// The inspirations' part of their change log (the core's Changes, sdk/server.ts, over the module's database: part.ts):
// which of their tables a changeset logs, and how its changes to them are said, as any module gives the log its own tables.

import { quoted, type ChangeDescriber, type Db, type LoggedChange, type TableSpec } from "../../../sdk/server.ts";

/** The inspirations' logged tables (store.ts's INSPIRATION_TABLES), each with its key and the columns kept. */
export const INSPIRATION_LOG_TABLES: Readonly<Record<string, TableSpec>> = {
  // An inspiration's caption set or hidden (store.ts): items are made by captures, never by an edit.
  inspiration: { key: ["id"], columns: ["caption", "hidden_at", "edited_at"], loose: ["edited_at"], updateOnly: true },
  // His inspiration tags, and which item has which.
  inspiration_tag: { key: ["id"], columns: ["name", "description", "sort_order", "created_at"], loose: [] },
  inspiration_item_tag: { key: ["inspiration_id", "tag_id"], columns: ["added_at"], loose: ["added_at"] },
};

/** How the change log over `db` says the inspirations' changes: who or what a refused undo is about, and the summary's lines. */
export function inspirationsDescriber(db: Db): ChangeDescriber {
  /** An inspiration as the change log names it: its number, and its title (or link) when it has one. */
  const inspirationName = (id: number): string => {
    const row = db.prepare("SELECT title, link FROM inspiration WHERE id = ?").get(id) as { title: string | null; link: string | null } | undefined;
    const label = row?.title ?? row?.link;
    return `inspiration #${id}${label ? ` "${label.length > 60 ? `${label.slice(0, 59)}…` : label}"` : ""}`;
  };
  return {
    conflictOf: (change, row, { now, changedSince }) => {
      switch (change.tbl) {
        case "inspiration": {
          const what = now ? changedSince.map((c) => (c === "hidden_at" ? "hidden" : c)).join(", ") : "";
          return { personId: null, name: inspirationName(Number(row.id)), what: what || "changed" };
        }
        case "inspiration_item_tag":
          return { personId: null, name: inspirationName(Number(row.inspiration_id)), what: "tags" };
        case "inspiration_tag":
          return { personId: null, name: `the inspiration tag "${row.name}"`, what: "inspiration tags" };
        default:
          return null;
      }
    },
    // An item's tag put back whose tag has been deleted since.
    references: { inspiration_item_tag: { personId: null, name: "an inspiration tag it puts back", what: "it has been deleted since" } },
    lines: (changes) => inspirationLines(db, changes, inspirationName),
  };
}

/**
 * A line for each inspiration the changeset changed (its tags, caption, hidden), and for each change to the
 * inspiration tags (added, renamed, described, deleted, the order), for the summary's other lines.
 */
function inspirationLines(db: Db, changes: readonly LoggedChange[], inspirationName: (id: number) => string): string[] {
  const of = (tbl: string) => changes.filter((c) => c.tbl === tbl);
  const tagRows = new Map(of("inspiration_tag").map((c) => [Number((JSON.parse(c.key) as number[])[0]), c]));
  const tagNow = (id: number) => db.prepare("SELECT name, sort_order FROM inspiration_tag WHERE id = ?").get(id) as { name: string; sort_order: number } | undefined;
  const tagThen = (id: number) => {
    const row = tagRows.get(id);
    return row ? (row.before ? { name: String(row.before.name), sort_order: Number(row.before.sort_order) } : undefined) : tagNow(id);
  };
  const tagList = (ids: Iterable<number>, name: typeof tagNow) =>
    [...ids].map((tagId) => name(tagId) ?? { name: `tag ${tagId}`, sort_order: Infinity })
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)).map((t) => t.name).join(", ") || "(none)";
  const lines: string[] = [];
  const items = new Set([...of("inspiration"), ...of("inspiration_item_tag")].map((c) => Number((JSON.parse(c.key) as number[])[0])));
  // Renaming a tag changes the tags of every item with it, though no item row changed: they are said in the tag's line.
  for (const id of [...items].sort((a, b) => a - b)) {
    const name = inspirationName(id);
    const row = of("inspiration").find((c) => JSON.parse(c.key)[0] === id);
    if (row?.before && row.after) {
      if (row.before.caption !== row.after.caption) lines.push(`${name}: caption ${quoted(row.before.caption)} -> ${quoted(row.after.caption)}`);
      if ((row.before.hidden_at === null) !== (row.after.hidden_at === null)) lines.push(`${name}: ${row.after.hidden_at === null ? "shown again" : "hidden"}`);
    }
    const tagChanges = of("inspiration_item_tag").filter((c) => JSON.parse(c.key)[0] === id);
    if (tagChanges.length === 0) continue;
    const now = (db.prepare("SELECT tag_id FROM inspiration_item_tag WHERE inspiration_id = ?").all(id) as { tag_id: number }[]).map((r) => r.tag_id);
    const then = new Set(now);
    for (const c of tagChanges) {
      const tagId = Number(JSON.parse(c.key)[1]);
      if (c.before === null) then.delete(tagId);
      if (c.after === null) then.add(tagId);
    }
    const before = tagList(then, tagThen);
    const after = tagList(now, tagNow);
    if (before !== after) lines.push(`${name}: tags ${before} -> ${after}`);
  }
  for (const c of tagRows.values()) {
    if (c.before === null) lines.push(`added the inspiration tag "${c.after!.name}"`);
    else if (c.after === null) lines.push(`deleted the inspiration tag "${c.before.name}"`);
    else {
      if (c.before.name !== c.after.name) lines.push(`renamed the inspiration tag "${c.before.name}" to "${c.after.name}"`);
      if (c.before.description !== c.after.description) lines.push(`described the inspiration tag "${c.after.name}": ${quoted(c.after.description)}`);
    }
  }
  if ([...tagRows.values()].some((c) => c.before && c.after && c.before.sort_order !== c.after.sort_order)) lines.push("changed the inspiration tag order");
  return lines;
}
