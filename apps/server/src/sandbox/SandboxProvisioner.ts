import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { SandboxPinnedSource, SandboxSubmissionError } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ServerConfig } from "../config.ts";
import {
  resolveCurrentSandboxArtifact,
  resolveCapturedSandboxArtifact,
} from "./SandboxArtifact.ts";
import type { SandboxProvisioner } from "./SandboxSubmissions.ts";
import { makeSpritesClient } from "./SpritesClient.ts";
import { makeSpritesProvisioner } from "./SpritesProvisioner.ts";

const failure = () =>
  new SandboxSubmissionError({
    code: "invalid",
    message: "Choose a published branch in a public GitHub repository.",
  });
const decodeBranch = Schema.decodeUnknownEffect(
  Schema.Struct({ commit: Schema.Struct({ sha: Schema.String }) }),
);
const decodeSource = Schema.decodeUnknownEffect(SandboxPinnedSource);

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
  const resolveSource: SandboxProvisioner["resolveSource"] = (input) =>
    Effect.gen(function* () {
      const project = yield* projects.getProjectShellById(input.projectId);
      if (Option.isNone(project)) return yield* failure();
      const cwd = project.value.workspaceRoot;
      yield* git.execute({
        operation: "sandbox.validateBranch",
        cwd,
        args: ["check-ref-format", "--branch", input.branch],
      });
      const remote = yield* git.execute({
        operation: "sandbox.source",
        cwd,
        args: ["remote", "get-url", "origin"],
      });
      const match =
        /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
          remote.stdout.trim(),
        );
      if (!match) return yield* failure();
      const repositoryUrl = `https://github.com/${match[1]}/${match[2]}`;
      // An unauthenticated lookup both resolves the published branch and excludes private repositories.
      const response = yield* http.execute(
        HttpClientRequest.get(
          `https://api.github.com/repos/${match[1]}/${match[2]}/branches/${encodeURIComponent(input.branch)}`,
        ).pipe(HttpClientRequest.setHeader("Accept", "application/vnd.github+json")),
      );
      if (response.status !== 200) return yield* failure();
      const branch = yield* response.json.pipe(Effect.flatMap(decodeBranch));
      return yield* decodeSource({
        repositoryUrl,
        branch: input.branch,
        commit: branch.commit.sha,
      });
    }).pipe(Effect.mapError(failure));
  const provisioner = yield* makeSpritesProvisioner(
    null,
    resolveSource,
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
