import {
  CommandId,
  type EnvironmentId,
  type OrchestrationCommand,
  type ProjectId,
  type ProjectScript,
  type ThreadId,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  type SandboxDestination,
  SandboxDestination as SandboxDestinationSchema,
  SandboxSubmissionError,
  type SandboxRuntimeManifest,
  type SandboxSubmissionRecord,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import { validateSandboxSelection } from "./SandboxRuntime.ts";

const failure = (code: SandboxSubmissionError["code"], message: string) =>
  new SandboxSubmissionError({ code, message });
const storageFailure = () => failure("storage", "Unable to persist or read sandbox intake.");
const providerConfigs = BUILT_IN_DRIVERS.map((driver) => ({
  driver,
  decode: Schema.decodeUnknownEffect(driver.configSchema),
}));

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const containsRedaction = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsRedaction);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.valueRedacted === true) return true;
    return Object.values(record).some(containsRedaction);
  }
  return false;
};

const commandId = (root: CommandId, operation: string) =>
  CommandId.make(
    `sandbox-intake:${NodeCrypto.createHash("sha256").update(root).digest("hex")}:${operation}`,
  );

export interface SandboxIntakeDependencies {
  readonly runtime: SandboxRuntimeManifest;
  readonly environmentId: EnvironmentId;
  readonly applyProviderInstances: (
    instances: ProviderInstanceConfigMap,
    selectedInstanceId: ProviderInstanceId,
  ) => Effect.Effect<void, SandboxSubmissionError>;
  readonly dispatch: OrchestrationEngineShape["dispatch"];
  /** Runs the project's setup script before the first turn, as a new worktree does. */
  readonly prepareWorkspace: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly scripts: ReadonlyArray<ProjectScript>;
  }) => Effect.Effect<void>;
}

export interface SandboxIntakeInput {
  readonly submission: SandboxSubmissionRecord;
  readonly providerInstances: ProviderInstanceConfigMap;
  readonly workspaceRoot: string;
  readonly projectId: ProjectId;
}

