// Friend map's People and Tags tables edited in Events' Tables (peopleEdits.ts, through the core's server/edits/), on
// made-up people only: rows found by friend map, not the calendar; a person's name, other names, tags, location,
// hidden, reach out and note, each one changeset named as the person panel's routes name it, kept in the record and
// undone, also from Friend Map's Changes; Add person with the same-name check and Add anyway; Delete for people added by
// hand only; the Tags table's add, rename (a merge onto a tag that exists), move and delete, the built-in tags only
// moving; what the text and tags fields offer; the People table's Closeness and its new columns; and the route.

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answering, EDITS_API, Effect, ForbiddenError, InvalidInputError, NotFoundError, transaction, UnavailableError,
  type ArchiveEvent, type EditDone, type OptionsAnswer,
} from "../../../sdk/server.ts";
import { editsHandler, NO_FILTERS, type TableEdits } from "../../../sdk/testing.ts";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { PEOPLE } from "./tabs/peopleTab.ts";
import { TAGS } from "./tabs/tagsTab.ts";
import { applyChats } from "./write.ts";

const AT = Date.parse("2026-03-06T08:00:00Z");
const SOURCE = { surface: "app", who: null, why: null } as const;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(answering(ForbiddenError, InvalidInputError, NotFoundError, UnavailableError), Effect.flip)) as Promise<Error>;
const PAGE = { offset: 0, limit: 100, sort: "name", direction: "asc", after: null } as const;

let dir: string;
let archive: TestArchive;
let edits: TableEdits;
/** Imported, with a WhatsApp account and messages. */
let ada: number;
/** Added by hand. */
let ivy: number;

function imported(platform: string, events: ArchiveEvent[]): void {
  const source = Number(archive.db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'made-up', 'export', 'made up', 0, 'ok')").run(platform).lastInsertRowid);
  const applied = transaction(archive.db, () => applyChats(events, archive.db, { id: source, platform, kind: "export", seenAt: 0, folder: dir }, (touched) => archive.push.afterChats(touched)));
  applied.afterCommit?.();
}

/** The People table's row of person `id`, as Events' Tables reads it. */
const peopleRow = (id: number) => PEOPLE.rows(archive.reads(), NO_FILTERS, PAGE).rows.find((row) => row.id === String(id));
const tagId = (name: string) => String((archive.db.prepare("SELECT id FROM tag WHERE name = ?").get(name) as { id: number }).id);
const lastChange = () => archive.changes.list({ limit: 1 })[0];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "life-archive-friend-map-people-edits-"));
  archive = await openTestArchive(join(dir, "data"));
  edits = archive.life.edits();
  // A chat both ways, so she has a closeness score (one-sided chats score nothing).
  imported("whatsapp", [
    { kind: "account", key: "Me", keyKind: "name", displayName: "Me", isSelf: true },
    { kind: "account", key: "Ada Sample", keyKind: "name", displayName: "Ada Sample" },
    { kind: "conversation", id: "chat", type: "direct", members: ["Me", "Ada Sample"] },
    { kind: "message", id: "M1", idKind: "platform", conversation: "chat", sender: "Ada Sample", isFromSelf: false, sentAt: AT, type: "text", text: "made-up words", raw: {} },
    { kind: "message", id: "M2", idKind: "platform", conversation: "chat", sender: "Me", isFromSelf: true, sentAt: AT + 60_000, type: "text", text: "made-up words", raw: {} },
  ]);
  archive.runRules();
  ada = (archive.db.prepare("SELECT id FROM person WHERE name = 'Ada Sample'").get() as { id: number }).id;
  ivy = archive.people.create("Ivy Hand");
});

