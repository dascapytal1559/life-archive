// The captain's inspirations: the only code that reads or writes the inspiration tables (INSPIRATION_STORE_TABLES, in
// the module's own database, db.ts).
//
// An inspiration is a thing he keeps (a post, a video, a page, a photo), one row holding his caption and his tags,
// fed by any number of saves: each time and place it was sent in, kept as it came (its origin, the link as given, the
// words with it, when). Saves of one thing are one item by its canonical link (links.ts), or, for a kept
// file with no link, by the file's content hash.
//
// capture is the one way in, for every door (the iPhone's share sheet through the server's capture route, the CLI's
// inspiration add, which his Grok Bot agent runs, and later the back-fill importers): it finds or makes the item,
// records the save, fills what is known of it where nothing is yet, adds his words and tags, and queues its preview and
// AI tags for the server (previews.ts, aiTags.ts). His words are kept as he gave them: the item's caption is the first
// save's words, a later save's added after a blank line (never replacing them, never twice), each save keeping its own.
// A capture is not one of his edits, as an import is not: it makes no changeset. His edits after it (caption, tags,
// hidden, the vocabulary) are, made inside Changes.record by the CLI or the viewer's routes, so the change log shows
// them and Undo puts them back.
//
// Items kept before 8 November 2026 may carry a probe (probe_requested_at, probe_result, probe_result_at: when firstmate
// was told his words asked for something to be done, and a link to what came of it). Nothing sets them any more; they
// are only read, so the page can still show an old item's result link.
//
// Two kinds of tags, never merged: his own (manual), from his inspiration vocabulary (inspiration_tag, apart from
// people's tags), written as normalizeTag writes people's; and the AI's (inspiration_ai_tag), free words written the
// same way, kept with the model and when, made again when asked. A tag of his stays in the vocabulary when no item has
// it any more (he deletes it in the tag manager); renaming one onto another merges the two, as people's tags do.

import type {
  AiTagsState,
  InspirationDetail,
  InspirationFilter,
  InspirationImage,
  InspirationList,
  InspirationProbe,
  InspirationSummary,
  InspirationTagsAnswer,
} from "../wire.ts";
import { combineNotes, InvalidInputError, normalizeNote, normalizeTag, NotFoundError, transaction, type Db } from "../../../sdk/server.ts";
import { KEPT_PATH } from "./files.ts";
import { canonicalLink, fileForm, type InspirationForm } from "./links.ts";

/** Every table the inspirations keep in their database, in the order a copy fills them (references first). */
export const INSPIRATION_STORE_TABLES = [
  "inspiration", "inspiration_tag", "inspiration_item_tag", "inspiration_ai_tag", "inspiration_file", "inspiration_save", "inspiration_fetch",
] as const;

/** The tables a changeset of inspirations touches (changeLog.ts logs them): the viewer's Undo undoes only these. */
export const INSPIRATION_TABLES = ["inspiration", "inspiration_tag", "inspiration_item_tag"] as const;

/** After this many failed tries the AI's tags are given up on, until asked for again. */
export const AI_TRIES = 6;

/** The largest preview picture check-data accepts: Instagram's lane keeps one of about 20 to 40 KB, and refuses one over 400 KB. */
const MAX_PREVIEW_BYTES = 400 * 1024;

/** The longest of each field kept: what an agent sees of a post can be long. */
const LIMITS = { title: 500, author: 200, description: 4000, tagDescription: 300, probeResult: 2000 } as const;

/** A file kept for an item, already stored by content hash (files.ts), named relative to the module's folder. */
export interface KeptFile {
  path: string;
  mime: string;
  bytes: number;
  sha256: string;
}

/** What comes in with a capture. */
export interface CaptureInput {
  /** The link as given; none for a kept file alone. */
  link?: string | null;
  /** Files kept for it (a photo or screenshot); with no link, the first is what makes it one item. */
  files?: readonly KeptFile[];
  /** His words about it. */
  caption?: string;
  /** His tags for it. */
  tags?: readonly string[];
  /** What the agent that sent it saw of it (an Instagram preview, slow, comes later and fills only what this leaves empty). */
  title?: string | null;
  author?: string | null;
  description?: string | null;
  /** Where it came from: share-sheet, grok-bot, cli... */
  origin: string;
  /** The source's own id for this save, for an import read again; none for a capture. */
  nativeId?: string | null;
  /** When it was saved, ms (now for a capture; null when an import's source does not say). */
  savedAt: number | null;
  now: number;
}

export interface Captured {
  id: number;
  /** Whether it is new, or another save of an item already kept. */
  created: boolean;
  /** Whether the save is new (an import read again adds none). */
  saved: boolean;
}

/** An item waiting for its preview: what to ask for it. */
export interface PreviewWork {
  id: number;
  link: string;
  platform: string;
  /** The links its saves were given as, newest first: X's oEmbed wants a link with the author's name in it. */
  given: string[];
}

/** What a preview found; each fills only what is still empty. */
export interface Preview {
  title?: string | null;
  author?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  /** A title an importer stood in with (Instagram's "Instagram save <code>"): replaced by this preview's, or by none. */
  placeholderTitle?: string;
}

/** Where a paced preview stands: its tries, when it may be tried again, and what its last try said. */
export interface PreviewProgress {
  tries: number;
  retryAt: number;
  note: string | null;
}

/** An Instagram item waiting for its preview (inspirations/instagram.ts). */
export interface InstagramWork {
  id: number;
  link: string;
  title: string | null;
  tries: number;
}

