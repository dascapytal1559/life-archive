// The person files people were once kept in (data/friends/<id>.md and
// data/people/<id>.md), read once, by the archive's schema migration 5 (db.ts
// runs it; migratePersonFiles, at the end of this file, is it), which moves
// their names, aliases, tags and account links into the person table. Nothing
// else reads them; the files are left on disk as they are.
//
// A file was Markdown with YAML frontmatter:
//
//   ---
//   id: ada-sample            # must match the file name
//   name: Ada Sample
//   aliases: [Addy]
//   tags: [climbing]
//   accounts:                 # which chat accounts are this person
//     - platform: messenger
//       name: Ada Sample      # or id: <platform id>, or handle: <phone or email>
//   ---
//
// read the way the app read it: friends/ before people/, each by file name, a
// file whose id repeats one already read left out, and a malformed aliases,
// tags or accounts key ignored (the rest of the file still counts). Every such
// problem is returned, so the migration can say what it left out.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Db, isMissingFile, normalizeHandle, setMeta } from "../../../sdk/server.ts";
import type { MigrationContext } from "./db.ts";
import { normalizeAliases, normalizeTags } from "./personFields.ts";

export interface LegacyAccountLink {
  platform: string;
  id?: string;
  name?: string;
  handle?: string;
}

export interface LegacyPersonFile {
  id: string;
  /** `friends/ada.md`, `people/gus.md`. */
  label: string;
  name: string;
  aliases: string[];
  tags: string[];
  accounts: LegacyAccountLink[];
}

export interface LegacyListing {
  files: LegacyPersonFile[];
  problems: Array<{ file: string; reason: string }>;
}

const FOLDERS = ["friends", "people"] as const;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FRONTMATTER = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

export function readLegacyPersonFiles(dataDir: string): LegacyListing {
  const files: LegacyPersonFile[] = [];
  const problems: LegacyListing["problems"] = [];
  const seen = new Set<string>();
  for (const folder of FOLDERS) {
    for (const file of markdownFiles(join(dataDir, folder))) {
      const label = `${folder}/${file}`;
      const problem = (reason: string) => problems.push({ file: label, reason });
      const id = file.slice(0, -".md".length);
      if (!ID_PATTERN.test(id)) {
        problem("its name is not a valid person id, so it was left out");
        continue;
      }
      let frontmatter: Record<string, unknown>;
      try {
        const match = FRONTMATTER.exec(readFileSync(join(dataDir, folder, file), "utf8").replace(/\r\n?/g, "\n"));
        if (!match) throw new Error("it does not start with frontmatter");
        const data = parseYaml(match[1]) ?? {};
        if (typeof data !== "object" || Array.isArray(data)) throw new Error("its frontmatter is not `key: value` fields");
        frontmatter = data as Record<string, unknown>;
      } catch (error) {
        problem(`${(error as Error).message}, so it was left out`);
        continue;
      }
      if (frontmatter.id !== id) {
        problem(`the id in its frontmatter does not match the file name, so it was left out`);
        continue;
      }
      if (seen.has(id)) {
        problem("an earlier file has the same id, so it was left out");
        continue;
      }
      seen.add(id);
      files.push({
        id,
        label,
        name: typeof frontmatter.name === "string" || typeof frontmatter.name === "number" ? String(frontmatter.name) : "",
        aliases: listKey(frontmatter.aliases, normalizeAliases, () => problem("its aliases key is malformed, so it was ignored")),
        tags: listKey(frontmatter.tags, normalizeTags, () => problem("its tags key is malformed, so it was ignored")),
        accounts: accountsKey(frontmatter.accounts, () => problem("its accounts key is malformed, so it was ignored")),
      });
    }
  }
  return { files, problems };
}

function markdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".md") && !name.startsWith(".")).sort();
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

function listKey(value: unknown, normalize: (value: unknown) => string[], malformed: () => void): string[] {
  if (value === undefined || value === null) return [];
  try {
    return normalize(value);
  } catch {
    malformed();
    return [];
  }
}

function accountsKey(value: unknown, malformed: () => void): LegacyAccountLink[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(isLink)) {
    malformed();
    return [];
  }
  return value.map((entry: Record<string, unknown>) => {
    const link: LegacyAccountLink = { platform: entry.platform as string };
    for (const key of ["id", "name", "handle"] as const) if (entry[key] !== undefined) link[key] = String(entry[key]).trim();
    return link;
  });
}

function isLink(entry: unknown): entry is Record<string, unknown> {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  if (typeof record.platform !== "string" || !/^[a-z][a-z0-9-]*$/.test(record.platform)) return false;
  const keys = (["id", "name", "handle"] as const).filter((key) => record[key] !== undefined);
  if (keys.length !== 1) return false;
  const value = record[keys[0]];
  return (typeof value === "string" || typeof value === "number") && String(value).trim() !== "";
}

