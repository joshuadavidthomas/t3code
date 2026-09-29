import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { type ProjectId, SandboxSubmissionError } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitHubCli } from "../sourceControl/GitHubCli.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ServerConfig } from "../config.ts";
import {
  resolveCurrentSandboxArtifact,
  resolveCapturedSandboxArtifact,
} from "./SandboxArtifact.ts";
import type { SandboxProvisioner, SandboxSourcePacker } from "./SandboxSubmissions.ts";
import { packSandboxSource, resolveSandboxSource } from "./SandboxSource.ts";
import { makeSandboxSaves } from "./SandboxSaves.ts";
import { makeSpritesClient } from "./SpritesClient.ts";
import { makeSpritesProvisioner } from "./SpritesProvisioner.ts";

const failure = (message: string) => new SandboxSubmissionError({ code: "invalid", message });

/** Resolve the runtime on first preflight, without delaying ordinary server startup. */
export const makeConfiguredSandboxProvisioner = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const projects = yield* ProjectionSnapshotQuery;
  const git = yield* GitVcsDriver;
  const github = yield* GitHubCli;
  const http = yield* HttpClient.HttpClient;
  const currentArtifact = yield* Effect.cachedWithTTL(
    resolveCurrentSandboxArtifact().pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, config),
      Effect.provideService(HttpClient.HttpClient, http),
    ),
    (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  );
  const socket = yield* Socket.WebSocketConstructor.pipe(
    Effect.provide(NodeSocket.layerWebSocketConstructor),
  );
  const findProject = (projectId: ProjectId) =>
    projects.getProjectShellById(projectId).pipe(
      Effect.mapError(() => failure("This project is no longer available.")),
      Effect.flatMap(
        Option.match({
          onNone: () => failure("This project is no longer available."),
          onSome: Effect.succeed,
        }),
      ),
    );
  const resolveSource: SandboxProvisioner["resolveSource"] = (input) =>
    findProject(input.projectId).pipe(
      Effect.flatMap((project) =>
        resolveSandboxSource(project, input.branch, input.startFromOrigin === true),
      ),
      Effect.provideService(GitVcsDriver, git),
    );
  // Sandboxes run on your own account, so they share the host's GitHub login, the
  // token T3's GitHub calls already use here. A host without one launches unsigned.
  const gitHubCredential: SandboxProvisioner["gitHubCredential"] = (input) =>
    findProject(input.projectId).pipe(
      Effect.flatMap((project) =>
        github.execute({
          cwd: project.workspaceRoot,
          args: ["auth", "token", "--hostname", "github.com"],
          env: { GH_DEBUG: "" },
        }),
      ),
      Effect.map((output) => output.stdout.trim() || null),
      Effect.orElseSucceed(() => null),
    );
  const packSource: SandboxSourcePacker = (submission) =>
    findProject(submission.input.projectId).pipe(
      Effect.flatMap((project) =>
        packSandboxSource(project.workspaceRoot, submission.source.commit),
      ),
      Effect.provideService(GitVcsDriver, git),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  // A save leaves the seed commit out when the host's repo can still provide it.
  const hasSource = (submission: Parameters<SandboxSourcePacker>[0]) =>
    findProject(submission.input.projectId).pipe(
      Effect.flatMap((project) =>
        git.execute({
          operation: "sandbox.hasSource",
          cwd: project.workspaceRoot,
          args: ["cat-file", "-e", `${submission.source.commit}^{commit}`],
          allowNonZeroExit: true,
        }),
      ),
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );
  // Saved sandboxes live in the host's T3 home, next to its settings and secrets.
  const saves = yield* makeSandboxSaves(path.join(path.dirname(config.settingsPath), "sandboxes"));
  const provisioner = yield* makeSpritesProvisioner(
    null,
    resolveSource,
    packSource,
    hasSource,
    saves,
    (credential) =>
      makeSpritesClient(credential).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(Socket.WebSocketConstructor, socket),
      ),
    (runtime) =>
      resolveCapturedSandboxArtifact(runtime.artifactIntegrity).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, config),
        Effect.mapError(
          () =>
            new SandboxSubmissionError({
              code: "unavailable",
              message: "Accepted sandbox runtime artifact is unavailable.",
            }),
        ),
      ),
  );
  return {
    ...provisioner,
    gitHubCredential,
    getRuntime: currentArtifact.pipe(
      Effect.map((artifact) => artifact.runtime),
      Effect.orElseSucceed(() => null),
    ),
  } satisfies SandboxProvisioner;
});
