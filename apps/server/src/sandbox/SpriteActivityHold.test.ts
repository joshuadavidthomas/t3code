import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  type ThreadBackgroundLiveness,
  ThreadBackgroundLivenessService,
} from "../orchestration/ThreadBackgroundLiveness.ts";
import { makeReactor, makeTaskHold } from "./SpriteActivityHold.ts";

const threadId = "thread-1" as ThreadId;

type Session = { readonly status: string; readonly activeTurnId: string | null } | null;

/** Runs the reactor over a controllable event stream and projection. */
const harness = Effect.gen(function* () {
  const owners = new Set<string>();
  const projected = new Map<string, { session: Session }>([[threadId, { session: null }]]);
  let liveness: ThreadBackgroundLiveness = null;
  const events = yield* Queue.unbounded<OrchestrationEvent>();
  let flushed = yield* Deferred.make<void>();
  const reactor = yield* makeReactor({
    setActive: (owner, active) =>
      Effect.sync(() => void (active ? owners.add(owner) : owners.delete(owner))),
  }).pipe(
    Effect.provideService(OrchestrationEngineService, {
      subscribeDomainEvents: Effect.succeed(
        Stream.fromQueue(events).pipe(
          Stream.tap((event) =>
            event.type === ("test.flushed" as never)
              ? Deferred.succeed(flushed, undefined)
              : Effect.void,
          ),
        ),
      ),
    } as never),
    Effect.provideService(ProjectionSnapshotQuery, {
      getThreadRuntimeContext: (id: ThreadId) =>
        Effect.succeed(
          Option.fromNullishOr(projected.get(id)).pipe(Option.map((thread) => ({ id, ...thread }))),
        ),
    } as never),
    Effect.provideService(ThreadBackgroundLivenessService, {
      getThreadBackgroundLiveness: () => liveness,
    } as never),
  );
  yield* reactor.start();
  const send = Effect.fnUntraced(function* (...types: ReadonlyArray<string>) {
    for (const type of types) {
      yield* Queue.offer(events, {
        type,
        payload: {
          threadId,
          activity: { kind: type === "thread.activity-appended" ? "task.progress" : "x" },
        },
      } as never);
    }
    yield* Queue.offer(events, { type: "test.flushed" } as never);
    yield* Deferred.await(flushed);
    flushed = yield* Deferred.make<void>();
    yield* reactor.drain;
  });
  return {
    owners,
    send,
    project: (session: Session | undefined) =>
      session === undefined ? projected.delete(threadId) : projected.set(threadId, { session }),
    setLiveness: (value: ThreadBackgroundLiveness) => {
      liveness = value;
    },
  };
});

describe("SpriteActivityHold", () => {
  it.effect("holds while any owner is active, renews, and releases the last owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: string[] = [];
        const hold = yield* makeTaskHold((method) => Effect.sync(() => void requests.push(method)));

        expect(requests).toEqual(["DELETE"]);
        yield* hold.setActive("turn", true);
        yield* hold.setActive("background", true);
        expect(requests).toEqual(["DELETE", "PUT"]);

        yield* TestClock.adjust("1 minute");
        expect(requests).toEqual(["DELETE", "PUT", "PUT"]);

        yield* hold.setActive("turn", false);
        expect(requests.at(-1)).toBe("PUT");
        yield* hold.setActive("background", false);
        expect(requests.at(-1)).toBe("DELETE");
      }),
    ),
  );

  it.effect("retries a failed acquisition and never treats it as held", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: string[] = [];
        let failPut = true;
        const hold = yield* makeTaskHold((method) =>
          Effect.sync(() => {
            requests.push(method);
            if (method === "PUT" && failPut) {
              failPut = false;
              throw new Error("unavailable");
            }
          }),
        );

        yield* hold.setActive("turn", true);
        yield* hold.setActive("background", true);
        expect(requests).toEqual(["DELETE", "PUT", "PUT"]);
        yield* hold.setActive("turn", false);
        yield* hold.setActive("background", false);
        expect(requests.at(-1)).toBe("DELETE");
      }),
    ),
  );

  it.effect("holds a requested turn until the committed session settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { owners, send, project } = yield* harness;
        yield* send("thread.turn-start-requested");
        expect(owners).toContain(`turn:${threadId}`);

        // A stale settle queued behind the new turn reads the running projection.
        project({ status: "running", activeTurnId: "turn-2" });
        yield* send("thread.session-set");
        expect(owners).toContain(`turn:${threadId}`);

        project({ status: "ready", activeTurnId: null });
        yield* send("thread.session-set");
        expect(owners).not.toContain(`turn:${threadId}`);
      }),
    ),
  );

  it.effect("releases a failed send that commits only a session error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { owners, send, project } = yield* harness;
        yield* send("thread.turn-start-requested");
        project({ status: "error", activeTurnId: null });
        yield* send("thread.session-set");
        expect(owners.size).toBe(0);
      }),
    ),
  );

  it.effect("holds live background work and releases archived threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { owners, send, project, setLiveness } = yield* harness;
        project({ status: "running", activeTurnId: "turn-1" });
        setLiveness("working");
        yield* send("thread.session-set", "thread.activity-appended");
        expect([...owners].toSorted()).toEqual([`background:${threadId}`, `turn:${threadId}`]);

        project(undefined);
        yield* send("thread.archived");
        expect(owners.size).toBe(0);
      }),
    ),
  );
});
