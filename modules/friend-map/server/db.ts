// The archive database: data/archive.sqlite, opened through Node's built-in
// SQLite. The code under server/archive/ is the only code that knows SQL.
//
// Two kinds of people live here:
//   import_person  one identity on one platform, as an import found it (the
//                  column names and the connector contract still call it an
//                  account): its key, handle and name, and which person it is,
//                  with how that link was made (link_source, see people.ts).
//   person         the captain's record of someone: name, aliases, a note,
//                  whether to reach out to them, where
//                  they are (location, as far as he last knew), the seed their
//                  identicon is drawn from (src/identicon.ts), and the archive
//                  state the rules stored for them.
//                  Every import person points at one person; a person gathers
//                  everything from the import people that point at it.
//   tag            the captain's tags, one row each, in the captain's order;
//                  person_tag says who has which (see tags.ts).
//   draft          messages the captain is writing to someone (see drafts.ts).
// Everything the captain decides (names, aliases, tags, notes, links, "not them") is
// kept here, so back up archive.sqlite with the rest of data/. Messages are
// not a cache either: they may exist nowhere else later.
//
// Until friend map was a module this database held everything, so the early
// migrations also made the core's tables (the event index, agents' sessions,
// inspirations, the trail of content reads) and the exercise and rituals
// modules' old ones. They live elsewhere now: the move dropped them from the
// archive it took (server/archive/migrate.ts), and migration 66 drops them from
// a new one, so every archive holds friend map's tables alone.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { telegramCallNotice } from "../connectors/matrix-bridge/rig.ts";
import { voipCall } from "../connectors/wechat-ios/records.ts";
import { migratePersonFiles } from "./legacyFiles.ts";
import { bumpMeta, type Db, getMeta, isEncodedName, LOCALE, schemaVersion, setMeta, TIME_ZONE, transaction } from "../../../sdk/server.ts";

export type { Db };


/** What a migration may need beyond the database: the data directory it lives in, if it has one. */
export interface MigrationContext {
  dataDir?: string;
  /** Stop at this schema version rather than the latest: for tests of the migrations. */
  version?: number;
}

/**
 * Each entry moves the schema one version forward: SQL, or a function for a
 * change SQL cannot say. Never edit one that has shipped, add a new one.
 * Each runs in a transaction with foreign keys checked at its end rather than
 * as it goes, so a table can be rebuilt.
 */
