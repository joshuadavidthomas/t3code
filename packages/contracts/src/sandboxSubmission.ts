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
export const SandboxRuntimeManifest = Schema.Struct({
  id: TrimmedNonEmptyString,
  artifactIntegrity: TrimmedNonEmptyString,
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
export type SandboxRuntimeManifest = typeof SandboxRuntimeManifest.Type;

export const SandboxSubmitInput = Schema.Struct({
  commandId: CommandId,
  configurationId: Schema.String.check(Schema.isUUID(4)),
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runtimeId: TrimmedNonEmptyString,
  projectId: ProjectId,
  branch: TrimmedNonEmptyString,
  threadId: ThreadId,
  messageId: MessageId,
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type SandboxSubmitInput = typeof SandboxSubmitInput.Type;

/** Resolved by the host, never supplied as a trusted commit by a browser. */
export const SandboxPinnedSource = Schema.Struct({
  repositoryUrl: Schema.String.check(
    Schema.isPattern(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  ),
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  branch: TrimmedNonEmptyString,
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
  }),
  progress: WorktreeSetupSnapshot,
  destination: Schema.NullOr(SandboxDestination),
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
  runtime: Schema.NullOr(SandboxRuntimeManifest),
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
