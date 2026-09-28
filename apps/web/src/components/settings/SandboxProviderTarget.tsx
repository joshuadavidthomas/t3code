import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  SANDBOX_PROVIDER_LABELS,
  sandboxInstanceHasCredential,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type SandboxConfiguration,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CloudIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { MenuRadioItem, MenuRadioItemIndicator } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { SandboxCredentialAction } from "./SandboxCredentialAction";
import { ProviderSettingsEditorLayout, ProviderSettingsPlaceholder } from "./ProviderSettingsPanel";
import { DRIVER_OPTIONS } from "./providerDriverMeta";
import { sandboxRuntimeSupportsDriver } from "../chat/useSandboxComposer";
import { useSandboxConfiguration } from "./SandboxSettings";
import { SettingsScopeSentence } from "./SettingsScopeSentence";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import {
  parseSandboxProviderMenuValue,
  sandboxAccountLabel,
  sandboxProviderMenuValue,
  selectSandboxProviderTarget,
} from "./settingsScopeNavigation";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

export interface SandboxProviderTarget {
  readonly ownerEnvironmentId: EnvironmentId | null;
  readonly configurationId: string;
}

function mergeChangedFields<T extends object>(base: T, next: T, current: T): T {
  const merged = { ...current } as Record<string, unknown>;
  const baseRecord = base as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  for (const key of new Set([...Object.keys(baseRecord), ...Object.keys(nextRecord)])) {
    if (Object.is(baseRecord[key], nextRecord[key])) continue;
    if (!(key in nextRecord)) {
      delete merged[key];
      continue;
    }
    const baseValue = baseRecord[key];
    const nextValue = nextRecord[key];
    const currentValue = merged[key];
    merged[key] =
      baseValue !== null &&
      nextValue !== null &&
      currentValue !== null &&
      typeof baseValue === "object" &&
      typeof nextValue === "object" &&
      typeof currentValue === "object" &&
      !Array.isArray(baseValue) &&
      !Array.isArray(nextValue) &&
      !Array.isArray(currentValue)
        ? mergeChangedFields(baseValue, nextValue, currentValue)
        : nextValue;
  }
  return merged as T;
}

/** Only Providers extends the heading with registration targets. */
export function ProviderSettingsScopeSentence({
  target,
}: {
  target: SandboxProviderTarget | null;
}) {
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const scope = useOptionalSettingsScope();
  const { registrations, loadingEnvironmentIds } = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) => {
          const loadingEnvironmentIds = new Set<EnvironmentId>();
          const registrations = environments.flatMap((environment) => {
            if (environment.serverConfig?.environment.capabilities.sandboxConfiguration !== true)
              return [];
            const result = get(
              serverEnvironment.sandboxConfiguration({
                environmentId: environment.environmentId,
                input: {},
              }),
            );
            if (AsyncResult.isInitial(result)) loadingEnvironmentIds.add(environment.environmentId);
            const configurations = Option.getOrElse(AsyncResult.value(result), () => []);
            return configurations.map((configuration) => ({ environment, configuration }));
          });
          return { registrations, loadingEnvironmentIds };
        }),
      [environments],
    ),
  );
  const selectedRegistration = registrations.find(
    ({ environment, configuration }) =>
      environment.environmentId === target?.ownerEnvironmentId &&
      configuration.id === target.configurationId,
  );
  // Keep the trigger blank while the owner's accounts load instead of flashing "Unavailable".
  const selectedLabel = selectedRegistration
    ? sandboxAccountLabel(selectedRegistration, registrations)
    : target?.ownerEnvironmentId && loadingEnvironmentIds.has(target.ownerEnvironmentId)
      ? ""
      : "Unavailable environment";
  return (
    <SettingsScopeSentence
      environmentMenu={{
        ...(target
          ? {
              selected: {
                value: sandboxProviderMenuValue(
                  target.ownerEnvironmentId ?? "",
                  target.configurationId,
                ),
                label: selectedLabel,
                ...(selectedRegistration
                  ? {
                      ariaLabel: `${selectedLabel} (${SANDBOX_PROVIDER_LABELS[selectedRegistration.configuration.provider]})`,
                    }
                  : {}),
                icon: <CloudIcon aria-hidden className="size-3.5 shrink-0" />,
              },
            }
          : {}),
        options: registrations.map((registration) => {
          const { environment, configuration } = registration;
          return (
            <MenuRadioItem
              key={`${environment.environmentId}:${configuration.id}`}
              value={sandboxProviderMenuValue(environment.environmentId, configuration.id)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <CloudIcon aria-hidden className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">
                  {sandboxAccountLabel(registration, registrations)}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {environment.connection.phase !== "connected"
                    ? "Offline"
                    : SANDBOX_PROVIDER_LABELS[configuration.provider]}
                </span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          );
        }),
        onSelect: (value) => {
          const selected = parseSandboxProviderMenuValue(value);
          if (!selected) return false;
          void navigate({
            to: "/settings/providers",
            search: selectSandboxProviderTarget(
              selected.ownerEnvironmentId,
              selected.configurationId,
              scope?.search,
            ),
            hash: "",
            resetScroll: false,
          });
          return true;
        },
        ...(target
          ? {
              onProjectChange: (next) => {
                void navigate({
                  to: "/settings/providers",
                  search: { ...next, sandbox: target.configurationId },
                  hash: "",
                  resetScroll: false,
                });
              },
            }
          : {}),
      }}
    />
  );
}

