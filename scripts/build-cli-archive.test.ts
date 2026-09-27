import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  CliArchiveSandboxRuntimeError,
  readSandboxRuntimeManifest,
  sandboxRuntimeSidecarFileName,
  validateSandboxRuntimeManifest,
} from "./build-cli-archive.ts";

const integrity = `sha256-${"a".repeat(64)}`;
const manifest = (artifactIntegrity: string) =>
  JSON.stringify({
    id: "runtime-test",
    artifactIntegrity,
    orchestrationProtocol: 1,
    intakeVersion: 1,
    providers: [
      {
        driver: "codex",
        version: "1.0.0",
        showInteractionModeToggle: false,
        models: [{ slug: "test", name: "Test", isCustom: false, capabilities: null }],
      },
    ],
  });

it.layer(NodeServices.layer)("sandbox runtime archive metadata", (it) => {
  it("uses the immutable Linux x64 release archive name", () => {
    assert.strictEqual(
      sandboxRuntimeSidecarFileName("1.2.3"),
      "t3-1.2.3-linux-x64.tar.gz.sandbox.json",
    );
  });
  it.effect("rejects an archive digest mismatch", () =>
    Effect.gen(function* () {
      const error = yield* validateSandboxRuntimeManifest(
        manifest(`sha256-${"b".repeat(64)}`),
        integrity,
      ).pipe(Effect.flip);
      assert.instanceOf(error, CliArchiveSandboxRuntimeError);
      assert.include(error.detail, "artifact integrity mismatch");
    }),
  );

  it.effect("rejects executable and sidecar disagreement", () =>
    Effect.gen(function* () {
      const sidecar = yield* validateSandboxRuntimeManifest(manifest(integrity), integrity);
      const error = yield* validateSandboxRuntimeManifest(
        manifest(integrity).replace("runtime-test", "runtime-other"),
        integrity,
        sidecar,
      ).pipe(Effect.flip);
      assert.instanceOf(error, CliArchiveSandboxRuntimeError);
      assert.include(error.detail, "disagrees with the sidecar");
    }),
  );

  it.effect("rejects a nonzero manifest command result", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-manifest-test-" });
      const executable = path.join(cwd, "t3");
      yield* fs.writeFileString(executable, "#!/bin/sh\necho manifest-failed >&2\nexit 9\n");
      yield* fs.chmod(executable, 0o755);
      const error = yield* readSandboxRuntimeManifest({
        executable,
        artifactIntegrity: integrity,
        cwd,
      }).pipe(Effect.flip);
      assert.instanceOf(error, CliArchiveSandboxRuntimeError);
      assert.include(error.detail, "exited with 9");
    }).pipe(Effect.scoped),
  );
});
