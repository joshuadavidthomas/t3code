import {
  CommandId,
  EnvironmentId,
  SandboxSubmissionError,
  WS_METHODS,
  type SandboxConfiguration,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const environmentId = EnvironmentId.make("sandbox-owner");
const connected: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};
const configuration: SandboxConfiguration = {
  id: "6e458d05-9c26-4439-9004-f7e0e4ad2a24",
  provider: "sprites",
  name: "Personal",
  revision: 1,
  credentialConfigured: true,
  gitHubCredentialConfigured: false,
  namePrefix: "",
  verifiedAt: null,
  providerInstances: {},
  providerModelPreferences: {},
};
const workConfiguration: SandboxConfiguration = {
  ...configuration,
  id: "901814a2-4b69-4c90-9885-a4a604adfa49",
  name: "Work",
  revision: 4,
};

const makeHarness = Effect.fn("sandboxQueryHarness")(function* () {
  const reads = yield* Queue.unbounded<void>();
  const subscriptionReads = yield* Queue.unbounded<void>();
  let readCount = 0;
  let current: ReadonlyArray<SandboxConfiguration> = [configuration, workConfiguration];
  let accepted = false;
  const submission = { progress: { sequence: 1, phase: "running" } };
  const readSubmission = Effect.suspend(() =>
    accepted
      ? Effect.succeed(submission)
      : Effect.fail(new SandboxSubmissionError({ code: "invalid", message: "Not accepted yet" })),
  );
  const client = {
    [WS_METHODS.sandboxListSubmissions]: () => Effect.succeed([]),
    [WS_METHODS.sandboxGetSubmission]: () => readSubmission,
    [WS_METHODS.sandboxSubscribeSubmission]: () =>
      Stream.fromEffect(
        Queue.offer(subscriptionReads, undefined).pipe(Effect.andThen(readSubmission)),
      ),
    [WS_METHODS.sandboxSubmit]: () =>
      Effect.sync(() => {
        accepted = true;
        return submission;
      }),
    [WS_METHODS.sandboxGetConfiguration]: () =>
      Effect.sync(() => {
        readCount++;
        return current;
      }).pipe(Effect.tap(() => Queue.offer(reads, undefined))),
    [WS_METHODS.sandboxSaveConfiguration]: () =>
      Effect.sync(() => {
        const saved = { ...configuration, revision: 2 };
        current = [saved, workConfiguration];
        return saved;
      }),
    [WS_METHODS.sandboxVerifyConfiguration]: () =>
      Effect.sync(() => {
        current = [{ ...configuration, revision: 3 }, workConfiguration];
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId,
              message: "Verification failed after updating persisted status",
            }),
          ),
        ),
      ),
    [WS_METHODS.sandboxRemoveConfiguration]: () =>
      Effect.sync(() => {
        current = [workConfiguration];
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const state = yield* SubscriptionRef.make(connected);
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Owner",
      httpBaseUrl: "https://owner.test",
      wsBaseUrl: "wss://owner.test",
    }),
    state,
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
    Stream.provideService(stream, EnvironmentSupervisor, supervisor);
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(
        EnvironmentRegistry,
        EnvironmentRegistry.of({ run, followStream } as EnvironmentRegistry["Service"]),
      ),
      Layer.succeed(EnvironmentCacheStore, {} as EnvironmentCacheStore["Service"]),
    ),
  );
  const atoms = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => Atom.make(null),
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const target = { environmentId, input: {} };
  const atom = atoms.sandboxConfiguration(target);
  return {
    atoms,
    atom,
    registry,
    state,
    reads,
    subscriptionReads,
    target,
    readCount: () => readCount,
  };
});

