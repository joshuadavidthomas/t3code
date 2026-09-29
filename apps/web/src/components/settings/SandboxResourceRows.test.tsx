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
  accounts: [] as unknown[],
  deleteSandbox: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: string) => ({
    data: atom === "accounts" ? state.accounts : state.submissions,
    error: null,
    isSuccess: true,
    refresh: () => {},
  }),
}));
vi.mock("~/state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: { setEnabled: "enable" } }));
vi.mock("./SandboxSettings", () => ({
  SandboxRegistrationRow: ({
    configuration,
    sandboxes,
  }: {
    configuration: { name: string };
    sandboxes: { summary: string } | null;
  }) => <p>{`${configuration.name}: ${sandboxes?.summary ?? "none"}`}</p>,
  SandboxFoldButton: () => null,
  EditSandboxConfigurationDialog: () => null,
}));
vi.mock("../ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => children,
  CollapsiblePanel: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./settingsLayout", () => ({ SettingsRow: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: () => null,
  TooltipTrigger: () => null,
  TooltipPopup: () => null,
}));
vi.mock("~/state/session", () => ({
  useEnvironmentSessionState: () => ({
    data: { authenticated: true, scopes: ["orchestration:operate"] },
  }),
}));
vi.mock("~/environments/primary", () => ({ usePrimarySessionState: () => ({ data: null }) }));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    sandboxSubmissions: () => "list",
    sandboxConfiguration: () => "accounts",
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
  SandboxAccounts,
  canOperateSandboxResources,
  canPairSandboxDestinations,
  sandboxBadge,
  sandboxResourceStatus,
  sortSandboxEntries,
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
      {
        environmentId: destinationId,
        entry: { enabled: true },
        connection: { phase: "available" },
      },
    ];
    state.confirm.mockResolvedValueOnce(false).mockResolvedValue(true);
    state.deleteSandbox.mockResolvedValueOnce("Provider unavailable").mockResolvedValueOnce(null);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SandboxAccounts onPresenceChange={() => {}} />);
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

  it("reads a running sandbox's state from its threads, as the sidebar shows them", () => {
    const done = {
      progress: { phase: "done" },
      destination: {},
      cancelRequested: false,
    } as SandboxSubmission;
    expect(sandboxBadge(done, null)).toBeNull();
    expect(sandboxBadge(done, [])).toBeNull();
    expect(
      sandboxBadge(done, [{ settledOverride: "settled" }, { settledOverride: null }])?.label,
    ).toBe("Active");
    expect(sandboxBadge(done, [{ settledOverride: "settled" }])?.label).toBe("Settled");
    expect(sandboxBadge({ ...done, savedAt: "2026-09-29T00:00:00.000Z" }, null)?.label).toBe(
      "Archived",
    );
    expect(
      sandboxBadge({ ...done, progress: { phase: "running" } } as SandboxSubmission, null)?.label,
    ).toBe("Setting up");
  });

  it("lists each sandbox under the account that made it, and keeps a removed account's", async () => {
    const sandbox = (id: string, configurationId: string, startedAt: string) => ({
      input: { commandId: id, title: id, configurationId },
      progress: { phase: "failed", error: null, startedAt, endedAt: null },
      intakeStarted: true,
      destination: null,
      deletedAt: null,
      deletionError: null,
    });
    state.accounts = [
      { id: "personal", name: "Personal" },
      { id: "work", name: "Work" },
    ];
    state.submissions = [
      sandbox("three", "personal", "2026-09-28T00:00:00Z"),
      sandbox("two", "work", "2026-09-28T00:00:00Z"),
      sandbox("one", "personal", "2026-09-29T00:00:00Z"),
      sandbox("four", "gone", "2026-09-28T00:00:00Z"),
    ];
    state.environments = [
      {
        environmentId: EnvironmentId.make("owner"),
        entry: { target: { _tag: "BearerConnectionTarget" } },
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities: { sandboxConfiguration: true } } },
      },
    ];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SandboxAccounts onPresenceChange={() => {}} />);
    });
    const text = (node: ReactTestRenderer["root"]): string =>
      node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
    const lines = renderer.root
      .findAll((node) => node.type === "p" && node.parent?.type !== "p")
      .map(text);
    expect(lines).toEqual([
      "Personal: 2 sandboxes",
      "oneFailed",
      "threeFailed",
      "Work: 1 sandbox",
      "twoFailed",
      "From removed accounts",
      "fourFailed",
    ]);
    await act(async () => renderer.unmount());
  });

  it("sorts active sandboxes first, then settled, each most recently active first", () => {
    const entry = (id: string, label: string | null, lastActiveAt: string) => ({
      id,
      badge: label ? { label, variant: "info" as const } : null,
      lastActiveAt,
    });
    expect(
      sortSandboxEntries([
        entry("archived", "Archived", "2026-09-29T05:00:00Z"),
        entry("settled-old", "Settled", "2026-09-20T00:00:00Z"),
        entry("unknown", null, "2026-09-29T04:00:00Z"),
        entry("active-old", "Active", "2026-09-21T00:00:00Z"),
        entry("settled-new", "Settled", "2026-09-28T00:00:00Z"),
        entry("setting-up", "Setting up", "2026-09-29T03:00:00Z"),
        entry("active-new", "Active", "2026-09-29T01:00:00Z"),
      ]).map(({ id }) => id),
    ).toEqual([
      "setting-up",
      "active-new",
      "active-old",
      "settled-new",
      "settled-old",
      "unknown",
      "archived",
    ]);
  });
});
