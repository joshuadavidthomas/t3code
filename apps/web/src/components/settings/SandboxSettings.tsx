import { type EnvironmentId, type SandboxConfiguration } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CloudIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import { requestConfirmDialog } from "~/confirmDialog";
import { serverEnvironment } from "../../state/server";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";

const EMPTY_SANDBOX_CONFIGURATIONS: readonly SandboxConfiguration[] = [];

export const SANDBOX_PROVIDER_LABELS: Record<SandboxConfiguration["provider"], string> = {
  sprites: "Sprites",
};

function formatFailure(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message.trim() ? failure.message : "Request failed.";
}

/** Reads the T3 server's sandbox registrations without creating a runtime connection. */
export function useSandboxConfiguration(environmentId: EnvironmentId | null, enabled: boolean) {
  const connected = useEnvironment(environmentId)?.connection.phase === "connected";
  const query = useEnvironmentQuery(
    enabled && environmentId !== null
      ? serverEnvironment.sandboxConfiguration({ environmentId, input: {} })
      : null,
  );
  return {
    configurations: query.data ?? EMPTY_SANDBOX_CONFIGURATIONS,
    error: connected ? query.error : null,
    loading: !connected || (!query.isSuccess && query.error === null),
    reload: query.refresh,
  };
}

export function SandboxRegistrationRow({
  environmentId,
  configuration,
  onEdit,
}: {
  environmentId: EnvironmentId;
  configuration: SandboxConfiguration;
  onEdit: () => void;
}) {
  const verify = useAtomCommand(serverEnvironment.verifySandboxConfiguration, {
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.removeSandboxConfiguration, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerLabel = SANDBOX_PROVIDER_LABELS[configuration.provider];
  const act = async (action: "verify" | "remove") => {
    if (
      action === "remove" &&
      (await requestConfirmDialog(
        `Remove ${configuration.name}?\nThis deletes its saved ${providerLabel} token from this server.`,
        { variant: "destructive" },
      )) !== true
    )
      return;
    setPending(true);
    setError(null);
    const response = await (action === "verify" ? verify : remove)({
      environmentId,
      input: { id: configuration.id, expectedRevision: configuration.revision },
    });
    setPending(false);
    if (response._tag === "Failure") setError(formatFailure(response));
  };
  return (
    <div
      {...searchableSetting("sandbox-account")}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2.5 sm:px-4"
    >
      <CloudIcon className="size-4 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {configuration.name}
          <Badge variant="warning" size="sm" className="shrink-0">
            Early Access
          </Badge>
        </p>
        <p className="text-xs text-muted-foreground">
          {providerLabel} ·{" "}
          {pending
            ? "Updating…"
            : !configuration.credentialConfigured
              ? "Token required"
              : configuration.verifiedAt
                ? `Verified ${new Date(configuration.verifiedAt).toLocaleString()}`
                : "Not verified"}
        </p>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`${configuration.name} actions`}
              disabled={pending}
            />
          }
        >
          <EllipsisIcon className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={onEdit}>Edit provider…</MenuItem>
          <MenuItem
            disabled={!configuration.credentialConfigured}
            onClick={() => void act("verify")}
          >
            Verify
          </MenuItem>
          <MenuItem variant="destructive" onClick={() => void act("remove")}>
            Remove
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

export function SandboxConfigurationForm({
  environmentId,
  configuration,
  onSaved,
}: {
  environmentId: EnvironmentId;
  configuration: SandboxConfiguration | null;
  onSaved: () => void;
}) {
  const providerId = useId();
  const [provider, setProvider] = useState<SandboxConfiguration["provider"] | null>(
    configuration?.provider ?? null,
  );
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={providerId} className="mb-1.5 block text-xs font-medium text-foreground">
          Provider
        </label>
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger id={providerId} size="sm">
            <SelectValue placeholder="Choose provider">
              {provider ? SANDBOX_PROVIDER_LABELS[provider] : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {Object.entries(SANDBOX_PROVIDER_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {provider === "sprites" ? (
        <SpritesConfigurationForm
          environmentId={environmentId}
          configuration={configuration}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}

function SpritesConfigurationForm({
  environmentId,
  configuration,
  onSaved,
}: {
  environmentId: EnvironmentId;
  configuration: SandboxConfiguration | null;
  onSaved: () => void;
}) {
  const save = useAtomCommand(serverEnvironment.saveSandboxConfiguration, { reportFailure: false });
  const verify = useAtomCommand(serverEnvironment.verifySandboxConfiguration, {
    reportFailure: false,
  });
  const [current, setCurrent] = useState(configuration);
  const [name, setName] = useState(configuration?.name ?? "");
  const [credential, setCredential] = useState("");
  const [clearCredential, setClearCredential] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setPending(true);
    setError(null);
    const saved = await save({
      environmentId,
      input: {
        provider: "sprites",
        name: name.trim(),
        expectedRevision: current?.revision ?? 0,
        ...(current ? { id: current.id } : {}),
        ...(clearCredential
          ? { credential: null }
          : credential.trim()
            ? { credential: credential.trim() }
            : {}),
      },
    });
    if (saved._tag === "Failure") {
      setError(formatFailure(saved));
      setPending(false);
      return;
    }
    setCurrent(saved.value);
    setCredential("");
    setClearCredential(false);
    if (saved.value.credentialConfigured) {
      const verified = await verify({
        environmentId,
        input: { id: saved.value.id, expectedRevision: saved.value.revision },
      });
      if (verified._tag === "Failure") {
        // Verification advances the persisted revision even when the provider rejects the token.
        toastManager.add({
          type: "error",
          title: "Sprites registered, verification failed",
          description: formatFailure(verified),
        });
        onSaved();
        return;
      }
    }
    setPending(false);
    onSaved();
  };
  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
          <Input
            value={name}
            disabled={pending}
            placeholder="Personal or Work"
            aria-label="Registration name"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Sprites API token
          </span>
          <Input
            type="password"
            value={credential}
            disabled={pending || clearCredential}
            placeholder={
              current?.credentialConfigured ? "Configured — leave blank to keep" : "Enter API token"
            }
            aria-label="Sprites API token"
            onChange={(event) => setCredential(event.target.value)}
          />
        </label>
        {current?.credentialConfigured ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setClearCredential((value) => !value)}
          >
            {clearCredential ? "Keep token" : "Clear token"}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        variant="outline"
        className="w-full"
        disabled={pending || !name.trim() || (!current && !credential.trim())}
        onClick={() => void submit()}
      >
        {!configuration ? <PlusIcon className="size-3.5" /> : null}
        {configuration
          ? pending
            ? "Saving…"
            : "Save changes"
          : pending
            ? "Adding…"
            : "Add environment"}
      </Button>
    </div>
  );
}
