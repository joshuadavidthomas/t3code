import {
  ORCHESTRATION_PROTOCOL_VERSION,
  SANDBOX_INTAKE_VERSION,
  SandboxRuntimeManifest,
  SandboxSubmissionError,
} from "@t3tools/contracts";
import {
  parseChecksums,
  cliArchiveFileName,
  cliReleaseDownloadBaseUrl,
} from "@t3tools/shared/cliRelease";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import packageJson from "../../package.json" with { type: "json" };
import { ServerConfig } from "../config.ts";

const MAX_MANIFEST_BYTES = 1024 * 1024;
/**
 * Releases that publish the `.sandbox.json` runtime sidecar. Upstream releases
 * don't yet, so this fork's releases are the default; a mirror can be selected
 * with T3CODE_SANDBOX_RELEASE_BASE_URL.
 */
const SANDBOX_RELEASE_DEFAULT_BASE_URL =
  "https://github.com/joshuadavidthomas/t3code/releases/download";
const SANDBOX_RELEASE_VERSION = packageJson.version;
/** Development and offline installs can point at a local archive with its sidecar beside it. */
const SandboxRuntimeArchiveOverride = Config.String("T3CODE_SANDBOX_RUNTIME_ARCHIVE").pipe(
  Config.option,
);
const SandboxReleaseBaseUrl = Config.String("T3CODE_SANDBOX_RELEASE_BASE_URL").pipe(Config.option);
const invalidArtifact = () =>
  new SandboxSubmissionError({ code: "invalid", message: "Sandbox artifact is invalid." });
const storageFailure = () =>
  new SandboxSubmissionError({
    code: "storage",
    message: "Sandbox artifact could not be stored.",
  });

const sha256File = Effect.fnUntraced(function* (filename: string) {
  const fs = yield* FileSystem.FileSystem;
  const hash = NodeCrypto.createHash("sha256");
  yield* fs
    .stream(filename)
    .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
  return hash.digest("hex");
});

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(SandboxRuntimeManifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(SandboxRuntimeManifest));
const ReleaseMarker = Schema.fromJsonString(Schema.Struct({ integrity: Schema.String }));
const encodeReleaseMarker = Schema.encodeEffect(ReleaseMarker);
const decodeReleaseMarker = Schema.decodeUnknownEffect(ReleaseMarker);

function validManifest(runtime: SandboxRuntimeManifest, sha256: string): boolean {
  return (
    runtime.artifactIntegrity === `sha256-${sha256}` &&
    runtime.orchestrationProtocol === ORCHESTRATION_PROTOCOL_VERSION &&
    runtime.intakeVersion === SANDBOX_INTAKE_VERSION &&
    runtime.providers.length > 0 &&
    runtime.providers.every((provider) => provider.models.length > 0)
  );
}

/** Verifies and imports a build sidecar without executing anything from the artifact. */
export const loadSandboxArtifact = Effect.fn("loadSandboxArtifact")(function* (
  archivePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;

  const verified = yield* Effect.gen(function* () {
    const manifestPath = `${archivePath}.sandbox.json`;
    const manifestInfo = yield* fs.stat(manifestPath);
    if (manifestInfo.type !== "File" || manifestInfo.size > MAX_MANIFEST_BYTES) {
      return yield* invalidArtifact();
    }
    const runtime = yield* decodeManifest(yield* fs.readFileString(manifestPath)).pipe(
      Effect.mapError(invalidArtifact),
    );
    const sha256 = yield* sha256File(archivePath);
    if (!validManifest(runtime, sha256)) return yield* invalidArtifact();
    return { runtime, sha256 };
  }).pipe(Effect.mapError(() => invalidArtifact()));

  const artifactDirectory = path.join(config.stateDir, "sandbox-artifacts");
  const destination = path.join(artifactDirectory, `${verified.sha256}.tar.gz`);
  const destinationManifest = path.join(artifactDirectory, `${verified.sha256}.sandbox.json`);

  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* fs.makeDirectory(artifactDirectory, { recursive: true });

      // Existing content-addressed entries are accepted only after checking their bytes.
      if (yield* fs.exists(destination)) {
        if ((yield* sha256File(destination)) !== verified.sha256) return yield* storageFailure();
      } else {
        const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
          directory: artifactDirectory,
          prefix: ".sandbox-artifact-",
        });
        const temporaryArchive = path.join(temporaryDirectory, "archive.tmp");
        yield* fs.copyFile(archivePath, temporaryArchive);
        // The source may be replaced while copyFile is in progress. Only publish the copied bytes.
        if ((yield* sha256File(temporaryArchive)) !== verified.sha256) {
          return yield* invalidArtifact();
        }
        yield* fs.rename(temporaryArchive, destination);
      }

      const encodedManifest = `${yield* encodeManifest(verified.runtime).pipe(Effect.mapError(storageFailure))}\n`;
      if (yield* fs.exists(destinationManifest)) {
        const stored = yield* decodeManifest(yield* fs.readFileString(destinationManifest)).pipe(
          Effect.mapError(storageFailure),
        );
        if (
          !validManifest(stored, verified.sha256) ||
          !NodeUtil.isDeepStrictEqual(stored, verified.runtime)
        ) {
          return yield* storageFailure();
        }
      } else {
        const temporaryManifest = yield* fs.makeTempFileScoped({
          directory: artifactDirectory,
          prefix: ".sandbox-manifest-",
        });
        yield* fs.writeFileString(temporaryManifest, encodedManifest);
        yield* fs.rename(temporaryManifest, destinationManifest);
      }
    }).pipe(Effect.catchTag("PlatformError", () => storageFailure())),
  );

  return { runtime: verified.runtime, archivePath: destination };
});

