import {
  ProviderInstanceConfigMap,
  SandboxDestination,
  SandboxPinnedSource,
  SandboxSubmissionRecord,
  SandboxSubmissionError,
  SandboxSubmitInput,
  sandboxInstanceHasCredential,
  type CommandId,
  type SandboxLaunchOptions,
  type SandboxDestinationConnection,
  type SandboxRuntimeCatalog,
  type SandboxRuntimeManifest,
  type SandboxSubmission,
  type SandboxSubmissionListEvent,
  type SandboxSubmissionUpdate,
  type WorktreeSetupStageId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { SandboxConfigurations } from "./SandboxConfiguration.ts";
import { makeConfiguredSandboxProvisioner } from "./SandboxProvisioner.ts";
import { SANDBOX_RELEASE_VERSION } from "./SandboxArtifact.ts";
import { validateSandboxSelection } from "./SandboxRuntime.ts";

const CapturedSecrets = Schema.Struct({
  credential: Schema.String,
  namePrefix: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  providerInstances: ProviderInstanceConfigMap,
});
export type SandboxCapturedSecrets = typeof CapturedSecrets.Type;
export const SANDBOX_PROVISION_STAGES = [
  "create",
  "runtime",
  "server",
  "clone",
  "connect",
] as const satisfies ReadonlyArray<WorktreeSetupStageId>;

/** Packs the pinned commit from the host project for providers to seed a sandbox with. */
export type SandboxSourcePacker = (
  submission: SandboxSubmissionRecord,
) => Effect.Effect<Uint8Array, SandboxSubmissionError>;

/** Every operation must reconcile by commandId before creating external state.
 * A retry can repeat a completed call whose acknowledgement was lost. */
export interface SandboxProvisioner {
  /** Offered before any download; the artifact must carry the same catalog id. */
  readonly catalog: SandboxRuntimeCatalog;
  readonly runtime: SandboxRuntimeManifest | null;
  readonly getRuntime?: Effect.Effect<SandboxRuntimeManifest | null>;
  readonly resolveSource: (
    input: SandboxSubmitInput,
  ) => Effect.Effect<SandboxPinnedSource, SandboxSubmissionError>;
  readonly stage: (
    stage: (typeof SANDBOX_PROVISION_STAGES)[number],
    submission: SandboxSubmissionRecord,
    secrets: SandboxCapturedSecrets,
  ) => Effect.Effect<void, SandboxSubmissionError>;
  readonly intake: (
    submission: SandboxSubmissionRecord,
    secrets: SandboxCapturedSecrets,
  ) => Effect.Effect<SandboxDestination, SandboxSubmissionError>;
  readonly cancel: (
    submission: SandboxSubmissionRecord,
    credential: string,
  ) => Effect.Effect<void, SandboxSubmissionError>;
  readonly delete?: (
    submission: SandboxSubmissionRecord,
    credential: string,
  ) => Effect.Effect<void, SandboxSubmissionError>;
  readonly pair?: (
    submission: SandboxSubmissionRecord,
    secrets: SandboxCapturedSecrets,
  ) => Effect.Effect<SandboxDestinationConnection, SandboxSubmissionError>;
}

const failure = (code: SandboxSubmissionError["code"], message: string) =>
  new SandboxSubmissionError({ code, message });
const storageFailure = () => failure("storage", "Unable to read or persist sandbox submission.");
const now = Effect.map(DateTime.now, DateTime.formatIso);
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(SandboxSubmissionRecord));
const decodeSecrets = Schema.decodeUnknownEffect(Schema.fromJsonString(CapturedSecrets));
const encode = Schema.encodeEffect(Schema.fromJsonString(SandboxSubmissionRecord));
const encodeSecrets = Schema.encodeEffect(Schema.fromJsonString(CapturedSecrets));
const decodeInput = Schema.decodeUnknownEffect(SandboxSubmitInput);
const decodeSource = Schema.decodeUnknownEffect(SandboxPinnedSource);
const decodeDestination = Schema.decodeUnknownEffect(SandboxDestination);
/** The client view of a record; see the SandboxSubmission contract. */
export const toSandboxSubmission = (value: SandboxSubmissionRecord): SandboxSubmission => ({
  input: {
    commandId: value.input.commandId,
    title: value.input.title,
    configurationId: value.input.configurationId,
  },
  progress: value.progress,
  destination: value.destination,
  intakeStarted: value.intakeStarted,
  cancelRequested: value.cancelRequested,
  deletedAt: value.deletedAt,
  deletionError: value.deletionError,
});
const toUpdate = (value: SandboxSubmissionRecord): SandboxSubmissionUpdate => ({
  commandId: value.input.commandId,
  progress: value.progress,
  destination: value.destination,
  intakeStarted: value.intakeStarted,
  cancelRequested: value.cancelRequested,
  deletedAt: value.deletedAt,
  deletionError: value.deletionError,
});

