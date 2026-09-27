import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type SandboxRuntimeManifest,
  type SandboxSubmissionRecord,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpRouter } from "effect/unstable/http";
import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../auth/EnvironmentAuth.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerConfig from "../config.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { makeSandboxIntake } from "./SandboxIntake.ts";
import { makeSandboxIntakeRoutes } from "./SandboxIntakeRoutes.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const runtime: SandboxRuntimeManifest = {
  id: "runtime-1",
  artifactIntegrity: "sha256-runtime",
  orchestrationProtocol: ORCHESTRATION_PROTOCOL_VERSION,
  intakeVersion: 1,
  providers: [
    {
      driver,
      version: "1.0.0",
      showInteractionModeToggle: false,
      models: [{ slug: "gpt", name: "GPT", isCustom: false, capabilities: null }],
    },
  ],
};
const submission: SandboxSubmissionRecord = {
  deletedAt: null,
  deletionError: null,
  input: {
    commandId: CommandId.make("submit-1"),
    configurationId: "11111111-1111-4111-8111-111111111111",
    expectedRevision: 1,
    runtimeId: "runtime-1",
    projectId: ProjectId.make("source-project"),
    branch: "main",
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    prompt: "Build it",
    title: "Sandbox task",
    modelSelection: { instanceId, model: "gpt" },
    runtimeMode: "full-access",
    interactionMode: "default",
  },
  source: {
    repositoryUrl: "https://github.com/example/repository",
    commit: "0123456789abcdef0123456789abcdef01234567",
    branch: "main",
  },
  runtime,
  acceptedAt: "2026-09-25T12:00:00.000Z",
  progress: {
    kind: "sandbox",
    threadId: ThreadId.make("thread-1"),
    phase: "running",
    startedAt: "2026-09-25T12:00:00.000Z",
    endedAt: null,
    branch: "main",
    baseRef: null,
    worktreePath: null,
    setupScript: null,
    stages: [],
    error: null,
    sequence: 4,
  },
  destination: null,
  intakeStarted: true,
  cancelRequested: false,
};
const input = {
  submission,
  providerInstances: { [instanceId]: { driver, enabled: true, config: { token: "secret" } } },
  workspaceRoot: "/workspace/repository",
  projectId: ProjectId.make("destination-project"),
};

const testLayer = Layer.mergeAll(NodeServices.layer, Layer.fresh(SqlitePersistenceMemory));
const engineLayer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "sandbox-intake-" })),
  Layer.provide(NodeServices.layer),
);

