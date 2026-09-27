import type { SearchMiddleware } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";
import { selectEnvironmentAxis } from "./settingsScopeAxis";

/** Provider-only targets never become members of the global environment catalog. */
export function validateProviderSettingsSearch(raw: Record<string, unknown>) {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
    ...(typeof raw.sandbox === "string" && raw.sandbox.trim() ? { sandbox: raw.sandbox } : {}),
  };
}

export function selectSandboxProviderTarget(
  ownerEnvironmentId: EnvironmentId,
  configurationId: string,
  search: SettingsScopeSearch = {},
) {
  return {
    ...selectEnvironmentAxis(search, ownerEnvironmentId),
    sandbox: configurationId,
  };
}

export function sandboxProviderMenuValue(ownerEnvironmentId: string, configurationId: string) {
  return `sandbox:${JSON.stringify([ownerEnvironmentId, configurationId])}`;
}

export function parseSandboxProviderMenuValue(value: string) {
  if (!value.startsWith("sandbox:")) return null;
  try {
    const parts: unknown = JSON.parse(value.slice("sandbox:".length));
    if (!Array.isArray(parts) || parts.length !== 2) return null;
    const owner: unknown = parts[0];
    const registration: unknown = parts[1];
    if (
      typeof owner === "string" &&
      owner.length > 0 &&
      typeof registration === "string" &&
      registration.length > 0
    ) {
      return {
        ownerEnvironmentId: EnvironmentId.make(owner),
        configurationId: registration,
      };
    }
  } catch {
    /* Not a registration menu value. */
  }
  return null;
}

/** Accept legacy provider links without replacing an explicit settings scope. */
export function validateSettingsRouteSearch(raw: Record<string, unknown>) {
  return validateSettingsScopeSearch(
    typeof raw.environmentId === "string" && raw.machine === undefined && raw.project === undefined
      ? { ...raw, machine: raw.environmentId }
      : raw,
  );
}

const SCOPE_KEYS = [
  "project",
  "machine",
  "checkout",
] as const satisfies readonly (keyof SettingsScopeSearch)[];
const TARGET_INPUT_KEYS = [...SCOPE_KEYS, "environmentId"];

/**
 * Category links keep the target, while an explicit target replaces the entire
 * previous selection. `environmentId` is the legacy provider deep-link target.
 */
export const retainSettingsScope: SearchMiddleware<SettingsScopeSearch> = ({ search, next }) => {
  const result = next(search);
  if (TARGET_INPUT_KEYS.some((key) => Object.hasOwn(result, key))) return result;
  const previousScope = Object.fromEntries(
    SCOPE_KEYS.filter((key) => search[key] !== undefined).map((key) => [key, search[key]]),
  );
  return { ...previousScope, ...result };
};
