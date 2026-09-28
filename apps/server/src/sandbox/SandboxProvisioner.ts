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
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ServerConfig } from "../config.ts";
import {
  resolveCurrentSandboxArtifact,
  resolveCapturedSandboxArtifact,
} from "./SandboxArtifact.ts";
import type { SandboxProvisioner, SandboxSourcePacker } from "./SandboxSubmissions.ts";
import { packSandboxSource, resolveSandboxSource } from "./SandboxSource.ts";
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
  const packSource: SandboxSourcePacker = (submission) =>
    findProject(submission.input.projectId).pipe(
      Effect.flatMap((project) =>
        packSandboxSource(project.workspaceRoot, submission.source.commit),
      ),
      Effect.provideService(GitVcsDriver, git),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const provisioner = yield* makeSpritesProvisioner(
    null,
    resolveSource,
    packSource,
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
    getRuntime: currentArtifact.pipe(
      Effect.map((artifact) => artifact.runtime),
      Effect.orElseSucceed(() => null),
    ),
  } satisfies SandboxProvisioner;
});
