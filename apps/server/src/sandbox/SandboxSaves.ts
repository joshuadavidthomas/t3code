import { type CommandId, SandboxSubmissionError } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Saved sandboxes: their T3 state, provider transcripts and workspace, kept by the host
 * that launched them until they are restored or deleted. */
export interface SandboxSaves {
  readonly write: (
    commandId: CommandId,
    archive: Uint8Array,
  ) => Effect.Effect<void, SandboxSubmissionError>;
  readonly read: (commandId: CommandId) => Effect.Effect<Uint8Array, SandboxSubmissionError>;
  readonly remove: (commandId: CommandId) => Effect.Effect<void, SandboxSubmissionError>;
}

const failure = () =>
  new SandboxSubmissionError({ code: "storage", message: "Unable to store the saved sandbox." });

export const makeSandboxSaves = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = (commandId: CommandId) =>
    path.join(
      directory,
      `${NodeCrypto.createHash("sha256").update(commandId).digest("hex")}.tar.gz`,
    );
  return {
    write: (commandId, archive) =>
      fs
        .makeDirectory(directory, { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFile(`${file(commandId)}.partial`, archive)),
          Effect.andThen(fs.rename(`${file(commandId)}.partial`, file(commandId))),
          Effect.mapError(failure),
        ),
    read: (commandId) => fs.readFile(file(commandId)).pipe(Effect.mapError(failure)),
    remove: (commandId) =>
      fs.remove(file(commandId), { force: true }).pipe(Effect.mapError(failure)),
  } satisfies SandboxSaves;
});
