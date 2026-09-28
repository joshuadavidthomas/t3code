import { useAtomValue } from "@effect/atom-react";
import {
  defaultInstanceIdForDriver,
  resolveProviderInstanceEnabled,
  ProviderInstanceId,
  type ProviderDriverKind,
  SANDBOX_PROVIDER_LABELS,
  type SandboxConfiguration,
  type SandboxRuntimeCatalog,
  sandboxInstanceHasCredential,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { useCallback, useEffect, useMemo } from "react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type { SandboxTarget } from "../../composerDraftStore";
import { sortModelsForProviderInstance } from "../../modelOrdering";
import type { DeclaredProviderInstanceEntry } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePrimarySessionState } from "../../environments/primary";
import { useEnvironmentSessionState } from "../../state/session";
import { isElectron } from "../../env";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "../settings/ProviderSettingsPanel.logic";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { toastManager } from "../ui/toast";
import { sandboxAccountLabel } from "../settings/settingsScopeNavigation";

export const SANDBOX_MODELS_LOADING = "Sandbox models loading";

/** Drivers the sandbox runtime can run; Settings and the composer offer only these. */
export function sandboxRuntimeSupportsDriver(
  runtime: SandboxRuntimeCatalog,
  driver: ProviderDriverKind,
): boolean {
  return runtime.providers.some((entry) => entry.driver === driver);
}

export function sandboxComposerCatalog(
  configuration: SandboxConfiguration,
  runtime: SandboxRuntimeCatalog,
): ReadonlyArray<DeclaredProviderInstanceEntry> {
  return Object.entries(configuration.providerInstances).flatMap(([id, instance]) => {
    if (!resolveProviderInstanceEnabled(instance)) return [];
    const provider = runtime.providers.find((entry) => entry.driver === instance.driver);
    if (!provider) return [];
    const instanceId = ProviderInstanceId.make(id);
    const preferences = configuration.providerModelPreferences[instanceId];
    return [
      {
        source: "runtime" as const,
        instanceId,
        driverKind: instance.driver,
        displayName: resolveProviderInstanceDisplayName({
          instanceId,
          driver: instance.driver,
          ...(instance.displayName ? { displayName: instance.displayName } : {}),
        }),
        accentColor: instance.accentColor,
        isDefault: instanceId === defaultInstanceIdForDriver(instance.driver),
        showInteractionModeToggle: provider.showInteractionModeToggle,
        models: sortModelsForProviderInstance(
          provider.models.filter((model) => !preferences?.hiddenModels.includes(model.slug)),
          {
            modelOrder: preferences?.modelOrder ?? [],
            favoriteModels: preferences?.favoriteModels ?? [],
            groupFavorites: true,
          },
        ),
      },
    ];
  });
}

/** The sandbox entry a draft sends with; ChatView and the composer must agree on it. */
export function resolveSandboxProviderEntry(
  catalog: ReadonlyArray<DeclaredProviderInstanceEntry>,
  selectedInstanceId: ProviderInstanceId | null,
  lockedProvider: ProviderDriverKind | null,
): DeclaredProviderInstanceEntry | undefined {
  const selectable = catalog.filter(
    (entry) =>
      entry.models.length > 0 && (lockedProvider === null || entry.driverKind === lockedProvider),
  );
  return (
    selectable.find((entry) => entry.instanceId === selectedInstanceId) ??
    selectable.find((entry) => entry.isDefault) ??
    selectable[0]
  );
}