/** The registration adapter has no live-environment settings or mutation hooks. */
export function SandboxProviderTargetContent({ target }: { target: SandboxProviderTarget }) {
  const { environments } = useEnvironments();
  const owner = environments.find(
    (environment) => environment.environmentId === target.ownerEnvironmentId,
  );
  const supported = owner?.serverConfig?.environment.capabilities.sandboxConfiguration === true;
  const result = useSandboxConfiguration(target.ownerEnvironmentId, supported);
  let unavailable: string | null = null;
  if (!owner) unavailable = "This environment is no longer available.";
  else if (owner.connection.phase !== "connected")
    unavailable = `Reconnect ${owner.label} to set up its providers.`;
  else if (!supported) unavailable = "Sandboxes are unavailable on this environment.";
  else if (result.error) unavailable = result.error;
  else if (
    !result.loading &&
    !result.configurations.some((configuration) => configuration.id === target.configurationId)
  )
    unavailable = "This sandbox account is no longer available.";
  if (unavailable || result.loading) {
    return (
      <ProviderSettingsPlaceholder
        icon={<CloudIcon />}
        title={unavailable ? "Provider settings are unavailable" : "Loading provider settings"}
        description={
          unavailable ?? `Waiting for ${owner?.label ?? "this environment"}'s configuration.`
        }
      />
    );
  }
  const configuration = result.configurations.find((item) => item.id === target.configurationId)!;
  return (
    <SandboxProviders
      key={`${target.ownerEnvironmentId}:${target.configurationId}`}
      environment={owner!}
      configuration={configuration}
      reload={result.reload}
    />
  );
}

