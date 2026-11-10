import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CalendarDay, type CalendarMonth, type CallNoteSaved, CAPABILITIES, type CatchUp, type CatchUpSaved, type Contract, CONTRACT_VERSION, dayKey, type DayMessagesPage, type Draft, type GroupChat, type ListedCall, type LocationInfo, type ManualCallSaved, type MergeProposal, monthKey, monthRange, type PeopleListing, type PersonAdded, type PersonGroup, type PersonSaved, type PersonSummary, type RelationshipsReport, type ScoreReport, type SearchHit, type TableRow, type TagInfo, type TagsChanged, type TimelinePage } from "../../../sdk/server.ts";
import { sampleMessengerExport } from "../fixtures/exports.ts";
import { THREADS } from "../fixtures/messenger.ts";
import { addSamplePeople, type SamplePerson } from "../fixtures/samplePeople.ts";
import { refusal } from "../page/src/contract/handshake.ts";
import { archiveHandler } from "../testing/routes.ts";

const SAMPLE_PEOPLE = new URL("../fixtures/data/people.json", import.meta.url);

let dataDir: string;
let archive: TestArchive;
let server: Server;
let base: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-archive-http-"));
  archive = await openTestArchive(dataDir);
  await archive.host.setEnabled("messenger-export", true);
  await archive.importHistory("messenger-export", await sampleMessengerExport(dataDir));
  addSamplePeople(archive, JSON.parse(await readFile(SAMPLE_PEOPLE, "utf8")) as SamplePerson[]);
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

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

/** The person with this name, as People lists them. */
async function named(name: string): Promise<PersonSummary> {
  const person = (await get<PeopleListing>("/people")).people.find((p) => p.name === name);
  if (!person) throw new Error(`nobody named ${name}`);
  return person;
}

