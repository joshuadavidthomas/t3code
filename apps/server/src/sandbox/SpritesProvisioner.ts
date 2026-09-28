import {
  type ProviderInstanceConfigMap,
  SandboxDestination,
  SandboxRuntimeManifest,
  SandboxSubmissionError,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { loadSandboxArtifact } from "./SandboxArtifact.ts";
import { SANDBOX_WORKSPACE_ROOT } from "./SandboxDeployment.ts";
import { SandboxIntakeRequest } from "./SandboxIntakeRoutes.ts";
import { SandboxResources } from "./SandboxResources.ts";
import { makeSandboxRuntimeCatalog } from "./SandboxRuntime.ts";
import type { SandboxProvisioner, SandboxSourcePacker } from "./SandboxSubmissions.ts";
import type { SpritesClient } from "./SpritesClient.ts";

const ROOT = "/home/sprite/t3";
const WORKSPACE = SANDBOX_WORKSPACE_ROOT;
// T3's GitHub support needs a newer gh than Sprite images ship.
const GH_VERSION = "2.101.0";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const failure = (message: string) => new SandboxSubmissionError({ code: "unavailable", message });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRuntime = Schema.decodeUnknownEffect(Schema.fromJsonString(SandboxRuntimeManifest));
const decodeDestination = Schema.decodeUnknownEffect(Schema.fromJsonString(SandboxDestination));
const encodeIntake = Schema.encodeEffect(Schema.fromJsonString(SandboxIntakeRequest));
const decodePairing = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String })),
);

// Each control request gets a short-lived token that replaces the previous one; callers
// hold setup.lock, so requests never race each other's token.
const issueControlSession = `set -eu
umask 077
${ROOT}/runtime/t3 auth session issue --base-dir ${ROOT}/state --subject sandbox-control --ttl 10m --replace-active --json > ${ROOT}/control-session.json`;

// Exec's stdin carries intake JSON; neither provider credentials nor the control token
// are placed in command arguments. The control token never leaves the sandbox.
const request = (path: string, method = "GET") => `set -eu
${issueControlSession}
node -e ${quote(`const fs = require('node:fs');
const http = require('node:http');
const token = JSON.parse(fs.readFileSync('${ROOT}/control-session.json', 'utf8')).token;
const req = http.request({host:'127.0.0.1',port:8080,path:'${path}',method:'${method}',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}}, res => {
  if(res.statusCode !== 200) { res.resume(); process.exitCode=1; return; }
  res.pipe(process.stdout);
});
req.setTimeout(60000, () => req.destroy());
req.on('error', () => {process.exitCode=1});
process.stdin.pipe(req);`)}
`;

// The Sprite image ships its own older Claude on the login shell's PATH, which T3
// puts ahead of the service PATH, so name the pinned install explicitly.
const withInstalledClaude = (instances: ProviderInstanceConfigMap): ProviderInstanceConfigMap =>
  Object.fromEntries(
    Object.entries(instances).map(([id, instance]) => [
      id,
      instance.driver === "claudeAgent"
        ? {
            ...instance,
            config: {
              ...(Predicate.isObject(instance.config) ? instance.config : {}),
              binaryPath: `${ROOT}/providers/bin/claude`,
            },
          }
        : instance,
    ]),
  );

