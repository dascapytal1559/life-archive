// Friend map's editors for its People and Tags tables (sdk/server.ts's `edits`; the core's server/edits/), Friend Map's
// own Table and tag manager folded into Events' Tables (the captain: "one table at a time, each once Events can do what
// Friend Map's does"). Neither table's rows are in the calendar, so each finds its own (TableEditor's `rows`). Every
// edit goes through friend map's own write, People's (people.ts) or the tag table's (tags.ts), as the person panel's and
// the tag manager's did, each one changeset of its change log named as their routes name it ("person tags", "tag
// rename"), so its undo is the change log's and an edit undone from Friend Map's Changes is undone in the record too.
//
//   a person   their name (the captain's from then on; one of their other names put first keeps the old as an alias),
//              their other names in order, their tags, where they are, whether they are hidden (the "archive" tag, the
//              "keep" tag that overrides the archive rules, or neither, as the rules say), whether to reach out to them,
//              and his note for them (no content: names, tags, locations and his notes for people are metadata)
//   a tag      its name (renamed for everyone; onto a tag that exists, the two are merged, as the tag manager did, and
//              Undo parts them again) and its place in the order; the built-in tags only move
//
// People he added by hand (someone he knows offline: no accounts) he also adds and deletes here (Add person, with the
// tag manager's same-name check: someone who already goes by the name is offered first, and Add anyway adds a second);
// anyone who came with accounts from his chats is never deleted, but hidden or joined instead. Tags are added and
// deleted here too (a deleted tag is taken from everyone who had it); the built-in ones never.

import {
  ARCHIVE_TAG, Effect, InvalidInputError, KEEP_TAG, NotFoundError, UnavailableError, undoneInLog,
  type Applied, type EditMeta, type EditOption, type EditRow, type EditValue, type FieldState, type OwnTableRows, type RowValues, type TableEditor,
} from "../../../sdk/server.ts";
import { FRIEND_MAP_ORIGIN } from "./calendarRows.ts";
import type { FriendMap } from "./friendMap.ts";
import { HIDDEN_RULES, HIDDEN_SHOWN, HIDDEN_YOU, PEOPLE, PERSON_ROW } from "./tabs/peopleTab.ts";
import { TAG_ROW, TAGS } from "./tabs/tagsTab.ts";

/** Why someone who came from his chats is never deleted. */
const IMPORTED_KEPT = "they came with accounts from your chats, so they are never deleted: hide them, or join them with someone, instead";
/** Why a built-in tag keeps its name and is never deleted. */
const BUILT_IN = "it is built in: it can be moved, but not renamed or deleted";

/** The most a field offers at once. */
const MOST_OPTIONS = 30;

/** `values`, those holding `query` (but for case) first by where, the order kept otherwise; at most MOST_OPTIONS. */
function matching(values: readonly string[], query: string): EditOption[] {
  const q = query.toLowerCase();
  const held = q === "" ? [...values] : values.filter((value) => value.toLowerCase().includes(q));
  if (q !== "") held.sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)));
  return held.slice(0, MOST_OPTIONS).map((value) => ({ value, label: value }));
}

