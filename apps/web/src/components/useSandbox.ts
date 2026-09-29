import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentAuthorizationError,
  SandboxSubmissionError,
  type CommandId,
  type EnvironmentId,
  type SandboxDestination,
  type SandboxSubmission,
  type SandboxSubmissionUpdate,
  type SandboxSubmitInput,
  type ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createElement, useCallback, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { awaitEnvironmentConnection, connectPairing } from "../connection/onboarding";
import {
  flushComposerDraftStorage,
  finalizePromotedDraftThreadByRef,
  recoverCancelledSandboxDraft,
  useComposerDraftStore,
  DraftId,
  type SandboxDraftSetup,
} from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuery } from "../state/query";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { newDraftId, newThreadId } from "../lib/utils";
import { useThreadDetail, useThreadShell } from "../state/entities";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { threadHasStarted } from "./ChatView.logic";
import { isDraftDiscardLocked } from "./Sidebar.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

function applySubmission(
  draftId: DraftId,
  submission: SandboxSubmission | SandboxSubmissionUpdate,
) {
  const store = useComposerDraftStore.getState();
  const setup = store.getDraftSession(draftId)?.sandboxSetup;
  const commandId = "input" in submission ? submission.input.commandId : submission.commandId;
  if (!setup?.submission || setup.submission.commandId !== commandId) return;
  if (submission.progress.sequence < setup.snapshot.sequence) return;
  // A same-sequence query result must not erase a local pairing failure. Only
  // authoritative forward progress can supersede it.
  if (
    !submission.deletedAt &&
    submission.progress.phase !== "cancelled" &&
    setup.submission.handoff === "pairing" &&
    setup.snapshot.phase === "failed" &&
    submission.progress.phase !== "failed"
  )
    return;
  store.setDraftThreadContext(draftId, {
    sandboxSetup: {
      ...setup,
      snapshot: submission.progress,
      submission: { ...setup.submission, intakeStarted: submission.intakeStarted },
    },
  });
  if (submission.progress.phase === "cancelled" || submission.deletedAt) {
    // Only the client that sent it gets the prompt back to edit.
    if (setup.submission.sentElsewhere) {
      store.clearDraftThread(draftId);
      return;
    }
    store.setPrompt(draftId, setup.prompt);
    store.setDraftThreadContext(draftId, { sandboxSetup: null });
    recoverCancelledSandboxDraft(draftId, newThreadId());
    flushComposerDraftStorage();
  }
}

function failureMessage(result: AtomCommandResult<unknown, unknown>, fallback: string) {
  const failure = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
  return failure instanceof Error ? failure.message : fallback;
}

/** The server's reason when it refused a launch outright, as opposed to a launch it may have accepted. */
export function sandboxSubmitRejection(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const failure = squashAtomCommandFailure(result);
  const code =
    typeof failure === "object" && failure !== null && "code" in failure ? failure.code : null;
  // The server decided before accepting; only a storage failure or a lost
  // response leaves acceptance unknown, and those keep the card for Retry.
  if (code !== "invalid" && code !== "conflict" && code !== "unsupported" && code !== "unavailable")
    return null;
  return failure instanceof Error ? failure.message : "Failed to send message.";
}

// Launches this client is still submitting. Until submit returns, the host may
// not have stored the command, so its absence is not yet a lost launch.
const submitting = new Set<CommandId>();
// Launches discarded here, which the host still lists until it deletes them.
const discarded = new Set<CommandId>();

/** Shows a launch in progress that another client sent, the way a worktree thread
 * being set up shows on every client. */
export function addSandboxLaunchDraft(
  ownerEnvironmentId: EnvironmentId,
  launch: SandboxSubmission,
) {
  const { commandId, configurationId, projectId, messageId, prompt } = launch.input;
  const phase = launch.progress.phase;
  if (
    (phase !== "running" && phase !== "failed") ||
    launch.deletedAt ||
    launch.savedAt ||
    discarded.has(commandId) ||
    messageId === undefined ||
    prompt === undefined
  )
    return;
  useComposerDraftStore
    .getState()
    .addSandboxLaunchDraft(newDraftId(), scopeProjectRef(ownerEnvironmentId, projectId), {
      threadId: launch.progress.threadId,
      createdAt: launch.progress.startedAt,
      branch: launch.progress.branch,
      sandboxTarget: { ownerEnvironmentId, configurationId },
      sandboxSetup: {
        prompt,
        messageId,
        snapshot: launch.progress,
        submission: {
          key: commandId,
          sourceProjectId: projectId,
          sourceBranch: launch.progress.branch,
          commandId,
          intent: "foreground",
          handoff: "provisioning",
          ownerEnvironmentId,
          intakeStarted: launch.intakeStarted,
          sentElsewhere: true,
        },
      },
    });
  flushComposerDraftStorage();
}

