// The archive's schema: every table, column, key and unique constraint of a freshly migrated empty archive in memory,
// never the real one, so what the query writer (queryWriter.ts) is told is what the migrations make.

import { schemaVersion, type Db } from "../../../sdk/server.ts";
import { openArchive } from "./db.ts";

export interface SchemaColumn {
  name: string;
  /** As declared ("INTEGER", "TEXT"); empty for an FTS column. */
  type: string;
  /** Its place in the primary key, 1 first; 0 when it is not part of it. */
  primaryKey: number;
  notNull: boolean;
}

export interface SchemaForeignKey {
  column: string;
  table: string;
  /** The column it points at in `table`. */
  to: string;
}

export interface SchemaTable {
  name: string;
  /** "virtual" for the full-text index; its shadow tables are left out. */
  kind: "table" | "virtual";
  columns: SchemaColumn[];
  foreignKeys: SchemaForeignKey[];
  /** Each UNIQUE constraint's columns, besides the primary key. */
  unique: string[][];
}

export interface ArchiveSchema {
  /** The schema version (migrations run). */
  version: number;
  tables: SchemaTable[];
}

/** The tables of the archive open in `db`, A to Z, leaving out SQLite's own and the full-text index's shadow tables. */
export function describeSchema(db: Db): ArchiveSchema {
  const listed = db.prepare("PRAGMA table_list").all() as { schema: string; name: string; type: string }[];
  const tables = listed
    .filter((t) => t.schema === "main" && (t.type === "table" || t.type === "virtual") && !t.name.startsWith("sqlite_"))
    .map((t): SchemaTable => {
      const quoted = `"${t.name.replaceAll('"', '""')}"`;
      const columns = db.prepare(`PRAGMA table_xinfo(${quoted})`).all() as { name: string; type: string; pk: number; notnull: number; hidden: number }[];
      const keys = db.prepare(`PRAGMA foreign_key_list(${quoted})`).all() as { id: number; seq: number; table: string; from: string; to: string | null }[];
      const indexes = db.prepare(`PRAGMA index_list(${quoted})`).all() as { name: string; unique: number; origin: string }[];
      return {
        name: t.name,
        kind: t.type === "virtual" ? "virtual" : "table",
        // hidden 1 is a virtual table's own hidden columns (the FTS table's name and rank).
        columns: columns.filter((c) => c.hidden !== 1).map((c) => ({ name: c.name, type: c.type, primaryKey: c.pk, notNull: c.notnull === 1 })),
        foreignKeys: keys
          .sort((a, b) => a.id - b.id || a.seq - b.seq)
          .map((k) => ({ column: k.from, table: k.table, to: k.to ?? "id" })),
        unique: indexes
          .filter((i) => i.unique === 1 && i.origin !== "pk")
          .map((i) => (db.prepare(`PRAGMA index_info("${i.name.replaceAll('"', '""')}")`).all() as { name: string }[]).map((c) => c.name)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { version: schemaVersion(db), tables };
}

let fresh: ArchiveSchema | undefined;

/** The schema this code makes, from an empty archive migrated in memory (once per process). */
export function freshSchema(): ArchiveSchema {
  if (!fresh) {
    const db = openArchive(":memory:");
    try {
      fresh = describeSchema(db);
    } finally {
      db.close();
    }
  }
  return fresh;
}
