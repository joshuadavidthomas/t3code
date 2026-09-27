import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type SandboxSubmission,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

const state = vi.hoisted(() => ({
  environments: [] as unknown[],
  submissions: [] as unknown[],
  remove: vi.fn(),
  enable: vi.fn(),
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
  serverEnvironment: { sandboxSubmissions: () => null, deleteSandboxSubmission: "remove" },
}));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: { setEnabled: "enable" } }));
vi.mock("~/connection/onboarding", () => ({
  connectPairing: "connect",
  awaitEnvironmentConnection: "await",
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "remove" ? state.remove : command === "enable" ? state.enable : vi.fn(),
}));
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

  it("keeps registered destinations on ordinary connection controls and confirms cleanup before disabling them", async () => {
    const destinationId = EnvironmentId.make("destination");
    const submission = {
      input: { commandId: "submission", title: "Workspace" },
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
    state.remove.mockReset();
    state.enable.mockReset();
    state.confirm.mockResolvedValueOnce(false).mockResolvedValue(true);
    state.remove
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { ...submission, deletionError: "Provider unavailable" },
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { ...submission, deletedAt: "2026-09-27T00:00:00.000Z" },
      });
    state.enable.mockResolvedValue({ _tag: "Success" });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SandboxResourceRows onResourcesChange={() => {}} />);
    });
    try {
      expect(
        renderer.root.findAllByType("button").map((button) => button.children.join("")),
      ).toEqual(["Delete sandbox"]);
      const remove = () => renderer.root.findByType("button").props.onClick();
      await act(async () => {
        remove();
      });
      expect(state.remove).not.toHaveBeenCalled();
      await act(async () => {
        remove();
      });
      expect(state.enable).not.toHaveBeenCalled();
      expect(
        renderer.root
          .findAllByType("p")
          .some((line) => line.children.includes("Provider unavailable")),
      ).toBe(true);
      await act(async () => {
        remove();
      });
      expect(state.remove).toHaveBeenCalledTimes(2);
      expect(state.enable).toHaveBeenCalledExactlyOnceWith({
        environmentId: destinationId,
        enabled: false,
      });
    } finally {
      await act(async () => {
        renderer.unmount();
      });
    }
  });
});