const MIGRATIONS: Array<string | ((db: Db, context: MigrationContext) => void)> = [
  `
  -- One row per import of an export file or read of an app's database.
  CREATE TABLE source (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    connector TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('export', 'app-db', 'live')),
    label TEXT NOT NULL,                       -- the file or folder name
    content_sha256 TEXT,                       -- of an export file
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
    counts_json TEXT,
    error TEXT
  );

  -- A person as the archive knows them: one per account until the captain's
  -- person files say which accounts belong together (see people.ts).
  CREATE TABLE person (
    id INTEGER PRIMARY KEY,
    display_name TEXT NOT NULL,
    file_id TEXT UNIQUE,                       -- data/friends/<id>.md or data/people/<id>.md
    file_kind TEXT CHECK (file_kind IN ('friend', 'person')), -- no longer written or read: a file's folder means nothing
    tags_json TEXT NOT NULL DEFAULT '[]',      -- copied from the person file
    seed_account_id INTEGER UNIQUE,            -- the account a person without a file was made for
    is_self INTEGER NOT NULL DEFAULT 0,
    merged_into INTEGER REFERENCES person(id), -- set while the seed account belongs to a filed person
    created_at INTEGER NOT NULL
  );

  -- One identity on one platform.
  CREATE TABLE account (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    key TEXT NOT NULL,                         -- JID, handle, or display name (key_kind 'name')
    key_kind TEXT NOT NULL CHECK (key_kind IN ('id', 'name')),
    display_name TEXT NOT NULL,
    handle TEXT,                               -- phone (E.164), email or username
    is_self INTEGER NOT NULL DEFAULT 0,
    person_id INTEGER REFERENCES person(id),
    UNIQUE (platform, key)
  );
  CREATE INDEX account_person ON account(person_id);
  CREATE INDEX account_handle ON account(handle) WHERE handle IS NOT NULL;

  CREATE TABLE conversation (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    platform_conversation_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('direct', 'group')),
    title TEXT,
    UNIQUE (platform, platform_conversation_id)
  );

  CREATE TABLE conversation_member (
    conversation_id INTEGER NOT NULL REFERENCES conversation(id),
    account_id INTEGER NOT NULL REFERENCES account(id),
    PRIMARY KEY (conversation_id, account_id)
  ) WITHOUT ROWID;
  CREATE INDEX conversation_member_account ON conversation_member(account_id);

  CREATE TABLE message (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    conversation_id INTEGER NOT NULL REFERENCES conversation(id),
    platform_message_id TEXT NOT NULL,         -- the platform's id, or a synthetic one
    id_kind TEXT NOT NULL CHECK (id_kind IN ('platform', 'synthetic')),
    sender_account_id INTEGER REFERENCES account(id),   -- NULL for system events
    is_from_self INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,                  -- ms since the epoch
    type TEXT NOT NULL,
    text TEXT,
    reply_to_platform_id TEXT,
    unsent INTEGER NOT NULL DEFAULT 0,
    edited_at INTEGER,
    first_source_id INTEGER NOT NULL REFERENCES source(id),
    last_source_id INTEGER NOT NULL REFERENCES source(id),
    raw_json TEXT NOT NULL,                    -- the original record
    UNIQUE (platform, platform_message_id)
  );
  CREATE INDEX message_conversation_time ON message(conversation_id, sent_at);
  CREATE INDEX message_sender_time ON message(sender_account_id, sent_at);

  -- Earlier texts of a message whose text changed between imports.
  CREATE TABLE message_version (
    message_id INTEGER NOT NULL REFERENCES message(id),
    text TEXT,
    replaced_at INTEGER NOT NULL,
    source_id INTEGER NOT NULL REFERENCES source(id)
  );
  CREATE INDEX message_version_message ON message_version(message_id);

  CREATE TABLE reaction (
    message_id INTEGER NOT NULL REFERENCES message(id),
    actor_account_id INTEGER NOT NULL REFERENCES account(id),
    emoji TEXT NOT NULL,
    added_at INTEGER,
    source_id INTEGER NOT NULL REFERENCES source(id),
    PRIMARY KEY (message_id, actor_account_id, emoji)
  ) WITHOUT ROWID;

  CREATE TABLE attachment (
    id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES message(id),
    ordinal INTEGER NOT NULL,
    platform_attachment_id TEXT,
    type TEXT NOT NULL,
    filename TEXT,
    mime TEXT,
    size INTEGER,
    sha256 TEXT,
    local_path TEXT,                           -- relative to data/archive/media (relative to data/ since migration 21); NULL = known missing
    source_id INTEGER NOT NULL REFERENCES source(id),
    UNIQUE (message_id, ordinal)
  );

  CREATE VIRTUAL TABLE message_fts USING fts5(text, content = 'message', content_rowid = 'id');
  CREATE TRIGGER message_fts_insert AFTER INSERT ON message BEGIN
    INSERT INTO message_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER message_fts_delete AFTER DELETE ON message BEGIN
    INSERT INTO message_fts(message_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER message_fts_update AFTER UPDATE OF text ON message BEGIN
    INSERT INTO message_fts(message_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO message_fts(rowid, text) VALUES (new.id, new.text);
  END;

  -- What each source claims to cover, so gaps can be computed. NULL conversation = the whole platform.
  CREATE TABLE coverage_span (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    conversation_id INTEGER REFERENCES conversation(id),
    source_id INTEGER NOT NULL REFERENCES source(id),
    from_ms INTEGER NOT NULL,
    to_ms INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('export', 'app-db', 'live'))
  );

  CREATE TABLE connector_state (
    connector TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'error')),
    last_run_at INTEGER,
    last_ok_at INTEGER,
    last_error TEXT,
    last_error_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,       -- consecutive failed runs
    retry_after INTEGER,                       -- backoff: no automatic run before this time
    cursor_json TEXT
  );

  -- Possible "same person" links between two identities, each an account
  -- ('account:<platform>:<key>') or a person file ('file:<id>'). Keys are
  -- stable across rebuilds; a rejected pair is never proposed again.
  CREATE TABLE merge_proposal (
    id INTEGER PRIMARY KEY,
    left_key TEXT NOT NULL,
    right_key TEXT NOT NULL,                   -- left_key < right_key
    rule TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('high', 'medium', 'low')),
    evidence_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'rejected')),
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    UNIQUE (left_key, right_key)
  );
  `,
  `
  -- The id another connector gave a message the archive already holds (see
  -- write.ts): the same message reaching the archive by two routes, such as
  -- Messenger's phone export and Facebook's "Download your information", is
  -- kept once, and each route finds it again by its own id.
  CREATE TABLE message_alias (
    platform TEXT NOT NULL,
    platform_message_id TEXT NOT NULL,
    message_id INTEGER NOT NULL REFERENCES message(id),
    source_id INTEGER NOT NULL REFERENCES source(id),
    PRIMARY KEY (platform, platform_message_id)
  ) WITHOUT ROWID;
  CREATE INDEX message_platform_time ON message(platform, sent_at);

  -- A chat about something for sale on Facebook Marketplace (see the
  -- facebook-dyi connector): left out of counts, trends and timelines by default.
  ALTER TABLE conversation ADD COLUMN is_marketplace INTEGER NOT NULL DEFAULT 0;

  -- Why the automatic rules archive this person, if they do (see archiving.ts):
  -- recomputed from the messages by people.ts on every resolve, like tags_json.
  -- Whether they are archived also depends on their person file's tags.
  ALTER TABLE person ADD COLUMN archive_rule TEXT;
  `,
  `
  -- A direct chat is you and one other person. The facebook-dyi connector used
  -- to tell a group from a direct chat by who was still in it, so a group that
  -- everyone but one had left was kept as a direct chat, with everyone who
  -- ever wrote in it as a member. Those become the groups they are.
  UPDATE conversation SET type = 'group'
  WHERE type = 'direct' AND is_marketplace = 0 AND (
    SELECT count(*) FROM conversation_member cm
    JOIN account a ON a.id = cm.account_id
    LEFT JOIN person p ON p.id = a.person_id
    WHERE cm.conversation_id = conversation.id AND a.is_self = 0 AND coalesce(p.is_self, 0) = 0
  ) > 1;
  `,
  // The whatsapp-db connector joined an address book contact's first, middle
  // and last names as they were, so a full name typed as the first name
  // ("Joanna Draftly", last name "Draftly") came out "Joanna Draftly Draftly".
  // A WhatsApp name of three or more words ending in the same word twice loses
  // the repeat, as the connector now names it, and so do its direct chats'
  // titles and its own person; people.ts refreshes the rest on its next resolve.
  (db) => {
    const accounts = db.prepare("SELECT id, display_name FROM account WHERE platform = 'whatsapp'").all() as { id: number; display_name: string }[];
    const rename = db.prepare("UPDATE account SET display_name = ? WHERE id = ?");
    const retitle = db.prepare("UPDATE conversation SET title = ? WHERE platform = 'whatsapp' AND type = 'direct' AND title = ?");
    const renamePerson = db.prepare("UPDATE person SET display_name = ? WHERE seed_account_id = ? AND display_name = ?");
    for (const { id, display_name: name } of accounts) {
      const words = name.split(" ");
      if (words.length < 3 || words.at(-1)!.toLowerCase() !== words.at(-2)!.toLowerCase()) continue;
      const fixed = words.slice(0, -1).join(" ");
      rename.run(fixed, id);
      retitle.run(fixed, name);
      renamePerson.run(fixed, id, name);
    }
  },
  // The person table becomes the captain's record of people, and person files
  // go: see migratePersonFiles.
  (db, context) => migratePersonFiles(db, context),
  `
  -- The captain's note about someone: free text, written in their panel or
  -- with \`person note\`, or filled from the iPhone address book's company and
  -- notes (see addressBookNotes.ts).
  ALTER TABLE person ADD COLUMN note TEXT NOT NULL DEFAULT '';
  -- The note as the address book last wrote it. While the note is empty or
  -- still exactly this, the address book may write it again; once the captain
  -- has changed it, never.
  ALTER TABLE person ADD COLUMN address_book_note TEXT;
  `,
  // A person the captain never named took its import person's name as the
  // platform gave it, doubled or trailing spaces and all ("Haruki  Oda"); it is
  // now trimmed and single-spaced as the app writes names (tidyName in
  // personFields.ts; its rule is copied here so this migration never changes).
  // Import people keep their names as they were.
  (db) => {
    const rename = db.prepare("UPDATE person SET name = ? WHERE id = ?");
    for (const { id, name } of db.prepare("SELECT id, name FROM person WHERE name_source = 'import'").all() as { id: number; name: string }[]) {
      const tidy = name.trim().replace(/\s+/g, " ");
      if (tidy !== name) rename.run(tidy, id);
    }
  },
  // Migration 7 undone: a person the captain never named or edited, with one
  // import person whose name differs from theirs only in spaces, takes that name
  // back exactly as the platform wrote it ("Haruki Oda" is "Haruki  Oda" again),
  // for the captain to review by hand. Import people kept the names as given.
  (db) => {
    const restore = db.prepare("UPDATE person SET name = ? WHERE id = ?");
    const tidy = (name: string) => name.trim().replace(/\s+/g, " ");
    for (const { id, name, display_name } of db.prepare(
      `SELECT p.id, p.name, min(ip.display_name) AS display_name FROM person p JOIN import_person ip ON ip.person_id = p.id
       WHERE p.name_source = 'import' AND p.is_self = 0 AND p.edited_at IS NULL GROUP BY p.id HAVING count(*) = 1`,
    ).all() as { id: number; name: string; display_name: string }[]) {
      if (display_name !== name && tidy(display_name) === tidy(name)) restore.run(display_name, id);
    }
  },
  // Tags get a table of their own (see tags.ts): one row per tag, in the
  // captain's order, and person_tag for who has which, instead of each
  // person's own list (person.tags_json, dropped here). Every tag anyone has
  // moves in, written as normalizeTag writes tags now (lower case, spaces made
  // dashes; the rule is copied here so this migration never changes), with
  // "system-archive" and "me", which were never tags, left out. The order: an
  // archive with anyone in it but the captain (not a new one) gets the Table's
  // quick tag defaults first, even those nobody has yet (they were offered as
  // toggles), then every other tag A to Z; "archive" and "keep" are always
  // there, marked built in. A tag's people are recorded as having it from now.
  (db) => {
    db.exec(`
      CREATE TABLE tag (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,               -- as normalizeTag writes it
        sort_order INTEGER NOT NULL,             -- 0 first; the Table's quick tags and every tag list go in this order
        built_in INTEGER NOT NULL DEFAULT 0,     -- 1 for "archive" and "keep": never renamed or deleted
        created_at INTEGER NOT NULL
      );
      CREATE TABLE person_tag (
        person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (person_id, tag_id)
      ) WITHOUT ROWID;
      CREATE INDEX person_tag_tag ON person_tag(tag_id);
    `);
    const now = Date.now();
    const people = db.prepare("SELECT id, tags_json, is_self FROM person").all() as { id: number; tags_json: string; is_self: number }[];
    const holders = new Map<string, Set<number>>();
    for (const { id, tags_json } of people) {
      for (const tag of JSON.parse(tags_json) as string[]) {
        const clean = tag.trim().toLowerCase().replace(/\s+/g, "-");
        if (!clean || clean === "system-archive" || clean === "me") continue;
        holders.set(clean, (holders.get(clean) ?? new Set()).add(id));
      }
    }
    const defaults = people.some((p) => !p.is_self) ? ["home-town", "school", "work", "travel", "overseas", "internet"] : [];
    const collator = new Intl.Collator(LOCALE, { sensitivity: "base", numeric: true });
    const others = [...new Set([...holders.keys(), "archive", "keep"])].filter((tag) => !defaults.includes(tag)).sort(collator.compare);
    const addTag = db.prepare("INSERT INTO tag (name, sort_order, built_in, created_at) VALUES (?, ?, ?, ?)");
    const give = db.prepare("INSERT INTO person_tag (person_id, tag_id, added_at) VALUES (?, ?, ?)");
    [...defaults, ...others].forEach((tag, order) => {
      const id = Number(addTag.run(tag, order, tag === "archive" || tag === "keep" ? 1 : 0, now).lastInsertRowid);
      for (const person of holders.get(tag) ?? []) give.run(person, id, now);
    });
    db.exec("ALTER TABLE person DROP COLUMN tags_json");
  },
  `
  -- Each message the captain sent from friend-map (see send.ts): where to, when,
  -- and what the platform said. Never its text: the message itself arrives
  -- through its connector's sync like any other, and is kept in message.
  CREATE TABLE outgoing_message (
    id INTEGER PRIMARY KEY,
    connector TEXT NOT NULL,
    conversation_id INTEGER NOT NULL REFERENCES conversation(id),
    requested_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'unconfirmed')),
    finished_at INTEGER,
    error TEXT,
    platform_message_id TEXT                   -- the sent message's id, when the platform gave one
  );
  CREATE INDEX outgoing_message_conversation ON outgoing_message(conversation_id, requested_at);
  `,
  `
  -- Whether each import person is in a small group the captain wrote in (see
  -- stats.ts), which the archive rules keep; filled when the rules next run.
  ALTER TABLE import_person_stats ADD COLUMN in_small_group INTEGER NOT NULL DEFAULT 0;
  `,
  // The whatsapp-db connector named accounts from the iPhone app's
  // ZWAMESSAGE.ZPUSHNAME and ZWAGROUPMEMBER.ZFIRSTNAME, which hold base64
  // protobuf messages, not names ("COC7/7cGIAA=", "+EAA="). A WhatsApp import
  // person named so is named as the connector now names it: by its number (its
  // handle), else "WhatsApp user"; so is its direct chat's title. Its person
  // follows when the rules next run (RULES_VERSION 7), unless the captain named them.
  (db) => {
    const accounts = db.prepare("SELECT id, display_name, handle FROM import_person WHERE platform = 'whatsapp'").all() as
      { id: number; display_name: string; handle: string | null }[];
    const rename = db.prepare("UPDATE import_person SET display_name = ? WHERE id = ?");
    const retitle = db.prepare(
      `UPDATE conversation SET title = ? WHERE type = 'direct' AND title = ?
         AND id IN (SELECT conversation_id FROM conversation_member WHERE account_id = ?)`,
    );
    for (const { id, display_name: name, handle } of accounts) {
      if (!isEncodedName(name)) continue;
      const fixed = handle ?? "WhatsApp user";
      rename.run(fixed, id);
      retitle.run(fixed, name, id);
    }
  },
  // Two fields of the captain's for keeping up with people: whether he should
  // reach out to them, indexed so they can be listed by it, and a first message
  // he has drafted to them. The flag takes over from the "should-call" tag:
  // everyone who has it is flagged, and the tag is deleted as the tag table
  // deletes one (tags.ts: taken from everyone, the rest renumbered, people
  // marked changed; copied here so this migration never changes).
  `
  ALTER TABLE person ADD COLUMN should_reach_out INTEGER NOT NULL DEFAULT 0 CHECK (should_reach_out IN (0, 1));
  ALTER TABLE person ADD COLUMN draft_opener TEXT NOT NULL DEFAULT '';
  CREATE INDEX person_should_reach_out ON person(should_reach_out);
  UPDATE person SET should_reach_out = 1 WHERE is_self = 0 AND id IN (
    SELECT pt.person_id FROM person_tag pt JOIN tag t ON t.id = pt.tag_id WHERE t.name = 'should-call');
  INSERT INTO meta (key, value) SELECT 'people_version', '1' WHERE EXISTS (SELECT 1 FROM tag WHERE name = 'should-call')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
  DELETE FROM person_tag WHERE tag_id IN (SELECT id FROM tag WHERE name = 'should-call');
  DELETE FROM tag WHERE name = 'should-call';
  CREATE TEMP TABLE tag_order AS SELECT id, row_number() OVER (ORDER BY sort_order, name) - 1 AS n FROM tag;
  UPDATE tag SET sort_order = (SELECT n FROM tag_order WHERE tag_order.id = tag.id);
  DROP TABLE tag_order;
  `,
  // Three fields of the captain's, each with a list of values of its own (see
  // fieldValues.ts): where he met someone and where they live (one value at
  // most, which the partial unique index holds to), and what they do (any
  // number). A person's value must be one of its field's (the two-column
  // foreign key). They take over from the tags he had started for them: each
  // met-<place> and lives-<place> tag becomes a value named from the rest of
  // the tag, each word capitalised (met-tokyo is Tokyo, met-new-york
  // New York), and its people have it. Someone with several met- or lives-
  // tags gets the first A to Z of each. Then the tags are taken from everyone
  // and deleted as the tag table deletes one (tags.ts: the rest renumbered,
  // people marked changed). Everything here is this migration's own, so it
  // never changes, but for the order of several tags, once the owner's own and
  // now A to Z, which changes nothing for an archive this migration has run on.
  (db) => {
    db.exec(`
      CREATE TABLE field_value (
        id INTEGER PRIMARY KEY,
        field TEXT NOT NULL CHECK (field IN ('met', 'lives', 'occupation')),
        name TEXT NOT NULL,                      -- as typed; values differing only in case are one
        created_at INTEGER NOT NULL,
        UNIQUE (id, field)
      );
      CREATE UNIQUE INDEX field_value_name ON field_value(field, name COLLATE NOCASE);
      CREATE TABLE person_field_value (
        person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        value_id INTEGER NOT NULL,
        field TEXT NOT NULL,                     -- the value's field, so met and lives can hold one value each
        added_at INTEGER NOT NULL,
        PRIMARY KEY (person_id, value_id),
        FOREIGN KEY (value_id, field) REFERENCES field_value(id, field) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX person_field_value_single ON person_field_value(person_id, field) WHERE field IN ('met', 'lives');
      CREATE INDEX person_field_value_value ON person_field_value(value_id);
    `);
    const now = Date.now();
    const title = (rest: string) => rest.split("-").filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
    const addValue = db.prepare("INSERT INTO field_value (field, name, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");
    const findValue = db.prepare("SELECT id FROM field_value WHERE field = ? AND name = ? COLLATE NOCASE");
    const tags = (db.prepare("SELECT id, name FROM tag WHERE name LIKE 'met-%' OR name LIKE 'lives-%' ORDER BY name").all() as { id: number; name: string }[])
      .map((tag) => {
        const [field, ...rest] = tag.name.split("-");
        return { ...tag, field, rest: rest.join("-"), value: title(rest.join("-")) };
      })
      .filter((tag) => tag.value !== "");
    if (tags.length === 0) return;
    const valueOf = new Map<number, number>();
    for (const tag of tags) {
      addValue.run(tag.field, tag.value, now);
      valueOf.set(tag.id, (findValue.get(tag.field, tag.value) as { id: number }).id);
    }
    const holders = db.prepare("SELECT pt.person_id FROM person_tag pt JOIN person p ON p.id = pt.person_id WHERE pt.tag_id = ? AND p.is_self = 0");
    const chosen = new Map<string, (typeof tags)[number]>();
    for (const tag of tags) {
      for (const { person_id } of holders.all(tag.id) as { person_id: number }[]) {
        const key = `${person_id}:${tag.field}`;
        const best = chosen.get(key);
        if (!best || tag.rest < best.rest) {
          chosen.set(key, tag);
        }
      }
    }
    const give = db.prepare("INSERT INTO person_field_value (person_id, value_id, field, added_at) VALUES (?, ?, ?, ?)");
    for (const [key, tag] of chosen) give.run(Number(key.split(":")[0]), valueOf.get(tag.id)!, tag.field, now);
    const ids = JSON.stringify(tags.map((tag) => tag.id));
    db.prepare("DELETE FROM person_tag WHERE tag_id IN (SELECT value FROM json_each(?))").run(ids);
    db.prepare("DELETE FROM tag WHERE id IN (SELECT value FROM json_each(?))").run(ids);
    db.exec(`
      CREATE TEMP TABLE tag_order AS SELECT id, row_number() OVER (ORDER BY sort_order, name) - 1 AS n FROM tag;
      UPDATE tag SET sort_order = (SELECT n FROM tag_order WHERE tag_order.id = tag.id);
      DROP TABLE tag_order;
      INSERT INTO meta (key, value) VALUES ('people_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
    `);
  },
  // Occupation goes: the captain keeps what people do as tags. Its values and
  // who had them are deleted (people marked changed if anyone had one), and
  // the field names narrow to met and lives: field_value is rebuilt with the
  // narrower check (SQLite cannot change one in place), and a person's one
  // value per field is now a plain unique index.
  `
  INSERT INTO meta (key, value) SELECT 'people_version', '1' WHERE EXISTS (SELECT 1 FROM person_field_value WHERE field = 'occupation')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
  DELETE FROM person_field_value WHERE field NOT IN ('met', 'lives');
  DELETE FROM field_value WHERE field NOT IN ('met', 'lives');
  CREATE TABLE field_value_new (
    id INTEGER PRIMARY KEY,
    field TEXT NOT NULL CHECK (field IN ('met', 'lives')),
    name TEXT NOT NULL,                      -- as typed; values differing only in case are one
    created_at INTEGER NOT NULL,
    UNIQUE (id, field)
  );
  INSERT INTO field_value_new (id, field, name, created_at) SELECT id, field, name, created_at FROM field_value;
  DROP TABLE field_value;
  ALTER TABLE field_value_new RENAME TO field_value;
  CREATE UNIQUE INDEX field_value_name ON field_value(field, name COLLATE NOCASE);
  DROP INDEX person_field_value_single;
  CREATE UNIQUE INDEX person_field_value_single ON person_field_value(person_id, field);
  `,
  // Telegram messages filed under another chat go back to their own. On
  // 2026-09-29 the homeserver gave two new one-to-one chats' rooms the same
  // room, and matrix-bridge read it while it was labelled as the other chat.
  // A Telegram message's id begins with its own chat's id (user:90000003/…),
  // so each message whose id names another existing Telegram chat moves
  // there, and a Telegram one-to-one chat (user:<id>) keeps as members only
  // you and <id>. If anything moved, links_version goes up, so what the
  // messages add up to is worked out again. The rule is this migration's own.
  (db) => {
    const moved = Number(db.prepare(`
      UPDATE message SET conversation_id = (
        SELECT t.id FROM conversation t
        WHERE t.platform = 'telegram' AND t.platform_conversation_id = substr(message.platform_message_id, 1, instr(message.platform_message_id, '/') - 1))
      WHERE platform = 'telegram' AND instr(platform_message_id, '/') > 0
        AND substr(platform_message_id, 1, instr(platform_message_id, '/') - 1) != (SELECT platform_conversation_id FROM conversation c WHERE c.id = message.conversation_id)
        AND EXISTS (SELECT 1 FROM conversation t
          WHERE t.platform = 'telegram' AND t.platform_conversation_id = substr(message.platform_message_id, 1, instr(message.platform_message_id, '/') - 1))
    `).run().changes);
    const strays = Number(db.prepare(`
      DELETE FROM conversation_member WHERE (conversation_id, account_id) IN (
        SELECT cm.conversation_id, cm.account_id FROM conversation_member cm
        JOIN conversation c ON c.id = cm.conversation_id
        JOIN import_person a ON a.id = cm.account_id
        WHERE c.platform = 'telegram' AND c.type = 'direct' AND c.platform_conversation_id LIKE 'user:%'
          AND a.is_self = 0 AND 'user:' || a.key != c.platform_conversation_id)
    `).run().changes);
    if (moved + strays > 0) {
      db.exec("INSERT INTO meta (key, value) VALUES ('links_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1");
    }
  },
  // WhatsApp messages get back what the bridge's own words took from them. Live
  // WhatsApp (matrix-whatsapp) first read what mautrix-whatsapp writes in place
  // of a message it could not bridge as that message's text: a file it could no
  // longer fetch ("fi.mau.whatsapp.failed_media"), an unsupported message (a
  // notice), and a contact card (a .vcf file, with no text). On a message an
  // import had, that replaced the import's text, keeping it as an earlier version:
  // it comes back, and that version goes, while nothing has changed the message
  // since. A message only live WhatsApp has keeps no text of the bridge's, and is
  // a photo or file (its file missing), or another kind, as the connector now
  // reads them. Only text changes, so no counts need working out again.
  (db) => {
    const bridgeWords = `(json_extract(m.raw_json, '$.content."fi.mau.whatsapp.failed_media"') IS NOT NULL
      OR json_extract(m.raw_json, '$.content.msgtype') = 'm.notice'
      OR json_extract(m.raw_json, '$.content.info.mimetype') IN ('text/vcard', 'text/x-vcard'))`;
    const replaced = db.prepare(`
      SELECT v.rowid AS version, v.message_id AS message, v.text FROM message_version v
      JOIN message m ON m.id = v.message_id AND m.last_source_id = v.source_id
      JOIN source s ON s.id = v.source_id
      WHERE m.platform = 'whatsapp' AND s.connector = 'matrix-whatsapp' AND ${bridgeWords}
        AND v.rowid = (SELECT max(rowid) FROM message_version WHERE message_id = v.message_id)
    `).all() as { version: number; message: number; text: string | null }[];
    const restore = db.prepare("UPDATE message SET text = ? WHERE id = ?");
    const forget = db.prepare("DELETE FROM message_version WHERE rowid = ?");
    for (const { version, message, text } of replaced) {
      restore.run(text, message);
      forget.run(version);
    }
    db.exec(`
      UPDATE message SET text = NULL,
        type = CASE WHEN json_extract(raw_json, '$.content."fi.mau.whatsapp.failed_media"') IS NOT NULL THEN 'media' ELSE 'other' END
      WHERE id IN (
        SELECT m.id FROM message m JOIN source s ON s.id = m.first_source_id
        WHERE m.platform = 'whatsapp' AND s.connector = 'matrix-whatsapp' AND m.text IS NOT NULL
          AND (json_extract(m.raw_json, '$.content."fi.mau.whatsapp.failed_media"') IS NOT NULL
            OR json_extract(m.raw_json, '$.content.msgtype') = 'm.notice'))
    `);
  },
  // The change log (changes.ts): every edit to people, from the app or the CLI, is
  // one changeset, with the rows it changed as they were before and after, so it
  // can be shown and undone exactly.
  `
  CREATE TABLE changeset (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    surface TEXT NOT NULL CHECK (surface IN ('cli', 'app')),
    action TEXT NOT NULL,                    -- what was done, in a few words ("edit tag commercial", "merge")
    description TEXT,                        -- the captain's words, when an agent passed them
    backup TEXT,                             -- the backup taken just before (the CLI's), by file name
    summary_json TEXT NOT NULL,              -- each person's before and after, and other changes, for showing
    undoes INTEGER,                          -- the changeset this one undid
    undone_by INTEGER                        -- the changeset that undid this one
  );
  CREATE INDEX changeset_at ON changeset(at);
  CREATE TABLE change_row (
    id INTEGER PRIMARY KEY,
    changeset_id INTEGER NOT NULL REFERENCES changeset(id) ON DELETE CASCADE,
    tbl TEXT NOT NULL,                       -- person, person_tag, tag, field_value, person_field_value, import_person, merge_proposal
    row_key TEXT NOT NULL,                   -- the row's key, as a JSON array
    before_json TEXT,                        -- the row before; NULL when the changeset added it
    after_json TEXT                          -- the row after; NULL when the changeset deleted it
  );
  CREATE INDEX change_row_changeset ON change_row(changeset_id);
  `,
  `
  -- A chat whose source holds only the captain's own messages (Discord's data
  -- package; see the discord-package connector), so whether anyone else wrote
  -- in it is not known; and, for the archive rules (see stats.ts and
  -- archiving.ts), what the captain sent in such one-to-one chats with each
  -- import person, filled when the rules next run.
  ALTER TABLE conversation ADD COLUMN is_self_only INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE import_person_stats ADD COLUMN you_direct_self_only INTEGER NOT NULL DEFAULT 0;
  `,
  // Each person's identicon (src/identicon.ts) is drawn from a seed kept on
  // them, 16 hex digits, given when a person is made (people.ts). Everyone
  // there is gets theirs here, a hash of their id and when they were made, so
  // running this again on the same archive gives the same pictures. The hash
  // is this migration's own copy, so it never changes.
  (db) => {
    db.exec("ALTER TABLE person ADD COLUMN identicon_seed TEXT");
    const hash = (text: string) => {
      let a = 0xdeadbeef;
      let b = 0x41c6ce57;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a = Math.imul(a ^ c, 2654435761);
        b = Math.imul(b ^ c, 1597334677);
      }
      a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
      b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
      return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
    };
    const seed = db.prepare("UPDATE person SET identicon_seed = ? WHERE id = ?");
    for (const { id, created_at } of db.prepare("SELECT id, created_at FROM person").all() as { id: number; created_at: number }[]) {
      seed.run(hash(`person ${id} ${created_at}`), id);
    }
  },
  // An attachment's file is named relative to the data folder, so it can be a
  // copy in archive/media/ or a file kept where it is in an export unpacked
  // under platform-exports/ (see mediaPaths.ts). Every file there was is a copy.
  `
  UPDATE attachment SET local_path = 'archive/media/' || local_path WHERE local_path IS NOT NULL;
  `,
  `
  -- A group chat the captain dropped (People.dropGroup), and when: it links
  -- nobody and counts in nothing worked out from group chats, though its
  -- messages stay. Imports never write it, so a re-import keeps it dropped.
  ALTER TABLE conversation ADD COLUMN dropped_at INTEGER;
  `,
  `
  -- Someone the captain took out of a group chat they never wrote in
  -- (People.removeFromGroup), and when: they are no member of it anywhere
  -- worked out from group chats. Imports add members with INSERT OR IGNORE
  -- and never write it, so a re-import keeps them out.
  ALTER TABLE conversation_member ADD COLUMN removed_at INTEGER;
  `,
  `
  -- Catch-ups (catchUps.ts): time the captain spent with people outside
  -- messages, each worth some messages in the closeness score. His own record:
  -- imports never write them.
  CREATE TABLE catch_up (
    id INTEGER PRIMARY KEY,
    day TEXT NOT NULL,                       -- its local day, 2026-10-04
    time TEXT,                               -- when it started, 19:30 local time; NULL when not said
    kind TEXT NOT NULL CHECK (kind IN ('catch-up', 'quick-catch-up')),
    mode TEXT NOT NULL CHECK (mode IN ('in-person', 'phone')),
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX catch_up_day ON catch_up(day);
  CREATE TABLE catch_up_person (
    catch_up_id INTEGER NOT NULL REFERENCES catch_up(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    PRIMARY KEY (catch_up_id, person_id)
  ) WITHOUT ROWID;
  CREATE INDEX catch_up_person_person ON catch_up_person(person_id);
  `,
  `
  -- Calls from a phone's call history (the call-history connector): one row
  -- per call with one other party, keyed on the source's own id for it. Kept
  -- apart from messages, so they count in no message count.
  CREATE TABLE call (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    platform_call_id TEXT NOT NULL,
    import_person_id INTEGER NOT NULL REFERENCES import_person(id),  -- the other party
    at INTEGER NOT NULL,                       -- when it started, ms since the epoch
    duration_seconds INTEGER NOT NULL,         -- how long it was connected
    direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
    answered INTEGER NOT NULL CHECK (answered IN (0, 1)),
    service TEXT NOT NULL CHECK (service IN ('phone', 'facetime-audio', 'facetime-video')),
    first_source_id INTEGER NOT NULL REFERENCES source(id),
    last_source_id INTEGER NOT NULL REFERENCES source(id),
    raw_json TEXT NOT NULL,
    UNIQUE (platform, platform_call_id)
  );
  CREATE INDEX call_import_person_at ON call(import_person_id, at);
  `,
  `
  -- Catch-ups are on a date alone and say how many hours they lasted in place
  -- of a kind (a catch-up 3, a quick one 1), and whether they were by a call
  -- in place of a way (by phone is by call). Their time, kind and way go, with
  -- the table rebuilt for its new checks (SQLite cannot add one in place). The change log's rows of them follow, as the triggers
  -- now write them, so undoing an older changeset puts back a catch-up as
  -- catch-ups are now kept.
  CREATE TABLE catch_up_new (
    id INTEGER PRIMARY KEY,
    day TEXT NOT NULL,                       -- its local date, 2026-10-04
    hours REAL NOT NULL CHECK (hours > 0),   -- how long it lasted
    by_call INTEGER NOT NULL CHECK (by_call IN (0, 1)),  -- 1 by a call (phone, Discord), 0 in person (gone in migration 28)
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  INSERT INTO catch_up_new (id, day, hours, by_call, note, created_at)
    SELECT id, day, CASE kind WHEN 'quick-catch-up' THEN 1.0 ELSE 3.0 END, mode = 'phone', note, created_at FROM catch_up;
  DROP TABLE catch_up;
  ALTER TABLE catch_up_new RENAME TO catch_up;
  CREATE INDEX catch_up_day ON catch_up(day);
  UPDATE change_row SET
    before_json = json_remove(json_set(before_json,
      '$.hours', CASE json_extract(before_json, '$.kind') WHEN 'quick-catch-up' THEN 1.0 ELSE 3.0 END,
      '$.by_call', json_extract(before_json, '$.mode') = 'phone'), '$.time', '$.kind', '$.mode'),
    after_json = json_remove(json_set(after_json,
      '$.hours', CASE json_extract(after_json, '$.kind') WHEN 'quick-catch-up' THEN 1.0 ELSE 3.0 END,
      '$.by_call', json_extract(after_json, '$.mode') = 'phone'), '$.time', '$.kind', '$.mode')
  WHERE tbl = 'catch_up';
  `,
  // Met and Lives become one field, Location: where someone is, as far as the
  // captain last knew. Everyone keeps their lives value; anyone without one
  // takes their met value (as a location value, the lives value of that name
  // but for case if there is one); then met and its values go, and
  // field_value is rebuilt with the one field name (SQLite cannot change a
  // check in place). Lives values nobody has stay, as values do. The change
  // log's rows of lives values and who had them follow, so undoing an older
  // changeset puts them back as location; met's stay as they were, so one
  // that set a met value is refused as changed since. What moved is
  // kept in meta as location_fold (see LocationFold), for `npm run archive --
  // migrate` to tell, and people are marked changed. Everything here is this
  // migration's own, so it never changes.
  (db) => {
    const rows = db.prepare(`
      SELECT p.id, p.name, (SELECT v.name FROM person_field_value pv JOIN field_value v ON v.id = pv.value_id WHERE pv.person_id = p.id AND pv.field = 'met') AS met,
        (SELECT v.name FROM person_field_value pv JOIN field_value v ON v.id = pv.value_id WHERE pv.person_id = p.id AND pv.field = 'lives') AS lives
      FROM person p WHERE p.id IN (SELECT person_id FROM person_field_value) ORDER BY p.id
    `).all() as { id: number; name: string; met: string | null; lives: string | null }[];
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const fold: LocationFold = {
      movedFromMet: rows.filter((row) => row.met !== null && row.lives === null).length,
      keptFromLives: rows.filter((row) => row.lives !== null).length,
      bothSame: rows.filter((row) => row.met !== null && row.lives !== null && same(row.met, row.lives)).length,
      bothDifferent: rows.filter((row) => row.met !== null && row.lives !== null && !same(row.met, row.lives))
        .map((row) => ({ id: row.id, name: row.name, met: row.met!, lives: row.lives! })),
      withLocation: rows.filter((row) => row.met !== null || row.lives !== null).length,
    };
    const findLives = db.prepare("SELECT id FROM field_value WHERE field = 'lives' AND name = ? COLLATE NOCASE");
    const addLives = db.prepare("INSERT INTO field_value (field, name, created_at) SELECT 'lives', name, created_at FROM field_value WHERE field = 'met' AND name = ?");
    const move = db.prepare("UPDATE person_field_value SET value_id = ?, field = 'lives' WHERE person_id = ? AND field = 'met'");
    for (const row of rows) {
      if (row.met === null || row.lives !== null) continue;
      let lives = findLives.get(row.met) as { id: number } | undefined;
      if (!lives) {
        addLives.run(row.met);
        lives = findLives.get(row.met) as { id: number };
      }
      move.run(lives.id, row.id);
    }
    db.exec(`
      DELETE FROM person_field_value WHERE field = 'met';
      DELETE FROM field_value WHERE field = 'met';
      CREATE TABLE field_value_new (
        id INTEGER PRIMARY KEY,
        field TEXT NOT NULL CHECK (field = 'location'),
        name TEXT NOT NULL,                      -- as typed; values differing only in case are one
        created_at INTEGER NOT NULL,
        UNIQUE (id, field)
      );
      INSERT INTO field_value_new (id, field, name, created_at) SELECT id, 'location', name, created_at FROM field_value;
      DROP TABLE field_value;
      ALTER TABLE field_value_new RENAME TO field_value;
      CREATE UNIQUE INDEX field_value_name ON field_value(field, name COLLATE NOCASE);
      UPDATE person_field_value SET field = 'location';
      UPDATE change_row SET
        before_json = CASE json_extract(before_json, '$.field') WHEN 'lives' THEN json_set(before_json, '$.field', 'location') ELSE before_json END,
        after_json = CASE json_extract(after_json, '$.field') WHEN 'lives' THEN json_set(after_json, '$.field', 'location') ELSE after_json END
      WHERE tbl IN ('field_value', 'person_field_value');
    `);
    if (rows.length > 0 || db.prepare("SELECT 1 FROM field_value LIMIT 1").get()) {
      setMeta(db, "location_fold", JSON.stringify(fold));
      bumpMeta(db, "people_version");
    }
  },
  `
  -- Catch-ups no longer say whether they were by a call: the captain writes
  -- that in the note when he wants it. One that was by call keeps it there,
  -- "By call" before its note ("By call: dinner"), and the column goes. The
  -- change log's rows of them follow, so undoing an older changeset puts back
  -- a catch-up as catch-ups are now kept.
  UPDATE catch_up SET note = CASE note WHEN '' THEN 'By call' ELSE 'By call: ' || note END WHERE by_call = 1;
  ALTER TABLE catch_up DROP COLUMN by_call;
  UPDATE change_row SET
    before_json = json_remove(CASE json_extract(before_json, '$.by_call') WHEN 1 THEN json_set(before_json, '$.note',
      CASE json_extract(before_json, '$.note') WHEN '' THEN 'By call' ELSE 'By call: ' || json_extract(before_json, '$.note') END) ELSE before_json END, '$.by_call'),
    after_json = json_remove(CASE json_extract(after_json, '$.by_call') WHEN 1 THEN json_set(after_json, '$.note',
      CASE json_extract(after_json, '$.note') WHEN '' THEN 'By call' ELSE 'By call: ' || json_extract(after_json, '$.note') END) ELSE after_json END, '$.by_call')
  WHERE tbl = 'catch_up';
  `,
  `
  -- A catch-up can have others the captain does not name (a crowd at a
  -- wedding), by how many: they take a share of its worth and are no one.
  -- Every catch-up so far had none, and so do the change log's rows of them,
  -- so undoing an older changeset puts back a catch-up as catch-ups are now
  -- kept.
  ALTER TABLE catch_up ADD COLUMN others INTEGER NOT NULL DEFAULT 0 CHECK (others >= 0);
  UPDATE change_row SET
    before_json = json_set(before_json, '$.others', 0),
    after_json = json_set(after_json, '$.others', 0)
  WHERE tbl = 'catch_up';
  `,
  `
  -- The Calendar view (calendar.ts) counts a month's messages by when they
  -- were sent, every chat at once: this index holds every message by its
  -- time, with its chat, sender and type, so a month is counted from the index
  -- alone, reading only that month. And calls by when they were.
  CREATE INDEX message_time ON message(sent_at, conversation_id, sender_account_id, type);
  CREATE INDEX call_at ON call(at);
  `,
  `
  -- "live-together" is built in, like "archive" and "keep" (see tags.ts):
  -- someone with it lives with the captain, and ranks above everyone else by
  -- closeness. A tag of that name the captain already made is kept, with its
  -- people and its place in the order, and marked built in; otherwise it is
  -- added, last. Its id is one no tag the change log remembers has had, as
  -- Tags.insert gives.
  UPDATE tag SET built_in = 1 WHERE name = 'live-together';
  INSERT INTO tag (id, name, sort_order, built_in, created_at)
    SELECT max(coalesce((SELECT max(id) FROM tag), 0), coalesce((SELECT max(row_key ->> 0) FROM change_row WHERE tbl = 'tag'), 0)) + 1,
      'live-together', (SELECT coalesce(max(sort_order), -1) + 1 FROM tag), 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE NOT EXISTS (SELECT 1 FROM tag WHERE name = 'live-together');
  `,
  // Location becomes a column of person (person.location), its one value or
  // NULL, kept as typed: values that differ only in case are one (the column
  // compares without case, and People writes a value someone already has in
  // their spelling), and the index on it answers "who is in Brisbane" and
  // "every location, with how many" from the index alone. Everyone keeps their
  // value, field_value and person_field_value go, and so do values nobody had.
  // The change log's rows of them become person rows holding only id and
  // location, each folded into the person's own row in its changeset when it
  // has one, so undoing an older changeset puts back a location as locations
  // are now kept; a renamed value becomes that change for everyone who has it
  // now. Rows that cannot (met's, kept by migration 27, or a value whose name
  // is gone) stay as they were, and an undo of them is refused. What it did
  // is kept in meta as location_column (see LocationColumn), for `npm run
  // archive -- migrate` to tell, and people are marked changed. Everything
  // here is this migration's own, so it never changes.
  (db) => {
    const counted = () => db.prepare("SELECT count(*) AS people, count(DISTINCT location) AS values_ FROM person WHERE location IS NOT NULL").get() as
      { people: number; values_: number };
    const old = db.prepare(`
      SELECT count(DISTINCT pv.person_id) AS people, count(DISTINCT pv.value_id) AS held, (SELECT count(*) FROM field_value) AS listed
      FROM person_field_value pv WHERE pv.field = 'location'
    `).get() as { people: number; held: number; listed: number };
    db.exec(`
      ALTER TABLE person ADD COLUMN location TEXT COLLATE NOCASE;  -- where they are, as far as the captain last knew; NULL for not said
      CREATE INDEX person_location ON person(location);
      UPDATE person SET location = (
        SELECT v.name FROM person_field_value pv JOIN field_value v ON v.id = pv.value_id WHERE pv.person_id = person.id AND pv.field = 'location')
      WHERE id IN (SELECT person_id FROM person_field_value WHERE field = 'location');
    `);

    type Row = Record<string, unknown>;
    type LogRow = { id: number; tbl: string; row_key: string; before_json: string | null; after_json: string | null };
    const parse = (json: string | null) => (json === null ? null : (JSON.parse(json) as Row));
    const nameNow = new Map((db.prepare("SELECT id, name FROM field_value").all() as { id: number; name: string }[]).map((v) => [v.id, v.name]));
    const holdersNow = db.prepare("SELECT person_id FROM person_field_value WHERE value_id = ? AND field = 'location'");
    const logged = db.prepare("SELECT id, tbl, row_key, before_json, after_json FROM change_row WHERE changeset_id = ? ORDER BY id");
    const setRow = db.prepare("UPDATE change_row SET before_json = ?, after_json = ? WHERE id = ?");
    const addRow = db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (?, 'person', ?, ?, ?)");
    const dropRow = db.prepare("DELETE FROM change_row WHERE id = ?");
    const changesets = (db.prepare("SELECT DISTINCT changeset_id AS id FROM change_row WHERE tbl IN ('field_value', 'person_field_value') ORDER BY 1").all() as
      { id: number }[]).map((c) => c.id);
    for (const changeset of changesets) {
      const rows = logged.all(changeset) as LogRow[];
      const valueRows = new Map(rows.filter((r) => r.tbl === "field_value").map((r) => [Number(JSON.parse(r.row_key)[0]), r]));
      // A value's name as it was before the changeset, or after it; undefined when it is not known.
      const nameThen = (id: number) => {
        const row = valueRows.get(id);
        return row ? (parse(row.before_json)?.name as string | undefined) : nameNow.get(id);
      };
      const nameAfter = (id: number) => {
        const row = valueRows.get(id);
        return row ? (parse(row.after_json)?.name as string | undefined) : nameNow.get(id);
      };
      // Each person's location before and after the changeset, from the rows of who had which.
      const people = new Map<number, { before: string | null | undefined; after: string | null | undefined; rows: number[] }>();
      const unconverted = new Set<number>();
      for (const row of rows.filter((r) => r.tbl === "person_field_value")) {
        const [personId, valueId] = JSON.parse(row.row_key) as number[];
        const before = parse(row.before_json);
        const after = parse(row.after_json);
        if ((before ?? after)!.field !== "location") {
          unconverted.add(personId);
          continue;
        }
        const entry = people.get(personId) ?? { before: null, after: null, rows: [] };
        entry.rows.push(row.id);
        if (before !== null) entry.before = nameThen(valueId);
        if (after !== null) entry.after = nameAfter(valueId);
        people.set(personId, entry);
      }
      // A value renamed: everyone who has it now.
      for (const [valueId, row] of valueRows) {
        const before = parse(row.before_json);
        const after = parse(row.after_json);
        if (!before || !after || before.name === after.name) continue;
        for (const { person_id } of holdersNow.all(valueId) as { person_id: number }[]) {
          if (!people.has(person_id)) people.set(person_id, { before: String(before.name), after: String(after.name), rows: [] });
        }
      }
      const personRows = new Map(rows.filter((r) => r.tbl === "person").map((r) => [Number(JSON.parse(r.row_key)[0]), r]));
      for (const [personId, { before, after, rows: from }] of people) {
        if (unconverted.has(personId) || before === undefined || after === undefined) continue;
        for (const id of from) dropRow.run(id);
        if (before === after) continue;
        const own = personRows.get(personId);
        if (own) {
          const ownBefore = parse(own.before_json);
          const ownAfter = parse(own.after_json);
          setRow.run(
            ownBefore === null ? null : JSON.stringify({ ...ownBefore, location: before }),
            ownAfter === null ? null : JSON.stringify({ ...ownAfter, location: after }),
            own.id,
          );
        } else {
          addRow.run(changeset, JSON.stringify([personId]), JSON.stringify({ id: personId, location: before }), JSON.stringify({ id: personId, location: after }));
        }
      }
      for (const row of valueRows.values()) dropRow.run(row.id);
    }

    db.exec("DROP TABLE person_field_value; DROP TABLE field_value;");
    const now = counted();
    const column: LocationColumn = { before: { people: old.people, values: old.held, unused: old.listed - old.held }, after: { people: now.people, values: now.values_ } };
    if (old.listed > 0) {
      setMeta(db, "location_column", JSON.stringify(column));
      bumpMeta(db, "people_version");
    }
  },
  `
  -- A call record among the messages (type 'call') keeps how long the call
  -- was connected when its source says (message.call_seconds, set by imports
  -- from the connector's callSeconds; see calls.ts): Messenger's and
  -- Instagram's every call record, 0 for one never answered. WeChat and
  -- Signal say nothing, so theirs stay NULL, as does everything not a call.
  -- The records imported before are filled in from their original records,
  -- where those two give it as call_duration (metaDyi.ts, callSeconds), so no
  -- import is run again. The index finds the call records of a chat, or of
  -- every chat, without reading the other messages.
  ALTER TABLE message ADD COLUMN call_seconds INTEGER;
  UPDATE message SET call_seconds = CAST(round(json_extract(raw_json, '$.call_duration')) AS INTEGER)
    WHERE type = 'call' AND platform IN ('messenger', 'instagram')
      AND json_type(raw_json, '$.call_duration') IN ('integer', 'real') AND json_extract(raw_json, '$.call_duration') >= 0;
  CREATE INDEX message_call ON message(conversation_id, sent_at) WHERE type = 'call';
  `,
  `
  -- A call whose app does not say how long it was may be given its length by
  -- the captain (call_length, one row per call record, in whole seconds; see
  -- calls.ts). Imports never touch it, and the change log records it, so it
  -- can be undone. An app's own length (message.call_seconds) always wins.
  --
  -- Messenger's phone-app export (the messenger-export connector) keeps each
  -- call as an empty item of type "link": no text, no media, no length. Those
  -- already imported become call records, as the connector now reads them.
  -- Signal says when a one-to-one call was missed or not answered; those
  -- already imported get the length 0, as an unanswered Messenger call has.
  CREATE TABLE call_length (
    message_id INTEGER PRIMARY KEY REFERENCES message(id),
    seconds INTEGER NOT NULL CHECK (seconds > 0),
    set_at INTEGER NOT NULL
  );
  UPDATE message SET type = 'call'
    WHERE platform = 'messenger' AND type = 'link' AND coalesce(text, '') = '' AND unsent = 0
      AND first_source_id IN (SELECT id FROM source WHERE connector = 'messenger-export')
      AND json_extract(raw_json, '$.type') = 'link' AND coalesce(json_extract(raw_json, '$.text'), '') = ''
      AND coalesce(json_array_length(raw_json, '$.media'), 0) = 0
      AND NOT EXISTS (SELECT 1 FROM attachment a WHERE a.message_id = message.id);
  UPDATE message SET call_seconds = 0
    WHERE platform = 'signal' AND type = 'call' AND call_seconds IS NULL
      AND json_extract(raw_json, '$.updateMessage.individualCall.state') IN ('MISSED', 'NOT_ACCEPTED', 'MISSED_NOTIFICATION_PROFILE');
  `,
  // A WeChat call record says how long the call was connected, or that it
  // never connected, in the words the app shows for it (the wechat-ios
  // connector now reads them, records.ts voipCall). Those already imported get
  // their length from the words their original record kept (raw_json's
  // Message); one WeChat compressed, imported without the dictionary, kept none
  // and stays without a length. Only call records are read.
  (db) => {
    const calls = db
      .prepare("SELECT id, json_extract(raw_json, '$.Message') AS words FROM message WHERE platform = 'wechat' AND type = 'call' AND call_seconds IS NULL AND json_type(raw_json, '$.Message') = 'text'")
      .all() as { id: number; words: string }[];
    const set = db.prepare("UPDATE message SET call_seconds = ? WHERE id = ?");
    let changed = 0;
    for (const { id, words } of calls) {
      const call = voipCall(words);
      if (call) changed += Number(set.run(call.seconds, id).changes);
    }
    if (changed > 0) bumpMeta(db, "people_version");
  },
  `
  -- A catch-up can say when it started again (migration 26 took its time
  -- away): 19:30 on its local date, or NULL when not said, as every
  -- catch-up so far is. It places the catch-up in the chat and is shown; the
  -- closeness score never reads it. The change log's rows of them get none, so
  -- undoing an older changeset puts back a catch-up as catch-ups are now kept.
  ALTER TABLE catch_up ADD COLUMN time TEXT CHECK (time IS NULL OR time GLOB '[0-2][0-9]:[0-5][0-9]');
  UPDATE change_row SET
    before_json = json_set(before_json, '$.time', NULL),
    after_json = json_set(after_json, '$.time', NULL)
  WHERE tbl = 'catch_up';
  `,
  `
  -- Catch-ups say whether they were by a call again (by_call, 1 by a call,
  -- 0 in person), so the closeness score does not count such a call twice.
  -- Migration 28 wrote it into the note, "By call" or "By call: <note>": a
  -- note of either shape is taken back out into the flag, as it was, and the
  -- change log's rows of them follow, so undoing an older changeset puts back
  -- a catch-up as catch-ups are now kept. Every other catch-up is in person.
  ALTER TABLE catch_up ADD COLUMN by_call INTEGER NOT NULL DEFAULT 0 CHECK (by_call IN (0, 1));
  UPDATE catch_up SET by_call = 1, note = CASE note WHEN 'By call' THEN '' ELSE trim(substr(note, 10)) END
  WHERE note = 'By call' OR substr(note, 1, 9) = 'By call: ';
  UPDATE change_row SET
    before_json = CASE WHEN before_json ->> '$.note' = 'By call' OR substr(before_json ->> '$.note', 1, 9) = 'By call: '
      THEN json_set(before_json, '$.by_call', 1, '$.note', CASE before_json ->> '$.note' WHEN 'By call' THEN '' ELSE trim(substr(before_json ->> '$.note', 10)) END)
      ELSE json_set(before_json, '$.by_call', 0) END,
    after_json = CASE WHEN after_json ->> '$.note' = 'By call' OR substr(after_json ->> '$.note', 1, 9) = 'By call: '
      THEN json_set(after_json, '$.by_call', 1, '$.note', CASE after_json ->> '$.note' WHEN 'By call' THEN '' ELSE trim(substr(after_json ->> '$.note', 10)) END)
      ELSE json_set(after_json, '$.by_call', 0) END
  WHERE tbl = 'catch_up';
  `,
  // Drafts (drafts.ts): messages the captain is writing to someone, any number
  // per person, saved as he types; his panel shows the first. Each person's
  // draft opener (person.draft_opener, the first message he meant to send
  // them) becomes their first draft, and the column goes. The change log's
  // person rows keep it in their before and after, which undo no longer
  // reads. How many moved is kept in meta as drafts_from_openers, for
  // `npm run archive -- migrate` to tell.
  //
  // Calls the captain logs himself (manual_call, calls.ts): with one person,
  // when they started, how long they lasted and on what app. Imports never
  // write them, so a re-import neither deletes nor repeats one, and they count
  // as the imported calls do.
  (db) => {
    const now = Date.now();
    db.exec(`
      CREATE TABLE draft (
        id INTEGER PRIMARY KEY,
        person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        text TEXT NOT NULL CHECK (text <> ''),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX draft_person ON draft(person_id);
      CREATE TABLE manual_call (
        id INTEGER PRIMARY KEY,
        person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,                       -- when it started, ms since the epoch
        duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
        app TEXT NOT NULL CHECK (app IN ('phone', 'facetime', 'messenger', 'instagram', 'wechat', 'telegram', 'other')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX manual_call_person_at ON manual_call(person_id, at);
    `);
    const moved = Number(db
      .prepare("INSERT INTO draft (person_id, text, created_at, updated_at) SELECT id, draft_opener, ?, ? FROM person WHERE draft_opener <> '' ORDER BY id")
      .run(now, now).changes);
    db.exec("ALTER TABLE person DROP COLUMN draft_opener");
    setMeta(db, "drafts_from_openers", String(moved));
    if (moved > 0) console.log(`Moved ${moved} draft ${moved === 1 ? "opener" : "openers"} into drafts.`);
  },
  // A logged call is on one of the person's accounts (account_id), as an
  // imported call is: who it was with is that account's person, so it goes
  // with the account through a merge or a detach, and its platform is the
  // account's. Only someone with no account that carries calls has one on no
  // account, with them (person_id) and on the app he said (app); exactly one
  // of the two is kept. Each call logged before goes on the one account of
  // its person's on its app (a FaceTime one on their phone or iMessage
  // account), where there is exactly one; else it stays on no account. The
  // change log's rows of them are moved the same way, so undo puts back a
  // call as calls are now kept. How many moved and stayed is kept in meta as
  // logged_calls_to_accounts, for `npm run archive -- migrate` to tell.
  // Everything here is this migration's own, so it never changes.
  (db) => {
    db.exec(`
      CREATE TABLE manual_call_next (
        id INTEGER PRIMARY KEY,
        person_id INTEGER REFERENCES person(id) ON DELETE CASCADE,  -- on no account: who it was with
        account_id INTEGER REFERENCES import_person(id),            -- the account it was on, whose person it was with
        at INTEGER NOT NULL,                       -- when it started, ms since the epoch
        duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
        app TEXT CHECK (app IN ('phone', 'facetime', 'messenger', 'instagram', 'wechat', 'telegram', 'other')),  -- on no account: the app
        created_at INTEGER NOT NULL,
        CHECK ((account_id IS NULL) = (person_id IS NOT NULL) AND (account_id IS NULL) = (app IS NOT NULL))
      );
    `);
    const platforms: Record<string, string[]> = {
      phone: ["phone"], facetime: ["phone", "imessage"], messenger: ["messenger"], instagram: ["instagram"], wechat: ["wechat"], telegram: ["telegram"],
    };
    const accountsOf = db.prepare("SELECT id, platform FROM import_person WHERE person_id = ? AND is_self = 0");
    /** The one account of `personId`'s on `app`, or null. */
    const accountFor = (personId: unknown, app: unknown): number | null => {
      const on = platforms[String(app)] ?? [];
      const found = (accountsOf.all(personId as number) as { id: number; platform: string }[]).filter((a) => on.includes(a.platform));
      return found.length === 1 ? found[0].id : null;
    };
    const insert = db.prepare("INSERT INTO manual_call_next (id, person_id, account_id, at, duration_seconds, app, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    let onAccounts = 0;
    let onNone = 0;
    for (const call of db.prepare("SELECT id, person_id, at, duration_seconds, app, created_at FROM manual_call ORDER BY id").all() as
      { id: number; person_id: number; at: number; duration_seconds: number; app: string; created_at: number }[]) {
      const account = accountFor(call.person_id, call.app);
      if (account === null) onNone++;
      else onAccounts++;
      insert.run(call.id, account === null ? call.person_id : null, account, call.at, call.duration_seconds, account === null ? call.app : null, call.created_at);
    }
    db.exec(`
      DROP TABLE manual_call;
      ALTER TABLE manual_call_next RENAME TO manual_call;
      CREATE INDEX manual_call_person_at ON manual_call(person_id, at);
      CREATE INDEX manual_call_account_at ON manual_call(account_id, at);
    `);
    const rows = db.prepare("SELECT id, before_json, after_json FROM change_row WHERE tbl = 'manual_call'").all() as { id: number; before_json: string | null; after_json: string | null }[];
    const update = db.prepare("UPDATE change_row SET before_json = ?, after_json = ? WHERE id = ?");
    const moved = (json: string | null) => {
      if (json === null) return null;
      const row = JSON.parse(json) as Record<string, unknown>;
      const account = accountFor(row.person_id, row.app);
      return JSON.stringify(account === null ? { ...row, account_id: null } : { ...row, person_id: null, account_id: account, app: null });
    };
    for (const row of rows) update.run(moved(row.before_json), moved(row.after_json), row.id);
    setMeta(db, "logged_calls_to_accounts", JSON.stringify({ onAccounts, onNone }));
    if (onAccounts + onNone > 0) console.log(`Logged calls: ${onAccounts} went on an account, ${onNone} stayed on none.`);
  },
  // The hue the captain picked for someone's identicon (src/identicon.ts), whole degrees: their colour everywhere,
  // the seed still drawing the picture. Null, as for everyone until then, is the seed's own.
  `
  ALTER TABLE person ADD COLUMN identicon_hue INTEGER CHECK (identicon_hue BETWEEN 0 AND 359);
  `,
  // A call the captain logs may be with several people (a group call): one
  // logged call each, every one on that person's account, all at the same
  // time and as long, sharing call_group, the number of the first logged.
  // Every call logged before is a group of one (its own number), and so is
  // each in the change log, so undo puts one back as calls are now kept.
  `
  CREATE TABLE manual_call_next (
    id INTEGER PRIMARY KEY,
    call_group INTEGER NOT NULL,                                -- shared by the calls logged as one, with several people
    person_id INTEGER REFERENCES person(id) ON DELETE CASCADE,  -- on no account: who it was with
    account_id INTEGER REFERENCES import_person(id),            -- the account it was on, whose person it was with
    at INTEGER NOT NULL,                       -- when it started, ms since the epoch
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
    app TEXT CHECK (app IN ('phone', 'facetime', 'messenger', 'instagram', 'wechat', 'telegram', 'other')),  -- on no account: the app
    created_at INTEGER NOT NULL,
    CHECK ((account_id IS NULL) = (person_id IS NOT NULL) AND (account_id IS NULL) = (app IS NOT NULL))
  );
  INSERT INTO manual_call_next (id, call_group, person_id, account_id, at, duration_seconds, app, created_at)
    SELECT id, id, person_id, account_id, at, duration_seconds, app, created_at FROM manual_call;
  DROP TABLE manual_call;
  ALTER TABLE manual_call_next RENAME TO manual_call;
  CREATE INDEX manual_call_person_at ON manual_call(person_id, at);
  CREATE INDEX manual_call_account_at ON manual_call(account_id, at);
  CREATE INDEX manual_call_group ON manual_call(call_group);
  UPDATE change_row SET
    before_json = CASE WHEN before_json IS NULL THEN NULL ELSE json_set(before_json, '$.call_group', row_key ->> '$[0]') END,
    after_json = CASE WHEN after_json IS NULL THEN NULL ELSE json_set(after_json, '$.call_group', row_key ->> '$[0]') END
  WHERE tbl = 'manual_call';
  `,
  // A person's names are one list, in order, the person panel's chips: their
  // name first, which is now their label, then their aliases. Until now the
  // first alias was the label, with the name beneath, so for everyone with an
  // alias the two change places, and each keeps the label they had: the first
  // alias becomes the name (the captain's, as he chose it) and the name the
  // first alias. An alias that repeats the name goes. The change log's rows
  // of people are moved the same way, so undo puts a person back as names are
  // now kept. How many people's name changed is kept in meta as names_first_alias_leads.
  // Everything here is this migration's own, so it never changes.
  (db) => {
    /** A person's row, or a change log's copy of one, with the first alias as its name. */
    const rotated = (row: Record<string, unknown>): Record<string, unknown> | null => {
      if (typeof row.name !== "string" || typeof row.aliases_json !== "string") return null;
      const aliases = JSON.parse(row.aliases_json) as string[];
      if (aliases.length === 0) return null;
      const [name, ...rest] = [...new Set([aliases[0], row.name, ...aliases.slice(1)])];
      const next: Record<string, unknown> = { ...row, name, aliases_json: JSON.stringify(rest) };
      if (name !== row.name && "name_source" in row) next.name_source = "captain";
      return next.aliases_json === row.aliases_json && name === row.name ? null : next;
    };
    const update = db.prepare("UPDATE person SET name = ?, name_source = ?, aliases_json = ? WHERE id = ?");
    let changed = 0;
    for (const row of db.prepare("SELECT id, name, name_source, aliases_json FROM person").all() as Record<string, unknown>[]) {
      const next = rotated(row);
      if (next === null) continue;
      update.run(next.name as string, next.name_source as string, next.aliases_json as string, row.id as number);
      if (next.name !== row.name) changed++;
    }
    const rows = db.prepare("SELECT id, before_json, after_json FROM change_row WHERE tbl = 'person'").all() as { id: number; before_json: string | null; after_json: string | null }[];
    const updateRow = db.prepare("UPDATE change_row SET before_json = ?, after_json = ? WHERE id = ?");
    const moved = (json: string | null) => {
      if (json === null) return null;
      const next = rotated(JSON.parse(json) as Record<string, unknown>);
      return next === null ? json : JSON.stringify(next);
    };
    for (const row of rows) updateRow.run(moved(row.before_json), moved(row.after_json), row.id);
    setMeta(db, "names_first_alias_leads", String(changed));
    if (changed > 0) console.log(`Names: ${changed} ${changed === 1 ? "person's first alias is" : "people's first aliases are"} now their name.`);
  },
  // A group chat the captain unlinked someone from (People.unlinkFromGroup):
  // they stay a member of it (its size, their counts and closeness keep it),
  // but it connects them to nobody: no shared group, friend circle or
  // highlight through it. By person, so it follows their accounts; imports
  // never write it, so a re-import keeps it.
  `
  CREATE TABLE group_unlink (
    person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    unlinked_at INTEGER NOT NULL,
    PRIMARY KEY (person_id, conversation_id)
  ) WITHOUT ROWID;
  CREATE INDEX group_unlink_conversation ON group_unlink(conversation_id);
  `,
  // The trail of content reads (contentLog.ts): every read of message text, search or an attachment's file through
  // the CLI's timeline and search and the app's /api/archive/content/ routes, with who read it, what and why. The
  // same read again soon after adds to its row. Only adds this table.
  `
  CREATE TABLE content_read (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,                       -- the first read, ms since the epoch
    last_at INTEGER NOT NULL,                  -- the last read added to it
    reads INTEGER NOT NULL DEFAULT 1 CHECK (reads >= 1),
    surface TEXT NOT NULL CHECK (surface IN ('cli', 'app')),
    reader TEXT,                               -- who, as $FRIEND_MAP_READER named them; null when unnamed (and the app's)
    what TEXT NOT NULL,                        -- the command or route: timeline, search, conversation, day or attachments
    scope_json TEXT NOT NULL,                  -- what it read: {"person":12}, {"conversation":41,"day":"2026-10-04"}, ...
    why TEXT                                   -- the captain's words for the job, when given
  );
  CREATE INDEX content_read_last_at ON content_read(last_at);
  `,
  // A call in no chat (the call table) may now be an app's call with several
  // people made in no group chat (a WhatsApp three-way call): one row for each
  // person on it its source names, all sharing its platform and call id, with
  // how many more were on it unnamed (others, 0 for every call before). It may
  // be an app's voice or video call, and of no known length (NULL: answered on
  // another of the captain's devices). The table is rebuilt for its new checks
  // and key; its rows keep their ids.
  `
  CREATE TABLE call_next (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    platform_call_id TEXT NOT NULL,
    import_person_id INTEGER NOT NULL REFERENCES import_person(id),  -- who it was with: one row for each on a call with several
    at INTEGER NOT NULL,                       -- when it started, ms since the epoch
    duration_seconds INTEGER CHECK (duration_seconds >= 0),  -- how long it was connected; NULL when the source does not say
    direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
    answered INTEGER NOT NULL CHECK (answered IN (0, 1)),
    service TEXT NOT NULL CHECK (service IN ('phone', 'facetime-audio', 'facetime-video', 'voice', 'video')),
    others INTEGER NOT NULL DEFAULT 0 CHECK (others >= 0),  -- how many more were on it, whom its source cannot name
    first_source_id INTEGER NOT NULL REFERENCES source(id),
    last_source_id INTEGER NOT NULL REFERENCES source(id),
    raw_json TEXT NOT NULL,
    UNIQUE (platform, platform_call_id, import_person_id)
  );
  INSERT INTO call_next (id, platform, platform_call_id, import_person_id, at, duration_seconds, direction, answered, service,
      first_source_id, last_source_id, raw_json)
    SELECT id, platform, platform_call_id, import_person_id, at, duration_seconds, direction, answered, service,
      first_source_id, last_source_id, raw_json FROM call;
  DROP TABLE call;
  ALTER TABLE call_next RENAME TO call;
  CREATE INDEX call_import_person_at ON call(import_person_id, at);
  CREATE INDEX call_at ON call(at);
  `,
  // Telegram's live bridge writes each call as a notice from whoever called
  // ("Call ended (12 minutes and 5 seconds)", "Video call missed", in a group
  // "Started a video chat"), which was kept as a text message. The
  // matrix-bridge connector now reads it as a call record, as the other apps'
  // are (telegramCallNotice in connectors/matrix-bridge/rig.ts), so those
  // already kept become calls in place, with how long each was connected (0
  // for one never connected; none when the words do not say), keeping their
  // words and original record; and a notice of a call ringing ("Started a
  // call"), which the call record after it stands for, becomes a system
  // message from no one. Only the bridge's notices (m.notice) kept as text
  // on Telegram are read.
  (db) => {
    const notices = db
      .prepare("SELECT id, text FROM message WHERE platform = 'telegram' AND type = 'text' AND json_extract(raw_json, '$.content.msgtype') = 'm.notice'")
      .all() as { id: number; text: string | null }[];
    const toCall = db.prepare("UPDATE message SET type = 'call', call_seconds = ? WHERE id = ?");
    const toSystem = db.prepare("UPDATE message SET type = 'system', sender_account_id = NULL, is_from_self = 0 WHERE id = ?");
    let calls = 0;
    let rings = 0;
    for (const { id, text } of notices) {
      const notice = telegramCallNotice(text ?? "");
      if (notice?.kind === "call") {
        toCall.run(notice.seconds ?? null, id);
        calls++;
      } else if (notice?.kind === "ring") {
        toSystem.run(id);
        rings++;
      }
    }
    if (calls + rings === 0) return;
    // Calls count as no message, and toward closeness: every open view works it out again.
    bumpMeta(db, "people_version");
    console.log(`Telegram's call notices: ${calls} became calls, ${rings} of a call ringing system messages.`);
  },
  // The life archive's event index (events.ts): one row for each thing that happened, by when, what kind, on which
  // device and from which source, keyed on its source's own id so an import again changes nothing; never its content,
  // only how big it is and whether there is any behind it. Its detail is in a typed table (detail, detail_id). The
  // first source is the captain's conversations with an LLM (the llm-sessions connector): llm_session and llm_turn
  // say where each session's file is and where in it each prompt and reply is, never their text. Only adds tables.
  `
  CREATE TABLE device (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,                  -- the connector's name for it, the same every import: computer:<host name>
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('computer', 'phone', 'other'))
  );

  CREATE TABLE event (
    id INTEGER PRIMARY KEY,
    origin TEXT NOT NULL,                      -- where it comes from: a chat platform, or claude-code
    native_id TEXT NOT NULL,                   -- the source's own id for it, the same every import
    kind TEXT NOT NULL,                        -- llm_session, llm_prompt, llm_reply (events.ts EVENT_KINDS)
    subkind TEXT,                              -- a session: how it was run; a reply: what started its turn
    at INTEGER NOT NULL,                       -- when, ms since the epoch
    at_end INTEGER CHECK (at_end >= at),       -- when it ended, for what lasts
    day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),  -- the local date of at
    self INTEGER NOT NULL CHECK (self IN (0, 1)),       -- the captain did it
    direction TEXT CHECK (direction IN ('in', 'out')),
    detail TEXT NOT NULL,                      -- the typed table its detail is in, and its row there
    detail_id INTEGER NOT NULL,
    device_id INTEGER REFERENCES device(id),
    size INTEGER CHECK (size >= 0),            -- how big its content is, never the content: characters of text, bytes of a file
    has_content INTEGER NOT NULL CHECK (has_content IN (0, 1)),
    first_source_id INTEGER NOT NULL REFERENCES source(id),
    last_source_id INTEGER NOT NULL REFERENCES source(id),
    UNIQUE (origin, native_id),
    UNIQUE (detail, detail_id)
  );
  CREATE INDEX event_day ON event(day, at);
  CREATE INDEX event_kind_time ON event(kind, at);

  CREATE TABLE llm_session (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,                     -- the folder it ran in
    file TEXT NOT NULL,                        -- the session file, where its content stays
    version TEXT,                              -- the tool's version, as the session last wrote it
    model TEXT                                 -- the model most of its replies came from
  );

  CREATE TABLE llm_turn (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES llm_session(id),
    role TEXT NOT NULL CHECK (role IN ('prompt', 'reply')),
    reply_to INTEGER REFERENCES llm_turn(id),  -- a reply's prompt; empty for a reply to a notification
    model TEXT,                                -- the model that wrote the reply, or answered the prompt
    images INTEGER NOT NULL DEFAULT 0,         -- pictures in a prompt
    tool_calls INTEGER NOT NULL DEFAULT 0,     -- tools a reply used on its way
    line INTEGER NOT NULL CHECK (line >= 1),   -- its first line in the session file
    byte_offset INTEGER NOT NULL,              -- where its lines are in the file
    byte_length INTEGER NOT NULL
  );
  CREATE INDEX llm_turn_session ON llm_turn(session_id, byte_offset);
  `,
  `
  -- "show-name" is built in, like "live-together" (migration 31): someone
  -- with it is named while the name choice is No name except… (src/names.ts),
  -- and nobody else is. A tag of that name the captain already made is kept,
  -- with its people and its place in the order, and marked built in;
  -- otherwise it is added, last, with an id no tag the change log remembers
  -- has had.
  UPDATE tag SET built_in = 1 WHERE name = 'show-name';
  INSERT INTO tag (id, name, sort_order, built_in, created_at)
    SELECT max(coalesce((SELECT max(id) FROM tag), 0), coalesce((SELECT max(row_key ->> 0) FROM change_row WHERE tbl = 'tag'), 0)) + 1,
      'show-name', (SELECT coalesce(max(sort_order), -1) + 1 FROM tag), 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE NOT EXISTS (SELECT 1 FROM tag WHERE name = 'show-name');
  `,
  `
  -- Calls take a note, as hangouts do (calls.ts; Events' Calls table and the
  -- chat show it): the captain's own words, content, which SQL never reads.
  -- A call he logged keeps it on each of its rows (manual_call.note, one note
  -- for the whole group, as its time and length are; empty for none, as every
  -- call so far). An imported call keeps it apart (call_note), as its length
  -- is (call_length), so imports never touch it: one row for each call he
  -- has given a note, a call record in a chat by its message, or a call in no
  -- chat by its source's own key (platform and platform_call_id, which every
  -- row of a call with several people shares and a re-import keeps). A note
  -- taken away leaves its row, emptied, so the change log's undo always finds
  -- the call's one row where it was. The change log's rows of logged calls
  -- get the empty note, so undoing an older changeset puts back a logged call
  -- as logged calls are now kept.
  ALTER TABLE manual_call ADD COLUMN note TEXT NOT NULL DEFAULT '';
  UPDATE change_row SET
    before_json = json_set(before_json, '$.note', ''),
    after_json = json_set(after_json, '$.note', '')
  WHERE tbl = 'manual_call';
  CREATE TABLE call_note (
    id INTEGER PRIMARY KEY,
    message_id INTEGER UNIQUE REFERENCES message(id),  -- a call record in a one-to-one chat
    platform TEXT,                             -- or a call in no chat (the call table), by its source's own key
    platform_call_id TEXT,
    note TEXT NOT NULL,                        -- empty once taken away
    set_at INTEGER NOT NULL,
    UNIQUE (platform, platform_call_id),
    CHECK ((message_id IS NOT NULL AND platform IS NULL AND platform_call_id IS NULL)
      OR (message_id IS NULL AND platform IS NOT NULL AND platform_call_id IS NOT NULL))
  );
  `,
  `
  -- Whether an imported call was answered, as the captain says (calls.ts,
  -- setCallAnswered; Events' Calls table): over its source's own, which stays
  -- as it was (call.answered, or a call record's length), so imports never
  -- touch it. Kept as call_note keeps a note: one row for each call he has
  -- set, a call record in a chat by its message, a call in no chat by its
  -- source's own key. answered is 'answered', 'missed' or 'unknown'; set back
  -- to what its source says, it is emptied (''), so the change log's undo
  -- always finds the call's one row where it was. A call he logged was
  -- answered, and takes none.
  CREATE TABLE call_answered (
    id INTEGER PRIMARY KEY,
    message_id INTEGER UNIQUE REFERENCES message(id),  -- a call record in a one-to-one chat
    platform TEXT,                             -- or a call in no chat (the call table), by its source's own key
    platform_call_id TEXT,
    answered TEXT NOT NULL CHECK (answered IN ('', 'answered', 'missed', 'unknown')),
    set_at INTEGER NOT NULL,
    UNIQUE (platform, platform_call_id),
    CHECK ((message_id IS NOT NULL AND platform IS NULL AND platform_call_id IS NULL)
      OR (message_id IS NULL AND platform IS NOT NULL AND platform_call_id IS NOT NULL))
  );
  `,
  `
  -- A call the captain logs on no account may be on WhatsApp, Signal or
  -- Discord too (MANUAL_CALL_APPS in src/archive.ts), so the check on
  -- manual_call.app takes them: the table is made again with it, every call
  -- kept as it was, with its number and its indexes.
  CREATE TABLE manual_call_next (
    id INTEGER PRIMARY KEY,
    call_group INTEGER NOT NULL,                                -- shared by the calls logged as one, with several people
    person_id INTEGER REFERENCES person(id) ON DELETE CASCADE,  -- on no account: who it was with
    account_id INTEGER REFERENCES import_person(id),            -- the account it was on, whose person it was with
    at INTEGER NOT NULL,                       -- when it started, ms since the epoch
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
    app TEXT CHECK (app IN ('phone', 'facetime', 'whatsapp', 'messenger', 'instagram', 'signal', 'telegram', 'wechat', 'discord', 'other')),  -- on no account: the app
    created_at INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    CHECK ((account_id IS NULL) = (person_id IS NOT NULL) AND (account_id IS NULL) = (app IS NOT NULL))
  );
  INSERT INTO manual_call_next (id, call_group, person_id, account_id, at, duration_seconds, app, created_at, note)
    SELECT id, call_group, person_id, account_id, at, duration_seconds, app, created_at, note FROM manual_call;
  DROP TABLE manual_call;
  ALTER TABLE manual_call_next RENAME TO manual_call;
  CREATE INDEX manual_call_person_at ON manual_call(person_id, at);
  CREATE INDEX manual_call_account_at ON manual_call(account_id, at);
  CREATE INDEX manual_call_group ON manual_call(call_group);
  `,
  `
  -- How long each message's text is, in characters: a size, which the
  -- privacy policy counts as metadata (as event.size is), so the viewer
  -- (server/viewer/) can show it and add it up without reading the text,
  -- which its connection cannot. One row for each message with text, kept by
  -- triggers as message_fts is, and filled here once. A table of its own
  -- rather than a column of message, so filling it writes a few megabytes
  -- rather than every page of message, and adding it up reads only it.
  CREATE TABLE message_chars (
    message_id INTEGER PRIMARY KEY REFERENCES message(id),
    chars INTEGER NOT NULL                     -- length(text): characters, not bytes
  );
  INSERT INTO message_chars (message_id, chars) SELECT id, length(text) FROM message WHERE text IS NOT NULL;
  CREATE TRIGGER message_chars_insert AFTER INSERT ON message WHEN new.text IS NOT NULL BEGIN
    INSERT INTO message_chars (message_id, chars) VALUES (new.id, length(new.text));
  END;
  CREATE TRIGGER message_chars_update AFTER UPDATE OF text ON message BEGIN
    DELETE FROM message_chars WHERE message_id = old.id;
    INSERT INTO message_chars (message_id, chars) SELECT new.id, length(new.text) WHERE new.text IS NOT NULL;
  END;
  CREATE TRIGGER message_chars_delete AFTER DELETE ON message BEGIN
    DELETE FROM message_chars WHERE message_id = old.id;
  END;
  `,
  `
  -- A catch-up may be a trip over several days (a trip away together, in
  -- person, never by a call): from its day at its time, which it then needs,
  -- to trip_last_day at trip_end_time, less trip_private_from to
  -- trip_private_to of each day (times of day, across midnight when the
  -- first is the later). Its hours are then its time together in all, which
  -- the archive works out from them (tripHours in src/catchUps.ts). All four
  -- NULL for one on a single day, as every catch-up so far is, and the
  -- change log's rows of them get none, so undoing an older changeset puts
  -- back a catch-up as catch-ups are now kept.
  ALTER TABLE catch_up ADD COLUMN trip_last_day TEXT
    CHECK (trip_last_day IS NULL OR (trip_last_day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND trip_last_day > day AND by_call = 0 AND time IS NOT NULL));
  ALTER TABLE catch_up ADD COLUMN trip_end_time TEXT
    CHECK ((trip_end_time IS NULL) = (trip_last_day IS NULL) AND (trip_end_time IS NULL OR trip_end_time GLOB '[0-2][0-9]:[0-5][0-9]'));
  ALTER TABLE catch_up ADD COLUMN trip_private_from TEXT
    CHECK ((trip_private_from IS NULL) = (trip_last_day IS NULL) AND (trip_private_from IS NULL OR trip_private_from GLOB '[0-2][0-9]:[0-5][0-9]'));
  ALTER TABLE catch_up ADD COLUMN trip_private_to TEXT
    CHECK ((trip_private_to IS NULL) = (trip_last_day IS NULL) AND (trip_private_to IS NULL OR trip_private_to GLOB '[0-2][0-9]:[0-5][0-9]'));
  UPDATE change_row SET
    before_json = json_set(before_json, '$.trip_last_day', NULL, '$.trip_end_time', NULL, '$.trip_private_from', NULL, '$.trip_private_to', NULL),
    after_json = json_set(after_json, '$.trip_last_day', NULL, '$.trip_end_time', NULL, '$.trip_private_from', NULL, '$.trip_private_to', NULL)
  WHERE tbl = 'catch_up';
  `,
  `
  -- The event index's second source: the captain's evening check-ins from
  -- rituals (the rituals connector), kind ritual_checkin, one for each
  -- ritual's day, keyed checkin/<day>. Its detail is that day, the evening's
  -- even when the check-in came after midnight (so not always the event's
  -- own day). No content: an instant, how it is known (subkind) and the day.
  CREATE TABLE ritual_checkin (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')
  );
  `,
  `
  -- The event index's habit times, from rituals (the rituals connector), kind
  -- ritual_habit: one for each time the captain did a habit that rituals
  -- records with a time, keyed habit/<rituals' id>, so two doses of protein
  -- are two. Its detail is the ritual's day (the evening's, as a check-in's)
  -- and the habit; how the time is known is the event's subkind. A doing with
  -- no time has no instant, so it is not here. No content.
  CREATE TABLE ritual_habit (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
    habit TEXT NOT NULL CHECK (habit <> '')
  );
  `,
  `
  -- The event index's workouts (events.ts), kind workout: one for each copy a
  -- source of them keeps of an activity (the polar connector's, origin polar,
  -- keyed on Polar's exercise id; Strava's or Garmin's export later), from its
  -- start (at) to its end (at_end), its sport family the subkind and the bytes
  -- of its copy the size. Its detail is what the copy holds, never a heart rate
  -- or a coordinate: the sport in the source's word, how far, what recorded it,
  -- which sample streams it has (a JSON object: each stream's samples and how
  -- often, in seconds), and where the copy is (file, and the source's own
  -- recording beside it, raw_file), named relative to the archive's folder.
  -- The copies of one activity are kept apart, each as its source gave it;
  -- which are one activity, and which to show, is worked out over the index
  -- (workouts.ts), never stored.
  CREATE TABLE workout (
    id INTEGER PRIMARY KEY,
    sport TEXT NOT NULL CHECK (sport <> ''),
    distance_m REAL CHECK (distance_m >= 0),
    recorder TEXT,
    streams TEXT NOT NULL CHECK (json_valid(streams) AND json_type(streams) = 'object'),
    file TEXT NOT NULL,
    raw_file TEXT
  );
  `,
  `
  -- The captain's inspirations (inspirations.ts): things he keeps for the ideas in them, a post, a video, a page or a
  -- photo. One row for each thing, holding his caption and his tags, fed by any number of saves (each time and place
  -- it was sent to the archive), joined by its canonical link (inspirationLinks.ts; none for a kept file alone).
  -- All of it is metadata (docs/features.md's "Inspirations"). Title, author and description are what is known of it: what
  -- the agent that sent it saw, then its preview (previews.ts), which only fills what is still empty, as does
  -- image_url, the preview's picture. Its AI tags are worked out by the archive's AI service (aiTags.ts) and kept apart
  -- from his own (inspiration_ai_tag), with the model and when; ai_state and preview_state are the server's queue.
  CREATE TABLE inspiration (
    id INTEGER PRIMARY KEY,
    link TEXT UNIQUE,                          -- canonical; NULL for a kept file with no link
    platform TEXT NOT NULL CHECK (platform <> ''),
    form TEXT NOT NULL CHECK (form IN ('post', 'reel', 'video', 'short', 'tweet', 'article', 'image', 'other')),
    title TEXT,
    author TEXT,
    description TEXT,
    image_url TEXT,
    caption TEXT NOT NULL DEFAULT '',          -- his words for it, written as a note is
    hidden_at INTEGER,                         -- hidden from the page, as the tag archive hides a person
    created_at INTEGER NOT NULL,
    edited_at INTEGER,                         -- when he last changed its caption, tags or hidden
    preview_state TEXT NOT NULL DEFAULT 'pending' CHECK (preview_state IN ('pending', 'done', 'none', 'failed')),
    ai_state TEXT NOT NULL DEFAULT 'pending' CHECK (ai_state IN ('pending', 'done', 'failed')),
    ai_model TEXT,
    ai_at INTEGER,
    ai_error TEXT,
    ai_tries INTEGER NOT NULL DEFAULT 0,
    ai_retry_at INTEGER NOT NULL DEFAULT 0     -- not asked again before this, after a failed try
  );
  CREATE INDEX inspiration_created ON inspiration(created_at);
  CREATE INDEX inspiration_queue ON inspiration(preview_state, ai_state);
  -- Each time and place it was saved: the origin (cli, grok-bot, later chrome or instagram-saved...), the source's own
  -- id for it when it has one (unique with the origin, so an import read again adds nothing), the link as given, the
  -- words that came with it, and when (NULL when the source does not say).
  CREATE TABLE inspiration_save (
    id INTEGER PRIMARY KEY,
    inspiration_id INTEGER NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
    origin TEXT NOT NULL CHECK (origin <> ''),
    native_id TEXT,
    link TEXT,
    caption TEXT NOT NULL DEFAULT '',
    saved_at INTEGER,
    UNIQUE (origin, native_id)
  );
  CREATE INDEX inspiration_save_item ON inspiration_save(inspiration_id);
  -- Files kept for it, by content hash in platform-exports/inspirations/live/ (connectors/media.ts): the photo or
  -- screenshot he shared (role item). Named relative to the archive's folder.
  CREATE TABLE inspiration_file (
    id INTEGER PRIMARY KEY,
    inspiration_id INTEGER NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('item', 'preview')),
    path TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    UNIQUE (inspiration_id, sha256)
  );
  CREATE INDEX inspiration_file_sha ON inspiration_file(sha256);
  -- His inspiration tags, one vocabulary apart from people's (tag): each with a line saying what it covers, in his
  -- order; inspiration_item_tag says which item has which.
  CREATE TABLE inspiration_tag (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE inspiration_item_tag (
    inspiration_id INTEGER NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES inspiration_tag(id),
    added_at INTEGER NOT NULL,
    PRIMARY KEY (inspiration_id, tag_id)
  );
  CREATE INDEX inspiration_item_tag_tag ON inspiration_item_tag(tag_id);
  -- The AI's tags for each item, best first (rank 0): free words, written as tags are, never his.
  CREATE TABLE inspiration_ai_tag (
    inspiration_id INTEGER NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    rank INTEGER NOT NULL,
    PRIMARY KEY (inspiration_id, name)
  );
  CREATE INDEX inspiration_ai_tag_name ON inspiration_ai_tag(name);
  `,
  `
  -- Instagram's previews, fetched slowly from its public embed page (inspirations/instagram.ts): each item's tries,
  -- when it may be tried again, and what its last try said (found, skipped and why, blocked); and every fetch made,
  -- which paces them (a few seconds apart, a cap a day, a long pause after Instagram refuses one) across restarts.
  -- A preview's picture is kept as a file of the item, role preview, by content hash.
  ALTER TABLE inspiration ADD COLUMN preview_tries INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE inspiration ADD COLUMN preview_retry_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE inspiration ADD COLUMN preview_note TEXT;
  CREATE TABLE inspiration_fetch (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    inspiration_id INTEGER REFERENCES inspiration(id) ON DELETE SET NULL,
    at INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('found', 'empty', 'blocked', 'failed')),
    note TEXT,
    next_at INTEGER NOT NULL                   -- the platform's next fetch not before this
  );
  CREATE INDEX inspiration_fetch_at ON inspiration_fetch(platform, at);
  `,
  // The viewer reads content too: a chat or an LLM session opened from a row's drawer (server/viewer/content.ts), each
  // read in the trail with the surface viewer. The table is rebuilt for its wider check; its rows keep their ids.
  `
  CREATE TABLE content_read_next (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,                       -- the first read, ms since the epoch
    last_at INTEGER NOT NULL,                  -- the last read added to it
    reads INTEGER NOT NULL DEFAULT 1 CHECK (reads >= 1),
    surface TEXT NOT NULL CHECK (surface IN ('cli', 'app', 'viewer')),
    reader TEXT,                               -- who, as $LIFE_ARCHIVE_READER named them; null when unnamed (the app's, the viewer's)
    what TEXT NOT NULL,                        -- the command or route: timeline, search, event-content, conversation, day or attachments
    scope_json TEXT NOT NULL,                  -- what it read: {"person":12}, {"conversation":41,"day":"2026-10-04"}, ...
    why TEXT                                   -- the captain's words for the job, when given
  );
  INSERT INTO content_read_next (id, at, last_at, reads, surface, reader, what, scope_json, why)
    SELECT id, at, last_at, reads, surface, reader, what, scope_json, why FROM content_read;
  DROP TABLE content_read;
  ALTER TABLE content_read_next RENAME TO content_read;
  CREATE INDEX content_read_last_at ON content_read(last_at);
  `,
  `
  -- A call the captain logs may have people on it he does not name, as a
  -- hangout may (manual_call.others), each taking a share of its time in the
  -- closeness score as an app's call's unnamed people do (PERSON_CALLS counts
  -- them among its people). Every row of a group keeps it, as its note is; 0
  -- for none, as every call so far. A hangout by call (catch_up.by_call, from
  -- before calls were their own kind) becomes one of these, its others with
  -- it, when the captain says (npm run archive -- repair by-call-catch-ups,
  -- byCallCatchUps.ts); nothing writes by_call 1 any more. The change log's
  -- rows of logged calls get none, so undoing an older changeset puts back a
  -- logged call as logged calls are now kept.
  ALTER TABLE manual_call ADD COLUMN others INTEGER NOT NULL DEFAULT 0 CHECK (others BETWEEN 0 AND 10000);
  UPDATE change_row SET
    before_json = json_set(before_json, '$.others', 0),
    after_json = json_set(after_json, '$.others', 0)
  WHERE tbl = 'manual_call';
  `,
  // A hangout is time in person, and no catch-up can be by call any more: catch_up.by_call goes, the table rebuilt
  // without it (a trip's check named it, so SQLite cannot drop it in place). Refused while any is still by call, as
  // dropping it would make that one in person: the release before this one (commit 499570f) makes each the call it
  // was (npm run archive -- repair by-call-catch-ups --apply). The change log's rows keep by_call as logged, so an
  // older changeset still shows "by call" (changes.ts); undoing one that would bring a hangout back by call is
  // refused, and the rest undo as before.
  (db) => {
    const { n } = db.prepare("SELECT count(*) AS n FROM catch_up WHERE by_call = 1").get() as { n: number };
    if (n > 0) {
      throw new Error(
        `${n} ${n === 1 ? "catch-up is" : "catch-ups are"} still by call, and a catch-up is in person now: make each the call it was ` +
          "with the release before this one (commit 499570f: npm run archive -- repair by-call-catch-ups --apply), then open the archive again",
      );
    }
    db.exec(`
    CREATE TABLE catch_up_new (
      id INTEGER PRIMARY KEY,
      day TEXT NOT NULL,                       -- its local date, 2026-10-04
      time TEXT CHECK (time IS NULL OR time GLOB '[0-2][0-9]:[0-5][0-9]'),  -- when it started, if he said
      hours REAL NOT NULL CHECK (hours > 0),   -- how long it lasted (a trip: its time together in all)
      note TEXT NOT NULL DEFAULT '',
      others INTEGER NOT NULL DEFAULT 0 CHECK (others >= 0),  -- people there he does not name
      created_at INTEGER NOT NULL,
      trip_last_day TEXT
        CHECK (trip_last_day IS NULL OR (trip_last_day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND trip_last_day > day AND time IS NOT NULL)),
      trip_end_time TEXT
        CHECK ((trip_end_time IS NULL) = (trip_last_day IS NULL) AND (trip_end_time IS NULL OR trip_end_time GLOB '[0-2][0-9]:[0-5][0-9]')),
      trip_private_from TEXT
        CHECK ((trip_private_from IS NULL) = (trip_last_day IS NULL) AND (trip_private_from IS NULL OR trip_private_from GLOB '[0-2][0-9]:[0-5][0-9]')),
      trip_private_to TEXT
        CHECK ((trip_private_to IS NULL) = (trip_last_day IS NULL) AND (trip_private_to IS NULL OR trip_private_to GLOB '[0-2][0-9]:[0-5][0-9]'))
    );
    INSERT INTO catch_up_new (id, day, time, hours, note, others, created_at, trip_last_day, trip_end_time, trip_private_from, trip_private_to)
      SELECT id, day, time, hours, note, others, created_at, trip_last_day, trip_end_time, trip_private_from, trip_private_to FROM catch_up;
    DROP TABLE catch_up;
    ALTER TABLE catch_up_new RENAME TO catch_up;
    CREATE INDEX catch_up_day ON catch_up(day);
    `);
  },
  `
  -- The workouts the captain deleted from the Exercise page (server/exercise/delete.ts), one row for each copy the
  -- delete removed, so no source brings it back (deletedWorkouts.ts): the copy's source and the source's own id for it,
  -- its sport family and from when to when (so another source's copy of the same activity, under another id, is known
  -- too, as workouts.ts matches copies), and when it was deleted. Nothing else of it: no heart rate, route, distance,
  -- sport word or file; the copy itself, its files and its index rows are gone.
  CREATE TABLE deleted_workout (
    origin TEXT NOT NULL CHECK (origin <> ''),
    native_id TEXT NOT NULL CHECK (native_id <> ''),
    family TEXT NOT NULL,
    at INTEGER NOT NULL,
    at_end INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL,
    PRIMARY KEY (origin, native_id)
  );
  CREATE INDEX deleted_workout_at ON deleted_workout(at);
  `,
  `
  -- The event index's workouts from rituals (the rituals connector), kind ritual_workouts: one for each day the
  -- captain logged workouts there, keyed workouts/<day>, from the day's start to its end local time (rituals keeps no
  -- time of day). Rituals names no workout in what it shows, so a day's are kept whole: its detail is the day, each
  -- workout's category and the minutes it states, if one (a JSON list of {type, minutes}, in rituals' order), and
  -- where the archive's copy of them is (file, relative to the archive's folder), whose titles and words are content.
  -- A day rituals changes updates its row, and one whose workouts rituals took out keeps its row with none ([]).
  CREATE TABLE ritual_workouts (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
    workouts TEXT NOT NULL CHECK (json_valid(workouts) AND json_type(workouts) = 'array'),
    file TEXT NOT NULL
  );
  `,
  `
  -- An inspiration whose words ask for something to be done ("it'd be cool if we reproduced this") asks firstmate for
  -- a probe: the archive's AI, when it tags the item, says whether his words are an ask (inspirations/aiTags.ts), and
  -- the server's worker then sends firstmate one note for the item, once (inspirations/probes.ts), kept here as when.
  -- The probe's result, a report's or preview's link, is set by firstmate from the CLI (inspiration probe <item>
  -- --result <link>) and shown on the item; neither is one of his edits, so neither is a changeset.
  ALTER TABLE inspiration ADD COLUMN probe_requested_at INTEGER;
  ALTER TABLE inspiration ADD COLUMN probe_result TEXT;
  ALTER TABLE inspiration ADD COLUMN probe_result_at INTEGER;
  `,
  `
  -- The event index's days from rituals (the rituals connector), kind ritual_day: one for each day rituals shows,
  -- closed or still open, keyed day/<day>, from the day's start to its end. Its detail is the day and
  -- how each habit stood on it (a JSON object by habit: its status in rituals' word, and a plank done with its held
  -- time as m:ss), so the Events calendar's Rituals row says done over asked from the calendar (server/calendar/)
  -- rather than from rituals. No content. A day rituals changes updates its row. Only adds a table.
  CREATE TABLE ritual_day (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
    cells TEXT NOT NULL CHECK (json_valid(cells) AND json_type(cells) = 'object')
  );
  `,
  // The tables migrations before this one made while this database held everything, which are not friend map's: the
  // core's event index, agents' sessions, inspirations and trail of content reads, and the exercise and rituals
  // modules' old tables. The move (server/archive/migrate.ts) dropped them from the archive it took; a new archive,
  // made by those migrations, has them empty. They go when every one there is empty, so a new archive holds what a
  // moved one does. When any holds a row (an archive the move has not finished with), they all stay as they are, for
  // the move to copy and drop: this never drops a row. The list is this migration's own, so it never changes.
  (db) => {
    const tables = [
      "event", "device", "llm_session", "llm_turn", "content_read",
      "inspiration", "inspiration_tag", "inspiration_item_tag", "inspiration_ai_tag", "inspiration_file", "inspiration_save", "inspiration_fetch",
      "workout", "deleted_workout", "ritual_checkin", "ritual_habit", "ritual_day", "ritual_workouts",
    ].filter((table) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined);
    if (tables.some((table) => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined)) return;
    for (const table of tables) db.exec(`DROP TABLE ${table}`);
  },
];

