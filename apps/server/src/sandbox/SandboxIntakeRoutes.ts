import {
  AuthOrchestrationOperateScope,
  CommandId,
  type OrchestrationShellSnapshot,
  ThreadId,
  AuthOrchestrationReadScope,
  ProjectId,
  ProviderInstanceConfigMap,
  SandboxSubmissionRecord,
  SandboxSubmissionError,
  type AuthEnvironmentScope,
  type SandboxDestination,
  type SandboxRuntimeManifest,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ServerConfig } from "../config.ts";
import { ProviderInstanceRegistryHydration } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { SANDBOX_SETUP_MADE_FILE, readSandboxDeployment } from "./SandboxDeployment.ts";
import { makeSandboxIntake } from "./SandboxIntake.ts";
import { makeSandboxRuntimeManifest } from "./SandboxRuntime.ts";

/** Restoring a saved sandbox unarchives the thread the user picked. */
export const SandboxUnarchiveRequest = Schema.Struct({ threadId: ThreadId });

export interface SandboxLifecycle {
  /** The archived threads to save, refused while any thread is still active. */
  readonly savable: Effect.Effect<OrchestrationShellSnapshot, SandboxSubmissionError>;
  readonly unarchive: (threadId: ThreadId) => Effect.Effect<void, SandboxSubmissionError>;
}

const unavailableThreads = () =>
  new SandboxSubmissionError({ code: "unavailable", message: "Sandbox threads are unavailable." });

/** Saving and restoring, from the sandbox's side. */
export const makeSandboxLifecycle = (deps: {
  readonly snapshots: ProjectionSnapshotQuery["Service"];
  readonly dispatch: OrchestrationEngineService["Service"]["dispatch"];
  readonly runSetup: (threadId: ThreadId, projectId: ProjectId) => Effect.Effect<void>;
}): SandboxLifecycle => ({
  savable: Effect.gen(function* () {
    const active = yield* deps.snapshots.getShellSnapshot();
    if (active.threads.length > 0)
      return yield* new SandboxSubmissionError({
        code: "conflict",
        message: "This sandbox still has active threads.",
      });
    return yield* deps.snapshots.getArchivedShellSnapshot();
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(SandboxSubmissionError)(error) ? error : unavailableThreads(),
    ),
  ),
  unarchive: (threadId) =>
    Effect.gen(function* () {
      const thread = yield* deps.snapshots.getThreadShellById(threadId);
      // A retried restore finds the thread already back.
      if (Option.isSome(thread) && thread.value.archivedAt === null) return;
      yield* deps.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make(`sandbox-restore:${NodeCrypto.randomUUID()}`),
        threadId,
      });
      // The save left out what setup made; running it again brings that back.
      const restored = yield* deps.snapshots.getThreadShellById(threadId);
      if (Option.isSome(restored))
        yield* deps.runSetup(threadId, restored.value.projectId).pipe(Effect.forkDetach);
    }).pipe(Effect.mapError(unavailableThreads)),
});

export const SandboxIntakeRequest = Schema.Struct({
  submission: SandboxSubmissionRecord,
  providerInstances: ProviderInstanceConfigMap,
});

const authenticate = Effect.fnUntraced(function* (scope: AuthEnvironmentScope) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth;
  const session = yield* auth
    .authenticateHttpRequest(request)
    .pipe(Effect.mapError(() => HttpServerResponse.empty({ status: 401 })));
  if (!session.scopes.includes(scope)) {
    return yield* Effect.fail(HttpServerResponse.empty({ status: 403 }));
  }
});

const respond = (cause: HttpServerResponse.HttpServerResponse | SandboxSubmissionError) =>
  Effect.succeed(
    HttpServerResponse.isHttpServerResponse(cause)
      ? cause
      : HttpServerResponse.jsonUnsafe(cause, {
          status:
            cause.code === "invalid"
              ? 400
              : cause.code === "conflict" || cause.code === "unsupported"
                ? 409
                : 503,
        }),
  );

