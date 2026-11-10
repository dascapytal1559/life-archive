// Untouched people (People.untouched): those the captain has never changed by
// hand. Every kind of edit touches someone, imports, the rules and the address
// book do not, and an undo puts them back as they were. Then a group chat's
// "Archive untouched" (POST /api/archive/groups/:id/archive-untouched): it
// archives only the untouched who are not archived, as one changeset that one
// undo puts back. Made-up people and placeholder text only.

import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ArchivedUntouched, type ArchiveEvent, type ChangesetInfo, type GroupChat, transaction } from "../../../sdk/server.ts";
import { archiveHandler } from "../testing/routes.ts";
import { ImportSession } from "./write.ts";

let dataDir: string;
let archive: TestArchive;
let server: Server;
let base: string;

/** Everyone with a one-to-one chat (so the archive rules show them), all in one group; Quiet is only in it, silent. */
const NAMED = ["Ada", "Bo", "Cy", "Dee", "Eve", "Fay", "Gus", "Hal", "Ivy", "Kim", "Lu", "Mo"].map((first) => `${first} Example`);

const key = (name: string) => `id-${name.split(" ")[0].toLowerCase()}`;

function events(): ArchiveEvent[] {
  let n = 0;
  const out: ArchiveEvent[] = [{ kind: "account", key: "me", keyKind: "id", displayName: "Riley Self", isSelf: true }];
  const message = (conversation: string, sender: string): ArchiveEvent => ({
    kind: "message", id: `m${n}`, idKind: "platform", conversation, sender, isFromSelf: sender === "me",
    sentAt: 1_700_000_000_000 + n++ * 60_000, type: "text", text: "placeholder", raw: {},
  });
  // Keyed on an id, not the name: a name that is its own key is no name to the archive rules.
  for (const who of NAMED) {
    out.push({ kind: "account", key: key(who), keyKind: "id", displayName: who });
    out.push({ kind: "conversation", id: `direct-${key(who)}`, type: "direct", members: ["me", key(who)] });
    out.push(message(`direct-${key(who)}`, key(who)), message(`direct-${key(who)}`, "me"));
  }
  // Two accounts with one name of two words: the rules join them into one person, whom nobody has touched.
  for (const key of ["jo-1", "jo-2"]) {
    out.push({ kind: "account", key, keyKind: "id", displayName: "Jo Doe" });
    out.push({ kind: "conversation", id: `direct-${key}`, type: "direct", members: ["me", key] });
    out.push(message(`direct-${key}`, key), message(`direct-${key}`, "me"));
  }
  out.push({ kind: "account", key: "quiet", keyKind: "id", displayName: "Quinn Quiet" });
  out.push({ kind: "conversation", id: "club", type: "group", title: "club chat", members: ["me", ...NAMED.map(key), "quiet"] });
  out.push(message("club", key(NAMED[0])), message("club", "me"));
  return out;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-untouched-"));
  archive = await openTestArchive(dataDir);
  transaction(archive.db, () => {
    const source = Number(archive.db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'test', 'export', 'test', 0, 'ok')")
      .run().lastInsertRowid);
    const session = new ImportSession(archive.db, "messenger", source, "export");
    for (const event of events()) session.apply(event);
  });
  archive.people.runRules();
  const handler = archiveHandler(archive);
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/archive`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  archive.close();
  await rm(dataDir, { recursive: true, force: true });
});

const id = (name: string) => archive.structure.listPeople().people.find((p) => p.name === name)!.id;
const untouched = (name: string) => archive.structure.getPerson(id(name))!.untouched;
/** One of the captain's edits, recorded as a changeset as the app records it; returns the changeset. */
const edit = (work: () => unknown) => archive.changes.record({ surface: "app", action: "test" }, work).changeset!;
const undo = (changeset: number) => archive.changes.undo(changeset, { surface: "app" });

function send(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function club(): Promise<GroupChat> {
  const groups = archive.structure.groupsOf(id("Ada Example"))!;
  return (await (await fetch(`${base}/groups/${groups.find((g) => g.title === "club chat")!.id}`)).json()) as GroupChat;
}

describe("untouched people", () => {
  it("are everyone an import made, and the rules joined, until the captain changes them; never the captain", () => {
    const { people, me } = archive.structure.listPeople();
    expect(people.map((p) => [p.name, p.untouched])).toEqual(expect.arrayContaining([...NAMED, "Jo Doe", "Quinn Quiet"].map((name) => [name, true])));
    expect(people.find((p) => p.name === "Jo Doe")!.accounts).toHaveLength(2);
    expect(me!.untouched).toBe(false);
    expect(archive.people.untouched().has(me!.id)).toBe(false);
    // The Table says the same.
    expect(archive.structure.tableRows().find((p) => p.name === "Ada Example")!.untouched).toBe(true);
  });

  it("are touched by every edit of the captain's, and untouched again when it is undone", () => {
    const people = archive.people;
    const edits: Array<[string, (id: number) => unknown]> = [
      ["Bo Example", (p) => people.setName(p, "Bo Renamed")],
      ["Cy Example", (p) => people.setAliases(p, ["Cee"])],
      ["Dee Example", (p) => people.addTags(p, ["friend"])],
      ["Eve Example", (p) => people.setLocation(p, "Tokyo")],
      ["Fay Example", (p) => people.setNote(p, "Owes me lunch")],
      ["Gus Example", (p) => people.setShouldReachOut(p, true)],
    ];
    for (const [name, change] of edits) {
      const person = id(name);
      const changeset = edit(() => change(person));
      expect(archive.structure.getPerson(person)!.untouched, name).toBe(false);
      undo(changeset);
      expect(archive.structure.getPerson(person)!.untouched, name).toBe(true);
    }
  });

  it("are touched by archiving or bringing back by hand, a merge, and Not them on either side", () => {
    const people = archive.people;
    const hal = id("Hal Example");
    const archived = edit(() => people.addTags(hal, ["archive"]));
    expect(untouched("Hal Example")).toBe(false);
    undo(archived);
    expect(untouched("Hal Example")).toBe(true);
    // Quiet is archived by the rules (silent in a group); bringing him back by hand touches him.
    expect(archive.structure.getPerson(id("Quinn Quiet"))!.archived).toBe("groups-silent");
    const kept = edit(() => people.addTags(id("Quinn Quiet"), ["keep"]));
    expect(untouched("Quinn Quiet")).toBe(false);
    undo(kept);
    expect(untouched("Quinn Quiet")).toBe(true);

    const [ivy, kim] = [id("Ivy Example"), id("Kim Example")];
    const merged = edit(() => people.merge(ivy, kim));
    expect(archive.structure.getPerson(ivy)!.untouched).toBe(false);
    undo(merged);
    expect(untouched("Ivy Example")).toBe(true);
    expect(untouched("Kim Example")).toBe(true);

    // "Not them" on a person the rules joined: they, and the fresh person the account becomes, are touched.
    const jo = archive.structure.getPerson(id("Jo Doe"))!;
    const detached = edit(() => people.detach(jo.id, jo.accounts[0].id));
    const [left, fresh] = archive.structure.listPeople().people.filter((p) => p.name === "Jo Doe").sort((a, b) => a.id - b.id);
    expect([left.id, left.untouched, fresh.untouched]).toEqual([jo.id, false, false]);
    undo(detached);
    expect(archive.structure.listPeople().people.filter((p) => p.name === "Jo Doe").map((p) => [p.id, p.untouched])).toEqual([[jo.id, true]]);
  });

  it("are not touched by the address book's notes", () => {
    const lu = id("Lu Example");
    archive.people.fillAddressBookNotes(new Map([[lu, "Company: Example Co"]]));
    expect(archive.structure.getPerson(lu)).toMatchObject({ note: "Company: Example Co", untouched: true });
  });
});

describe("Archive untouched in a group chat", () => {
  it("archives the untouched who are not archived, skipping the touched and archived, as one changeset one undo puts back", async () => {
    const people = archive.people;
    // Touched: Bo (tagged), Cy (archived by hand, so archived already too). Quiet is archived by the rules.
    edit(() => people.addTags(id("Bo Example"), ["friend"]));
    edit(() => people.addTags(id("Cy Example"), ["archive"]));
    const before = await club();
    const byName = new Map(before.members.map((m) => [m.name, m]));
    expect(byName.get("Bo Example")).toMatchObject({ untouched: false, archived: false });
    expect(byName.get("Cy Example")).toMatchObject({ untouched: false, archived: true });
    expect(byName.get("Quinn Quiet")).toMatchObject({ untouched: true, archived: true });
    expect(byName.get("Ada Example")).toMatchObject({ untouched: true, archived: false });
    const shown = before.members.filter((m) => m.untouched && !m.archived).map((m) => m.id);
    const expected = NAMED.filter((name) => name !== "Bo Example" && name !== "Cy Example");
    expect(shown.map((p) => before.members.find((m) => m.id === p)!.name).sort()).toEqual([...expected].sort());

    // Only the page may ask; and only for whom it showed: anyone more or fewer, and nothing changes.
    const path = `/groups/${before.id}/archive-untouched`;
    expect((await send(path, { people: shown }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const stale = await send(path, { people: shown.slice(1) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "who is untouched in this group has changed since it was shown; look again" });
    expect((await send(path, { people: [...shown, id("Bo Example")] })).status).toBe(409);
    expect((await send(path, { people: "everyone" })).status).toBe(400);
    expect(untouched("Ada Example")).toBe(true);

    const response = await send(path, { people: shown });
    expect(response.status).toBe(200);
    const done = (await response.json()) as ArchivedUntouched;
    expect(done.archived).toBe(expected.length);
    const after = new Map((await club()).members.map((m) => [m.name, m]));
    for (const name of expected) expect(after.get(name), name).toMatchObject({ archived: true, untouched: false });
    expect(archive.structure.getPerson(id("Ada Example"))!.archived).toBe("you");
    expect(after.get("Bo Example")).toMatchObject({ archived: false });
    expect(archive.structure.getPerson(id("Quinn Quiet"))!.archived).toBe("groups-silent");

    const changeset = (await (await fetch(`${base}/changes/${done.changeset}`)).json()) as ChangesetInfo;
    expect(changeset).toMatchObject({ surface: "app", action: `archive untouched in group ${before.id}`, peopleCount: expected.length });

    // Nobody left to archive: nothing changes, and no changeset.
    expect(await (await send(path, { people: [] })).json()).toEqual({ archived: 0, changeset: null });

    undo(done.changeset!);
    const back = new Map((await club()).members.map((m) => [m.name, m]));
    for (const name of expected) expect(back.get(name), name).toMatchObject({ archived: false, untouched: true });
  });

  it("answers 404 for a chat that is not a group", async () => {
    const response = await send("/groups/99999/archive-untouched", { people: [] });
    expect(response.status).toBe(404);
  });
});