/** One fetch of a paced platform, as inspiration_fetch keeps it. */
export interface FetchRecord {
  platform: string;
  inspirationId: number | null;
  at: number;
  outcome: "found" | "empty" | "blocked" | "failed";
  note: string | null;
  /** The platform's next fetch not before this. */
  nextAt: number;
}

/** How Instagram's previews stand: the items by where their preview is, and the fetches of the last day. */
export interface InstagramStatus {
  found: number;
  waiting: number;
  skipped: number;
  failed: number;
  notAsked: number;
  lastDay: number;
  last: FetchRecord | null;
}

/** An item waiting for its AI tags: everything known of it that the model is given. */
export interface AiWork {
  id: number;
  platform: string;
  form: string;
  link: string | null;
  title: string | null;
  author: string | null;
  description: string | null;
  caption: string;
  tags: string[];
  tries: number;
}

interface ItemRow {
  id: number;
  link: string | null;
  platform: string;
  form: string;
  title: string | null;
  author: string | null;
  description: string | null;
  image_url: string | null;
  caption: string;
  hidden_at: number | null;
  created_at: number;
  edited_at: number | null;
  preview_state: InspirationDetail["previewState"];
  preview_note: string | null;
  ai_state: AiTagsState;
  ai_model: string | null;
  ai_at: number | null;
  ai_error: string | null;
  probe_requested_at: number | null;
  probe_result: string | null;
  probe_result_at: number | null;
  tags: string | null;
  ai_tags: string | null;
  file_id: number | null;
  save_count: number;
}

/** The columns a list or an item is read with: its tags as JSON arrays, its first item file and how many saves. */
const ITEM_COLUMNS = `i.*,
  (SELECT json_group_array(name) FROM (SELECT t.name FROM inspiration_item_tag it JOIN inspiration_tag t ON t.id = it.tag_id
     WHERE it.inspiration_id = i.id ORDER BY t.sort_order, t.name)) AS tags,
  (SELECT json_group_array(name) FROM (SELECT name FROM inspiration_ai_tag WHERE inspiration_id = i.id ORDER BY rank)) AS ai_tags,
  coalesce((SELECT min(id) FROM inspiration_file WHERE inspiration_id = i.id AND role = 'item'),
           (SELECT min(id) FROM inspiration_file WHERE inspiration_id = i.id AND role = 'preview')) AS file_id,
  (SELECT count(*) FROM inspiration_save WHERE inspiration_id = i.id) AS save_count`;

export class Inspirations {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // --- coming in