/** The schema version this code writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Opens (creating if need be) the archive and brings its schema up to date.
 * `context.dataDir` is where an older archive's person files are read from
 * when they move into the person table (migration 5); without it there are none.
 */
export function openArchive(file: string, context: MigrationContext = {}): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  // Foreign keys go on once the schema is up to date (see migrate).
  const db = new DatabaseSync(file, { timeout: 10_000, enableForeignKeyConstraints: false });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  migrate(db, context);
  db.exec("PRAGMA foreign_keys = ON");
  if (context.version === undefined) holdTimeZone(db);
  return db;
}

/**
 * The archive's days (each row's day, the tables' date keys) were reckoned in one zone, so it keeps that zone in its
 * meta table from its first open, and refuses any other: a day counted in two zones would quietly disagree with itself.
 * Moving an archive to another zone would need its days worked out again, which nothing does yet.
 */
function holdTimeZone(db: Db): void {
  const kept = getMeta(db, "time_zone");
  if (kept === null) return setMeta(db, "time_zone", TIME_ZONE);
  if (kept === TIME_ZONE) return;
  db.close();
  throw new Error(`this archive's days are in ${kept}, but its settings say ${TIME_ZONE}: put "timeZone": "${kept}" back in settings.json, as nothing can move an archive to another zone yet`);
}

