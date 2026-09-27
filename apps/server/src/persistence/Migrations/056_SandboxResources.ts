import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE sandbox_resources (
    command_id TEXT PRIMARY KEY NOT NULL,
    name TEXT UNIQUE NOT NULL,
    artifact_integrity TEXT NOT NULL,
    sprite_id TEXT,
    sprite_url TEXT,
    destination_json TEXT,
    deleted_at TEXT,
    CHECK (length(name) <= 50 AND name NOT GLOB '*[^a-z0-9-]*'),
    CHECK ((sprite_id IS NULL) = (sprite_url IS NULL))
  )`;
});
