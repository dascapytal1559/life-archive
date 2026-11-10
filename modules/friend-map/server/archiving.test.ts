import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveEvent, type Db, transaction } from "../../../sdk/server.ts";
import { isUnnamed } from "./archiving.ts";
import { ArchiveContent } from "./content.ts";
import { openArchive } from "./db.ts";
import { People } from "./people.ts";
import { ArchiveStructure } from "./structure.ts";
import { ImportSession } from "./write.ts";

let dataDir: string;
let db: Db;
let people: People;
let structure: ArchiveStructure;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-archiving-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  people = new People(db);
  structure = new ArchiveStructure(db, people);
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

type Chat = { id: string; type?: "direct" | "group"; marketplace?: boolean; members: string[]; from: string[] };

/** Imports chats on a platform: each `from` entry is one message by that account ("Me" is the captain). */
function importChats(chats: Chat[], platform = "messenger"): void {
  const names = new Set(["Me", ...chats.flatMap((c) => [...c.members, ...c.from])]);
  const events: ArchiveEvent[] = [...names].map((name) => ({
    kind: "account", key: name, keyKind: "name", displayName: name, ...(name === "Me" ? { isSelf: true } : {}),
  }));
  let n = 0;
  for (const chat of chats) {
    events.push({
      kind: "conversation", id: chat.id, type: chat.type ?? "direct", title: chat.id, members: ["Me", ...chat.members],
      ...(chat.marketplace ? { marketplace: true } : {}),
    });
    for (const sender of chat.from) {
      events.push({
        kind: "message", id: `${platform}-${chat.id}-${n}`, idKind: "platform", conversation: chat.id, sender,
        isFromSelf: sender === "Me", sentAt: 1_700_000_000_000 + n++ * 60_000, type: "text", text: `message ${n}`, raw: {},
      });
    }
  }
  importEvents(events, platform);
}

function importEvents(events: ArchiveEvent[], platform: string): void {
  transaction(db, () => {
    const source = Number(db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')")
      .run(platform).lastInsertRowid);
    const session = new ImportSession(db, platform, source, "export");
    for (const event of events) session.apply(event);
  });
}

/** `n` names: `prefix`1, `prefix`2 and so on. */
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
/** What `archived()` gives the `many` names of silent members of a big group. */
const silent = (prefix: string, n: number) => Object.fromEntries(many(prefix, n).map((name) => [name, "groups-silent"]));
const person = (name: string) => structure.listPeople().people.find((p) => p.name === name)!;
const archived = () => Object.fromEntries(structure.listPeople().people.map((p) => [p.name, p.archived]));

