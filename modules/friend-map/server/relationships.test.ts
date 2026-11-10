import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveEvent, type Db, type MessageEvent, transaction } from "../../../sdk/server.ts";
import { openArchive } from "./db.ts";
import { People } from "./people.ts";
import { ArchiveStructure } from "./structure.ts";
import { ImportSession } from "./write.ts";

let dataDir: string;
let db: Db;
let people: People;
let structure: ArchiveStructure;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-relationships-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  people = new People(db);
  structure = new ArchiveStructure(db, people);
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const DAY = 86_400_000;
/** Noon in Melbourne on a date, so months never straddle the time zone. */
const day = (date: string) => Date.parse(`${date}T12:00:00+10:00`);
const SECRET = "SECRET-MESSAGE-TEXT";

function importEvents(events: ArchiveEvent[], platform = "messenger"): void {
  transaction(db, () => {
    const source = Number(
      db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')")
        .run(platform).lastInsertRowid,
    );
    const session = new ImportSession(db, platform, source, "export");
    for (const event of events) session.apply(event);
  });
}

let nextId = 0;
function message(conversation: string, sender: string, sentAt: number): ArchiveEvent {
  return {
    kind: "message", id: `m${nextId++}`, idKind: "platform", conversation, sender, isFromSelf: sender === "Me",
    sentAt, type: "text", text: `${SECRET} ${nextId}`, raw: { text: SECRET },
  };
}

/**
 * Me, Ada, Bea and Cy. Ada and I talk directly across two months with a
 * 20-day quiet stretch she ends and a 30-day one I end; Ada, Bea and I share
 * a group; Cy is only in a group with me; one "Facebook user" chat.
 */
function importSample(): void {
  const account = (name: string, isSelf = false): ArchiveEvent =>
    ({ kind: "account", key: name, keyKind: "name", displayName: name, isSelf });
  importEvents([
    account("Me", true), account("Ada"), account("Bea"), account("Cy"), account("Facebook user"),
    { kind: "conversation", id: "ada", type: "direct", title: "Ada", members: ["Me", "Ada"] },
    { kind: "conversation", id: "climbers", type: "group", title: `${SECRET} group`, members: ["Me", "Ada", "Bea"] },
    { kind: "conversation", id: "cy-group", type: "group", title: "Cy group", members: ["Me", "Cy"] },
    { kind: "conversation", id: "fb", type: "direct", title: "Facebook user", members: ["Me", "Facebook user"] },
    message("ada", "Ada", day("2026-01-01")),                  // first ever: not a reopening
    message("ada", "Me", day("2026-01-02")),
    message("ada", "Ada", day("2026-01-22")),                  // 20 quiet days, reopened by Ada
    message("ada", "Me", day("2026-02-21")),                   // 30 quiet days, reopened by me
    message("ada", "Ada", day("2026-02-21") + 60_000),
    message("climbers", "Ada", day("2026-02-01")),
    message("climbers", "Bea", day("2026-02-02")),
    message("climbers", "Bea", day("2026-02-03")),
    message("climbers", "Me", day("2026-02-04")),
    message("cy-group", "Me", day("2026-03-01")),
    message("fb", "Facebook user", day("2026-03-02")),
    // Ada reacts to my message; I react to hers and to Bea's in the group; Bea reacts to Ada's (not to me).
    { kind: "reaction", message: "m1", actor: "Ada", emoji: "👍" },
    { kind: "reaction", message: "m2", actor: "Me", emoji: "❤️" },
    { kind: "reaction", message: "m6", actor: "Me", emoji: "😂" },
    { kind: "reaction", message: "m5", actor: "Bea", emoji: "😂" },
  ]);
}