/** The editors of friend map's People and Tags tables, over `friendMap`. */
export function peopleEditors(friendMap: FriendMap): TableEditor[] {
  const { db, people, changes } = friendMap;
  const { tags } = people;

  /** Runs `work` as one changeset of the change log, from where `meta` says; its number, or null when it changed nothing. */
  const recorded = (meta: EditMeta, action: string, work: () => unknown): number | null =>
    changes.record({ surface: meta.surface, action, description: meta.why ?? undefined }, work).changeset;

  /** Puts changeset `receipt.changeset` back, from where `meta` says; the undo's own changeset. */
  const undone = (receipt: Readonly<Record<string, unknown>>, meta: EditMeta): number | null => {
    if (typeof receipt.changeset !== "number") throw new InvalidInputError("that edit changed nothing, so there is nothing to put back");
    return changes.undo(receipt.changeset, { surface: meta.surface, description: meta.why ?? undefined }).changeset;
  };

  /** An editor over `state` and `write`, each edit one changeset (`action` names it), its undo the change log's, and whether one stands the change log's too. */
  const editor = (table: string, rows: OwnTableRows, state: TableEditor["state"], write: (row: EditRow, field: string, value: EditValue) => void,
    action: (field: string) => string, own: Pick<TableEditor, "add" | "remove" | "kept" | "undoRow">, options: TableEditor["options"]): TableEditor => {
    const valueOf = (row: EditRow, field: string): EditValue => state(row)?.[field]?.value ?? null;
    return {
      table,
      rows,
      state,
      ...own,
      options,
      undone: undoneInLog(changes, "Friend Map's Changes"),
      apply: (row, field, value, meta) =>
        Effect.sync((): Applied => {
          const before = valueOf(row, field);
          const changeset = recorded(meta, action(field), () => write(row, field, value));
          // A row the edit took away (a tag renamed onto another, so merged into it) became what it was given.
          return { before, after: state(row) === null ? value : valueOf(row, field), receipt: { changeset }, changed: changeset !== null };
        }),
      undo: (row, field, receipt, meta) =>
        Effect.sync((): Applied => {
          const before = valueOf(row, field);
          const changeset = undone(receipt, meta);
          return { before, after: valueOf(row, field), receipt: { changeset } };
        }),
    };
  };

  /** Puts back the add or delete whose receipt is `receipt`: the change log's undo of its changeset. */
  const undoRow: NonNullable<TableEditor["undoRow"]> = (_row, receipt, meta) => Effect.sync(() => ({ receipt: { changeset: undone(receipt, meta) } }));

  // --- people

  const personRow = (id: number): EditRow => ({ module: PEOPLE.spec.module ?? "friend-map", origin: FRIEND_MAP_ORIGIN, nativeId: String(id), kind: PERSON_ROW });
  /** Person `id`'s row, or null for nobody (or the captain, who is in no table). */
  const personAt = (id: number) =>
    db.prepare("SELECT id, name, aliases_json, note, location, should_reach_out FROM person WHERE id = ? AND is_self = 0").get(id) as
      { id: number; name: string; aliases_json: string; note: string; location: string | null; should_reach_out: number } | undefined;
  const personRows: OwnTableRows = {
    find: (id) => (personAt(Number(id)) ? personRow(Number(id)) : null),
    idOf: (row) => (row.kind === PERSON_ROW && personAt(Number(row.nativeId)) ? row.nativeId : null),
  };
  const accountsOf = (id: number) => (db.prepare("SELECT count(*) AS n FROM import_person WHERE person_id = ?").get(id) as { n: number }).n;

  const personState = (row: EditRow): Record<string, FieldState> | null => {
    if (row.kind !== PERSON_ROW) return null;
    const person = personAt(Number(row.nativeId));
    if (!person) return null;
    const theirs = tags.of(person.id);
    return {
      name: { value: person.name },
      aliases: { value: JSON.parse(person.aliases_json) as string[] },
      tags: { value: theirs },
      location: { value: person.location },
      hidden: { value: theirs.includes(ARCHIVE_TAG) ? HIDDEN_YOU : theirs.includes(KEEP_TAG) ? HIDDEN_SHOWN : HIDDEN_RULES },
      reach: { value: person.should_reach_out === 1 ? "yes" : "no" },
      note: { value: person.note === "" ? null : person.note },
    };
  };

  const personWrite = (row: EditRow, field: string, value: EditValue): void => {
    const id = Number(row.nativeId);
    switch (field) {
      case "name":
        return void people.setName(id, value);
      case "aliases":
        return void people.setAliases(id, value);
      case "tags":
        return void people.setTags(id, value);
      case "location":
        return void people.setLocation(id, value);
      case "hidden": {
        // The archive tag hides them; the keep tag shows them whatever the rules say; neither leaves it to the rules.
        const rest = tags.of(id).filter((tag) => tag !== ARCHIVE_TAG && tag !== KEEP_TAG);
        return void people.setTags(id, value === HIDDEN_YOU ? [...rest, ARCHIVE_TAG] : value === HIDDEN_SHOWN ? [...rest, KEEP_TAG] : rest);
      }
      case "reach":
        return void people.setShouldReachOut(id, value === "yes");
      case "note":
        return void people.setNote(id, value ?? "");
    }
    throw new InvalidInputError(`a person's ${JSON.stringify(field)} cannot be edited`);
  };

  /** The page's routes' names for each field's changeset (http.ts), so Friend Map's Changes says it as it said the panel's. */
  const personAction = (field: string): string =>
    ({ name: "person names", aliases: "person names", tags: "person tags", hidden: "person tags", location: "person location", reach: "person should-reach-out", note: "person note" })[field] ?? `person ${field}`;

  const personAdd: NonNullable<TableEditor["add"]> = (values, meta, { anyway } = { anyway: false }) =>
    Effect.gen(function* () {
      const same = people.sameNamed(values.name);
      if (same.length > 0 && !anyway) {
        const named = same.map((id) => `${personAt(id)?.name ?? `person ${id}`} (#${id})`).join(", ");
        return yield* new UnavailableError(`${same.length === 1 ? "someone already goes" : "people already go"} by this name: ${named}. Add anyway adds a second`);
      }
      const input: RowValues = values;
      const { value: id, changeset } = changes.record({ surface: meta.surface, action: "person new", description: meta.why ?? undefined }, () =>
        people.add({
          name: input.name,
          ...(input.location !== null && { location: input.location }),
          ...(Array.isArray(input.tags) && input.tags.length > 0 && { tags: input.tags }),
          ...(input.note !== null && { note: input.note }),
        }));
      return { row: personRow(id), receipt: { changeset } };
    });

  const personOptions = (field: string, query: string): EditOption[] => {
    if (field === "tags") return matching(tags.list().map((tag) => tag.name), query);
    if (field === "location") return matching(people.locations.list().map((location) => location.name), query);
    return [];
  };

  // --- tags

  const tagAt = (id: number) => db.prepare("SELECT id, name, sort_order, built_in FROM tag WHERE id = ?").get(id) as { id: number; name: string; sort_order: number; built_in: number } | undefined;
  const tagRow = (id: number): EditRow => ({ module: TAGS.spec.module ?? "friend-map", origin: FRIEND_MAP_ORIGIN, nativeId: String(id), kind: TAG_ROW });
  const tagRows: OwnTableRows = {
    find: (id) => (tagAt(Number(id)) ? tagRow(Number(id)) : null),
    idOf: (row) => (row.kind === TAG_ROW && tagAt(Number(row.nativeId)) ? row.nativeId : null),
  };
  /** A tag's place in the order, from 1, as the table numbers them (sort_order may skip after an undo). */
  const placeOf = (id: number) => (db.prepare("SELECT count(*) AS n FROM tag WHERE sort_order < (SELECT sort_order FROM tag WHERE id = ?)").get(id) as { n: number }).n + 1;

  const tagState = (row: EditRow): Record<string, FieldState> | null => {
    if (row.kind !== TAG_ROW) return null;
    const tag = tagAt(Number(row.nativeId));
    if (!tag) return null;
    return {
      name: tag.built_in === 1 ? { value: tag.name, locked: BUILT_IN } : { value: tag.name },
      order: { value: placeOf(tag.id) },
    };
  };

  const tagWrite = (row: EditRow, field: string, value: EditValue): void => {
    const tag = tagAt(Number(row.nativeId));
    if (!tag) throw new NotFoundError(`there is no tag #${row.nativeId}`);
    if (field === "name") return void tags.rename(tag.name, value);
    if (field === "order") {
      if (!Number.isInteger(value)) throw new InvalidInputError("a tag's place is a whole number, 1 for the first");
      return void tags.move(tag.name, Number(value) - 1);
    }
    throw new InvalidInputError(`a tag's ${JSON.stringify(field)} cannot be edited`);
  };

  const tagAdd: NonNullable<TableEditor["add"]> = (values, meta) =>
    Effect.sync(() => {
      const { value: name, changeset } = changes.record({ surface: meta.surface, action: "tag add", description: meta.why ?? undefined }, () => tags.create(values.name));
      const id = (db.prepare("SELECT id FROM tag WHERE name = ?").get(name) as { id: number }).id;
      return { row: tagRow(id), receipt: { changeset } };
    });

  return [
    editor(PEOPLE.spec.kind, personRows, personState, personWrite, personAction, {
      add: personAdd,
      remove: (row, meta) =>
        Effect.sync(() => {
          const id = Number(row.nativeId);
          if (accountsOf(id) > 0) throw new InvalidInputError(IMPORTED_KEPT);
          return { receipt: { changeset: recorded(meta, "person delete", () => people.delete(id)) } };
        }),
      kept: (row) => (accountsOf(Number(row.nativeId)) > 0 ? IMPORTED_KEPT : null),
      undoRow,
    }, personOptions),
    editor(TAGS.spec.kind, tagRows, tagState, tagWrite, (field) => (field === "order" ? "tag move" : "tag rename"), {
      add: tagAdd,
      remove: (row, meta) =>
        Effect.sync(() => {
          const tag = tagAt(Number(row.nativeId));
          if (!tag) throw new NotFoundError(`there is no tag #${row.nativeId}`);
          if (tag.built_in === 1) throw new InvalidInputError(BUILT_IN);
          return { receipt: { changeset: recorded(meta, "tag delete", () => tags.delete(tag.name)) } };
        }),
      kept: (row) => (tagAt(Number(row.nativeId))?.built_in === 1 ? BUILT_IN : null),
      undoRow,
    }, () => []),
  ];
}
