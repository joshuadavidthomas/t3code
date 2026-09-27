import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "./providerInstance.ts";
import { ServerProviderModel } from "./server.ts";

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
export const SandboxConfiguration = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  provider: Schema.Literal("sprites"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  revision: Revision,
  credentialConfigured: Schema.Boolean,
  verifiedAt: Schema.NullOr(Text),
  providerInstances: ProviderInstanceConfigMap.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  providerModelPreferences: SandboxProviderModelPreferencesMap.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type SandboxConfiguration = typeof SandboxConfiguration.Type;
export const SandboxConfigurationSaveInput = Schema.Struct({
  id: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  provider: Schema.Literal("sprites"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  expectedRevision: Revision,
  // Omitted preserves the credential; null clears it; a string replaces it.
  credential: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
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
