// The group chats a person's panel lists: every group they are listed in or
// wrote in, with its size counted as the archive rules count it, and what they
// and the captain sent there. Made-up people and placeholder text only.

import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ArchiveEvent, transaction } from "../../../sdk/server.ts";
import { ImportSession } from "./write.ts";

let dataDir: string;
let archive: TestArchive;

interface Chat {
  id: string;
  type?: "direct" | "group";
  members: string[];
  /** Who sent each message, oldest first. */
  from: string[];
  marketplace?: boolean;
  /** Accounts keyed on their name, such as "Facebook user". */
  byName?: string[];
  /** No title, as iMessage groups often have. */
  untitled?: boolean;
}

let n = 0;
function events(chats: Chat[]): ArchiveEvent[] {
  const out: ArchiveEvent[] = [{ kind: "account", key: "Me", keyKind: "id", displayName: "Riley Self", isSelf: true }];
  const accounts = new Set(chats.flatMap((chat) => [...chat.members, ...chat.from]).filter((who) => who !== "Me"));
  const byName = new Set(chats.flatMap((chat) => chat.byName ?? []));
  for (const who of accounts) out.push({ kind: "account", key: who, keyKind: byName.has(who) ? "name" : "id", displayName: who });
  for (const chat of chats) {
    out.push({
      kind: "conversation", id: chat.id, type: chat.type ?? "group", ...(chat.untitled ? {} : { title: `${chat.id} chat` }), members: ["Me", ...chat.members],
      ...(chat.marketplace ? { marketplace: true } : {}),
    });
    for (const sender of chat.from) {
      out.push({
        kind: "message", id: `m${n}`, idKind: "platform", conversation: chat.id, sender, isFromSelf: sender === "Me",
        sentAt: 1_700_000_000_000 + n++ * 60_000, type: "text", text: "placeholder", raw: {},
      });
    }
  }
  return out;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-person-groups-"));
  archive = await openTestArchive(dataDir);
  transaction(archive.db, () => {
    const source = Number(archive.db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'test', 'export', 'test', 0, 'ok')")
      .run().lastInsertRowid);
    const session = new ImportSession(archive.db, "messenger", source, "export");
    for (const event of events([
      { id: "ada", type: "direct", members: ["Ada"], from: ["Ada", "Me"] },
      // Listed, never wrote: still one of her groups.
      { id: "quiet", members: ["Ada", "Bo", "Cy"], from: ["Bo", "Me", "Me"] },
      // Wrote without being listed (she left, say): hers too, and she counts in its size.
      { id: "left", members: ["Bo"], from: ["Ada", "Ada", "Bo"] },
      // A deleted account keyed on its name counts as one person, as the archive rules count it, though it may be several.
      { id: "deleted", members: ["Ada", "Facebook user"], from: ["Facebook user", "Ada", "Me"], byName: ["Facebook user"] },
      { id: "sale", marketplace: true, members: ["Ada"], from: ["Ada"] },
      { id: "other", members: ["Bo", "Cy"], from: ["Bo"] },
      // Untitled, with five people besides the captain: named by the three who wrote most, then by name.
      { id: "nameless", untitled: true, members: ["Dee", "Eve", "Fay", "Gus", "Hal"], from: ["Eve", "Eve", "Gus", "Me"] },
    ])) session.apply(event);
  });
  archive.people.runRules();
});

afterAll(async () => {
  archive.close();
  await rm(dataDir, { recursive: true, force: true });
});

const personId = (name: string) => archive.structure.listPeople().people.find((p) => p.name === name)!.id;

describe("a person's group chats", () => {
  it("lists every group they are listed in or wrote in, the latest first, with its size and what each side sent", () => {
    expect(archive.structure.groupsOf(personId("Ada"))).toEqual([
      { id: expect.any(Number), title: "deleted chat", platform: "messenger", people: 3, fromThem: 1, fromMe: 1, lastMessageAt: expect.any(Number), namedBy: [], unlinked: false },
      { id: expect.any(Number), title: "left chat", platform: "messenger", people: 3, fromThem: 2, fromMe: 0, lastMessageAt: expect.any(Number), namedBy: [], unlinked: false },
      { id: expect.any(Number), title: "quiet chat", platform: "messenger", people: 4, fromThem: 0, fromMe: 2, lastMessageAt: expect.any(Number), namedBy: [], unlinked: false },
    ]);
  });

  it("names an untitled group by the first few people in it, most messages there first, then by name", () => {
    const [nameless] = archive.structure.groupsOf(personId("Eve"))!;
    expect(nameless).toMatchObject({ title: null, people: 6, fromThem: 2, fromMe: 1 });
    expect(nameless.namedBy.map((p) => p.name)).toEqual(["Eve", "Gus", "Dee"]);
    // A titled group needs nobody to name it by.
    expect(archive.structure.groupsOf(personId("Ada"))!.every((group) => group.namedBy.length === 0)).toBe(true);
  });

  it("gives one group chat for its header: everyone in it but the captain, with what each sent there", () => {
    const [nameless] = archive.structure.groupsOf(personId("Eve"))!;
    const group = archive.structure.group(nameless.id)!;
    expect(group).toMatchObject({ id: nameless.id, title: null, platform: "messenger", people: 6, fromMe: 1, messageCount: 4 });
    expect(group.members.map((m) => [m.name, m.messages])).toEqual([["Eve", 2], ["Gus", 1], ["Dee", 0], ["Fay", 0], ["Hal", 0]]);
    // The list names an untitled group by the first of these, so both call it the same.
    expect(group.members.slice(0, nameless.namedBy.length).map(({ id, name, aliases }) => ({ id, name, aliases }))).toEqual(nameless.namedBy);
    expect(group.firstMessageAt).toBeLessThan(group.lastMessageAt!);
    expect(group.lastMessageAt).toBe(nameless.lastMessageAt);
  });

  it("counts two accounts of one person in a group as one member, with both accounts' messages", () => {
    // Bo and Cy become one person: in "other" (Bo wrote, Cy listed) they are one member now.
    const bo = personId("Bo");
    archive.people.merge(bo, personId("Cy"));
    const other = archive.structure.groupsOf(bo)!.find((group) => group.title === "other chat")!;
    const group = archive.structure.group(other.id)!;
    expect(group.members).toEqual([{ id: bo, name: "Bo", aliases: [], messages: 1, untouched: false, archived: false }]);
    // The size still counts accounts, as the archive rules do.
    expect(group.people).toBe(3);
  });

  it("gives no group chat for a direct or Marketplace chat, or one that isn't there", () => {
    const chats = archive.db.prepare("SELECT id, type, is_marketplace FROM conversation").all() as { id: number; type: string; is_marketplace: number }[];
    for (const chat of chats.filter((c) => c.type === "direct" || c.is_marketplace)) expect(archive.structure.group(chat.id)).toBeNull();
    expect(chats.some((c) => c.type === "direct")).toBe(true);
    expect(archive.structure.group(999_999)).toBeNull();
  });

  it("counts a deleted account's groups too, and gives null for nobody", () => {
    const groups = archive.structure.groupsOf(personId("Facebook user"))!;
    expect(groups).toHaveLength(1);
    // Its header counts the deleted account as one, as the list does.
    expect(archive.structure.group(groups[0].id)!.people).toBe(3);
    expect(archive.structure.groupsOf(999_999)).toBeNull();
  });
});
