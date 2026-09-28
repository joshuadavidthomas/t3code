import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  SandboxSubmissionError,
  ThreadId,
  type SandboxSubmissionUpdate,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

const state = vi.hoisted(() => ({
  update: null as SandboxSubmissionUpdate | null,
  stored: null as SandboxSubmissionUpdate | null,
  storedError: null as Error | null,
  shell: null as object | null,
  detail: null as object | null,
  commands: new Map<string, ReturnType<typeof vi.fn>>(),
  saved: new Map<string, unknown>(),
  toast: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../connection/onboarding", () => ({
  connectPairing: "connect",
  awaitEnvironmentConnection: "await",
}));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    sandboxSubmission: () => "subscription",
    getSandboxSubmission: () => "stored",
    submitSandbox: "submit",
    retrySandboxSubmission: "retry",
    cancelSandboxSubmission: "cancel",
    pairSandboxDestination: "pair",
    deleteSandboxSubmission: "delete",
    listSandboxSubmissions: "list",
  },
  environmentServerConfigsAtom: "configs",
}));
vi.mock("../connection/catalog", () => ({
  environmentCatalog: { remove: "forget", catalogValueAtom: "catalog" },
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: string) => (atom === "catalog" ? { entries: state.saved } : new Map()),
  },
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => state.commands.get(command),
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: string | null) => ({
    data: atom === "subscription" ? state.update : atom === "stored" ? state.stored : null,
    error: atom === "stored" ? state.storedError : null,
    isPending: false,
    isSuccess: true,
    refresh: state.refresh,
  }),
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => state.shell,
  useThreadDetail: () => state.detail,
}));

import {
  DraftId,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
  type SandboxDraftSetup,
} from "../composerDraftStore";
import {
  SandboxSubmissionCoordinator,
  sandboxSubmitRejection,
  useDiscardDraftThread,
  useSandboxSubmission,
} from "./useSandbox";

const draftId = DraftId.make("draft-sandbox");
const threadId = ThreadId.make("thread-sandbox");
const messageId = MessageId.make("message-sandbox");

function setup(phase: "running" | "failed" | "cancelled" = "running"): SandboxDraftSetup {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    prompt: "Original prompt",
    messageId,
    submission: {
      key: "sandbox-test",
      sourceProjectId: ProjectId.make("source-project"),
      sourceBranch: "main",
      commandId: CommandId.make("sandbox:send:stable"),
      intent: "foreground",
      handoff: "ready",
    },
    snapshot: {
      kind: "sandbox",
      threadId,
      phase,
      startedAt: at,
      endedAt: phase === "running" ? null : at,
      branch: "main",
      baseRef: "main",
      worktreePath: null,
      setupScript: null,
      error: phase === "failed" ? "Agent failed to start" : null,
      sequence: 3,
      stages: [
        {
          id: "agent",
          status: phase === "running" ? "running" : "failed",
          startedAt: at,
          endedAt: phase === "running" ? null : at,
          percent: null,
          detail: null,
          tail: [],
        },
      ],
    },
  };
}

function seed(value = setup()) {
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(
    scopeProjectRef(EnvironmentId.make("sandbox"), ProjectId.make("sandbox-project")),
    draftId,
    { threadId },
  );
  store.setDraftThreadContext(draftId, { sandboxSetup: value });
  store.setPrompt(draftId, "");
}

function current() {
  return useComposerDraftStore.getState().getDraftSession(draftId)!.sandboxSetup!;
}

beforeEach(() => {
  state.update = null;
  state.stored = null;
  state.storedError = null;
  state.shell = null;
  state.detail = null;
  state.commands.clear();
  state.saved = new Map();
  state.toast.mockReset();
  for (const command of [
    "submit",
    "retry",
    "cancel",
    "pair",
    "connect",
    "await",
    "delete",
    "forget",
  ])
    state.commands.set(command, vi.fn());
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
});

