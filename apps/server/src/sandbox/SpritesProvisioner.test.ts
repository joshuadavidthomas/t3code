import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
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
import type { SandboxSaves } from "./SandboxSaves.ts";
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

const memorySaves = (store = new Map<string, Uint8Array>()): SandboxSaves => ({
  write: (commandId, archive) => Effect.sync(() => void store.set(commandId, archive)),
  read: (commandId) => Effect.sync(() => store.get(commandId) ?? new Uint8Array()),
  remove: (commandId) => Effect.sync(() => void store.delete(commandId)),
});

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
        download: () => Effect.succeed(new Uint8Array()),
        stopService: () => Effect.void,
        putService: () => Effect.void,
      };
      const open = () =>
        makeSpritesProvisioner(
          { runtime, archivePath: "/unused" },
          () => Effect.succeed(submission.source),
          () => Effect.succeed(new Uint8Array()),
          () => Effect.succeed(true),
          memorySaves(),
          () => Effect.succeed(client),
        );
      const prefixed = { ...captured, namePrefix: "orb-" };
      const first = yield* open();
      yield* first.stage("create", submission, prefixed).pipe(Effect.flip);
      expect(name).toMatch(/^orb-t3-[a-f0-9]{32}$/);
      const resumed = yield* open();
      expect(yield* resumed.stage("create", submission, prefixed)).toEqual({ resourceName: name });
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
        download: () => Effect.succeed(new Uint8Array()),
        stopService: () => Effect.void,
        putService: () => Effect.void,
      };
      const provisioner = yield* makeSpritesProvisioner(
        null,
        () => Effect.succeed(submission.source),
        () => Effect.succeed(new Uint8Array()),
        () => Effect.succeed(true),
        memorySaves(),
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
    const deployments: string[] = [];
    const packs: Uint8Array[] = [];
    const seedScripts: string[] = [];
    const intakes: string[] = [];
    const signIns: { script: string; input: string }[] = [];
    let mismatch = true;
    const client: SpritesClient = {
      find: () => Effect.succeed(null),
      create: () => Effect.succeed({ id: "sprite", url: "https://sprite.example" }),
      remove: () => Effect.void,
      makeUrlPublic: () =>
        Effect.sync(() => {
          operations.push("public");
        }),
      upload: (_name, path, body) =>
        Effect.sync(() => {
          operations.push("upload");
          uploads.push(path);
          if (path.endsWith(".pack")) packs.push(body);
        }),
      putService: () =>
        Effect.sync(() => {
          operations.push("service");
        }),
      download: () => Effect.succeed(new Uint8Array()),
      stopService: () => Effect.void,
      exec: (_name, script, input) =>
        Effect.sync(() => {
          if (script.includes("sandbox-runtime.json")) deployments.push(input);
          if (script.includes("index-pack")) seedScripts.push(script);
          if (script.includes("gh auth login")) signIns.push({ script, input });
          if (script.includes("sandbox-runtime-manifest"))
            return encode(mismatch ? { ...runtime, id: "wrong" } : runtime);
          if (script.includes("/api/sandbox/runtime")) return encode(runtime);
          if (script.includes("/api/sandbox/intake")) {
            operations.push("intake");
            controlScripts.push(script);
            expect(input).toContain("Run the tests");
            intakes.push(input);
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
      () => Effect.succeed(new Uint8Array([4, 5, 6])),
      () => Effect.succeed(true),
      memorySaves(),
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
    const withClaude = {
      ...captured,
      providerInstances: {
        [ProviderInstanceId.make("claude")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { binaryPath: "claude", homePath: "~/.claude" },
        },
      },
    };
    expect(yield* provisioner.intake(submission, withClaude)).toEqual(destination);
    const resources = yield* SandboxResources.SandboxResources;
    expect((yield* resources.get(submission.input.commandId)).destination).toEqual(destination);
    expect(operations).toEqual(["upload", "upload", "upload", "service", "public", "intake"]);
    expect(packs).toEqual([new Uint8Array([4, 5, 6])]);
    expect(seedScripts).toHaveLength(1);
    expect(seedScripts[0]).toContain(`checkout -q -B 'main' '${"a".repeat(40)}'`);
    expect(seedScripts[0]).toContain("remote add origin 'https://github.com/example/repo'");
    expect(controlScripts).toHaveLength(1);
    // The pinned install wins over the Sprite image's own Claude.
    expect(intakes[0]).toContain('"binaryPath":"/home/sprite/t3/providers/bin/claude"');
    expect(intakes[0]).toContain('"homePath":"~/.claude"');
    expect(deployments).toHaveLength(1);
    const { name } = yield* (yield* SandboxResources.SandboxResources).get(
      submission.input.commandId,
    );
    expect(deployments[0]).toContain(`"label":${encode(name)}`);
    expect(deployments[0]).toContain(`"workspaceRoot":"/workspace"`);
    expect(controlScripts[0]).toContain("auth session issue");
    expect(controlScripts[0]).toContain("--replace-active");
    expect(controlScripts[0]).toContain("flock 9");
    expect(controlScripts[0]).not.toContain("control-bearer");
    expect(uploads).toHaveLength(3);
    expect(uploads[0]).not.toBe(uploads[1]);
    const paired = yield* provisioner.pair(submission, captured);
    const pairedAgain = yield* provisioner.pair(submission, captured);
    expect(paired.destination).toEqual(destination);
    expect(paired.url).toBe("https://sprite.example");
    expect(pairedAgain.pairingToken).not.toBe(paired.pairingToken);
    expect(paired.pairingToken).not.toBe("control-bearer");
    // Without a GitHub token nothing signs in; with one, only stdin carries it.
    expect(signIns).toEqual([]);
    yield* provisioner.stage("server", submission, { ...captured, gitHubCredential: "gh-token" });
    expect(signIns.map((signIn) => signIn.input)).toEqual(["gh-token"]);
    expect(signIns[0]!.script).toContain("gh auth setup-git");
    expect(signIns[0]!.script).not.toContain("gh-token");
    // Commits made in the sandbox carry the project's Git identity.
    const author = { name: "Ada Lovelace", email: "ada@example.com" };
    yield* provisioner.stage(
      "clone",
      { ...submission, source: { ...submission.source, author } },
      captured,
    );
    expect(seedScripts[1]).toContain("git config --global user.name 'Ada Lovelace'");
    expect(seedScripts[1]).toContain("git config --global user.email 'ada@example.com'");
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("saves a sandbox to the host and restores it under the same name", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const archivePath = yield* fs.makeTempFileScoped();
    yield* fs.writeFile(archivePath, new Uint8Array([1, 2, 3]));
    const store = new Map<string, Uint8Array>();
    const saved = new Uint8Array([7, 7, 7]);
    const archived = {
      snapshotSequence: 3,
      projects: [],
      threads: [],
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const operations: string[] = [];
    const scripts: { script: string; input: string }[] = [];
    let sprite: { id: string; url: string } | null = null;
    let created = 0;
    const client: SpritesClient = {
      find: () => Effect.sync(() => sprite),
      create: (name) =>
        Effect.sync(() => {
          created++;
          sprite = { id: `sprite-${created}`, url: `https://${name}.example` };
          return sprite;
        }),
      remove: () =>
        Effect.sync(() => {
          operations.push("remove");
          sprite = null;
        }),
      makeUrlPublic: () => Effect.void,
      upload: (_name, path, body) =>
        Effect.sync(() => {
          operations.push(`upload ${path.split("/").pop()!.split("-")[0]}`);
          if (path.endsWith("restore.tar")) expect(body).toEqual(saved);
        }),
      download: () =>
        Effect.sync(() => {
          operations.push("download");
          return saved;
        }),
      stopService: () => Effect.sync(() => void operations.push("stop")),
      putService: () => Effect.void,
      exec: (_name, script, input) =>
        Effect.sync(() => {
          scripts.push({ script, input });
          if (script.includes("/api/sandbox/save")) return encode(archived);
          if (
            script.includes("sandbox-runtime-manifest") ||
            script.includes("/api/sandbox/runtime")
          )
            return encode(runtime);
          if (script.includes("/api/sandbox/intake")) return encode(destination);
          return "";
        }),
    };
    const provisioner = yield* makeSpritesProvisioner(
      { runtime, archivePath },
      () => Effect.succeed(submission.source),
      () => Effect.succeed(new Uint8Array([4])),
      () => Effect.succeed(true),
      memorySaves(store),
      () => Effect.succeed(client),
    );
    for (const stage of SANDBOX_PROVISION_STAGES)
      yield* provisioner.stage(stage, submission, captured);
    yield* provisioner.intake(submission, captured);
    const resources = yield* SandboxResources.SandboxResources;
    const { name } = yield* resources.get(submission.input.commandId);

    operations.length = 0;
    expect(yield* provisioner.save(submission, captured.credential)).toEqual(archived);
    // Stopped before archiving, so the database is consistent, then deleted.
    expect(operations).toEqual(["stop", "download", "remove"]);
    // Only the work on top of the seed, which the host still has.
    expect(scripts.some((entry) => entry.script.includes("git rev-list --objects"))).toBe(true);
    expect(scripts.some((entry) => entry.script.includes("workspace.tar.gz"))).toBe(false);
    expect([...store.values()]).toEqual([saved]);
    expect((yield* resources.get(submission.input.commandId)).sprite).toBeNull();

    operations.length = 0;
    scripts.length = 0;
    const restoring = {
      ...submission,
      saved: { at: "2026-01-02T00:00:00.000Z", archived },
      restoreThreadId: submission.input.threadId,
    };
    for (const stage of SANDBOX_PROVISION_STAGES)
      yield* provisioner.stage(stage, restoring, captured);
    // Same name, so the environment comes back at the same URL.
    expect(sprite).toEqual({ id: "sprite-2", url: `https://${name}.example` });
    // Seeded from the host like a launch, then the save goes on top.
    expect(operations).toEqual(["upload runtime", "upload restore.tar", "upload seed"]);
    expect(scripts.some((entry) => entry.script.includes("checkout-index"))).toBe(true);
    expect(yield* provisioner.intake(restoring, captured)).toEqual(destination);
    expect(scripts.at(-1)!.script).toContain("/api/sandbox/unarchive");
    expect(scripts.at(-1)!.input).toBe(encode({ threadId: submission.input.threadId }));
    expect(store.size).toBe(0);

    // Deleting a saved sandbox deletes its save; there is no Sprite left to remove.
    yield* provisioner.save(submission, captured.credential);
    operations.length = 0;
    yield* provisioner.delete(restoring, captured.credential);
    expect(operations).toEqual([]);
    expect(store.size).toBe(0);
    expect((yield* resources.get(submission.input.commandId)).deletedAt).not.toBeNull();
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
