// The copies docs/import-runbook.md's "From this Mac" takes, made in code: the call history's, the Messages app's and
// the Contacts app's databases by SQLite's backup, read-only, so a copy is whole while the app writes; and the Messages
// attachments that came since a day, with their times. Whether a database has anything new is told by its newest row's
// id alone. Nothing here opens a message, a call or a card; a database is copied page by page, and a file by its name
// and time.

import { constants } from "node:fs";
import { copyFile, mkdir, open, readdir, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Data, Effect } from "effect";
import { macStores } from "../../connectors/addressBook.ts";

/** Where this Mac keeps what the two connectors read, under a home folder. */
export function macSources(home: string) {
  return {
    calls: join(home, "Library", "Application Support", "CallHistoryDB", "CallHistory.storedata"),
    messages: join(home, "Library", "Messages", "chat.db"),
    attachments: join(home, "Library", "Messages", "Attachments"),
    /** The Contacts app's folder: its own store, AddressBook-v22.abcddb, and each account's under Sources/<id>/. */
    contacts: join(home, "Library", "Application Support", "AddressBook"),
  };
}

/** macOS (or the file's mode) would not let this process read a source: Full Disk Access is missing. */
export class NoAccess extends Data.TaggedError("NoAccess")<{ readonly file: string; readonly message: string }> {}
/** A source is not where this Mac keeps it. */
export class NoSource extends Data.TaggedError("NoSource")<{ readonly file: string; readonly message: string }> {}
/** A copy failed part way. */
export class CopyFailed extends Data.TaggedError("CopyFailed")<{ readonly message: string }> {}

/** Whether this process may read `file`: opened and closed again, nothing read. */
export const canRead = Effect.fn("canRead")(function* (file: string) {
  yield* Effect.tryPromise({
    try: async () => (await open(file, "r")).close(),
    catch: (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return new NoAccess({ file, message: `this process may not read ${file}` });
      if (code === "ENOENT") return new NoSource({ file, message: `there is no ${file}` });
      return new CopyFailed({ message: `could not open ${file}: ${(error as Error).message}` });
    },
  });
});

/** A database copied whole by SQLite's backup from a read-only connection, as `sqlite3 -readonly <from> ".backup <to>"`. */
export const copyDatabase = Effect.fn("copyDatabase")(function* (from: string, to: string) {
  yield* Effect.tryPromise({
    try: async () => {
      const source = new DatabaseSync(from, { readOnly: true });
      try {
        await backup(source, to);
      } finally {
        source.close();
      }
    },
    catch: (error) => new CopyFailed({ message: `could not copy ${from}: ${(error as Error).message}` }),
  });
});

/**
 * The id of the newest row in `table` of the database `file` (0 when it has none), read-only: rows only ever get a
 * higher id than any before them (the call history's Core Data Z_PK, Messages' AUTOINCREMENT ROWID), so a higher one
 * than last time means something came in. Reads the key alone, nothing of any row.
 */
export const newestRow = Effect.fn("newestRow")(function* (file: string, table: string, key: string) {
  return yield* Effect.try({
    try: () => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return Number((db.prepare(`SELECT max(${key}) AS newest FROM ${table}`).get() as { newest: number | null }).newest ?? 0);
      } finally {
        db.close();
      }
    },
    catch: (error) => new CopyFailed({ message: `could not read ${file}'s newest ${table} row: ${(error as Error).message}` }),
  });
});

/** The Contacts app's stores copied, each as copyDatabase copies, to the same places under `to` (not the cards' photos); how many. */
export const copyContacts = Effect.fn("copyContacts")(function* (from: string, to: string) {
  const stores = yield* Effect.promise(() => macStores(from));
  for (const store of stores) {
    yield* Effect.promise(() => mkdir(dirname(join(to, store)), { recursive: true }));
    yield* copyDatabase(join(from, store), join(to, store));
  }
  return stores.length;
});

/**
 * The files under `from` changed after `since` (every file when it is null), copied to the same places under `to`
 * with their times, as `find -type f -newermt` through `tar -p` does. A folder that is not there holds none.
 */
export const copyFilesSince = Effect.fn("copyFilesSince")(function* (from: string, to: string, since: number | null) {
  return yield* Effect.tryPromise({
    try: async () => {
      const entries = await readdir(from, { recursive: true, withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      let files = 0;
      let bytes = 0;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const file = join(entry.parentPath, entry.name);
        const info = await stat(file);
        if (since !== null && info.mtimeMs <= since) continue;
        const copy = join(to, file.slice(from.length + 1));
        await mkdir(dirname(copy), { recursive: true });
        // A clone on APFS, which takes no space until either copy changes.
        await copyFile(file, copy, constants.COPYFILE_FICLONE);
        await utimes(copy, info.atime, info.mtime);
        files += 1;
        bytes += info.size;
      }
      return { files, bytes };
    },
    catch: (error) => new CopyFailed({ message: `could not copy the files in ${from}: ${(error as Error).message}` }),
  });
});