it("reloads persisted background intent without automatically sending it", () => {
  const initial = setup();
  seed({
    ...initial,
    submission: { ...initial.submission!, intent: "background" },
  });
  const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
  const hydrated = useComposerDraftStore.persist.getOptions().merge!(
    persisted,
    useComposerDraftStore.getState(),
  );

  useComposerDraftStore.setState(hydrated);

  expect(current()).toEqual({
    ...initial,
    submission: { ...initial.submission!, intent: "background" },
  });
  expect(current().submission).toMatchObject({
    commandId: "sandbox:send:stable",
    handoff: "ready",
    intent: "background",
  });
  expect(current().messageId).toBe("message-sandbox");
});

it("keeps setup and its prompt reserved when cancellation fails or is still pending", async () => {
  const mounted = await mountSubmission();
  try {
    state.commands.get("cancel")!.mockResolvedValueOnce({ _tag: "Failure" });
    await act(async () => {
      await mounted.actions().cancel();
    });
    expect(current().snapshot.phase).toBe("running");
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt ?? "").toBe("");
    state.commands.get("cancel")!.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        ...completed(),
        destination: null,
        intakeStarted: false,
        cancelRequested: true,
        progress: { ...completed().progress, phase: "running" },
      },
    });
    await act(async () => {
      await mounted.actions().cancel();
    });
    expect(current().snapshot.phase).toBe("running");
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.threadId).toBe(threadId);
  } finally {
    await mounted.close();
  }
});

async function mountSubmission() {
  const initial = setup();
  seed({
    ...initial,
    submission: {
      ...initial.submission!,
      ownerEnvironmentId: EnvironmentId.make("owner"),
      handoff: "provisioning",
    },
  });
  let actions!: ReturnType<typeof useSandboxSubmission>;
  function Probe() {
    const pending = useComposerDraftStore(
      (store) => store.getDraftSession(draftId)?.sandboxSetup ?? null,
    );
    const result = useSandboxSubmission(draftId, pending);
    useLayoutEffect(() => {
      actions = result;
    });
    return null;
  }
  function Harness({ composer = true }: { composer?: boolean }) {
    return (
      <>
        <SandboxSubmissionCoordinator />
        {composer ? <Probe /> : null}
      </>
    );
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness />);
  });
  return {
    actions: () => actions,
    update: async () => {
      await act(async () => renderer.update(<Harness />));
    },
    updateWithoutComposer: async () => {
      await act(async () => renderer.update(<Harness composer={false} />));
    },
    close: async () => {
      await act(async () => renderer.unmount());
    },
  };
}

function completed(): SandboxSubmissionUpdate {
  return {
    commandId: setup().submission!.commandId,
    progress: { ...setup().snapshot, phase: "done", sequence: 8 },
    destination: {
      environmentId: EnvironmentId.make("destination"),
      projectId: ProjectId.make("dest-project"),
      threadId,
    },
    intakeStarted: true,
    cancelRequested: false,
    deletedAt: null,
    deletionError: null,
  };
}

it("promotes an accepted destination through pairing without submitting another turn", async () => {
  const done = completed();
  state.commands.get("pair")!.mockResolvedValue({
    _tag: "Success",
    value: {
      destination: done.destination,
      url: "https://sprite.example",
      pairingToken: "pair-token",
    },
  });
  state.commands
    .get("connect")!
    .mockResolvedValue({ _tag: "Success", value: done.destination!.environmentId });
  state.commands.get("await")!.mockResolvedValue({ _tag: "Success", value: undefined });
  const mounted = await mountSubmission();
  try {
    state.update = done;
    await mounted.updateWithoutComposer();
    expect(state.commands.get("connect")).toHaveBeenCalledWith({
      host: "https://sprite.example",
      pairingCode: "pair-token",
    });
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo).toEqual({
      environmentId: done.destination!.environmentId,
      threadId,
    });
    expect(state.commands.get("submit")).not.toHaveBeenCalled();
    expect(state.commands.get("retry")).not.toHaveBeenCalled();
    expect(state.commands.get("pair")).toHaveBeenCalledTimes(1);
  } finally {
    await mounted.close();
  }
});

