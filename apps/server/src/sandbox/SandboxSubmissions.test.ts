import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ORCHESTRATION_PROTOCOL_VERSION,
  SandboxSubmissionError,
  type SandboxRuntimeManifest,
  type SandboxSubmissionListEvent,
  type SandboxSubmitInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@t3tools/contracts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeSandboxConfiguration } from "./SandboxConfiguration.ts";
import {
  makeSandboxSubmissions,
  type SandboxCapturedSecrets,
  type SandboxProvisioner,
} from "./SandboxSubmissions.ts";

const instanceId = ProviderInstanceId.make("claude-personal");
const driver = ProviderDriverKind.make("claudeAgent");
const runtime: SandboxRuntimeManifest = {
  id: "test-runtime",
  artifactIntegrity: "sha256-test-artifact",
  intakeVersion: 1,
  orchestrationProtocol: ORCHESTRATION_PROTOCOL_VERSION,
  providers: [
    {
      driver,
      version: "2.1.280",
      showInteractionModeToggle: true,
      models: [
        {
          slug: "sonnet",
          name: "Sonnet",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ],
    },
  ],
};
const source = {
  repositoryUrl: "https://github.com/example/project",
  branch: "main",
  commit: "1234567890abcdef1234567890abcdef12345678",
};
const baseProvisioner: SandboxProvisioner = {
  runtime,
  resolveSource: () => Effect.succeed(source),
  stage: () => Effect.void,
  intake: (value) =>
    Effect.succeed({
      environmentId: EnvironmentId.make("destination"),
      projectId: ProjectId.make("destination-project"),
      threadId: value.input.threadId,
    }),
  cancel: () => Effect.void,
};
const setup = Effect.gen(function* () {
  const configurations = yield* makeSandboxConfiguration();
  const created = yield* configurations.save({
    provider: "sprites",
    name: "Personal",
    expectedRevision: 0,
    credential: "personal-token",
  });
  const account = yield* configurations.saveProviderInstance({
    id: created.id,
    expectedRevision: created.revision,
    instanceId,
    instance: {
      driver,
      enabled: true,
      environment: [{ name: "ANTHROPIC_API_KEY", value: "personal-provider-key", sensitive: true }],
    },
  });
  const input: SandboxSubmitInput = {
    commandId: CommandId.make("submission-1"),
    configurationId: account.id,
    expectedRevision: account.revision,
    runtimeId: runtime.id,
    projectId: ProjectId.make("source-project"),
    branch: "main",
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    title: "Fix parser",
    prompt: "Fix the parser without changing its API",
    modelSelection: { instanceId, model: "sonnet", options: [{ id: "effort", value: "high" }] },
    runtimeMode: "approval-required",
    interactionMode: "plan",
  };
  return { configurations, account, input };
});
const dependencies = Layer.mergeAll(Secrets.layer, SqlitePersistenceMemory).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "sandbox-submissions-" })),
  Layer.provideMerge(NodeServices.layer),
);
const settled = (
  service: Effect.Success<ReturnType<typeof makeSandboxSubmissions>>,
  id: CommandId,
) =>
  service.stream(id).pipe(
    Stream.filter((value) => value.progress.phase !== "running"),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.andThen(service.get(id)),
  );