afterAll(async () => {
  archive.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the People table's fields, on rows that are not in the calendar", () => {
  it("finds a person by their own id, and says the fields as they stand", () => {
    const state = edits.state("people", String(ada));
    expect(state.fields).toMatchObject({ name: { value: "Ada Sample" }, aliases: { value: [] }, tags: { value: [] }, location: { value: null }, hidden: { value: "rules" }, reach: { value: "no" }, note: { value: null } });
    // Someone from his chats is never deleted; someone he added is.
    expect(state.delete).toEqual({ locked: expect.stringContaining("never deleted") });
    expect(edits.state("people", String(ivy)).delete).toEqual({});
    expect(() => edits.state("people", "999999")).toThrow(NotFoundError);
    // A page of the grid's rows, in one ask: nothing of a person is kept as it is.
    expect(edits.locks("people", [String(ada), String(ivy), "999999"])).toEqual({ [ada]: {}, [ivy]: {} });
  });

  it("renames someone, keeps it in the record as the panel's changeset, and undoes it", async () => {
    const done = await run(edits.edit("people", String(ivy), "name", "Ivy Renamed", SOURCE));
    expect(done.state?.fields.name).toEqual({ value: "Ivy Renamed" });
    expect(edits.record(done.edit!)).toMatchObject({ kind: "people", label: "Name", before: "Ivy Hand", after: "Ivy Renamed", rowId: String(ivy) });
    expect(lastChange()).toMatchObject({ action: "person names" });
    expect(peopleRow(ivy)?.cells.name).toBe("Ivy Renamed");
    await run(edits.undo(done.edit!, SOURCE));
    expect(edits.state("people", String(ivy)).fields.name).toEqual({ value: "Ivy Hand" });
    // A name is never left empty.
    expect(await refusal(edits.edit("people", String(ivy), "name", "  ", SOURCE))).toBeInstanceOf(InvalidInputError);
  });

  it("sets other names and tags as lists, a new tag made as it is given", async () => {
    const aliases = await run(edits.edit("people", String(ada), "aliases", ["Addy", " Addy ", ""], SOURCE));
    expect(aliases.state?.fields.aliases).toEqual({ value: ["Addy"] });
    expect(edits.record(aliases.edit!)).toMatchObject({ label: "Also called", before: "none", after: "Addy" });

    const tags = await run(edits.edit("people", String(ada), "tags", ["climbing"], SOURCE));
    expect(tags.state?.fields.tags).toEqual({ value: ["climbing"] });
    expect(lastChange()).toMatchObject({ action: "person tags" });
    expect(archive.people.tags.list().map((tag) => tag.name)).toContain("climbing");
    expect(peopleRow(ada)?.cells.tags).toBe("climbing");
  });

  it("hides someone with the archive tag, shows them whatever the rules say with keep, and leaves it to the rules with neither", async () => {
    const hidden = await run(edits.edit("people", String(ada), "hidden", "hidden", SOURCE));
    expect(hidden.state?.fields).toMatchObject({ hidden: { value: "hidden" }, tags: { value: expect.arrayContaining(["climbing", "archive"]) } });
    expect(peopleRow(ada)?.cells.hidden).toBe("By you");
    const shown = await run(edits.edit("people", String(ada), "hidden", "shown", SOURCE));
    expect(shown.state?.fields.tags?.value).toEqual(expect.arrayContaining(["climbing", "keep"]));
    expect(shown.state?.fields.tags?.value).not.toContain("archive");
    const rules = await run(edits.edit("people", String(ada), "hidden", "rules", SOURCE));
    expect(rules.state?.fields.tags).toEqual({ value: ["climbing"] });
    expect(edits.record(rules.edit!)).toMatchObject({ label: "Hidden", after: "As the archive rules say" });
    expect(await refusal(edits.edit("people", String(ada), "hidden", "maybe", SOURCE))).toBeInstanceOf(InvalidInputError);
  });

  it("sets where they are, whether to reach out, and his note for them (no content: in the table and the record)", async () => {
    await run(edits.edit("people", String(ada), "location", "Melbourne", SOURCE));
    expect(lastChange()).toMatchObject({ action: "person location" });
    const reach = await run(edits.edit("people", String(ada), "reach", "yes", SOURCE));
    expect(reach.state?.fields.reach).toEqual({ value: "yes" });
    expect(lastChange()).toMatchObject({ action: "person should-reach-out" });
    const note = await run(edits.edit("people", String(ada), "note", "Met at the made-up climbing gym", SOURCE));
    expect(note.state?.fields.note).toEqual({ value: "Met at the made-up climbing gym" });
    expect(edits.record(note.edit!)).toMatchObject({ label: "Note", after: "Met at the made-up climbing gym" });
    expect(peopleRow(ada)?.cells).toMatchObject({ location: "Melbourne", note: "Met at the made-up climbing gym" });
    const cleared = await run(edits.edit("people", String(ada), "location", "", SOURCE));
    expect(cleared.state?.fields.location).toEqual({ value: null });
    await run(edits.undo(cleared.edit!, SOURCE));
  });

  it("offers the tags and the locations in use as they are typed, and nothing for a field that offers none", () => {
    expect(edits.options("people", "tags", "clim")).toEqual([{ value: "climbing", label: "climbing" }]);
    expect(edits.options("people", "tags", "").map((option) => option.value)).toEqual(expect.arrayContaining(["archive", "keep", "climbing"]));
    expect(edits.options("people", "location", "mel")).toEqual([{ value: "Melbourne", label: "Melbourne" }]);
    expect(() => edits.options("people", "aliases", "a")).toThrow(InvalidInputError);
    expect(() => edits.options("people", "name", "a")).toThrow(InvalidInputError);
  });

  it("follows an edit undone from Friend Map's Changes, and refuses its Undo saying where", async () => {
    const done = await run(edits.edit("people", String(ivy), "location", "Toowoomba", SOURCE));
    const undo = archive.changes.undo(lastChange()!.id, { surface: "app" });
    expect(edits.record(done.edit!)).toMatchObject({ undone: `in Friend Map's Changes (its #${undo.changeset})` });
    expect((await refusal(edits.undo(done.edit!, SOURCE))).message).toContain("Friend Map's Changes");
  });
});

