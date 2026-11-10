// Friend map's tables edited in Events' Tables (tableEdits.ts, through the core's server/edits/), on made-up people
// only: the locks a page of the grid is given, so a cell is edited in place only where its row lets it (a call he
// logged whole; an imported one's time and people never, its length only where its app gave none); a cell's edit, which
// is the drawer's (one route, one record, one undo); the one record, whose standing is friend map's change log's, so an
// edit undone from Friend Map's Changes is undone in the tables' record too, and its undo there undone again stands
// again; and Edits, every table's record newest first, paged, each undone from it.

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answering, EDITS_API, Effect, ForbiddenError, InvalidInputError, NotFoundError, transaction, UnavailableError,
  type ArchiveEvent, type EditDone, type EditsAnswer, type LocksAnswer,
} from "../../../sdk/server.ts";
import { editsHandler, type TableEdits } from "../../../sdk/testing.ts";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { ManualCalls } from "./manualCalls.ts";
import { applyChats } from "./write.ts";

const AT = Date.parse("2026-03-06T08:00:00Z");
const SOURCE = { surface: "app", who: null, why: null } as const;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(answering(ForbiddenError, InvalidInputError, NotFoundError, UnavailableError), Effect.flip)) as Promise<Error>;

let dir: string;
let archive: TestArchive;
let edits: TableEdits;
/** The rows, by their ids in their tables: a hangout, a call he logged, an imported call with no length and one whose app gave its length, and a message. */
const rows: Record<"hangout" | "logged" | "imported" | "lengthless" | "message", string> = { hangout: "", logged: "", imported: "", lengthless: "", message: "" };

/** One import of `events` on `platform`, pushed as the host pushes it. */
function imported(platform: string, events: ArchiveEvent[]): void {
  const source = Number(archive.db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'made-up', 'export', 'made up', 0, 'ok')").run(platform).lastInsertRowid);
  const applied = transaction(archive.db, () => applyChats(events, archive.db, { id: source, platform, kind: "export", seenAt: 0, folder: dir }, (touched) => archive.push.afterChats(touched)));
  applied.afterCommit?.();
}

const idOf = (kind: string, like: string) => String((archive.calendarDb.prepare("SELECT id FROM event WHERE kind = ? AND native_id LIKE ? ORDER BY id LIMIT 1").get(kind, like) as { id: number }).id);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "life-archive-friend-map-table-edits-"));
  archive = await openTestArchive(join(dir, "data"));
  edits = archive.life.edits();
  const account = (key: string): ArchiveEvent => ({ kind: "account", key, keyKind: "name", displayName: key });
  imported("whatsapp", [
    account("Ada Sample"),
    account("Bruno Example"),
    { kind: "conversation", id: "chat", type: "direct", members: ["Ada Sample"] },
    // A call record whose app says how long it was, and one in no chat whose length nobody gave.
    { kind: "message", id: "M1", idKind: "platform", conversation: "chat", sender: "Ada Sample", isFromSelf: false, sentAt: AT, type: "call", callSeconds: 120, raw: {} },
    { kind: "message", id: "M2", idKind: "platform", conversation: "chat", sender: "Ada Sample", isFromSelf: false, sentAt: AT + 60_000, type: "text", text: "made-up words", raw: {} },
    { kind: "call", id: "W9", with: "Bruno Example", at: AT + 3_600_000, direction: "outgoing", answered: true, service: "video", raw: {} },
  ]);
  archive.runRules();
  const cleo = archive.people.create("Cleo Demo");
  archive.changes.record({ surface: "app", action: "hangout" }, () => archive.people.addCatchUp({ day: "2026-03-07", time: "18:30", hours: 2, personIds: [cleo] }));
  archive.changes.record({ surface: "app", action: "log a call" }, () =>
    new ManualCalls(archive.db).insert({ people: [{ personId: cleo, accountId: null, app: "discord" }], day: "2026-04-05", time: "20:00", minutes: 30, note: "" }));
  rows.hangout = idOf("hangout", "%");
  rows.logged = idOf("call", "logged:%");
  rows.imported = idOf("call", "record:%");
  rows.lengthless = idOf("call", "call:%");
  rows.message = "1";
});

afterAll(async () => {
  archive.close();
  await rm(dir, { recursive: true, force: true });
});

describe("a page of the grid's locks", () => {
  it("lets a call he logged be edited whole but its answer, and an imported one's time and people never, its length only where its app gave none", () => {
    const locks = edits.locks("calls", [rows.logged, rows.imported, rows.lengthless]);
    expect(locks[rows.logged]).toEqual({ answered: "a call you logged was answered, so it keeps that" });
    expect(Object.keys(locks[rows.imported]!).sort()).toEqual(["length", "when", "with"]);
    expect(locks[rows.imported]!.length).toContain("its app says");
    expect(Object.keys(locks[rows.lengthless]!).sort()).toEqual(["length", "when", "with"]);
    // What the locks say is what the drawer's state says, row by row.
    for (const id of [rows.logged, rows.imported, rows.lengthless]) {
      const state = edits.state("calls", id).fields;
      const locked = Object.fromEntries(Object.entries(state).flatMap(([key, field]) => (field.locked ? [[key, field.locked]] : [])));
      expect(locks[id]).toEqual(locked);
    }
  });

  it("says a hangout's from its state, leaves out a row that is not the table's, and refuses a table only read", async () => {
    expect(edits.locks("hangouts", [rows.hangout, rows.logged, "999999"])).toEqual({ [rows.hangout]: {} });
    expect(() => edits.locks("messages", [rows.message])).toThrow(ForbiddenError);
    expect(() => edits.locks("calls", ["a call"])).toThrow(InvalidInputError);
    expect(() => edits.locks("calls", Array.from({ length: 201 }, (_, i) => String(i + 1)))).toThrow(InvalidInputError);
  });
});

