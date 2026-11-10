// The facts the demo's shape is worked out from, over a made-up crowd's archive: counts that match what the app
// says of it, and nothing but counts, times and ids (no name, title, tag or message).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, type MapFacts, transaction } from "../../../sdk/server.ts";
import { makeCrowd } from "../fixtures/crowd.ts";
import { addSamplePeople } from "../fixtures/samplePeople.ts";
import { openArchive } from "./db.ts";
import { People } from "./people.ts";
import { ArchiveStructure } from "./structure.ts";
import { ImportSession } from "./write.ts";

const NOW = Date.parse("2026-03-15T12:00:00+11:00");
let dataDir: string;
let db: Db;
let facts: MapFacts;
let shownIds: number[];
let groups: number;
let caller: number;
let crowdWords: Set<string>;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-map-facts-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  const people = new People(db);
  const structure = new ArchiveStructure(db, people);
  const crowd = makeCrowd(NOW);
  transaction(db, () => {
    const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'crowd', 'export', 'crowd', 0, 'ok')").run().lastInsertRowid);
    const session = new ImportSession(db, "messenger", source, "export");
    for (const event of crowd.events) session.apply(event);
    // Two calls in the first one-to-one chat, one answered for ten minutes and one never answered.
    const chat = crowd.events.flatMap((e) => (e.kind === "conversation" && e.type === "direct" ? [e] : []))[0]!;
    const self = crowd.events.flatMap((e) => (e.kind === "account" && e.isSelf ? [e.key] : []))[0];
    const them = chat.members.find((m) => m !== self)!;
    for (const [n, seconds] of [[1, 600], [2, 0]]) {
      session.apply({ kind: "message", id: `call-${n}`, idKind: "platform", conversation: chat.id, sender: them, isFromSelf: false, sentAt: NOW - n * 86_400_000, type: "call", callSeconds: seconds, raw: {} });
    }
  });
  people.runRules();
  addSamplePeople({ db, people, structure } as Parameters<typeof addSamplePeople>[0], crowd.people);
  caller = (db.prepare("SELECT ip.person_id AS id FROM message m JOIN import_person ip ON ip.id = m.sender_account_id WHERE m.type = 'call'").get() as { id: number }).id;
  shownIds = structure.listPeople().people.filter((person) => person.archived === null).map((person) => person.id).sort((a, b) => a - b);
  groups = (db.prepare("SELECT count(*) AS n FROM conversation WHERE type = 'group' AND is_marketplace = 0").get() as { n: number }).n;
  crowdWords = new Set(crowd.events.flatMap((e) => ("displayName" in e && typeof e.displayName === "string" ? e.displayName.split(/\s+/) : [])));
  facts = structure.mapFacts();
});

afterAll(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the map's facts", () => {
  it("are of the people the app shows, archived ones counted by why, and of every group chat", () => {
    expect(facts.people.map((person) => person.id).sort((a, b) => a - b)).toEqual(shownIds);
    expect(facts.archived).toEqual({ byHand: 4, byRule: expect.objectContaining({ unknown: 3, marketplace: 3 }) });
    expect(facts.groups).toHaveLength(groups);
    expect(facts.groups.every((group) => group.shown <= group.size)).toBe(true);
    expect(facts.groupMessages.length).toBeLessThanOrEqual(groups);
    expect(facts.groupMessages.every((group) => group.mine <= group.messages && group.first <= group.last)).toBe(true);
    expect(Object.keys(facts.platformMessages)).toEqual(["messenger"]);
  });

  it("give each person their counts, and what the map's report counts of them", () => {
    expect(facts.people.every((person) => person.platforms.join() === "messenger")).toBe(true);
    expect(facts.people.every((person) => person.messages >= person.youDirect + person.theyDirect)).toBe(true);
    expect(facts.people.filter((person) => person.report).length).toBeGreaterThan(facts.people.length / 2);
    expect(facts.people.reduce((n, person) => n + (person.report?.reactions.fromThem ?? 0), 0)).toBeGreaterThan(0);
    expect(facts.people.some((person) => person.groups > 0)).toBe(true);
    expect(facts.tagPeople.length).toBeGreaterThan(2);
  });

  it("give the months with messages, oldest first, and the calls with whom", () => {
    expect(facts.months[0]!.month).toBe("2024-02");
    expect(facts.months.map((m) => m.month)).toEqual([...facts.months.map((m) => m.month)].sort());
    expect(facts.calls.map(({ personId, answered, durationSeconds }) => ({ personId, answered, durationSeconds })).sort((a, b) => Number(b.answered) - Number(a.answered)))
      .toEqual([{ personId: caller, answered: true, durationSeconds: 600 }, { personId: caller, answered: false, durationSeconds: 0 }]);
  });

  it("hold nothing but counts, times and ids: no name, title, tag or message of the crowd", () => {
    const text = JSON.stringify(facts);
    const strings = [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]!).filter((s) => /[a-z]/i.test(s));
    // Keys, the platform and the archive rules only.
    const allowed = /^(people|id|messages|youDirect|theyDirect|lastMessageAt|platforms|tags|groups|located|reachOut|report|firstMessageAt|reactions|fromMe|fromThem|openings|byMe|byThem|archived|byHand|byRule|platformMessages|locations|size|titled|shown|groupMessages|mine|first|last|months|month|count|calls|personId|at|answered|durationSeconds|tagPeople|messenger|unknown|no-name|marketplace|they-only|you-only|groups-wrote|groups-silent|no-messages)$/;
    expect(strings.filter((s) => !allowed.test(s) && !/^\d{4}-\d{2}$/.test(s))).toEqual([]);
    expect([...crowdWords].filter((word) => word.length > 3 && text.includes(word))).toEqual([]);
  });
});
