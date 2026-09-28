import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type SandboxConfiguration,
  type SandboxLaunchOptions,
  type SandboxRuntimeCatalog,
} from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import type { SandboxTarget } from "../../composerDraftStore";

const state = vi.hoisted(() => ({
  environments: [] as Array<unknown>,
  configurationQuery: vi.fn(),
  launchOptionsQuery: vi.fn(),
  saveProviderInstance: vi.fn(),
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    sandboxConfiguration: state.configurationQuery,
    sandboxLaunchOptions: state.launchOptionsQuery,
    saveSandboxProviderInstance: Symbol("saveSandboxProviderInstance"),
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.saveProviderInstance,
}));
vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, isPending: false, error: null }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({
    data: { authenticated: true, scopes: ["orchestration:operate"] },
    isPending: false,
    hasError: false,
  }),
}));

import {
  resolveSandboxProviderEntry,
  sandboxComposerCatalog,
  useSandboxComposer,
} from "./useSandboxComposer";

const ownerId = EnvironmentId.make("owner");
const otherOwnerId = EnvironmentId.make("other-owner");
const personalId = "6e458d05-9c26-4439-9004-f7e0e4ad2a24";
const workId = "a1c25164-2110-4d37-ac31-8303144fa586";

const model = (slug: string, isCustom = false) => ({
  slug,
  name: slug,
  isCustom,
  capabilities: {},
});

const runtime = (id: string, models = [model("alpha"), model("beta")]) =>
  ({
    id,
    orchestrationProtocol: 1,
    intakeVersion: 1,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        version: "1.0.0",
        showInteractionModeToggle: false,
        models,
      },
    ],
  }) satisfies SandboxRuntimeCatalog;

const configuration = (
  id: string,
  name: string,
  revision: number,
  overrides: Partial<SandboxConfiguration> = {},
): SandboxConfiguration => ({
  id,
  provider: "sprites",
  name,
  revision,
  credentialConfigured: true,
  gitHubCredentialConfigured: false,
  namePrefix: "",
  verifiedAt: null,
  providerInstances: {
    [ProviderInstanceId.make("codex")]: { driver: ProviderDriverKind.make("codex") },
  },
  providerModelPreferences: {},
  ...overrides,
});

const connectedEnvironment = (environmentId: EnvironmentId) => ({
  environmentId,
  entry: { target: { _tag: "RemoteConnectionTarget" } },
  connection: { phase: "connected" },
  serverConfig: { environment: { capabilities: { sandboxConfiguration: true } } },
});

describe("sandboxComposerCatalog", () => {
  it("intersects enabled account providers with the runtime and applies account model preferences", () => {
    const codexId = ProviderInstanceId.make("codex_personal");
    const catalog = sandboxComposerCatalog(
      configuration(personalId, "Personal", 1, {
        providerInstances: {
          [codexId]: { driver: ProviderDriverKind.make("codex"), displayName: "Personal Codex" },
          [ProviderInstanceId.make("codex_disabled")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
          },
          [ProviderInstanceId.make("ollama")]: { driver: ProviderDriverKind.make("ollama") },
        },
        providerModelPreferences: {
          [codexId]: {
            hiddenModels: ["hidden"],
            modelOrder: ["second", "first"],
            favoriteModels: [],
          },
        },
      }),
      runtime("runtime", [model("first"), model("hidden"), model("second")]),
    );

    expect(catalog.map((entry) => entry.instanceId)).toEqual([codexId]);
    expect(catalog[0]?.displayName).toBe("Personal Codex");
    expect(catalog[0]?.showInteractionModeToggle).toBe(false);
    expect(catalog[0]?.models.map((entry) => entry.slug)).toEqual(["second", "first"]);
    expect(catalog.some((entry) => entry.driverKind === "ollama")).toBe(false);
  });
});