describe("automatic archive rules", () => {
  it("archive everyone without a direct chat where both of you wrote, by the first rule that fits", async () => {
    importChats([
      { id: "ada", members: ["Ada"], from: ["Ada", "Me"] },
      { id: "req", members: ["Rex"], from: ["Rex", "Rex"] },
      { id: "cold", members: ["Cal"], from: ["Me"] },
      { id: "empty", members: ["Eve"], from: [] },
      { id: "fb", members: ["Facebook user"], from: ["Facebook user", "Me"] },
      // Groups of thirteen with the captain: too big to keep anyone by the small-group rule.
      { id: "crew", type: "group", members: ["Ada", "Gus", "Sal", ...many("Crew", 9)], from: ["Gus"] },
      { id: "bike", marketplace: true, members: ["Nora"], from: ["Me", "Nora", "Me"] },
      // Marketplace doesn't make a two-way chat, and doesn't archive someone who has more than Marketplace.
      { id: "bike2", marketplace: true, members: ["Cal"], from: ["Cal"] },
    ]);
    importChats([{ id: "wa-group", type: "group", members: ["Wren", ...many("Crowd", 11)], from: [] }], "whatsapp");
    people.runRules();
    expect(archived()).toEqual({
      ...silent("Crew", 9),
      ...silent("Crowd", 11),
      Ada: null,
      Rex: "they-only",
      Cal: "you-only",
      Eve: "no-messages",
      "Facebook user": "unknown",
      Gus: "groups-wrote",
      Sal: "groups-silent",
      Nora: "marketplace",
      Wren: "groups-silent",
    });
    // Marketplace chats count in nothing but their own count.
    expect(person("Nora")).toMatchObject({ messageCount: 0, marketplaceMessageCount: 3, lastMessageAt: null, lastByPlatform: [] });
    expect(person("Cal")).toMatchObject({ directMessageCount: 1, marketplaceMessageCount: 1 });
  });

  it("keep people in a small group chat the captain wrote in, whether or not they wrote there", async () => {
    importChats([
      // Twelve people with the captain: small. Rex also has a one-way direct chat, which still archives him.
      { id: "twelve", type: "group", members: many("Twelve", 10).concat("Rex"), from: ["Twelve1", "Me"] },
      { id: "rex", members: ["Rex"], from: ["Rex"] },
      // Thirteen: too big. So is a group whose list has twelve, with one more who wrote and left.
      { id: "thirteen", type: "group", members: many("Big", 12), from: ["Big1", "Me"] },
      { id: "left", type: "group", members: many("Left", 11), from: ["Left1", "Gone", "Me"] },
      // Small, and the captain never wrote there (a spam group he was added to, say): it keeps no one, nor does a
      // small group nobody wrote in. Sid is also in a small group the captain wrote in, which keeps him.
      { id: "quiet", type: "group", members: ["Qin", "Quo", "Sid"], from: ["Qin", "Qin"] },
      { id: "hush", type: "group", members: ["Hal"], from: [] },
      { id: "sid", type: "group", members: ["Sid"], from: ["Me"] },
      // Small and silent, but the captain edited Ned and tagged Kip keep: both shown.
      { id: "edited", type: "group", members: ["Ned", "Kip"], from: ["Ned"] },
      // Big, and the captain never wrote there.
      { id: "loud", type: "group", members: many("Loud", 12), from: ["Loud1"] },
      // A deleted account counts as one person; it stays archived itself.
      { id: "unknown", type: "group", members: ["Una", "Facebook user"], from: ["Una", "Me"] },
      // Eleven listed and a deleted account make thirteen with the captain: too big.
      { id: "unknown-big", type: "group", members: many("Eleven", 11).concat("Facebook user"), from: ["Eleven1", "Me"] },
    ]);
    importChats([{ id: "wa-small", type: "group", members: ["Wren", "Wim"], from: ["Me"] }], "whatsapp");
    people.runRules();
    people.setTags(person("Twelve2").id, ["archive"]);
    people.setName(person("Ned").id, "Ned Sample");
    people.setTags(person("Kip").id, ["keep"]);
    expect(archived()).toMatchObject({
      Twelve1: null, Twelve3: null, Twelve10: null, Twelve2: "you", Rex: "they-only",
      Big1: "groups-wrote", Big2: "groups-silent", Left1: "groups-wrote", Gone: "groups-wrote", Left2: "groups-silent",
      Qin: "groups-wrote", Quo: "groups-silent", Sid: null, Hal: "groups-silent", "Ned Sample": null, Kip: null,
      Loud1: "groups-wrote", Loud2: "groups-silent",
      Una: null, "Facebook user": "unknown", Eleven1: "groups-wrote", Eleven2: "groups-silent",
      Wren: null, Wim: null,
    });
  });

  it("archive people known only by a number, an email, a short code or data kept as a name, unless kept or edited by the captain", async () => {
    // Accounts as the iMessage and WhatsApp connectors write them: keyed on a handle or JID,
    // shown by the handle when no name was found.
    const accounts: Array<{ platform: string; key: string; displayName: string; handle?: string }> = [
      { platform: "imessage", key: "+61491571266", displayName: "+61491571266", handle: "+61491571266" },
      { platform: "imessage", key: "sam@example.com", displayName: "sam@example.com", handle: "sam@example.com" },
      { platform: "imessage", key: "78787", displayName: "78787" },
      { platform: "imessage", key: "CommBank", displayName: "CommBank" },
      { platform: "imessage", key: "+61491571491", displayName: "Ada Lovelace", handle: "+61491571491" },
      { platform: "whatsapp", key: "61491571804@s.whatsapp.net", displayName: "Bo", handle: "+61491571804" },
      { platform: "whatsapp", key: "61491572549@s.whatsapp.net", displayName: "+61491572549", handle: "+61491572549" },
      { platform: "imessage", key: "+61491572665", displayName: "+61491572665", handle: "+61491572665" },
      { platform: "imessage", key: "+61491572983", displayName: "+61491572983", handle: "+61491572983" },
      // Named by the base64 protobuf message the iPhone WhatsApp app keeps in a name column, as the connector once did.
      { platform: "whatsapp", key: "61491573087@s.whatsapp.net", displayName: "CKDw3MYGIAA=", handle: "+61491573087" },
    ];
    for (const platform of ["imessage", "whatsapp"]) {
      const mine = accounts.filter((a) => a.platform === platform);
      const events: ArchiveEvent[] = [{ kind: "account", key: "Me", keyKind: "id", displayName: "Me", isSelf: true }];
      mine.forEach((a, i) => {
        events.push(
          { kind: "account", key: a.key, keyKind: "id", displayName: a.displayName, ...(a.handle ? { handle: a.handle } : {}) },
          { kind: "conversation", id: a.key, type: "direct", title: a.displayName, members: ["Me", a.key] },
          ...[a.key, "Me"].map((sender, j): ArchiveEvent => ({
            kind: "message", id: `${a.key}-${j}`, idKind: "platform", conversation: a.key, sender, isFromSelf: sender === "Me",
            sentAt: 1_700_000_000_000 + i * 60_000 + j, type: "text", text: "hi", raw: {},
          })),
        );
      });
      importEvents(events, platform);
    }
    people.runRules();
    people.setName(person("+61491572665").id, "+61491572665");
    people.setTags(person("+61491572983").id, ["keep"]);
    expect(archived()).toEqual({
      "+61491571266": "no-name",
      "sam@example.com": "no-name",
      "78787": "no-name",
      CommBank: "no-name",
      "Ada Lovelace": null,
      Bo: null,
      "+61491572549": "no-name",
      "+61491572665": null,
      "+61491572983": null,
      "CKDw3MYGIAA=": "no-name",
    });
    expect(person("+61491572983").archiveRule).toBe("no-name");
  });

  it("count a username on an internet chat platform as a name, but not a number, an email, a short code or a platform id", async () => {
    // Accounts as each connector writes them: keyed on the platform's user id, shown by the username
    // (and carrying it as the handle) when that is all it has, or by the id when it has nothing.
    const accounts: Array<{ platform: string; key: string; keyKind?: "id" | "name"; displayName: string; handle?: string; selfOnly?: boolean }> = [
      { platform: "discord", key: "100000000000000001", displayName: "ada.sample", handle: "ada.sample", selfOnly: true },
      { platform: "telegram", key: "telegram:200000001", displayName: "bruno_sample" },
      { platform: "x", key: "300000001", displayName: "@cleo_sample", handle: "@cleo_sample" },
      { platform: "signal", key: "4d6f6e6f-0000-4000-8000-000000000001", displayName: "dev.42", handle: "dev.42" },
      { platform: "discord", key: "100000000000000002", displayName: "100000000000000002", selfOnly: true },
      { platform: "discord", key: "Deleted User", keyKind: "name", displayName: "Deleted User", selfOnly: true },
      { platform: "x", key: "300000002", displayName: "300000002" },
      { platform: "signal", key: "4d6f6e6f-0000-4000-8000-000000000002", displayName: "4d6f6e6f-0000-4000-8000-000000000002" },
      { platform: "signal", key: "4d6f6e6f-0000-4000-8000-000000000003", displayName: "+61491571804", handle: "+61491571804" },
      { platform: "imessage", key: "+61491572549", displayName: "+61491572549", handle: "+61491572549" },
      { platform: "imessage", key: "sam@example.com", displayName: "sam@example.com", handle: "sam@example.com" },
      { platform: "imessage", key: "78787", displayName: "78787" },
      { platform: "imessage", key: "CommBank", displayName: "CommBank" },
    ];
    for (const platform of new Set(accounts.map((a) => a.platform))) {
      const events: ArchiveEvent[] = [{ kind: "account", key: "Me", keyKind: "id", displayName: "Me", isSelf: true }];
      accounts.filter((a) => a.platform === platform).forEach((a, i) => {
        // Discord's data package holds only the captain's side, so only he writes there.
        const senders = a.selfOnly ? ["Me"] : [a.key, "Me"];
        events.push(
          { kind: "account", key: a.key, keyKind: a.keyKind ?? "id", displayName: a.displayName, ...(a.handle ? { handle: a.handle } : {}) },
          { kind: "conversation", id: a.key, type: "direct", title: a.displayName, members: ["Me", a.key], ...(a.selfOnly ? { selfOnly: true } : {}) },
          ...senders.map((sender, j): ArchiveEvent => ({
            kind: "message", id: `${a.key}-${j}`, idKind: "platform", conversation: a.key, sender, isFromSelf: sender === "Me",
            sentAt: 1_700_000_000_000 + i * 60_000 + j, type: "text", text: "hi", raw: {},
          })),
        );
      });
      importEvents(events, platform);
    }
    people.runRules();
    expect(archived()).toEqual({
      "ada.sample": null,
      bruno_sample: null,
      "@cleo_sample": null,
      "dev.42": null,
      "100000000000000002": "no-name",
      "Deleted User": "unknown",
      "300000002": "no-name",
      "4d6f6e6f-0000-4000-8000-000000000002": "no-name",
      "+61491571804": "no-name",
      "+61491572549": "no-name",
      "sam@example.com": "no-name",
      "78787": "no-name",
      CommBank: "no-name",
    });
  });

  it("tell a name from a handle", () => {
    const id = (displayName: string, key = "k") => isUnnamed({ key, key_kind: "id", display_name: displayName });
    const byName = (displayName: string) => isUnnamed({ key: displayName, key_kind: "name", display_name: displayName });
    expect(id("+61491571266", "+61491571266")).toBe(true);
    expect(id("+61491571266", "61491571266@s.whatsapp.net")).toBe(true);
    expect(id("GOV.AU", "GOV.AU")).toBe(true);
    expect(id("Ada Lovelace", "+61491571491")).toBe(false);
    // A platform's own id shown as the name is no name; a username, which is never the key, is one.
    expect(id("100000000000000001", "100000000000000001")).toBe(true);
    expect(id("ada.sample", "100000000000000001")).toBe(false);
    expect(id("@cleo_sample", "300000001")).toBe(false);
    // A name shaped like a number or an email is no name, whoever wrote it.
    expect(byName("0491 571 266")).toBe(true);
    expect(byName("sam@example.com")).toBe(true);
    // However it is typeset: WhatsApp's direction marks, no-break spaces and non-breaking hyphens.
    expect(byName("\u202a+61\u00a0491\u00a0570\u00a0006\u202c")).toBe(true);
    expect(byName("\u202a+1\u00a0202\u00a0555\u20110143\u202c")).toBe(true);
    expect(id("\u202a+61\u00a0491\u00a0571\u00a0266\u202c", "61491571266@s.whatsapp.net")).toBe(true);
    expect(byName("\u200e(03) 7010\u20130000")).toBe(true);
    expect(byName("\u2066Sam@Example.com\u2069")).toBe(true);
    // Data WhatsApp keeps in a name column (see isEncodedName) is no name either.
    expect(id("CKDw3MYGIAA=", "61491573087@s.whatsapp.net")).toBe(true);
    expect(id("+EAA=", "61491573087@s.whatsapp.net")).toBe(true);
    // A Messenger account is keyed on its name, which is a name.
    expect(byName("Ada")).toBe(false);
    expect(byName("CommBank")).toBe(false);
  });

  it("give way to the captain: archive wins, and keep or any edit exempts from the rules", async () => {
    importChats([
      { id: "ada", members: ["Ada"], from: ["Ada", "Me"] },
      { id: "crew", type: "group", members: ["Gus", "Sal", "Tam", ...many("Crew", 9)], from: ["Gus"] },
    ]);
    people.setTags(resolved("Ada").id, ["archive"]);
    people.setTags(person("Gus").id, ["keep"]);
    people.setAliases(person("Sal").id, ["Sally"]);
    people.setTags(person("Tam").id, ["keep", "archive"]);
    expect(archived()).toEqual({ Ada: "you", Gus: null, Sal: null, Tam: "you", ...silent("Crew", 9) });
    expect(person("Gus")).toMatchObject({ archived: null, archiveRule: "groups-wrote" });
    // Unarchiving someone the rules fit, the page adds "keep" (see ArchiveButton).
    people.setTags(person("Tam").id, ["keep"]);
    expect(person("Tam").archived).toBeNull();
  });

  it("keep archived people out of merge proposals", async () => {
    importChats([
      { id: "a", members: ["Bruno Placeholder"], from: ["Bruno Placeholder", "Me"] },
      { id: "b", members: ["Bruno Ryan Placeholder"], from: ["Bruno Ryan Placeholder", "Me"] },
      { id: "crew", type: "group", members: ["Bruno Pellegrini", ...many("Crew", 11)], from: ["Bruno Pellegrini"] },
    ]);
    people.runRules();
    const pairs = () => structure.proposals().map((p) => p.people.map((x) => x.name).sort().join(" / "));
    expect(pairs()).toEqual(["Bruno Placeholder / Bruno Ryan Placeholder"]);
    people.setTags(person("Bruno Ryan Placeholder").id, ["archive"]);
    expect(pairs()).toEqual([]);
  });

  describe("the same phone number", () => {
    /** Imports one account per entry on a platform, keyed and handled by its number, in a direct chat (two-way) or a big group. */
    function importPhones(platform: string, accounts: Array<{ name: string; phone: string; group?: boolean }>): void {
      const events: ArchiveEvent[] = [{ kind: "account", key: "me", keyKind: "id", displayName: "Me", isSelf: true }];
      let n = 0;
      const message = (conversation: string, sender: string) => events.push({
        kind: "message", id: `${platform}-${n}`, idKind: "platform", conversation, sender, isFromSelf: sender === "me",
        sentAt: 1_700_000_000_000 + n++ * 60_000, type: "text", text: `message ${n}`, raw: {},
      });
      const crowd = many(`${platform} crowd `, 11);
      for (const key of crowd) events.push({ kind: "account", key, keyKind: "id", displayName: key });
      for (const { name, phone } of accounts) events.push({ kind: "account", key: phone, keyKind: "id", displayName: name, handle: phone });
      events.push({ kind: "conversation", id: "group", type: "group", title: "Group", members: ["me", ...crowd, ...accounts.filter((a) => a.group).map((a) => a.phone)] });
      for (const { name, phone, group } of accounts) {
        if (group) {
          message("group", phone);
          continue;
        }
        events.push({ kind: "conversation", id: phone, type: "direct", title: name, members: ["me", phone] });
        message(phone, phone);
        message(phone, "me");
      }
      importEvents(events, platform);
    }
    const pairs = () => structure.proposals().map((p) => [p.people.map((x) => x.name).sort().join(" / "), p.evidence.map((e) => e.rule).join(",")]);

    it("proposes people the rules archived, one side or both, but never by name", () => {
      importPhones("whatsapp", [{ name: "Ada Sample", phone: "+61491571266" }, { name: "Cleo Example", phone: "+61491571804" }]);
      importPhones("signal", [
        { name: "Ada S", phone: "+61491571266", group: true },
        { name: "Bo Placeholder", phone: "+61491571491", group: true },
        { name: "Cleo", phone: "+61491572549", group: true },
      ]);
      importPhones("imessage", [{ name: "Bo P", phone: "+61491571491", group: true }]);
      people.runRules();
      expect(person("Ada S").archived).toBe("groups-wrote");
      expect(person("Bo Placeholder").archived).toBe("groups-wrote");
      expect(person("Bo P").archived).toBe("groups-wrote");
      // Cleo / Cleo Example would be a name proposal on the map; with Cleo archived it is not made.
      expect(pairs()).toEqual([["Ada S / Ada Sample", "phone-match"], ["Bo P / Bo Placeholder", "phone-match"]]);
      // Confirmed, the merged person is shown.
      const kept = people.confirm(structure.proposals()[0].id);
      expect(structure.getPerson(kept)).toMatchObject({ name: "Ada Sample", archived: null });
    });

    it("never proposes someone the captain archived, and keeps a rejected pair rejected", () => {
      importPhones("whatsapp", [{ name: "Ada Sample", phone: "+61491571266" }, { name: "Bo Placeholder", phone: "+61491571491" }]);
      importPhones("signal", [{ name: "Ada S", phone: "+61491571266", group: true }, { name: "Bo P", phone: "+61491571491", group: true }]);
      people.runRules();
      expect(pairs()).toEqual([["Ada S / Ada Sample", "phone-match"], ["Bo P / Bo Placeholder", "phone-match"]]);
      // Archived by hand: dropped at once, and not made again when the rules run.
      people.setTags(person("Ada S").id, ["archive"]);
      expect(pairs()).toEqual([["Bo P / Bo Placeholder", "phone-match"]]);
      people.runRules();
      expect(pairs()).toEqual([["Bo P / Bo Placeholder", "phone-match"]]);
      people.reject(structure.proposals()[0].id);
      people.runRules();
      expect(pairs()).toEqual([]);
      expect(person("Bo P").archived).toBe("groups-wrote");
    });
  });

  it("leave Marketplace chats out of the timeline unless asked, and out of the relationships report", async () => {
    importChats([
      { id: "ada", members: ["Ada"], from: ["Ada", "Me"] },
      { id: "bike", marketplace: true, members: ["Ada"], from: ["Ada"] },
      { id: "crew", type: "group", marketplace: false, members: ["Ada", "Gus", ...many("Crew", 10)], from: ["Gus"] },
    ]);
    people.runRules();
    const content = new ArchiveContent(db, dataDir);
    const ada = person("Ada").id;
    expect(content.timeline(ada)!.messages).toHaveLength(2);
    const all = content.timeline(ada, { marketplace: true })!.messages;
    expect(all).toHaveLength(3);
    expect(all.filter((m) => m.conversation.marketplace)).toHaveLength(1);
    expect(person("Gus").archived).toBe("groups-wrote");
    const report = structure.relationships();
    expect(report.people.find((p) => p.name === "Ada")).toMatchObject({
      totals: { directFromMe: 1, directFromThem: 1, directFromMeSelfOnly: 0, groupFromMe: 0, groupFromThem: 0 },
    });
    // Gus is archived, so the report only counts him.
    expect(report.people.some((p) => p.name === "Gus")).toBe(false);
    expect(report.archivedCount).toBeGreaterThan(0);
  });

  it("page a long timeline up to 5000 at a time, counting the whole of it when asked", () => {
    importChats([{ id: "ada", members: ["Ada"], from: Array.from({ length: 6000 }, (_, i) => (i % 3 ? "Ada" : "Me")) }]);
    people.runRules();
    const content = new ArchiveContent(db, dataDir);
    const ada = person("Ada").id;
    const first = content.timeline(ada, { limit: 10_000, count: true })!;
    expect(first.messages).toHaveLength(5000);
    expect(first.total).toBe(6000);
    const rest = content.timeline(ada, { limit: 10_000, before: first.nextBefore! })!;
    expect(rest.messages).toHaveLength(1000);
    expect(rest.nextBefore).toBeNull();
    expect(rest.total).toBeUndefined();
    const ids = [...first.messages, ...rest.messages].map((m) => m.id);
    expect(new Set(ids).size).toBe(6000);
    expect(content.search("message", { limit: 10_000 })).toHaveLength(200);
  });
});

/** Runs the rules, then finds one by name. */
function resolved(name: string) {
  people.runRules();
  return person(name);
}