/** One host-scoped service, independent of client connections. SQL owns progress;
 * immutable private snapshots live in ServerSecretStore, never in RPC responses. */
export const makeSandboxSubmissions = Effect.fnUntraced(function* (
  configurations: SandboxConfigurations["Service"],
  provisioner?: SandboxProvisioner,
) {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore;
  const scope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<SandboxSubmissionUpdate>();
  const listChanges = yield* PubSub.unbounded<SandboxSubmissionListEvent>();
  let listSequence = 0;
  const workers = new Map<CommandId, { lock: Semaphore.Semaphore; pending: number }>();

  const find = Effect.fnUntraced(function* (id: CommandId) {
    const rows = yield* sql<{
      body: string;
    }>`SELECT body FROM sandbox_submissions WHERE id = ${id}`.pipe(Effect.mapError(storageFailure));
    return rows[0] ? yield* decode(rows[0].body).pipe(Effect.mapError(storageFailure)) : null;
  });
  const get = Effect.fnUntraced(function* (id: CommandId) {
    const value = yield* find(id);
    if (!value) return yield* failure("invalid", "Sandbox submission does not exist.");
    return value;
  });
  const save = Effect.fnUntraced(function* (value: SandboxSubmissionRecord) {
    const body = yield* encode(value).pipe(Effect.mapError(storageFailure));
    yield* sql`UPDATE sandbox_submissions SET body = ${body} WHERE id = ${value.input.commandId}`.pipe(
      Effect.mapError(storageFailure),
    );
    yield* PubSub.publish(changes, toUpdate(value));
    yield* PubSub.publish(
      listChanges,
      value.deletedAt || value.progress.phase === "cancelled"
        ? {
            version: 1,
            sequence: ++listSequence,
            type: "removed",
            commandId: value.input.commandId,
          }
        : { version: 1, sequence: ++listSequence, type: "updated", update: toUpdate(value) },
    );
    return value;
  });
  const update = (
    id: CommandId,
    change: (value: SandboxSubmissionRecord, at: string) => SandboxSubmissionRecord,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* get(id);
        const next = change(current, yield* now);
        return yield* save({
          ...next,
          progress: { ...next.progress, sequence: current.progress.sequence + 1 },
        });
      }),
    );
  const secretRef = Effect.fnUntraced(function* (id: CommandId) {
    const rows = yield* sql<{
      secret_ref: string;
    }>`SELECT secret_ref FROM sandbox_submissions WHERE id = ${id}`.pipe(
      Effect.mapError(storageFailure),
    );
    if (!rows[0]) return yield* storageFailure();
    return rows[0].secret_ref;
  });
  const captured = Effect.fnUntraced(function* (id: CommandId) {
    const bytes = yield* secrets.get(yield* secretRef(id)).pipe(Effect.mapError(storageFailure));
    if (Option.isNone(bytes)) return yield* storageFailure();
    return yield* decodeSecrets(new TextDecoder().decode(bytes.value)).pipe(
      Effect.mapError(storageFailure),
    );
  });
  const capturedOption = Effect.fnUntraced(function* (id: CommandId) {
    const bytes = yield* secrets.get(yield* secretRef(id)).pipe(Effect.mapError(storageFailure));
    if (Option.isNone(bytes)) return null;
    return yield* decodeSecrets(new TextDecoder().decode(bytes.value)).pipe(
      Effect.mapError(storageFailure),
    );
  });
  const removeCaptured = Effect.fnUntraced(function* (id: CommandId) {
    yield* secrets.remove(yield* secretRef(id)).pipe(Effect.mapError(storageFailure));
  });
  // Resources belong to the account captured at submission. If that credential
  // has since been rotated or revoked, retry once with the account's saved one.
  const withResourceCredential = <A>(
    submission: SandboxSubmissionRecord,
    snapshot: SandboxCapturedSecrets | null,
    operation: (credential: string) => Effect.Effect<A, SandboxSubmissionError>,
  ) =>
    operation(snapshot?.credential ?? "").pipe(
      Effect.catch((error) =>
        configurations.currentCredential(submission.input.configurationId).pipe(
          Effect.mapError(storageFailure),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(error),
              onSome: (current) =>
                current === snapshot?.credential ? Effect.fail(error) : operation(current),
            }),
          ),
        ),
      ),
    );
  const cancelAndForget = Effect.fnUntraced(function* (
    id: CommandId,
    submission: SandboxSubmissionRecord,
    credential?: string,
  ) {
    if (!provisioner) return yield* failure("unsupported", "This server can't launch sandboxes.");
    const cancel = provisioner.cancel;
    yield* credential === undefined
      ? withResourceCredential(submission, yield* capturedOption(id), (value) =>
          cancel(submission, value),
        )
      : cancel(submission, credential);
    yield* removeCaptured(id);
  });
  const stageStatus = (id: CommandId, stage: WorktreeSetupStageId, status: "running" | "done") =>
    update(id, (value, at) => ({
      ...value,
      progress: {
        ...value.progress,
        stages: value.progress.stages.map((entry) =>
          entry.id !== stage
            ? entry
            : {
                ...entry,
                status,
                startedAt: entry.startedAt ?? at,
                endedAt: status === "done" ? at : null,
              },
        ),
      },
    }));
  const process = Effect.fnUntraced(function* (id: CommandId) {
    let value = yield* get(id);
    if (value.deletedAt || value.progress.phase !== "running") return;
    if (!provisioner) return yield* failure("unsupported", "This server can't launch sandboxes.");
    if (value.cancelRequested) {
      yield* cancelAndForget(id, value);
      yield* update(id, (current, at) => ({
        ...current,
        progress: { ...current.progress, phase: "cancelled", endedAt: at, error: null },
      }));
      return;
    }
    const snapshot = yield* captured(id);
    for (const stage of [...SANDBOX_PROVISION_STAGES, "agent"] as const) {
      value = yield* get(id);
      if (value.cancelRequested) {
        yield* cancelAndForget(id, value, snapshot.credential);
        yield* update(id, (current, at) => ({
          ...current,
          progress: { ...current.progress, phase: "cancelled", endedAt: at, error: null },
        }));
        return;
      }
      if (value.progress.stages.find((entry) => entry.id === stage)?.status === "done") continue;
      if (stage === "agent") {
        // Serialize the cancellation fence with cancel(). Once persisted, reconcile intake
        // on retry, even if its first response never reached this host.
        value = yield* update(id, (current) =>
          current.cancelRequested ? current : { ...current, intakeStarted: true },
        );
        if (value.cancelRequested) {
          yield* cancelAndForget(id, value, snapshot.credential);
          yield* update(id, (current, at) => ({
            ...current,
            progress: { ...current.progress, phase: "cancelled", endedAt: at, error: null },
          }));
          return;
        }
        yield* stageStatus(id, stage, "running");
        const destination = yield* provisioner.intake(value, snapshot);
        const decoded = yield* decodeDestination(destination).pipe(
          Effect.mapError(() => failure("invalid", "Invalid sandbox destination.")),
        );
        if (decoded.threadId !== value.input.threadId)
          return yield* failure("invalid", "Sandbox destination thread does not match.");
        yield* update(id, (current) => ({ ...current, destination: decoded }));
      } else {
        yield* stageStatus(id, stage, "running");
        const cancelled = yield* provisioner.stage(stage, value, snapshot).pipe(
          Effect.as(false),
          Effect.catch((error) =>
            Effect.gen(function* () {
              const current = yield* get(id);
              if (!current.cancelRequested) return yield* error;
              yield* cancelAndForget(id, current, snapshot.credential);
              yield* update(id, (latest, at) => ({
                ...latest,
                progress: { ...latest.progress, phase: "cancelled", endedAt: at, error: null },
              }));
              return true;
            }),
          ),
        );
        if (cancelled) return;
      }
      yield* stageStatus(id, stage, "done");
    }
    yield* update(id, (current, at) => ({
      ...current,
      progress: { ...current.progress, phase: "done", endedAt: at, error: null },
    }));
  });
  const start = Effect.fnUntraced(function* (id: CommandId) {
    const worker = workers.get(id) ?? { lock: Semaphore.makeUnsafe(1), pending: 0 };
    workers.set(id, worker);
    worker.pending++;
    yield* worker.lock
      .withPermits(1)(
        process(id).pipe(
          // A defect must also settle the submission; otherwise it stays running with no worker.
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              update(id, (current, at) => ({
                ...current,
                progress: {
                  ...current.progress,
                  phase: "failed",
                  endedAt: at,
                  error: Option.match(Cause.findErrorOption(cause), {
                    onNone: () => "Sandbox setup failed unexpectedly.",
                    onSome: (error) => error.message,
                  }),
                  stages: current.progress.stages.map((entry) =>
                    entry.status === "running"
                      ? { ...entry, status: "failed", endedAt: at }
                      : entry,
                  ),
                },
              })),
          ),
        ),
      )
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (--worker.pending === 0) workers.delete(id);
          }),
        ),
        Effect.interruptible,
        Effect.forkIn(scope),
      );
  });
  const launchOptions = Effect.fnUntraced(function* (
    configurationId: string,
  ): Effect.fn.Return<SandboxLaunchOptions, SandboxSubmissionError> {
    const values = yield* configurations.read.pipe(Effect.mapError(storageFailure));
    const account = values.find((value) => value.id === configurationId);
    if (!account) return yield* failure("invalid", "Sandbox configuration does not exist.");
    return {
      configurationRevision: account.revision,
      runtime: provisioner?.catalog ?? null,
      reason: provisioner ? null : "This server can't launch sandboxes.",
    };
  });
  const replay = Effect.fnUntraced(function* (decoded: SandboxSubmitInput) {
    const previous = yield* find(decoded.commandId);
    if (!previous) return null;
    if (!NodeUtil.isDeepStrictEqual(previous.input, decoded))
      return yield* failure("conflict", "Submission command was already used for different input.");
    return previous;
  });
  const submit = Effect.fnUntraced(function* (input: SandboxSubmitInput) {
    const decoded = yield* decodeInput(input).pipe(
      Effect.mapError(() => failure("invalid", "Invalid sandbox submission.")),
    );
    const replayed = yield* replay(decoded);
    if (replayed) return replayed;
    // Runtime downloads and source resolution stay outside the lock so one slow
    // launch never stalls progress, cancellation or listing for the others.
    if (!provisioner) return yield* failure("unsupported", "This server can't launch sandboxes.");
    if (decoded.runtimeId !== provisioner.catalog.id)
      return yield* failure("conflict", "Sandbox models changed. Choose a model again.");
    // The composer showed the host's catalog; the launch is checked against the
    // artifact that will actually run, before any Sprite exists.
    const runtime = provisioner.getRuntime ? yield* provisioner.getRuntime : provisioner.runtime;
    if (!runtime)
      return yield* failure(
        "unavailable",
        `Couldn't download the T3 Code server (v${SANDBOX_RELEASE_VERSION}) that runs inside the sandbox.`,
      );
    if (runtime.id !== provisioner.catalog.id)
      return yield* failure(
        "unsupported",
        "The T3 Code server build for the sandbox doesn't match this server's models.",
      );
    const capture = yield* configurations
      .capture(decoded.configurationId, decoded.expectedRevision)
      .pipe(
        Effect.mapError((error) =>
          failure(error.code === "conflict" ? "conflict" : "invalid", error.message),
        ),
      );
    yield* validateSandboxSelection(
      runtime,
      capture.providerInstances,
      decoded.modelSelection,
      decoded.interactionMode,
    );
    // Fail here rather than minutes later when the agent starts on the Sprite.
    if (
      !sandboxInstanceHasCredential(capture.providerInstances[decoded.modelSelection.instanceId]!)
    )
      return yield* failure("invalid", "Sandbox provider credential required.");
    const source = yield* provisioner
      .resolveSource(decoded)
      .pipe(
        Effect.flatMap((value) =>
          decodeSource(value).pipe(
            Effect.mapError(() => failure("invalid", "Unable to resolve project source.")),
          ),
        ),
      );
    // Reported like a new worktree's fetch stage.
    const originMissed =
      decoded.startFromOrigin === true && !source.remoteRef && source.repositoryUrl !== null;
    const sourceDetail = source.remoteRef
      ? `${source.remoteRef} at ${source.commit.slice(0, 7)}`
      : originMissed
        ? `origin/${source.branch} not found, using local branch`
        : null;
    const accepted = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const previous = yield* replay(decoded);
        if (previous) return previous;
        const at = yield* now;
        const value: SandboxSubmissionRecord = {
          input: decoded,
          source,
          runtime,
          acceptedAt: at,
          destination: null,
          intakeStarted: false,
          cancelRequested: false,
          deletedAt: null,
          deletionError: null,
          progress: {
            kind: "sandbox",
            threadId: decoded.threadId,
            phase: "running",
            startedAt: at,
            endedAt: null,
            branch: source.branch,
            baseRef: source.commit,
            worktreePath: null,
            setupScript: null,
            error: null,
            sequence: 1,
            stages: ["source" as const, ...SANDBOX_PROVISION_STAGES, "agent" as const].map(
              (id) => ({
                id,
                status:
                  id !== "source"
                    ? ("pending" as const)
                    : originMissed
                      ? ("warning" as const)
                      : ("done" as const),
                startedAt: id === "source" ? at : null,
                endedAt: id === "source" ? at : null,
                percent: null,
                detail: id === "source" ? sourceDetail : null,
                tail: [],
              }),
            ),
          },
        };
        // Unique per attempt: a crash before SQL commit can leave an orphan secret,
        // but cannot let a later command overwrite an accepted operation's snapshot.
        const key = `sandbox-submission-${NodeCrypto.createHash("sha256").update(decoded.commandId).digest("hex")}-${NodeCrypto.randomUUID()}`;
        const privateBody = yield* encodeSecrets({
          credential: capture.credential,
          namePrefix: capture.configuration.namePrefix,
          providerInstances: capture.providerInstances,
        }).pipe(Effect.mapError(storageFailure));
        const body = yield* encode(value).pipe(Effect.mapError(storageFailure));
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* secrets
              .create(key, new TextEncoder().encode(privateBody))
              .pipe(Effect.mapError(storageFailure));
            yield* sql`INSERT INTO sandbox_submissions (id, thread_id, secret_ref, body) VALUES (${decoded.commandId}, ${decoded.threadId}, ${key}, ${body})`.pipe(
              Effect.mapError(storageFailure),
              Effect.onError(() => secrets.remove(key).pipe(Effect.ignore)),
            );
            // A disconnect after commit cannot strand accepted work until restart.
            yield* start(decoded.commandId);
          }),
        );
        yield* PubSub.publish(changes, toUpdate(value));
        yield* PubSub.publish(listChanges, {
          version: 1,
          sequence: ++listSequence,
          type: "added",
          submission: toSandboxSubmission(value),
        });
        return value;
      }),
    );
    return accepted;
  });
  const retry = Effect.fnUntraced(function* (id: CommandId) {
    const value = yield* update(id, (current) =>
      current.deletedAt || current.progress.phase !== "failed"
        ? current
        : {
            ...current,
            progress: { ...current.progress, phase: "running", endedAt: null, error: null },
          },
    );
    if (value.progress.phase === "running") yield* start(id);
    return value;
  }, Effect.uninterruptible);
  const cancel = Effect.fnUntraced(function* (id: CommandId) {
    const value = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* get(id);
        if (current.deletedAt) return current;
        if (current.intakeStarted)
          return yield* failure(
            "too-late",
            "The destination has started accepting this submission.",
          );
        if (current.progress.phase === "cancelled") return current;
        return yield* save({
          ...current,
          cancelRequested: true,
          progress: {
            ...current.progress,
            phase: "running",
            sequence: current.progress.sequence + 1,
            error: null,
            endedAt: null,
          },
        });
      }),
    );
    if (value.progress.phase === "running") yield* start(id);
    return value;
  }, Effect.uninterruptible);
  const stream = (id: CommandId) =>
    Stream.callback<SandboxSubmissionUpdate, SandboxSubmissionError>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const initial = toUpdate(yield* get(id));
          let sequence = initial.progress.sequence;
          Queue.offerUnsafe(mailbox, initial);
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((value) =>
              Effect.sync(() => {
                if (value.commandId !== id || value.progress.sequence <= sequence) return;
                sequence = value.progress.sequence;
                Queue.offerUnsafe(mailbox, value);
              }),
            ),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );
  const list = Effect.gen(function* () {
    const rows = yield* sql<{ body: string }>`SELECT body FROM sandbox_submissions
      WHERE json_extract(body, '$.progress.phase') IN ('running', 'failed', 'done')
      ORDER BY rowid`.pipe(Effect.mapError(storageFailure));
    const values = yield* Effect.forEach(rows, (row) =>
      decode(row.body).pipe(Effect.mapError(storageFailure)),
    );
    return values.filter((value) => value.deletedAt === null);
  });
  const listStream = Stream.callback<SandboxSubmissionListEvent, SandboxSubmissionError>(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(listChanges);
        const initial = yield* lock.withPermits(1)(
          Effect.map(list, (submissions) => ({
            version: 1 as const,
            sequence: listSequence,
            type: "snapshot" as const,
            submissions: submissions.map(toSandboxSubmission),
          })),
        );
        let sequence = initial.sequence;
        Queue.offerUnsafe(mailbox, initial);
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.sequence <= sequence) return;
              sequence = event.sequence;
              Queue.offerUnsafe(mailbox, event);
            }),
          ),
          Effect.forkScoped,
        );
      }),
    // Deltas cannot be dropped: losing an addition or removal corrupts the list.
    { bufferSize: Number.POSITIVE_INFINITY },
  );
  /** Restarts workers for submissions a previous process left running. */
  const resume = Effect.gen(function* () {
    for (const value of yield* list) {
      if (value.progress.phase === "running") yield* start(value.input.commandId);
    }
  });
  const pair = Effect.fnUntraced(function* (id: CommandId) {
    const submission = yield* get(id);
    if (submission.deletedAt)
      return yield* failure("invalid", "Sandbox resource has been deleted.");
    if (!submission.destination || submission.progress.phase !== "done")
      return yield* failure("invalid", "Sandbox destination is not ready.");
    if (!provisioner?.pair) return yield* failure("unsupported", "Sandbox pairing is unavailable.");
    const pairDestination = provisioner.pair;
    const snapshot = yield* captured(id);
    return yield* withResourceCredential(submission, snapshot, (credential) =>
      pairDestination(submission, { ...snapshot, credential }),
    );
  });
  const remove = Effect.fnUntraced(function* (id: CommandId) {
    const worker = workers.get(id) ?? { lock: Semaphore.makeUnsafe(1), pending: 0 };
    workers.set(id, worker);
    worker.pending++;
    const operation = Effect.gen(function* () {
      const submission = yield* get(id);
      const snapshot = yield* capturedOption(id);
      if (submission.deletedAt && !snapshot) return submission;
      if (submission.progress.phase === "running")
        return yield* failure("too-late", "Sandbox provisioning has not completed.");
      if (!provisioner?.delete)
        return yield* failure("unsupported", "Sandbox deletion is unavailable.");
      const deletedAt = yield* now;
      const terminal = {
        phase: submission.progress.phase,
        error: submission.progress.error,
        endedAt: submission.progress.endedAt,
      };
      const deleteResource = provisioner.delete;
      return yield* withResourceCredential(submission, snapshot, (credential) =>
        deleteResource(submission, credential),
      ).pipe(
        Effect.andThen(removeCaptured(id)),
        Effect.andThen(
          update(id, (current) => ({
            ...current,
            progress: { ...current.progress, ...terminal },
            deletedAt: current.deletedAt ?? deletedAt,
            deletionError: null,
          })),
        ),
        Effect.catch((error) =>
          update(id, (current) => ({ ...current, deletionError: error.message })),
        ),
      );
    });
    return yield* worker.lock
      .withPermits(1)(operation)
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (--worker.pending === 0) workers.delete(id);
          }),
        ),
      );
  }, Effect.uninterruptible);
  return {
    launchOptions,
    submit,
    list,
    listStream,
    get,
    retry,
    cancel,
    remove,
    stream,
    pair,
    resume,
  };
});

export class SandboxSubmissions extends Context.Service<
  SandboxSubmissions,
  Effect.Success<ReturnType<typeof makeSandboxSubmissions>>
>()("t3/sandbox/SandboxSubmissions") {}

export const layer = Layer.effect(
  SandboxSubmissions,
  Effect.gen(function* () {
    const configurations = yield* SandboxConfigurations;
    return yield* makeSandboxSubmissions(configurations, yield* makeConfiguredSandboxProvisioner());
  }),
);