async function send(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("structure", () => {
  it("answers the handshake: contract 1.3, everything in it, friend-map's own scores last (page/scoring.ts), in the archive's zone and locale", async () => {
    const contract = await get<Contract>("/contract");
    expect(contract).toEqual({
      version: CONTRACT_VERSION,
      capabilities: [...Object.keys(CAPABILITIES).filter((c) => c !== "scores"), "scores"],
      timeZone: "Australia/Melbourne",
      locale: "en-AU",
    });
    expect(CONTRACT_VERSION).toBe("1.3.0");
  });

  it("answers a handshake friend-map's page takes", async () => {
    expect(refusal(await get<Contract>("/contract"))).toBeNull();
  });

  it("lists people with names, aliases, tags, counts and the captain's own account", async () => {
    const listing = await get<PeopleListing>("/people");
    const ada = listing.people.find((p) => p.name === "Ada Sample")!;
    expect(ada).toMatchObject({ aliases: ["Addy"], tags: ["climbing"], edited: true, directMessageCount: 11 });
    expect(ada).not.toHaveProperty("fileId");
    expect(ada.accounts.map((a) => a.link)).toEqual(["import"]);
    expect(ada.lastByPlatform).toEqual([{ platform: "messenger", at: Date.parse("2026-09-20T19:30:00+10:00") }]);
    expect(listing.me?.accounts.map((a) => a.displayName)).toEqual(["Riley Self"]);
    expect(listing.tags).toEqual([{ tag: "climbing", count: 1 }]);
    expect(listing.people.filter((p) => p.unknown)).toHaveLength(4);

    expect((await get<PeopleListing>("/people?tag=climbing")).people.map((p) => p.name)).toEqual(["Ada Sample"]);
    // Found by an alias too.
    expect((await get<PeopleListing>("/people?query=addy")).people.map((p) => p.name)).toEqual(["Ada Sample"]);
    expect((await get<PeopleListing>("/people?query=bruno")).people.map((p) => p.name).sort()).toEqual(["Bruno P", "Bruno Placeholder"]);
    // Someone added by hand, with no accounts yet, is listed too.
    expect(await named("Felix Demo")).toMatchObject({ accounts: [], edited: true, messageCount: 0 });
    expect((await get<PersonSummary>(`/people/${ada.id}`)).id).toBe(ada.id);
    expect((await fetch(`${base}/people/999999`)).status).toBe(404);
  });

  it("gives what friend-map scores from, each person's messages each month, tagged with the archive's version", async () => {
    const ada = await named("Ada Sample");
    const first = await fetch(`${base}/score-report`);
    const report = (await first.json()) as ScoreReport;
    const { months } = report.people.find((p) => p.id === ada.id)!;
    expect(months.length).toBeGreaterThan(0);
    expect(months.map((m) => m.month)).toEqual([...months.map((m) => m.month)].sort());
    expect(months.reduce((sum, m) => sum + m.directFromMe + m.directFromThem, 0)).toBe(ada.directMessageCount);
    expect(months[0]).not.toHaveProperty("text");
    expect(report.groups.length).toBeGreaterThan(0);
    // Only the facts: the scores are worked out from them by friend-map's own code, in its scoring routes (page/scoring.ts).
    expect(Object.keys(report.people[0]).sort()).toEqual(["id", "months"]);
    expect((await fetch(`${base}/people/${ada.id}/activity`)).status).toBe(200);
    expect((await fetch(`${base}/table`)).status).toBe(200);

    // Asked again with its tag, unchanged: 304 and no body; the Table's rows the same.
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^".+"$/);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const again = await fetch(`${base}/score-report`, { headers: { "if-none-match": `"other", ${etag}` } });
    expect([again.status, await again.text(), again.headers.get("etag")]).toEqual([304, "", etag]);
    const rows = await fetch(`${base}/table-rows`, { headers: { "if-none-match": etag } });
    expect(rows.status).toBe(304);
    // Any change to people gives a new tag, and the body again.
    await send(`/people/${ada.id}/note`, "PUT", { note: "a new note" });
    const changed = await fetch(`${base}/score-report`, { headers: { "if-none-match": etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect(((await changed.json()) as ScoreReport).people).toEqual(report.people);
    await send(`/people/${ada.id}/note`, "PUT", { note: ada.note });
    // "This is me" is the CLI's alone now.
    expect((await send(`/people/${ada.id}/me`, "POST")).status).toBe(404);
  });

  it("confirms a proposal, keeping the person the captain edited, and edits name, aliases and tags for anyone", async () => {
    expect(await get<MergeProposal[]>("/merge-proposals")).toEqual([]);
    // Two people added by hand whose names contain the account's "Cléo Example": each is proposed with it.
    const dora = archive.people.create("Cléo Dora Example");
    archive.people.create("Cléo Example Jr");
    archive.people.runRules();
    const proposals = await get<MergeProposal[]>("/merge-proposals");
    expect(proposals.map((p) => [p.tier, p.evidence[0].rule, p.people.map((person) => person.name).sort().join(" + ")])).toEqual([
      ["medium", "name-contained", "Cléo Dora Example + Cléo Example"], ["medium", "name-contained", "Cléo Example + Cléo Example Jr"],
    ]);
    const [cleo, reject] = proposals;
    expect((await send(`/merge-proposals/${reject.id}/reject`, "POST")).status).toBe(204);
    const confirmed = await send(`/merge-proposals/${cleo.id}/confirm`, "POST");
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ id: dora, name: "Cléo Dora Example", directMessageCount: 2 });
    expect((await send(`/merge-proposals/${reject.id}/confirm`, "POST")).status).toBe(404);

    // Hana has never been edited: no file, nothing to start first.
    const hana = await named("Hana Newface");
    expect(hana.edited).toBe(false);
    const tagged = await send(`/people/${hana.id}/tags`, "PUT", { tags: ["friend", "Workshop"] });
    expect(await tagged.json()).toMatchObject({ person: { id: hana.id, tags: ["friend", "workshop"], edited: true }, changeset: expect.any(Number) });
    // A tag nobody had is made, and goes again with the last person who has it; the page's chip names them.
    expect(await (await send(`/people/${hana.id}/tags`, "PUT", { tags: ["friend", "workshop", "oops"] })).json()).toMatchObject({ created: ["oops"], deleted: [] });
    expect(await (await send(`/people/${hana.id}/tags`, "PUT", { tags: ["friend", "workshop"] })).json()).toMatchObject({ created: [], deleted: ["oops"] });
    // Every name, in order, the first their name: one changeset each, the same again none.
    const renamed = await (await send(`/people/${hana.id}/names`, "PUT", { names: ["Hana  Newface-Smith", "Hana", " Hana ", "H. N."] })).json() as PersonSaved;
    expect(renamed).toMatchObject({ person: { name: "Hana Newface-Smith", aliases: ["Hana", "H. N."] }, changeset: expect.any(Number) });
    expect(await (await send(`/people/${hana.id}/names`, "PUT", { names: ["Hana Newface-Smith", "Hana", "H. N."] })).json()).toMatchObject({ changeset: null });
    // Dragging an alias first makes it their name; the name before stays an alias.
    const dragged = await (await send(`/people/${hana.id}/names`, "PUT", { names: ["Hana", "Hana Newface-Smith", "H. N."] })).json() as PersonSaved;
    expect(dragged).toMatchObject({ person: { name: "Hana", aliases: ["Hana Newface-Smith", "H. N."] }, changeset: expect.any(Number) });
    expect((await send(`/changes/${dragged.changeset}/undo`, "POST", {})).status).toBe(200);
    expect(await get<PersonSummary>(`/people/${hana.id}`)).toMatchObject({ name: "Hana Newface-Smith", aliases: ["Hana", "H. N."] });
    // Nobody is left without a name.
    expect((await send(`/people/${hana.id}/names`, "PUT", { names: [] })).status).toBe(400);
    expect((await send(`/people/${hana.id}/names`, "PUT", { names: ["  "] })).status).toBe(400);
    expect((await send(`/people/${hana.id}/names`, "PUT", { names: "Hana" })).status).toBe(400);
    expect((await send(`/people/${hana.id}/name`, "PUT", { name: "Hana" })).status).toBe(404);
    expect((await send(`/people/${hana.id}/tags`, "PUT", { tags: "nope" })).status).toBe(400);
    expect(await (await send(`/people/${hana.id}/note`, "PUT", { note: " Owes me lunch\r\nTuesdays " })).json())
      .toMatchObject({ note: "Owes me lunch\nTuesdays", noteFromContacts: false });
    expect((await send(`/people/${hana.id}/note`, "PUT", { note: 3 })).status).toBe(400);
    expect(await (await send(`/people/${hana.id}/should-reach-out`, "PUT", { shouldReachOut: true })).json()).toMatchObject({ shouldReachOut: true });
    expect((await send(`/people/${hana.id}/should-reach-out`, "PUT", { shouldReachOut: "yes" })).status).toBe(400);
    // Drafts: saved as typed, no changeset; emptied, gone.
    const changesBefore = (await get<unknown[]>("/changes")).length;
    const draft = await (await send(`/people/${hana.id}/drafts`, "POST", { text: " Lunch this week?\r\n " })).json() as Draft;
    expect(draft).toMatchObject({ personId: hana.id, text: "Lunch this week?" });
    expect(await (await send(`/drafts/${draft.id}`, "PUT", { text: "Lunch on Friday?" })).json()).toMatchObject({ id: draft.id, text: "Lunch on Friday?" });
    expect(await get<Draft[]>(`/people/${hana.id}/drafts`)).toMatchObject([{ id: draft.id, text: "Lunch on Friday?" }]);
    expect((await send(`/drafts/${draft.id}`, "PUT", { text: null })).status).toBe(400);
    expect(await (await send(`/drafts/${draft.id}`, "PUT", { text: "" })).json()).toBeNull();
    expect(await get<Draft[]>(`/people/${hana.id}/drafts`)).toEqual([]);
    expect((await send(`/drafts/${draft.id}`, "DELETE")).status).toBe(404);
    expect((await send(`/people/${hana.id}/draft-opener`, "PUT", { draftOpener: "Hi" })).status).toBe(404);
    expect((await get<unknown[]>("/changes")).length).toBe(changesBefore);
    expect((await get<PeopleListing>("/people?reachOut=1")).people.map((p) => p.id)).toEqual([hana.id]);
    expect((await get<RelationshipsReport>("/relationships")).people.find((p) => p.id === hana.id)).toMatchObject({ shouldReachOut: true });
    expect(await (await send(`/people/${hana.id}/location`, "PUT", { location: "Toronto" })).json())
      .toMatchObject({ person: { location: "Toronto" }, changeset: expect.any(Number) });
    // The same again, but for case, changes nothing, so no changeset to undo.
    expect(await (await send(`/people/${hana.id}/location`, "PUT", { location: "toronto" })).json())
      .toMatchObject({ person: { location: "Toronto" }, changeset: null });
    expect((await send(`/people/${hana.id}/location`, "PUT", { location: 3 })).status).toBe(400);
    const { person: recoloured, changeset: recolour } = await (await send(`/people/${hana.id}/identicon`, "PUT", { seed: "0123456789abcdef", hue: 200 })).json() as PersonSaved;
    expect(recoloured).toMatchObject({ identiconSeed: "0123456789abcdef", identiconHue: 200 });
    expect(recolour).toEqual(expect.any(Number));
    // The same again changes nothing, so no changeset to undo.
    expect(await (await send(`/people/${hana.id}/identicon`, "PUT", { seed: "0123456789abcdef", hue: 200 })).json())
      .toMatchObject({ changeset: null });
    expect((await send(`/people/${hana.id}/identicon`, "PUT", { seed: "0123456789abcdef", hue: 360 })).status).toBe(400);
    expect((await send(`/people/${hana.id}/identicon`, "PUT", { hue: 200 })).status).toBe(400);
    expect((await send(`/people/${hana.id}/identicon`, "PUT", {})).status).toBe(400);
    expect((await send(`/people/${hana.id}/met`, "PUT", { met: "Couchsurfing" })).status).toBe(404);
    expect((await get<PeopleListing>("/people?location=TORONTO")).people.map((p) => p.id)).toEqual([hana.id]);
    expect((await get<PeopleListing>("/people?query=toronto")).people.map((p) => p.id)).toEqual([hana.id]);
    expect((await get<TableRow[]>("/table-rows")).find((p) => p.id === hana.id))
      .toMatchObject({ location: "Toronto" });
    expect(await get<LocationInfo[]>("/locations")).toEqual([{ name: "Toronto", count: 1 }]);
    expect(await (await send("/locations/toronto", "PUT", { name: "New York" })).json()).toEqual([{ name: "New York", count: 1 }]);
    expect((await send("/locations/Nowhere", "PUT", { name: "Somewhere" })).status).toBe(404);
    expect((await send("/locations/New%20York", "PUT", { name: "--" })).status).toBe(400);
    expect((await send("/fields/location/CS", "DELETE")).status).toBe(404);
    expect((await send(`/people/${hana.id}/occupations`, "PUT", { occupations: ["Programmer"] })).status).toBe(404);
    expect(await (await send(`/people/${hana.id}/location`, "PUT", { location: null })).json()).toMatchObject({ person: { location: null } });
    expect(await get<LocationInfo[]>("/locations")).toEqual([]);
    expect((await send(`/people/999999/names`, "PUT", { names: ["Nobody"] })).status).toBe(404);
  });

  it("merges one person into another, which is kept, and takes an account back out with Not them", async () => {
    const bruno = await named("Bruno Placeholder");
    const brunoP = await named("Bruno P");
    const merged = await send(`/people/${bruno.id}/merge`, "POST", { with: brunoP.id });
    expect(merged.status).toBe(200);
    const person = (await merged.json()) as PersonSummary;
    expect(person).toMatchObject({ id: bruno.id, name: "Bruno Placeholder" });
    expect(person.accounts.map((a) => [a.displayName, a.link]).sort()).toEqual([["Bruno P", "captain"], ["Bruno Placeholder", "import"]]);
    // The other person is gone.
    expect((await fetch(`${base}/people/${brunoP.id}`)).status).toBe(404);

    const account = person.accounts.find((a) => a.displayName === "Bruno P")!;
    const detached = await send(`/people/${bruno.id}/accounts/${account.id}/detach`, "POST");
    expect((await detached.json()).accounts.map((a: { displayName: string }) => a.displayName)).toEqual(["Bruno Placeholder"]);
    const fresh = await named("Bruno P");
    expect(fresh.id).not.toBe(brunoP.id);
    expect(fresh.accounts.map((a) => a.link)).toEqual(["captain"]);
  });

  it("lists every tag in order, and adds, renames, merges, moves and deletes them for everyone", async () => {
    const names = (tags: TagInfo[]) => tags.map((t) => `${t.name}:${t.count}${t.builtIn ? "*" : ""}`);
    // A change answers the tags after it and its changeset, for the page's chip to undo.
    const list = async (response: Response) => {
      expect(response.status).toBe(200);
      const changed = (await response.json()) as TagsChanged;
      expect(changed.changeset).toEqual(expect.any(Number));
      return names(changed.tags);
    };
    expect(names(await get<TagInfo[]>("/tags"))).toEqual(["archive:0*", "keep:0*", "live-together:0*", "show-name:0*", "climbing:1", "friend:1", "workshop:1"]);
    expect(await list(await send("/tags", "POST", { name: "Night Owls" }))).toEqual(["archive:0*", "keep:0*", "live-together:0*", "show-name:0*", "climbing:1", "friend:1", "workshop:1", "night-owls:0"]);
    expect((await send("/tags", "POST", { name: "night-owls" })).status).toBe(400);
    expect(await list(await send("/tags/night-owls/position", "PUT", { position: 0 }))).toEqual(["night-owls:0", "archive:0*", "keep:0*", "live-together:0*", "show-name:0*", "climbing:1", "friend:1", "workshop:1"]);
    // Onto a tag that exists: merged into it.
    expect(await list(await send("/tags/workshop", "PUT", { name: "friend" }))).toEqual(["night-owls:0", "archive:0*", "keep:0*", "live-together:0*", "show-name:0*", "climbing:1", "friend:1"]);
    expect(await list(await send(`/tags/${encodeURIComponent("night-owls")}`, "PUT", { name: "owls & larks" }))).toEqual(["owls-&-larks:0", "archive:0*", "keep:0*", "live-together:0*", "show-name:0*", "climbing:1", "friend:1"]);
    expect(await list(await send(`/tags/${encodeURIComponent("owls-&-larks")}`, "DELETE"))).toEqual(["archive:0*", "keep:0*", "live-together:0*", "show-name:0*", "climbing:1", "friend:1"]);
    expect((await send("/tags/archive", "DELETE")).status).toBe(400);
    expect((await send("/tags/keep", "PUT", { name: "kept" })).status).toBe(400);
    expect((await send("/tags/nope", "DELETE")).status).toBe(404);
    expect((await send("/tags/friend/position", "PUT", { position: "first" })).status).toBe(400);
    expect((await get<PeopleListing>("/people?tag=Friend")).people.map((p) => p.tags)).toEqual([["friend"]]);
  });

  it("adds someone by hand, offering who already goes by that name first, as a changeset the change log can undo", async () => {
    const input = { name: "Walt Example", location: "Hobart", tags: ["offline"], note: "a neighbour" };
    const added = (await (await send("/people", "POST", input)).json()) as PersonAdded;
    expect(added).toMatchObject({ changeset: expect.any(Number), sameName: [] });
    expect(added.person).toMatchObject({ name: "Walt Example", location: "Hobart", tags: ["offline"], note: "a neighbour", accounts: [], archived: null });
    const walt = added.person!.id;
    expect((await get<TableRow[]>("/table-rows")).map((p) => p.id)).toContain(walt);

    // The same name again, in another case, adds nobody until asked to anyway.
    const again = (await (await send("/people", "POST", { name: "walt example" })).json()) as PersonAdded;
    expect(again).toEqual({ person: null, changeset: null, sameName: [{ id: walt, name: "Walt Example", aliases: [] }] });
    const anyway = (await (await send("/people", "POST", { name: "walt example", anyway: true })).json()) as PersonAdded;
    expect(anyway.person).toMatchObject({ name: "walt example" });

    for (const changeset of [anyway.changeset!, added.changeset!]) {
      expect((await send(`/changes/${changeset}/undo`, "POST", {})).status).toBe(200);
    }
    expect((await fetch(`${base}/people/${walt}`)).status).toBe(404);
    expect((await get<TagInfo[]>("/tags")).map((t) => t.name)).not.toContain("offline");
    expect((await send("/people", "POST", { name: "  " })).status).toBe(400);
    expect((await send("/people", "POST", { name: "Zed Example", tags: "offline" })).status).toBe(400);
  });

  it("lists every call for the Table's Calls, and gives one a note or takes it away, each a changeset the change log can undo; refuses an answer for one logged", async () => {
    const ada = await named("Ada Sample");
    const accountId = ada.accounts.find((a) => a.platform === "messenger")!.id;
    const input = { people: [{ personId: ada.id, accountId, app: null }], day: "2026-09-28", time: "19:30", minutes: 25, note: "Planned the trip" };
    const logged = (await (await send("/calls", "POST", input)).json()) as ManualCallSaved;
    expect(logged.call).toMatchObject({ manual: true, durationSeconds: 1500, note: "Planned the trip" });
    const id = logged.call!.id;
    const listed = () => get<ListedCall[]>("/calls").then((calls) => calls.find((c) => c.ref.kind === "logged" && c.ref.id === id));
    expect(await listed()).toMatchObject({ source: "logged", platform: "messenger", people: [ada.id], durationSeconds: 1500, length: "logged", lengthEditable: true, note: "Planned the trip" });

    const changed = (await (await send("/call-notes", "PUT", { call: { kind: "logged", id }, note: " Talked about the move " })).json()) as CallNoteSaved;
    expect(changed).toEqual({ call: { kind: "logged", id }, note: "Talked about the move", changeset: expect.any(Number) });
    expect((await listed())!.note).toBe("Talked about the move");
    expect(((await (await send("/call-notes", "PUT", { call: { kind: "logged", id }, note: "Talked about the move" })).json()) as CallNoteSaved).changeset).toBeNull();
    const cleared = (await (await send("/call-notes", "PUT", { call: { kind: "logged", id }, note: "" })).json()) as CallNoteSaved;
    expect((await listed())!.note).toBe("");
    expect((await send(`/changes/${cleared.changeset}/undo`, "POST", {})).status).toBe(200);
    expect((await send(`/changes/${changed.changeset}/undo`, "POST", {})).status).toBe(200);
    expect((await listed())!.note).toBe("Planned the trip");

    // What is wrong is said, and nothing is kept.
    expect((await send("/call-notes", "PUT", { call: { kind: "elsewhere", id }, note: "A note" })).status).toBe(400);
    expect((await send("/call-notes", "PUT", { call: { kind: "record", id: 999_999 }, note: "A note" })).status).toBe(404);
    expect((await send("/call-notes", "PUT", { call: { kind: "logged", id }, note: 7 })).status).toBe(400);
    // A call he logged was answered; the testing data has no imported call, so that is said, and nothing kept.
    expect((await send("/call-answered", "PUT", { call: { kind: "logged", id }, answered: "missed" })).status).toBe(400);
    expect((await send("/call-answered", "PUT", { call: { kind: "record", id: 999_999 }, answered: "missed" })).status).toBe(404);
    expect((await send("/call-answered", "PUT", { call: { kind: "record", id: 999_999 }, answered: "maybe" })).status).toBe(400);
    expect(await listed()).toMatchObject({ answered: true, answeredSet: false, sourceAnswered: true });
    expect((await send(`/calls/${id}`, "DELETE")).status).toBe(200);
    expect(await listed()).toBeUndefined();
  });

  it("adds, lists, changes and deletes catch-ups, each a changeset the change log can undo", async () => {
    const ada = await named("Ada Sample");
    const felix = await named("Felix Demo");
    const listingSelf = (await get<PeopleListing>("/people")).me!.id;
    const input = { day: "2026-09-27", hours: 1.5, note: "a long lunch", personIds: [ada.id, felix.id] };
    const added = (await (await send("/catch-ups", "POST", input)).json()) as CatchUpSaved;
    expect(added.changeset).toEqual(expect.any(Number));
    expect(added.catchUp).toMatchObject({ day: "2026-09-27", hours: 1.5, note: "a long lunch" });
    expect(added.catchUp).not.toHaveProperty("byCall");
    expect(added.catchUp!.people.map((p) => p.name)).toEqual(["Ada Sample", "Felix Demo"]);
    const id = added.catchUp!.id;
    expect((await get<CatchUp[]>(`/catch-ups?person=${felix.id}`)).map((c) => c.id)).toEqual([id]);
    expect((await get<CatchUp[]>("/catch-ups")).map((c) => c.id)).toContain(id);
    expect((await get<RelationshipsReport>("/relationships")).catchUps).toContainEqual({ id, day: "2026-09-27", time: null, trip: null, hours: 1.5, others: 0, personIds: [ada.id, felix.id].sort((a, b) => a - b) });

    // byCall false, from an older page, is passed over; true is refused, a call being logged as a call.
    const changed = (await (await send(`/catch-ups/${id}`, "PUT", { day: "2026-09-27", hours: 3, byCall: false, note: "a long lunch", personIds: [ada.id] })).json()) as CatchUpSaved;
    expect(changed.catchUp).toMatchObject({ id, hours: 3 });
    expect(changed.catchUp!.people.map((p) => p.name)).toEqual(["Ada Sample"]);
    const same = (await (await send(`/catch-ups/${id}`, "PUT", { ...input, hours: 3, personIds: [ada.id] })).json()) as CatchUpSaved;
    expect(same.changeset).toBeNull();
    const byCall = await send(`/catch-ups/${id}`, "PUT", { ...input, byCall: true });
    expect(byCall.status).toBe(400);
    expect(await byCall.text()).toMatch(/a hangout is time in person: log a call as a call/);

    const deleted = (await (await send(`/catch-ups/${id}`, "DELETE")).json()) as CatchUpSaved;
    expect(deleted).toEqual({ catchUp: null, changeset: expect.any(Number) });
    expect(await get<CatchUp[]>(`/catch-ups?person=${ada.id}`)).toEqual([]);
    // The change log's undo brings it back as it was before the delete.
    expect((await send(`/changes/${deleted.changeset}/undo`, "POST", {})).status).toBe(200);
    expect((await get<CatchUp[]>(`/catch-ups?person=${ada.id}`))[0]).toMatchObject({ id, hours: 3 });
    await send(`/changes/${changed.changeset}/undo`, "POST", {});
    await send(`/changes/${added.changeset}/undo`, "POST", {});
    expect((await get<CatchUp[]>("/catch-ups")).map((c) => c.id)).not.toContain(id);

    // What is wrong is said, and nothing is kept.
    for (const wrong of [{ ...input, day: "2999-01-01" }, { ...input, hours: 0 }, { ...input, byCall: true }, { ...input, hours: 25 }, { ...input, personIds: [] }, { ...input, personIds: [listingSelf] }]) {
      expect((await send("/catch-ups", "POST", wrong)).status).toBe(400);
    }
    expect((await send("/catch-ups", "POST", { ...input, personIds: [999999] })).status).toBe(404);
    expect((await send("/catch-ups/999999", "PUT", input)).status).toBe(404);
    expect((await send("/catch-ups/999999", "DELETE")).status).toBe(404);
    expect((await fetch(`${base}/catch-ups?person=ada`)).status).toBe(400);
  });

  it("tells the page when people change, from this process or another", async () => {
    const abort = new AbortController();
    const response = await fetch(`${base}/events`, { signal: abort.signal });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toBe(": watching people\n\n");
    archive.people.setName((await named("Dev Testington")).id, "Dev Testington II");
    expect((await reader.read()).value).toMatch(/^event: people\ndata: "\d+"\n\n$/);
    abort.abort();
  });

  it("reports coverage and connectors", async () => {
    const coverage = await get<{ platforms: Array<{ platform: string; messageCount: number; spans: unknown[] }> }>("/coverage");
    expect(coverage.platforms).toMatchObject([{ platform: "messenger", messageCount: 28 }]);
    expect(await get("/connectors")).toMatchObject([
      { id: "call-history", enabled: false, status: "disabled" },
      { id: "discord-package", enabled: false, status: "disabled" },
      { id: "facebook-dyi", enabled: false, status: "disabled" },
      { id: "grok-bot", platform: "grok-bot", enabled: false, status: "disabled", capabilities: { sync: true, send: false }, live: null },
      { id: "imessage-db", enabled: false, status: "disabled" },
      { id: "instagram-dyi", enabled: false, status: "disabled" },
      { id: "llm-sessions", platform: "claude-code", enabled: false, status: "disabled", capabilities: { sync: true, send: false }, live: null },
      { id: "matrix-bridge", enabled: false, status: "disabled", capabilities: { sync: true, send: true }, companion: "the bridge rig's homeserver", live: null },
      { id: "matrix-whatsapp", enabled: false, status: "disabled", capabilities: { sync: true, send: false }, companion: "the bridge rig's homeserver", live: null },
      { id: "messenger-export", enabled: true, status: "idle" },
      { id: "signal-export", enabled: false, status: "disabled" },
      { id: "wechat-ios", enabled: false, status: "disabled" },
      { id: "whatsapp-db", enabled: false, status: "disabled" },
      { id: "x-archive", enabled: false, status: "disabled" },
    ]);
  });

  it("serves the relationship numbers of everyone on the map, archived people only counted, and group membership", async () => {
    const report = await get<RelationshipsReport>("/relationships");
    const ada = report.people.find((p) => p.name === "Ada Sample")!;
    expect(ada.aliases).toEqual(["Addy"]);
    expect(ada.totals.directFromMe + ada.totals.directFromThem).toBe(11);
    expect(ada.months.length).toBeGreaterThan(0);
    const { people } = await get<PeopleListing>("/people");
    const shown = people.filter((p) => p.archived === null);
    expect(report.people.map((p) => p.id).sort()).toEqual(shown.map((p) => p.id).sort());
    expect(report.archivedCount).toBe(people.length - shown.length);
    expect(report.archivedCount).toBeGreaterThan(0);
    expect(report.groups.length).toBeGreaterThan(0);
    // Groups still name everyone in them, the archived too, so a group keeps its real size.
    const ids = new Set(people.map((p) => p.id));
    for (const group of report.groups) for (const id of group.memberIds) expect(ids.has(id)).toBe(true);
  });

  it("serves everyone, archived people too, as one light row each for the Table view", async () => {
    const { people } = await get<PeopleListing>("/people");
    const rows = await get<TableRow[]>("/table-rows");
    expect(rows.map((p) => p.id).sort()).toEqual(people.map((p) => p.id).sort());
    expect(rows.some((p) => p.archived !== null)).toBe(true);
    // Everyone archived carries "archive", the captain's or the rules' alike: one archive. For the rules' it is worked
    // out from the rule, never stored; nobody carries "system-archive".
    for (const row of rows) {
      expect(row.tags.includes("archive")).toBe(row.archived !== null);
      expect(row.tags).not.toContain("system-archive");
      expect(people.find((p) => p.id === row.id)!.tags.includes("archive")).toBe(row.archived === "you");
    }
    expect(rows.some((p) => p.archived !== null && p.archived !== "you")).toBe(true);
    const ada = rows.find((p) => p.name === "Ada Sample")!;
    expect(ada).toMatchObject({ aliases: ["Addy"], tags: ["climbing"], platforms: ["messenger"], directMessageCount: 11 });
    expect(ada.byPlatform).toEqual([
      { platform: "messenger", messageCount: ada.messageCount, directMessageCount: 11, groupMessageCount: ada.groupMessageCount, lastMessageAt: ada.lastMessageAt },
    ]);
    expect(ada).not.toHaveProperty("accounts");
    expect(ada).not.toHaveProperty("totals");
    // Closeness is friend-map's to add (server/methodology.ts).
    expect(ada).not.toHaveProperty("closeness");
    // Someone added by hand, with no messages, is a row too.
    expect(rows.find((p) => p.name === "Felix Demo")).toMatchObject({ platforms: [], byPlatform: [], messageCount: 0 });
  });

  it("never returns message text on any structure route", async () => {
    const texts = THREADS.flatMap((t) => t.messages.map((m) => m.text)).filter((text) => text.length > 3);
    const listing = await get<PeopleListing>("/people");
    const bodies = [
      JSON.stringify(listing),
      JSON.stringify(await get("/merge-proposals")),
      JSON.stringify(await get("/coverage")),
      JSON.stringify(await get("/connectors")),
      JSON.stringify(await get("/relationships")),
      JSON.stringify(await get("/table-rows")),
      JSON.stringify(await get("/score-report")),
      ...(await Promise.all(listing.people.map((p) => get(`/people/${p.id}`)))).map((p) => JSON.stringify(p)),
      ...(await Promise.all(listing.people.map((p) => get<PersonGroup[]>(`/people/${p.id}/groups`)))).map((g) => JSON.stringify(g)),
    ];
    const groups = new Set(bodies.slice(-listing.people.length).flatMap((body) => (JSON.parse(body) as PersonGroup[]).map((g) => g.id)));
    expect(groups.size).toBeGreaterThan(0);
    for (const id of groups) bodies.push(JSON.stringify(await get(`/groups/${id}`)));
    // Every month and day of the Calendar.
    for (const month of await sampleMonths()) {
      const days = await get<CalendarMonth>(`/calendar/${month}`);
      bodies.push(JSON.stringify(days));
      for (const { day } of days.days) bodies.push(JSON.stringify(await get(`/calendar/${day}`)));
    }
    for (const text of texts) for (const body of bodies) expect(body).not.toContain(text);
  });

  it("serves the Calendar's months and days, and refuses anything else", async () => {
    const months = await sampleMonths();
    const month = await get<CalendarMonth>(`/calendar/${months[0]}`);
    expect(month.month).toBe(months[0]);
    expect(month.span.first?.slice(0, 7)).toBe(months[0]);
    expect(month.days.length).toBeGreaterThan(0);
    const counted = month.days[0].chats.reduce((n, c) => n + c.messages, 0);
    const day = await get<CalendarDay>(`/calendar/${month.days[0].day}`);
    expect(day.chats.reduce((n, c) => n + c.messages, 0)).toBe(counted);
    expect(new Set(day.people.map((p) => p.id))).toEqual(new Set(day.chats.flatMap((c) => c.people)));
    for (const wrong of ["2026-13", "2026-02-30", "soon", "2026-1"]) {
      const response = await fetch(`${base}/calendar/${wrong}`);
      expect(response.status, wrong).toBe(400);
    }
  });
});

/** Every month of the sample's messages, YYYY-MM. */
async function sampleMonths(): Promise<string[]> {
  const { first, last } = archive.db.prepare("SELECT min(sent_at) AS first, max(sent_at) AS last FROM message").get() as { first: number; last: number };
  return monthRange(monthKey(first), monthKey(last));
}

/** The first attachment of a type in a person's timeline. */
async function attachmentOf(name: string, type: string) {
  const person = await named(name);
  const page = await get<TimelinePage>(`/content/people/${person.id}/timeline?limit=200&groups=1`);
  const attachment = page.messages.flatMap((m) => m.attachments).find((a) => a.type === type);
  if (!attachment) throw new Error(`${name} has no ${type}`);
  return attachment;
}

describe("content", () => {
  it("gives a person's one-to-one messages unless asked for their group ones too", async () => {
    const { people } = await get<PeopleListing>("/people");
    const timeline = async (person: PersonSummary, groups: boolean) =>
      (await get<TimelinePage>(`/content/people/${person.id}/timeline?limit=200${groups ? "&groups=1" : ""}`)).messages;
    const ada = await named("Ada Sample");
    expect(ada.directMessageCount).toBeGreaterThan(0);
    expect(await timeline(ada, false)).toHaveLength(ada.directMessageCount);
    const inGroups = people.find((p) => p.groupMessageCount > 0)!;
    const direct = await timeline(inGroups, false);
    expect(direct).toHaveLength(inGroups.directMessageCount);
    expect(direct.every((m) => m.conversation.type === "direct")).toBe(true);
    const all = await timeline(inGroups, true);
    expect(all).toHaveLength(inGroups.messageCount);
    expect(all.filter((m) => m.conversation.type === "group")).toHaveLength(inGroups.groupMessageCount);
  });

  it("pages a friend's timeline newest first, across group and direct chats", async () => {
    const ada = await named("Ada Sample");
    const first = await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=3&groups=1`);
    expect(first.messages.map((m) => m.text)).toEqual(["Dinner at mine next week?", null, "https://example.com/route-guide"]);
    expect(first.messages[0].reactions).toEqual([{ emoji: "❤️", actor: "Riley Self" }]);
    expect(first.messages[1]).toMatchObject({ unsent: true, fromSelf: false });
    const second = await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=50&groups=1&before=${first.nextBefore}`);
    expect(second.nextBefore).toBeNull();
    expect(second.messages).toHaveLength(ada.messageCount - 3);
    expect(second.messages.find((m) => m.type === "media" && m.fromSelf)?.attachments).toEqual([
      { id: expect.any(Number), type: "video", mime: "video/mp4", size: null, missing: true, like: null },
    ]);
  });

  it("says how many messages a timeline has when asked, and pages past search's limit", async () => {
    const ada = await named("Ada Sample");
    const counted = await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=2&groups=1&count=1`);
    expect(counted.total).toBe(ada.messageCount);
    expect(counted.messages).toHaveLength(2);
    const later = await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=2&groups=1&count=1&before=${counted.nextBefore}`);
    expect(later.total).toBe(ada.messageCount);
    expect((await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=2&groups=1`)).total).toBeUndefined();
  });

  it("pages a timeline and a chat from a moment both ways: before= older, after= newer, with nextAfter", async () => {
    const ada = await named("Ada Sample");
    const all = (await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=200&groups=1`)).messages;
    expect(all.length).toBeGreaterThan(4);
    // A moment between two messages (as a hangout or call sits), as <ms>:0: everything at it or after is newer.
    const moment = all[2].sentAt;
    const older = all.filter((m) => m.sentAt < moment);
    const newer = all.filter((m) => m.sentAt >= moment);
    const back = await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=200&groups=1&before=${moment}:0`);
    expect(back.messages.map((m) => m.id)).toEqual(older.map((m) => m.id));
    expect(back.nextAfter).toBeUndefined();
    const on = await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=1&groups=1&count=1&after=${moment}:0`);
    // The oldest newer message, newest first like any page, with where the next newer page starts and no older one.
    expect(on.messages.map((m) => m.id)).toEqual([newer.at(-1)!.id]);
    expect(on.total).toBe(ada.messageCount);
    expect(on.nextBefore).toBeNull();
    expect(on.nextAfter).toBe(`${newer.at(-1)!.sentAt}:${newer.at(-1)!.id}`);
    const rest = await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=200&groups=1&after=${on.nextAfter}`);
    expect(rest.messages.map((m) => m.id)).toEqual(newer.slice(0, -1).map((m) => m.id));
    expect(rest.nextAfter).toBeNull();
    // A chat pages the same way.
    const chat = all[0].conversation.id;
    const chatAll = (await get<TimelinePage>(`/content/conversations/${chat}/messages?limit=200`)).messages;
    const chatOn = await get<TimelinePage>(`/content/conversations/${chat}/messages?limit=200&after=${chatAll.at(-1)!.sentAt}:0`);
    expect(chatOn.messages.map((m) => m.id)).toEqual(chatAll.map((m) => m.id));
    expect(chatOn.nextAfter).toBeNull();
    // A page starts at one end.
    expect((await fetch(`${base}/content/people/${ada.id}/timeline?before=${moment}:0&after=${moment}:0`)).status).toBe(400);
    expect((await fetch(`${base}/content/conversations/${chat}/messages?before=${moment}:0&after=${moment}:0`)).status).toBe(400);
  });

  it("gives one account's own messages with account=, and 404 for an account that is not theirs", async () => {
    const ada = await named("Ada Sample");
    // Their one account is all of them; the demo's archive test checks a person with several, beside this server.
    expect(ada.accounts).toHaveLength(1);
    const [account] = ada.accounts;
    const all = await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=200&groups=1&count=1`);
    const own = await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=200&groups=1&count=1&account=${account.id}`);
    expect(own.total).toBe(account.messageCount);
    expect(own.messages.map((m) => m.id)).toEqual(all.messages.map((m) => m.id));
    const someoneElse = (await get<PeopleListing>("/people")).people.find((p) => p.id !== ada.id && p.accounts.length > 0)!.accounts[0];
    const refused = await fetch(`${base}/content/people/${ada.id}/timeline?account=${someoneElse.id}`);
    expect(refused.status).toBe(404);
    expect((await fetch(`${base}/content/people/${ada.id}/timeline?account=first`)).status).toBe(400);
  });

  it("gives one chat's messages on a Calendar day, oldest first, a page at a time, and 400 for what is not a day", async () => {
    const month = await get<CalendarMonth>(`/calendar/${(await sampleMonths()).at(-1)}`);
    const busiest = month.days.flatMap((d) => d.chats.map((c) => ({ day: d.day, ...c }))).sort((a, b) => b.messages - a.messages)[0];
    const all = await get<DayMessagesPage>(`/content/conversations/${busiest.chat}/days/${busiest.day}?limit=5000`);
    expect(all.messages.length).toBe(busiest.messages);
    expect(all.nextAfter).toBeNull();
    expect(all.messages.every((m, i) => i === 0 || m.sentAt >= all.messages[i - 1].sentAt)).toBe(true);
    expect(all.messages.every((m) => dayKey(m.sentAt) === busiest.day && m.conversation.id === busiest.chat)).toBe(true);
    if (busiest.messages > 1) {
      const first = await get<DayMessagesPage>(`/content/conversations/${busiest.chat}/days/${busiest.day}?limit=1`);
      expect(first.messages.map((m) => m.id)).toEqual([all.messages[0].id]);
      const next = await get<DayMessagesPage>(`/content/conversations/${busiest.chat}/days/${busiest.day}?limit=5000&after=${encodeURIComponent(first.nextAfter!)}`);
      expect(next.messages.map((m) => m.id)).toEqual(all.messages.slice(1).map((m) => m.id));
    }
    expect((await fetch(`${base}/content/conversations/${busiest.chat}/days/tomorrow`)).status).toBe(400);
  });

  it("opens a group chat: its header from /groups/:id, its messages newest first, counted when asked", async () => {
    const ada = await named("Ada Sample");
    const [first] = await get<PersonGroup[]>(`/people/${ada.id}/groups`);
    const group = await get<GroupChat>(`/groups/${first.id}`);
    expect(group).toMatchObject({ id: first.id, title: first.title, platform: "messenger", people: first.people, fromMe: first.fromMe });
    // Everyone in it but the captain, Ada among them, with what each sent there adding up to everything but the captain's.
    expect(group.members.map((m) => m.id)).toContain(ada.id);
    expect(group.members.find((m) => m.id === ada.id)!.messages).toBe(first.fromThem);
    expect(group.members.reduce((n, m) => n + m.messages, 0) + group.fromMe).toBe(group.messageCount);
    for (let i = 1; i < group.members.length; i++) expect(group.members[i - 1].messages).toBeGreaterThanOrEqual(group.members[i].messages);
    const page = await get<TimelinePage>(`/content/conversations/${first.id}/messages?limit=2&count=1`);
    expect(page.total).toBe(group.messageCount);
    expect(page.messages[0].sentAt).toBe(group.lastMessageAt);
    expect(page.messages.every((m) => m.conversation.id === first.id)).toBe(true);
    expect((await get<TimelinePage>(`/content/conversations/${first.id}/messages?limit=2`)).total).toBeUndefined();
  });

  it("answers 404 for a group chat that is a direct chat, or none", async () => {
    const ada = await named("Ada Sample");
    const direct = (await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=1`)).messages[0].conversation;
    expect(direct.type).toBe("direct");
    expect((await fetch(`${base}/groups/${direct.id}`)).status).toBe(404);
    expect((await fetch(`${base}/groups/999999`)).status).toBe(404);
  });

  it("searches message text", async () => {
    const hits = await get<SearchHit[]>(`/content/search?q=${encodeURIComponent("rope")}`);
    expect(hits.map((h) => h.snippet)).toEqual(["Sunday works. I'll bring the [rope]."]);
    expect(await get<SearchHit[]>("/content/search?q=")).toEqual([]);
    expect(await get<SearchHit[]>(`/content/search?q=${encodeURIComponent('"(')}`)).toEqual([]);
  });

  it("serves an attachment's file by id, with byte ranges", async () => {
    const photo = await attachmentOf("Ada Sample", "image");
    const url = `${base}/content/attachments/${photo.id}`;
    const bytes = "placeholder bytes: not an image (5)"; // burst_2.jpeg, her newest photo

    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect(Object.fromEntries(["content-type", "content-length", "accept-ranges", "content-disposition", "x-content-type-options"]
      .map((name) => [name, whole.headers.get(name)]))).toEqual({
      "content-type": "image/jpeg", "content-length": String(bytes.length), "accept-ranges": "bytes",
      "content-disposition": "inline", "x-content-type-options": "nosniff",
    });
    expect(await whole.text()).toBe(bytes);

    const part = await fetch(url, { headers: { range: "bytes=0-10" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-10/${bytes.length}`);
    expect(await part.text()).toBe(bytes.slice(0, 11));
    const tail = await fetch(url, { headers: { range: "bytes=-3" } });
    expect([tail.status, await tail.text()]).toEqual([206, "(5)"]);
    const outside = await fetch(url, { headers: { range: `bytes=${bytes.length}-` } });
    expect([outside.status, outside.headers.get("content-range")]).toEqual([416, `bytes */${bytes.length}`]);

    const head = await fetch(url, { method: "HEAD" });
    expect([head.status, head.headers.get("content-length"), await head.text()]).toEqual([200, String(bytes.length), ""]);
    // Hana, renamed above.
    const audio = await fetch(`${base}/content/attachments/${(await attachmentOf("Hana Newface-Smith", "audio")).id}`);
    expect(audio.headers.get("content-type")).toBe("audio/ogg");
  });

  it("keeps every read in the trail of content reads, as the app's, and nothing that read nothing", async () => {
    const ada = await named("Ada Sample");
    const photo = await attachmentOf("Ada Sample", "image");
    const { conversation_id: photoChat } = archive.db
      .prepare("SELECT m.conversation_id FROM attachment a JOIN message m ON m.id = a.message_id WHERE a.id = ?")
      .get(photo.id) as { conversation_id: number };
    // The trail is the core's, in the calendar's file (archive/contentLog.ts).
    archive.calendarDb.exec("DELETE FROM content_read");
    const trail = () => archive.contentLog.list().map(({ surface, reader, what, scope, reads, why }) => ({ surface, reader, what, scope, reads, why }));

    // A timeline read a page at a time is one read, many times.
    const first = await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=2&groups=1`);
    await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=2&groups=1&before=${first.nextBefore}`);
    // Opened at a moment (the Table's When): the page after it is a read like any other.
    await get<TimelinePage>(`/content/people/${ada.id}/timeline?limit=2&groups=1&after=${first.messages[1].sentAt}:0`);
    const chat = first.messages[0].conversation.id;
    const day = dayKey(first.messages[0].sentAt);
    await get<TimelinePage>(`/content/conversations/${chat}/messages?limit=1`);
    await get<TimelinePage>(`/content/conversations/${chat}/messages?limit=1&after=${first.messages[0].sentAt}:0`);
    await get<DayMessagesPage>(`/content/conversations/${chat}/days/${day}`);
    // A search that finds nothing has still read: that nothing matches is content.
    expect(await get<SearchHit[]>(`/content/search?q=nothing-says-this&person=${ada.id}`)).toEqual([]);
    // A file by its chat, each GET of it, but not HEAD, which sends none of it.
    await (await fetch(`${base}/content/attachments/${photo.id}`)).text();
    await (await fetch(`${base}/content/attachments/${photo.id}`, { headers: { range: "bytes=0-3" } })).text();
    await fetch(`${base}/content/attachments/${photo.id}`, { method: "HEAD" });
    // Nothing read, nothing kept.
    expect((await fetch(`${base}/content/people/999999/timeline`)).status).toBe(404);
    expect((await fetch(`${base}/content/people/${ada.id}/timeline?before=1:0&after=1:0`)).status).toBe(400);
    expect((await fetch(`${base}/content/attachments/999999`)).status).toBe(404);

    const app = { surface: "app", reader: null, why: null };
    expect(trail()).toEqual([
      { ...app, what: "attachments", scope: { conversation: photoChat }, reads: 2 },
      { ...app, what: "search", scope: { words: "nothing-says-this", person: ada.id }, reads: 1 },
      { ...app, what: "day", scope: { conversation: chat, day }, reads: 1 },
      { ...app, what: "conversation", scope: { conversation: chat }, reads: 2 },
      { ...app, what: "timeline", scope: { person: ada.id, groups: true }, reads: 3 },
    ]);
  });

  it("answers 404 for an attachment without a file, and never serves a file outside the media folders", async () => {
    const video = await attachmentOf("Ada Sample", "video");
    expect(video.missing).toBe(true);
    expect((await fetch(`${base}/content/attachments/${video.id}`)).status).toBe(404);
    expect((await fetch(`${base}/content/attachments/999999`)).status).toBe(404);
    expect((await fetch(`${base}/content/attachments/..%2F..%2Farchive.sqlite`)).status).toBe(404);
    expect((await fetch(`${base}/content/attachments/1`, { method: "DELETE" })).status).toBe(404);

    // A stored path that climbs out, or a symlink inside that points out, is refused.
    const secret = join(dataDir, "secret.txt");
    await writeFile(secret, "not media");
    const media = join(dataDir, "archive", "media");
    await mkdir(join(media, "elsewhere"), { recursive: true });
    await symlink(secret, join(media, "elsewhere", "link.jpeg"));
    for (const localPath of [
      "../secret.txt", secret, "secret.txt", "archive.sqlite", "archive/media/elsewhere/link.jpeg", "archive/media/../../secret.txt",
      "platform-exports/../secret.txt", "", ".", "archive/media", "platform-exports",
    ]) {
      archive.db.prepare("UPDATE attachment SET local_path = ? WHERE id = ?").run(localPath, video.id);
      expect((await fetch(`${base}/content/attachments/${video.id}`)).status, localPath).toBe(404);
    }

    // A type the page must not render in place is only offered as a download.
    await writeFile(join(media, "elsewhere", "page.html"), "<script>alert(1)</script>");
    archive.db.prepare("UPDATE attachment SET local_path = ?, mime = ? WHERE id = ?").run("archive/media/elsewhere/page.html", "text/html", video.id);
    const page = await fetch(`${base}/content/attachments/${video.id}`);
    expect([page.status, page.headers.get("content-type"), page.headers.get("content-disposition")])
      .toEqual([200, "application/octet-stream", "attachment"]);

    // A file kept in place in an unpacked export is served from there.
    const unpacked = join(dataDir, "platform-exports", "instagram", "2026-10-05", "photos");
    await mkdir(unpacked, { recursive: true });
    await writeFile(join(unpacked, "1.jpg"), "not really a jpeg");
    archive.db.prepare("UPDATE attachment SET local_path = ?, mime = 'image/jpeg' WHERE id = ?").run("platform-exports/instagram/2026-10-05/photos/1.jpg", video.id);
    const kept = await fetch(`${base}/content/attachments/${video.id}`);
    expect([kept.status, await kept.text()]).toEqual([200, "not really a jpeg"]);
    archive.db.prepare("UPDATE attachment SET local_path = NULL, mime = 'video/mp4' WHERE id = ?").run(video.id);
  });

  it("answers 503 on every route when the archive could not be opened", async () => {
    const handler = archiveHandler(new Error("disk full"));
    const broken = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${(broken.address() as AddressInfo).port}/api/archive/people`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "the archive is not available: disk full" });
    await new Promise((resolve) => broken.close(resolve));
  });
});
