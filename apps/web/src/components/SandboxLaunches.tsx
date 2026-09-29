import type { CommandId, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore } from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { usePrimarySessionState } from "../environments/primary";
import { useEnvironments, type EnvironmentPresentation } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useEnvironmentSessionState } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { canPairSandboxDestinations } from "./settings/SandboxResourceRows";
import { addSandboxLaunchDraft, useConnectSandboxDestination } from "./useSandbox";

// Finished launches this client has tried to pair since it loaded. One try each: a
// connection the user removes stays removed until the next load.
const paired = new Set<string>();

/**
 * Every client of a host shows its sandbox launches, as every client of an environment
 * shows its threads: a launch in progress gets a draft row here, a finished one is
 * paired so its thread appears, and a deleted one is forgotten. Only clients that can
 * pair take part.
 */
export function SandboxLaunchesCoordinator() {
  const { environments } = useEnvironments();
  const connected = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  return environments
    .filter(
      (environment) =>
        environment.serverConfig?.environment.capabilities.sandboxConfiguration === true,
    )
    .map((environment) => (
      <SandboxHostLaunches
        key={environment.environmentId}
        environment={environment}
        connected={connected}
      />
    ));
}

function SandboxHostLaunches({
  environment,
  connected,
}: {
  environment: EnvironmentPresentation;
  connected: ReadonlySet<EnvironmentId>;
}) {
  const ownerEnvironmentId = environment.environmentId;
  const remoteSession = useEnvironmentSessionState(ownerEnvironmentId);
  const primarySession = usePrimarySessionState();
  const session =
    environment.entry.target._tag === "PrimaryConnectionTarget"
      ? primarySession.data
      : remoteSession.data;
  const canPair = canPairSandboxDestinations(environment, session);
  const submissions = useEnvironmentQuery(
    canPair
      ? serverEnvironment.sandboxSubmissions({ environmentId: ownerEnvironmentId, input: {} })
      : null,
  );
  // Launches a draft here already shows; its observer pairs them when they finish.
  const shown = new Set(
    useComposerDraftStore(
      useShallow((store) =>
        Object.values(store.draftThreadsByThreadKey).flatMap((draft) =>
          draft.sandboxSetup?.submission ? [draft.sandboxSetup.submission.commandId] : [],
        ),
      ),
    ),
  );
  const launches = (submissions.data ?? []).filter(
    (launch) => launch.deletedAt === null && !launch.savedAt,
  );
  // The host drops a deleted launch from its list. Its sandbox has nothing left to
  // reconnect to, wherever it was deleted from, so this client forgets it too.
  const listed = useRef<ReadonlyMap<CommandId, EnvironmentId | null> | null>(null);
  const forget = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  useEffect(() => {
    if (!submissions.data) return;
    const next = new Map(
      submissions.data.map((launch) => [
        launch.input.commandId,
        launch.destination?.environmentId ?? null,
      ]),
    );
    for (const [commandId, environmentId] of listed.current ?? [])
      if (environmentId && !next.has(commandId) && connected.has(environmentId))
        void forget(environmentId);
    listed.current = next;
  }, [connected, forget, submissions.data]);
  const unpaired = launches.filter(
    (launch) =>
      launch.progress.phase === "done" &&
      launch.destination !== null &&
      !connected.has(launch.destination.environmentId) &&
      !shown.has(launch.input.commandId),
  );
  const connectDestination = useConnectSandboxDestination();
  const unpairedKey = unpaired.map((launch) => launch.input.commandId).join(",");
  useEffect(() => {
    for (const commandId of unpairedKey ? unpairedKey.split(",") : []) {
      const key = `${ownerEnvironmentId}:${commandId}`;
      if (paired.has(key)) continue;
      paired.add(key);
      void connectDestination(ownerEnvironmentId, commandId as CommandId);
    }
  }, [connectDestination, ownerEnvironmentId, unpairedKey]);
  return launches
    .filter(
      (launch) =>
        (launch.progress.phase === "running" || launch.progress.phase === "failed") &&
        !shown.has(launch.input.commandId),
    )
    .map((launch) => (
      <SandboxLaunchDraft
        key={launch.input.commandId}
        ownerEnvironmentId={ownerEnvironmentId}
        commandId={launch.input.commandId}
      />
    ));
}

/** Fetches the launch's message, which lists leave out, and shows it as a draft. */
function SandboxLaunchDraft({
  ownerEnvironmentId,
  commandId,
}: {
  ownerEnvironmentId: EnvironmentId;
  commandId: CommandId;
}) {
  const launch = useEnvironmentQuery(
    serverEnvironment.getSandboxSubmission({
      environmentId: ownerEnvironmentId,
      input: { commandId },
    }),
  );
  useEffect(() => {
    if (launch.data) addSandboxLaunchDraft(ownerEnvironmentId, launch.data);
  }, [launch.data, ownerEnvironmentId]);
  return null;
}