describe("resolveSandboxProviderEntry", () => {
  const entry = (id: string, driver: string, isDefault: boolean) => ({
    source: "runtime" as const,
    instanceId: ProviderInstanceId.make(id),
    driverKind: ProviderDriverKind.make(driver),
    displayName: id,
    isDefault,
    showInteractionModeToggle: driver === "codex",
    models: [{ slug: `${id}-model`, name: id, isCustom: false, capabilities: null }],
  });
  const catalog = [entry("claudeAgent", "claudeAgent", true), entry("codex", "codex", true)];

  it("falls back to the catalog default when the draft's instance isn't in the sandbox", () => {
    expect(
      resolveSandboxProviderEntry(catalog, ProviderInstanceId.make("host_only"), null)?.instanceId,
    ).toBe("claudeAgent");
    expect(
      resolveSandboxProviderEntry(catalog, ProviderInstanceId.make("codex"), null)?.instanceId,
    ).toBe("codex");
    expect(
      resolveSandboxProviderEntry(catalog, null, ProviderDriverKind.make("codex"))?.instanceId,
    ).toBe("codex");
  });
});

describe("useSandboxComposer", () => {
  it("keeps same-owner accounts isolated when the old account resolves after switching", async () => {
    const instanceId = ProviderInstanceId.make("codex");
    const personal = configuration(personalId, "Personal", 3, {
      providerModelPreferences: {
        [instanceId]: {
          hiddenModels: ["hidden"],
          modelOrder: ["beta", "alpha"],
          favoriteModels: ["alpha"],
        },
      },
    });
    const work = configuration(workId, "Work", 8);
    let resolveSave!: (value: { _tag: "Success"; value: SandboxConfiguration }) => void;
    const pendingSave = new Promise<{ _tag: "Success"; value: SandboxConfiguration }>((resolve) => {
      resolveSave = resolve;
    });
    state.saveProviderInstance.mockReset();
    state.saveProviderInstance.mockReturnValueOnce(pendingSave);
    state.saveProviderInstance.mockResolvedValue({ _tag: "Success", value: work });
    const configurations = Atom.family((_id: EnvironmentId) =>
      Atom.make<AsyncResult.AsyncResult<readonly SandboxConfiguration[]>>(AsyncResult.initial()),
    );
    const launches = new Map(
      [personalId, workId].map((id) => [
        id,
        Atom.make<AsyncResult.AsyncResult<SandboxLaunchOptions>>(AsyncResult.initial()),
      ]),
    );
    state.environments = [connectedEnvironment(ownerId)];
    state.configurationQuery.mockImplementation(
      ({ environmentId }: { environmentId: EnvironmentId }) => configurations(environmentId),
    );
    state.launchOptionsQuery.mockImplementation(
      ({ input }: { input: { configurationId: string } }) => launches.get(input.configurationId)!,
    );
    const registry = AtomRegistry.make();
    let value!: ReturnType<typeof useSandboxComposer>;
    const target = (configurationId: string): SandboxTarget => ({
      ownerEnvironmentId: ownerId,
      configurationId,
    });
    function Probe({ selected }: { selected: SandboxTarget }) {
      const result = useSandboxComposer(selected, true);
      useLayoutEffect(() => {
        value = result;
      });
      return null;
    }
    const render = (selected: SandboxTarget) => (
      <RegistryContext.Provider value={registry}>
        <Probe selected={selected} />
      </RegistryContext.Provider>
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(render(target(personalId)));
      registry.set(configurations(ownerId), AsyncResult.success([personal, work]));
    });
    try {
      expect(value.registrations.map((entry) => entry.configurationId)).toEqual([
        personalId,
        workId,
      ]);
      expect(value.registrations.map((entry) => [entry.label, entry.providerLabel])).toEqual([
        ["Personal", "Sprites"],
        ["Work", "Sprites"],
      ]);
      expect(value.favoriteModels.get(instanceId)).toEqual(["alpha"]);
      const personalSave = value.updateFavoriteModels(instanceId, ["beta"]);
      await act(async () => renderer.update(render(target(workId))));
      await act(async () => {
        await value.updateFavoriteModels(instanceId, ["work-model"]);
      });
      expect(state.saveProviderInstance.mock.calls.map(([request]) => request)).toEqual([
        {
          environmentId: ownerId,
          input: {
            id: personalId,
            expectedRevision: 3,
            instanceId,
            instance: personal.providerInstances[instanceId],
            modelPreferences: {
              hiddenModels: ["hidden"],
              modelOrder: ["beta", "alpha"],
              favoriteModels: ["beta"],
            },
          },
        },
        {
          environmentId: ownerId,
          input: {
            id: workId,
            expectedRevision: 8,
            instanceId,
            instance: work.providerInstances[instanceId],
            modelPreferences: { hiddenModels: [], modelOrder: [], favoriteModels: ["work-model"] },
          },
        },
      ]);
      await act(async () => {
        resolveSave({ _tag: "Success", value: { ...personal, revision: 4 } });
        await personalSave;
      });
      expect(value.favoriteModels.get(instanceId)).toBeUndefined();
      await act(async () => {
        registry.set(
          launches.get(personalId)!,
          AsyncResult.success({
            configurationRevision: 3,
            runtime: runtime("personal-runtime", [model("personal-model")]),
            reason: null,
          }),
        );
      });
      expect(value.catalog).toEqual([]);
      expect(value.runtimeId).toBeNull();
      await act(async () => {
        registry.set(
          launches.get(workId)!,
          AsyncResult.success({
            configurationRevision: 8,
            runtime: runtime("work-runtime", [model("work-model")]),
            reason: null,
          }),
        );
      });
      expect(value.catalog[0]?.models.map((entry) => entry.slug)).toEqual(["work-model"]);
      expect(value.runtimeId).toBe("work-runtime");
    } finally {
      await act(async () => renderer.unmount());
      registry.dispose();
    }
  });

  it("hides mismatched revisions, reports a missing runtime, and clears removed accounts", async () => {
    const account = configuration(personalId, "Personal", 4);
    const configurations = Atom.family((_id: EnvironmentId) =>
      Atom.make<AsyncResult.AsyncResult<readonly SandboxConfiguration[]>>(AsyncResult.initial()),
    );
    const launch = Atom.make<AsyncResult.AsyncResult<SandboxLaunchOptions>>(AsyncResult.initial());
    state.environments = [connectedEnvironment(ownerId), connectedEnvironment(otherOwnerId)];
    state.configurationQuery.mockImplementation(
      ({ environmentId }: { environmentId: EnvironmentId }) => configurations(environmentId),
    );
    state.launchOptionsQuery.mockReturnValue(launch);
    const registry = AtomRegistry.make();
    let value!: ReturnType<typeof useSandboxComposer>;
    function Probe() {
      const result = useSandboxComposer(
        { ownerEnvironmentId: ownerId, configurationId: personalId },
        true,
      );
      useLayoutEffect(() => {
        value = result;
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <RegistryContext.Provider value={registry}>
          <Probe />
        </RegistryContext.Provider>,
      );
      registry.set(configurations(ownerId), AsyncResult.success([account]));
      registry.set(
        configurations(otherOwnerId),
        AsyncResult.success([configuration(workId, "Other owner", 1)]),
      );
    });
    try {
      await act(async () => {
        registry.set(
          launch,
          AsyncResult.success({
            configurationRevision: 3,
            runtime: runtime("stale"),
            reason: null,
          }),
        );
      });
      expect(value.catalog).toEqual([]);
      expect(value.reason).toBe("Sandbox models loading");
      await act(async () => {
        registry.set(
          launch,
          AsyncResult.success({ configurationRevision: 4, runtime: null, reason: null }),
        );
      });
      expect(value.reason).toBe("Sandboxes unavailable");
      // Nothing in Settings fixes a server that cannot launch sandboxes, so no settings link.
      expect(value.reasonFix).toBeNull();
      await act(async () => {
        registry.set(configurations(ownerId), AsyncResult.success([]));
      });
      expect(value.catalog).toEqual([]);
      expect(value.reason).toBe("Sandbox account unavailable");
      expect(value.registrations.map((entry) => entry.configurationId)).toEqual([workId]);
    } finally {
      await act(async () => renderer.unmount());
      registry.dispose();
    }
  });
});
