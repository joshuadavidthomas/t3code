import {
  SandboxConfiguration,
  SandboxConfigurationError,
  SandboxConfigurationRemoveInput,
  SandboxConfigurationSaveInput,
  SandboxConfigurationVerifyInput,
  SandboxProviderInstanceSaveInput,
  ProviderInstanceConfigMap,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import { redactProviderEnvironmentVariable } from "../serverSettings.ts";

const secretKey = (id: string) => `sandbox-sprites-${id}`;
const providerSecretKey = (id: string) => `sandbox-provider-instances-${id}`;
const SPRITES_API_URL = "https://api.sprites.dev/v1/sprites";
const failure = (code: SandboxConfigurationError["code"], message: string) =>
  new SandboxConfigurationError({ code, message });
const storageFailure = () => failure("storage", "Unable to persist or read sandbox configuration.");
const decodeConfigurations = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(SandboxConfiguration)),
);
const decodeRemoveInput = Schema.decodeUnknownEffect(SandboxConfigurationRemoveInput);
const decodeSaveInput = Schema.decodeUnknownEffect(SandboxConfigurationSaveInput);
const decodeVerifyInput = Schema.decodeUnknownEffect(SandboxConfigurationVerifyInput);
const decodeProviderInput = Schema.decodeUnknownEffect(SandboxProviderInstanceSaveInput);
const isConfigurationError = Schema.is(SandboxConfigurationError);
const providerInstancesJson = Schema.fromJsonString(ProviderInstanceConfigMap);
const decodeProviderInstances = Schema.decodeUnknownEffect(providerInstancesJson);
const encodeProviderInstances = Schema.encodeEffect(providerInstancesJson);
const providerConfigs = BUILT_IN_DRIVERS.map((driver) => ({
  driver,
  decode: Schema.decodeUnknownEffect(driver.configSchema),
}));

// Mirrors host provider settings: sensitive environment values never leave the server.
const sanitizeInstance = (instance: ProviderInstanceConfig): ProviderInstanceConfig =>
  instance.environment === undefined
    ? instance
    : { ...instance, environment: instance.environment.map(redactProviderEnvironmentVariable) };

