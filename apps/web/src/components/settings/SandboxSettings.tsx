import {
  type EnvironmentId,
  SANDBOX_PROVIDER_LABELS,
  type SandboxConfiguration,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "../../state/server";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { EnvironmentRow, formatAccessTimestamp } from "./EnvironmentRow";
import { searchableSetting } from "./settingsSearch";

const EMPTY_SANDBOX_CONFIGURATIONS: readonly SandboxConfiguration[] = [];

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
    refreshing: query.isPending,
  };
}

/** Shows or hides the sandboxes folded under an account, like an expandable Source Control row. */
export function SandboxFoldButton({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={`Toggle ${label} sandboxes`}
    >
      <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
    </Button>
  );
}

export function SandboxRegistrationRow({
  environmentId,
  configuration,
  onEdit,
  sandboxes,
}: {
  environmentId: EnvironmentId;
  configuration: SandboxConfiguration;
  onEdit: () => void;
  /** The sandboxes it made, folded under it; null when it has none. */
  sandboxes: { summary: string; expanded: boolean; onToggle: () => void } | null;
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
  const status = error
    ? error
    : pending
      ? "Updating…"
      : !configuration.credentialConfigured
        ? "Token required"
        : configuration.verifiedAt
          ? `Verified ${formatAccessTimestamp(configuration.verifiedAt)}`
          : "Not verified";
  return (
    <div {...searchableSetting("sandbox-account")}>
      <EnvironmentRow
        kind="cloud"
        label={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{configuration.name}</span>
            <Badge variant="warning" size="sm" className="shrink-0">
              Early Access
            </Badge>
          </span>
        }
        subtitle={
          <span className={error ? "block truncate text-destructive" : "block truncate"}>
            {[providerLabel, status, sandboxes?.summary].filter(Boolean).join(" · ")}
          </span>
        }
      >
        {sandboxes ? <SandboxFoldButton label={configuration.name} {...sandboxes} /> : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                disabled={pending}
                aria-label={`More actions for ${configuration.name}`}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={onEdit}>Edit…</MenuItem>
            <MenuItem
              disabled={!configuration.credentialConfigured}
              onClick={() => void act("verify")}
            >
              Verify
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => void act("remove")}>
              Remove…
            </MenuItem>
          </MenuPopup>
        </Menu>
      </EnvironmentRow>
    </div>
  );
}

export function SandboxConfigurationForm({
  environmentId,
  onSaved,
}: {
  environmentId: EnvironmentId;
  onSaved: () => void;
}) {
  const providerId = useId();
  const [provider, setProvider] = useState<SandboxConfiguration["provider"] | null>(null);
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
          configuration={null}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}

/** Edits a saved account; its provider is fixed once added. */
export function EditSandboxConfigurationDialog({
  environmentId,
  configuration,
  onClose,
}: {
  environmentId: EnvironmentId;
  configuration: SandboxConfiguration | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={configuration !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        {configuration ? (
          <>
            <DialogHeader>
              <DialogTitle>Edit {configuration.name}</DialogTitle>
              <DialogDescription>
                Update this {SANDBOX_PROVIDER_LABELS[configuration.provider]} account.
              </DialogDescription>
            </DialogHeader>
            <SpritesConfigurationForm
              key={configuration.id}
              environmentId={environmentId}
              configuration={configuration}
              onSaved={onClose}
              onCancel={onClose}
            />
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Adding renders inline with the other Add Environment modes; editing (with
 * `onCancel`) renders as a dialog panel and footer.
 */
function SpritesConfigurationForm({
  environmentId,
  configuration,
  onSaved,
  onCancel,
}: {
  environmentId: EnvironmentId;
  configuration: SandboxConfiguration | null;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const save = useAtomCommand(serverEnvironment.saveSandboxConfiguration, { reportFailure: false });
  const verify = useAtomCommand(serverEnvironment.verifySandboxConfiguration, {
    reportFailure: false,
  });
  const formId = useId();
  const [current, setCurrent] = useState(configuration);
  const [name, setName] = useState(configuration?.name ?? "");
  const [namePrefix, setNamePrefix] = useState(configuration?.namePrefix ?? "");
  const [credential, setCredential] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = !pending && name.trim().length > 0 && (current !== null || credential.trim());
  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    const saved = await save({
      environmentId,
      input: {
        provider: "sprites",
        name: name.trim(),
        namePrefix: namePrefix.trim(),
        expectedRevision: current?.revision ?? 0,
        ...(current ? { id: current.id } : {}),
        ...(credential.trim() ? { credential: credential.trim() } : {}),
      },
    });
    if (saved._tag === "Failure") {
      setError(formatFailure(saved));
      setPending(false);
      return;
    }
    setCurrent(saved.value);
    setCredential("");
    if (saved.value.credentialConfigured) {
      const verified = await verify({
        environmentId,
        input: { id: saved.value.id, expectedRevision: saved.value.revision },
      });
      if (verified._tag === "Failure") {
        // Verification advances the persisted revision even when the provider rejects the token.
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not verify ${saved.value.name}`,
            description: formatFailure(verified),
          }),
        );
        onSaved();
        return;
      }
    }
    setPending(false);
    onSaved();
  };
  const fields = (
    <form
      id={formId}
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
        <Input
          value={name}
          disabled={pending}
          placeholder="e.g. Personal"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-foreground">Sprites API token</span>
        <Input
          type="password"
          autoComplete="off"
          value={credential}
          disabled={pending}
          placeholder={
            current?.credentialConfigured
              ? "Stored secret, enter a new value to replace"
              : undefined
          }
          onChange={(event) => setCredential(event.target.value)}
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-foreground">
          Sprite name prefix (optional)
        </span>
        <Input
          value={namePrefix}
          disabled={pending}
          placeholder="e.g. work-"
          spellCheck={false}
          onChange={(event) => setNamePrefix(event.target.value.toLowerCase())}
        />
      </label>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
  if (onCancel) {
    return (
      <>
        <DialogPanel>{fields}</DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!canSubmit}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </>
    );
  }
  return (
    <div className="space-y-4">
      {fields}
      <Button
        type="submit"
        form={formId}
        variant="outline"
        className="w-full"
        disabled={!canSubmit}
      >
        <PlusIcon className="size-3.5" />
        {pending ? "Adding…" : "Add environment"}
      </Button>
    </div>
  );
}
