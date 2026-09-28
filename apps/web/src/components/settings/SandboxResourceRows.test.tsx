import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthStandardClientScopes,
  EnvironmentId,
  type SandboxSubmission,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

const state = vi.hoisted(() => ({
  environments: [] as unknown[],
  submissions: [] as unknown[],
  deleteSandbox: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.submissions, refresh: () => {} }),
}));
vi.mock("~/state/session", () => ({
  useEnvironmentSessionState: () => ({
    data: { authenticated: true, scopes: ["orchestration:operate"] },
  }),
}));
vi.mock("~/environments/primary", () => ({ usePrimarySessionState: () => ({ data: null }) }));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    sandboxSubmissions: () => null,
    sandboxConfiguration: () => null,
  },
}));
vi.mock("../useSandbox", () => ({
  SANDBOX_PAIRING_SCOPE_MESSAGE: "",
  useConnectSandboxDestination: () => vi.fn(),
  useSandboxCleanup: () => ({ deleteSandbox: state.deleteSandbox }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: state.confirm }));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => children,
  MenuPopup: ({ children }: { children: ReactNode }) => children,
  MenuTrigger: () => null,
  MenuSeparator: () => null,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

import {
  SandboxResourceRows,
  canOperateSandboxResources,
  canPairSandboxDestinations,
  sandboxResourceStatus,
} from "./SandboxResourceRows";

const environment = {
  environmentId: EnvironmentId.make("owner"),
  entry: { target: { _tag: "RemoteConnectionTarget" } },
} as never;

describe("sandbox resource actions", () => {
  it("requires operate scope from the command owner session", () => {
    expect(
      canOperateSandboxResources(environment, { authenticated: true, scopes: [] } as never),
    ).toBe(false);
    expect(
      canOperateSandboxResources(environment, {
        authenticated: true,
        scopes: [AuthOrchestrationOperateScope],
      } as never),
    ).toBe(true);
  });

  it("only offers pairing to sessions that may mint standard client credentials", () => {
    expect(
      canPairSandboxDestinations(environment, {
        authenticated: true,
        scopes: [...AuthStandardClientScopes],
      } as never),
    ).toBe(false);
    expect(
      canPairSandboxDestinations(environment, {
        authenticated: true,
        scopes: [AuthAccessWriteScope, ...AuthStandardClientScopes],
      } as never),
    ).toBe(true);
  });

  it("keeps failed setup and deletion failures actionable in the list", () => {
    const submission = {
      progress: { phase: "failed", error: "clone failed" },
      deletionError: null,
      destination: null,
    } as SandboxSubmission;
    expect(sandboxResourceStatus(submission)).toBe("Setup failed: clone failed");
    expect(sandboxResourceStatus({ ...submission, deletionError: "provider unavailable" })).toBe(
      "Delete failed: provider unavailable",
    );
  });

  it("confirms before deleting a sandbox and keeps a failed deletion visible", async () => {
    const destinationId = EnvironmentId.make("destination");
    const submission = {
      input: {
        commandId: "submission",
        title: "Workspace",
        configurationId: "6e458d05-9c26-4439-9004-f7e0e4ad2a24",
      },
      progress: { phase: "done" },
      intakeStarted: true,
      destination: { environmentId: destinationId },
      deletedAt: null,
      deletionError: null,
    };
    state.submissions = [submission];
    state.environments = [
      {
        environmentId: EnvironmentId.make("owner"),
        entry: { target: { _tag: "BearerConnectionTarget" } },
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities: { sandboxConfiguration: true } } },
      },
      { environmentId: destinationId, connection: { phase: "disconnected" } },
    ];
    state.confirm.mockResolvedValueOnce(false).mockResolvedValue(true);
    state.deleteSandbox.mockResolvedValueOnce("Provider unavailable").mockResolvedValueOnce(null);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SandboxResourceRows onResourcesChange={() => {}} />);
    });
    try {
      expect(
        renderer.root.findAllByType("button").map((button) => button.children.join("")),
      ).toEqual(["Delete sandbox…"]);
      const remove = () => renderer.root.findByType("button").props.onClick();
      await act(async () => {
        remove();
      });
      expect(state.deleteSandbox).not.toHaveBeenCalled();
      await act(async () => {
        remove();
      });
      expect(
        renderer.root
          .findAllByType("span")
          .some((line) => line.children.includes("Provider unavailable")),
      ).toBe(true);
      await act(async () => {
        remove();
      });
      expect(state.deleteSandbox).toHaveBeenCalledTimes(2);
      expect(state.deleteSandbox).toHaveBeenLastCalledWith("owner", "submission");
    } finally {
      await act(async () => {
        renderer.unmount();
      });
    }
  });
});
