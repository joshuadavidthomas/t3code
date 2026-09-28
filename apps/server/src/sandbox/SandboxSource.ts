import { SandboxPinnedSource, SandboxSubmissionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";

const failure = (message: string) => new SandboxSubmissionError({ code: "invalid", message });
const isSubmissionError = Schema.is(SandboxSubmissionError);
const decodeSource = Schema.decodeUnknownEffect(SandboxPinnedSource);

/** The sandbox keeps origin for pushing, but never the host's embedded credentials. */
export const withoutCredentials = (remote: string) => {
  if (!URL.canParse(remote)) return remote || null;
  const url = new URL(remote);
  if (url.protocol === "http:" || url.protocol === "https:") url.username = "";
  url.password = "";
  return url.toString();
};

/** Pins a branch of the host project. It needs no remote: the host seeds the sandbox.
 * Start from origin follows new worktrees: fetch, then fall back to the local branch. */
export const resolveSandboxSource = Effect.fnUntraced(
  function* (
    project: { readonly workspaceRoot: string; readonly title: string },
    branch: string,
    startFromOrigin = false,
  ) {
    const git = yield* GitVcsDriver;
    const run = (operation: string, args: ReadonlyArray<string>) =>
      git.execute({ operation, cwd: project.workspaceRoot, args, allowNonZeroExit: true });
    const commitOf = (ref: string) =>
      run("sandbox.resolveBranch", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    // Like a worktree base, a remote-tracking pick such as origin/feature starts a local branch.
    const local = yield* commitOf(`refs/heads/${branch}`);
    const resolved = local.exitCode === 0 ? local : yield* commitOf(`refs/remotes/${branch}`);
    if (resolved.exitCode !== 0) return yield* failure(`${branch} isn't a branch in this project.`);
    const name = local.exitCode === 0 ? branch : branch.slice(branch.indexOf("/") + 1);
    const valid = yield* run("sandbox.validateBranch", ["check-ref-format", "--branch", name]);
    if (valid.exitCode !== 0) return yield* failure(`${branch} isn't a branch in this project.`);
    const origin = yield* run("sandbox.source", ["remote", "get-url", "origin"]);
    const cwd = project.workspaceRoot;
    let remote: { commitSha: string; remoteRefName: string } | null = null;
    if (startFromOrigin && local.exitCode === 0 && origin.exitCode === 0) {
      yield* git
        .fetchRemote({ cwd, remoteName: "origin", refName: name })
        .pipe(Effect.mapError(() => failure(`Couldn't fetch ${name} from origin.`)));
      if (yield* git.remoteBranchExists({ cwd, remoteName: "origin", refName: name }))
        remote = yield* git.resolveRemoteTrackingCommit({
          cwd,
          refName: name,
          fallbackRemoteName: "origin",
        });
    }
    const authorName = (yield* run("sandbox.authorName", ["config", "user.name"])).stdout.trim();
    const authorEmail = (yield* run("sandbox.authorEmail", ["config", "user.email"])).stdout.trim();
    return yield* decodeSource({
      repositoryUrl: origin.exitCode === 0 ? withoutCredentials(origin.stdout.trim()) : null,
      branch: name,
      commit: remote?.commitSha ?? resolved.stdout.trim(),
      projectTitle: project.title,
      ...(remote ? { remoteRef: remote.remoteRefName } : {}),
      ...(authorName && authorEmail ? { author: { name: authorName, email: authorEmail } } : {}),
    });
  },
  Effect.mapError((error) =>
    isSubmissionError(error) ? error : failure("Couldn't read the branch from this project."),
  ),
);

/** Packs one commit and its tree, the objects a depth-1 clone receives. */
export const packSandboxSource = Effect.fnUntraced(
  function* (workspaceRoot: string, commit: string) {
    const git = yield* GitVcsDriver;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-source-" });
    const packed = yield* git.execute({
      operation: "sandbox.packSource",
      cwd: workspaceRoot,
      args: ["pack-objects", "-q", "--revs", path.join(directory, "source")],
      stdin: `--shallow ${commit}\n${commit}\n`,
      timeoutMs: null,
    });
    return yield* fs.readFile(path.join(directory, `source-${packed.stdout.trim()}.pack`));
  },
  Effect.scoped,
  Effect.mapError(() => failure("Couldn't pack the branch from this project.")),
);
