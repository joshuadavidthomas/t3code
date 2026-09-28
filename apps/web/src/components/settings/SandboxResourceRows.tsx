import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthStandardClientScopes,
  type AuthSessionState,
  SANDBOX_PROVIDER_LABELS,
  type SandboxSubmission,
} from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  SANDBOX_PAIRING_SCOPE_MESSAGE,
  useConnectSandboxDestination,
  useSandboxCleanup,
} from "../useSandbox";
import { requestConfirmDialog } from "~/confirmDialog";
import { isElectron } from "~/env";
import { usePrimarySessionState } from "~/environments/primary";
import { useEnvironments, type EnvironmentPresentation } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentSessionState } from "~/state/session";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { EnvironmentRow } from "./EnvironmentRow";

export function canOperateSandboxResources(
  environment: EnvironmentPresentation,
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null,
) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget" && isElectron) return true;
  return session?.authenticated === true && session.scopes?.includes(AuthOrchestrationOperateScope);
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

export function sandboxResourceStatus(submission: SandboxSubmission) {
  if (submission.deletionError) return `Delete failed: ${submission.deletionError}`;
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

function SandboxOwnerResources({
  environment,
  onResourcesChange,
}: {
  environment: EnvironmentPresentation;
  onResourcesChange: (environmentId: string, present: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const submissions = useEnvironmentQuery(
    serverEnvironment.sandboxSubmissions({ environmentId: environment.environmentId, input: {} }),
  );
  const configurations = useEnvironmentQuery(
    serverEnvironment.sandboxConfiguration({ environmentId: environment.environmentId, input: {} }),
  );
  const hasResources =
    submissions.data?.some((submission) => submission.deletedAt === null) ?? false;
  useEffect(() => {
    onResourcesChange(environment.environmentId, hasResources);
    return () => onResourcesChange(environment.environmentId, false);
  }, [environment.environmentId, hasResources, onResourcesChange]);
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

  const run = async (
    submission: SandboxSubmission,
    action: "connect" | "retry" | "cancel" | "delete",
  ) => {
    if (pending) return;
    if (
      action === "delete" &&
      (await requestConfirmDialog(
        `Delete ${submission.input.title}?\nThis permanently deletes the sandbox, its files and its threads, including any running work.`,
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

  return (submissions.data ?? [])
    .filter((submission) => submission.deletedAt === null)
    .map((submission) => {
      const commandId = submission.input.commandId;
      const busy = pending !== null;
      const done = submission.progress.phase === "done" && submission.destination !== null;
      const connectable =
        done &&
        !environments.some(
          (entry) => entry.environmentId === submission.destination?.environmentId,
        );
      const configuration = configurations.data?.find(
        (candidate) => candidate.id === submission.input.configurationId,
      );
      const error = errors[commandId] || submission.deletionError;
      const status =
        errors[commandId] ||
        (connectable && !canPair
          ? SANDBOX_PAIRING_SCOPE_MESSAGE
          : sandboxResourceStatus(submission));
      return (
        <EnvironmentRow
          key={commandId}
          kind="cloud"
          label={submission.input.title}
          subtitle={
            <span className={error ? "block truncate text-destructive" : "block truncate"}>
              {configuration
                ? `${SANDBOX_PROVIDER_LABELS[configuration.provider]} · ${status}`
                : status}
            </span>
          }
        >
          {connectable && canPair ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canOperate || busy}
              onClick={() => void run(submission, "connect")}
            >
              {pending?.commandId === commandId && pending.action === "connect"
                ? "Connecting…"
                : "Connect"}
            </Button>
          ) : submission.progress.phase === "failed" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canOperate || busy}
              onClick={() => void run(submission, "retry")}
            >
              Retry
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  disabled={!canOperate || busy}
                  aria-label={`More actions for ${submission.input.title}`}
                />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              {submission.progress.phase !== "cancelled" && !submission.intakeStarted ? (
                <>
                  <MenuItem onClick={() => void run(submission, "cancel")}>Cancel setup</MenuItem>
                  <MenuSeparator />
                </>
              ) : null}
              {submission.progress.phase !== "running" ? (
                <MenuItem variant="destructive" onClick={() => void run(submission, "delete")}>
                  Delete sandbox…
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        </EnvironmentRow>
      );
    });
}

export function SandboxResourceRows({
  onResourcesChange,
}: {
  onResourcesChange: (environmentId: string, present: boolean) => void;
}) {
  const { environments } = useEnvironments();
  return environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.sandboxConfiguration === true,
    )
    .map((environment) => (
      <SandboxOwnerResources
        key={environment.environmentId}
        environment={environment}
        onResourcesChange={onResourcesChange}
      />
    ));
}