/** Account queries share the same cached source used by Settings, and start before menus open. */
export function useSandboxComposer(target: SandboxTarget | null, enabled: boolean) {
  const { environments } = useEnvironments();
  const accounts = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          enabled
            ? environments.flatMap((environment) => {
                if (
                  environment.serverConfig?.environment.capabilities.sandboxConfiguration !== true
                )
                  return [];
                const result = get(
                  serverEnvironment.sandboxConfiguration({
                    environmentId: environment.environmentId,
                    input: {},
                  }),
                );
                return Option.getOrElse(AsyncResult.value(result), () => []).map(
                  (configuration) => ({
                    ownerEnvironmentId: environment.environmentId,
                    ownerLabel: environment.label,
                    configuration,
                    configurationId: configuration.id,
                    providerLabel: SANDBOX_PROVIDER_LABELS[configuration.provider],
                  }),
                );
              })
            : [],
        ),
      [enabled, environments],
    ),
  );
  const registrations = useMemo(() => {
    const entries = accounts.map((account) => ({
      environment: { environmentId: account.ownerEnvironmentId, label: account.ownerLabel },
      configuration: account.configuration,
    }));
    return accounts.map((account, index) => ({
      ...account,
      label: sandboxAccountLabel(entries[index]!, entries),
    }));
  }, [accounts]);
  const owner = environments.find(
    (environment) => environment.environmentId === target?.ownerEnvironmentId,
  );
  const primarySession = usePrimarySessionState();
  const remoteSession = useEnvironmentSessionState(target?.ownerEnvironmentId ?? null);
  const saveProviderInstance = useAtomCommand(serverEnvironment.saveSandboxProviderInstance, {
    reportFailure: false,
  });
  const registration = registrations.find(
    (entry) =>
      entry.ownerEnvironmentId === target?.ownerEnvironmentId &&
      entry.configurationId === target.configurationId,
  );
  const query = useEnvironmentQuery(
    target && registration
      ? serverEnvironment.sandboxLaunchOptions({
          environmentId: target.ownerEnvironmentId,
          input: { configurationId: target.configurationId },
        })
      : null,
  );
  const configurationRevision = registration?.configuration.revision;
  const ownerEnvironmentId = target?.ownerEnvironmentId;
  const configurationId = target?.configurationId;
  const { refresh: refreshLaunchOptions } = query;
  useEffect(() => {
    if (ownerEnvironmentId && configurationId && configurationRevision !== undefined)
      refreshLaunchOptions();
  }, [ownerEnvironmentId, configurationId, configurationRevision, refreshLaunchOptions]);
  const current =
    registration && query.data?.configurationRevision === configurationRevision ? query.data : null;
  const catalog = useMemo(
    () =>
      registration && current?.runtime
        ? sandboxComposerCatalog(registration.configuration, current.runtime)
        : [],
    [registration, current],
  );
  const reason = !target
    ? null
    : !owner || owner.connection.phase !== "connected"
      ? "Environment disconnected"
      : !registration
        ? "Sandbox account unavailable"
        : !registration.configuration.credentialConfigured
          ? "Sandbox token required"
          : (query.error ??
            (!current
              ? SANDBOX_MODELS_LOADING
              : !current.runtime
                ? "Sandboxes unavailable"
                : !catalog.some((entry) => entry.models.length > 0)
                  ? "No provider configured"
                  : null));
  // Where the user can fix the reason; the others need a reconnect or a server change.
  const reasonFix: "account" | "providers" | null =
    reason === "Sandbox token required"
      ? "account"
      : reason === "No provider configured"
        ? "providers"
        : null;
  const favoriteModels = useMemo(
    () =>
      new Map(
        Object.entries(registration?.configuration.providerModelPreferences ?? {}).map(
          ([instanceId, preferences]) => [
            ProviderInstanceId.make(instanceId),
            preferences.favoriteModels,
          ],
        ),
      ),
    [registration],
  );
  const updateFavoriteModels = useCallback(
    async (instanceId: ProviderInstanceId, favoriteModels: readonly string[]) => {
      if (!target || !owner || !registration) return;
      const isPrimary = owner.entry.target._tag === "PrimaryConnectionTarget";
      const access =
        isPrimary && isElectron
          ? "granted"
          : isPrimary
            ? resolvePrimaryOperateAccess({
                isPrimary: true,
                hasDesktopBridge: false,
                session: primarySession.data,
                isPending: primarySession.isPending,
                hasError: primarySession.error !== null,
              })
            : resolveRemoteOperateAccess({
                session: remoteSession.data,
                isPending: remoteSession.isPending,
                hasError: remoteSession.hasError,
              });
      if (access !== "granted") {
        toastManager.add({
          type: "error",
          title: "Could not save favorite models",
          description: `This session can't change ${registration.configuration.name}'s settings.`,
        });
        return;
      }
      const latest = registration.configuration;
      const modelPreferences = latest.providerModelPreferences[instanceId] ?? {
        hiddenModels: [],
        favoriteModels: [],
        modelOrder: [],
      };
      const result = await saveProviderInstance({
        environmentId: target.ownerEnvironmentId,
        input: {
          id: target.configurationId,
          expectedRevision: latest.revision,
          instanceId,
          instance: latest.providerInstances[instanceId]!,
          modelPreferences: { ...modelPreferences, favoriteModels },
        },
      });
      if (result._tag === "Success") {
        return;
      }
      query.refresh();
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not save favorite models",
        description: failure instanceof Error ? failure.message : undefined,
      });
    },
    [owner, primarySession, query, registration, remoteSession, saveProviderInstance, target],
  );
  const credentialMissing = useCallback(
    (instanceId: ProviderInstanceId) => {
      const instance = registration?.configuration.providerInstances[instanceId];
      return instance !== undefined && !sandboxInstanceHasCredential(instance);
    },
    [registration],
  );
  return {
    registrations,
    catalog,
    reason,
    reasonFix,
    credentialMissing,
    loading: reason === SANDBOX_MODELS_LOADING,
    runtimeId: current?.runtime?.id ?? null,
    configurationRevision: current?.configurationRevision ?? null,
    favoriteModels,
    updateFavoriteModels,
  };
}