it.effect(
  "persists acceptance before provisioning; freezes account, source and model independently of later edits",
  () =>
    Effect.gen(function* () {
      const { configurations, account, input } = yield* setup;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const captures: SandboxCapturedSecrets[] = [];
      const stages: string[] = [];
      const service = yield* makeSandboxSubmissions(configurations, {
        ...baseProvisioner,
        stage: (stage, _value, captured) =>
          Effect.gen(function* () {
            stages.push(stage);
            captures.push(captured);
            if (stage === "create") {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
          }),
      });
      expect(
        (yield* service.launchOptions(account.id)).runtime?.providers[0]?.models[0]?.slug,
      ).toBe("sonnet");
      const accepted = yield* service.submit(input);
      yield* Deferred.await(entered);
      expect(accepted.progress.phase).toBe("running");
      expect((yield* service.get(input.commandId)).input.prompt).toBe(input.prompt);
      expect((yield* service.list).map((value) => value.input.threadId)).toEqual([input.threadId]);
      expect(accepted.source.commit).toBe(source.commit);
      yield* configurations.save({
        id: account.id,
        provider: "sprites",
        name: "Renamed",
        expectedRevision: account.revision,
        credential: "changed-token",
      });
      yield* configurations.saveProviderInstance({
        id: account.id,
        expectedRevision: account.revision + 1,
        instanceId,
        instance: { driver, enabled: false },
      });
      expect((yield* service.submit(input)).input).toEqual(input);
      expect((yield* Effect.flip(service.submit({ ...input, prompt: "different" }))).code).toBe(
        "conflict",
      );
      yield* Deferred.succeed(release, undefined);
      const done = yield* settled(service, input.commandId);
      expect(done.progress.phase).toBe("done");
      expect(done.destination?.threadId).toBe(input.threadId);
      expect(
        (yield* service.list).find((value) => value.input.commandId === input.commandId)
          ?.destination,
      ).toEqual(done.destination);
      expect(done.progress.stages.map((stage) => [stage.id, stage.status])).toEqual([
        ["source", "done"],
        ["create", "done"],
        ["runtime", "done"],
        ["server", "done"],
        ["clone", "done"],
        ["connect", "done"],
        ["agent", "done"],
      ]);
      expect(stages).toEqual(["create", "runtime", "server", "clone", "connect"]);
      expect(captures.every((capture) => capture.credential === "personal-token")).toBe(true);
      expect(captures[0]?.providerInstances[instanceId]?.environment?.[0]?.value).toBe(
        "personal-provider-key",
      );
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ body: string }>`SELECT body FROM sandbox_submissions`;
      expect(rows[0]?.body).not.toContain("personal-token");
      expect(rows[0]?.body).not.toContain("personal-provider-key");
      expect(done.progress.sequence).toBeGreaterThan(accepted.progress.sequence);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("settles a submission as failed when a setup stage defects", () =>
  Effect.gen(function* () {
    const { configurations, input } = yield* setup;
    const service = yield* makeSandboxSubmissions(configurations, {
      ...baseProvisioner,
      stage: (stage) => (stage === "runtime" ? Effect.die("unexpected") : Effect.void),
    });
    yield* service.submit(input);
    const failed = yield* settled(service, input.commandId);
    expect(failed.progress.phase).toBe("failed");
    expect(failed.progress.error).toBe("Sandbox setup failed unexpectedly.");
    expect(failed.progress.stages.find((stage) => stage.id === "runtime")?.status).toBe("failed");
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "recovers after host shutdown and retries a lost intake receipt without reallocating or changing source",
  () =>
    Effect.gen(function* () {
      const { configurations, input } = yield* setup;
      const allocated = new Set<string>();
      const turns = new Set<string>();
      const created = yield* Deferred.make<void>();
      let firstStage = true;
      let loseReceipt = true;
      let resolutions = 0;
      const provisioner: SandboxProvisioner = {
        ...baseProvisioner,
        resolveSource: () =>
          Effect.sync(() => {
            resolutions++;
            return source;
          }),
        stage: (stage, value) =>
          Effect.gen(function* () {
            if (stage === "create") {
              allocated.add(value.input.commandId);
              if (firstStage) {
                firstStage = false;
                yield* Deferred.succeed(created, undefined);
                return yield* Effect.never;
              }
            }
          }),
        intake: (value) =>
          Effect.gen(function* () {
            turns.add(value.input.commandId);
            if (loseReceipt) {
              loseReceipt = false;
              return yield* new SandboxSubmissionError({
                code: "unavailable",
                message: "lost receipt",
              });
            }
            return yield* baseProvisioner.intake(value, {
              credential: "captured",
              providerInstances: {},
            });
          }),
      };
      const firstScope = yield* Scope.make();
      const first = yield* makeSandboxSubmissions(configurations, provisioner).pipe(
        Effect.provideService(Scope.Scope, firstScope),
      );
      yield* first.submit(input);
      yield* Deferred.await(created);
      yield* Scope.close(firstScope, Exit.void);
      const recovered = yield* makeSandboxSubmissions(configurations, provisioner);
      yield* recovered.resume;
      const failed = yield* settled(recovered, input.commandId);
      expect(failed.progress.phase).toBe("failed");
      expect(failed.intakeStarted).toBe(true);
      expect(failed.progress.stages.find((stage) => stage.id === "agent")?.status).toBe("failed");
      expect((yield* Effect.flip(recovered.cancel(input.commandId))).code).toBe("too-late");
      yield* recovered.retry(input.commandId);
      const done = yield* settled(recovered, input.commandId);
      expect(done.progress.phase).toBe("done");
      expect(done.input).toEqual(input);
      expect(done.source).toEqual(source);
      expect(resolutions).toBe(1);
      expect(allocated.size).toBe(1);
      expect(turns.size).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "cancels before intake only after resource cleanup, and keeps cancellation terminal",
  () =>
    Effect.gen(function* () {
      const { configurations, input } = yield* setup;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void, SandboxSubmissionError>();
      let cleaned = 0;
      let intakes = 0;
      const service = yield* makeSandboxSubmissions(configurations, {
        ...baseProvisioner,
        stage: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        cancel: () =>
          Effect.sync(() => {
            cleaned++;
          }),
        intake: (value, instances) =>
          Effect.sync(() => {
            intakes++;
          }).pipe(Effect.andThen(baseProvisioner.intake(value, instances))),
      });
      yield* service.submit(input);
      yield* Deferred.await(entered);
      const requested = yield* service.cancel(input.commandId);
      expect(requested.cancelRequested).toBe(true);
      expect(requested.progress.phase).toBe("running");
      yield* Deferred.fail(
        release,
        new SandboxSubmissionError({ code: "unavailable", message: "provisioning failed" }),
      );
      expect((yield* settled(service, input.commandId)).progress.phase).toBe("cancelled");
      expect((yield* service.retry(input.commandId)).progress.phase).toBe("cancelled");
      expect(cleaned).toBe(1);
      expect(intakes).toBe(0);
      const sql = yield* SqlClient.SqlClient;
      const secrets = yield* Secrets.ServerSecretStore;
      const rows = yield* sql<{ secret_ref: string }>`SELECT secret_ref FROM sandbox_submissions
        WHERE id = ${input.commandId}`;
      expect(Option.isNone(yield* secrets.get(rows[0]!.secret_ref))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("keeps a failed cancellation retryable after provisioning fails", () =>
  Effect.gen(function* () {
    const { configurations, input } = yield* setup;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void, SandboxSubmissionError>();
    let cleanups = 0;
    let intakes = 0;
    const service = yield* makeSandboxSubmissions(configurations, {
      ...baseProvisioner,
      stage: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      cancel: () =>
        Effect.gen(function* () {
          cleanups++;
          if (cleanups === 1)
            return yield* new SandboxSubmissionError({
              code: "unavailable",
              message: "cleanup failed",
            });
        }),
      intake: (value, instances) =>
        Effect.sync(() => {
          intakes++;
        }).pipe(Effect.andThen(baseProvisioner.intake(value, instances))),
    });
    yield* service.submit(input);
    yield* Deferred.await(entered);
    yield* service.cancel(input.commandId);
    yield* Deferred.fail(
      release,
      new SandboxSubmissionError({ code: "unavailable", message: "provisioning failed" }),
    );
    const failed = yield* settled(service, input.commandId);
    expect(failed.progress.phase).toBe("failed");
    expect(failed.progress.error).toBe("cleanup failed");
    expect(failed.cancelRequested).toBe(true);
    yield* service.cancel(input.commandId);
    expect((yield* settled(service, input.commandId)).progress.phase).toBe("cancelled");
    expect(cleanups).toBe(2);
    expect(intakes).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "rejects unavailable runtimes, stale accounts and unsupported options before allocating",
  () =>
    Effect.gen(function* () {
      const { configurations, input, account } = yield* setup;
      const unavailable = yield* makeSandboxSubmissions(configurations);
      expect((yield* unavailable.launchOptions(account.id)).runtime).toBeNull();
      expect((yield* Effect.flip(unavailable.submit(input))).code).toBe("unsupported");
      let allocations = 0;
      const service = yield* makeSandboxSubmissions(configurations, {
        ...baseProvisioner,
        stage: () =>
          Effect.sync(() => {
            allocations++;
          }),
      });
      expect((yield* Effect.flip(service.submit({ ...input, expectedRevision: 0 }))).code).toBe(
        "conflict",
      );
      for (const modelSelection of [
        { instanceId, model: "missing" },
        { instanceId, model: "sonnet", options: [{ id: "effort", value: "low" }] },
        { instanceId, model: "sonnet", options: [{ id: "invented", value: true }] },
      ])
        expect((yield* Effect.flip(service.submit({ ...input, modelSelection }))).code).toBe(
          "unsupported",
        );
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT id FROM sandbox_submissions`).toEqual([]);
      expect(allocations).toBe(0);

      let sourceResolutions = 0;
      const withoutPlan = yield* makeSandboxSubmissions(configurations, {
        ...baseProvisioner,
        runtime: {
          ...runtime,
          providers: runtime.providers.map((provider) => ({
            ...provider,
            showInteractionModeToggle: false,
          })),
        },
        resolveSource: () =>
          Effect.sync(() => {
            sourceResolutions++;
            return source;
          }),
      });
      expect((yield* Effect.flip(withoutPlan.submit(input))).code).toBe("unsupported");
      expect(sourceResolutions).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

for (const nextRuntime of [null, { ...runtime, id: "replacement-runtime" }]) {
  it.effect(
    `cancels captured resources after restart with ${nextRuntime?.id ?? "no runtime"}`,
    () =>
      Effect.gen(function* () {
        const { configurations, account, input } = yield* setup;
        const firstScope = yield* Scope.make();
        const first = yield* makeSandboxSubmissions(configurations, {
          ...baseProvisioner,
          stage: () =>
            Effect.fail(
              new SandboxSubmissionError({
                code: "unavailable",
                message: "Sprites request failed (403).",
              }),
            ),
        }).pipe(Effect.provideService(Scope.Scope, firstScope));
        yield* first.submit(input);
        const failed = yield* settled(first, input.commandId);
        expect(failed.progress.error).toBe("Sprites request failed (403).");
        expect((yield* first.list)[0]?.progress.error).toBe(failed.progress.error);
        yield* Scope.close(firstScope, Exit.void);
        yield* configurations.save({
          id: account.id,
          provider: "sprites",
          name: "Changed",
          expectedRevision: account.revision,
          credential: "replacement-token",
        });
        const cleanups: string[] = [];
        const recovered = yield* makeSandboxSubmissions(configurations, {
          ...baseProvisioner,
          runtime: nextRuntime,
          stage: () => Effect.die("Cancellation must not run setup"),
          intake: () => Effect.die("Cancellation must not run intake"),
          cancel: (value, credential) =>
            Effect.sync(() => {
              expect(value.runtime).toEqual(runtime);
              expect(value.input).toEqual(input);
              cleanups.push(credential);
            }),
        });
        yield* recovered.cancel(input.commandId);
        expect((yield* settled(recovered, input.commandId)).progress.phase).toBe("cancelled");
        expect(cleanups).toEqual(["personal-token"]);
      }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
}

it.effect("accepts other submissions while one is still resolving its source", () =>
  Effect.gen(function* () {
    const { configurations, input } = yield* setup;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const service = yield* makeSandboxSubmissions(configurations, {
      ...baseProvisioner,
      resolveSource: (value) =>
        value.commandId === input.commandId
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(source),
            )
          : Effect.succeed(source),
    });
    const slow = yield* Effect.forkChild(service.submit(input));
    yield* Deferred.await(entered);

    const other = yield* service.submit({
      ...input,
      commandId: CommandId.make("submission-2"),
      threadId: ThreadId.make("thread-2"),
      messageId: MessageId.make("message-2"),
    });
    expect(other.input.commandId).toBe("submission-2");

    yield* Deferred.succeed(release, undefined);
    expect((yield* Fiber.join(slow)).input.commandId).toBe(input.commandId);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("pairs and deletes with the account's credential after the captured one is revoked", () =>
  Effect.gen(function* () {
    const { configurations, account, input } = yield* setup;
    const revoked = new SandboxSubmissionError({
      code: "unavailable",
      message: "Sprites request failed (401).",
    });
    const pairCredentials: string[] = [];
    const deleteCredentials: string[] = [];
    const service = yield* makeSandboxSubmissions(configurations, {
      ...baseProvisioner,
      pair: (value, secrets) => {
        pairCredentials.push(secrets.credential);
        return secrets.credential === "personal-token"
          ? Effect.fail(revoked)
          : Effect.succeed({
              destination: value.destination!,
              url: "https://sprite.example",
              pairingToken: "token",
            });
      },
      delete: (_value, credential) => {
        deleteCredentials.push(credential);
        return credential === "personal-token" ? Effect.fail(revoked) : Effect.void;
      },
    });
    yield* service.submit(input);
    yield* settled(service, input.commandId);
    yield* configurations.save({
      id: account.id,
      provider: "sprites",
      name: "Personal",
      expectedRevision: account.revision,
      credential: "rotated-token",
    });

    yield* service.pair(input.commandId);
    const deleted = yield* service.remove(input.commandId);

    expect(pairCredentials).toEqual(["personal-token", "rotated-token"]);
    expect(deleteCredentials).toEqual(["personal-token", "rotated-token"]);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.deletionError).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "deletes completed resources idempotently with the captured credential and retries failures",
  () =>
    Effect.gen(function* () {
      const { configurations, account, input } = yield* setup;
      const credentials: string[] = [];
      let attempts = 0;
      let pairs = 0;
      const service = yield* makeSandboxSubmissions(configurations, {
        ...baseProvisioner,
        pair: (value) => {
          pairs++;
          return Effect.succeed({
            destination: value.destination!,
            url: "https://sprite.example",
            pairingToken: "token",
          });
        },
        delete: (_value, credential) =>
          Effect.gen(function* () {
            credentials.push(credential);
            if (attempts++ === 0)
              return yield* new SandboxSubmissionError({
                code: "unavailable",
                message: "Sprites deletion failed.",
              });
          }),
      });
      yield* service.submit(input);
      yield* settled(service, input.commandId);
      yield* configurations.remove({ id: account.id, expectedRevision: account.revision });

      const failed = yield* service.remove(input.commandId);
      expect(failed.deletedAt).toBeNull();
      expect(failed.deletionError).toBe("Sprites deletion failed.");
      const deleted = yield* service.remove(input.commandId);
      expect(deleted.deletedAt).not.toBeNull();
      expect(deleted.deletionError).toBeNull();
      expect((yield* service.remove(input.commandId)).deletedAt).toBe(deleted.deletedAt);
      expect(credentials).toEqual(["personal-token", "personal-token"]);
      const sql = yield* SqlClient.SqlClient;
      const secrets = yield* Secrets.ServerSecretStore;
      const rows = yield* sql<{ secret_ref: string }>`SELECT secret_ref FROM sandbox_submissions
      WHERE id = ${input.commandId}`;
      expect(Option.isNone(yield* secrets.get(rows[0]!.secret_ref))).toBe(true);
      expect((yield* service.retry(input.commandId)).deletedAt).toBe(deleted.deletedAt);
      expect((yield* Effect.flip(service.pair(input.commandId))).code).toBe("invalid");
      expect(pairs).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "keeps deferred deletion of a failed submission terminal across retry and cancellation",
  () =>
    Effect.gen(function* () {
      const { configurations, input } = yield* setup;
      const deleteEntered = yield* Deferred.make<void>();
      const releaseDelete = yield* Deferred.make<void>();
      let deletions = 0;
      const service = yield* makeSandboxSubmissions(configurations, {
        ...baseProvisioner,
        stage: () =>
          Effect.fail(
            new SandboxSubmissionError({ code: "unavailable", message: "provisioning failed" }),
          ),
        delete: () =>
          Effect.gen(function* () {
            deletions++;
            yield* Deferred.succeed(deleteEntered, undefined);
            yield* Deferred.await(releaseDelete);
          }),
      });
      yield* service.submit(input);
      expect((yield* settled(service, input.commandId)).progress.phase).toBe("failed");

      const removing = yield* Effect.forkScoped(service.remove(input.commandId));
      yield* Deferred.await(deleteEntered);
      const retrying = yield* Effect.forkScoped(service.retry(input.commandId));
      const cancelling = yield* Effect.forkScoped(service.cancel(input.commandId));
      yield* Fiber.join(retrying);
      yield* Fiber.join(cancelling);
      yield* Deferred.succeed(releaseDelete, undefined);

      const deleted = yield* Fiber.join(removing);
      const final = yield* service.get(input.commandId);
      expect(final.deletedAt).toBe(deleted.deletedAt);
      expect(final.progress.phase).toBe("failed");
      expect(final.progress.error).toBe("provisioning failed");
      expect((yield* service.retry(input.commandId)).deletedAt).toBe(deleted.deletedAt);
      expect((yield* service.cancel(input.commandId)).deletedAt).toBe(deleted.deletedAt);
      expect(yield* service.list).toEqual([]);
      expect(deletions).toBe(1);
      const sql = yield* SqlClient.SqlClient;
      const secrets = yield* Secrets.ServerSecretStore;
      const rows = yield* sql<{ secret_ref: string }>`SELECT secret_ref FROM sandbox_submissions
      WHERE id = ${input.commandId}`;
      expect(Option.isNone(yield* secrets.get(rows[0]!.secret_ref))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("streams an initial list snapshot, additions, compact progress, and removals", () =>
  Effect.gen(function* () {
    const { configurations, input } = yield* setup;
    const createEntered = yield* Deferred.make<void>();
    const releaseCreate = yield* Deferred.make<void>();
    let blockCreate = false;
    const service = yield* makeSandboxSubmissions(configurations, {
      ...baseProvisioner,
      stage: (stage) =>
        stage === "create" && blockCreate
          ? Deferred.succeed(createEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseCreate)),
            )
          : Effect.void,
      delete: () => Effect.void,
    });
    yield* service.submit(input);
    yield* settled(service, input.commandId);

    const snapshots =
      yield* Queue.unbounded<Extract<SandboxSubmissionListEvent, { type: "snapshot" }>>();
    const additions =
      yield* Queue.unbounded<Extract<SandboxSubmissionListEvent, { type: "added" }>>();
    const updates =
      yield* Queue.unbounded<Extract<SandboxSubmissionListEvent, { type: "updated" }>>();
    const removals =
      yield* Queue.unbounded<Extract<SandboxSubmissionListEvent, { type: "removed" }>>();
    yield* service.listStream.pipe(
      Stream.runForEach((event) => {
        switch (event.type) {
          case "snapshot":
            return Queue.offer(snapshots, event);
          case "added":
            return Queue.offer(additions, event);
          case "updated":
            return Queue.offer(updates, event);
          case "removed":
            return Queue.offer(removals, event);
        }
      }),
      Effect.forkScoped,
    );
    const snapshot = yield* Queue.take(snapshots);
    expect(snapshot.submissions.map((value) => value.input.commandId)).toEqual([input.commandId]);
    // Clients never receive the accepted prompt, pinned source or runtime catalog.
    expect(snapshot.submissions[0]!.input).toEqual({
      commandId: input.commandId,
      title: input.title,
    });
    expect("runtime" in snapshot.submissions[0]!).toBe(false);
    expect("source" in snapshot.submissions[0]!).toBe(false);

    blockCreate = true;
    const second = {
      ...input,
      commandId: CommandId.make("submission-2"),
      threadId: ThreadId.make("thread-2"),
      messageId: MessageId.make("message-2"),
    };
    yield* service.submit(second);
    const added = (yield* Queue.take(additions)).submission;
    expect(added.input).toEqual({ commandId: second.commandId, title: second.title });
    expect("runtime" in added).toBe(false);
    yield* Deferred.await(createEntered);
    const progress = yield* Queue.take(updates);
    expect(progress.update.commandId).toBe(second.commandId);
    expect(progress.update.progress.phase).toBe("running");
    expect("input" in progress.update).toBe(false);
    expect("runtime" in progress.update).toBe(false);
    yield* Deferred.succeed(releaseCreate, undefined);
    yield* settled(service, second.commandId);
    yield* service.remove(second.commandId);
    expect((yield* Queue.take(removals)).commandId).toBe(second.commandId);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
