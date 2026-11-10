// Friend map's own rows added and deleted in Events' Tables (tableEdits.ts's `own`, through the core's server/edits/),
// on made-up people only: a hangout and a logged call added from Add's fields, each one changeset of friend map's change
// log and one add in the tables' record, undone and done again; a call added on each person's usual account or on the
// app said, refused for someone with no account there; a hangout or a logged call deleted, never an imported call; a
// delete undone from the record or from Friend Map's Changes, which the record then says; and the route's two paths.

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answering, EDITS_API, Effect, ForbiddenError, InvalidInputError, NotFoundError, transaction, UnavailableError,
  type ArchiveEvent, type EditDone,
} from "../../../sdk/server.ts";
import { editsHandler, type TableEdits } from "../../../sdk/testing.ts";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { applyChats } from "./write.ts";

const AT = Date.parse("2026-03-06T08:00:00Z");
const SOURCE = { surface: "app", who: null, why: null } as const;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(answering(ForbiddenError, InvalidInputError, NotFoundError, UnavailableError), Effect.flip)) as Promise<Error>;

let dir: string;
let archive: TestArchive;
let edits: TableEdits;
let ada: number;
let cleo: number;
/** An imported call's row in the Calls table. */
let importedCall: string;

function imported(platform: string, events: ArchiveEvent[]): void {
  const source = Number(archive.db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'made-up', 'export', 'made up', 0, 'ok')").run(platform).lastInsertRowid);
  const applied = transaction(archive.db, () => applyChats(events, archive.db, { id: source, platform, kind: "export", seenAt: 0, folder: dir }, (touched) => archive.push.afterChats(touched)));
  applied.afterCommit?.();
}

/** The friend map rows a calendar row is, by its id in its table. */
const keyOf = (id: string) => archive.calendarDb.prepare("SELECT origin, native_id FROM event WHERE id = ?").get(Number(id)) as { origin: string; native_id: string } | undefined;
/** Everyone on logged call `group`, each with the account it is on (null for none) and the app (for one on none). */
const onCall = (group: number) =>
  archive.db.prepare("SELECT coalesce(a.person_id, mc.person_id) AS person, mc.account_id, a.platform, mc.app FROM manual_call mc LEFT JOIN import_person a ON a.id = mc.account_id WHERE mc.call_group = ? ORDER BY mc.id").all(group);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "life-archive-friend-map-table-rows-"));
  archive = await openTestArchive(join(dir, "data"));
  edits = archive.life.edits();
  imported("whatsapp", [
    { kind: "account", key: "Ada Sample", keyKind: "name", displayName: "Ada Sample" },
    { kind: "conversation", id: "chat", type: "direct", members: ["Ada Sample"] },
    { kind: "message", id: "M1", idKind: "platform", conversation: "chat", sender: "Ada Sample", isFromSelf: false, sentAt: AT, type: "call", callSeconds: 120, raw: {} },
  ]);
  archive.runRules();
  ada = (archive.db.prepare("SELECT id FROM person WHERE name = 'Ada Sample'").get() as { id: number }).id;
  cleo = archive.people.create("Cleo Demo");
  importedCall = String((archive.calendarDb.prepare("SELECT id FROM event WHERE kind = 'call' AND native_id LIKE 'record:%'").get() as { id: number }).id);
});

afterAll(async () => {
  archive.close();
  await rm(dir, { recursive: true, force: true });
});