describe("SandboxIntake", () => {
  it.effect("does not dispatch commands until provider application completes", () =>
    Effect.gen(function* () {
      const applying = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const commands: string[] = [];
      const intake = yield* makeSandboxIntake({
        runtime,
        environmentId: EnvironmentId.make("destination"),
        applyProviderInstances: () =>
          Deferred.succeed(applying, undefined).pipe(Effect.andThen(Deferred.await(ready))),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command.type);
            return { sequence: commands.length };
          }),
      });
      const accepting = yield* intake.accept(input).pipe(Effect.forkScoped);
      yield* Deferred.await(applying);
      assert.deepStrictEqual(commands, []);
      yield* Deferred.succeed(ready, undefined);
      yield* Fiber.join(accepting);
      assert.deepStrictEqual(commands, [
        "project.create",
        "thread.create",
        "thread.message.user.append",
        "thread.turn.start",
      ]);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect(
    "rejects malformed driver config before reserving ownership and accepts a correction",
    () =>
      Effect.gen(function* () {
        let writes = 0;
        let commands = 0;
        const claude = ProviderDriverKind.make("claudeAgent");
        const destinationRuntime = {
          ...runtime,
          providers: runtime.providers.map((provider) => ({ ...provider, driver: claude })),
        };
        const intake = yield* makeSandboxIntake({
          runtime: destinationRuntime,
          environmentId: EnvironmentId.make("destination"),
          applyProviderInstances: () =>
            Effect.sync(() => {
              writes++;
            }),
          dispatch: () => Effect.sync(() => ({ sequence: ++commands })),
        });
        const request = {
          ...input,
          submission: { ...submission, runtime: destinationRuntime },
          providerInstances: {
            [instanceId]: { driver: claude, enabled: true, config: { launchArgs: 42 } },
          },
        };
        assert.strictEqual((yield* Effect.flip(intake.accept(request))).code, "invalid");
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT id FROM sandbox_intakes`, []);
        assert.strictEqual(writes, 0);
        assert.strictEqual(commands, 0);
        yield* intake.accept({
          ...request,
          providerInstances: {
            [instanceId]: { driver: claude, enabled: true, config: { launchArgs: "" } },
          },
        });
        assert.strictEqual(writes, 1);
        assert.strictEqual(commands, 4);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("authenticates HTTP intake and returns the same destination on replay", () =>
    Effect.gen(function* () {
      const dispatched: string[] = [];
      const intake = yield* makeSandboxIntake({
        runtime,
        environmentId: EnvironmentId.make("destination"),
        applyProviderInstances: () => Effect.void,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command.type);
            return { sequence: dispatched.length };
          }),
      });
      const routes = makeSandboxIntakeRoutes(runtime, (request) =>
        intake.accept({
          ...input,
          ...request,
        }),
      ).pipe(
        Layer.provideMerge(
          Layer.mock(EnvironmentAuth, {
            authenticateHttpRequest: (request) =>
              request.headers.authorization
                ? Effect.succeed({
                    sessionId: AuthSessionId.make("test"),
                    subject: "test",
                    method: "bearer-access-token",
                    scopes:
                      request.headers.authorization === "Bearer read"
                        ? [AuthOrchestrationReadScope]
                        : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
                  })
                : Effect.fail(new ServerAuthMissingCredentialError({})),
          }),
        ),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const request = (
        token?: string,
        body = JSON.stringify({ submission, providerInstances: input.providerInstances }),
      ) =>
        Effect.promise(() =>
          handler(
            new Request("http://runtime.test/api/sandbox/intake", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
              },
              body,
            }),
          ),
        );
      assert.strictEqual((yield* request()).status, 401);
      assert.strictEqual((yield* request("read")).status, 403);
      assert.strictEqual((yield* request("write", "{}")).status, 400);
      assert.deepStrictEqual(dispatched, []);
      const first = yield* request("write");
      const replay = yield* request("write");
      assert.strictEqual(first.status, 200);
      assert.strictEqual(replay.status, 200);
      assert.deepStrictEqual(yield* Effect.promise(() => first.json()), {
        environmentId: "destination",
        projectId: input.projectId,
        threadId: submission.input.threadId,
      });
      assert.deepStrictEqual(yield* Effect.promise(() => replay.json()), {
        environmentId: "destination",
        projectId: input.projectId,
        threadId: submission.input.threadId,
      });
      assert.deepStrictEqual(dispatched, [
        "project.create",
        "thread.create",
        "thread.message.user.append",
        "thread.turn.start",
      ]);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("replays a lost acknowledgement with stable deduplicated commands", () =>
    Effect.gen(function* () {
      const handled = new Set<string>();
      const attempts: string[] = [];
      let loseAck = true;
      const dispatch = ((command) => {
        attempts.push(command.commandId);
        if (handled.has(command.commandId)) return Effect.succeed({ sequence: handled.size });
        handled.add(command.commandId);
        if (command.type === "thread.turn.start" && loseAck) {
          loseAck = false;
          return Effect.fail(new PersistenceSqlError({ operation: "lost acknowledgement" }));
        }
        return Effect.succeed({ sequence: handled.size });
      }) satisfies OrchestrationEngineShape["dispatch"];
      let applied = 0;
      const intake = yield* makeSandboxIntake({
        runtime,
        environmentId: EnvironmentId.make("environment-1"),
        applyProviderInstances: () => Effect.sync(() => void applied++),
        dispatch,
      });

      const first = yield* Effect.flip(intake.accept(input));
      assert.strictEqual(first.code, "unavailable");
      const destination = yield* intake.accept(input);
      assert.deepStrictEqual(destination, {
        environmentId: "environment-1",
        projectId: "destination-project",
        threadId: "thread-1",
      });
      assert.strictEqual(handled.size, 4);
      assert.strictEqual(attempts.filter((id) => id.endsWith(":turn-start")).length, 2);
      assert.strictEqual(applied, 2);

      const replay = yield* intake.accept(input);
      assert.deepStrictEqual(replay, destination);
      assert.strictEqual(attempts.length, 8);

      const changed = yield* Effect.flip(
        intake.accept({ ...input, workspaceRoot: "/workspace/changed" }),
      );
      assert.strictEqual(changed.code, "conflict");
      assert.strictEqual(
        (yield* Effect.flip(
          intake.accept({
            ...input,
            providerInstances: {
              [instanceId]: { driver, enabled: true, config: { token: "changed" } },
            },
          }),
        )).code,
        "conflict",
      );
      assert.strictEqual(
        (yield* Effect.flip(
          intake.accept({
            ...input,
            submission: {
              ...submission,
              input: { ...submission.input, commandId: CommandId.make("another") },
            },
          }),
        )).code,
        "conflict",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects an incompatible runtime before settings or dispatch", () =>
    Effect.gen(function* () {
      let sideEffects = 0;
      const intake = yield* makeSandboxIntake({
        runtime: { ...runtime, artifactIntegrity: "different" },
        environmentId: EnvironmentId.make("environment-1"),
        applyProviderInstances: () => Effect.sync(() => void sideEffects++),
        dispatch: (() =>
          Effect.sync(() => ({ sequence: sideEffects++ }))) as OrchestrationEngineShape["dispatch"],
      });
      const error = yield* Effect.flip(intake.accept(input));
      assert.strictEqual(error.code, "unsupported");
      assert.strictEqual(sideEffects, 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects unsupported plan mode before settings or dispatch", () =>
    Effect.gen(function* () {
      let sideEffects = 0;
      const intake = yield* makeSandboxIntake({
        runtime,
        environmentId: EnvironmentId.make("environment-1"),
        applyProviderInstances: () => Effect.sync(() => void sideEffects++),
        dispatch: (() =>
          Effect.sync(() => ({ sequence: sideEffects++ }))) as OrchestrationEngineShape["dispatch"],
      });
      const error = yield* Effect.flip(
        intake.accept({
          ...input,
          submission: {
            ...submission,
            input: { ...submission.input, interactionMode: "plan" },
          },
        }),
      );
      assert.strictEqual(error.code, "unsupported");
      assert.strictEqual(sideEffects, 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "uses persisted engine receipts across intake reconstruction without duplicate messages or turns",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        let loseAck = true;
        const deps = {
          runtime,
          environmentId: EnvironmentId.make("destination"),
          applyProviderInstances: () => Effect.void,
          dispatch: (command: Parameters<OrchestrationEngineShape["dispatch"]>[0]) =>
            Effect.gen(function* () {
              const receipt = yield* engine.dispatch(command);
              if (command.type === "thread.turn.start" && loseAck) {
                loseAck = false;
                return yield* new PersistenceSqlError({ operation: "lost acknowledgement" });
              }
              return receipt;
            }),
        };
        const first = yield* makeSandboxIntake(deps);
        assert.strictEqual((yield* Effect.flip(first.accept(input))).code, "unavailable");
        const restarted = yield* makeSandboxIntake(deps);
        const result = yield* restarted.accept({
          ...input,
          submission: { ...submission, progress: { ...submission.progress, sequence: 20 } },
        });
        assert.strictEqual(result.threadId, submission.input.threadId);
        const events = yield* Stream.runCollect(engine.readEvents(0));
        assert.strictEqual(
          events.find((event) => event.type === "project.created")?.payload.title,
          "repository",
        );
        assert.strictEqual(events.filter((event) => event.type === "thread.created").length, 1);
        assert.strictEqual(
          events.filter((event) => event.type === "thread.turn-start-requested").length,
          1,
        );
        const messages = events.filter((event) => event.type === "thread.message-sent");
        assert.strictEqual(messages.length, 1);
      }).pipe(Effect.provide(engineLayer)),
  );

  it.effect(
    "rejects redacted settings and unsupported intake versions before applying settings",
    () =>
      Effect.gen(function* () {
        let writes = 0;
        const deps = {
          runtime,
          environmentId: EnvironmentId.make("destination"),
          applyProviderInstances: () =>
            Effect.sync(() => {
              writes++;
            }),
          dispatch: () => Effect.succeed({ sequence: 1 }),
        };
        const intake = yield* makeSandboxIntake(deps);
        const redacted = {
          ...input,
          providerInstances: {
            [instanceId]: {
              driver,
              enabled: true,
              environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
            },
          },
        };
        assert.strictEqual((yield* Effect.flip(intake.accept(redacted))).code, "invalid");
        const legacyRuntime = { ...runtime, intakeVersion: 0 };
        const legacy = yield* makeSandboxIntake({ ...deps, runtime: legacyRuntime });
        assert.strictEqual(
          (yield* Effect.flip(
            legacy.accept({ ...input, submission: { ...submission, runtime: legacyRuntime } }),
          )).code,
          "unsupported",
        );
        assert.strictEqual(writes, 0);
      }).pipe(Effect.provide(testLayer)),
  );
});
