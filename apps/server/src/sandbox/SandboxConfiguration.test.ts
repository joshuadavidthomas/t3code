import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import {
  ProviderDriverKind,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import { makeSandboxConfiguration } from "./SandboxConfiguration.ts";

const create = (name: string, credential?: string) => ({
  provider: "sprites" as const,
  name,
  expectedRevision: 0,
  ...(credential === undefined ? {} : { credential }),
});
const key = (id: string) => `sandbox-sprites-${id}`;
const deferredPromise = Effect.runPromise;

const fixture = Effect.gen(function* () {
  const calls: string[] = [];
  let response = (): Response | Promise<Response> => new Response(null, { status: 200 });
  const service = yield* makeSandboxConfiguration(async (_url, init) => {
    calls.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
    return response();
  });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  return {
    service,
    calls,
    fs,
    filePath: path.join(path.dirname(config.settingsPath), "sprites.json"),
    respond: (next: () => Response | Promise<Response>) => {
      response = next;
    },
  };
});

const dependencies = Layer.mergeAll(Settings.layerTest({}), Secrets.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "sandbox-config-test-" })),
);

it.layer(NodeServices.layer)("sandbox configuration", (it) => {
  it.effect("creates, edits, verifies, restarts, and removes independently named accounts", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* fixture;
      const secrets = yield* Secrets.ServerSecretStore;
      expect(yield* service.read).toEqual([]);
      const personal = yield* service.save(create("  Personal  ", "personal-token"));
      const work = yield* service.save(create("Work", "work-token"));
      expect(personal).toMatchObject({ name: "Personal", revision: 1 });
      expect(work).toMatchObject({ name: "Work", revision: 1 });
      expect(work.id).not.toBe(personal.id);

      const edited = yield* service.save({
        id: personal.id,
        provider: "sprites",
        name: "Personal renamed",
        expectedRevision: 1,
      });
      expect(edited).toMatchObject({ id: personal.id, revision: 2, credentialConfigured: true });
      const verified = yield* service.verify({ id: work.id, expectedRevision: 1 });
      expect(verified).toMatchObject({ id: work.id, revision: 2 });
      expect(calls).toEqual(["Bearer work-token"]);
      expect((yield* service.read).find((item) => item.id === personal.id)).toMatchObject({
        revision: 2,
        verifiedAt: null,
      });

      const restarted = yield* makeSandboxConfiguration();
      expect(yield* restarted.read).toHaveLength(2);
      yield* restarted.remove({ id: personal.id, expectedRevision: 2 });
      expect(yield* restarted.read).toEqual([verified]);
      expect(Option.isNone(yield* secrets.get(key(personal.id)))).toBe(true);
      expect(new TextDecoder().decode(Option.getOrThrow(yield* secrets.get(key(work.id))))).toBe(
        "work-token",
      );
    }).pipe(Effect.provide(dependencies)),
  );

  it.effect("scopes provider settings and redacts sensitive environment values", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture;
      const secrets = yield* Secrets.ServerSecretStore;
      const personal = yield* service.save(create("Personal"));
      const work = yield* service.save(create("Work"));
      const instanceId = ProviderInstanceId.make("opencode");
      const save = (id: string, expectedRevision: number, password: string) =>
        service.saveProviderInstance({
          id,
          expectedRevision,
          instanceId,
          instance: {
            driver: ProviderDriverKind.make("opencode"),
            config: { serverPassword: password },
            environment: [{ name: "TOKEN", value: password, sensitive: true }],
          },
        });
      const personalProvider = yield* save(personal.id, 1, "personal-secret");
      const workProvider = yield* save(work.id, 1, "work-secret");
      expect(personalProvider.providerInstances[instanceId]).toMatchObject({
        config: { serverPassword: "personal-secret" },
        environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
      });
      expect(workProvider.providerInstances[instanceId]?.config).toEqual({
        serverPassword: "work-secret",
      });
      const workAntigravity = yield* service.saveProviderInstance({
        id: work.id,
        expectedRevision: 2,
        instanceId,
        instance: {
          driver: ProviderDriverKind.make("antigravity"),
          config: { apiKey: "work-api-key" },
          environment: [{ name: "TOKEN", value: "work-environment", sensitive: true }],
        },
      });
      expect(workAntigravity.providerInstances[instanceId]).toMatchObject({
        driver: "antigravity",
        config: { apiKey: "work-api-key" },
        environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
      });
      const edited = yield* service.save({
        id: personal.id,
        provider: "sprites",
        name: "Personal renamed",
        expectedRevision: 2,
      });
      expect(edited.providerInstances).toEqual(personalProvider.providerInstances);
      const restarted = yield* makeSandboxConfiguration();
      yield* restarted.saveProviderInstance({
        id: personal.id,
        expectedRevision: 3,
        instanceId,
        instance: {
          driver: ProviderDriverKind.make("opencode"),
          config: { serverPassword: "personal-secret" },
          environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
        },
      });
      const raw = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ProviderInstanceConfigMap),
      )(
        new TextDecoder().decode(
          Option.getOrThrow(yield* secrets.get(`sandbox-provider-instances-${personal.id}`)),
        ),
      );
      expect(raw[instanceId]?.config).toMatchObject({ serverPassword: "personal-secret" });
      expect(raw[instanceId]?.environment?.[0]?.value).toBe("personal-secret");
      const replaced = yield* restarted.saveProviderInstance({
        id: personal.id,
        expectedRevision: 4,
        instanceId,
        instance: {
          driver: ProviderDriverKind.make("opencode"),
          config: { serverPassword: "replacement" },
          environment: [
            { name: "TOKEN", value: "replacement-env", sensitive: true },
            { name: "PUBLIC", value: "visible", sensitive: false },
          ],
        },
      });
      expect(replaced.providerInstances[instanceId]).toMatchObject({
        config: { serverPassword: "replacement" },
        environment: [
          { name: "TOKEN", value: "", sensitive: true, valueRedacted: true },
          { name: "PUBLIC", value: "visible", sensitive: false },
        ],
      });
      const cleared = yield* restarted.saveProviderInstance({
        id: personal.id,
        expectedRevision: 5,
        instanceId,
        instance: {
          driver: ProviderDriverKind.make("opencode"),
          config: { serverPassword: "" },
          environment: [],
        },
      });
      expect(cleared.providerInstances[instanceId]).toMatchObject({
        config: { serverPassword: "" },
        environment: [],
      });
      const withoutInstance = yield* restarted.saveProviderInstance({
        id: personal.id,
        expectedRevision: 6,
        instanceId,
        instance: null,
      });
      expect(withoutInstance.providerInstances).toEqual({});
      expect(
        yield* restarted
          .saveProviderInstance({
            id: personal.id,
            expectedRevision: 7,
            instanceId,
            instance: { driver: "unsupported", config: {} } as never,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "invalid" });
      yield* restarted.remove({ id: personal.id, expectedRevision: 7 });
      expect(Option.isNone(yield* secrets.get(`sandbox-provider-instances-${personal.id}`))).toBe(
        true,
      );
      expect(Option.isSome(yield* secrets.get(`sandbox-provider-instances-${work.id}`))).toBe(true);
      const workRaw = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ProviderInstanceConfigMap),
      )(
        new TextDecoder().decode(
          Option.getOrThrow(yield* secrets.get(`sandbox-provider-instances-${work.id}`)),
        ),
      );
      expect(workRaw[instanceId]).toMatchObject({
        driver: "antigravity",
        config: { apiKey: "work-api-key" },
        environment: [{ name: "TOKEN", value: "work-environment", sensitive: true }],
      });
    }).pipe(Effect.provide(dependencies)),
  );

  it.effect("targets IDs and enforces create and per-account revisions", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture;
      const account = yield* service.save(create("Personal"));
      expect(
        yield* service.save({ ...create("Invalid"), expectedRevision: 1 }).pipe(Effect.flip),
      ).toMatchObject({ code: "conflict" });
      expect(
        yield* service
          .save({ ...create("Missing"), id: "00000000-0000-4000-8000-000000000001" })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "invalid" });
      expect(
        yield* service.remove({ id: account.id, expectedRevision: 0 }).pipe(Effect.flip),
      ).toMatchObject({ code: "conflict" });
      expect(
        yield* service
          .verify({ id: "00000000-0000-4000-8000-000000000001", expectedRevision: 1 })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "invalid" });
    }).pipe(Effect.provide(dependencies)),
  );

  it.effect("invalidates only the targeted account before failed verification", () =>
    Effect.gen(function* () {
      const { service, respond } = yield* fixture;
      const personal = yield* service.save(create("Personal", "personal-token"));
      const work = yield* service.save(create("Work", "work-token"));
      yield* service.verify({ id: personal.id, expectedRevision: 1 });
      respond(() => new Response(null, { status: 401 }));
      expect(
        yield* service.verify({ id: personal.id, expectedRevision: 2 }).pipe(Effect.flip),
      ).toMatchObject({ code: "unauthorized" });
      const values = yield* service.read;
      expect(values.find((item) => item.id === personal.id)).toMatchObject({
        revision: 3,
        verifiedAt: null,
      });
      expect(values.find((item) => item.id === work.id)).toEqual(work);
    }).pipe(Effect.provide(dependencies)),
  );

  it.effect("does not lock unrelated accounts while verification is in flight", () =>
    Effect.gen(function* () {
      const { service, respond } = yield* fixture;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<Response>();
      respond(async () => {
        await deferredPromise(Deferred.succeed(started, undefined));
        return deferredPromise(Deferred.await(release));
      });
      const personal = yield* service.save(create("Personal", "personal-token"));
      const work = yield* service.save(create("Work", "work-token"));
      const verification = yield* service
        .verify({ id: personal.id, expectedRevision: 1 })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(started);

      expect(yield* service.read).toContainEqual(expect.objectContaining({ id: work.id }));
      const editedWork = yield* service.save({
        id: work.id,
        provider: "sprites",
        name: "Work renamed",
        expectedRevision: 1,
      });
      yield* Deferred.succeed(release, new Response(null, { status: 200 }));
      const result = yield* Fiber.join(verification);
      expect(Exit.isSuccess(result)).toBe(true);
      const values = yield* service.read;
      expect(values.find((item) => item.id === personal.id)).toMatchObject({
        revision: 2,
        verifiedAt: expect.any(String),
      });
      expect(values.find((item) => item.id === work.id)).toEqual(editedWork);
    }).pipe(Effect.provide(dependencies)),
  );

  it.effect("rejects a late verification after the same account credential rotates", () =>
    Effect.gen(function* () {
      const { service, respond } = yield* fixture;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<Response>();
      respond(async () => {
        await deferredPromise(Deferred.succeed(started, undefined));
        return deferredPromise(Deferred.await(release));
      });
      const account = yield* service.save(create("Personal", "old-token"));
      const verification = yield* service
        .verify({ id: account.id, expectedRevision: 1 })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(started);
      const rotated = yield* service.save({
        id: account.id,
        provider: "sprites",
        name: account.name,
        expectedRevision: 2,
        credential: "new-token",
      });
      yield* Deferred.succeed(release, new Response(null, { status: 200 }));
      const result = yield* Fiber.join(verification);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toMatchObject({
          code: "conflict",
        });
      }
      expect(yield* service.read).toEqual([rotated]);
      expect(rotated).toMatchObject({ revision: 3, verifiedAt: null });
    }).pipe(Effect.provide(dependencies)),
  );

  it.effect("does not resurrect an account deleted during verification", () =>
    Effect.gen(function* () {
      const { service, respond } = yield* fixture;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<Response>();
      respond(async () => {
        await deferredPromise(Deferred.succeed(started, undefined));
        return deferredPromise(Deferred.await(release));
      });
      const account = yield* service.save(create("Personal", "token"));
      const verification = yield* service
        .verify({ id: account.id, expectedRevision: 1 })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(started);
      yield* service.remove({ id: account.id, expectedRevision: 2 });
      yield* Deferred.succeed(release, new Response(null, { status: 200 }));
      const result = yield* Fiber.join(verification);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toMatchObject({
          code: "conflict",
        });
      }
      expect(yield* service.read).toEqual([]);
    }).pipe(Effect.provide(dependencies)),
  );

  it.effect("rolls back only the targeted credential when collection persistence fails", () =>
    Effect.gen(function* () {
      const { service, fs, filePath } = yield* fixture;
      const personal = yield* service.save(create("Personal", "personal-token"));
      const work = yield* service.save(create("Work", "work-token"));
      const instanceId = ProviderInstanceId.make("opencode");
      const personalProvider = yield* service.saveProviderInstance({
        id: personal.id,
        expectedRevision: 1,
        instanceId,
        instance: {
          driver: ProviderDriverKind.make("opencode"),
          config: { serverPassword: "original-provider-secret" },
        },
      });
      const secrets = yield* Secrets.ServerSecretStore;
      const providerKey = `sandbox-provider-instances-${personal.id}`;
      const originalProviderBlob = Option.getOrThrow(yield* secrets.get(providerKey));
      const broken = yield* makeSandboxConfiguration().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            to === filePath
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    description: "denied",
                  }),
                )
              : fs.rename(from, to),
        }),
      );
      expect(
        yield* broken
          .save({
            id: personal.id,
            provider: "sprites",
            name: "Personal",
            expectedRevision: 2,
            credential: "replacement",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "storage" });
      expect(
        yield* broken
          .saveProviderInstance({
            id: personal.id,
            expectedRevision: 2,
            instanceId,
            instance: {
              driver: ProviderDriverKind.make("opencode"),
              config: { serverPassword: "changed-provider-secret" },
            },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "storage" });
      expect(
        yield* broken.remove({ id: personal.id, expectedRevision: 2 }).pipe(Effect.flip),
      ).toMatchObject({ code: "storage" });
      expect(
        new TextDecoder().decode(Option.getOrThrow(yield* secrets.get(key(personal.id)))),
      ).toBe("personal-token");
      expect(new TextDecoder().decode(Option.getOrThrow(yield* secrets.get(key(work.id))))).toBe(
        "work-token",
      );
      expect(yield* secrets.get(providerKey)).toEqual(Option.some(originalProviderBlob));
      expect(yield* service.read).toEqual([personalProvider, work]);
    }).pipe(Effect.provide(dependencies)),
  );
});
