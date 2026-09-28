import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";

/** Every backend checks the project out here, so a thread's paths, including the ones
 * providers derive their transcript locations from, survive moving to another sandbox. */
export const SANDBOX_WORKSPACE_ROOT = "/workspace";

/** Written by the provisioner alongside the destination's settings before startup. */
export const SandboxDeployment = Schema.Struct({
  artifactIntegrity: Schema.String.check(Schema.isPattern(/^sha256-[a-f0-9]{64}$/)),
  workspaceRoot: Schema.String.check(Schema.isMinLength(1)),
  /** The backend's own name for the sandbox, so the environment matches its dashboard. */
  label: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
});

const decodeDeployment = Schema.decodeUnknownEffect(Schema.fromJsonString(SandboxDeployment));

export const readSandboxDeployment = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const filename = path.join(config.stateDir, "sandbox-runtime.json");
  if (!(yield* fs.exists(filename))) return null;
  const deployment = yield* decodeDeployment(yield* fs.readFileString(filename));
  if (!path.isAbsolute(deployment.workspaceRoot)) {
    return yield* new SandboxDeploymentError({
      message: "Sandbox workspace path must be absolute.",
    });
  }
  return deployment;
});

class SandboxDeploymentError extends Schema.TaggedError<SandboxDeploymentError>()(
  "SandboxDeploymentError",
  { message: Schema.String },
) {}