it("finalizes an accepted background draft only after its destination starts and preserves a newer draft", async () => {
  const done = completed();
  state.commands.get("pair")!.mockResolvedValue({
    _tag: "Success",
    value: {
      destination: done.destination,
      url: "https://sprite.example",
      pairingToken: "pair-token",
    },
  });
  state.commands
    .get("connect")!
    .mockResolvedValue({ _tag: "Success", value: done.destination!.environmentId });
  state.commands.get("await")!.mockResolvedValue({ _tag: "Success", value: undefined });
  const mounted = await mountSubmission();
  try {
    const pending = current();
    useComposerDraftStore.getState().setDraftThreadContext(draftId, {
      sandboxSetup: {
        ...pending,
        submission: { ...pending.submission!, intent: "background" },
      },
    });
    state.update = done;
    await mounted.updateWithoutComposer();

    const destinationProjectRef = scopeProjectRef(
      done.destination!.environmentId,
      done.destination!.projectId,
    );
    const nextDraftId = DraftId.make("newer-destination-draft");
    useComposerDraftStore.getState().setProjectDraftThreadId(destinationProjectRef, nextDraftId, {
      threadId: ThreadId.make("newer-destination-thread"),
    });
    useComposerDraftStore.getState().setPrompt(nextDraftId, "Keep this newer prompt");
    state.shell = {};
    await mounted.updateWithoutComposer();

    expect(useComposerDraftStore.getState().getDraftSession(draftId)).not.toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectRef(destinationProjectRef)?.draftId,
    ).toBe(nextDraftId);

    state.detail = { latestTurn: null, messages: [], session: { status: "running" } };
    await mounted.updateWithoutComposer();

    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.sandboxSetup).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectRef(destinationProjectRef)?.draftId,
    ).toBe(nextDraftId);
    expect(useComposerDraftStore.getState().getComposerDraft(nextDraftId)?.prompt).toBe(
      "Keep this newer prompt",
    );
  } finally {
    await mounted.close();
  }
});

it("keeps pairing failures until explicit retry and rejects stale progress", async () => {
  const done = completed();
  state.commands.get("pair")!.mockResolvedValue({ _tag: "Failure" });
  const mounted = await mountSubmission();
  try {
    state.update = done;
    await mounted.update();
    expect(current().snapshot.phase).toBe("failed");
    state.stored = { ...done, progress: { ...done.progress, sequence: 2, phase: "running" } };
    await mounted.update();
    expect(current().snapshot.phase).toBe("failed");
    expect(state.commands.get("pair")).toHaveBeenCalledTimes(1);
    await act(async () => {
      await mounted.actions().retry();
    });
    expect(state.commands.get("pair")).toHaveBeenCalledTimes(2);
    expect(state.commands.get("submit")).not.toHaveBeenCalled();
    expect(state.commands.get("retry")).not.toHaveBeenCalled();
  } finally {
    await mounted.close();
  }
});

it.each(["cancelled", "deleted"] as const)(
  "restores the prompt after authoritative %s cleanup",
  async (terminal) => {
    const mounted = await mountSubmission();
    try {
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt ?? "").toBe("");
      state.update = {
        ...completed(),
        destination: null,
        intakeStarted: false,
        cancelRequested: true,
        deletedAt: terminal === "deleted" ? "2026-09-27T00:00:00.000Z" : null,
        progress: {
          ...completed().progress,
          phase: terminal === "cancelled" ? "cancelled" : "done",
        },
      };
      await mounted.update();
      expect(useComposerDraftStore.getState().getDraftSession(draftId)?.sandboxSetup).toBeNull();
      expect(useComposerDraftStore.getState().getDraftSession(draftId)?.threadId).not.toBe(
        threadId,
      );
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
        "Original prompt",
      );
      expect(state.commands.get("pair")).not.toHaveBeenCalled();
    } finally {
      await mounted.close();
    }
  },
);

