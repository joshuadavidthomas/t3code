import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE sandbox_submissions (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT UNIQUE NOT NULL,
    secret_ref TEXT NOT NULL,
    body TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE sandbox_intakes (
    id TEXT PRIMARY KEY NOT NULL,
    fingerprint TEXT NOT NULL,
    destination_json TEXT
  )`;
  // A destination runtime belongs to one accepted submission, including during recovery.
  yield* sql`CREATE UNIQUE INDEX sandbox_intake_owner ON sandbox_intakes ((1))`;
});
