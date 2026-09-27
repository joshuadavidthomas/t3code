import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SandboxSubmissionError,
  ThreadId,
  type SandboxSubmissionRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as SandboxResources from "./SandboxResources.ts";
import { makeSandboxRuntimeManifest } from "./SandboxRuntime.ts";
import { SANDBOX_PROVISION_STAGES } from "./SandboxSubmissions.ts";
import type { SpritesClient } from "./SpritesClient.ts";
import { makeSpritesProvisioner } from "./SpritesProvisioner.ts";

const runtime = makeSandboxRuntimeManifest(`sha256-${"1".repeat(64)}`);
const submission: SandboxSubmissionRecord = {
  input: {
    commandId: CommandId.make("accepted"),
    configurationId: "00000000-0000-4000-8000-000000000001",
    expectedRevision: 1,
    runtimeId: runtime.id,
    projectId: ProjectId.make("project"),
    branch: "main",
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    prompt: "Run the tests",
    title: "Tests",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
    runtimeMode: "full-access",
    interactionMode: "default",
  },
  source: {
    repositoryUrl: "https://github.com/example/repo",
    branch: "main",
    commit: "a".repeat(40),
  },
  runtime,
  acceptedAt: "2026-01-01T00:00:00.000Z",
  destination: null,
  intakeStarted: false,
  cancelRequested: false,
  deletedAt: null,
  deletionError: null,
  progress: {
    kind: "sandbox",
    threadId: ThreadId.make("thread"),
    phase: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    branch: "main",
    baseRef: null,
    worktreePath: null,
    setupScript: null,
    error: null,
    sequence: 1,
    stages: [],
  },
};
const captured = { credential: "captured-account-key", namePrefix: "", providerInstances: {} };
const destination = {
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("remote-project"),
  threadId: submission.input.threadId,
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const dependencies = SandboxResources.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Secrets.layer, SqlitePersistenceMemory)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "sprites-provisioner-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "reconciles a lost create response with the persisted prefixed name after reopening",
  () =>
    Effect.gen(function* () {
      let creates = 0;
      let name: string | undefined;
      const client: SpritesClient = {
        find: (requested) =>
          Effect.sync(() =>
            requested === name ? { id: "sprite", url: "https://sprite.example" } : null,
          ),
        create: (requested) =>
          Effect.gen(function* () {
            name = requested;
            creates++;
            return yield* new SandboxSubmissionError({
              code: "unavailable",
              message: "Response lost",
            });
          }),
        remove: () => Effect.void,
        makeUrlPublic: () => Effect.void,
        exec: () => Effect.succeed(""),
        upload: () => Effect.void,
        putService: () => Effect.void,
      };
      const open = () =>
        makeSpritesProvisioner(
          { runtime, archivePath: "/unused" },
          () => Effect.succeed(submission.source),
          () => Effect.succeed(client),
        );
      const prefixed = { ...captured, namePrefix: "orb-" };
      const first = yield* open();
      yield* first.stage("create", submission, prefixed).pipe(Effect.flip);
      expect(name).toMatch(/^orb-t3-[a-f0-9]{32}$/);
      const resumed = yield* open();
      yield* resumed.stage("create", submission, prefixed);
      expect(creates).toBe(1);
      const resources = yield* SandboxResources.SandboxResources;
      expect((yield* resources.get(submission.input.commandId)).sprite?.id).toBe("sprite");
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "cleans up persisted resources without an artifact and never allocates during cancellation",
  () =>
    Effect.gen(function* () {
      const resources = yield* SandboxResources.SandboxResources;
      const removed: string[] = [];
      let existing: { id: string; url: string } | null = {
        id: "original",
        url: "https://sprite.example",
      };
      const client: SpritesClient = {
        find: () => Effect.succeed(existing),
        create: () => Effect.die("Must not create"),
        remove: (name) =>
          Effect.sync(() => {
            removed.push(name);
            existing = null;
          }),
        makeUrlPublic: () => Effect.void,
        exec: () => Effect.succeed(""),
        upload: () => Effect.void,
        putService: () => Effect.void,
      };
      const provisioner = yield* makeSpritesProvisioner(
        null,
        () => Effect.succeed(submission.source),
        (credential) => {
          expect(credential).toBe(captured.credential);
          return Effect.succeed(client);
        },
      );
      yield* provisioner.cancel(submission, captured.credential);
      expect(yield* resources.find(submission.input.commandId)).toBeNull();
      expect(removed).toEqual([]);
      const resource = yield* resources.getOrCreate(submission);
      yield* resources.bindSprite(submission.input.commandId, existing!);
      existing = { id: "replacement", url: "https://sprite.example" };
      expect(
        (yield* Effect.flip(provisioner.cancel(submission, captured.credential))).message,
      ).toBe("Sandbox binding has changed.");
      expect(removed).toEqual([]);
      existing = { id: "original", url: "https://sprite.example" };
      yield* provisioner.cancel(submission, captured.credential);
      yield* provisioner.cancel(submission, "");
      expect(removed).toEqual([resource.name]);
      expect((yield* resources.get(submission.input.commandId)).deletedAt).not.toBeNull();
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("verifies the runtime before starting intake and preserves the destination receipt", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const archivePath = yield* fs.makeTempFileScoped();
    yield* fs.writeFile(archivePath, new Uint8Array([1, 2, 3]));
    const operations: string[] = [];
    const uploads: string[] = [];
    const controlScripts: string[] = [];
    let mismatch = true;
    const client: SpritesClient = {
      find: () => Effect.succeed(null),
      create: () => Effect.succeed({ id: "sprite", url: "https://sprite.example" }),
      remove: () => Effect.void,
      makeUrlPublic: () =>
        Effect.sync(() => {
          operations.push("public");
        }),
      upload: (_name, path) =>
        Effect.sync(() => {
          operations.push("upload");
          uploads.push(path);
        }),
      putService: () =>
        Effect.sync(() => {
          operations.push("service");
        }),
      exec: (_name, script, input) =>
        Effect.sync(() => {
          if (script.includes("sandbox-runtime-manifest"))
            return encode(mismatch ? { ...runtime, id: "wrong" } : runtime);
          if (script.includes("/api/sandbox/runtime")) return encode(runtime);
          if (script.includes("/api/sandbox/intake")) {
            operations.push("intake");
            controlScripts.push(script);
            expect(input).toContain("Run the tests");
            expect(script).not.toContain(captured.credential);
            return encode(destination);
          }
          if (script.includes("auth pairing create")) {
            operations.push("pair");
            return encode({ credential: `fresh-pair-${operations.length}` });
          }
          return "";
        }),
    };
    const provisioner = yield* makeSpritesProvisioner(
      { runtime: { ...runtime, id: "current-runtime" }, archivePath },
      () => Effect.succeed(submission.source),
      (credential) => {
        expect(credential).toBe(captured.credential);
        return Effect.succeed(client);
      },
      (capturedRuntime) => {
        expect(capturedRuntime).toEqual(runtime);
        return Effect.succeed({ runtime, archivePath });
      },
    );
    expect(provisioner.runtime?.id).toBe("current-runtime");
    yield* provisioner.stage("create", submission, captured);
    yield* provisioner.stage("runtime", submission, captured).pipe(Effect.flip);
    expect(operations).toEqual(["upload"]);
    mismatch = false;
    for (const stage of SANDBOX_PROVISION_STAGES.slice(1))
      yield* provisioner.stage(stage, submission, captured);
    expect(yield* provisioner.intake(submission, captured)).toEqual(destination);
    const resources = yield* SandboxResources.SandboxResources;
    expect((yield* resources.get(submission.input.commandId)).destination).toEqual(destination);
    expect(operations).toEqual(["upload", "upload", "service", "public", "intake"]);
    expect(controlScripts).toHaveLength(1);
    expect(controlScripts[0]).toContain("auth session issue");
    expect(controlScripts[0]).toContain("--replace-active");
    expect(controlScripts[0]).toContain("flock 9");
    expect(controlScripts[0]).not.toContain("control-bearer");
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).not.toBe(uploads[1]);
    const paired = yield* provisioner.pair(submission, captured);
    const pairedAgain = yield* provisioner.pair(submission, captured);
    expect(paired.destination).toEqual(destination);
    expect(paired.url).toBe("https://sprite.example");
    expect(pairedAgain.pairingToken).not.toBe(paired.pairingToken);
    expect(paired.pairingToken).not.toBe("control-bearer");
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