it("waits for its own submit before treating a missing submission as lost", async () => {
  const mounted = await mountSubmission();
  try {
    const input = { commandId: current().submission!.commandId } as never;
    let accept!: (result: unknown) => void;
    state.commands.get("submit")!.mockReturnValueOnce(new Promise((resolve) => (accept = resolve)));
    let submitted!: Promise<unknown>;
    await act(async () => {
      submitted = mounted.actions().submit(EnvironmentId.make("owner"), input);
    });
    // The host hasn't stored the command yet, so asking for it fails.
    state.storedError = new Error("Sandbox submission does not exist.");
    await mounted.update();
    expect(current().snapshot.phase).toBe("running");
    await act(async () => {
      accept({ _tag: "Success", value: { ...completed(), progress: setup().snapshot } });
      await submitted;
    });
    expect(current().snapshot.phase).toBe("running");
    // Without a submit in flight, as after a reload, the same absence is a lost launch.
    state.storedError = new Error("Sandbox submission does not exist.");
    await mounted.update();
    expect(current().snapshot.phase).toBe("failed");
  } finally {
    await mounted.close();
  }
});

it("hands a refused launch back with the server's reason and keeps an unconfirmed one for retry", async () => {
  const mounted = await mountSubmission();
  try {
    const input = { commandId: current().submission!.commandId } as never;
    const unconfirmed = AsyncResult.failure(Cause.fail(new Error("socket closed")));
    state.commands.get("submit")!.mockResolvedValueOnce(unconfirmed);
    await act(async () => {
      await mounted.actions().submit(EnvironmentId.make("owner"), input);
    });
    expect(sandboxSubmitRejection(unconfirmed)).toBeNull();
    expect(current().snapshot.phase).toBe("failed");

    const refused = AsyncResult.failure(
      Cause.fail(new SandboxSubmissionError({ code: "conflict", message: "Account changed." })),
    );
    state.commands.get("submit")!.mockResolvedValueOnce(refused);
    await act(async () => {
      await mounted.actions().submit(EnvironmentId.make("owner"), input);
    });
    expect(sandboxSubmitRejection(refused)).toBe("Account changed.");
    expect(
      sandboxSubmitRejection(
        AsyncResult.failure(
          Cause.fail(
            new SandboxSubmissionError({ code: "unavailable", message: "Server build missing." }),
          ),
        ),
      ),
    ).toBe("Server build missing.");
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.sandboxSetup).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "Original prompt",
    );
  } finally {
    await mounted.close();
  }
});

async function discard(value: SandboxDraftSetup) {
  seed({
    ...value,
    submission: { ...value.submission!, ownerEnvironmentId: EnvironmentId.make("owner") },
  });
  let run!: ReturnType<typeof useDiscardDraftThread>;
  function Probe() {
    run = useDiscardDraftThread();
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Probe />);
  });
  await act(async () => {
    run(draftId);
  });
  await act(async () => renderer.unmount());
}

it("deletes a discarded launch's sandbox and forgets its connection", async () => {
  const destination = completed().destination!;
  state.saved.set(destination.environmentId, {});
  state.commands.get("delete")!.mockResolvedValue({
    _tag: "Success",
    value: { destination, deletionError: null, deletedAt: "2026-09-28T00:00:00.000Z" },
  });
  state.commands.get("forget")!.mockResolvedValue({ _tag: "Success" });
  await discard(setup("failed"));
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
  expect(state.commands.get("delete")).toHaveBeenCalledExactlyOnceWith({
    environmentId: "owner",
    input: { commandId: setup().submission!.commandId },
  });
  expect(state.commands.get("forget")).toHaveBeenCalledExactlyOnceWith(destination.environmentId);
  expect(state.toast).not.toHaveBeenCalled();
});

it("discards quietly when the host never stored the launch or already deleted it", async () => {
  state.commands.get("delete")!.mockResolvedValue(
    AsyncResult.failure(
      Cause.fail(
        new SandboxSubmissionError({
          code: "invalid",
          message: "Sandbox submission does not exist.",
        }),
      ),
    ),
  );
  await discard(setup("failed"));
  expect(state.toast).not.toHaveBeenCalled();
  expect(state.commands.get("forget")).not.toHaveBeenCalled();
  await discard(setup("cancelled"));
  expect(state.commands.get("delete")).toHaveBeenCalledTimes(1);
});

it("tells the user when a discarded launch's sandbox couldn't be deleted", async () => {
  state.commands.get("delete")!.mockResolvedValue({
    _tag: "Success",
    value: { destination: null, deletionError: "Provider unavailable", deletedAt: null },
  });
  await discard(setup("failed"));
  expect(state.toast).toHaveBeenCalledOnce();
});