export type SandboxArtifact = Effect.Success<ReturnType<typeof loadSandboxArtifact>>;

const cachedArtifact = Effect.fnUntraced(function* (integrity: string) {
  const match = /^sha256-([0-9a-f]{64})$/.exec(integrity);
  if (match?.[1] === undefined) return yield* invalidArtifact();
  const digest = match[1];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const archivePath = path.join(config.stateDir, "sandbox-artifacts", `${match[1]}.tar.gz`);
  const manifestPath = path.join(config.stateDir, "sandbox-artifacts", `${match[1]}.sandbox.json`);
  const runtime = yield* Effect.gen(function* () {
    const info = yield* fs.stat(manifestPath);
    if (info.type !== "File" || info.size > MAX_MANIFEST_BYTES) return yield* invalidArtifact();
    const value = yield* decodeManifest(yield* fs.readFileString(manifestPath)).pipe(
      Effect.mapError(invalidArtifact),
    );
    if (!validManifest(value, digest) || (yield* sha256File(archivePath)) !== digest) {
      return yield* invalidArtifact();
    }
    return value;
  }).pipe(Effect.mapError(() => invalidArtifact()));
  return { runtime, archivePath };
});

/** Resolves an already accepted submission runtime by its immutable integrity. */
export const resolveCapturedSandboxArtifact = Effect.fn("resolveCapturedSandboxArtifact")(
  function* (artifactIntegrity: string) {
    return yield* cachedArtifact(artifactIntegrity);
  },
);

const downloadReleaseArtifact = Effect.fnUntraced(function* (version: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const fileName = cliArchiveFileName(version, "linux-x64");
  const mirror = Option.getOrUndefined(yield* SandboxReleaseBaseUrl)?.trim();
  const baseUrl = cliReleaseDownloadBaseUrl(version, mirror || SANDBOX_RELEASE_DEFAULT_BASE_URL);
  const http = yield* HttpClient.HttpClient;
  const fetchBytes = (name: string) =>
    http.execute(HttpClientRequest.get(`${baseUrl}/${name}`)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.map((bytes) => new Uint8Array(bytes)),
      Effect.timeout("2 minutes"),
      Effect.mapError(invalidArtifact),
    );
  const checksums = parseChecksums(new TextDecoder().decode(yield* fetchBytes("SHA256SUMS")));
  const expected = checksums.get(fileName);
  const sidecarName = `${fileName}.sandbox.json`;
  const expectedSidecar = checksums.get(sidecarName);
  if (expected === undefined || expectedSidecar === undefined) return yield* invalidArtifact();
  const [archive, sidecar] = yield* Effect.all([fetchBytes(fileName), fetchBytes(sidecarName)], {
    concurrency: "unbounded",
  });
  const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (digest(archive) !== expected || digest(sidecar) !== expectedSidecar) {
    return yield* invalidArtifact();
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "sandbox-release-" });
      const archivePath = path.join(temporary, fileName);
      yield* fs.writeFile(archivePath, archive);
      yield* fs.writeFile(path.join(temporary, sidecarName), sidecar);
      const loaded = yield* loadSandboxArtifact(archivePath);
      const marker = path.join(config.stateDir, "sandbox-artifacts", `release-${version}.json`);
      yield* fs.writeFileString(
        marker,
        yield* encodeReleaseMarker({ integrity: loaded.runtime.artifactIntegrity }),
      );
      return loaded;
    }),
  );
});

/** Resolves the Linux x64 runtime from the override, durable cache, or this exact release version. */
export const resolveCurrentSandboxArtifact = Effect.fn("resolveCurrentSandboxArtifact")(
  function* () {
    const override = Option.getOrUndefined(yield* SandboxRuntimeArchiveOverride)?.trim();
    if (override) return yield* loadSandboxArtifact(override);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const marker = path.join(
      config.stateDir,
      "sandbox-artifacts",
      `release-${SANDBOX_RELEASE_VERSION}.json`,
    );
    if (yield* fs.exists(marker)) {
      const markerContents = yield* fs.readFileString(marker);
      const parsed = yield* decodeReleaseMarker(markerContents).pipe(
        Effect.mapError(invalidArtifact),
      );
      return yield* resolveCapturedSandboxArtifact(parsed.integrity);
    }
    return yield* downloadReleaseArtifact(SANDBOX_RELEASE_VERSION);
  },
);
