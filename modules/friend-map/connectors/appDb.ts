// Reading an app's own SQLite database (WhatsApp's ChatStorage.sqlite, the
// Messages app's sms.db or chat.db) without ever writing to the source: each
// database is copied to a temporary folder, with its -wal, and opened there, so
// not even SQLite's own -shm file lands beside the original.

import { copyFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

export type Row = Record<string, SQLOutputValue>;

/** Opens a copy of a database (with its -wal, which holds changes not yet written into it), or null if it is not there. */
export async function openCopy(original: string, work: string): Promise<DatabaseSync | null> {
  if (!(await isFile(original))) return null;
  const copy = join(work, basename(original));
  await copyFile(original, copy);
  if (await isFile(`${original}-wal`)) await copyFile(`${original}-wal`, `${copy}-wal`);
  return new DatabaseSync(copy);
}

/** A table's columns, or none when there is no such table. */
export function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name));
}

/** A record's columns without binary fields (and without `leaveOut`), for keeping as the message's original record. */
export function plain(row: Row, leaveOut: string[]): Record<string, string | number | null> {
  const kept: Record<string, string | number | null> = {};
  for (const [column, value] of Object.entries(row)) {
    if (leaveOut.includes(column) || value instanceof Uint8Array) continue;
    kept[column] = typeof value !== "bigint" ? value : Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  return kept;
}

export async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}
