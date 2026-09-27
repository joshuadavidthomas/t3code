import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";
import { ProviderInstanceRegistryMutator } from "../Services/ProviderInstanceRegistryMutator.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";
import { makeSettingsHydration } from "./ProviderInstanceRegistryHydration.ts";

describe("settings hydration acknowledgement", () => {
  it.effect("finishes an interrupted replacement without orphaning instance resources", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const active = new Set<string>();
      const closed: string[] = [];
      const driverKind = ProviderDriverKind.make("test");
      const first = ProviderInstanceId.make("first");
      const second = ProviderInstanceId.make("second");
      const driver: ProviderDriver<{ version: string }> = {
        driverKind,
        metadata: { displayName: "Test" },
        configSchema: Schema.Struct({ version: Schema.String }),
        defaultConfig: () => ({ version: "old" }),
        create: ({ instanceId, config }) =>
          Effect.gen(function* () {
            const resource = `${instanceId}:${config.version}`;
            assert.strictEqual(active.has(resource), false);
            active.add(resource);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                active.delete(resource);
                closed.push(resource);
              }),
            );
            if (instanceId === second) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return {
              instanceId,
              driverKind,
              enabled: true,
              displayName: config.version,
              continuationIdentity: { driverKind, continuationKey: resource },
              get adapter(): never {
                throw new Error("Reconciliation must not start sessions.");
              },
              get snapshot(): never {
                throw new Error("Reconciliation must not probe providers.");
              },
              get textGeneration(): never {
                throw new Error("Reconciliation must not generate text.");
              },
            };
          }),
      };
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [driver],
        configMap: { [first]: { driver: driverKind, config: { version: "old" } } },
      }).pipe(Scope.provide(scope));
      let current: ServerSettings = DEFAULT_SERVER_SETTINGS;
      const hydration = yield* makeSettingsHydration.pipe(
        Effect.provide([
          Layer.succeed(ProviderInstanceRegistryMutator, mutator),
          Layer.mock(ServerSettingsService, {
            subscribeChanges: Effect.succeed(Stream.empty),
            updateSettings: () =>
              Effect.sync(() => {
                current = {
                  ...current,
                  providerInstances: {
                    [first]: { driver: driverKind, config: { version: "new" } },
                    [second]: { driver: driverKind, config: { version: "new" } },
                  },
                };
                return current;
              }),
          }),
        ]),
      );
      const updating = yield* hydration.updateSettings({}).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      assert.deepStrictEqual(closed, ["first:old"]);
      assert.deepStrictEqual([...active], ["first:new", "second:new"]);
      updating.interruptUnsafe();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(updating);
      assert.strictEqual((yield* registry.getInstance(first))?.displayName, "new");
      assert.strictEqual((yield* registry.getInstance(second))?.displayName, "new");
      yield* mutator.reconcile({});
      assert.strictEqual(active.size, 0);
      assert.deepStrictEqual(closed, ["first:old", "first:new", "second:new"]);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(closed.length, 3);
    }).pipe(Effect.scoped),
  );

  for (const replacing of [false, true]) {
    it.effect(
      `waits for ${replacing ? "replacement" : "new instance"} reconciliation and does not replay stale settings`,
      () =>
        Effect.gen(function* () {
          const driver = ProviderDriverKind.make("claudeAgent");
          const instanceId = ProviderInstanceId.make("personal");
          const oldEntry = {
            driver,
            environment: [{ name: "TOKEN", value: "old", sensitive: true }],
          };
          const nextEntry = {
            driver,
            environment: [{ name: "TOKEN", value: "new", sensitive: true }],
          };
          let current: ServerSettings = {
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: replacing ? { [instanceId]: oldEntry } : {},
          };
          let applied = current.providerInstances[instanceId];
          const changes = yield* PubSub.unbounded<ServerSettings>();
          const constructing = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const watcherApplied = yield* Deferred.make<void>();
          let reconciliations = 0;
          const hydration = yield* makeSettingsHydration.pipe(
            Effect.provide([
              Layer.mock(ServerSettingsService, {
                getSettings: Effect.sync(() => current),
                subscribeChanges: PubSub.subscribe(changes).pipe(
                  Effect.map(Stream.fromSubscription),
                ),
                updateSettings: () =>
                  Effect.gen(function* () {
                    const stale = current;
                    current = { ...current, providerInstances: { [instanceId]: nextEntry } };
                    yield* PubSub.publish(changes, stale);
                    return current;
                  }),
              }),
              Layer.succeed(ProviderInstanceRegistryMutator, {
                reconcile: (map) =>
                  Effect.gen(function* () {
                    reconciliations++;
                    if (reconciliations === 1) {
                      yield* Deferred.succeed(constructing, undefined);
                      yield* Deferred.await(release);
                    }
                    applied = map[instanceId];
                    if (reconciliations > 1) yield* Deferred.succeed(watcherApplied, undefined);
                  }),
              }),
            ]),
          );
          const completed = yield* Deferred.make<void>();
          const saving = yield* hydration
            .updateSettings({ providerInstances: { [instanceId]: nextEntry } })
            .pipe(
              Effect.tap(() => Deferred.succeed(completed, undefined)),
              Effect.forkScoped,
            );
          yield* Deferred.await(constructing);
          assert.strictEqual(yield* Deferred.isDone(completed), false);
          assert.deepStrictEqual(applied, replacing ? oldEntry : undefined);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(saving);
          assert.deepStrictEqual(applied, nextEntry);
          yield* Deferred.await(watcherApplied);
          assert.deepStrictEqual(applied, nextEntry);
        }).pipe(Effect.scoped),
    );
  }
});
