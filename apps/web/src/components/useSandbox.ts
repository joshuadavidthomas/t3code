import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentAuthorizationError,
  type CommandId,
  type EnvironmentId,
  type SandboxDestination,
  type SandboxSubmission,
  type SandboxSubmissionUpdate,
  type SandboxSubmitInput,
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
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuery } from "../state/query";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { newThreadId } from "../lib/utils";
import { useThreadDetail, useThreadShell } from "../state/entities";
import { threadHasStarted } from "./ChatView.logic";

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
    store.setPrompt(draftId, setup.prompt);
    store.setDraftThreadContext(draftId, { sandboxSetup: null });
    recoverCancelledSandboxDraft(draftId, newThreadId());
    flushComposerDraftStorage();
  }
}

/** The server's reason when it refused a launch outright, as opposed to a launch it may have accepted. */
export function sandboxSubmitRejection(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const failure = squashAtomCommandFailure(result);
  const code =
    typeof failure === "object" && failure !== null && "code" in failure ? failure.code : null;
  if (code !== "invalid" && code !== "conflict" && code !== "unsupported") return null;
  return failure instanceof Error ? failure.message : "Failed to send message.";
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
    const result = await submitCommand({ environmentId: owner, input });
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

export const SANDBOX_PAIRING_SCOPE_MESSAGE =
  "Connecting requires the access:write scope for this backend.";
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

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
      !persisted.data &&
      !subscription.data &&
      setup.snapshot.phase === "running"
    )
      settleSandboxSetup(draftId, "failed", "Could not confirm sandbox setup. Retry to reconnect.");
  }, [draftId, persisted.error, persisted.data, subscription.data, setup.snapshot.phase]);

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
