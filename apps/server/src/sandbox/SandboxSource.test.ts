import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { packSandboxSource, resolveSandboxSource, withoutCredentials } from "./SandboxSource.ts";

const layer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sandbox-source-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "SandboxSource.test", cwd, args });
    return result.stdout.trim();
  });

const commit = (cwd: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(cwd, file), file);
    yield* git(cwd, ["add", file]);
    yield* git(cwd, ["commit", "-m", file]);
    return yield* git(cwd, ["rev-parse", "HEAD"]);
  });

const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-source-" });
  yield* git(cwd, ["init", "--initial-branch=main"]);
  yield* git(cwd, ["config", "user.email", "test@example.com"]);
  yield* git(cwd, ["config", "user.name", "Test User"]);
  yield* commit(cwd, "base");
  return cwd;
});

it.effect("pins an unpublished local branch without contacting its remote", () =>
  Effect.gen(function* () {
    const cwd = yield* repository;
    yield* git(cwd, ["remote", "add", "origin", "https://user:secret@git.example/team/app.git"]);
    yield* git(cwd, ["switch", "-c", "local-only"]);
    const head = yield* commit(cwd, "unpublished");
    expect(yield* resolveSandboxSource({ workspaceRoot: cwd, title: "App" }, "local-only")).toEqual(
      {
        repositoryUrl: "https://git.example/team/app.git",
        branch: "local-only",
        commit: head,
        projectTitle: "App",
      },
    );
    const missing = yield* Effect.flip(
      resolveSandboxSource({ workspaceRoot: cwd, title: "App" }, "absent"),
    );
    expect(missing.message).toBe("absent isn't a branch in this project.");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("starts a local branch from a remote-tracking pick and allows no origin", () =>
  Effect.gen(function* () {
    const cwd = yield* repository;
    const head = yield* git(cwd, ["rev-parse", "HEAD"]);
    yield* git(cwd, ["update-ref", "refs/remotes/upstream/feature", head]);
    expect(
      yield* resolveSandboxSource({ workspaceRoot: cwd, title: "App" }, "upstream/feature"),
    ).toEqual({ repositoryUrl: null, branch: "feature", commit: head, projectTitle: "App" });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("seeds a fresh repository with exactly the pinned commit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* repository;
    const head = yield* commit(cwd, "second");
    yield* commit(cwd, "after-pin");
    const pack = yield* packSandboxSource(cwd, head);
    // The sandbox's steps, with the pack indexed in place rather than from stdin.
    const sandbox = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-seeded-" });
    const workspace = path.join(sandbox, "project");
    yield* fs.makeDirectory(workspace);
    yield* git(workspace, ["init", "--initial-branch=main"]);
    const packed = path.join(workspace, ".git", "objects", "pack", "source.pack");
    yield* fs.writeFile(packed, pack);
    yield* git(workspace, ["index-pack", packed]);
    yield* fs.writeFileString(path.join(workspace, ".git", "shallow"), `${head}\n`);
    yield* git(workspace, ["checkout", "-q", "-B", "feature", head]);
    expect(yield* git(workspace, ["rev-parse", "HEAD"])).toBe(head);
    expect(yield* git(workspace, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(yield* git(workspace, ["ls-files"])).toBe("base\nsecond");
    expect(yield* git(workspace, ["fsck", "--connectivity-only"])).toBe("");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it("strips credentials from remote URLs but keeps SSH users", () => {
  expect(withoutCredentials("https://x-access-token:ghp_secret@github.com/a/b.git")).toBe(
    "https://github.com/a/b.git",
  );
  expect(withoutCredentials("ssh://git@host.example/a/b.git")).toBe(
    "ssh://git@host.example/a/b.git",
  );
  expect(withoutCredentials("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
  expect(withoutCredentials("")).toBeNull();
});
