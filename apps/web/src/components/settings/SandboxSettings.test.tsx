import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentId, type SandboxConfiguration } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ phase: "connected", query: vi.fn() }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.phase } }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { sandboxConfiguration: state.query },
}));

import { useSandboxConfiguration } from "./SandboxSettings";

it("shares query updates between settings consumers without leaking another owner's registration", async () => {
  const first = EnvironmentId.make("first");
  const second = EnvironmentId.make("second");
  const configuration: SandboxConfiguration = {
    id: "6e458d05-9c26-4439-9004-f7e0e4ad2a24",
    provider: "sprites",
    name: "Personal",
    revision: 4,
    credentialConfigured: true,
    namePrefix: "",
    verifiedAt: null,
    providerInstances: {},
    providerModelPreferences: {},
  };
  const workConfiguration: SandboxConfiguration = {
    ...configuration,
    id: "a1c25164-2110-4d37-ac31-8303144fa586",
    name: "Work",
  };
  const configurations = [configuration, workConfiguration];
  const queries = Atom.family((_id: EnvironmentId) =>
    Atom.make<AsyncResult.AsyncResult<readonly SandboxConfiguration[]>>(AsyncResult.initial()),
  );
  state.query.mockImplementation(({ environmentId }: { environmentId: EnvironmentId }) =>
    queries(environmentId),
  );
  const registry = AtomRegistry.make();
  const values = new Map<string, ReturnType<typeof useSandboxConfiguration>>();
  function Probe({ id, consumer }: { id: EnvironmentId; consumer: string }) {
    const result = useSandboxConfiguration(id, true);
    useLayoutEffect(() => {
      values.set(consumer, result);
    });
    return null;
  }
  const render = (id: EnvironmentId) => (
    <RegistryContext.Provider value={registry}>
      <Probe id={first} consumer="connections" />
      <Probe id={id} consumer="providers" />
    </RegistryContext.Provider>
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(render(first));
  });
  try {
    expect(values.get("providers")?.loading).toBe(true);
    await act(async () => {
      registry.set(queries(first), AsyncResult.success(configurations));
    });
    expect(values.get("connections")?.configurations).toEqual(configurations);
    expect(values.get("providers")?.configurations).toEqual(configurations);
    await act(async () => {
      registry.set(queries(first), AsyncResult.success(configurations, { waiting: true }));
    });
    expect(values.get("providers")?.loading).toBe(false);
    expect(values.get("providers")?.configurations).toEqual(configurations);
    await act(async () => {
      renderer.update(render(second));
    });
    expect(values.get("providers")?.configurations).toEqual([]);
    expect(values.get("providers")?.loading).toBe(true);
    await act(async () => {
      registry.set(queries(first), AsyncResult.success([]));
    });
    expect(values.get("connections")?.configurations).toEqual([]);
    expect(values.get("connections")?.loading).toBe(false);
  } finally {
    await act(async () => {
      renderer.unmount();
    });
    registry.dispose();
  }
});
