import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthStandardClientScopes,
  type AuthSessionState,
  type EnvironmentId,
  type SandboxSubmission,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  SANDBOX_PAIRING_SCOPE_MESSAGE,
  useConnectSandboxDestination,
  useSandboxCleanup,
} from "../useSandbox";
import { requestConfirmDialog } from "~/confirmDialog";
import { environmentCatalog } from "~/connection/catalog";
import { isElectron } from "~/env";
import { usePrimarySessionState } from "~/environments/primary";
import { useEnvironments, type EnvironmentPresentation } from "~/state/environments";
import { useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentSessionState } from "~/state/session";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { EnvironmentRow, savedBackendStatus } from "./EnvironmentRow";
import { EditSandboxConfigurationDialog, SandboxRegistrationRow } from "./SandboxSettings";
import { SettingsRow } from "./settingsLayout";

export function canOperateSandboxResources(
  environment: EnvironmentPresentation,
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null,
) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget" && isElectron) return true;
  return (
    session?.authenticated === true &&
    session.scopes?.includes(AuthOrchestrationOperateScope) === true
  );
}

/** Pairing mints a standard client credential on the sandbox, like host pairing links. */
export function canPairSandboxDestinations(
  environment: EnvironmentPresentation,
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null,
) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget" && isElectron) return true;
  return (
    session?.authenticated === true &&
    [AuthAccessWriteScope, ...AuthStandardClientScopes].every((scope) =>
      session.scopes?.includes(scope),
    )
  );
}

/** The provider's name for the sandbox, which matches its dashboard, once it exists. */
export function sandboxResourceLabel(submission: SandboxSubmission) {
  return submission.resourceName ?? submission.input.title;
}

export function sandboxResourceStatus(submission: SandboxSubmission) {
  if (submission.deletionError) return `Delete failed: ${submission.deletionError}`;
  if (submission.savedAt)
    return submission.progress.phase === "running"
      ? "Restoring"
      : submission.progress.phase === "failed"
        ? `Restore failed: ${submission.progress.error ?? "unknown error"}`
        : "Saved";
  switch (submission.progress.phase) {
    case "done":
      return submission.destination ? "Ready" : "Finishing setup";
    case "failed":
      return submission.progress.error
        ? `Setup failed: ${submission.progress.error}`
        : "Setup failed";
    case "cancelled":
      return "Cancelled";
    case "running":
      return submission.cancelRequested ? "Cancelling" : "Setting up";
  }
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : String(failure);
}

export type SandboxBadge = {
  readonly label: string;
  readonly variant: "info" | "success" | "secondary" | "outline" | "warning" | "error";
};

/**
 * A sandbox's state at a glance. Once it runs, that's its threads' state as the
 * sidebar shows it: Active while any is, Settled once all are. Unknown on a device
 * that isn't connected to it.
 */
export function sandboxBadge(
  submission: SandboxSubmission,
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "settledOverride">> | null,
): SandboxBadge | null {
  if (submission.savedAt)
    return submission.progress.phase === "running"
      ? { label: "Restoring", variant: "info" }
      : submission.progress.phase === "failed"
        ? { label: "Failed", variant: "error" }
        : { label: "Archived", variant: "outline" };
  switch (submission.progress.phase) {
    case "running":
      return submission.cancelRequested
        ? { label: "Cancelling", variant: "warning" }
        : { label: "Setting up", variant: "info" };
    case "failed":
      return { label: "Failed", variant: "error" };
    case "cancelled":
      return null;
    case "done":
      if (!threads || threads.length === 0) return null;
      return threads.some((thread) => thread.settledOverride !== "settled")
        ? { label: "Active", variant: "success" }
        : { label: "Settled", variant: "secondary" };
  }
}

// The order a folded list counts them in: what needs attention first.
const SANDBOX_BADGE_ORDER = [
  "Failed",
  "Setting up",
  "Cancelling",
  "Restoring",
  "Active",
  "Settled",
  "Archived",
];

