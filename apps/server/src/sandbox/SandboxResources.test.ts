import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type SandboxSubmissionRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeSandboxResources } from "./SandboxResources.ts";

const commandId = CommandId.make("resource-command");
const submission = (artifactIntegrity = "sha256-runtime"): SandboxSubmissionRecord => ({
  input: {
    commandId,
    configurationId: "00000000-0000-4000-8000-000000000000",
    expectedRevision: 1,
    runtimeId: "runtime",
    projectId: ProjectId.make("source-project"),
    branch: "main",
    threadId: ThreadId.make("source-thread"),
    messageId: MessageId.make("source-message"),
    prompt: "Run tests",
    title: "Tests",
    modelSelection: {
      instanceId: ProviderInstanceId.make("provider"),
      model: "model",
      options: [],
    },
    runtimeMode: "approval-required",
    interactionMode: "plan",
  },
  source: {
    repositoryUrl: "https://github.com/example/repository",
    commit: "1".repeat(40),
    branch: "main",
  },
  runtime: {
    id: "runtime",
    artifactIntegrity,
    orchestrationProtocol: ORCHESTRATION_PROTOCOL_VERSION,
    intakeVersion: 1,
    providers: [],
  },
  acceptedAt: "2026-01-01T00:00:00.000Z",
  destination: null,
  intakeStarted: false,
  cancelRequested: false,
  deletedAt: null,
  deletionError: null,
  progress: {
    kind: "sandbox",
    threadId: ThreadId.make("source-thread"),
    phase: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    branch: "main",
    baseRef: "1".repeat(40),
    worktreePath: null,
    setupScript: null,
    error: null,
    sequence: 1,
    stages: [],
  },
});
const dependencies = Layer.mergeAll(Secrets.layer, SqlitePersistenceMemory).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "sandbox-resources-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("reopens and replays the durable name and immutable bindings", () =>
  Effect.gen(function* () {
    const first = yield* makeSandboxResources();
    const allocated = yield* first.getOrCreate(submission());
    expect(allocated.name).toMatch(/^[a-z0-9-]{1,50}$/);
    yield* first.bindSprite(commandId, { id: "sprite-1", url: "https://sprite.example" });
    const destination = {
      environmentId: EnvironmentId.make("environment"),
      projectId: ProjectId.make("destination-project"),
      threadId: ThreadId.make("destination-thread"),
    };
    yield* first.bindDestination(commandId, destination);

    const reopened = yield* makeSandboxResources();
    expect(yield* reopened.getOrCreate(submission())).toEqual({
      ...allocated,
      sprite: { id: "sprite-1", url: "https://sprite.example" },
      destination,
    });
    expect(
      yield* reopened.bindSprite(commandId, { id: "sprite-1", url: "https://sprite.example" }),
    ).toEqual(yield* reopened.get(commandId));
    expect(
      (yield* Effect.flip(reopened.bindSprite(commandId, { id: "sprite-2", url: "different" })))
        .code,
    ).toBe("conflict");
    expect(
      (yield* Effect.flip(
        reopened.bindDestination(commandId, { ...destination, projectId: ProjectId.make("other") }),
      )).code,
    ).toBe("conflict");
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("rejects a replay with a different runtime artifact identity", () =>
  Effect.gen(function* () {
    const resources = yield* makeSandboxResources();
    yield* resources.getOrCreate(submission());
    expect((yield* Effect.flip(resources.getOrCreate(submission("sha256-other")))).code).toBe(
      "conflict",
    );
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect("keeps a deletion tombstone idempotently", () =>
  Effect.gen(function* () {
    const resources = yield* makeSandboxResources();
    yield* resources.getOrCreate(submission());
    const deleted = yield* resources.markDeleted(commandId, "2026-01-02T00:00:00.000Z");
    expect(deleted.deletedAt).toBe("2026-01-02T00:00:00.000Z");
    const repeated = yield* resources.markDeleted(commandId, "2026-01-03T00:00:00.000Z");
    expect(repeated.deletedAt).toBe(deleted.deletedAt);
    expect(yield* resources.find(commandId)).toEqual(repeated);
  }).pipe(Effect.provide(dependencies), Effect.scoped),
);
