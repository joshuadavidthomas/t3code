import {
  type CommandId,
  SandboxDestination,
  SandboxSubmissionRecord,
  SandboxSubmissionError,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface SandboxSpriteBinding {
  readonly id: string;
  readonly url: string;
}

export interface SandboxResource {
  readonly commandId: CommandId;
  readonly name: string;
  readonly artifactIntegrity: string;
  readonly sprite: SandboxSpriteBinding | null;
  readonly destination: SandboxDestination | null;
  readonly deletedAt: string | null;
}

type Row = {
  command_id: string;
  name: string;
  artifact_integrity: string;
  sprite_id: string | null;
  sprite_url: string | null;
  destination_json: string | null;
  deleted_at: string | null;
};

const failure = (code: SandboxSubmissionError["code"], message: string) =>
  new SandboxSubmissionError({ code, message });
const storageFailure = () => failure("storage", "Unable to read or persist sandbox resource.");
const validateDestination = Schema.decodeUnknownEffect(SandboxDestination);
const decodeDestination = Schema.decodeUnknownEffect(Schema.fromJsonString(SandboxDestination));
const encodeDestination = Schema.encodeEffect(Schema.fromJsonString(SandboxDestination));
const decodeSubmission = Schema.decodeUnknownEffect(SandboxSubmissionRecord);
const sameDestination = (left: SandboxDestination, right: SandboxDestination) =>
  left.environmentId === right.environmentId &&
  left.projectId === right.projectId &&
  left.threadId === right.threadId;

/** Durable host-owned bindings used to reconcile external sandbox allocation. */
export const makeSandboxResources = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);

  const findRow = Effect.fnUntraced(function* (commandId: CommandId) {
    const rows = yield* sql<Row>`SELECT command_id, name, artifact_integrity, sprite_id,
      sprite_url, destination_json, deleted_at FROM sandbox_resources
      WHERE command_id = ${commandId}`.pipe(Effect.mapError(storageFailure));
    return rows[0] ?? null;
  });
  const toResource = Effect.fnUntraced(function* (row: Row) {
    const destination = row.destination_json
      ? yield* decodeDestination(row.destination_json).pipe(Effect.mapError(storageFailure))
      : null;
    return {
      commandId: row.command_id as CommandId,
      name: row.name,
      artifactIntegrity: row.artifact_integrity,
      sprite:
        row.sprite_id === null || row.sprite_url === null
          ? null
          : { id: row.sprite_id, url: row.sprite_url },
      destination,
      deletedAt: row.deleted_at,
    } satisfies SandboxResource;
  });
  const get = Effect.fnUntraced(function* (commandId: CommandId) {
    const row = yield* findRow(commandId);
    if (!row) return yield* failure("invalid", "Sandbox resource does not exist.");
    return yield* toResource(row);
  });
  const find = Effect.fnUntraced(function* (commandId: CommandId) {
    const row = yield* findRow(commandId);
    return row ? yield* toResource(row) : null;
  });
  const getOrCreate = Effect.fnUntraced(function* (
    submission: SandboxSubmissionRecord,
    namePrefix = "",
  ) {
    const accepted = yield* decodeSubmission(submission).pipe(
      Effect.mapError(() => failure("invalid", "Invalid sandbox submission.")),
    );
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* findRow(accepted.input.commandId);
        if (existing) {
          if (existing.deleted_at)
            return yield* failure("conflict", "Sandbox resource has been deleted.");
          if (existing.artifact_integrity !== accepted.runtime.artifactIntegrity)
            return yield* failure("conflict", "Sandbox runtime identity does not match.");
          return yield* toResource(existing);
        }
        const name = `${namePrefix}t3-${NodeCrypto.randomUUID().replaceAll("-", "")}`;
        yield* sql`INSERT INTO sandbox_resources
          (command_id, name, artifact_integrity)
          VALUES (${accepted.input.commandId}, ${name}, ${accepted.runtime.artifactIntegrity})`.pipe(
          Effect.mapError(storageFailure),
        );
        return yield* get(accepted.input.commandId);
      }),
    );
  });
  const bindSprite = Effect.fnUntraced(function* (
    commandId: CommandId,
    sprite: SandboxSpriteBinding,
  ) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* get(commandId);
        if (current.deletedAt)
          return yield* failure("conflict", "Sandbox resource has been deleted.");
        if (
          current.sprite &&
          (current.sprite.id !== sprite.id || current.sprite.url !== sprite.url)
        )
          return yield* failure("conflict", "Sandbox Sprite binding cannot be replaced.");
        if (!current.sprite)
          yield* sql`UPDATE sandbox_resources SET sprite_id = ${sprite.id}, sprite_url = ${sprite.url}
            WHERE command_id = ${commandId}`.pipe(Effect.mapError(storageFailure));
        return yield* get(commandId);
      }),
    );
  });
  const bindDestination = Effect.fnUntraced(function* (
    commandId: CommandId,
    destination: SandboxDestination,
  ) {
    const decoded = yield* validateDestination(destination).pipe(
      Effect.mapError(() => failure("invalid", "Invalid sandbox destination.")),
    );
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* get(commandId);
        if (current.deletedAt)
          return yield* failure("conflict", "Sandbox resource has been deleted.");
        if (current.destination && !sameDestination(current.destination, decoded))
          return yield* failure("conflict", "Sandbox destination binding cannot be replaced.");
        if (!current.destination) {
          const body = yield* encodeDestination(decoded).pipe(Effect.mapError(storageFailure));
          yield* sql`UPDATE sandbox_resources SET destination_json = ${body}
            WHERE command_id = ${commandId}`.pipe(Effect.mapError(storageFailure));
        }
        return yield* get(commandId);
      }),
    );
  });
  const markDeleted = Effect.fnUntraced(function* (commandId: CommandId, deletedAt: string) {
    const row = yield* findRow(commandId);
    if (!row) return yield* failure("invalid", "Sandbox resource does not exist.");
    yield* sql`UPDATE sandbox_resources SET deleted_at = COALESCE(deleted_at, ${deletedAt})
      WHERE command_id = ${commandId}`.pipe(Effect.mapError(storageFailure));
    return yield* get(commandId);
  });

  return {
    getOrCreate,
    get,
    find,
    bindSprite,
    bindDestination,
    markDeleted,
  } as const;
});

export class SandboxResources extends Context.Service<
  SandboxResources,
  Effect.Success<ReturnType<typeof makeSandboxResources>>
>()("t3/sandbox/SandboxResources") {}

export const layer = Layer.effect(SandboxResources, makeSandboxResources());
