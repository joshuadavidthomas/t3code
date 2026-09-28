import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { ServerProviderModel } from "./server.ts";
import { WorktreeSetupSnapshot } from "./worktreeSetup.ts";

/** A capability distinct from the orchestration protocol: older runtimes cannot accept intake. */
export const SANDBOX_INTAKE_VERSION = 1;
/**
 * The models a sandbox offers. The host computes it from its own code, so the
 * composer never waits on a download; `id` hashes only this catalog.
 */
export const SandboxRuntimeCatalog = Schema.Struct({
  id: TrimmedNonEmptyString,
  orchestrationProtocol: Schema.Int,
  intakeVersion: Schema.Int,
  providers: Schema.Array(
    Schema.Struct({
      driver: ProviderDriverKind,
      version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
      showInteractionModeToggle: Schema.Boolean.pipe(
        Schema.withDecodingDefault(Effect.succeed(false)),
      ),
      models: Schema.Array(ServerProviderModel),
    }),
  ),
});
export type SandboxRuntimeCatalog = typeof SandboxRuntimeCatalog.Type;
/** A built artifact's sidecar: its catalog plus the archive it describes. */
export const SandboxRuntimeManifest = Schema.Struct({
  ...SandboxRuntimeCatalog.fields,
  artifactIntegrity: TrimmedNonEmptyString,
});
export type SandboxRuntimeManifest = typeof SandboxRuntimeManifest.Type;

export const SandboxSubmitInput = Schema.Struct({
  commandId: CommandId,
  configurationId: Schema.String.check(Schema.isUUID(4)),
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runtimeId: TrimmedNonEmptyString,
  projectId: ProjectId,
  branch: TrimmedNonEmptyString,
  /** Like a new worktree, start from origin's copy of the branch when it has one. */
  startFromOrigin: Schema.optional(Schema.Boolean),
  threadId: ThreadId,
  messageId: MessageId,
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type SandboxSubmitInput = typeof SandboxSubmitInput.Type;

/** Resolved by the host, never supplied as a trusted commit by a browser. The host
 * seeds the sandbox with this commit, so it needs no access to the remote. */
export const SandboxPinnedSource = Schema.Struct({
  /** The project's origin without credentials, kept as the sandbox's origin. */
  repositoryUrl: Schema.NullOr(TrimmedNonEmptyString),
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  branch: TrimmedNonEmptyString,
  projectTitle: Schema.optional(TrimmedNonEmptyString),
  /** Set when start from origin found the branch there, e.g. "origin/main". */
  remoteRef: Schema.optional(TrimmedNonEmptyString),
  /** The project's Git identity, so commits made in the sandbox are the user's. */
  author: Schema.optional(
    Schema.Struct({ name: TrimmedNonEmptyString, email: TrimmedNonEmptyString }),
  ),
});
export type SandboxPinnedSource = typeof SandboxPinnedSource.Type;

export const SandboxDestination = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
});
export type SandboxDestination = typeof SandboxDestination.Type;

export const SandboxDestinationConnection = Schema.Struct({
  destination: SandboxDestination,
  /** The sandbox's own public origin; clients pair to it like any remote server. */
  url: TrimmedNonEmptyString,
  pairingToken: TrimmedNonEmptyString,
});
export type SandboxDestinationConnection = typeof SandboxDestinationConnection.Type;

/** The host's durable record of an accepted submission, also handed to the sandbox at intake. */
export const SandboxSubmissionRecord = Schema.Struct({
  input: SandboxSubmitInput,
  source: SandboxPinnedSource,
  runtime: SandboxRuntimeManifest,
  acceptedAt: IsoDateTime,
  progress: WorktreeSetupSnapshot,
  destination: Schema.NullOr(SandboxDestination),
  /** The provider's own name for the sandbox, once it exists. */
  resourceName: Schema.optionalKey(TrimmedNonEmptyString),
  /** Once intake starts, retry reconciles its receipt; cancellation is too late. */
  intakeStarted: Schema.Boolean,
  cancelRequested: Schema.Boolean,
  /** Resource deletion is separate from provisioning cancellation and account removal. */
  deletedAt: Schema.NullOr(IsoDateTime),
  deletionError: Schema.NullOr(Schema.String),
});
export type SandboxSubmissionRecord = typeof SandboxSubmissionRecord.Type;
/** What clients see: the accepted prompt, pinned source and runtime catalog stay on the host. */
export const SandboxSubmission = Schema.Struct({
  input: Schema.Struct({
    commandId: CommandId,
    title: TrimmedNonEmptyString,
    configurationId: Schema.String.check(Schema.isUUID(4)),
    /** The host project it launched from, whose worktree cleanup rules it follows. */
    projectId: ProjectId,
  }),
  progress: WorktreeSetupSnapshot,
  destination: Schema.NullOr(SandboxDestination),
  resourceName: Schema.optionalKey(TrimmedNonEmptyString),
  intakeStarted: Schema.Boolean,
  cancelRequested: Schema.Boolean,
  deletedAt: Schema.NullOr(IsoDateTime),
  deletionError: Schema.NullOr(Schema.String),
});
export type SandboxSubmission = typeof SandboxSubmission.Type;
/** Progress never retransmits the accepted prompt or runtime model catalog. */
export const SandboxSubmissionUpdate = Schema.Struct({
  commandId: CommandId,
  progress: WorktreeSetupSnapshot,
  destination: Schema.NullOr(SandboxDestination),
  intakeStarted: Schema.Boolean,
  cancelRequested: Schema.Boolean,
  deletedAt: Schema.NullOr(IsoDateTime),
  deletionError: Schema.NullOr(Schema.String),
});
export type SandboxSubmissionUpdate = typeof SandboxSubmissionUpdate.Type;
export const SandboxSubmissionListEvent = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    sequence: Schema.Number,
    type: Schema.Literal("snapshot"),
    submissions: Schema.Array(SandboxSubmission),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    sequence: Schema.Number,
    type: Schema.Literal("added"),
    submission: SandboxSubmission,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    sequence: Schema.Number,
    type: Schema.Literal("updated"),
    update: SandboxSubmissionUpdate,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    sequence: Schema.Number,
    type: Schema.Literal("removed"),
    commandId: CommandId,
  }),
]);
export type SandboxSubmissionListEvent = typeof SandboxSubmissionListEvent.Type;
export const SandboxSubmissionInput = Schema.Struct({ commandId: CommandId });
export const SandboxLaunchOptionsInput = Schema.Struct({
  configurationId: Schema.String.check(Schema.isUUID(4)),
});
export const SandboxLaunchOptions = Schema.Struct({
  configurationRevision: Schema.Int,
  runtime: Schema.NullOr(SandboxRuntimeCatalog),
  reason: Schema.NullOr(Schema.String),
});
export type SandboxLaunchOptions = typeof SandboxLaunchOptions.Type;

export class SandboxSubmissionError extends Schema.TaggedError<SandboxSubmissionError>()(
  "SandboxSubmissionError",
  {
    code: Schema.Literals([
      "invalid",
      "conflict",
      "unsupported",
      "storage",
      "unavailable",
      "too-late",
    ]),
    message: Schema.String,
  },
) {}