export function useSandboxSubmission(draftId: DraftId | null, setup: SandboxDraftSetup | null) {
  const ownerEnvironmentId = setup?.submission?.ownerEnvironmentId ?? null;
  const commandId = setup?.submission?.commandId ?? null;
  const persisted = useEnvironmentQuery(
    ownerEnvironmentId && commandId
      ? serverEnvironment.getSandboxSubmission({
          environmentId: ownerEnvironmentId,
          input: { commandId },
        })
      : null,
  );
  const submitCommand = useAtomCommand(serverEnvironment.submitSandbox, { reportFailure: false });
  const retryCommand = useAtomCommand(serverEnvironment.retrySandboxSubmission, {
    reportFailure: false,
  });
  const cancelCommand = useAtomCommand(serverEnvironment.cancelSandboxSubmission);
  const submit = async (
    owner: NonNullable<typeof ownerEnvironmentId>,
    input: SandboxSubmitInput,
  ) => {
    submitting.add(input.commandId);
    const result = await submitCommand({ environmentId: owner, input }).finally(() =>
      submitting.delete(input.commandId),
    );
    if (result._tag === "Success" && draftId) applySubmission(draftId, result.value);
    if (result._tag === "Failure" && draftId) {
      if (sandboxSubmitRejection(result) !== null) {
        const current = useComposerDraftStore.getState().getDraftSession(draftId)?.sandboxSetup;
        if (current?.submission?.commandId === input.commandId) {
          useComposerDraftStore.getState().setPrompt(draftId, current.prompt);
          useComposerDraftStore.getState().setDraftThreadContext(draftId, { sandboxSetup: null });
        }
      } else {
        settleSandboxSetup(
          draftId,
          "failed",
          "Could not confirm sandbox launch. Retry to reconnect.",
        );
        persisted.refresh();
      }
    }
    return result;
  };

  return {
    submit,
    retry: async () => {
      if (!draftId || !ownerEnvironmentId || !commandId) return;
      if (
        setup?.snapshot.phase === "done" ||
        setup?.submission?.handoff === "pairing" ||
        (persisted.data?.progress.phase === "done" && persisted.data.destination)
      ) {
        const current = useComposerDraftStore.getState().getDraftSession(draftId)?.sandboxSetup;
        if (current?.submission) {
          useComposerDraftStore.getState().setDraftThreadContext(draftId, {
            sandboxSetup: {
              ...current,
              snapshot: { ...current.snapshot, phase: "done", error: null },
              submission: { ...current.submission, handoff: "ready" },
            },
          });
          flushComposerDraftStorage();
        }
        persisted.refresh();
        return;
      }
      if (persisted.data) {
        applySubmission(draftId, persisted.data);
      } else if (setup?.submission?.input) {
        await submit(ownerEnvironmentId, setup.submission.input);
        return;
      } else if (!persisted.isSuccess) {
        persisted.refresh();
        return;
      }
      const result = await retryCommand({
        environmentId: ownerEnvironmentId,
        input: { commandId },
      });
      if (result._tag === "Success") applySubmission(draftId, result.value);
    },
    cancel: async () => {
      if (!draftId || !ownerEnvironmentId || !commandId || setup?.submission?.intakeStarted) return;
      const result = await cancelCommand({
        environmentId: ownerEnvironmentId,
        input: { commandId },
      });
      if (result._tag === "Success") applySubmission(draftId, result.value);
    },
  };
}

/** Whether deleting the sandbox would lose nothing: like automatic worktree cleanup,
 * it needs a clean tree, and unlike a worktree, every commit pushed as well. */
export function isSandboxWorkSaved(
  status: Pick<VcsStatusResult, "hasWorkingTreeChanges" | "hasUpstream" | "aheadCount">,
) {
  return !status.hasWorkingTreeChanges && status.hasUpstream && status.aheadCount === 0;
}