/** Environments that are sandboxes a connected host launched. They're listed under
 * the account that made them rather than with the machines. */
export function useSandboxEnvironmentIds(): ReadonlySet<EnvironmentId> {
  const { environments } = useEnvironments();
  const ids = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          environments
            .flatMap((environment) =>
              environment.serverConfig?.environment.capabilities.sandboxConfiguration === true
                ? Option.getOrElse(
                    AsyncResult.value(
                      get(
                        serverEnvironment.sandboxSubmissions({
                          environmentId: environment.environmentId,
                          input: {},
                        }),
                      ),
                    ),
                    () => [],
                  )
                : [],
            )
            .flatMap((submission) =>
              submission.deletedAt === null && submission.destination
                ? [submission.destination.environmentId]
                : [],
            )
            .join(","),
        ),
      [environments],
    ),
  );
  return useMemo(() => new Set(ids ? (ids.split(",") as EnvironmentId[]) : []), [ids]);
}

type SandboxAction = "connect" | "retry" | "cancel" | "delete";

function SandboxHostAccounts({
  environment,
  onPresenceChange,
}: {
  environment: EnvironmentPresentation;
  onPresenceChange: (environmentId: string, present: boolean) => void;
}) {
  const submissions = useEnvironmentQuery(
    serverEnvironment.sandboxSubmissions({ environmentId: environment.environmentId, input: {} }),
  );
  const configurations = useEnvironmentQuery(
    serverEnvironment.sandboxConfiguration({ environmentId: environment.environmentId, input: {} }),
  );
  const sandboxes = (submissions.data ?? []).filter((submission) => submission.deletedAt === null);
  const accounts = configurations.data ?? [];
  const present = sandboxes.length > 0 || accounts.length > 0 || configurations.error !== null;
  useEffect(() => {
    onPresenceChange(environment.environmentId, present);
    return () => onPresenceChange(environment.environmentId, false);
  }, [environment.environmentId, present, onPresenceChange]);
  const remoteSession = useEnvironmentSessionState(environment.environmentId);
  const primarySession = usePrimarySessionState();
  const session =
    environment.entry.target._tag === "PrimaryConnectionTarget"
      ? primarySession.data
      : remoteSession.data;
  const canOperate = canOperateSandboxResources(environment, session);
  const canPair = canPairSandboxDestinations(environment, session);
  const connectDestination = useConnectSandboxDestination();
  const retry = useAtomCommand(serverEnvironment.retrySandboxSubmission, { reportFailure: false });
  const cancel = useAtomCommand(serverEnvironment.cancelSandboxSubmission, {
    reportFailure: false,
  });
  const { deleteSandbox } = useSandboxCleanup();
  const [pending, setPending] = useState<{ commandId: string; action: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);

  const run = async (submission: SandboxSubmission, action: SandboxAction) => {
    if (pending) return;
    if (
      action === "delete" &&
      (await requestConfirmDialog(
        `Delete ${sandboxResourceLabel(submission)}?\nThis permanently deletes the sandbox, its files and its threads, including any running work.`,
        { variant: "destructive" },
      )) !== true
    )
      return;
    const commandId = submission.input.commandId;
    setPending({ commandId, action });
    setErrors((current) => ({ ...current, [commandId]: "" }));
    let result:
      | { readonly _tag: "Success" }
      | ({ readonly _tag: "Failure" } & Parameters<typeof squashAtomCommandFailure>[0]);
    if (action === "connect") {
      const connected = await connectDestination(environment.environmentId, commandId);
      if (connected._tag === "Failed")
        setErrors((current) => ({ ...current, [commandId]: connected.message }));
      submissions.refresh();
      setPending(null);
      return;
    } else if (action === "delete") {
      const error = await deleteSandbox(environment.environmentId, commandId);
      if (error) setErrors((current) => ({ ...current, [commandId]: error }));
      submissions.refresh();
      setPending(null);
      return;
    } else {
      const command = action === "retry" ? retry : cancel;
      result = await command({ environmentId: environment.environmentId, input: { commandId } });
    }
    if (result._tag === "Failure")
      setErrors((current) => ({ ...current, [commandId]: failureMessage(result) }));
    submissions.refresh();
    setPending(null);
  };
  const list = (key: string, members: ReadonlyArray<SandboxSubmission>, title?: string) =>
    members.length === 0 ? null : (
      <SandboxList
        key={`sandboxes:${key}`}
        {...(title ? { title } : {})}
        sandboxes={members}
        canOperate={canOperate}
        canPair={canPair}
        pending={pending}
        errors={errors}
        onRun={(submission, action) => void run(submission, action)}
      />
    );
  // Sandboxes outlive the account that made them; removing it keeps them.
  const orphans = sandboxes.filter(
    (submission) => !accounts.some((account) => account.id === submission.input.configurationId),
  );
  return (
    <>
      {configurations.error ? (
        <SettingsRow
          title="Sandbox accounts"
          description="Couldn't load sandbox accounts."
          status={<span className="block text-destructive">{configurations.error}</span>}
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={configurations.refresh}
              disabled={configurations.isPending}
            >
              {configurations.isPending ? "Retrying…" : "Retry"}
            </Button>
          }
        />
      ) : null}
      {accounts.flatMap((account) => [
        <SandboxRegistrationRow
          key={account.id}
          environmentId={environment.environmentId}
          configuration={account}
          onEdit={() => setEditing(account.id)}
        />,
        list(
          account.id,
          sandboxes.filter((submission) => submission.input.configurationId === account.id),
        ),
      ])}
      {configurations.isSuccess ? list("orphans", orphans, "From removed accounts") : null}
      <EditSandboxConfigurationDialog
        environmentId={environment.environmentId}
        configuration={accounts.find((account) => account.id === editing) ?? null}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

/** An account's sandboxes, folded so a long list stays out of the way. */
function SandboxList({
  title,
  sandboxes,
  canOperate,
  canPair,
  pending,
  errors,
  onRun,
}: {
  /** Names the group when no account row above it does. */
  title?: string;
  sandboxes: ReadonlyArray<SandboxSubmission>;
  canOperate: boolean;
  canPair: boolean;
  pending: { commandId: string; action: string } | null;
  errors: Record<string, string>;
  onRun: (submission: SandboxSubmission, action: SandboxAction) => void;
}) {
  const { environments } = useEnvironments();
  const shells = useThreadShells();
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const rows = sandboxes.map((submission) => {
    const destination = submission.destination?.environmentId ?? null;
    const here = destination
      ? (environments.find((environment) => environment.environmentId === destination) ?? null)
      : null;
    const threads =
      here?.connection.phase === "connected"
        ? shells.filter(
            (thread) => thread.environmentId === destination && thread.archivedAt === null,
          )
        : null;
    return { submission, here, badge: sandboxBadge(submission, threads) };
  });
  const summary = [
    `${sandboxes.length} ${sandboxes.length === 1 ? "sandbox" : "sandboxes"}`,
    ...SANDBOX_BADGE_ORDER.flatMap((label) => {
      const count = rows.filter((row) => row.badge?.label === label).length;
      return count > 0 ? [`${count} ${label.toLowerCase()}`] : [];
    }),
  ].join(" · ");
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex min-h-9 w-full min-w-0 items-center gap-2 py-2 pr-3 pl-10 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pr-4 sm:pl-11">
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        {title ? <span className="shrink-0 text-xs font-medium">{title}</span> : null}
        <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="[&>*]:border-t [&>*]:border-border/50">
          {rows.map(({ submission, here, badge }) => (
            <SandboxRow
              key={submission.input.commandId}
              submission={submission}
              here={here}
              badge={badge}
              canOperate={canOperate}
              canPair={canPair}
              busy={pending !== null}
              connecting={
                pending?.commandId === submission.input.commandId && pending.action === "connect"
              }
              error={errors[submission.input.commandId] ?? ""}
              onRun={onRun}
              onSetEnabled={(environmentId, enabled) => void setEnabled({ environmentId, enabled })}
            />
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** One sandbox: what the host knows about it, and this device's connection to it. */
function SandboxRow({
  submission,
  here,
  badge,
  canOperate,
  canPair,
  busy,
  connecting,
  error: actionError,
  onRun,
  onSetEnabled,
}: {
  submission: SandboxSubmission;
  here: EnvironmentPresentation | null;
  badge: SandboxBadge | null;
  canOperate: boolean;
  canPair: boolean;
  busy: boolean;
  connecting: boolean;
  error: string;
  onRun: (submission: SandboxSubmission, action: SandboxAction) => void;
  onSetEnabled: (environmentId: EnvironmentId, enabled: boolean) => void;
}) {
  const label = sandboxResourceLabel(submission);
  const running =
    submission.progress.phase === "done" && submission.destination !== null && !submission.savedAt;
  const connection = here ? savedBackendStatus(here) : null;
  const detail =
    actionError ||
    submission.deletionError ||
    (running
      ? connection
        ? connection.text
        : canPair
          ? "Not connected"
          : SANDBOX_PAIRING_SCOPE_MESSAGE
      : submission.progress.phase === "failed"
        ? (submission.progress.error ?? null)
        : null);
  const failed =
    Boolean(actionError || submission.deletionError) ||
    (running && connection?.tone === "error" && here?.entry.enabled === true);
  return (
    <EnvironmentRow
      kind="cloud"
      className="pl-10 sm:pl-11"
      dimmed={here !== null && !here.entry.enabled}
      label={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{label}</span>
          {badge ? (
            <Badge variant={badge.variant} size="sm" className="shrink-0">
              {badge.label}
            </Badge>
          ) : null}
        </span>
      }
      subtitle={
        <span className={failed ? "block truncate text-destructive" : "block truncate"}>
          {[label === submission.input.title ? null : submission.input.title, detail]
            .filter(Boolean)
            .join(" · ")}
        </span>
      }
    >
      {running && !here && canPair ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!canOperate || busy}
          onClick={() => onRun(submission, "connect")}
        >
          {connecting ? "Connecting…" : "Connect"}
        </Button>
      ) : submission.progress.phase === "failed" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!canOperate || busy}
          onClick={() => onRun(submission, "retry")}
        >
          Retry
        </Button>
      ) : null}
      {running && here ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Switch
                size="sm"
                checked={here.entry.enabled}
                aria-label={`${here.entry.enabled ? "Switch off" : "Switch on"} ${label}`}
                onCheckedChange={(checked) => onSetEnabled(here.environmentId, checked)}
              />
            }
          />
          <TooltipPopup side="top">
            {here.entry.enabled ? "Stop connecting on this device" : "Connect on this device"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-xs"
              disabled={!canOperate || busy}
              aria-label={`More actions for ${label}`}
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          {submission.progress.phase !== "cancelled" && !submission.intakeStarted ? (
            <>
              <MenuItem onClick={() => onRun(submission, "cancel")}>Cancel setup</MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          {submission.progress.phase !== "running" ? (
            <MenuItem variant="destructive" onClick={() => onRun(submission, "delete")}>
              Delete sandbox…
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    </EnvironmentRow>
  );
}

/** Each sandbox host's accounts, with the sandboxes each one made folded under it. */
export function SandboxAccounts({
  onPresenceChange,
}: {
  onPresenceChange: (environmentId: string, present: boolean) => void;
}) {
  const { environments } = useEnvironments();
  return environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.sandboxConfiguration === true,
    )
    .map((environment) => (
      <SandboxHostAccounts
        key={environment.environmentId}
        environment={environment}
        onPresenceChange={onPresenceChange}
      />
    ));
}