/** Durable, replay-safe handoff from a sandbox host into one destination runtime. */
export const makeSandboxIntake = Effect.fnUntraced(function* (deps: SandboxIntakeDependencies) {
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  const decodeDestination = Schema.decodeUnknownEffect(
    Schema.fromJsonString(SandboxDestinationSchema),
  );
  const encodeDestination = Schema.encodeEffect(Schema.fromJsonString(SandboxDestinationSchema));

  const acceptUnlocked = Effect.fnUntraced(function* (
    input: SandboxIntakeInput,
  ): Effect.fn.Return<SandboxDestination, SandboxSubmissionError> {
    const { submission, providerInstances } = input;
    if (
      submission.input.runtimeId !== deps.runtime.id ||
      canonicalJson(submission.runtime) !== canonicalJson(deps.runtime)
    )
      return yield* failure("unsupported", "Sandbox runtime is incompatible with this submission.");

    yield* validateSandboxSelection(
      deps.runtime,
      providerInstances,
      submission.input.modelSelection,
      submission.input.interactionMode,
    );
    if (containsRedaction(providerInstances))
      return yield* failure("invalid", "Provider settings contain redacted credentials.");

    const selected = providerInstances[submission.input.modelSelection.instanceId]!;
    const providerConfig = providerConfigs.find(
      (entry) => entry.driver.driverKind === selected.driver,
    );
    if (!providerConfig) return yield* failure("unsupported", "Selected provider is unavailable.");
    yield* providerConfig
      .decode(selected.config ?? providerConfig.driver.defaultConfig())
      .pipe(Effect.mapError(() => failure("invalid", "Invalid provider settings.")));

    const identity = {
      input: submission.input,
      source: submission.source,
      runtime: submission.runtime,
      acceptedAt: submission.acceptedAt,
      providerInstances,
      workspaceRoot: input.workspaceRoot,
      projectId: input.projectId,
    };
    const fingerprint = NodeCrypto.createHash("sha256")
      .update(canonicalJson(identity))
      .digest("hex");
    const id = submission.input.commandId;
    const destination: SandboxDestination = {
      environmentId: deps.environmentId,
      projectId: input.projectId,
      threadId: submission.input.threadId,
    };

    const rows = yield* sql<{ fingerprint: string; destination_json: string | null }>`
      SELECT fingerprint, destination_json FROM sandbox_intakes WHERE id = ${id}
    `.pipe(Effect.mapError(storageFailure));
    const prior = rows[0];
    if (prior && prior.fingerprint !== fingerprint)
      return yield* failure(
        "conflict",
        "Sandbox intake command was already used for different input.",
      );
    if (prior?.destination_json) {
      return yield* decodeDestination(prior.destination_json).pipe(Effect.mapError(storageFailure));
    }

    const owners = yield* sql<{ id: string }>`
      SELECT id FROM sandbox_intakes WHERE id <> ${id} LIMIT 1
    `.pipe(Effect.mapError(storageFailure));
    if (owners.length > 0)
      return yield* failure(
        "conflict",
        "This sandbox destination already belongs to another submission.",
      );
    if (!prior) {
      yield* sql`INSERT INTO sandbox_intakes (id, fingerprint, destination_json)
        VALUES (${id}, ${fingerprint}, NULL)`.pipe(Effect.mapError(storageFailure));
    }

    yield* deps.applyProviderInstances(
      providerInstances,
      submission.input.modelSelection.instanceId,
    );
    const commands: ReadonlyArray<OrchestrationCommand> = [
      {
        type: "project.create",
        commandId: commandId(id, "project-create"),
        projectId: input.projectId,
        title:
          submission.source.projectTitle ??
          submission.source.repositoryUrl
            ?.split(/[/:]/)
            .at(-1)
            ?.replace(/\.git$/, "") ??
          "project",
        workspaceRoot: input.workspaceRoot,
        createdAt: submission.acceptedAt,
      },
      {
        type: "thread.create",
        commandId: commandId(id, "thread-create"),
        threadId: submission.input.threadId,
        projectId: input.projectId,
        title: submission.input.title,
        modelSelection: submission.input.modelSelection,
        runtimeMode: submission.input.runtimeMode,
        interactionMode: submission.input.interactionMode,
        branch: submission.input.branch,
        worktreePath: null,
        createdAt: submission.acceptedAt,
      },
      {
        type: "thread.message.user.append",
        commandId: commandId(id, "message-append"),
        threadId: submission.input.threadId,
        message: {
          messageId: submission.input.messageId,
          text: submission.input.prompt,
          attachments: [],
        },
        createdAt: submission.acceptedAt,
      },
      {
        type: "thread.turn.start",
        commandId: commandId(id, "turn-start"),
        threadId: submission.input.threadId,
        message: {
          messageId: submission.input.messageId,
          role: "user",
          text: submission.input.prompt,
          attachments: [],
        },
        modelSelection: submission.input.modelSelection,
        runtimeMode: submission.input.runtimeMode,
        interactionMode: submission.input.interactionMode,
        createdAt: submission.acceptedAt,
      },
    ];
    for (const command of commands) {
      if (command.type === "thread.turn.start")
        yield* deps.prepareWorkspace({
          threadId: submission.input.threadId,
          projectId: input.projectId,
          scripts: submission.source.projectScripts ?? [],
        });
      yield* deps
        .dispatch(command)
        .pipe(
          Effect.mapError(() => failure("unavailable", "Sandbox orchestration is unavailable.")),
        );
    }
    const encoded = yield* encodeDestination(destination).pipe(Effect.mapError(storageFailure));
    yield* sql`UPDATE sandbox_intakes SET destination_json = ${encoded} WHERE id = ${id}`.pipe(
      Effect.mapError(storageFailure),
    );
    return destination;
  });

  return { accept: (input: SandboxIntakeInput) => lock.withPermits(1)(acceptUnlocked(input)) };
});