export type SandboxLaunch = {
  readonly ownerEnvironmentId: EnvironmentId;
  readonly submission: SandboxSubmission;
};

/** Finds and deletes sandboxes the way a thread deletes its worktree. Only the
 * host that launched a sandbox holds its account, so it does the deleting. */
export function useSandboxCleanup() {
  const list = useAtomCommand(serverEnvironment.listSandboxSubmissions, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.deleteSandboxSubmission, {
    reportFailure: false,
  });
  const forget = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const saveCommand = useAtomCommand(serverEnvironment.saveSandboxSubmission, {
    reportFailure: false,
  });
  const restoreCommand = useAtomCommand(serverEnvironment.restoreSandboxSubmission, {
    reportFailure: false,
  });

  /** The launch behind a sandbox environment, on whichever connected host made it. */
  const findLaunch = useCallback(
    async (environmentId: EnvironmentId): Promise<SandboxLaunch | null> => {
      const configs = appAtomRegistry.get(environmentServerConfigsAtom);
      if (configs.get(environmentId)?.environment.platform.machine !== "cloud") return null;
      for (const [ownerEnvironmentId, config] of configs) {
        if (config.environment.capabilities.sandboxConfiguration !== true) continue;
        const listed = await list({ environmentId: ownerEnvironmentId, input: {} });
        const submission =
          listed._tag === "Success"
            ? listed.value.find(
                (candidate) =>
                  candidate.deletedAt === null &&
                  candidate.destination?.environmentId === environmentId,
              )
            : undefined;
        if (submission) return { ownerEnvironmentId, submission };
      }
      return null;
    },
    [list],
  );

  /** Deletes the sandbox, then forgets its environment, which has nothing left to reconnect to.
   * Returns why it couldn't, or null. */
  const deleteSandbox = useCallback(
    async (ownerEnvironmentId: EnvironmentId, commandId: CommandId): Promise<string | null> => {
      const removed = await remove({ environmentId: ownerEnvironmentId, input: { commandId } });
      if (removed._tag === "Failure") {
        // Deletion reports "invalid" only for a launch the host never stored.
        const failure = squashAtomCommandFailure(removed);
        if (isSubmissionError(failure) && failure.code === "invalid") return null;
        return failureMessage(removed, "Couldn't delete the sandbox.");
      }
      if (removed.value.deletionError) return removed.value.deletionError;
      const destination = removed.value.destination?.environmentId;
      if (
        destination &&
        appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.has(destination)
      ) {
        const forgotten = await forget(destination);
        if (forgotten._tag === "Failure")
          return "The sandbox was deleted, but its connection couldn't be removed.";
      }
      return null;
    },
    [forget, remove],
  );

  /** Saves a sandbox whose threads are all archived to its host, which then deletes it. */
  const saveSandbox = useCallback(
    async ({ ownerEnvironmentId, submission }: SandboxLaunch): Promise<string | null> => {
      const saved = await saveCommand({
        environmentId: ownerEnvironmentId,
        input: { commandId: submission.input.commandId },
      });
      return saved._tag === "Success" ? null : failureMessage(saved, "Couldn't save the sandbox.");
    },
    [saveCommand],
  );

  /** Restores a saved sandbox and then the thread; its environment reconnects on its own. */
  const restoreSandbox = useCallback(
    async (
      ownerEnvironmentId: EnvironmentId,
      commandId: CommandId,
      threadId: ThreadId,
    ): Promise<string | null> => {
      const restored = await restoreCommand({
        environmentId: ownerEnvironmentId,
        input: { commandId, threadId },
      });
      return restored._tag === "Success"
        ? null
        : failureMessage(restored, "Couldn't restore the sandbox.");
    },
    [restoreCommand],
  );

  return { findLaunch, deleteSandbox, saveSandbox, restoreSandbox };
}

/** Discards a draft. A launch that never reached its thread goes with it, as Cancel does. */
export function useDiscardDraftThread() {
  const { deleteSandbox } = useSandboxCleanup();
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  return useCallback(
    (draftId: DraftId) => {
      const setup = useComposerDraftStore.getState().getDraftSession(draftId)?.sandboxSetup;
      if (isDraftDiscardLocked(setup)) return;
      if (setup?.submission) discarded.add(setup.submission.commandId);
      releaseComposerDraftUploads(draftId);
      clearDraftThread(draftId);
      const owner = setup?.submission?.ownerEnvironmentId;
      if (!owner || !setup?.submission || setup.snapshot.phase === "cancelled") return;
      void deleteSandbox(owner, setup.submission.commandId).then((error) => {
        if (error)
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Couldn't delete the sandbox",
              description: `${error} Delete it from Settings → Connections.`,
            }),
          );
      });
    },
    [clearDraftThread, deleteSandbox],
  );
}

