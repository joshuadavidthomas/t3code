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

// A host repo and a sandbox seeded from its commit like a launch. "Setup" installs an
// ignored node_modules, recorded the way the sandbox records what setup made. Then work of
// every kind: a new commit and branch, a stash, staged, modified, deleted and untracked
// files, a tracked file under a node_modules folder, and ignored files setup didn't make.
const scenario = `set -eu
git init -q host && cd host
git config user.email t@example.com && git config user.name T
echo base > a.txt && echo gone > d.txt && head -c 200000 /dev/urandom > big.bin
mkdir -p fixtures/node_modules/pkg && echo tracked > fixtures/node_modules/pkg/index.js
printf 'node_modules/\\ndist/\\n.env\\n' > .gitignore
git add -f . && git commit -qm base
seed=$(git rev-parse HEAD) && cd ..
printf -- '--shallow %s\\n%s\\n' $seed $seed | git -C host pack-objects -q --revs "$PWD/seed" >/dev/null
seed_objects() { git init -q "$1" && git -C "$1" index-pack --stdin < seed-*.pack >/dev/null; }
seed_objects sandbox && echo $seed > sandbox/.git/shallow && git -C sandbox checkout -q -B main $seed
cd sandbox && git config user.email t@example.com && git config user.name T
mkdir -p node_modules/dep && echo dependency > node_modules/dep/index.js
git ls-files -z --others --ignored --exclude-standard --directory > ../setup-made
echo two > b.txt && git add b.txt && git commit -qm two
git checkout -q -b side && echo side > s.txt && git add s.txt && git commit -qm side && git checkout -q main
echo stashed > st.txt && git add st.txt && git stash -q
echo modified >> a.txt && echo staged > c.txt && git add c.txt && echo untracked > u.txt && rm d.txt
echo changed > fixtures/node_modules/pkg/index.js
echo secret > .env && mkdir -p dist && echo built > dist/out.js
echo added > node_modules/dep/extra.js
cd .. && seed_objects restored && seed_objects whole && echo $seed > seed.txt`;

const snapshot = (repo: string) => `cd ${repo}
git status --short
git log --oneline --all
git stash list
cat .env dist/out.js fixtures/node_modules/pkg/index.js`;

const exists = (path: string) => bash(`test -e ${path} && echo kept || echo skipped`, ".");

const save = (root: string, setupMade: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const seed = (yield* fs.readFileString(`${root}/seed.txt`)).trim();
    yield* bash(
      saveWorkspaceScript({ workspace: "sandbox", out: `${root}/save`, seed, setupMade }),
      root,
    );
    yield* bash(restoreWorkspaceScript({ workspace: "restored", from: `${root}/save` }), root);
  });

it.effect("saves the work on top of the seed, skipping only what setup made", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-save-" });
    yield* bash(scenario, root);
    yield* save(root, `${root}/setup-made`);
    // Nothing from the seed or from setup: a few KB for this work.
    expect(Number(yield* bash(`du -sb save | cut -f1`, root))).toBeLessThan(64 * 1024);

    expect(yield* bash(snapshot("restored"), root)).toBe(yield* bash(snapshot("sandbox"), root));
    expect(yield* bash(`git -C restored fsck --no-dangling`, root)).toBe("");
    // Setup runs again on restore to bring node_modules back; everything else is here.
    expect(yield* exists(`${root}/restored/node_modules`)).toBe("skipped");
    expect(yield* bash(`diff -r -x .git -x node_modules sandbox restored && echo same`, root)).toBe(
      "same",
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("keeps every ignored file when setup made nothing it can make again", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-save-" });
    yield* bash(scenario, root);
    yield* save(root, `${root}/no-setup`);
    expect(yield* bash(`diff -r -x .git sandbox restored && echo same`, root)).toBe("same");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("saves a workspace whole when the seed is gone, still skipping what setup made", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-save-" });
    yield* bash(scenario, root);
    yield* bash(`rm -rf whole && mkdir whole`, root);
    yield* bash(
      saveWholeWorkspaceScript({
        workspace: "sandbox",
        out: `${root}/save`,
        setupMade: `${root}/setup-made`,
      }),
      root,
    );
    yield* bash(restoreWholeWorkspaceScript({ workspace: "whole", from: `${root}/save` }), root);
    expect(yield* bash(snapshot("whole"), root)).toBe(yield* bash(snapshot("sandbox"), root));
    expect(yield* exists(`${root}/whole/node_modules`)).toBe("skipped");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("saves a workspace with no work at all", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-save-" });
    yield* bash(scenario, root);
    yield* bash(`cd sandbox && git stash clear && git reset -q --hard && git clean -qfdx`, root);
    yield* save(root, `${root}/setup-made`);
    expect(yield* bash(`git -C restored status --short --ignored`, root)).toBe("");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("leaves the seed out when the only new commits are parentless checkpoints", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-save-" });
    yield* bash(scenario, root);
    // No commit on top of the seed, only a checkpoint of the working tree as T3 takes one.
    const seed = (yield* fs.readFileString(`${root}/seed.txt`)).trim();
    yield* bash(
      `cd sandbox && git stash clear && git branch -qD side && git reset -q --soft ${seed} && git reflog expire --expire=now --all
git update-ref refs/t3/checkpoint $(git commit-tree $(git write-tree) -m checkpoint)`,
      root,
    );
    yield* save(root, `${root}/setup-made`);
    expect(Number(yield* bash(`du -sb save | cut -f1`, root))).toBeLessThan(64 * 1024);
    expect(yield* bash(`git -C restored cat-file -t refs/t3/checkpoint`, root)).toBe("commit");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