describe("the one record", () => {
  it("reads an edit's standing from friend map's change log: undone from its Changes, undone here; that undo undone, standing again", async () => {
    const made = await run(edits.edit("calls", rows.logged, "length", 45, SOURCE));
    const changeset = archive.changes.list({ limit: 1 })[0]!.id;
    expect(edits.record(made.edit!)).toMatchObject({ undone: null, undoneBy: null });

    // Undone from Friend Map's Changes, not from the tables.
    const undo = archive.changes.undo(changeset, { surface: "app" });
    expect(edits.record(made.edit!)).toMatchObject({ undone: `in Friend Map's Changes (its #${undo.changeset})`, undoneBy: null });
    expect(edits.state("calls", rows.logged).fields.length).toMatchObject({ value: 30 });
    const refused = await refusal(edits.undo(made.edit!, SOURCE));
    expect(refused).toBeInstanceOf(UnavailableError);
    expect(refused.message).toContain("Friend Map's Changes");

    // Its undo undone there too: the edit stands again, and the tables' Undo puts it back, as an undo of the record's own.
    archive.changes.undo(undo.changeset!, { surface: "app" });
    expect(edits.record(made.edit!)).toMatchObject({ undone: null });
    expect(edits.state("calls", rows.logged).fields.length).toMatchObject({ value: 45 });
    const ours = await run(edits.undo(made.edit!, SOURCE));
    expect(edits.record(made.edit!)).toMatchObject({ undone: `by #${ours.edit}`, undoneBy: ours.edit });
    expect(edits.state("calls", rows.logged).fields.length).toMatchObject({ value: 30 });
    // The change log says the same of it: undone, by the changeset the record's undo made.
    const receipt = archive.coreDb.prepare("SELECT receipt FROM table_edit WHERE id = ?").get(ours.edit!) as { receipt: string };
    expect(archive.changes.standing(changeset)).toEqual({ undoneBy: (JSON.parse(receipt.receipt) as { changeset: number }).changeset });
  });

  it("falls back on its own record once the change log no longer has the changeset", async () => {
    const made = await run(edits.edit("hangouts", rows.hangout, "hours", 3, SOURCE));
    const ours = await run(edits.undo(made.edit!, SOURCE));
    archive.db.exec("DELETE FROM changeset");
    expect(edits.record(made.edit!)).toMatchObject({ undone: `by #${ours.edit}`, undoneBy: ours.edit });
    expect(edits.record(ours.edit!)).toMatchObject({ undone: null });
  });
});

describe("in a cell, and from Edits, over the route", () => {
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
  const record = async (query: string) => ((await (await fetch(`${base}?${query}`)).json()) as EditsAnswer).edits;

  it("answers a page's locks in one ask, and refuses a table only read", async () => {
    const answer = (await (await fetch(`${base}/locks?kind=calls&ids=${rows.logged},${rows.imported}`)).json()) as LocksAnswer;
    expect(Object.keys(answer.rows).sort()).toEqual([rows.logged, rows.imported].sort());
    expect(Object.keys(answer.rows[rows.logged]!)).toEqual(["answered"]);
    expect((await fetch(`${base}/locks?kind=messages&ids=${rows.message}`)).status).toBe(403);
    expect((await fetch(`${base}/locks?kind=calls&ids=x`)).status).toBe(400);
  });

  it("edits a cell as the drawer does, and undoes it from Edits, newest first across the tables, paged", async () => {
    // What a cell saves is the drawer's edit: one route, one record.
    const cell = (await (await post("", { kind: "hangouts", id: rows.hangout, field: "when", value: "2026-03-07T20:00" })).json()) as EditDone;
    expect(cell.state?.fields.when).toMatchObject({ value: "2026-03-07T20:00" });
    const call = (await (await post("", { kind: "calls", id: rows.logged, field: "length", value: 50 })).json()) as EditDone;

    const every = await record("limit=2");
    expect(every.map((edit) => [edit.id, edit.kind, edit.label, edit.after])).toEqual([[call.edit, "calls", "Length", "50 min"], [cell.edit, "hangouts", "When", expect.stringContaining("2026")]]);
    expect(every.map((edit) => edit.rowId)).toEqual([call.id, cell.id]);
    expect((await record(`limit=1&before=${call.edit}`)).map((edit) => edit.id)).toEqual([cell.edit]);
    expect((await record("kind=hangouts&limit=1")).map((edit) => edit.id)).toEqual([cell.edit]);

    // Edits' Undo, of the older of the two: the record says it is undone, and by which.
    const undone = (await (await post(`/${cell.edit}/undo`, {})).json()) as EditDone;
    expect(undone.state?.fields.when).toMatchObject({ value: "2026-03-07T18:30" });
    const after = await record("limit=3");
    expect(after[0]).toMatchObject({ id: undone.edit, undoes: cell.edit, undone: null });
    expect(after.find((edit) => edit.id === cell.edit)).toMatchObject({ undone: `by #${undone.edit}`, undoneBy: undone.edit });
    expect((await post(`/${cell.edit}/undo`, {})).status).toBe(409);
    expect((await fetch(`${base}?limit=1&before=x`)).status).toBe(400);
  });
});