export const SANDBOX_PAIRING_SCOPE_MESSAGE =
  "Connecting requires the access:write scope for this backend.";
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isSubmissionError = Schema.is(SandboxSubmissionError);

/** Pairs to a finished sandbox and waits for its connection, stopping early once `isCurrent` fails. */
export function useConnectSandboxDestination() {
  const pair = useAtomCommand(serverEnvironment.pairSandboxDestination, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const awaitConnection = useAtomCommand(awaitEnvironmentConnection, { reportFailure: false });
  return useCallback(
    async (
      ownerEnvironmentId: EnvironmentId,
      commandId: CommandId,
      isCurrent: () => boolean = () => true,
    ): Promise<
      | { readonly _tag: "Connected"; readonly destination: SandboxDestination }
      | { readonly _tag: "Failed"; readonly message: string }
      | { readonly _tag: "Stale" }
    > => {
      const paired = await pair({ environmentId: ownerEnvironmentId, input: { commandId } });
      if (!isCurrent()) return { _tag: "Stale" };
      if (paired._tag === "Failure")
        return {
          _tag: "Failed",
          message: isAuthorizationError(squashAtomCommandFailure(paired))
            ? SANDBOX_PAIRING_SCOPE_MESSAGE
            : "Sandbox is ready, but connecting failed.",
        };
      const connected = await connect({
        host: paired.value.url,
        pairingCode: paired.value.pairingToken,
      });
      if (!isCurrent()) return { _tag: "Stale" };
      if (
        connected._tag === "Failure" ||
        connected.value !== paired.value.destination.environmentId
      )
        return { _tag: "Failed", message: "Sandbox pairing failed." };
      const ready = await awaitConnection(connected.value);
      if (!isCurrent()) return { _tag: "Stale" };
      if (ready._tag === "Failure")
        return { _tag: "Failed", message: "Timed out connecting to the sandbox." };
      return { _tag: "Connected", destination: paired.value.destination };
    },
    [awaitConnection, connect, pair],
  );
}

export function SandboxSubmissionCoordinator() {
  const draftIds = useComposerDraftStore(
    useShallow((store) =>
      Object.entries(store.draftThreadsByThreadKey)
        .filter(([, draft]) => draft.sandboxSetup?.submission?.ownerEnvironmentId)
        .map(([draftId]) => draftId),
    ),
  );
  return draftIds.map((draftId) =>
    createElement(SandboxSubmissionSlot, { key: draftId, draftId: DraftId.make(draftId) }),
  );
}

function SandboxSubmissionSlot({ draftId }: { draftId: DraftId }) {
  const setup = useComposerDraftStore(
    (store) => store.draftThreadsByThreadKey[draftId]?.sandboxSetup ?? null,
  );
  return setup ? createElement(SandboxSubmissionObserver, { draftId, setup }) : null;
}

function SandboxSubmissionObserver({
  draftId,
  setup,
}: {
  draftId: DraftId;
  setup: SandboxDraftSetup;
}) {
  const ownerEnvironmentId = setup.submission?.ownerEnvironmentId ?? null;
  const commandId = setup.submission?.commandId ?? null;
  const subscription = useEnvironmentQuery(
    ownerEnvironmentId && commandId
      ? serverEnvironment.sandboxSubmission({
          environmentId: ownerEnvironmentId,
          input: { commandId },
        })
      : null,
  );
  const persisted = useEnvironmentQuery(
    ownerEnvironmentId && commandId
      ? serverEnvironment.getSandboxSubmission({
          environmentId: ownerEnvironmentId,
          input: { commandId },
        })
      : null,
  );
  const connectDestination = useConnectSandboxDestination();
  const pairingRef = useRef<string | null>(null);
  const promoted = useComposerDraftStore(
    (store) => store.getDraftSession(draftId)?.promotedTo ?? null,
  );
  const shell = useThreadShell(promoted);
  const detail = useThreadDetail(promoted);

  useEffect(() => {
    if (subscription.data) applySubmission(draftId, subscription.data);
  }, [draftId, subscription.data]);
  useEffect(() => {
    if (persisted.data) applySubmission(draftId, persisted.data);
  }, [draftId, persisted.data]);
  useEffect(() => {
    if (
      persisted.error &&
      commandId &&
      !submitting.has(commandId) &&
      !persisted.data &&
      !subscription.data &&
      setup.snapshot.phase === "running"
    )
      settleSandboxSetup(draftId, "failed", "Could not confirm sandbox setup. Retry to reconnect.");
  }, [
    commandId,
    draftId,
    persisted.error,
    persisted.data,
    subscription.data,
    setup.snapshot.phase,
  ]);

  useEffect(() => {
    if (setup.submission?.handoff === "pairing" && setup.snapshot.phase === "failed") {
      pairingRef.current = null;
    }
  }, [setup.snapshot.phase, setup.submission?.handoff]);

  useEffect(() => {
    const submission =
      subscription.data && persisted.data
        ? subscription.data.progress.sequence >= persisted.data.progress.sequence
          ? subscription.data
          : persisted.data
        : (subscription.data ?? persisted.data);
    if (
      !ownerEnvironmentId ||
      !commandId ||
      !submission?.destination ||
      submission.deletedAt ||
      submission.progress.phase !== "done"
    )
      return;
    if (setup.submission?.handoff === "pairing" && setup.snapshot.phase === "failed") return;
    const key = `${ownerEnvironmentId}:${commandId}`;
    if (pairingRef.current === key || promoted) return;
    pairingRef.current = key;
    void (async () => {
      const stillCurrent = () =>
        useComposerDraftStore.getState().getDraftSession(draftId)?.sandboxSetup?.submission
          ?.commandId === commandId;
      const current = useComposerDraftStore.getState().getDraftSession(draftId)?.sandboxSetup;
      if (!current?.submission || current.submission.commandId !== commandId) return;
      useComposerDraftStore.getState().setDraftThreadContext(draftId, {
        sandboxSetup: { ...current, submission: { ...current.submission, handoff: "pairing" } },
      });
      const result = await connectDestination(ownerEnvironmentId, commandId, stillCurrent);
      if (result._tag === "Stale") return;
      if (result._tag === "Failed")
        return settleSandboxSetup(draftId, "failed", `${result.message} Retry to connect again.`);
      const destination = result.destination;
      const store = useComposerDraftStore.getState();
      if (store.getDraftSession(draftId)?.sandboxSetup?.submission?.commandId !== commandId) return;
      store.setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(destination.environmentId, destination.projectId),
      });
      store.markDraftThreadPromoting(
        draftId,
        scopeThreadRef(destination.environmentId, destination.threadId),
      );
      flushComposerDraftStorage();
    })().catch(() =>
      settleSandboxSetup(
        draftId,
        "failed",
        "Could not connect to the sandbox. Retry to connect again.",
      ),
    );
  }, [
    commandId,
    connectDestination,
    draftId,
    ownerEnvironmentId,
    persisted.data,
    promoted,
    setup.snapshot.phase,
    setup.submission?.handoff,
    subscription.data,
  ]);

  useEffect(() => {
    if (promoted && setup.submission?.intent === "background" && shell && threadHasStarted(detail))
      finalizePromotedDraftThreadByRef(promoted);
  }, [detail, promoted, setup.submission?.intent, shell]);
  return null;
}

export function settleSandboxSetup(
  draftId: DraftId,
  phase: "done" | "failed" | "cancelled",
  error: string | null = null,
) {
  const store = useComposerDraftStore.getState();
  const setup = store.getDraftSession(draftId)?.sandboxSetup;
  if (!setup || setup.snapshot.phase === "cancelled") return;
  const at = new Date().toISOString();
  store.setDraftThreadContext(draftId, {
    sandboxSetup: {
      ...setup,
      snapshot: {
        ...setup.snapshot,
        phase,
        endedAt: at,
        error,
        sequence: setup.snapshot.sequence,
        stages: setup.snapshot.stages.map((stage) =>
          stage.status === "running"
            ? {
                ...stage,
                status: phase === "done" ? "done" : phase === "cancelled" ? "skipped" : "failed",
                endedAt: at,
              }
            : stage,
        ),
      },
    },
  });
}