describe("Add, in the Hangouts and Calls tables", () => {
  it("adds a hangout from Add's fields, one changeset and one add in the record, undone and done again", async () => {
    const done = await run(edits.add("hangouts", { when: "2026-03-08", hours: 1.5, with: [ada, cleo], note: "made-up words" }, SOURCE));
    expect(done.edit).not.toBeNull();
    expect(done.state?.fields).toMatchObject({ when: { value: "2026-03-08" }, hours: { value: 1.5 }, with: { value: [ada, cleo] }, note: { has: true } });
    expect(done.state?.delete).toEqual({});
    expect(keyOf(done.id)).toMatchObject({ origin: "friend-map" });
    expect(archive.changes.list({ limit: 1 })[0]).toMatchObject({ action: "catch-up add" });

    const record = edits.record(done.edit!);
    expect(record).toMatchObject({ action: "add", label: "hangout", before: null, rowId: done.id, field: "" });
    expect(record.after).toContain("Ada Sample, Cleo Demo");
    expect(record.after).toContain("1.5 h");
    // The note's words are never in the record.
    expect(JSON.stringify(archive.coreDb.prepare("SELECT * FROM table_edit WHERE id = ?").get(done.edit!))).not.toContain("made-up words");

    // Undone: the hangout goes, and the record says by which; that undone, it is back where it was.
    const undo = await run(edits.undo(done.edit!, SOURCE));
    expect(undo).toMatchObject({ gone: true, state: null });
    expect(() => edits.state("hangouts", done.id)).toThrow(NotFoundError);
    expect(edits.record(done.edit!)).toMatchObject({ undoneBy: undo.edit, rowId: null });
    expect(edits.record(undo.edit!)).toMatchObject({ action: "add", undoes: done.edit });
    const again = await run(edits.undo(undo.edit!, SOURCE));
    expect(again.gone).toBe(false);
    expect(edits.state("hangouts", again.id).fields.hours).toMatchObject({ value: 1.5 });
  });

  it("refuses an add with a field left empty or not Add's, one its owner's rules do not take, and a table whose rows all come from imports", async () => {
    expect((await refusal(edits.add("hangouts", { when: "2026-03-08", hours: 2, with: [] }, SOURCE))).message).toContain("With");
    expect((await refusal(edits.add("hangouts", { when: "2026-03-08", with: [cleo] }, SOURCE))).message).toContain("Hours cannot be left empty");
    expect(await refusal(edits.add("hangouts", { when: "2026-03-08", hours: 2, with: [cleo], app: "phone" }, SOURCE))).toBeInstanceOf(InvalidInputError);
    expect(await refusal(edits.add("hangouts", [], SOURCE))).toBeInstanceOf(InvalidInputError);
    // A hangout is one that has happened.
    expect((await refusal(edits.add("hangouts", { when: "2999-01-01", hours: 2, with: [cleo] }, SOURCE))).message).toContain("after today");
    // A call needs its time of day, which a hangout may leave out.
    expect(await refusal(edits.add("calls", { when: "2026-03-08", length: 10, with: [cleo], app: "usual" }, SOURCE))).toBeInstanceOf(InvalidInputError);
    expect(await refusal(edits.add("messages", {}, SOURCE))).toBeInstanceOf(ForbiddenError);
  });

  it("adds a call on each person's usual account, or on the app said, and refuses an app someone has no account on", async () => {
    // Ada's usual is her one account that carries calls (WhatsApp); Cleo has none, so hers is on the phone, on no account.
    const usual = await run(edits.add("calls", { when: "2026-03-09T19:00", length: 25, with: [ada, cleo], app: "usual" }, SOURCE));
    const group = Number(keyOf(usual.id)!.native_id.replace("logged:", ""));
    expect(onCall(group)).toEqual([
      { person: ada, account_id: expect.any(Number), platform: "whatsapp", app: null },
      { person: cleo, account_id: null, platform: null, app: "phone" },
    ]);
    expect(usual.state?.fields).toMatchObject({ when: { value: "2026-03-09T19:00" }, length: { value: 25 } });
    expect(edits.record(usual.edit!)).toMatchObject({ action: "add", label: "call" });
    expect(archive.changes.list({ limit: 1 })[0]).toMatchObject({ action: "call add" });

    // Said: on Discord, Cleo (with no account) on the app itself.
    const discord = await run(edits.add("calls", { when: "2026-03-09T21:00", length: 5, with: [cleo], app: "discord" }, SOURCE));
    expect(onCall(Number(keyOf(discord.id)!.native_id.replace("logged:", "")))).toEqual([{ person: cleo, account_id: null, platform: null, app: "discord" }]);

    const refused = await refusal(edits.add("calls", { when: "2026-03-09T19:00", length: 25, with: [ada], app: "telegram" }, SOURCE));
    expect(refused).toBeInstanceOf(InvalidInputError);
    expect(refused.message).toContain("Ada Sample has no Telegram account");
    expect(refused.message).toContain("WhatsApp");
  });
});

