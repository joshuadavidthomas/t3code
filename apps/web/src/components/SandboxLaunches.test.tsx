import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type SandboxSubmission,
} from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { act } from "react";
import { create } from "react-test-renderer";

const state = vi.hoisted(() => ({
  environments: [] as unknown[],
  submissions: [] as unknown[],
  connect: vi.fn(),
  addDraft: vi.fn(),
  forget: vi.fn(),
}));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { remove: "forget" } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.forget }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string; commandId?: string } | null) => ({
    data:
      atom?.kind === "list"
        ? state.submissions
        : atom?.kind === "get"
          ? (state.submissions as SandboxSubmission[]).find(
              (launch) => launch.input.commandId === atom.commandId,
            )
          : null,
  }),
}));
vi.mock("../state/session", () => ({
  useEnvironmentSessionState: () => ({
    data: { authenticated: true, scopes: [AuthAccessWriteScope, ...AuthStandardClientScopes] },
  }),
}));
vi.mock("../environments/primary", () => ({ usePrimarySessionState: () => ({ data: null }) }));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    sandboxSubmissions: () => ({ kind: "list" }),
    getSandboxSubmission: ({ input }: { input: { commandId: string } }) => ({
      kind: "get",
      commandId: input.commandId,
    }),
  },
}));
vi.mock("./useSandbox", () => ({
  useConnectSandboxDestination: () => state.connect,
  addSandboxLaunchDraft: state.addDraft,
}));

import { useComposerDraftStore } from "../composerDraftStore";
import { SandboxLaunchesCoordinator } from "./SandboxLaunches";

const owner = EnvironmentId.make("owner");
const host = {
  environmentId: owner,
  entry: { target: { _tag: "RemoteConnectionTarget" } },
  serverConfig: { environment: { capabilities: { sandboxConfiguration: true } } },
};

function launch(
  id: string,
  phase: "running" | "failed" | "done",
  destination: string | null = null,
): SandboxSubmission {
  const at = "2026-09-29T00:00:00.000Z";
  return {
    input: {
      commandId: CommandId.make(id),
      title: id,
      configurationId: "7b0f8a52-7f6c-4c3e-9d0e-3c1f4a5b6c7d",
      projectId: ProjectId.make("project"),
    },
    progress: {
      kind: "sandbox",
      threadId: ThreadId.make(`thread-${id}`),
      phase,
      startedAt: at,
      endedAt: null,
      branch: "main",
      baseRef: "main",
      worktreePath: null,
      setupScript: null,
      error: null,
      sequence: 1,
      stages: [],
    },
    destination: destination
      ? {
          environmentId: EnvironmentId.make(destination),
          projectId: ProjectId.make("sandbox-project"),
          threadId: ThreadId.make(`thread-${id}`),
        }
      : null,
    intakeStarted: false,
    cancelRequested: false,
    deletedAt: null,
    deletionError: null,
  };
}

beforeEach(() => {
  state.connect.mockReset();
  state.addDraft.mockReset();
  state.forget.mockReset();
  useComposerDraftStore.setState({ draftThreadsByThreadKey: {} });
});

it("shows the host's launches in progress, pairs finished ones once, forgets deleted ones", async () => {
  state.environments = [
    host,
    { environmentId: EnvironmentId.make("connected") },
    { environmentId: EnvironmentId.make("gone") },
  ];
  state.submissions = [
    launch("running", "running"),
    launch("failed", "failed"),
    launch("unpaired", "done", "sandbox-a"),
    launch("connected", "done", "connected"),
    { ...launch("deleted", "done", "sandbox-b"), deletedAt: "2026-09-29T00:00:00.000Z" },
    launch("deleted-elsewhere", "done", "gone"),
    { ...launch("saved", "done", "sandbox-c"), savedAt: "2026-09-29T00:00:00.000Z" },
  ];
  const renderer = create(<SandboxLaunchesCoordinator />);
  await act(async () => {});
  expect(state.addDraft.mock.calls.map(([, shown]) => shown.input.commandId)).toEqual([
    "running",
    "failed",
  ]);
  expect(state.connect).toHaveBeenCalledExactlyOnceWith(owner, "unpaired");
  expect(state.forget).not.toHaveBeenCalled();

  // Another client deletes one: the host drops it, and this client forgets it too.
  state.submissions = state.submissions.filter(
    (listed) => (listed as SandboxSubmission).input.commandId !== "deleted-elsewhere",
  );
  await act(async () => renderer.update(<SandboxLaunchesCoordinator />));
  expect(state.forget).toHaveBeenCalledExactlyOnceWith("gone");

  // A connection the user removes isn't paired again until the next load.
  await act(async () => renderer.update(<SandboxLaunchesCoordinator key="again" />));
  expect(state.connect).toHaveBeenCalledOnce();
  await act(async () => renderer.unmount());
});