export function SandboxProviders({
  environment,
  configuration,
  reload,
}: {
  environment: EnvironmentPresentation;
  configuration: SandboxConfiguration;
  reload: () => void;
}) {
  const primarySession = usePrimarySessionState();
  const remoteSession = useEnvironmentSessionState(environment.environmentId);
  const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
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
  const readOnly = access !== "granted";
  const save = useAtomCommand(serverEnvironment.saveSandboxProviderInstance, {
    reportFailure: false,
  });
  const revision = useRef(configuration.revision);
  const [draftInstances, setDraftInstances] = useState(configuration.providerInstances);
  const [draftPreferences, setDraftPreferences] = useState(configuration.providerModelPreferences);
  const instancesRef = useRef(configuration.providerInstances);
  const preferencesRef = useRef(configuration.providerModelPreferences);
  const pending = useRef<
    Array<{
      instanceId: ProviderInstanceId;
      instance: ProviderInstanceConfig;
      modelPreferences: (typeof configuration.providerModelPreferences)[ProviderInstanceId];
    }>
  >([]);
  const draining = useRef(false);
  const launchOptions = useEnvironmentQuery(
    serverEnvironment.sandboxLaunchOptions({
      environmentId: environment.environmentId,
      input: { configurationId: configuration.id },
    }),
  );
  const runtime = launchOptions.data?.runtime ?? null;
  // Until the runtime is known, nothing is ruled out.
  const driverOptions = runtime
    ? DRIVER_OPTIONS.filter((option) => sandboxRuntimeSupportsDriver(runtime, option.value))
    : DRIVER_OPTIONS;
  const [selected, setSelected] = useState<ProviderInstanceId>(
    defaultInstanceIdForDriver(DRIVER_OPTIONS[0]!.value),
  );

  const syncFromConfiguration = () => {
    revision.current = configuration.revision;
    instancesRef.current = configuration.providerInstances;
    preferencesRef.current = configuration.providerModelPreferences;
    setDraftInstances(configuration.providerInstances);
    setDraftPreferences(configuration.providerModelPreferences);
  };
  useEffect(() => {
    if (draining.current || pending.current.length > 0) return;
    revision.current = configuration.revision;
    instancesRef.current = configuration.providerInstances;
    preferencesRef.current = configuration.providerModelPreferences;
    setDraftInstances(configuration.providerInstances);
    setDraftPreferences(configuration.providerModelPreferences);
  }, [configuration]);

  const drain = async () => {
    if (draining.current || pending.current.length === 0) return;
    draining.current = true;
    while (pending.current.length > 0) {
      const next = pending.current[0]!;
      const response = await save({
        environmentId: environment.environmentId,
        input: {
          id: configuration.id,
          expectedRevision: revision.current,
          instanceId: next.instanceId,
          instance: next.instance,
          modelPreferences: next.modelPreferences,
        },
      });
      if (response._tag !== "Success") {
        const failure = squashAtomCommandFailure(response);
        pending.current = [];
        draining.current = false;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save provider settings",
            description:
              failure instanceof Error && failure.message.trim()
                ? failure.message
                : "The sandbox account could not be updated.",
          }),
        );
        // Drop unsaved edits and pick up whatever the server has now.
        syncFromConfiguration();
        reload();
        return;
      }
      revision.current = response.value.revision;
      pending.current.shift();
      if (pending.current.length === 0) {
        instancesRef.current = response.value.providerInstances;
        preferencesRef.current = response.value.providerModelPreferences;
        setDraftInstances(response.value.providerInstances);
        setDraftPreferences(response.value.providerModelPreferences);
      }
    }
    draining.current = false;
  };

  const persist = (
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
    modelPreferences = preferencesRef.current[instanceId] ?? {
      hiddenModels: [],
      favoriteModels: [],
      modelOrder: [],
    },
  ) => {
    if (readOnly) return;
    pending.current.push({ instanceId, instance, modelPreferences });
    void drain();
  };

  const updateInstance = (
    instanceId: ProviderInstanceId,
    rendered: ProviderInstanceConfig,
    instance: ProviderInstanceConfig,
  ) => {
    const reconciled = mergeChangedFields(
      rendered,
      instance,
      instancesRef.current[instanceId] ?? rendered,
    );
    instancesRef.current = { ...instancesRef.current, [instanceId]: reconciled };
    setDraftInstances(instancesRef.current);
    persist(instanceId, reconciled);
  };
  const updatePreferences = (
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
    patch: Partial<{
      hiddenModels: readonly string[];
      favoriteModels: readonly string[];
      modelOrder: readonly string[];
    }>,
  ) => {
    const current = preferencesRef.current[instanceId] ?? {
      hiddenModels: [],
      favoriteModels: [],
      modelOrder: [],
    };
    const next = { ...current, ...patch } as typeof current;
    preferencesRef.current = { ...preferencesRef.current, [instanceId]: next };
    setDraftPreferences(preferencesRef.current);
    persist(instanceId, instancesRef.current[instanceId] ?? instance, next);
  };

  const driver =
    driverOptions.find((option) => defaultInstanceIdForDriver(option.value) === selected) ??
    driverOptions[0];
  const selectedInstanceId = driver ? defaultInstanceIdForDriver(driver.value) : selected;
  const render = (driver: (typeof DRIVER_OPTIONS)[number], mode: "list" | "editor") => {
    const instanceId = defaultInstanceIdForDriver(driver.value);
    const instance = draftInstances[instanceId] ?? { driver: driver.value, enabled: false };
    const preferences = draftPreferences[instanceId] ?? {
      hiddenModels: [],
      favoriteModels: [],
      modelOrder: [],
    };
    return (
      <ProviderInstanceCard
        key={instanceId}
        instanceId={instanceId}
        instance={instance}
        driverOption={driver}
        liveProvider={undefined}
        mode={mode}
        selected={selectedInstanceId === instanceId}
        onSelect={() => setSelected(instanceId)}
        readOnly={readOnly}
        status={
          sandboxInstanceHasCredential(instance)
            ? { key: "ready", headline: "Enabled", detail: null }
            : {
                key: "warning",
                headline: "Not authenticated",
                detail: "Add a credential under Variables",
              }
        }
        variablesAction={
          // Once any credential variable is set, its row is where to replace or remove it.
          readOnly || sandboxInstanceHasCredential(instance) ? null : (
            <SandboxCredentialAction
              instance={instance}
              onUpdate={(next) => updateInstance(instanceId, instance, next)}
            />
          )
        }
        onUpdate={(next) => updateInstance(instanceId, instance, next)}
        hiddenModels={preferences.hiddenModels}
        favoriteModels={preferences.favoriteModels}
        modelOrder={preferences.modelOrder}
        onHiddenModelsChange={(next) =>
          updatePreferences(instanceId, instance, { hiddenModels: next })
        }
        onFavoriteModelsChange={(next) =>
          updatePreferences(instanceId, instance, { favoriteModels: next })
        }
        onModelOrderChange={(next) => updatePreferences(instanceId, instance, { modelOrder: next })}
      />
    );
  };

  return (
    <SettingsSection {...searchableSetting("providers")} variant="plain">
      {/* Same header row as an environment's providers, with no refresh or add controls. */}
      <div className="min-h-11" />
      {readOnly ? (
        <SettingsGroup divided={false} className="overflow-hidden">
          <SettingsRow
            title="Limited permissions"
            description={`This session can view ${configuration.name}'s providers but can't change their settings.`}
          />
        </SettingsGroup>
      ) : null}
      <ProviderSettingsEditorLayout
        list={driverOptions.map((option) => render(option, "list"))}
        editor={driver ? render(driver, "editor") : null}
      />
    </SettingsSection>
  );
}
