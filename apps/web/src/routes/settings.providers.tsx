import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import {
  ProviderSettingsScopeSentence,
  SandboxProviderTargetContent,
} from "../components/settings/SandboxProviderTarget";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { validateProviderSettingsSearch } from "../components/settings/settingsScopeNavigation";

/**
 * Providers are machine state, so the page shows one environment at a time:
 * the chosen one, or the representative of the selection. A project crumb
 * narrows the candidates to the environments that project is registered on.
 */
function SettingsProvidersRoute() {
  const target = Route.useSearch();
  const { environment, scope, search } = useSettingsScope();
  const sandboxTarget = target.sandbox
    ? {
        ownerEnvironmentId: search.machine ? EnvironmentId.make(search.machine) : null,
        configurationId: target.sandbox,
      }
    : null;
  const scopeSentence = <ProviderSettingsScopeSentence target={sandboxTarget} />;
  if (sandboxTarget) {
    return (
      <SettingsPageContainer
        width="wide"
        className="@container/providers gap-8"
        scopeSentence={scopeSentence}
      >
        <SandboxProviderTargetContent
          key={`${sandboxTarget.ownerEnvironmentId}:${sandboxTarget.configurationId}`}
          target={sandboxTarget}
        />
      </SettingsPageContainer>
    );
  }
  if (!environment) {
    return (
      <SettingsPageContainer scopeSentence={scopeSentence}>
        <p className="p-8 text-sm text-muted-foreground">
          {scope.kind === "environment"
            ? `Reconnect ${scope.label} to set up its providers.`
            : "Connect an environment to set up its providers."}
        </p>
      </SettingsPageContainer>
    );
  }
  return (
    <ProviderSettingsPanel
      environmentId={environment.environmentId}
      scopeSentence={scopeSentence}
      {...(target.instanceId ? { instanceId: target.instanceId } : {})}
      scoped
    />
  );
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: validateProviderSettingsSearch,
  component: SettingsProvidersRoute,
});