/** Reconciles each named stage against a persisted resource and an immutable artifact. */
export const makeSpritesProvisioner = Effect.fnUntraced(function* (
  artifact: Effect.Success<ReturnType<typeof loadSandboxArtifact>> | null,
  resolveSource: SandboxProvisioner["resolveSource"],
  packSource: SandboxSourcePacker,
  client: (credential: string) => Effect.Effect<SpritesClient>,
  resolveArtifact: (
    runtime: typeof SandboxRuntimeManifest.Type,
  ) => Effect.Effect<
    Effect.Success<ReturnType<typeof loadSandboxArtifact>>,
    SandboxSubmissionError
  > = (runtime) =>
    artifact && artifact.runtime.artifactIntegrity === runtime.artifactIntegrity
      ? Effect.succeed(artifact)
      : Effect.fail(failure("Accepted sandbox runtime artifact is unavailable.")),
) {
  const resources = yield* SandboxResources;
  const fs = yield* FileSystem.FileSystem;
  const stage: SandboxProvisioner["stage"] = Effect.fnUntraced(
    function* (stage, submission, secrets) {
      const selectedArtifact = yield* resolveArtifact(submission.runtime);
      const selectedClaude = selectedArtifact.runtime.providers.find(
        (provider) => provider.driver === "claudeAgent",
      );
      if (!selectedClaude || selectedArtifact.runtime.providers.length !== 1)
        return yield* failure("Sandbox artifact provider is unavailable or unsupported.");
      const resource = yield* resources.getOrCreate(submission, secrets.namePrefix);
      const sprites = yield* client(secrets.credential);
      if (stage === "create") {
        const existing = yield* sprites.find(resource.name);
        if (resource.sprite && (!existing || existing.id !== resource.sprite.id))
          return yield* failure("The bound sandbox is unavailable.");
        const sprite = existing ?? (yield* sprites.create(resource.name));
        yield* resources.bindSprite(submission.input.commandId, sprite);
        return { resourceName: resource.name };
      }
      if (!resource.sprite) return yield* failure("Sandbox has not been created.");
      const exec = (script: string, input = "") =>
        sprites.exec(
          resource.name,
          `set -eu
mkdir -p ${ROOT}
exec 9>${ROOT}/setup.lock
flock 9
${script}`,
          input,
        );
      if (stage === "runtime") {
        const bytes = yield* fs
          .readFile(selectedArtifact.archivePath)
          .pipe(Effect.mapError(() => failure("Sandbox artifact is unavailable.")));
        const upload = `runtime-${NodeCrypto.randomUUID()}.tar.gz`;
        yield* sprites.upload(resource.name, `${ROOT}/${upload}`, bytes);
        yield* exec(`set -eu
umask 077
cd ${ROOT}
trap 'rm -f ${upload}' EXIT
printf '%s  ${upload}\\n' ${quote(selectedArtifact.runtime.artifactIntegrity.slice(7))} | sha256sum -c - >/dev/null
if [ ! -f runtime/t3 ]; then
  rm -rf runtime.tmp
  mkdir runtime.tmp
  tar -xzf ${upload} --strip-components=1 -C runtime.tmp
  mv runtime.tmp runtime
fi
runtime/t3 sandbox-runtime-manifest --artifact-integrity ${quote(selectedArtifact.runtime.artifactIntegrity)}
`).pipe(
          Effect.flatMap(decodeRuntime),
          Effect.flatMap((runtime) =>
            NodeUtil.isDeepStrictEqual(runtime, selectedArtifact.runtime)
              ? Effect.void
              : Effect.fail(failure("Installed sandbox runtime does not match its artifact.")),
          ),
          Effect.mapError(() => failure("Sandbox runtime verification failed.")),
        );
        return;
      }
      if (stage === "server") {
        const deployment = yield* encodeJson({
          artifactIntegrity: selectedArtifact.runtime.artifactIntegrity,
          workspaceRoot: WORKSPACE,
          // The Sprite's own name, so the environment matches the Sprites dashboard.
          label: resource.name,
        }).pipe(Effect.mapError(() => failure("Invalid sandbox deployment.")));
        yield* exec(
          `set -eu
umask 077
mkdir -p ${ROOT}/state/userdata
cat > ${ROOT}/state/userdata/sandbox-runtime.json
if [ ! -f ${ROOT}/claude-ready ]; then
  npm install --prefix ${ROOT}/providers -g @anthropic-ai/claude-code@${quote(selectedClaude.version)} > ${ROOT}/install.log 2>&1
  node ${ROOT}/providers/lib/node_modules/@anthropic-ai/claude-code/install.cjs >> ${ROOT}/install.log 2>&1
  touch ${ROOT}/claude-ready
fi
test "$(${ROOT}/providers/bin/claude --version | cut -d ' ' -f 1)" = ${quote(selectedClaude.version)}
if [ ! -f ${ROOT}/gh-ready ]; then
  case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; *) arch=amd64 ;; esac
  release=gh_${GH_VERSION}_linux_$arch
  cd ${ROOT}
  curl -fsSL -o $release.tar.gz https://github.com/cli/cli/releases/download/v${GH_VERSION}/$release.tar.gz
  curl -fsSL https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt | grep " $release.tar.gz$" | sha256sum -c - >/dev/null
  tar -xzf $release.tar.gz
  install -m 755 $release/bin/gh ${ROOT}/providers/bin/gh
  rm -rf $release $release.tar.gz
  touch ${ROOT}/gh-ready
fi
test "$(${ROOT}/providers/bin/gh --version | head -1 | cut -d ' ' -f 3)" = ${GH_VERSION}
if [ ! -f ${ROOT}/state/userdata/settings.json ]; then
  printf '%s\\n' '{"enableProviderUpdateChecks":false}' > ${ROOT}/state/userdata/settings.json
fi
`,
          deployment,
        );
        // Signed in like any machine: T3's git and gh calls use the ambient login.
        if (secrets.gitHubCredential)
          yield* exec(
            `${ROOT}/providers/bin/gh auth login --hostname github.com --with-token
${ROOT}/providers/bin/gh auth setup-git --hostname github.com
git config --global --unset-all url.https://github.com/.insteadOf || true
git config --global --add url.https://github.com/.insteadOf git@github.com:
git config --global --add url.https://github.com/.insteadOf ssh://git@github.com/
`,
            secrets.gitHubCredential,
          );
        return;
      }
      if (stage === "clone") {
        const { source } = submission;
        const upload = `source-${NodeCrypto.randomUUID()}.pack`;
        yield* sprites.upload(resource.name, `${ROOT}/${upload}`, yield* packSource(submission));
        yield* exec(`set -eu
cd ${ROOT}
trap 'rm -f ${upload}' EXIT
if [ ! -d ${WORKSPACE}/.git ]; then
  sudo install -d -o "$(id -u)" -g "$(id -g)" ${WORKSPACE}
  git -C ${WORKSPACE} init -q
fi
git -C ${WORKSPACE} index-pack --stdin < ${upload} >/dev/null
grep -qx ${quote(source.commit)} ${WORKSPACE}/.git/shallow 2>/dev/null || echo ${quote(source.commit)} >> ${WORKSPACE}/.git/shallow
git -C ${WORKSPACE} checkout -q -B ${quote(source.branch)} ${quote(source.commit)}
${
  source.repositoryUrl
    ? `git -C ${WORKSPACE} remote set-url origin ${quote(source.repositoryUrl)} 2>/dev/null ||
  git -C ${WORKSPACE} remote add origin ${quote(source.repositoryUrl)}`
    : ""
}
${
  source.author
    ? `git config --global user.name ${quote(source.author.name)}
git config --global user.email ${quote(source.author.email)}`
    : ""
}
test "$(git -C ${WORKSPACE} rev-parse HEAD)" = ${quote(source.commit)}
`);
        return;
      }
      yield* sprites.putService(resource.name, "t3", {
        cmd: `${ROOT}/runtime/t3`,
        args: [
          "serve",
          "--host",
          "0.0.0.0",
          "--port",
          "8080",
          "--no-browser",
          "--base-dir",
          `${ROOT}/state`,
        ],
        env: { PATH: `${ROOT}/providers/bin:/usr/local/bin:/usr/bin:/bin` },
        dir: WORKSPACE,
        http_port: 8080,
      });
      const runtime = yield* exec(request("/api/sandbox/runtime")).pipe(
        Effect.flatMap(decodeRuntime),
        Effect.mapError(() => failure("Sandbox server is not ready.")),
      );
      if (!NodeUtil.isDeepStrictEqual(runtime, selectedArtifact.runtime))
        return yield* failure("Sandbox server runtime does not match its artifact.");
      yield* sprites.makeUrlPublic(resource.name);
    },
  );
  const intake: SandboxProvisioner["intake"] = Effect.fnUntraced(function* (submission, secrets) {
    const resource = yield* resources.get(submission.input.commandId);
    const body = yield* encodeIntake({
      submission,
      providerInstances: withInstalledClaude(secrets.providerInstances),
    }).pipe(Effect.mapError(() => failure("Invalid sandbox intake.")));
    const sprites = yield* client(secrets.credential);
    const output = yield* sprites.exec(
      resource.name,
      `set -eu
mkdir -p ${ROOT}
exec 9>${ROOT}/setup.lock
flock 9
${request("/api/sandbox/intake", "POST")}`,
      body,
    );
    const destination = yield* decodeDestination(output).pipe(
      Effect.mapError(() => failure("Invalid sandbox intake receipt.")),
    );
    yield* resources.bindDestination(submission.input.commandId, destination);
    return destination;
  });
  const removeResource = Effect.fnUntraced(function* (
    submission: Parameters<SandboxProvisioner["cancel"]>[0],
    credential: string,
  ) {
    const resource = yield* resources.find(submission.input.commandId);
    if (!resource) return;
    if (resource.deletedAt) {
      yield* resources.markDeleted(submission.input.commandId, resource.deletedAt);
      return;
    }
    const sprites = yield* client(credential);
    const existing = yield* sprites.find(resource.name);
    if (existing && resource.sprite && existing.id !== resource.sprite.id)
      return yield* failure("Sandbox binding has changed.");
    if (existing) yield* sprites.remove(resource.name);
    yield* resources.markDeleted(
      submission.input.commandId,
      DateTime.formatIso(yield* DateTime.now),
    );
  });
  const cancel: SandboxProvisioner["cancel"] = removeResource;
  const remove: SandboxProvisioner["delete"] = removeResource;
  const pair: NonNullable<SandboxProvisioner["pair"]> = Effect.fnUntraced(
    function* (submission, secrets) {
      const resource = yield* resources.get(submission.input.commandId);
      if (resource.deletedAt || !resource.destination || !resource.sprite)
        return yield* failure("Sandbox destination is not ready.");
      const sprites = yield* client(secrets.credential);
      const output = yield* sprites.exec(
        resource.name,
        `${ROOT}/runtime/t3 auth pairing create --base-dir ${ROOT}/state --json`,
        "",
      );
      const issued = yield* decodePairing(output).pipe(
        Effect.mapError(() => failure("Could not issue sandbox pairing credential.")),
      );
      return {
        destination: resource.destination,
        url: resource.sprite.url,
        pairingToken: issued.credential,
      };
    },
  );
  return {
    catalog: makeSandboxRuntimeCatalog(),
    runtime: artifact?.runtime ?? null,
    resolveSource,
    stage,
    intake,
    cancel,
    delete: remove,
    pair,
  } satisfies SandboxProvisioner;
});