describe("Delete, in a row's drawer", () => {
  it("deletes a logged call and a hangout, undone from the record or from Friend Map's Changes", async () => {
    const call = await run(edits.add("calls", { when: "2026-03-10T08:15", length: 12, with: [cleo], app: "usual" }, SOURCE));
    const deleted = await run(edits.remove("calls", call.id, SOURCE));
    expect(deleted).toMatchObject({ gone: true, state: null });
    expect(() => edits.state("calls", call.id)).toThrow(NotFoundError);
    const record = edits.record(deleted.edit!);
    expect(record).toMatchObject({ action: "delete", label: "call", after: null });
    expect(record.before).toContain("12 min");
    expect(archive.changes.list({ limit: 1 })[0]).toMatchObject({ action: "call delete" });

    // Undone from the record: back.
    const back = await run(edits.undo(deleted.edit!, SOURCE));
    expect(back.gone).toBe(false);
    expect(edits.state("calls", back.id).fields.length).toMatchObject({ value: 12 });

    // A hangout deleted, then undone from Friend Map's Changes: the record says so, and its Undo is refused saying where.
    const hangout = await run(edits.add("hangouts", { when: "2026-03-11", hours: 3, with: [cleo] }, SOURCE));
    const gone = await run(edits.remove("hangouts", hangout.id, SOURCE));
    const undo = archive.changes.undo(archive.changes.list({ limit: 1 })[0]!.id, { surface: "app" });
    expect(edits.record(gone.edit!)).toMatchObject({ undone: `in Friend Map's Changes (its #${undo.changeset})` });
    expect((await refusal(edits.undo(gone.edit!, SOURCE))).message).toContain("Friend Map's Changes");
  });

  it("never deletes an imported call, and says why in its state", async () => {
    expect(edits.state("calls", importedCall).delete).toEqual({ locked: expect.stringContaining("never deleted") });
    const refused = await refusal(edits.remove("calls", importedCall, SOURCE));
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect(refused.message).toContain("never deleted");
    expect(edits.state("calls", importedCall)).toBeTruthy();
    expect(await refusal(edits.remove("messages", "1", SOURCE))).toBeInstanceOf(ForbiddenError);
  });
});

describe("Answered, which Friend Map's Calls tab set before it folded in here", () => {
  it("sets an imported call's answer over its source's, undone as any edit, and keeps a logged call's", async () => {
    // The made-up call record lasted two minutes, so its source says it was answered.
    expect(edits.state("calls", importedCall).fields.answered).toEqual({ value: "answered" });
    const missed = await run(edits.edit("calls", importedCall, "answered", "missed", SOURCE));
    expect(missed.state?.fields.answered).toEqual({ value: "missed" });
    expect(edits.record(missed.edit!)).toMatchObject({ label: "Answered", before: "Yes", after: "No" });
    expect(archive.calendarDb.prepare("SELECT facts ->> '$.answered' AS answered FROM event WHERE id = ?").get(Number(missed.id))).toEqual({ answered: "no" });
    await run(edits.undo(missed.edit!, SOURCE));
    expect(edits.state("calls", importedCall).fields.answered).toEqual({ value: "answered" });

    const logged = await run(edits.add("calls", { when: "2026-03-13T09:00", length: 3, with: [cleo], app: "usual" }, SOURCE));
    expect(logged.state?.fields.answered).toMatchObject({ value: "answered", locked: expect.stringContaining("was answered") });
    expect(await refusal(edits.edit("calls", logged.id, "answered", "missed", SOURCE))).toBeInstanceOf(ForbiddenError);
    expect(await refusal(edits.edit("calls", importedCall, "answered", "maybe", SOURCE))).toBeInstanceOf(InvalidInputError);
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

  it("adds and deletes through /add and /delete, refusing an imported call's delete and a body that is not one", async () => {
    const added = (await (await post("/add", { kind: "hangouts", values: { when: "2026-03-12T10:00", hours: 1, with: [cleo] } })).json()) as EditDone;
    expect(added.state?.fields.when).toMatchObject({ value: "2026-03-12T10:00" });
    const deleted = await post("/delete", { kind: "hangouts", id: added.id });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as EditDone).gone).toBe(true);
    expect((await post("/delete", { kind: "calls", id: importedCall })).status).toBe(403);
    expect((await post("/delete", { kind: "calls" })).status).toBe(400);
    expect((await post("/add", { values: {} })).status).toBe(400);
  });
});
