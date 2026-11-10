// SQLite as every store here opens it (node:sqlite): the connection's type, the schema version a database is at, one
// transaction (a savepoint inside another), the read-only address ATTACH takes, deletes overwritten for good, and the
// `meta` table each store keeps of itself. The core's database (coreDb.ts), the calendar (server/calendar/db.ts) and
// every module's database (server/modules/store.ts) are opened with these; each store's own schema is its own.

import type { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** The schema version of the database open in `db`. */
export function schemaVersion(db: Db): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/**
 * Runs `work` in a transaction that rolls back if it throws. Inside another
 * transaction it is a savepoint: its work rolls back alone if it throws, and
 * commits with the outer one (so a changeset, changes.ts, holds edits that are
 * transactions of their own).
 */
export function transaction<T>(db: Db, work: () => T): T {
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT nested" : "BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec(nested ? "RELEASE nested" : "COMMIT");
    return result;
  } catch (error) {
    db.exec(nested ? "ROLLBACK TO nested; RELEASE nested" : "ROLLBACK");
    throw error;
  }
}

/** A file's read-only address, for ATTACH: what is attached by it can only be read. */
export const readOnlyAddress = (file: string): string => `file:${file.split("/").map(encodeURIComponent).join("/")}?mode=ro`;

/**
 * `work`'s deletes on `db`, for good: with SQLite's secure_delete on, so their bytes are overwritten, and the WAL
 * checkpointed after, so no older page of them stays in it. Outside any transaction of `db`: `work` makes its own.
 */
export function overwriting<T>(db: Db, work: () => T): T {
  const before = (db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete;
  db.exec("PRAGMA secure_delete = ON");
  let result: T;
  try {
    result = work();
  } finally {
    db.exec(`PRAGMA secure_delete = ${before ? "ON" : "OFF"}`);
  }
  db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  return result;
}

/** A value kept in the meta table, or null when it has never been set. */
export function getMeta(db: Db, key: string): string | null {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Adds one to a counter kept in the meta table (people_version, links_version; see people.ts). */
export function bumpMeta(db: Db, key: string): void {
  setMeta(db, key, String(Number(getMeta(db, key) ?? 0) + 1));
}