/** The schema version of the archive in `file`, read without opening it for writing or bringing it up to date. */
export function schemaVersionOf(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return schemaVersion(db);
  } finally {
    db.close();
  }
}


function migrate(db: Db, context: MigrationContext): void {
  const version = schemaVersion(db);
  if (version > MIGRATIONS.length) {
    throw new Error(`the archive is at schema version ${version}, newer than this code knows (${MIGRATIONS.length})`);
  }
  // Foreign keys stay off while migrating (SQLite's way to rebuild a table), and are checked before each commit.
  for (let next = version; next < (context.version ?? MIGRATIONS.length); next++) {
    transaction(db, () => {
      const migration = MIGRATIONS[next];
      if (typeof migration === "string") db.exec(migration);
      else migration(db, context);
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new Error(`migration ${next + 1} left ${broken.length} broken references, e.g. ${JSON.stringify(broken[0])}`);
      db.exec(`PRAGMA user_version = ${next + 1}`);
    });
  }
}


/**
 * What migration 27 did when Met and Lives became Location, kept in meta as location_fold for an archive that had
 * any values: how many people took their met value, how many kept their lives value, those who had both (the same
 * place but for case, or different places, when lives was kept and met went), and how many had a location after.
 */
export interface LocationFold {
  movedFromMet: number;
  keptFromLives: number;
  bothSame: number;
  bothDifferent: Array<{ id: number; name: string; met: string; lives: string }>;
  withLocation: number;
}

