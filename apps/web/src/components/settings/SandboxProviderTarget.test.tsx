import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type SandboxConfiguration,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  save: vi.fn(),
  reload: vi.fn(),
  launchOptions: undefined as { runtime: { providers: { driver: string }[] } | null } | undefined,
  primarySession: { authenticated: true, scopes: ["orchestration:operate"] } as {
    authenticated: boolean;
    scopes?: readonly string[];
  },
}));

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({
    data: state.primarySession,
    error: null,
    isPending: false,
  }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({
    data: { authenticated: true, scopes: [AuthOrchestrationOperateScope] },
    hasError: false,
    isPending: false,
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    saveSandboxProviderInstance: Symbol("saveSandboxProviderInstance"),
    sandboxLaunchOptions: () => Symbol("sandboxLaunchOptions"),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.launchOptions }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (response: { cause?: unknown }) => response.cause,
}));
vi.mock("./ProviderInstanceCard", () => ({
  ProviderInstanceCard: (props: Record<string, unknown>) => <div data-provider-card {...props} />,
}));
vi.mock("./ProviderSettingsPanel", () => ({
  ProviderSettingsEditorLayout: ({ list, editor }: { list: ReactNode; editor: ReactNode }) => (
    <div>
      {list}
      {editor}
    </div>
  ),
  ProviderSettingsPlaceholder: () => null,
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("./SandboxSettings", () => ({ useSandboxConfiguration: vi.fn() }));
vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
vi.mock("./SettingsScopeContext", () => ({ useOptionalSettingsScope: () => null }));
vi.mock("./settingsScopeAxis", () => ({ settingsScopeEnvironmentLabel: () => "Environment" }));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

import { SandboxProviders } from "./SandboxProviderTarget";

const ownerId = EnvironmentId.make("owner");
const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");
const environment = {
  environmentId: ownerId,
  entry: { target: { _tag: "PrimaryConnectionTarget" } },
} as never;

function configuration(
  revision: number,
  providerInstances: Record<string, ProviderInstanceConfig> = {},
): SandboxConfiguration {
  return {
    id: "6e458d05-9c26-4439-9004-f7e0e4ad2a24",
    provider: "sprites",
    name: "Personal",
    revision,
    credentialConfigured: true,
    namePrefix: "",
    verifiedAt: null,
    providerInstances,
    providerModelPreferences: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function success(value: SandboxConfiguration) {
  return { _tag: "Success" as const, value };
}

function render(config: SandboxConfiguration, key = config.id) {
  return (
    <SandboxProviders
      key={key}
      environment={environment}
      configuration={config}
      reload={state.reload}
    />
  );
}

function card(renderer: ReactTestRenderer, id = codexId, mode = "editor") {
  return renderer.root
    .findAllByProps({ "data-provider-card": true })
    .find((node) => node.props.instanceId === id && node.props.mode === mode)!;
}

describe("SandboxProviders", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    state.save.mockReset();
    state.reload.mockReset();
    state.launchOptions = undefined;
    state.primarySession = { authenticated: true, scopes: [AuthOrchestrationOperateScope] };
  });

  afterEach(async () => {
    if (!renderer) return;
    await act(async () => renderer?.unmount());
    renderer = undefined;
  });

  it("serializes rapid edits, preserves the earlier change, and advances CAS revisions", async () => {
    const first = deferred<ReturnType<typeof success>>();
    const second = deferred<ReturnType<typeof success>>();
    state.save.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await act(async () => {
      renderer = create(render(configuration(4)));
    });

    await act(async () => {
      card(renderer!).props.onUpdate({
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { binaryPath: "/sandbox/codex" },
      });
      card(renderer!).props.onFavoriteModelsChange(["o3"]);
    });
    expect(state.save).toHaveBeenCalledTimes(1);
    expect(state.save.mock.calls[0]![0].input.expectedRevision).toBe(4);

    await act(async () => {
      first.resolve(
        success(
          configuration(5, {
            [codexId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: { binaryPath: "/sandbox/codex" },
            },
          }),
        ),
      );
      await first.promise;
    });
    expect(state.save).toHaveBeenCalledTimes(2);
    expect(state.save.mock.calls[1]![0].input).toMatchObject({
      expectedRevision: 5,
      instance: { enabled: true, config: { binaryPath: "/sandbox/codex" } },
      modelPreferences: { favoriteModels: ["o3"] },
    });
    await act(async () => {
      second.resolve(success(configuration(6)));
      await second.promise;
    });
  });

  it("replaces a raw credential draft with the sanitized server response", async () => {
    const saved = deferred<ReturnType<typeof success>>();
    state.save.mockReturnValue(saved.promise);
    await act(async () => {
      renderer = create(render(configuration(1)));
    });
    await act(async () => {
      card(renderer!).props.onUpdate({
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { apiKey: "raw-secret" },
      });
    });
    expect(card(renderer!).props.instance.config.apiKey).toBe("raw-secret");
    await act(async () => {
      saved.resolve(
        success(
          configuration(2, {
            [codexId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: { apiKey: "saved-secret" },
            },
          }),
        ),
      );
      await saved.promise;
    });
    expect(card(renderer!).props.instance.config.apiKey).toBe("saved-secret");
  });

  it("keeps a failed draft and blocks editing until explicit Reload", async () => {
    const failed = deferred<{ _tag: "Failure"; cause: Error }>();
    state.save.mockReturnValue(failed.promise);
    await act(async () => {
      renderer = create(render(configuration(3)));
    });
    await act(async () => {
      card(renderer!).props.onUpdate({ driver: ProviderDriverKind.make("codex"), enabled: true });
      card(renderer!).props.onFavoriteModelsChange(["queued"]);
      failed.resolve({ _tag: "Failure", cause: new Error("revision conflict") });
      await failed.promise;
    });
    expect(state.save).toHaveBeenCalledTimes(1);
    expect(card(renderer!).props.instance.enabled).toBe(true);
    expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual(["revision conflict"]);
    expect.soft(card(renderer!).props.readOnly).toBe(true);
    expect.soft(state.reload).not.toHaveBeenCalled();

    await act(async () => renderer!.root.findByType("button").props.onClick());
    expect(state.reload).toHaveBeenCalledOnce();
    expect(card(renderer!).props.instance.enabled).toBe(false);
  });

  it("syncs a newer idle configuration and uses its revision for the next edit", async () => {
    state.save.mockResolvedValue(success(configuration(10)));
    await act(async () => {
      renderer = create(render(configuration(7)));
      renderer.update(
        render(
          configuration(9, {
            [codexId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
          }),
        ),
      );
    });
    expect(card(renderer!).props.instance.enabled).toBe(true);
    await act(async () => card(renderer!).props.onFavoriteModelsChange(["new"]));
    expect(state.save.mock.calls[0]![0].input.expectedRevision).toBe(9);
  });

  it("does not send an old keyed account's queued edit to the new account", async () => {
    const oldSave = deferred<ReturnType<typeof success>>();
    state.save.mockReturnValueOnce(oldSave.promise).mockResolvedValue(success(configuration(2)));
    await act(async () => {
      renderer = create(render(configuration(1), "first-account"));
    });
    await act(async () => {
      card(renderer!).props.onUpdate({ driver: ProviderDriverKind.make("codex"), enabled: true });
    });
    await act(async () => {
      renderer!.update(
        render(
          { ...configuration(8), id: "a1c25164-2110-4d37-ac31-8303144fa586" },
          "second-account",
        ),
      );
    });
    await act(async () => {
      card(renderer!, claudeId, "list").props.onFavoriteModelsChange(["sonnet"]);
    });
    expect(state.save.mock.calls[0]![0].input.id).toBe("6e458d05-9c26-4439-9004-f7e0e4ad2a24");
    expect(state.save.mock.calls[1]![0].input).toMatchObject({
      id: "a1c25164-2110-4d37-ac31-8303144fa586",
      instanceId: claudeId,
      expectedRevision: 8,
    });
    await act(async () => {
      oldSave.resolve(success(configuration(2)));
      await oldSave.promise;
    });
  });

  it("offers only drivers the sandbox runtime supports once it is known", async () => {
    await act(async () => {
      renderer = create(render(configuration(1)));
    });
    const listed = () =>
      renderer!.root
        .findAllByProps({ "data-provider-card": true })
        .filter((node) => node.props.mode === "list")
        .map((node) => node.props.instanceId);
    expect(listed()).toContain(codexId);

    state.launchOptions = { runtime: { providers: [{ driver: "claudeAgent" }] } };
    await act(async () => {
      renderer!.update(render(configuration(1)));
    });
    expect(listed()).toEqual([claudeId]);
    expect(card(renderer!, claudeId).props.selected).toBe(true);
  });

  it("never mutates settings when operate access is read only", async () => {
    state.primarySession = { authenticated: false };
    await act(async () => {
      renderer = create(
        <SandboxProviders
          environment={environment}
          configuration={configuration(1)}
          reload={state.reload}
        />,
      );
    });
    expect(card(renderer!).props.readOnly).toBe(true);
    await act(async () => {
      card(renderer!).props.onUpdate({ driver: ProviderDriverKind.make("codex"), enabled: true });
      card(renderer!).props.onFavoriteModelsChange(["blocked"]);
    });
    expect(state.save).not.toHaveBeenCalled();
  });
});