describe("Add person and Delete, for people he added by hand", () => {
  it("adds someone with a location, tags and a note, as Add person did, undone and done again", async () => {
    const done = await run(edits.add("people", { name: "Dora Near", location: "Toowoomba", tags: ["climbing"], note: "Made-up neighbour" }, SOURCE));
    expect(done.state?.fields).toMatchObject({ name: { value: "Dora Near" }, location: { value: "Toowoomba" }, tags: { value: ["climbing"] }, note: { value: "Made-up neighbour" } });
    expect(done.state?.delete).toEqual({});
    expect(lastChange()).toMatchObject({ action: "person new" });
    expect(edits.record(done.edit!)).toMatchObject({ action: "add", label: "person", before: null, after: "Dora Near · Toowoomba · climbing · Made-up neighbour" });
    // Edited by hand, so the rules never archive them for having no messages.
    expect(peopleRow(Number(done.id))?.cells.hidden).toBeNull();

    const undo = await run(edits.undo(done.edit!, SOURCE));
    expect(undo.gone).toBe(true);
    expect(() => edits.state("people", done.id)).toThrow(NotFoundError);
    const again = await run(edits.undo(undo.edit!, SOURCE));
    expect(edits.state("people", again.id).fields.name).toEqual({ value: "Dora Near" });
  });

  it("asks him to be sure before adding someone of a name someone goes by (409), and adds a second anyway", async () => {
    const refused = await refusal(edits.add("people", { name: "ada sample" }, SOURCE));
    expect(refused).toBeInstanceOf(UnavailableError);
    expect(refused.message).toContain(`Ada Sample (#${ada})`);
    const anyway = await run(edits.add("people", { name: "Ada Sample" }, SOURCE, { anyway: true }));
    expect(anyway.id).not.toBe(String(ada));
    await run(edits.remove("people", anyway.id, SOURCE));
  });

  it("deletes someone he added, with their tags, undone with them back; never someone from his chats", async () => {
    await run(edits.edit("people", String(ivy), "tags", ["climbing"], SOURCE));
    const deleted = await run(edits.remove("people", String(ivy), SOURCE));
    expect(deleted).toMatchObject({ gone: true, state: null });
    expect(edits.record(deleted.edit!)).toMatchObject({ action: "delete", label: "person", rowId: null });
    expect(lastChange()).toMatchObject({ action: "person delete" });
    await run(edits.undo(deleted.edit!, SOURCE));
    expect(edits.state("people", String(ivy)).fields).toMatchObject({ name: { value: "Ivy Hand" }, tags: { value: ["climbing"] } });

    const kept = await refusal(edits.remove("people", String(ada), SOURCE));
    expect(kept).toBeInstanceOf(ForbiddenError);
    expect(kept.message).toContain("never deleted");
    expect(edits.state("people", String(ada))).toBeTruthy();
  });
});