  /** Finds or makes the item, records the save, and queues its preview and AI tags (see the top). */
  capture(input: CaptureInput): Captured {
    const canonical = input.link ? canonicalLink(input.link) : null;
    const files = input.files ?? [];
    if (!canonical && files.length === 0) throw new InvalidInputError("an inspiration needs a link or a file");
    const origin = cleanOrigin(input.origin);
    const caption = normalizeNote(input.caption ?? "");
    const tags = (input.tags ?? []).map(normalizeTag);
    const known = {
      title: cleanField(input.title, "a title", LIMITS.title),
      author: cleanField(input.author, "an author", LIMITS.author),
      description: cleanField(input.description, "a description", LIMITS.description, { lines: true }),
    };
    return transaction(this.db, () => {
      const found = canonical
        ? (this.db.prepare("SELECT id, caption FROM inspiration WHERE link = ?").get(canonical.link) as { id: number; caption: string } | undefined)
        : (this.db
            .prepare(`SELECT i.id, i.caption FROM inspiration i JOIN inspiration_file f ON f.inspiration_id = i.id
                      WHERE i.link IS NULL AND f.role = 'item' AND f.sha256 = ? ORDER BY i.id LIMIT 1`)
            .get(files[0].sha256) as { id: number; caption: string } | undefined);
      let id: number;
      if (found) {
        id = found.id;
        this.db
          .prepare("UPDATE inspiration SET title = coalesce(title, ?), author = coalesce(author, ?), description = coalesce(description, ?) WHERE id = ?")
          .run(known.title, known.author, known.description, id);
        const combined = combineNotes(found.caption, caption);
        if (combined !== found.caption) {
          this.db.prepare("UPDATE inspiration SET caption = ? WHERE id = ?").run(normalizeNote(combined), id);
          this.queueAi(id);
        }
      } else {
        const form: InspirationForm = canonical?.form ?? fileForm(files[0].path);
        id = Number(this.db
          .prepare(
            `INSERT INTO inspiration (link, platform, form, title, author, description, caption, created_at, preview_state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(canonical?.link ?? null, canonical?.platform ?? "file", form, known.title, known.author, known.description, caption, input.now, canonical ? "pending" : "none")
          .lastInsertRowid);
      }
      const saved = this.db
        .prepare("INSERT OR IGNORE INTO inspiration_save (inspiration_id, origin, native_id, link, caption, saved_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, origin, input.nativeId ?? null, input.link?.trim() || null, caption, input.savedAt).changes !== 0;
      const keep = this.db.prepare("INSERT OR IGNORE INTO inspiration_file (inspiration_id, role, path, mime, bytes, sha256, added_at) VALUES (?, 'item', ?, ?, ?, ?, ?)");
      for (const { path, mime, bytes, sha256 } of files) keep.run(id, path, mime, bytes, sha256, input.now);
      if (tags.length > 0) this.writeTags(id, [...new Set([...this.tagsOf(id), ...tags])], input.now);
      return { id, created: !found, saved };
    });
  }

  // --- reading (metadata, on any connection, the viewer's read-only one included)

  /** The items `filter` chooses, newest first, a page of them, and how many in all. */
  list(filter: InspirationFilter, { offset = 0, limit = 60 }: { offset?: number; limit?: number } = {}): InspirationList {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new InvalidInputError("offset is a whole number from 0");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new InvalidInputError("limit is a whole number from 1 to 500");
    const { where, values } = filterSql(filter);
    const total = (this.db.prepare(`SELECT count(*) AS n FROM inspiration i WHERE ${where}`).get(...values) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM inspiration i WHERE ${where} ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as unknown as ItemRow[];
    return { items: rows.map(summaryOf), total };
  }

  /** One item, with every save and file, and where its AI tags are; null when there is none. */
  get(id: number): InspirationDetail | null {
    const row = this.db.prepare(`SELECT ${ITEM_COLUMNS} FROM inspiration i WHERE i.id = ?`).get(id) as unknown as ItemRow | undefined;
    if (!row) return null;
    const saves = (this.db
      .prepare("SELECT id, origin, link, caption, saved_at FROM inspiration_save WHERE inspiration_id = ? ORDER BY coalesce(saved_at, 0) DESC, id DESC")
      .all(id) as { id: number; origin: string; link: string | null; caption: string; saved_at: number | null }[])
      .map((s) => ({ id: s.id, origin: s.origin, link: s.link, caption: s.caption, savedAt: s.saved_at }));
    const files = (this.db.prepare("SELECT id, role, mime, bytes FROM inspiration_file WHERE inspiration_id = ? ORDER BY id").all(id) as
      { id: number; role: "item" | "preview"; mime: string; bytes: number }[]).map((f) => ({ ...f }));
    return {
      ...summaryOf(row),
      saves,
      files,
      previewState: row.preview_state,
      previewNote: row.preview_note,
      ai: { state: row.ai_state, model: row.ai_model, at: row.ai_at, error: row.ai_error },
      editedAt: row.edited_at,
    };
  }

  /** An item, or NotFoundError. */
  existing(id: number): InspirationDetail {
    const item = Number.isSafeInteger(id) ? this.get(id) : null;
    if (!item) throw new NotFoundError(`there is no inspiration #${id}`);
    return item;
  }

  /** His vocabulary in his order with how many items have each, every AI tag in use, each platform's items, and the counts the page heads. */
  tags(): InspirationTagsAnswer {
    const shown = "SELECT id FROM inspiration WHERE hidden_at IS NULL";
    const tags = (this.db
      .prepare(`SELECT t.name, t.description, (SELECT count(*) FROM inspiration_item_tag it WHERE it.tag_id = t.id AND it.inspiration_id IN (${shown})) AS count
                FROM inspiration_tag t ORDER BY t.sort_order, t.name`)
      .all() as { name: string; description: string; count: number }[]).map((t) => ({ ...t }));
    const aiTags = (this.db
      .prepare(`SELECT name, count(*) AS count FROM inspiration_ai_tag WHERE inspiration_id IN (${shown}) GROUP BY name ORDER BY count DESC, name`)
      .all() as { name: string; count: number }[]).map((t) => ({ ...t }));
    const platforms = (this.db
      .prepare("SELECT platform, count(*) AS count FROM inspiration WHERE hidden_at IS NULL GROUP BY platform ORDER BY count DESC, platform")
      .all() as { platform: string; count: number }[]).map((p) => ({ ...p }));
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      tags,
      aiTags,
      platforms,
      untagged: count(`SELECT count(*) AS n FROM inspiration i WHERE i.hidden_at IS NULL AND NOT EXISTS (SELECT 1 FROM inspiration_item_tag it WHERE it.inspiration_id = i.id)`),
      total: count("SELECT count(*) AS n FROM inspiration WHERE hidden_at IS NULL"),
      hidden: count("SELECT count(*) AS n FROM inspiration WHERE hidden_at IS NOT NULL"),
    };
  }

  /** A kept file, to serve: where it is (relative to the module's folder), its type and size; null when there is none. */
  file(id: number): { path: string; mime: string; bytes: number } | null {
    return (this.db.prepare("SELECT path, mime, bytes FROM inspiration_file WHERE id = ?").get(id) as { path: string; mime: string; bytes: number } | undefined) ?? null;
  }

  /** Every kept file's number, in order: what the static demo keeps a copy of (module.ts's demo). */
  fileIds(): number[] {
    return (this.db.prepare("SELECT id FROM inspiration_file ORDER BY id").all() as Array<{ id: number }>).map(({ id }) => id);
  }

  // --- his edits (each inside a changeset, made by the caller)

  /** Sets his caption (written as a note is); a new one asks for the AI's tags again, since they read it. */
  setCaption(id: number, caption: unknown, now: number): void {
    const item = this.existing(id);
    const clean = normalizeNote(caption);
    if (clean === item.caption) return;
    transaction(this.db, () => {
      this.db.prepare("UPDATE inspiration SET caption = ?, edited_at = ? WHERE id = ?").run(clean, now, id);
      this.queueAi(id);
    });
  }

  /** Gives the item exactly these tags of his; a tag not yet in the vocabulary is added to it, last. */
  setTags(id: number, names: unknown, now: number): void {
    this.existing(id);
    if (!Array.isArray(names)) throw new InvalidInputError("tags must be a list");
    const clean = [...new Set(names.map(normalizeTag))];
    transaction(this.db, () => this.writeTags(id, clean, now));
  }

  /** Adds tags of his to the item. */
  tag(id: number, names: readonly string[], now: number): void {
    this.setTags(id, [...this.tagsOf(this.existing(id).id), ...names.map(normalizeTag)], now);
  }

  /** Takes tags of his from the item. */
  untag(id: number, names: readonly string[], now: number): void {
    const gone = new Set(names.map(normalizeTag));
    this.setTags(id, this.tagsOf(this.existing(id).id).filter((name) => !gone.has(name)), now);
  }

  setHidden(id: number, hidden: boolean, now: number): void {
    const item = this.existing(id);
    if (item.hidden === hidden) return;
    this.db.prepare("UPDATE inspiration SET hidden_at = ?, edited_at = ? WHERE id = ?").run(hidden ? now : null, now, id);
  }

  // --- his vocabulary (each inside a changeset, made by the caller)

  /** Adds a tag, last, with what it covers. Returns its name as stored. */
  createTag(name: unknown, description: unknown = "", now: number): string {
    const clean = normalizeTag(name);
    const about = cleanTagDescription(description);
    return transaction(this.db, () => {
      if (this.findTag(clean)) throw new InvalidInputError(`there is already an inspiration tag "${clean}"`);
      this.insertTag(clean, now, about);
      return clean;
    });
  }

  /** Renames a tag for every item with it; onto a tag that exists, the two are merged into that one, which keeps its place. */
  renameTag(from: unknown, to: unknown): { name: string; merged: boolean } {
    const old = this.existingTag(from);
    const name = normalizeTag(to);
    if (name === old.name) return { name, merged: false };
    return transaction(this.db, () => {
      const target = this.findTag(name);
      if (!target) {
        this.db.prepare("UPDATE inspiration_tag SET name = ? WHERE id = ?").run(name, old.id);
        return { name, merged: false };
      }
      this.db
        .prepare("INSERT OR IGNORE INTO inspiration_item_tag (inspiration_id, tag_id, added_at) SELECT inspiration_id, ?, added_at FROM inspiration_item_tag WHERE tag_id = ?")
        .run(target.id, old.id);
      if (!target.description && old.description) this.db.prepare("UPDATE inspiration_tag SET description = ? WHERE id = ?").run(old.description, target.id);
      this.removeTag(old.id);
      return { name, merged: true };
    });
  }

  /** Says what a tag covers (empty for nothing). */
  describeTag(name: unknown, description: unknown): void {
    const tag = this.existingTag(name);
    this.db.prepare("UPDATE inspiration_tag SET description = ? WHERE id = ?").run(cleanTagDescription(description), tag.id);
  }

  /** Moves a tag to `position` in his order (0 first; past the end is last). */
  moveTag(name: unknown, position: number): void {
    const tag = this.existingTag(name);
    if (!Number.isSafeInteger(position) || position < 0) throw new InvalidInputError("a position is a whole number from 0");
    transaction(this.db, () => {
      const order = this.tagIds().filter((id) => id !== tag.id);
      order.splice(Math.min(position, order.length), 0, tag.id);
      this.renumber(order);
    });
  }

  /** Deletes a tag, taking it from every item. Returns how many had it. */
  deleteTag(name: unknown): number {
    const tag = this.existingTag(name);
    return transaction(this.db, () => {
      const count = (this.db.prepare("SELECT count(*) AS n FROM inspiration_item_tag WHERE tag_id = ?").get(tag.id) as { n: number }).n;
      this.removeTag(tag.id);
      return count;
    });
  }

  // --- the server's queue: previews, then AI tags

  /** The next item whose preview is waiting, oldest first, Instagram's aside (nextInstagram); null when none is. */
  nextPreview(): PreviewWork | null {
    const row = this.db.prepare("SELECT id, link, platform FROM inspiration WHERE preview_state = 'pending' AND link IS NOT NULL AND platform <> 'instagram' ORDER BY id LIMIT 1").get() as
      { id: number; link: string; platform: string } | undefined;
    if (!row) return null;
    const given = (this.db.prepare("SELECT link FROM inspiration_save WHERE inspiration_id = ? AND link IS NOT NULL ORDER BY id DESC").all(row.id) as { link: string }[])
      .map((s) => s.link);
    return { ...row, given };
  }

  /**
   * Keeps what a preview found, filling only what is still empty (a placeholder title replaced): done, none (it found
   * nothing), failed, or, for a paced platform, pending again with its progress (tried again later). A preview found
   * after the AI's tags were made (Instagram's, paced, never waited for) asks for them again, so they read what it found.
   */
  setPreview(id: number, state: "done" | "none" | "failed" | "pending", preview: Preview = {}, progress?: PreviewProgress): void {
    const field = (value: string | null | undefined, limit: number) => {
      try {
        return cleanField(value, "a field", limit, { lines: limit === LIMITS.description, cut: true });
      } catch {
        return null;
      }
    };
    const image = typeof preview.imageUrl === "string" && /^https:\/\/\S{1,2000}$/.test(preview.imageUrl) ? preview.imageUrl : null;
    const known = () => this.db.prepare("SELECT title, author, description FROM inspiration WHERE id = ?").get(id) as { title: string | null; author: string | null; description: string | null } | undefined;
    transaction(this.db, () => {
      const before = known();
      if (preview.placeholderTitle) this.db.prepare("UPDATE inspiration SET title = NULL WHERE id = ? AND title = ?").run(id, preview.placeholderTitle);
      this.db
        .prepare(
          `UPDATE inspiration SET title = coalesce(title, ?), author = coalesce(author, ?), description = coalesce(description, ?),
           image_url = coalesce(image_url, ?), preview_state = ? WHERE id = ?`,
        )
        .run(field(preview.title, LIMITS.title), field(preview.author, LIMITS.author), field(preview.description, LIMITS.description), image, state, id);
      if (progress) {
        this.db.prepare("UPDATE inspiration SET preview_tries = ?, preview_retry_at = ?, preview_note = ? WHERE id = ?")
          .run(progress.tries, progress.retryAt, progress.note?.slice(0, 500) ?? null, id);
      }
      if (state === "done" && JSON.stringify(known()) !== JSON.stringify(before)) {
        this.db.prepare("UPDATE inspiration SET ai_state = 'pending', ai_tries = 0, ai_retry_at = 0, ai_error = NULL WHERE id = ? AND ai_state = 'done'").run(id);
      }
    });
  }

  /** Keeps a preview's picture, already stored by content hash, as a file of the item (role preview). */
  keepPreviewFile(id: number, file: KeptFile, now: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO inspiration_file (inspiration_id, role, path, mime, bytes, sha256, added_at) VALUES (?, 'preview', ?, ?, ?, ?, ?)")
      .run(id, file.path, file.mime, file.bytes, file.sha256, now);
  }

  // --- Instagram's previews, paced (inspirations/instagram.ts)

  /** The next Instagram item whose preview is waiting and due, oldest first; null when none is. */
  nextInstagram(now: number): InstagramWork | null {
    const row = this.db
      .prepare(
        `SELECT id, link, title, preview_tries AS tries FROM inspiration
         WHERE platform = 'instagram' AND preview_state = 'pending' AND link IS NOT NULL AND preview_retry_at <= ? ORDER BY id LIMIT 1`,
      )
      .get(now) as InstagramWork | undefined;
    return row ? { ...row } : null;
  }

  /** Keeps what one paced fetch came to, all at once: the item's preview and progress, its picture, and the fetch. */
  settleFetch(id: number, settled: { state: "done" | "none" | "failed" | "pending"; preview: Preview; progress: PreviewProgress; record: FetchRecord; picture: KeptFile | null }): void {
    transaction(this.db, () => {
      if (settled.picture) this.keepPreviewFile(id, settled.picture, settled.record.at);
      this.setPreview(id, settled.state, settled.preview, settled.progress);
      this.recordFetch(settled.record);
    });
  }

  /** Records one fetch of a paced platform. */
  recordFetch(fetch: FetchRecord): void {
    this.db
      .prepare("INSERT INTO inspiration_fetch (platform, inspiration_id, at, outcome, note, next_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(fetch.platform, fetch.inspirationId, fetch.at, fetch.outcome, fetch.note?.slice(0, 500) ?? null, fetch.nextAt);
  }

  /** The platform's latest fetches, newest first. */
  recentFetches(platform: string, limit: number): FetchRecord[] {
    return (this.db
      .prepare("SELECT platform, inspiration_id, at, outcome, note, next_at FROM inspiration_fetch WHERE platform = ? ORDER BY id DESC LIMIT ?")
      .all(platform, limit) as { platform: string; inspiration_id: number | null; at: number; outcome: FetchRecord["outcome"]; note: string | null; next_at: number }[])
      .map((row) => ({ platform: row.platform, inspirationId: row.inspiration_id, at: row.at, outcome: row.outcome, note: row.note, nextAt: row.next_at }));
  }

  /** When the platform's fetches since `since` were made, oldest first. */
  fetchTimes(platform: string, since: number): number[] {
    return (this.db.prepare("SELECT at FROM inspiration_fetch WHERE platform = ? AND at > ? ORDER BY at").all(platform, since) as { at: number }[]).map((row) => row.at);
  }

  /**
   * Asks for Instagram's previews: every Instagram item with a link and no picture whose preview found nothing, failed
   * or was stopped is waiting again, tried from the start. Returns how many.
   */
  queueInstagram(): number {
    return Number(this.db
      .prepare(
        `UPDATE inspiration SET preview_state = 'pending', preview_tries = 0, preview_retry_at = 0, preview_note = NULL
         WHERE platform = 'instagram' AND link IS NOT NULL AND preview_state IN ('none', 'failed')
           AND NOT EXISTS (SELECT 1 FROM inspiration_file f WHERE f.inspiration_id = inspiration.id AND f.role = 'preview')`,
      )
      .run().changes);
  }

  /** Stops Instagram's previews: every one waiting is asked for no more (queueInstagram asks again). Returns how many. */
  stopInstagram(): number {
    return Number(this.db
      .prepare("UPDATE inspiration SET preview_state = 'none', preview_note = 'stopped: inspiration instagram start asks again' WHERE platform = 'instagram' AND preview_state = 'pending'")
      .run().changes);
  }

  /** How Instagram's previews stand at `now`. */
  instagramStatus(now: number): InstagramStatus {
    const count = (where: string) => (this.db.prepare(`SELECT count(*) AS n FROM inspiration WHERE platform = 'instagram' AND link IS NOT NULL AND ${where}`).get() as { n: number }).n;
    return {
      found: count("preview_state = 'done'"),
      waiting: count("preview_state = 'pending'"),
      skipped: count("preview_state = 'none' AND preview_note IS NOT NULL"),
      failed: count("preview_state = 'failed'"),
      notAsked: count("preview_state = 'none' AND preview_note IS NULL"),
      lastDay: this.fetchTimes("instagram", now - 86_400_000).length,
      last: this.recentFetches("instagram", 1)[0] ?? null,
    };
  }

  /**
   * The next item whose AI tags are waiting and due, oldest first, once its preview has settled (so the model is told
   * what the preview found; Instagram's, paced over minutes or days, are not waited for); null when none is.
   */
  nextAiTags(now: number): AiWork | null {
    const row = this.db
      .prepare(
        `SELECT id, platform, form, link, title, author, description, caption, ai_tries
         FROM inspiration
         WHERE ai_state = 'pending' AND (preview_state <> 'pending' OR platform = 'instagram') AND ai_retry_at <= ? ORDER BY id LIMIT 1`,
      )
      .get(now) as (Omit<AiWork, "tags" | "tries"> & { ai_tries: number }) | undefined;
    if (!row) return null;
    const { ai_tries, ...rest } = row;
    return { ...rest, tags: this.tagsOf(row.id), tries: ai_tries };
  }

  /** Keeps the AI's tags for an item (best first, each written as tags are), with the model and when. */
  setAiTags(id: number, names: readonly string[], model: string, now: number): string[] {
    const clean = cleanAiTags(names);
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM inspiration_ai_tag WHERE inspiration_id = ?").run(id);
      const insert = this.db.prepare("INSERT INTO inspiration_ai_tag (inspiration_id, name, rank) VALUES (?, ?, ?)");
      clean.forEach((name, rank) => insert.run(id, name, rank));
      this.db.prepare("UPDATE inspiration SET ai_state = 'done', ai_model = ?, ai_at = ?, ai_error = NULL, ai_tries = 0, ai_retry_at = 0 WHERE id = ?")
        .run(model, now, id);
    });
    return clean;
  }

  /** The AI could not tag it: tried again after a growing wait (1, 2, 4... minutes, at most 30), and given up after AI_TRIES. */
  aiFailed(id: number, error: string, now: number): void {
    const { ai_tries: tries } = this.db.prepare("SELECT ai_tries FROM inspiration WHERE id = ?").get(id) as { ai_tries: number };
    const next = tries + 1;
    this.db
      .prepare("UPDATE inspiration SET ai_state = ?, ai_error = ?, ai_tries = ?, ai_retry_at = ? WHERE id = ?")
      .run(next >= AI_TRIES ? "failed" : "pending", error.slice(0, 500), next, now + Math.min(30, 2 ** tries) * 60_000, id);
  }

  /** Asks for the item's AI tags again (its old ones stay until the new ones come). */
  queueAi(id: number): void {
    this.db.prepare("UPDATE inspiration SET ai_state = 'pending', ai_tries = 0, ai_retry_at = 0, ai_error = NULL WHERE id = ?").run(id);
  }

  /** Asks again for every item whose AI tags were given up on; returns how many. */
  queueFailedAi(): number {
    return Number(this.db.prepare("UPDATE inspiration SET ai_state = 'pending', ai_tries = 0, ai_retry_at = 0, ai_error = NULL WHERE ai_state = 'failed'").run().changes);
  }

  // --- helpers

  /** An item's tags of his, in his order. */
  tagsOf(id: number): string[] {
    return (this.db
      .prepare("SELECT t.name FROM inspiration_item_tag it JOIN inspiration_tag t ON t.id = it.tag_id WHERE it.inspiration_id = ? ORDER BY t.sort_order, t.name")
      .all(id) as { name: string }[]).map((row) => row.name);
  }

  /** Gives `id` exactly the tags `names` (already written as tags are), adding new ones to the vocabulary, last. */
  private writeTags(id: number, names: readonly string[], now: number): void {
    const ids = names.map((name) => this.findTag(name)?.id ?? this.insertTag(name, now));
    const taken = Number(this.db
      .prepare("DELETE FROM inspiration_item_tag WHERE inspiration_id = ? AND tag_id NOT IN (SELECT value FROM json_each(?))")
      .run(id, JSON.stringify(ids)).changes);
    const add = this.db.prepare("INSERT OR IGNORE INTO inspiration_item_tag (inspiration_id, tag_id, added_at) VALUES (?, ?, ?)");
    let added = 0;
    for (const tagId of ids) added += Number(add.run(id, tagId, now).changes);
    if (taken + added > 0) this.db.prepare("UPDATE inspiration SET edited_at = ? WHERE id = ?").run(now, id);
  }

  private findTag(name: string): { id: number; name: string; description: string } | undefined {
    return this.db.prepare("SELECT id, name, description FROM inspiration_tag WHERE name = ?").get(name) as { id: number; name: string; description: string } | undefined;
  }

  private existingTag(name: unknown): { id: number; name: string; description: string } {
    const clean = normalizeTag(name);
    const tag = this.findTag(clean);
    if (!tag) throw new NotFoundError(`there is no inspiration tag "${clean}"`);
    return tag;
  }

  /** Adds a tag, last, with a number no tag the change log remembers has had, so an undo never finds it taken (as tags.ts does). */
  private insertTag(name: string, now: number, description = ""): number {
    const last = (this.db.prepare("SELECT coalesce(max(sort_order), -1) AS n FROM inspiration_tag").get() as { n: number }).n;
    const id = (this.db
      .prepare(`SELECT max(coalesce((SELECT max(id) FROM inspiration_tag), 0),
                          coalesce((SELECT max(row_key ->> 0) FROM change_row WHERE tbl = 'inspiration_tag'), 0)) + 1 AS id`)
      .get() as { id: number }).id;
    this.db.prepare("INSERT INTO inspiration_tag (id, name, description, sort_order, created_at) VALUES (?, ?, ?, ?, ?)").run(id, name, description, last + 1, now);
    return id;
  }

  private removeTag(tagId: number): void {
    this.db.prepare("DELETE FROM inspiration_item_tag WHERE tag_id = ?").run(tagId);
    this.db.prepare("DELETE FROM inspiration_tag WHERE id = ?").run(tagId);
    this.renumber(this.tagIds());
  }

  private tagIds(): number[] {
    return (this.db.prepare("SELECT id FROM inspiration_tag ORDER BY sort_order, name").all() as { id: number }[]).map((row) => row.id);
  }

  /** Numbers the tags 0, 1, 2... in this order. */
  private renumber(order: number[]): void {
    const update = this.db.prepare("UPDATE inspiration_tag SET sort_order = ? WHERE id = ? AND sort_order IS NOT ?");
    order.forEach((id, i) => update.run(i, id, i));
  }
}

/** The WHERE clause a filter is, over `inspiration i`, and its values. */
function filterSql(filter: InspirationFilter): { where: string; values: (string | number)[] } {
  const clauses = [filter.hidden ? "i.hidden_at IS NOT NULL" : "i.hidden_at IS NULL"];
  const values: (string | number)[] = [];
  for (const raw of filter.tags) {
    const name = normalizeTag(raw);
    clauses.push(filter.tagKind === "ai"
      ? "EXISTS (SELECT 1 FROM inspiration_ai_tag a WHERE a.inspiration_id = i.id AND a.name = ?)"
      : "EXISTS (SELECT 1 FROM inspiration_item_tag it JOIN inspiration_tag t ON t.id = it.tag_id WHERE it.inspiration_id = i.id AND t.name = ?)");
    values.push(name);
  }
  if (filter.untagged) clauses.push("NOT EXISTS (SELECT 1 FROM inspiration_item_tag it WHERE it.inspiration_id = i.id)");
  if (filter.platform) {
    clauses.push("i.platform = ?");
    values.push(filter.platform);
  }
  // Each word in any of what is known of it, his words and both kinds of tags (LIKE: any case, for Latin letters).
  const places = [
    "i.caption", "i.title", "i.author", "i.description", "i.link",
    "(SELECT group_concat(t.name, ' ') FROM inspiration_item_tag it JOIN inspiration_tag t ON t.id = it.tag_id WHERE it.inspiration_id = i.id)",
    "(SELECT group_concat(a.name, ' ') FROM inspiration_ai_tag a WHERE a.inspiration_id = i.id)",
  ];
  for (const word of filter.q.trim().split(/\s+/).filter(Boolean)) {
    const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    clauses.push(`(${places.map((place) => `${place} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    values.push(...places.map(() => like));
  }
  return { where: clauses.join(" AND "), values };
}

function summaryOf(row: ItemRow): InspirationSummary {
  const image: InspirationImage = row.file_id !== null ? { fileId: row.file_id } : row.image_url ? { url: row.image_url } : null;
  const probe: InspirationProbe | null = row.probe_requested_at !== null || row.probe_result !== null
    ? { requestedAt: row.probe_requested_at, result: row.probe_result, resultAt: row.probe_result_at }
    : null;
  return {
    id: row.id,
    link: row.link,
    platform: row.platform,
    form: row.form,
    title: row.title,
    author: row.author,
    description: row.description,
    caption: row.caption,
    tags: JSON.parse(row.tags ?? "[]") as string[],
    aiTags: JSON.parse(row.ai_tags ?? "[]") as string[],
    aiState: row.ai_state,
    image,
    createdAt: row.created_at,
    saveCount: row.save_count,
    hidden: row.hidden_at !== null,
    probe,
  };
}

/** A probe's result: a web link (http or https), up to 2000 characters; null for none. */
export function cleanProbeResult(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new InvalidInputError("a probe's result is a web link");
  const clean = value.trim();
  if (!clean) return null;
  if (!/^https?:\/\/\S+$/i.test(clean) || clean.length > LIMITS.probeResult) {
    throw new InvalidInputError(`"${clean.slice(0, 80)}" is not a probe's result: a web link (http or https, up to ${LIMITS.probeResult} characters) to its report or preview`);
  }
  return clean;
}

/** Where a save came from: a short lowercase word or hyphenated words (share-sheet, grok-bot, cli, instagram-saved). */
export function cleanOrigin(origin: unknown): string {
  if (typeof origin !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(origin)) {
    throw new InvalidInputError(`"${String(origin)}" is not an origin (lowercase letters, digits and dashes, up to 40, such as grok-bot)`);
  }
  return origin;
}

/**
 * A title, author or description: trimmed and single-spaced (a description keeps its lines), null for none; longer
 * than `limit` is refused, or with `cut`, cut short (a preview's).
 */
function cleanField(value: unknown, what: string, limit: number, { lines = false, cut = false }: { lines?: boolean; cut?: boolean } = {}): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new InvalidInputError(`${what} is text`);
  const clean = lines
    ? value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim().replace(/\s+/g, " ")).join("\n").replace(/\n{3,}/g, "\n\n").trim()
    : value.trim().replace(/\s+/g, " ");
  if (!clean) return null;
  if (clean.length > limit) {
    if (!cut) throw new InvalidInputError(`${what} is at most ${limit} characters`);
    return `${clean.slice(0, limit - 1).trimEnd()}…`;
  }
  return clean;
}

/** What a tag covers: one line, trimmed and single-spaced, up to 300 characters; empty for nothing. */
function cleanTagDescription(value: unknown): string {
  if (typeof value !== "string") throw new InvalidInputError("a tag's description is text");
  const clean = value.trim().replace(/\s+/g, " ");
  if (clean.length > LIMITS.tagDescription) throw new InvalidInputError(`a tag's description is at most ${LIMITS.tagDescription} characters`);
  return clean;
}

/** The AI's tags as kept: each written as a tag (those that are none dropped), without repeats, at most eight. */
export function cleanAiTags(names: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    try {
      const clean = normalizeTag(name);
      if (!out.includes(clean)) out.push(clean);
    } catch {
      // Not a tag (a sentence, say): left out.
    }
  }
  return out.slice(0, 8);
}


/**
 * What npm run check-data says of the inspirations in `db` (read-only), whose kept files are under the module's folder
 * `moduleFolder`: each item's link in its canonical form, its caption written as a note is, at least one save, each
 * save's origin, a kept file with no link, each file kept by its hash in the module's files/ (files.ts), a preview's picture a
 * small one (never a post's media whole: Instagram's previews keep one picture about 320 px across); each tag of his and of
 * the AI's written as a tag is, his tags' descriptions as the app writes them, and a probe's result a web link.
 */
export function inspirationProblems(db: Db, moduleFolder: string, exists: (path: string) => boolean): string[] {
  const problems: string[] = [];
  const items = db.prepare(
    `SELECT i.id, i.link, i.platform, i.caption, i.probe_result,
       (SELECT count(*) FROM inspiration_save s WHERE s.inspiration_id = i.id) AS saves,
       (SELECT count(*) FROM inspiration_file f WHERE f.inspiration_id = i.id AND f.role = 'item') AS files
     FROM inspiration i`,
  ).all() as { id: number; link: string | null; platform: string; caption: string; probe_result: string | null; saves: number; files: number }[];
  for (const item of items) {
    const at = `inspiration #${item.id}`;
    if (item.link !== null) {
      try {
        const canonical = canonicalLink(item.link);
        if (canonical.link !== item.link) problems.push(`${at}: its link is not in its canonical form (${canonical.link}); a save of the same thing would make another item`);
        if (canonical.platform !== item.platform) problems.push(`${at}: its platform is ${item.platform}, but its link is ${canonical.platform}'s`);
      } catch (error) {
        problems.push(`${at}: its link: ${(error as Error).message}`);
      }
    } else if (item.files === 0) problems.push(`${at}: it has neither a link nor a kept file`);
    try {
      if (normalizeNote(item.caption) !== item.caption) problems.push(`${at}: its caption is not written the way the app writes notes`);
    } catch (error) {
      problems.push(`${at}: its caption: ${(error as Error).message}`);
    }
    if (item.saves === 0) problems.push(`${at}: it has no save, and every item came in by one`);
    try {
      if (cleanProbeResult(item.probe_result) !== item.probe_result) problems.push(`${at}: its probe's result is not written the way the app writes it`);
    } catch (error) {
      problems.push(`${at}: its probe's result: ${(error as Error).message}`);
    }
  }
  for (const save of db.prepare("SELECT id, inspiration_id, origin FROM inspiration_save").all() as { id: number; inspiration_id: number; origin: string }[]) {
    try {
      cleanOrigin(save.origin);
    } catch (error) {
      problems.push(`inspiration #${save.inspiration_id}, save #${save.id}: ${(error as Error).message}`);
    }
  }
  for (const file of db.prepare("SELECT id, inspiration_id, role, path, bytes FROM inspiration_file").all() as { id: number; inspiration_id: number; role: string; path: string; bytes: number }[]) {
    if (file.role === "preview" && file.bytes > MAX_PREVIEW_BYTES) {
      problems.push(`inspiration #${file.inspiration_id}, file #${file.id}: a preview's picture of ${Math.round(file.bytes / 1024)} KB, more than a small picture (${MAX_PREVIEW_BYTES / 1024} KB)`);
    }
    if (!KEPT_PATH.test(file.path)) {
      problems.push(`inspiration #${file.inspiration_id}, file #${file.id}: it is not kept by content hash in modules/inspirations/files/ (${file.path})`);
    } else if (!exists(`${moduleFolder}/${file.path}`)) problems.push(`inspiration #${file.inspiration_id}, file #${file.id}: modules/inspirations/${file.path} is not in the archive's folder`);
  }
  for (const tag of db.prepare("SELECT name, description FROM inspiration_tag").all() as { name: string; description: string }[]) {
    try {
      if (normalizeTag(tag.name) !== tag.name) problems.push(`inspiration tag "${tag.name}": it is not written the way the app writes tags (${normalizeTag(tag.name)})`);
      if (cleanTagDescription(tag.description) !== tag.description) problems.push(`inspiration tag "${tag.name}": its description is not written the way the app writes them`);
    } catch (error) {
      problems.push(`inspiration tag "${tag.name}": ${(error as Error).message}`);
    }
  }
  for (const row of db.prepare("SELECT DISTINCT name FROM inspiration_ai_tag").all() as { name: string }[]) {
    if (cleanAiTags([row.name])[0] !== row.name) problems.push(`AI tag "${row.name}": it is not written the way the app writes tags`);
  }
  return problems;
}
