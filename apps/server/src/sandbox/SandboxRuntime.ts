import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ProviderDriverKind,
  SANDBOX_INTAKE_VERSION,
  SandboxSubmissionError,
  resolveProviderInstanceEnabled,
  type ModelSelection,
  type ProviderInteractionMode,
  type ProviderInstanceConfigMap,
  type SandboxRuntimeManifest,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeModelsForVersion,
} from "../provider/ClaudeModelCatalog.ts";

export const SANDBOX_CLAUDE_VERSION = "2.1.280";

/** Called by the built artifact and destination, never from the host's live provider inventory. */
export function makeSandboxRuntimeManifest(artifactIntegrity: string): SandboxRuntimeManifest {
  const manifest = {
    artifactIntegrity,
    orchestrationProtocol: ORCHESTRATION_PROTOCOL_VERSION,
    intakeVersion: SANDBOX_INTAKE_VERSION,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        version: SANDBOX_CLAUDE_VERSION,
        showInteractionModeToggle: true,
        models: resolveClaudeModelsForVersion(BUNDLED_CLAUDE_MODEL_CATALOG, SANDBOX_CLAUDE_VERSION),
      },
    ],
  };
  return {
    id: NodeCrypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    ...manifest,
  };
}

/** Validate the exact selection against the destination artifact, not the host's providers. */
export const validateSandboxSelection = Effect.fnUntraced(function* (
  runtime: SandboxRuntimeManifest,
  instances: ProviderInstanceConfigMap,
  selection: ModelSelection,
  interactionMode: ProviderInteractionMode,
) {
  const unsupported = () =>
    new SandboxSubmissionError({
      code: "unsupported",
      message: "Selected runtime, provider, model, or options are unavailable.",
    });
  if (
    runtime.intakeVersion !== SANDBOX_INTAKE_VERSION ||
    runtime.orchestrationProtocol !== ORCHESTRATION_PROTOCOL_VERSION
  )
    return yield* unsupported();
  const instance = instances[selection.instanceId];
  if (!instance || !resolveProviderInstanceEnabled(instance)) return yield* unsupported();
  const provider = runtime.providers.find((entry) => entry.driver === instance.driver);
  if (interactionMode === "plan" && provider?.showInteractionModeToggle !== true)
    return yield* unsupported();
  const model = provider?.models.find((entry) => entry.slug === selection.model);
  if (!model) return yield* unsupported();
  const seen = new Set<string>();
  for (const option of selection.options ?? []) {
    const descriptor = model.capabilities?.optionDescriptors?.find(
      (entry) => entry.id === option.id,
    );
    if (
      seen.has(option.id) ||
      !descriptor ||
      (descriptor.type === "boolean"
        ? typeof option.value !== "boolean"
        : !descriptor.options.some((choice) => choice.id === option.value))
    )
      return yield* unsupported();
    seen.add(option.id);
  }
});
