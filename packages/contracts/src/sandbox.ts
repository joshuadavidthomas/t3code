import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "./providerInstance.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Revision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const SandboxProviderModelPreferences = Schema.Struct({
  hiddenModels: Schema.Array(Schema.String),
  favoriteModels: Schema.Array(Schema.String),
  modelOrder: Schema.Array(Schema.String),
});
export type SandboxProviderModelPreferences = typeof SandboxProviderModelPreferences.Type;
export const SandboxProviderModelPreferencesMap = Schema.Record(
  ProviderInstanceId,
  SandboxProviderModelPreferences,
);
/** Sprites tokens can be limited to names with a prefix; sandbox names start with it. */
export const SandboxNamePrefix = Schema.String.check(Schema.isPattern(/^[a-z0-9-]{0,20}$/));
export const SandboxConfiguration = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  provider: Schema.Literal("sprites"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  revision: Revision,
  credentialConfigured: Schema.Boolean,
  namePrefix: SandboxNamePrefix.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  verifiedAt: Schema.NullOr(Text),
  providerInstances: ProviderInstanceConfigMap.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  providerModelPreferences: SandboxProviderModelPreferencesMap.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type SandboxConfiguration = typeof SandboxConfiguration.Type;

/** Display names for sandbox providers, shared by every client surface. */
export const SANDBOX_PROVIDER_LABELS: Record<SandboxConfiguration["provider"], string> = {
  sprites: "Sprites",
};

/**
 * Sandboxes have no interactive login, so an agent needs one of these variables
 * on its provider instance before a launch. Drivers without an entry have no
 * known requirement.
 */
export const SANDBOX_DRIVER_CREDENTIALS: Readonly<
  Record<string, { readonly variables: readonly string[] }>
> = {
  // The first variable is the one Settings writes; the rest are also accepted.
  claudeAgent: { variables: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] },
};

/** Stored values arrive redacted on clients, so a redaction marker counts as set. */
export function sandboxInstanceHasCredential(instance: ProviderInstanceConfig): boolean {
  const credential = SANDBOX_DRIVER_CREDENTIALS[instance.driver];
  if (!credential) return true;
  return (instance.environment ?? []).some(
    (variable) =>
      credential.variables.includes(variable.name) &&
      (variable.valueRedacted === true || variable.value.trim() !== ""),
  );
}

/** Stores a pasted token as the driver's primary credential variable, marked sensitive. */
export function withSandboxCredential(
  instance: ProviderInstanceConfig,
  value: string,
): ProviderInstanceConfig {
  const name = SANDBOX_DRIVER_CREDENTIALS[instance.driver]?.variables[0];
  const trimmed = value.trim();
  if (!name || !trimmed) return instance;
  const entry = { name, value: trimmed, sensitive: true };
  const environment = instance.environment ?? [];
  return {
    ...instance,
    environment: environment.some((variable) => variable.name === name)
      ? environment.map((variable) => (variable.name === name ? entry : variable))
      : [...environment, entry],
  };
}

export const SandboxConfigurationSaveInput = Schema.Struct({
  id: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  provider: Schema.Literal("sprites"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  expectedRevision: Revision,
  // Omitted preserves the saved prefix.
  namePrefix: Schema.optionalKey(SandboxNamePrefix),
  // Omitted preserves the credential; a string replaces it.
  credential: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  ),
});
export type SandboxConfigurationSaveInput = typeof SandboxConfigurationSaveInput.Type;
export const SandboxProviderInstanceSaveInput = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  expectedRevision: Revision,
  instanceId: ProviderInstanceId,
  instance: Schema.NullOr(ProviderInstanceConfig),
  modelPreferences: Schema.optionalKey(SandboxProviderModelPreferences),
});
export type SandboxProviderInstanceSaveInput = typeof SandboxProviderInstanceSaveInput.Type;
export const SandboxConfigurationRemoveInput = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  expectedRevision: Revision,
});
export type SandboxConfigurationRemoveInput = typeof SandboxConfigurationRemoveInput.Type;
export const SandboxConfigurationVerifyInput = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  expectedRevision: Revision,
});
export type SandboxConfigurationVerifyInput = typeof SandboxConfigurationVerifyInput.Type;
export class SandboxConfigurationError extends Schema.TaggedError<SandboxConfigurationError>()(
  "SandboxConfigurationError",
  {
    code: Schema.Literals([
      "disabled",
      "conflict",
      "invalid",
      "unavailable",
      "unauthorized",
      "protocol",
      "storage",
    ]),
    message: Schema.String,
  },
) {}
