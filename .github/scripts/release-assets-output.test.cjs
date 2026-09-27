const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const workflow = readFileSync(join(__dirname, "../workflows/release.yml"), "utf8");
const step = workflow.match(
  /- id: release_files\n        name: Resolve release asset list\n[\s\S]*?        run: \|\n((?:          .*\n|\n)+)/,
);
assert.ok(step, "Could not find the release asset list workflow step");
const script = step[1]
  .replace(/^          /gm, "")
  .replace(/\$\{\{ needs\.preflight\.outputs\.release_channel \}\}/g, "$RELEASE_CHANNEL");

const commonAssets = [
  "T3-Code.dmg",
  "T3-Code-mac.zip",
  "T3-Code.AppImage",
  "T3-Code.exe",
  "t3-linux-x64.tar.gz",
  "t3-win32-x64.zip",
  "t3-1.2.3-linux-x64.tar.gz.sandbox.json",
  "SHA256SUMS",
];
const updaterAssets = ["T3-Code.exe.blockmap", "latest.yml"];

function runStep(channel) {
  const fixture = mkdtempSync(join(tmpdir(), `t3-release-assets-${channel}-`));
  try {
    const assets = channel === "preview" ? commonAssets : [...commonAssets, ...updaterAssets];
    mkdirSync(join(fixture, "release-assets"));
    for (const asset of assets) writeFileSync(join(fixture, "release-assets", asset), "fixture");

    const output = join(fixture, "github-output");
    const result = spawnSync(
      "bash",
      [
        "-c",
        script +
          "\nmapfile -t patterns < <(sed -n '/^files<<EOF$/,/^EOF$/{ /^files<<EOF$/d; /^EOF$/d; p; }' \"$GITHUB_OUTPUT\")\n" +
          "shopt -s nullglob\n" +
          'for pattern in "${patterns[@]}"; do matches=($pattern); [[ ${#matches[@]} -gt 0 ]] || exit 2; printf \'%s\\n\' "${matches[@]}"; done\n',
      ],
      {
        cwd: fixture,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: output,
          RELEASE_CHANNEL: channel,
        },
      },
    );
    assert.ifError(result.error);
    return { result, assets };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

for (const channel of ["stable", "nightly", "preview"]) {
  test(`resolves complete ${channel} release asset list`, () => {
    const { result, assets } = runStep(channel);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.stdout.trim().split("\n").sort(),
      assets.map((asset) => `release-assets/${asset}`).sort(),
    );
    assert.match(result.stdout, /release-assets\/t3-1\.2\.3-linux-x64\.tar\.gz\.sandbox\.json/);
    if (channel === "preview") assert.doesNotMatch(result.stdout, /(?:\.blockmap|\.yml)$/m);
  });
}
