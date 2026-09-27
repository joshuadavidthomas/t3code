import {
  AuthOrchestrationOperateScope,
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
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderInstanceRegistryHydration } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { readSandboxDeployment } from "./SandboxDeployment.ts";
import { makeSandboxIntake } from "./SandboxIntake.ts";
import { makeSandboxRuntimeManifest } from "./SandboxRuntime.ts";

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
  );

/** Normal servers don't expose intake. Bootstrap opts a fresh destination into it. */
export const sandboxIntakeRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const deployment = yield* readSandboxDeployment;
    if (!deployment) return Layer.empty;
    const environment = yield* ServerEnvironmentIdentity;
    const engine = yield* OrchestrationEngineService;
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
    return makeSandboxIntakeRoutes(runtime, ({ submission, providerInstances }) =>
      intake.accept({
        submission,
        providerInstances,
        workspaceRoot: deployment.workspaceRoot,
        projectId: ProjectId.make(
          NodeCrypto.createHash("sha256").update(submission.input.commandId).digest("hex"),
        ),
      }),
    );
  }),
);