export const makeSandboxIntakeRoutes = (
  runtime: SandboxRuntimeManifest,
  accept: (
    input: typeof SandboxIntakeRequest.Type,
  ) => Effect.Effect<SandboxDestination, SandboxSubmissionError>,
  lifecycle: SandboxLifecycle,
) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/sandbox/runtime",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        return HttpServerResponse.jsonUnsafe(runtime);
      }).pipe(Effect.catch(respond)),
    ),
    HttpRouter.add(
      "POST",
      "/api/sandbox/intake",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(SandboxIntakeRequest)),
          Effect.mapError(
            () =>
              new SandboxSubmissionError({ code: "invalid", message: "Invalid sandbox intake." }),
          ),
        );
        return HttpServerResponse.jsonUnsafe(yield* accept(input));
      }).pipe(Effect.catch(respond)),
    ),
    HttpRouter.add(
      "GET",
      "/api/sandbox/save",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        return HttpServerResponse.jsonUnsafe(yield* lifecycle.savable);
      }).pipe(Effect.catch(respond)),
    ),
    HttpRouter.add(
      "POST",
      "/api/sandbox/unarchive",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(SandboxUnarchiveRequest)),
          Effect.mapError(
            () =>
              new SandboxSubmissionError({
                code: "invalid",
                message: "Invalid thread to restore.",
              }),
          ),
        );
        yield* lifecycle.unarchive(input.threadId);
        return HttpServerResponse.empty({ status: 204 });
      }).pipe(Effect.catch(respond)),
    ),
  );

/** Normal servers don't expose intake. Bootstrap opts a fresh destination into it. */
export const sandboxIntakeRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const deployment = yield* readSandboxDeployment;
    if (!deployment) return Layer.empty;
    const environment = yield* ServerEnvironmentIdentity;
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const settings = yield* ProviderInstanceRegistryHydration;
    const registry = yield* ProviderInstanceRegistry;
    const setupScripts = yield* ProjectSetupScriptRunner;
    const git = yield* GitVcsDriver;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const root = deployment.workspaceRoot;
    // What setup makes, it makes again on restore, so a save can leave it out.
    const recordSetupMade = git
      .execute({
        operation: "sandbox.setupMade",
        cwd: root,
        args: ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
      })
      .pipe(
        Effect.flatMap((listed) =>
          fs.writeFileString(path.join(config.stateDir, SANDBOX_SETUP_MADE_FILE), listed.stdout),
        ),
      );
    // Like a new worktree: the agent waits only when the script asks it to.
    const runSetup = (threadId: ThreadId, projectId: ProjectId) =>
      setupScripts
        .runForThread({
          threadId,
          projectId,
          projectCwd: root,
          worktreePath: root,
          observeCompletion: {},
        })
        .pipe(
          Effect.flatMap((started) => {
            if (started.status !== "started" || !started.completion) return Effect.void;
            const settled = started.completion.pipe(
              Effect.flatMap(({ exitCode }) => (exitCode === 0 ? recordSetupMade : Effect.void)),
              Effect.ignoreCause({ log: true }),
            );
            return started.async ? Effect.asVoid(Effect.forkDetach(settled)) : settled;
          }),
          Effect.ignoreCause({ log: true }),
        );
    const runtime = makeSandboxRuntimeManifest(deployment.artifactIntegrity);
    const intake = yield* makeSandboxIntake({
      runtime,
      // The project's actions come from the host, so its setup script runs here too.
      prepareWorkspace: ({ threadId, projectId, scripts }) =>
        (scripts.length === 0
          ? Effect.void
          : settings.updateSettings({
              projectSettingsOverrides: { [projectId]: { defaultProjectScripts: scripts } },
            })
        ).pipe(Effect.ignoreCause({ log: true }), Effect.andThen(runSetup(threadId, projectId))),
      environmentId: yield* environment.getEnvironmentId,
      dispatch: engine.dispatch,
      applyProviderInstances: (providerInstances, selectedInstanceId) =>
        settings
          .updateSettings({
            providerInstances,
            enableProviderUpdateChecks: false,
          })
          .pipe(
            Effect.mapError(
              () =>
                new SandboxSubmissionError({
                  code: "storage",
                  message: "Unable to save sandbox provider settings.",
                }),
            ),
            Effect.flatMap(() => registry.getInstance(selectedInstanceId)),
            Effect.flatMap((instance) =>
              instance
                ? Effect.void
                : Effect.fail(
                    new SandboxSubmissionError({
                      code: "unavailable",
                      message: "Selected provider is unavailable.",
                    }),
                  ),
            ),
          ),
    });
    return makeSandboxIntakeRoutes(
      runtime,
      ({ submission, providerInstances }) =>
        intake.accept({
          submission,
          providerInstances,
          workspaceRoot: deployment.workspaceRoot,
          projectId: ProjectId.make(
            NodeCrypto.createHash("sha256").update(submission.input.commandId).digest("hex"),
          ),
        }),
      makeSandboxLifecycle({ snapshots, dispatch: engine.dispatch, runSetup }),
    );
  }),
);
