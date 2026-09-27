import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthStandardClientScopes,
  type AuthSessionState,
  type SandboxSubmission,
} from "@t3tools/contracts";
import { CloudIcon, EllipsisIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { SANDBOX_PAIRING_SCOPE_MESSAGE, useConnectSandboxDestination } from "../useSandbox";
import { environmentCatalog } from "~/connection/catalog";
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
  const remove = useAtomCommand(serverEnvironment.deleteSandboxSubmission, {
    reportFailure: false,
  });
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled);
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
        `Delete ${submission.input.title}?\nThis permanently deletes the sandbox and its files, including any running work.`,
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
      const removed = await remove({
        environmentId: environment.environmentId,
        input: { commandId },
      });
      result = removed;
      const deletionError = removed._tag === "Success" ? removed.value.deletionError : null;
      if (deletionError) setErrors((current) => ({ ...current, [commandId]: deletionError }));
      if (
        removed._tag === "Success" &&
        removed.value.deletedAt &&
        submission.destination &&
        environments.some((entry) => entry.environmentId === submission.destination?.environmentId)
      ) {
        result = await setEnabled({
          environmentId: submission.destination.environmentId,
          enabled: false,
        });
      }
    } else {
      const command = action === "retry" ? retry : action === "cancel" ? cancel : remove;
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
      return (
        <div
          key={commandId}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 sm:px-4"
        >
          <CloudIcon aria-hidden className="size-4 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{submission.input.title}</p>
            <p
              className={
                errors[commandId] || submission.deletionError
                  ? "truncate text-xs text-destructive"
                  : "truncate text-xs text-muted-foreground"
              }
            >
              {errors[commandId] ||
                (connectable && !canPair
                  ? SANDBOX_PAIRING_SCOPE_MESSAGE
                  : sandboxResourceStatus(submission))}
            </p>
          </div>
          <div className="flex items-center gap-1">
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
                    Delete sandbox
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
          </div>
        </div>
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