/** Environment-owned named configurations. Credentials never enter JSON or RPC results. */
export const makeSandboxConfiguration = Effect.fnUntraced(function* (
  request: typeof fetch = fetch,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const secrets = yield* ServerSecretStore;
  const lock = yield* Semaphore.make(1);
  const filePath = path.join(path.dirname(config.settingsPath), "sprites.json");
  const persist = (values: ReadonlyArray<SandboxConfiguration>) =>
    writeFileStringAtomically({ filePath, contents: JSON.stringify(values, null, 2) }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(storageFailure),
    );
  const load = Effect.gen(function* () {
    if (!(yield* fs.exists(filePath))) return [];
    const contents = yield* fs.readFileString(filePath);
    return yield* decodeConfigurations(contents);
  }).pipe(Effect.mapError(storageFailure));
  const read = lock.withPermits(1)(load);
  const findCurrent = (
    values: ReadonlyArray<SandboxConfiguration>,
    id: string,
    expectedRevision: number,
  ) =>
    Effect.gen(function* () {
      const current = values.find((value) => value.id === id);
      if (!current) return yield* failure("invalid", "Sandbox configuration does not exist.");
      if (current.revision !== expectedRevision)
        return yield* failure("conflict", "Sandbox configuration changed. Reload before saving.");
      return current;
    });
  const save = (input: SandboxConfigurationSaveInput) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const decoded = yield* decodeSaveInput(input).pipe(
          Effect.mapError(() => failure("invalid", "Invalid sandbox configuration.")),
        );
        const values = yield* load;
        if (decoded.id === undefined && decoded.expectedRevision !== 0)
          return yield* failure("conflict", "New sandbox configurations require revision 0.");
        const current =
          decoded.id === undefined
            ? undefined
            : yield* findCurrent(values, decoded.id, decoded.expectedRevision);
        const id = current?.id ?? NodeCrypto.randomUUID();
        const key = secretKey(id);
        const previous = yield* secrets.get(key).pipe(Effect.mapError(storageFailure));
        const next: SandboxConfiguration = {
          ...(current ?? { providerInstances: {}, providerModelPreferences: {}, namePrefix: "" }),
          id,
          provider: decoded.provider,
          name: decoded.name,
          ...(decoded.namePrefix !== undefined ? { namePrefix: decoded.namePrefix } : {}),
          revision: decoded.expectedRevision + 1,
          credentialConfigured: decoded.credential !== undefined || Option.isSome(previous),
          verifiedAt: null,
        };
        const nextValues = current
          ? values.map((value) => (value.id === id ? next : value))
          : [...values, next];
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const write = yield* Effect.exit(
              Effect.gen(function* () {
                if (decoded.credential !== undefined) {
                  yield* secrets.set(key, new TextEncoder().encode(decoded.credential));
                }
                yield* persist(nextValues);
              }),
            );
            if (Exit.isFailure(write)) {
              if (decoded.credential !== undefined) {
                yield* Option.isSome(previous)
                  ? secrets.set(key, previous.value)
                  : secrets.remove(key);
              }
              return yield* Effect.failCause(write.cause);
            }
          }),
        );
        return next;
      }).pipe(Effect.mapError((error) => (isConfigurationError(error) ? error : storageFailure()))),
    );
  const remove = (input: SandboxConfigurationRemoveInput) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const decoded = yield* decodeRemoveInput(input).pipe(
          Effect.mapError(() => failure("invalid", "Invalid sandbox configuration revision.")),
        );
        const values = yield* load;
        yield* findCurrent(values, decoded.id, decoded.expectedRevision);
        const key = secretKey(decoded.id);
        const previous = yield* secrets.get(key).pipe(Effect.mapError(storageFailure));
        const providerKey = providerSecretKey(decoded.id);
        const previousProviders = yield* secrets
          .get(providerKey)
          .pipe(Effect.mapError(storageFailure));
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const deletion = yield* Effect.exit(
              Effect.gen(function* () {
                yield* secrets.remove(key);
                yield* secrets.remove(providerKey);
                yield* persist(values.filter((value) => value.id !== decoded.id));
              }),
            );
            if (Exit.isFailure(deletion)) {
              if (Option.isSome(previous)) yield* secrets.set(key, previous.value);
              if (Option.isSome(previousProviders))
                yield* secrets.set(providerKey, previousProviders.value);
              return yield* Effect.failCause(deletion.cause);
            }
          }),
        );
      }).pipe(Effect.mapError((error) => (isConfigurationError(error) ? error : storageFailure()))),
    );
  const saveProviderInstance = (input: SandboxProviderInstanceSaveInput) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const decoded = yield* decodeProviderInput(input).pipe(
          Effect.mapError(() => failure("invalid", "Invalid provider instance configuration.")),
        );
        const values = yield* load;
        const current = yield* findCurrent(values, decoded.id, decoded.expectedRevision);
        const key = providerSecretKey(decoded.id);
        const previous = yield* secrets.get(key).pipe(Effect.mapError(storageFailure));
        const stored = Option.isSome(previous)
          ? yield* decodeProviderInstances(new TextDecoder().decode(previous.value)).pipe(
              Effect.mapError(storageFailure),
            )
          : {};
        const raw = { ...stored };
        if (Option.isNone(previous) && Object.keys(current.providerInstances).length > 0)
          return yield* storageFailure();
        if (decoded.instance === null) delete raw[decoded.instanceId];
        else {
          const prior = raw[decoded.instanceId];
          const incoming = decoded.instance;
          const providerConfig = providerConfigs.find(
            (entry) => entry.driver.driverKind === incoming.driver,
          );
          if (!providerConfig) return yield* failure("invalid", "Unsupported provider driver.");
          const priorEnvironment = new Map(
            (prior?.environment ?? []).map((entry) => [entry.name, entry]),
          );
          if (
            incoming.environment?.some(
              (entry) =>
                entry.valueRedacted &&
                (!entry.sensitive ||
                  prior?.driver !== incoming.driver ||
                  !priorEnvironment.get(entry.name)?.sensitive),
            )
          )
            return yield* failure("invalid", "Redacted environment secret has no matching value.");
          const environment = incoming.environment?.map((entry) => {
            if (!entry.valueRedacted) return entry;
            const old = priorEnvironment.get(entry.name)!;
            const { valueRedacted: _redacted, ...rest } = entry;
            return { ...rest, value: old.value };
          });
          yield* providerConfig
            .decode(incoming.config ?? providerConfig.driver.defaultConfig())
            .pipe(Effect.mapError(() => failure("invalid", "Invalid provider settings.")));
          raw[decoded.instanceId] = { ...incoming, ...(environment ? { environment } : {}) };
        }
        const publicInstances = Object.fromEntries(
          Object.entries(raw).map(([id, instance]) => [id, sanitizeInstance(instance)]),
        );
        const preferences = { ...current.providerModelPreferences };
        if (decoded.instance === null) delete preferences[decoded.instanceId];
        else if (decoded.modelPreferences !== undefined)
          preferences[decoded.instanceId] = decoded.modelPreferences;
        const next = {
          ...current,
          revision: current.revision + 1,
          providerInstances: publicInstances,
          providerModelPreferences: preferences,
        };
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const write = yield* Effect.exit(
              Effect.gen(function* () {
                const serialized = yield* encodeProviderInstances(raw);
                yield* secrets.set(key, new TextEncoder().encode(serialized));
                yield* persist(values.map((value) => (value.id === decoded.id ? next : value)));
              }),
            );
            if (Exit.isFailure(write)) {
              yield* Option.isSome(previous)
                ? secrets.set(key, previous.value)
                : secrets.remove(key);
              return yield* Effect.failCause(write.cause);
            }
          }),
        );
        return next;
      }).pipe(Effect.mapError((error) => (isConfigurationError(error) ? error : storageFailure()))),
    );
  const verify = (input: SandboxConfigurationVerifyInput) =>
    Effect.gen(function* () {
      const captured = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const decoded = yield* decodeVerifyInput(input).pipe(
            Effect.mapError(() => failure("invalid", "Invalid sandbox configuration revision.")),
          );
          const values = yield* load;
          const current = yield* findCurrent(values, decoded.id, decoded.expectedRevision);
          const token = yield* secrets
            .get(secretKey(decoded.id))
            .pipe(Effect.mapError(storageFailure));
          if (Option.isNone(token))
            return yield* failure("invalid", "Sprites credential is required.");
          const invalidated = {
            ...current,
            revision: decoded.expectedRevision + 1,
            verifiedAt: null,
          };
          yield* persist(
            values.map((candidate) => (candidate.id === decoded.id ? invalidated : candidate)),
          );
          return { decoded, token: token.value, invalidated };
        }),
      );
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          request(SPRITES_API_URL, {
            method: "GET",
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            headers: { authorization: `Bearer ${new TextDecoder().decode(captured.token)}` },
          }),
        catch: () => failure("unavailable", "Sprites API is unavailable."),
      });
      if (response.status === 401 || response.status === 403)
        return yield* failure("unauthorized", "Sprites rejected its credential.");
      if (!response.ok) return yield* failure("unavailable", "Sprites API is unavailable.");
      const next = { ...captured.invalidated, verifiedAt: DateTime.formatIso(yield* DateTime.now) };
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const values = yield* load;
          const current = values.find((value) => value.id === captured.decoded.id);
          if (!current || current.revision !== captured.invalidated.revision)
            return yield* failure("conflict", "Sandbox configuration changed during verification.");
          yield* persist(values.map((value) => (value.id === current.id ? next : value)));
          return next;
        }),
      );
    });
  // Capture both credentials under the same revision lock as configuration writes.
  // This is server-only; the submission service stores its own immutable secret snapshot.
  const capture = (id: string, expectedRevision: number) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* findCurrent(yield* load, id, expectedRevision);
        const token = yield* secrets.get(secretKey(id)).pipe(Effect.mapError(storageFailure));
        if (Option.isNone(token))
          return yield* failure("invalid", "Sprites credential is required.");
        const stored = yield* secrets
          .get(providerSecretKey(id))
          .pipe(Effect.mapError(storageFailure));
        if (Option.isNone(stored))
          return yield* failure("invalid", "Provider configuration is required.");
        const providerInstances = yield* decodeProviderInstances(
          new TextDecoder().decode(stored.value),
        ).pipe(Effect.mapError(storageFailure));
        return {
          configuration: current,
          credential: new TextDecoder().decode(token.value),
          providerInstances,
        };
      }),
    );
  // Cleanup and pairing fall back to the saved credential when a submission's
  // captured one was rotated, so this ignores configuration revisions.
  const currentCredential = (id: string) =>
    secrets
      .get(secretKey(id))
      .pipe(
        Effect.mapError(storageFailure),
        Effect.map(Option.map((token) => new TextDecoder().decode(token))),
      );
  return { read, save, saveProviderInstance, remove, verify, capture, currentCredential };
});

export class SandboxConfigurations extends Context.Service<
  SandboxConfigurations,
  Effect.Success<ReturnType<typeof makeSandboxConfiguration>>
>()("t3/sandbox/SandboxConfiguration/SandboxConfigurations") {}

export const layer = Layer.effect(SandboxConfigurations, makeSandboxConfiguration());