describe("relationships", () => {
  it("counts each person's messages by sender, month, reaction and reopening", async () => {
    nextId = 0;
    importSample();
    people.runRules();
    const report = structure.relationships(day("2026-04-01"));
    const byName = new Map(report.people.map((p) => [p.name, p]));
    expect(report.gapDays).toBe(14);
    expect(report.generatedAt).toBe(day("2026-04-01"));

    const ada = byName.get("Ada")!;
    expect(ada.totals).toEqual({ directFromMe: 2, directFromThem: 3, directFromMeSelfOnly: 0, groupFromMe: 1, groupFromThem: 1 });
    expect(ada.months).toEqual([
      { month: "2026-01", directFromMe: 1, directFromThem: 2, directFromMeSelfOnly: 0, groupFromMe: 0, groupFromThem: 0 },
      { month: "2026-02", directFromMe: 1, directFromThem: 1, directFromMeSelfOnly: 0, groupFromMe: 1, groupFromThem: 1 },
    ]);
    expect(ada.firstMessageAt).toBe(day("2026-01-01"));
    expect(ada.lastMessageAt).toBe(day("2026-02-21") + 60_000);
    expect(ada.openings).toEqual({ byMe: 1, byThem: 1 });
    expect(ada.reactions).toEqual({ fromMe: 1, fromThem: 1 });

    const bea = byName.get("Bea")!;
    expect(bea.totals).toEqual({ directFromMe: 0, directFromThem: 0, directFromMeSelfOnly: 0, groupFromMe: 1, groupFromThem: 2 });
    expect(bea.reactions).toEqual({ fromMe: 1, fromThem: 0 });
    expect(bea.openings).toEqual({ byMe: 0, byThem: 0 });
    expect(bea.lastMessageAt).toBe(day("2026-02-03"));

    // What I say to a group counts for its members but doesn't date the relationship.
    const cy = byName.get("Cy")!;
    expect(cy.totals).toEqual({ directFromMe: 0, directFromThem: 0, directFromMeSelfOnly: 0, groupFromMe: 1, groupFromThem: 0 });
    expect(cy.firstMessageAt).toBeNull();
    expect(cy.lastMessageAt).toBeNull();

    // The "Facebook user" is archived (an unknown account): only counted. Kept, they are shown, marked unknown.
    expect(byName.has("Facebook user")).toBe(false);
    expect(report.archivedCount).toBe(1);
    expect(ada.unknown).toBe(false);
    expect(report.people.some((p) => p.name === "Me")).toBe(false);
    people.setTags(structure.listPeople().people.find((p) => p.name === "Facebook user")!.id, ["keep"]);
    const kept = structure.relationships();
    expect(kept.people.find((p) => p.name === "Facebook user")!.unknown).toBe(true);
    expect(kept.archivedCount).toBe(0);
  });

  it("counts each person's messages by app and month as the map views do, apart from the map's report", async () => {
    nextId = 0;
    importSample();
    // Ada on WhatsApp too, joined to her Messenger self by hand.
    importEvents([
      { kind: "account", key: "Me", keyKind: "name", displayName: "Me", isSelf: true },
      { kind: "account", key: "Ada", keyKind: "name", displayName: "Ada", isSelf: false },
      { kind: "conversation", id: "ada-wa", type: "direct", title: "Ada", members: ["Me", "Ada"] },
      message("ada-wa", "Ada", day("2026-03-05")),
      message("ada-wa", "Me", day("2026-03-06")),
    ], "whatsapp");
    people.runRules();
    const listed = structure.listPeople().people.filter((p) => p.name === "Ada");
    if (listed.length > 1) people.merge(listed[0].id, listed[1].id);
    const report = structure.relationships();
    const id = (name: string) => report.people.find((p) => p.name === name)?.id;
    const apps = structure.messageApps();
    // Direct both ways and theirs in groups: what I say to a group is not counted, so Cy, with only that, has none.
    expect(apps.find((a) => a.id === id("Ada"))?.apps).toEqual([
      { platform: "messenger", months: [{ month: "2026-01", messages: 3 }, { month: "2026-02", messages: 3 }] },
      { platform: "whatsapp", months: [{ month: "2026-03", messages: 2 }] },
    ]);
    expect(apps.find((a) => a.id === id("Bea"))?.apps).toEqual([{ platform: "messenger", months: [{ month: "2026-02", messages: 2 }] }]);
    expect(apps.some((a) => a.id === id("Cy"))).toBe(false);
    // The same totals as the map's series, app by app.
    const ada = report.people.find((p) => p.name === "Ada")!;
    const series = ada.months.reduce((sum, m) => sum + m.directFromMe + m.directFromThem + m.groupFromThem, 0);
    expect(apps.find((a) => a.id === ada.id)!.apps.flatMap((a) => a.months).reduce((sum, m) => sum + m.messages, 0)).toBe(series);
    // Never in the map's report.
    expect(JSON.stringify(report)).not.toContain("whatsapp\",\"months");
    expect(Object.keys(report)).not.toContain("apps");
  });

  it("lists group chats as the people in them and who wrote how much each month, without titles", async () => {
    nextId = 0;
    importSample();
    people.runRules();
    const report = structure.relationships();
    const id = (name: string) => report.people.find((p) => p.name === name)!.id;
    expect(report.groups).toEqual([
      {
        id: expect.any(Number), memberIds: [id("Ada"), id("Bea")].sort((a, b) => a - b), selfOnly: false, messageCount: 4, lastMessageAt: day("2026-02-04"),
        months: [{
          month: "2026-02", messages: 4, fromMe: 1,
          fromMembers: [{ id: id("Ada"), count: 1 }, { id: id("Bea"), count: 2 }].sort((a, b) => a.id - b.id),
        }],
      },
      {
        id: expect.any(Number), memberIds: [id("Cy")], selfOnly: false, messageCount: 1, lastMessageAt: day("2026-03-01"),
        months: [{ month: "2026-03", messages: 1, fromMe: 1, fromMembers: [] }],
      },
    ]);
  });

  it("leaves Marketplace chats and system messages out of the group counts", async () => {
    nextId = 0;
    importEvents([
      { kind: "account", key: "Me", keyKind: "name", displayName: "Me", isSelf: true },
      { kind: "account", key: "Eve", keyKind: "name", displayName: "Eve" },
      { kind: "account", key: "Fin", keyKind: "name", displayName: "Fin" },
      { kind: "conversation", id: "pals", type: "group", members: ["Me", "Eve", "Fin"] },
      { kind: "conversation", id: "stall", type: "group", members: ["Me", "Eve", "Fin"], marketplace: true },
      message("pals", "Eve", day("2026-05-01")),
      { ...(message("pals", "Fin", day("2026-05-02")) as MessageEvent), type: "system" },
      message("stall", "Eve", day("2026-05-03")),
      message("stall", "Me", day("2026-05-03") + 60_000),
    ]);
    people.runRules();
    // The captain never wrote in "pals", so it keeps no one by the small-group rule: keep Eve to see her there.
    people.setTags(structure.listPeople().people.find((p) => p.name === "Eve")!.id, ["keep"]);
    const report = structure.relationships();
    const eve = report.people.find((p) => p.name === "Eve")!.id;
    expect(report.groups.map((g) => g.months)).toEqual([[{ month: "2026-05", messages: 1, fromMe: 0, fromMembers: [{ id: eve, count: 1 }] }]]);
  });

  it("follows the person table: names, tags, merges and old names of mine, the stored counts made again when links change", async () => {
    nextId = 0;
    importSample();
    people.runRules();
    const before = structure.relationships();
    const id = (name: string) => before.people.find((p) => p.name === name)!.id;
    const kept = people.merge(id("Ada"), id("Bea"));
    people.setName(kept, "Ada Lovelace");
    people.setAliases(kept, ["Lovelace"]);
    people.setTags(kept, ["hide"]);
    people.markAsMe(id("Cy"));
    const report = structure.relationships();
    // The "Facebook user" (archived) is only counted.
    expect(report.people.map((p) => p.name).sort()).toEqual(["Ada Lovelace"]);
    expect(report.archivedCount).toBe(1);
    const ada = report.people.find((p) => p.name === "Ada Lovelace")!;
    expect(ada).toMatchObject({ id: kept, aliases: ["Lovelace"], tags: ["hide"], platforms: ["messenger"] });
    // Ada and Bea as one person: both of their group messages, and the group has one member.
    expect(ada.totals).toEqual({ directFromMe: 2, directFromThem: 3, directFromMeSelfOnly: 0, groupFromMe: 1, groupFromThem: 3 });
    expect(report.groups.map((g) => g.memberIds)).toEqual([[ada.id]]);
  });

  it("never returns message text or group titles", async () => {
    nextId = 0;
    importSample();
    people.runRules();
    const json = JSON.stringify(structure.relationships());
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("Cy group");
  });

  it("gives Marketplace chats no closeness", async () => {
    nextId = 0;
    importEvents([
      { kind: "account", key: "Me", keyKind: "name", displayName: "Me", isSelf: true },
      { kind: "account", key: "Gus", keyKind: "name", displayName: "Gus" },
      { kind: "account", key: "Hal", keyKind: "name", displayName: "Hal" },
      { kind: "conversation", id: "gus", type: "direct", members: ["Me", "Gus"] },
      { kind: "conversation", id: "hal-bike", type: "direct", members: ["Me", "Hal"], marketplace: true },
      { kind: "conversation", id: "gus-lamp", type: "direct", members: ["Me", "Gus"], marketplace: true },
      message("gus", "Gus", day("2026-05-01")),
      ...Array.from({ length: 20 }, (_, i) => message("hal-bike", i % 2 ? "Me" : "Hal", day("2026-05-02") + i * 60_000)),
      ...Array.from({ length: 20 }, (_, i) => message("gus-lamp", i % 2 ? "Me" : "Gus", day("2026-05-02") + i * 60_000)),
    ]);
    people.runRules();
    // Both are archived by the rules (Gus only wrote, Hal only in Marketplace); "keep" puts them on the map.
    for (const p of structure.listPeople().people.filter((p) => p.name === "Gus" || p.name === "Hal")) await people.setTags(p.id, ["keep"]);
    const now = day("2026-05-20");
    const report = structure.relationships(now);
    const gus = report.people.find((p) => p.name === "Gus")!;
    const hal = report.people.find((p) => p.name === "Hal")!;
    // Gus's one direct message is all the closeness score is given of him; his Marketplace chat adds nothing, and
    // Hal's only chat is one, so the score has nothing of him.
    expect(gus.months).toEqual([{ month: "2026-05", directFromMe: 0, directFromThem: 1, directFromMeSelfOnly: 0, groupFromMe: 0, groupFromThem: 0 }]);
    expect(hal.months).toEqual([]);
    const scored = structure.scoreReport();
    expect(scored.people.find((p) => p.id === gus.id)!.months).toEqual(gus.months);
    expect(scored.people.find((p) => p.id === hal.id)!.months).toEqual([]);
  });

  it("counts the captain's messages where only his side is known apart, and marks such groups", async () => {
    nextId = 0;
    importEvents([
      { kind: "account", key: "Me", keyKind: "name", displayName: "Me", isSelf: true },
      { kind: "account", key: "Ivy", keyKind: "name", displayName: "Ivy" },
      { kind: "account", key: "Jo", keyKind: "name", displayName: "Jo" },
      { kind: "conversation", id: "ivy-one-sided", type: "direct", members: ["Me", "Ivy"], selfOnly: true },
      { kind: "conversation", id: "ivy", type: "direct", members: ["Me", "Ivy"] },
      { kind: "conversation", id: "trio", type: "group", members: ["Me", "Ivy", "Jo"], selfOnly: true },
      message("ivy-one-sided", "Me", day("2026-05-01")),
      message("ivy-one-sided", "Me", day("2026-05-02")),
      message("ivy", "Me", day("2026-05-03")),
      message("ivy", "Ivy", day("2026-05-04")),
      message("trio", "Me", day("2026-05-05")),
    ]);
    people.runRules();
    for (const p of structure.listPeople().people) await people.setTags(p.id, ["keep"]);
    const report = structure.relationships(day("2026-05-20"));
    const ivy = report.people.find((p) => p.name === "Ivy")!;
    // The real counts: three of mine, one of hers; two of mine where hers are not known.
    expect(ivy.totals).toEqual({ directFromMe: 3, directFromThem: 1, directFromMeSelfOnly: 2, groupFromMe: 1, groupFromThem: 0 });
    expect(report.groups.map((g) => g.selfOnly)).toEqual([true]);
  });

  it("counts a reopening only after the whole quiet stretch", async () => {
    nextId = 0;
    importEvents([
      { kind: "account", key: "Me", keyKind: "name", displayName: "Me", isSelf: true },
      { kind: "account", key: "Dee", keyKind: "name", displayName: "Dee" },
      { kind: "conversation", id: "dee", type: "direct", members: ["Me", "Dee"] },
      message("dee", "Me", day("2026-05-01")),
      message("dee", "Dee", day("2026-05-01") + 13 * DAY),
      message("dee", "Me", day("2026-05-01") + 27 * DAY),
    ]);
    people.runRules();
    const dee = structure.relationships().people.find((p) => p.name === "Dee")!;
    expect(dee.openings).toEqual({ byMe: 1, byThem: 0 });
  });
});