describe("the Tags table", () => {
  it("adds a tag nobody has, renames it, moves it, and deletes it, each undone", async () => {
    const added = await run(edits.add("tags", { name: "Uni Friends" }, SOURCE));
    expect(added.state?.fields.name).toEqual({ value: "uni-friends" });
    expect(lastChange()).toMatchObject({ action: "tag add" });
    const id = added.id;

    const renamed = await run(edits.edit("tags", id, "name", "uni", SOURCE));
    expect(renamed.state?.fields.name).toEqual({ value: "uni" });
    expect(edits.record(renamed.edit!)).toMatchObject({ kind: "tags", label: "Tag", before: "uni-friends", after: "uni" });
    expect(lastChange()).toMatchObject({ action: "tag rename" });

    const moved = await run(edits.edit("tags", id, "order", 1, SOURCE));
    expect(moved.state?.fields.order).toEqual({ value: 1 });
    expect(TAGS.rows(archive.reads(), NO_FILTERS, { offset: 0, limit: 10, sort: "order", direction: "asc", after: null }).rows[0]).toMatchObject({ id, cells: { order: 1, name: "uni" } });
    expect(lastChange()).toMatchObject({ action: "tag move" });
    expect(await refusal(edits.edit("tags", id, "order", 1.5, SOURCE))).toBeInstanceOf(InvalidInputError);

    const deleted = await run(edits.remove("tags", id, SOURCE));
    expect(deleted.gone).toBe(true);
    expect(lastChange()).toMatchObject({ action: "tag delete" });
    await run(edits.undo(deleted.edit!, SOURCE));
    expect(edits.state("tags", id).fields.name).toEqual({ value: "uni" });
  });

  it("merges a tag renamed onto one that exists, everyone with it keeping the one, and Undo parts them again", async () => {
    await run(edits.add("tags", { name: "bouldering" }, SOURCE));
    await run(edits.edit("people", String(ivy), "tags", ["climbing", "bouldering"], SOURCE));
    const merged = await run(edits.edit("tags", tagId("bouldering"), "name", "climbing", SOURCE));
    expect(merged.gone).toBe(true);
    expect(edits.record(merged.edit!)).toMatchObject({ before: "bouldering", after: "climbing" });
    expect(edits.state("people", String(ivy)).fields.tags).toEqual({ value: ["climbing"] });
    await run(edits.undo(merged.edit!, SOURCE));
    expect(edits.state("people", String(ivy)).fields.tags?.value).toEqual(expect.arrayContaining(["climbing", "bouldering"]));
  });

  it("moves a built-in tag but never renames or deletes it", async () => {
    const archived = tagId("archive");
    expect(edits.state("tags", archived)).toMatchObject({ fields: { name: { value: "archive", locked: expect.stringContaining("built in") } }, delete: { locked: expect.stringContaining("built in") } });
    expect(edits.locks("tags", [archived])).toEqual({ [archived]: { name: expect.stringContaining("built in") } });
    expect(await refusal(edits.edit("tags", archived, "name", "hidden", SOURCE))).toBeInstanceOf(ForbiddenError);
    expect(await refusal(edits.remove("tags", archived, SOURCE))).toBeInstanceOf(ForbiddenError);
    const moved = await run(edits.edit("tags", archived, "order", 3, SOURCE));
    expect(moved.state?.fields.order).toEqual({ value: 3 });
  });

  it("lists every tag with how many people have it, and opens People narrowed to it", () => {
    const climbing = TAGS.rows(archive.reads(), { ...NO_FILTERS, search: "climb" }, { offset: 0, limit: 10, sort: "order", direction: "asc", after: null });
    expect(climbing.rows).toEqual([expect.objectContaining({ cells: expect.objectContaining({ name: "climbing", people: 3, builtIn: null }) })]);
    expect(TAGS.detail(archive.reads(), climbing.rows[0]!.id).views).toEqual([{ label: "People with it", kind: "people", filters: { ...NO_FILTERS, choices: { tag: ["climbing"] } } }]);
  });
});

describe("the People table's columns", () => {
  it("has friend-map's closeness and its rank, the one-to-one messages, when someone was added, and a link to their panel", () => {
    const row = peopleRow(ada)!;
    expect(row.cells.closeness).toMatch(/^\S+ {2}#1$/);
    expect(row.cells).toMatchObject({ messages: 2, direct: 2, added: expect.any(Number) });
    // Nobody he only added by hand has a score, so none is ranked.
    expect(peopleRow(ivy)?.cells.closeness).toBeNull();
    const byCloseness = PEOPLE.rows(archive.reads(), NO_FILTERS, { ...PAGE, sort: "closeness", direction: "desc" }).rows;
    expect(byCloseness[0]?.id).toBe(String(ada));
    expect(PEOPLE.detail(archive.reads(), String(ada)).places).toEqual([{ label: "Their panel in Friend Map", place: "friend-map", query: { person: String(ada) } }]);
  });
});

describe("over the route", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => void editsHandler(edits)(req, res));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${EDITS_API}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("offers a tags field's values, and adds anyway only when asked", async () => {
    const offered = (await (await fetch(`${base}/options?kind=people&field=tags&q=clim`)).json()) as OptionsAnswer;
    expect(offered.options).toEqual([{ value: "climbing", label: "climbing" }]);
    expect((await post("/add", { kind: "people", values: { name: "Ivy Hand" } })).status).toBe(409);
    const anyway = await post("/add", { kind: "people", values: { name: "Ivy Hand" }, anyway: true });
    expect(anyway.status).toBe(200);
    expect((await post("/delete", { kind: "people", id: ((await anyway.json()) as EditDone).id })).status).toBe(200);
    expect((await post("/delete", { kind: "people", id: String(ada) })).status).toBe(403);
  });
});