/**
 * Migration 5. `account` becomes `import_person`, with how each is linked to
 * its person (link_source: "import", "rule:<name>" or "captain", and when), how
 * the connector named it, and when an import first and last reported it. The
 * person table is rebuilt as the captain's record of people: name, aliases and
 * tags live in it, and nothing is worked out again when the archive loads.
 *
 * The person files (data/friends/, data/people/) move in: each file (read as
 * the app read them, see legacyFiles.ts) keeps its person, with the file's name,
 * aliases and tags, marked edited by the captain, and the accounts it listed
 * linked to it by the captain. A file tagged "me" gives its accounts to the
 * captain's own person. Every other account goes back to the person made for
 * it; the joins by name, like the automatic archive rules and proposals, are
 * then made again by the rules, which run on the next open because rules_version
 * starts at 0 (see people.ts). "Not them" and rejected proposals are kept, their
 * person files named by person. The files themselves are left as they are.
 */
export function migratePersonFiles(db: Db, { dataDir }: MigrationContext): void {
  const now = Date.now();
  const legacy = dataDir ? readLegacyPersonFiles(dataDir) : { files: [], problems: [] };
  for (const { file, reason } of legacy.problems) console.warn(`Moving person files into the archive: ${file}: ${reason}`);

  db.exec(`
    ALTER TABLE account RENAME TO import_person;
    DROP INDEX account_person;
    DROP INDEX account_handle;
    CREATE INDEX import_person_person ON import_person(person_id);
    CREATE INDEX import_person_handle ON import_person(handle) WHERE handle IS NOT NULL;
    ALTER TABLE import_person ADD COLUMN name_source TEXT;     -- where the connector found the name, when it says
    ALTER TABLE import_person ADD COLUMN first_seen_at INTEGER; -- when an import first reported it
    ALTER TABLE import_person ADD COLUMN last_seen_at INTEGER;  -- ...and last
    ALTER TABLE import_person ADD COLUMN link_source TEXT NOT NULL DEFAULT 'import'
      CHECK (link_source IN ('import', 'captain') OR link_source LIKE 'rule:%');
    ALTER TABLE import_person ADD COLUMN linked_at INTEGER;

    CREATE TABLE person_next (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      name_source TEXT NOT NULL CHECK (name_source IN ('import', 'captain')), -- 'import': follows its one import person's name
      aliases_json TEXT NOT NULL DEFAULT '[]',   -- other names, in order; the first is their label
      tags_json TEXT NOT NULL DEFAULT '[]',
      is_self INTEGER NOT NULL DEFAULT 0,
      edited_at INTEGER,                         -- when the captain last named, tagged or merged them; NULL if never
      archive_rule TEXT,                         -- the automatic archive rule that fits them, stored by the rules
      created_at INTEGER NOT NULL
    );

    -- Small values the archive keeps: rules_version (the rules last run), and
    -- counters that change whenever people or links do (see people.ts).
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

    -- What each import person did, counted from the messages when imports or
    -- rules run, so people and the archive rules are read without a scan.
    CREATE TABLE import_person_stats (
      import_person_id INTEGER PRIMARY KEY REFERENCES import_person(id),
      direct_count INTEGER NOT NULL,         -- messages in one-to-one chats with them, both ways
      group_count INTEGER NOT NULL,          -- what they sent in group chats
      marketplace_count INTEGER NOT NULL,    -- messages in Marketplace chats with them
      last_message_at INTEGER,               -- outside Marketplace
      they_direct INTEGER NOT NULL,          -- what they sent in one-to-one chats
      you_direct INTEGER NOT NULL,           -- what the captain sent in one-to-one chats with them
      in_direct INTEGER NOT NULL,
      in_group INTEGER NOT NULL,
      in_marketplace INTEGER NOT NULL
    );

    -- Reports worked out from the messages, kept until what they were made from changes.
    CREATE TABLE derived (key TEXT PRIMARY KEY, stamp TEXT NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
  `);

  const old = db.prepare("SELECT id, display_name, file_id, seed_account_id, is_self, created_at FROM person").all() as
    { id: number; display_name: string; file_id: string | null; seed_account_id: number | null; is_self: number; created_at: number }[];
  const insert = db.prepare(
    `INSERT INTO person_next (id, name, name_source, aliases_json, tags_json, is_self, edited_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // New people are numbered after every old one, so no old id is taken before its person is copied.
  let nextId = Math.max(0, ...old.map((p) => p.id)) + 1;
  const add = (id: number | null, name: string, source: "import" | "captain", fields: { aliases?: string[]; tags?: string[]; isSelf?: boolean; edited?: boolean; createdAt?: number } = {}) =>
    Number(insert.run(
      id ?? nextId++, name, source, JSON.stringify(fields.aliases ?? []), JSON.stringify(fields.tags ?? []),
      fields.isSelf ? 1 : 0, fields.edited ? now : null, fields.createdAt ?? now,
    ).lastInsertRowid);

  const baseSelf = old.find((p) => p.is_self && p.file_id === null);
  const self = add(baseSelf?.id ?? null, baseSelf?.display_name ?? "Me", "import", { isSelf: true, createdAt: baseSelf?.created_at });

  // One person per file, keeping the person it had; the captain's own files give theirs to self.
  const byFile = new Map(old.filter((p) => p.file_id !== null).map((p) => [p.file_id!, p]));
  const filePerson = new Map<string, number>();
  for (const file of legacy.files) {
    if (file.tags.includes("me")) {
      filePerson.set(file.id, self);
      continue;
    }
    const known = byFile.get(file.id);
    filePerson.set(file.id, add(known?.id ?? null, file.name.trim() || file.id, "captain", {
      aliases: file.aliases, tags: file.tags, edited: true, createdAt: known?.created_at,
    }));
  }

  // Which accounts each file lists: the first file to list one keeps it.
  const byId = db.prepare("SELECT id, is_self FROM import_person WHERE platform = ? AND key_kind = 'id' AND key = ?");
  const byName = db.prepare("SELECT id, is_self FROM import_person WHERE platform = ? AND key_kind = 'name' AND key = ?");
  const byHandle = db.prepare("SELECT id, is_self FROM import_person WHERE platform = ? AND handle = ?");
  const claims = new Map<number, number>();
  for (const file of legacy.files) {
    for (const link of file.accounts) {
      for (const row of lookup(link) as { id: number; is_self: number }[]) {
        if (row.is_self || claims.has(row.id)) continue;
        claims.set(row.id, filePerson.get(file.id)!);
      }
    }
  }
  function lookup(link: LegacyAccountLink) {
    if (link.id !== undefined) return byId.all(link.platform, link.id);
    if (link.name !== undefined) return byName.all(link.platform, link.name);
    return byHandle.all(link.platform, normalizeHandle(link.handle!));
  }

  // Every other account goes back to the person made for it, as it was before any join.
  const seeds = new Map(old.filter((p) => p.seed_account_id !== null).map((p) => [p.seed_account_id!, p]));
  const link = db.prepare("UPDATE import_person SET person_id = ?, link_source = ?, linked_at = ? WHERE id = ?");
  for (const account of db.prepare("SELECT id, display_name, is_self FROM import_person").all() as { id: number; display_name: string; is_self: number }[]) {
    if (account.is_self) {
      link.run(self, "import", now, account.id);
    } else if (claims.has(account.id)) {
      link.run(claims.get(account.id)!, "captain", now, account.id);
    } else {
      const seed = seeds.get(account.id);
      link.run(add(seed?.id ?? null, account.display_name, "import", { createdAt: seed?.created_at }), "import", now, account.id);
    }
  }

  db.exec("DROP TABLE person; ALTER TABLE person_next RENAME TO person;");

  // Decisions about person files are kept about their people. Pending proposals are made again by the rules.
  db.exec("DELETE FROM merge_proposal WHERE status = 'pending'");
  const rekey = (key: string): string | null => {
    if (!key.startsWith("file:")) return key;
    const person = filePerson.get(key.slice("file:".length));
    return person === undefined || person === self ? null : `person:${person}`;
  };
  const rows = db.prepare("SELECT id, left_key, right_key FROM merge_proposal").all() as { id: number; left_key: string; right_key: string }[];
  const drop = db.prepare("DELETE FROM merge_proposal WHERE id = ?");
  const update = db.prepare("UPDATE merge_proposal SET left_key = ?, right_key = ? WHERE id = ?");
  const kept = new Set<string>();
  for (const row of rows) {
    const keys = [rekey(row.left_key), rekey(row.right_key)];
    if (keys[0] === null || keys[1] === null || keys[0] === keys[1]) {
      drop.run(row.id);
      continue;
    }
    const [left, right] = (keys as string[]).sort();
    if (kept.has(`${left}\n${right}`)) {
      drop.run(row.id);
      continue;
    }
    kept.add(`${left}\n${right}`);
    if (left !== row.left_key || right !== row.right_key) update.run(left, right, row.id);
  }

  // When imports first and last reported each account, as far as the messages they sent tell.
  db.exec(`
    UPDATE import_person SET
      first_seen_at = (SELECT min(s.started_at) FROM message m JOIN source s ON s.id = m.first_source_id WHERE m.sender_account_id = import_person.id),
      last_seen_at = (SELECT max(s.started_at) FROM message m JOIN source s ON s.id = m.last_source_id WHERE m.sender_account_id = import_person.id);
    UPDATE import_person SET
      first_seen_at = (SELECT min(started_at) FROM source WHERE source.platform = import_person.platform),
      last_seen_at = (SELECT max(started_at) FROM source WHERE source.platform = import_person.platform)
    WHERE first_seen_at IS NULL;
  `);
  setMeta(db, "rules_version", "0");
}
