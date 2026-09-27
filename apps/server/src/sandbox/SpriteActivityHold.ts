// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import { forkParked } from "../serverActivation.ts";
import { readSandboxDeployment } from "./SandboxDeployment.ts";

const TASK_PATH = "/v1/tasks/t3-turns";

export interface TaskHold {
  readonly setActive: (owner: string, active: boolean) => Effect.Effect<void>;
}

/**
 * Keeps a sandbox destination's Sprite awake while its threads have running
 * turns or live background work, even with no client connected. Normal T3
 * servers get a no-op reactor and never subscribe.
 */
export class SpriteActivityHold extends Context.Service<
  SpriteActivityHold,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/sandbox/SpriteActivityHold") {}

class SpriteTaskError extends Schema.TaggedError<SpriteTaskError>()("SpriteTaskError", {
  message: Schema.String,
}) {}

export type TaskRequest = (method: "PUT" | "DELETE") => Effect.Effect<void, SpriteTaskError>;

const requestTask: TaskRequest = (method) =>
  Effect.callback<void, SpriteTaskError>((resume) => {
    const request = NodeHttp.request(
      {
        socketPath: "/.sprite/api.sock",
        hostname: "sprite",
        path: TASK_PATH,
        method,
        headers: { "Content-Type": "application/json" },
        timeout: 10_000,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          const successful =
            response.statusCode !== undefined &&
            ((response.statusCode >= 200 && response.statusCode < 300) ||
              (method === "DELETE" && response.statusCode === 404));
          resume(
            successful
              ? Effect.void
              : Effect.fail(
                  new SpriteTaskError({
                    message: `Sprite task ${method} failed (${response.statusCode})`,
                  }),
                ),
          );
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("Sprite task request timed out")));
    request.once("error", () =>
      resume(Effect.fail(new SpriteTaskError({ message: "Sprite task request failed." }))),
    );
    request.end(method === "PUT" ? '{"expire":"5m"}' : undefined);
    return Effect.sync(() => {
      request.destroy();
    });
  });

/** One Sprite task held while any owner is active, renewed before it expires. */
export const makeTaskHold = (request: TaskRequest = requestTask) =>
  Effect.gen(function* () {
    const owners = new Set<string>();
    let held = false;
    const mutex = yield* Semaphore.make(1);

    const update = (method: "PUT" | "DELETE") =>
      request(method).pipe(
        Effect.tap(() => Effect.sync(() => (held = method === "PUT"))),
        Effect.catchCause((cause) =>
          Effect.logWarning("Sprite activity hold update failed", { method, cause }),
        ),
      );

    const setActive: TaskHold["setActive"] = (owner, active) =>
      mutex
        .withPermits(1)(
          Effect.gen(function* () {
            if (active) owners.add(owner);
            else owners.delete(owner);
            if (owners.size > 0 && !held) yield* update("PUT");
            if (owners.size === 0 && held) yield* update("DELETE");
          }),
        )
        .pipe(Effect.withSpan("SpriteActivityHold.setActive"));

    yield* Effect.addFinalizer(() => update("DELETE"));
    // A previous process can only have left an expiring task, but eagerly
    // reconcile it so a restart with no recovered owners becomes idle now.
    yield* update("DELETE");
    yield* Effect.sleep(Duration.minutes(1)).pipe(
      Effect.flatMap(() =>
        mutex.withPermits(1)(
          Effect.suspend(() =>
            owners.size > 0 ? update("PUT") : held ? update("DELETE") : Effect.void,
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    return { setActive } satisfies TaskHold;
  });

type HoldInput =
  | { readonly kind: "turn-requested"; readonly threadId: ThreadId }
  | { readonly kind: "session"; readonly threadId: ThreadId }
  | { readonly kind: "background"; readonly threadId: ThreadId };

const holdInput = (event: OrchestrationEvent): HoldInput | null => {
  switch (event.type) {
    case "thread.turn-start-requested":
      return { kind: "turn-requested", threadId: event.payload.threadId };
    case "thread.session-set":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
      return { kind: "session", threadId: event.payload.threadId };
    case "thread.activity-appended":
      return event.payload.activity.kind.startsWith("task.")
        ? { kind: "background", threadId: event.payload.threadId }
        : null;
    default:
      return null;
  }
};

/** Derives the hold from committed orchestration state rather than event payloads. */
export const makeReactor = (hold: TaskHold) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const backgroundLiveness = yield* ThreadBackgroundLivenessService;

    const background = (threadId: ThreadId) =>
      hold.setActive(
        `background:${threadId}`,
        backgroundLiveness.getThreadBackgroundLiveness(threadId) !== null,
      );
    // Reading the projection keeps an older queued event from clearing a newer
    // turn, and covers failed sends that never emit a terminal runtime event.
    // Archived and deleted threads no longer project, so they release.
    const session = (threadId: ThreadId) =>
      snapshots.getThreadRuntimeContext(threadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              hold
                .setActive(`turn:${threadId}`, false)
                .pipe(Effect.andThen(hold.setActive(`background:${threadId}`, false))),
            onSome: (thread) =>
              hold
                .setActive(
                  `turn:${threadId}`,
                  thread.session?.activeTurnId != null ||
                    thread.session?.status === "starting" ||
                    thread.session?.status === "running",
                )
                .pipe(Effect.andThen(background(threadId))),
          }),
        ),
      );
    const worker = yield* makeDrainableWorker((input: HoldInput) =>
      (input.kind === "turn-requested"
        ? hold.setActive(`turn:${input.threadId}`, true)
        : input.kind === "session"
          ? session(input.threadId)
          : background(input.threadId)
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Sprite activity hold update failed", { input, cause }),
        ),
      ),
    );

    const start = Effect.fn("SpriteActivityHold.start")(function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* forkParked(
        Stream.runForEach(events, (event) => {
          const input = holdInput(event);
          return input ? worker.enqueue(input) : Effect.void;
        }),
      );
    });

    return SpriteActivityHold.of({ start, drain: worker.drain });
  });

export const layer = Layer.unwrap(
  readSandboxDeployment.pipe(
    Effect.map((deployment) =>
      deployment === null
        ? Layer.succeed(SpriteActivityHold, { start: () => Effect.void, drain: Effect.void })
        : Layer.effect(SpriteActivityHold, makeTaskHold().pipe(Effect.flatMap(makeReactor))),
    ),
  ),
);
