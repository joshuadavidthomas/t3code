import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ProcessRunner from "../processRunner.ts";
import {
  restoreWholeWorkspaceScript,
  restoreWorkspaceScript,
  saveWholeWorkspaceScript,
  saveWorkspaceScript,
} from "./SandboxWorkspaceSave.ts";

const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const bash = (script: string, cwd: string) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const result = yield* runner.run({ command: "bash", args: ["-c", script], cwd });
    if (result.code !== 0) throw new Error(`bash failed: ${result.stderr}`);
    return result.stdout.trim();
  });

// A host repo, a sandbox seeded from its commit like a launch, and work of every kind:
// a new commit and branch, a stash, staged, modified, deleted and untracked files, an
// ignored secret, an ignored node_modules and a tracked file under a node_modules folder.
const scenario = `set -eu
git init -q host && cd host
git config user.email t@example.com && git config user.name T
echo base > a.txt && echo gone > d.txt
mkdir -p fixtures/node_modules/pkg && echo tracked > fixtures/node_modules/pkg/index.js
printf 'node_modules/\\n' > .gitignore
git add -f . && git commit -qm base
seed=$(git rev-parse HEAD) && cd ..
printf -- '--shallow %s\\n%s\\n' $seed $seed | git -C host pack-objects -q --revs "$PWD/seed" >/dev/null
seed_objects() { git init -q "$1" && git -C "$1" index-pack --stdin < seed-*.pack >/dev/null; }
seed_objects sandbox && echo $seed > sandbox/.git/shallow && git -C sandbox checkout -q -B main $seed
cd sandbox && git config user.email t@example.com && git config user.name T
echo two > b.txt && git add b.txt && git commit -qm two
git checkout -q -b side && echo side > s.txt && git add s.txt && git commit -qm side && git checkout -q main
echo stashed > st.txt && git add st.txt && git stash -q
echo modified >> a.txt && echo staged > c.txt && git add c.txt && echo untracked > u.txt && rm d.txt
echo changed > fixtures/node_modules/pkg/index.js
echo secret > .env && echo .env >> .git/info/exclude
mkdir -p node_modules/dep && echo dependency > node_modules/dep/index.js
cd .. && seed_objects restored && seed_objects whole && echo $seed > seed.txt`;

const snapshot = (repo: string) => `cd ${repo}
git status --short
git log --oneline --all
git stash list
cat .env fixtures/node_modules/pkg/index.js`;

it.effect("saves only the work on top of the seed and restores it exactly", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-save-" });
    yield* bash(scenario, root);
    const seed = yield* fs.readFileString(`${root}/seed.txt`);
    yield* bash(
      saveWorkspaceScript({ workspace: "sandbox", out: `${root}/save`, seed: seed.trim() }),
      root,
    );
    // Nothing from the seed itself: a few KB for this work.
    const size = Number(yield* bash(`du -sb save | cut -f1`, root));
    expect(size).toBeLessThan(64 * 1024);
    yield* bash(restoreWorkspaceScript({ workspace: "restored", from: `${root}/save` }), root);

    expect(yield* bash(snapshot("restored"), root)).toBe(yield* bash(snapshot("sandbox"), root));
    expect(yield* bash(`git -C restored fsck --no-dangling`, root)).toBe("");
    // Ignored dependencies reinstall; everything else comes back.
    expect(yield* bash(`test -e restored/node_modules && echo kept || echo skipped`, root)).toBe(
      "skipped",
    );
    expect(yield* bash(`diff -r -x .git -x node_modules sandbox restored && echo same`, root)).toBe(
      "same",
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("saves a workspace whole when the seed is gone, keeping tracked node_modules", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-save-" });
    yield* bash(scenario, root);
    yield* bash(`rm -rf whole && mkdir whole`, root);
    yield* bash(saveWholeWorkspaceScript({ workspace: "sandbox", out: `${root}/save` }), root);
    yield* bash(restoreWholeWorkspaceScript({ workspace: "whole", from: `${root}/save` }), root);
    expect(yield* bash(snapshot("whole"), root)).toBe(yield* bash(snapshot("sandbox"), root));
    expect(yield* bash(`test -e whole/node_modules && echo kept || echo skipped`, root)).toBe(
      "skipped",
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("saves a workspace with no work at all", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-save-" });
    yield* bash(scenario, root);
    yield* bash(`cd sandbox && git stash clear && git reset -q --hard && git clean -qfd`, root);
    const seed = (yield* fs.readFileString(`${root}/seed.txt`)).trim();
    yield* bash(saveWorkspaceScript({ workspace: "sandbox", out: `${root}/save`, seed }), root);
    yield* bash(restoreWorkspaceScript({ workspace: "restored", from: `${root}/save` }), root);
    expect(yield* bash(`git -C restored status --short`, root)).toBe("");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