it.effect("restarts submission reads that raced durable acceptance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const target = { environmentId, input: { commandId: CommandId.make("sandbox:race") } };
      const query = h.atoms.getSandboxSubmission(target);
      const stream = h.atoms.sandboxSubmission(target);
      h.registry.mount(query);
      h.registry.mount(stream);
      yield* Effect.flip(AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true }));
      yield* Queue.take(h.subscriptionReads);
      const result = yield* Effect.promise(() =>
        h.atoms.submitSandbox.run(h.registry, target as never),
      );
      expect(result._tag).toBe("Success");
      expect(yield* AtomRegistry.getResult(h.registry, query)).toMatchObject({
        progress: { sequence: 1, phase: "running" },
      });
      expect(yield* AtomRegistry.getResult(h.registry, stream)).toMatchObject({
        progress: { sequence: 1, phase: "running" },
      });
    }),
  ),
);

it.effect(
  "shares a loaded registration across subscribers and remounts, then refreshes on reconnect",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const unmount = h.registry.mount(h.atom);
        expect(
          yield* AtomRegistry.getResult(h.registry, h.atom, { suspendOnWaiting: true }),
        ).toEqual([configuration, workConfiguration]);
        yield* Queue.take(h.reads);
        const second = h.atoms.sandboxConfiguration({ environmentId, input: {} });
        expect(second).toBe(h.atom);
        const unmountSecond = h.registry.mount(second);
        unmount();
        unmountSecond();
        const remount = h.registry.mount(second);
        expect(
          yield* AtomRegistry.getResult(h.registry, second, { suspendOnWaiting: true }),
        ).toEqual([configuration, workConfiguration]);
        expect(h.readCount()).toBe(1);
        yield* SubscriptionRef.set(h.state, {
          ...connected,
          phase: "connecting",
          stage: "opening",
        });
        yield* Effect.yieldNow;
        expect(Option.getOrNull(AsyncResult.value(h.registry.get(h.atom)))).toEqual([
          configuration,
          workConfiguration,
        ]);
        yield* SubscriptionRef.set(h.state, { ...connected, generation: 2 });
        yield* Queue.take(h.reads);
        expect(
          yield* AtomRegistry.getResult(h.registry, h.atom, { suspendOnWaiting: true }),
        ).toEqual([configuration, workConfiguration]);
        expect(h.readCount()).toBe(2);
        remount();
      }),
    ),
);

it.effect("refreshes the affected owner's cache after save, failed verify, and removal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const other = h.atoms.sandboxConfiguration({
        environmentId: EnvironmentId.make("other-owner"),
        input: {},
      });
      h.registry.mount(h.atom);
      h.registry.mount(other);
      yield* AtomRegistry.getResult(h.registry, h.atom, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(h.registry, other, { suspendOnWaiting: true });
      yield* Queue.take(h.reads);
      yield* Queue.take(h.reads);
      for (const [command, revision, expected] of [
        [
          h.atoms.saveSandboxConfiguration,
          1,
          [{ ...configuration, revision: 2 }, workConfiguration],
        ],
        [
          h.atoms.verifySandboxConfiguration,
          2,
          [{ ...configuration, revision: 3 }, workConfiguration],
        ],
        [h.atoms.removeSandboxConfiguration, 3, [workConfiguration]],
      ] as const) {
        const result = yield* Effect.promise(async () =>
          command.run(h.registry, {
            environmentId,
            input:
              command === h.atoms.saveSandboxConfiguration
                ? {
                    id: configuration.id,
                    provider: "sprites" as const,
                    name: configuration.name,
                    expectedRevision: revision,
                  }
                : { id: configuration.id, expectedRevision: revision },
          } as never),
        );
        expect(result._tag === "Failure").toBe(revision === 2);
        yield* Queue.take(h.reads);
        expect(
          yield* AtomRegistry.getResult(h.registry, h.atom, { suspendOnWaiting: true }),
        ).toEqual(expected);
        expect(
          yield* AtomRegistry.getResult(h.registry, other, { suspendOnWaiting: true }),
        ).toEqual([configuration, workConfiguration]);
      }
      expect(h.readCount()).toBe(5);
    }),
  ),
);
