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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistryHydration } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { readSandboxDeployment } from "./SandboxDeployment.ts";
import { makeSandboxIntake } from "./SandboxIntake.ts";
import { makeSandboxRuntimeManifest } from "./SandboxRuntime.ts";

/** Restoring a saved sandbox unarchives the thread the user picked. */
export const SandboxUnarchiveRequest = Schema.Struct({ threadId: ThreadId });

export interface SandboxLifecycle {
  /** The archived threads to save, refused while any thread is still active. */
  readonly savable: Effect.Effect<OrchestrationShellSnapshot, SandboxSubmissionError>;
  readonly unarchive: (threadId: ThreadId) => Effect.Effect<void, SandboxSubmissionError>;
}

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
    const runtime = makeSandboxRuntimeManifest(deployment.artifactIntegrity);
    const intake = yield* makeSandboxIntake({
      runtime,
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
    const unavailable = () =>
      new SandboxSubmissionError({
        code: "unavailable",
        message: "Sandbox threads are unavailable.",
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
      {
        savable: Effect.gen(function* () {
          const active = yield* snapshots.getShellSnapshot();
          if (active.threads.length > 0)
            return yield* new SandboxSubmissionError({
              code: "conflict",
              message: "This sandbox still has active threads.",
            });
          return yield* snapshots.getArchivedShellSnapshot();
        }).pipe(
          Effect.mapError((error) =>
            Schema.is(SandboxSubmissionError)(error) ? error : unavailable(),
          ),
        ),
        unarchive: (threadId) =>
          Effect.gen(function* () {
            const thread = yield* snapshots.getThreadShellById(threadId);
            // A retried restore finds the thread already back.
            if (Option.isSome(thread) && thread.value.archivedAt === null) return;
            yield* engine.dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make(`sandbox-restore:${NodeCrypto.randomUUID()}`),
              threadId,
            });
          }).pipe(Effect.mapError(unavailable)),
      },
    );
  }),
);
