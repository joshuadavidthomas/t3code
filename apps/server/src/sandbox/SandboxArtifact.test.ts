import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ProviderDriverKind,
  SANDBOX_INTAKE_VERSION,
  SandboxRuntimeManifest,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import {
  loadSandboxArtifact,
  resolveCapturedSandboxArtifact,
  resolveCurrentSandboxArtifact,
} from "./SandboxArtifact.ts";

const testLayer = Layer.merge(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "sandbox-artifact-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

const encodeManifest = Schema.encodeSync(Schema.fromJsonString(SandboxRuntimeManifest));

const manifestFor = (bytes: Uint8Array): SandboxRuntimeManifest => ({
  id: "runtime-test",
  artifactIntegrity: `sha256-${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`,
  orchestrationProtocol: ORCHESTRATION_PROTOCOL_VERSION,
  intakeVersion: SANDBOX_INTAKE_VERSION,
  providers: [
    {
      driver: ProviderDriverKind.make("claudeAgent"),
      version: "2.1.280",
      showInteractionModeToggle: true,
      models: [{ slug: "model", name: "Model", isCustom: false, capabilities: null }],
    },
  ],
});

describe("loadSandboxArtifact", () => {
  it("reads older manifests without advertising undeclared Plan support", () => {
    const runtime = manifestFor(new Uint8Array([1, 2, 3]));
    const { showInteractionModeToggle: _capability, ...legacyProvider } = runtime.providers[0]!;
    const decode = Schema.decodeUnknownSync(SandboxRuntimeManifest);
    assert.equal(
      decode({ ...runtime, providers: [legacyProvider] }).providers[0]!.showInteractionModeToggle,
      false,
    );
    assert.equal(decode(runtime).providers[0]!.showInteractionModeToggle, true);
  });

  it.effect("downloads the exact release with checksums once, then resolves from disk", () =>
    Effect.gen(function* () {
      const override = process.env.T3CODE_SANDBOX_RUNTIME_ARCHIVE;
      const mirror = process.env.T3CODE_SANDBOX_RELEASE_BASE_URL;
      delete process.env.T3CODE_SANDBOX_RUNTIME_ARCHIVE;
      process.env.T3CODE_SANDBOX_RELEASE_BASE_URL = "https://releases.test/download";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (override === undefined) delete process.env.T3CODE_SANDBOX_RUNTIME_ARCHIVE;
          else process.env.T3CODE_SANDBOX_RUNTIME_ARCHIVE = override;
          if (mirror === undefined) delete process.env.T3CODE_SANDBOX_RELEASE_BASE_URL;
          else process.env.T3CODE_SANDBOX_RELEASE_BASE_URL = mirror;
        }),
      );
      const archive = new Uint8Array([9, 2, 5]);
      const runtime = manifestFor(archive);
      const sidecar = new TextEncoder().encode(encodeManifest(runtime));
      const name = `t3-${packageJson.version}-linux-x64.tar.gz`;
      const base = `https://releases.test/download/v${packageJson.version}/`;
      const digest = (bytes: Uint8Array) =>
        NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      const files: Record<string, Uint8Array> = {
        [base + name]: archive,
        [base + name + ".sandbox.json"]: sidecar,
        [base + "SHA256SUMS"]: new TextEncoder().encode(
          `${digest(archive)}  ${name}\n${digest(sidecar)}  ${name}.sandbox.json\n`,
        ),
      };
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          return HttpClientResponse.fromWeb(
            request,
            new Response(files[request.url] as Uint8Array<ArrayBuffer> | undefined, {
              status: files[request.url] ? 200 : 404,
            }),
          );
        }),
      );
      const resolve = resolveCurrentSandboxArtifact().pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const first = yield* resolve;
      assert.deepStrictEqual(first.runtime, runtime);
      assert.deepStrictEqual(yield* resolve, first);
      assert.deepStrictEqual(requests.toSorted(), Object.keys(files).toSorted());
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("stores a valid archive and verified sidecar by content hash", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const input = yield* fs.makeTempDirectoryScoped({ prefix: "sandbox-artifact-input-" });
      const archive = path.join(input, "runtime.tar.gz");
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const runtime = manifestFor(bytes);
      yield* fs.writeFile(archive, bytes);
      yield* fs.writeFileString(`${archive}.sandbox.json`, encodeManifest(runtime));

      const loaded = yield* loadSandboxArtifact(archive);
      assert.deepStrictEqual(loaded.runtime, runtime);
      assert.strictEqual(
        loaded.archivePath,
        path.join(
          config.stateDir,
          "sandbox-artifacts",
          `${runtime.artifactIntegrity.slice(7)}.tar.gz`,
        ),
      );
      assert.deepStrictEqual(yield* fs.readFile(loaded.archivePath), bytes);
      assert.isTrue(yield* fs.exists(`${loaded.archivePath.slice(0, -7)}.sandbox.json`));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects an archive changed after its sidecar was created", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* fs.makeTempDirectoryScoped({ prefix: "sandbox-artifact-changed-" });
      const archive = path.join(input, "runtime.tar.gz");
      const original = new Uint8Array([1, 2, 3]);
      yield* fs.writeFile(archive, new Uint8Array([9, 9, 9]));
      yield* fs.writeFileString(`${archive}.sandbox.json`, encodeManifest(manifestFor(original)));

      const error = yield* Effect.flip(loadSandboxArtifact(archive));
      assert.strictEqual(error._tag, "SandboxSubmissionError");
      assert.strictEqual(error.code, "invalid");
      assert.strictEqual(error.message, "Sandbox artifact is invalid.");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects an orchestration protocol mismatch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* fs.makeTempDirectoryScoped({ prefix: "sandbox-artifact-protocol-" });
      const archive = path.join(input, "runtime.tar.gz");
      const bytes = new Uint8Array([4, 5, 6]);
      yield* fs.writeFile(archive, bytes);
      yield* fs.writeFileString(
        `${archive}.sandbox.json`,
        encodeManifest({ ...manifestFor(bytes), orchestrationProtocol: 999 }),
      );

      const error = yield* Effect.flip(loadSandboxArtifact(archive));
      assert.strictEqual(error.code, "invalid");
      assert.strictEqual(error.message, "Sandbox artifact is invalid.");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resolves a cached artifact after its source is gone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* fs.makeTempDirectoryScoped({ prefix: "sandbox-artifact-restart-" });
      const archive = path.join(input, "runtime.tar.gz");
      const bytes = new Uint8Array([7, 8, 9]);
      const runtime = manifestFor(bytes);
      yield* fs.writeFile(archive, bytes);
      yield* fs.writeFileString(`${archive}.sandbox.json`, encodeManifest(runtime));
      const imported = yield* loadSandboxArtifact(archive);
      yield* fs.remove(archive);
      yield* fs.remove(`${archive}.sandbox.json`);

      const restarted = yield* resolveCapturedSandboxArtifact(runtime.artifactIntegrity);
      assert.deepStrictEqual(restarted, imported);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects corrupted cached bytes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* fs.makeTempDirectoryScoped({ prefix: "sandbox-artifact-cache-" });
      const archive = path.join(input, "runtime.tar.gz");
      const bytes = new Uint8Array([10, 11, 12]);
      const runtime = manifestFor(bytes);
      yield* fs.writeFile(archive, bytes);
      yield* fs.writeFileString(`${archive}.sandbox.json`, encodeManifest(runtime));
      const imported = yield* loadSandboxArtifact(archive);
      yield* fs.writeFile(imported.archivePath, new Uint8Array([0]));

      const error = yield* Effect.flip(resolveCapturedSandboxArtifact(runtime.artifactIntegrity));
      assert.strictEqual(error.code, "invalid");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
