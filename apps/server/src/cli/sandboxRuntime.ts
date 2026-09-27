import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { makeSandboxRuntimeManifest } from "../sandbox/SandboxRuntime.ts";
import { SandboxDeployment } from "../sandbox/SandboxDeployment.ts";

const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Packaging invokes the built executable so the catalog comes from that artifact. */
export const sandboxRuntimeCommand = Command.make(
  "sandbox-runtime-manifest",
  {
    artifactIntegrity: Flag.String("artifact-integrity").pipe(
      Flag.withSchema(SandboxDeployment.fields.artifactIntegrity),
    ),
  },
  ({ artifactIntegrity }) =>
    encodeManifest(makeSandboxRuntimeManifest(artifactIntegrity)).pipe(Effect.flatMap(Console.log)),
).pipe(Command.unlisted);