/** What migration 27 did (see LocationFold), or null when the archive had no met or lives values then. */
export function locationFold(db: Db): LocationFold | null {
  const value = getMeta(db, "location_fold");
  return value === null ? null : (JSON.parse(value) as LocationFold);
}

/**
 * What migration 32 did when Location became a column of person, kept in meta as location_column for an archive that
 * had any location values: before, how many people had a location, how many values they had between them, and how
 * many values nobody had (gone with the table); after, how many people have one and how many different ones.
 */
export interface LocationColumn {
  before: { people: number; values: number; unused: number };
  after: { people: number; values: number };
}

/** How many draft openers migration 38 made drafts (0 for an archive that had none, a new one too). */
export function draftsFromOpeners(db: Db): number {
  return Number(getMeta(db, "drafts_from_openers") ?? 0);
}

/**
 * What migration 39 did when logged calls went on accounts: how many went on one, and how many stayed on none (no
 * one account of their person's on their app); null for an archive that had none then.
 */
export function loggedCallsToAccounts(db: Db): { onAccounts: number; onNone: number } | null {
  const value = getMeta(db, "logged_calls_to_accounts");
  const counts = value === null ? null : (JSON.parse(value) as { onAccounts: number; onNone: number });
  return counts && counts.onAccounts + counts.onNone > 0 ? counts : null;
}

/** How many people's first alias migration 42 made their name (0 for an archive where nobody had an alias, a new one too). */
export function namesFirstAliasLeads(db: Db): number {
  return Number(getMeta(db, "names_first_alias_leads") ?? 0);
}

/** What migration 32 did (see LocationColumn), or null when the archive had no location values then. */
export function locationColumn(db: Db): LocationColumn | null {
  const value = getMeta(db, "location_column");
  return value === null ? null : (JSON.parse(value) as LocationColumn);
}
