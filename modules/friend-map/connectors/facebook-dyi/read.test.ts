import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unpackExport } from "../../server/platformExports.ts";
import { DYI_SAMPLE, facebookJson, rec, threadFile, writeDyiParts } from "../../fixtures/facebook-dyi.ts";
import { SELF } from "../../fixtures/messenger.ts";
import { type ConnectorEvent, MediaLedger, writeZip, zipBytes } from "../../../../sdk/server.ts";
import { callSeconds, fixText } from "../metaDyi.ts";
import { readFacebookDyi } from "./read.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-dyi-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function read(sources: string[], config: Record<string, unknown> = {}) {
  const events: ConnectorEvent[] = [];
  const mediaDir = join(dir, "media");
  await readFacebookDyi({ sources, config, mediaDir, emit: async (event) => void events.push(event) });
  const of = <K extends ConnectorEvent["kind"]>(kind: K) => events.filter((e): e is Extract<ConnectorEvent, { kind: K }> => e.kind === kind);
  return { events, of, mediaDir };
}

describe("fixText", () => {
  it("reads Facebook's escaped UTF-8 back, and leaves other text alone", () => {
    const escaped = (text: string) => Buffer.from(text, "utf8").toString("latin1");
    for (const text of ["Cléo Example", "Ça va? 🎟️", "❤", "日本語"]) expect(fixText(escaped(text))).toBe(text);
    // Plain ASCII, text already decoded, and Latin-1 that is not UTF-8 bytes are kept as they are.
    for (const text of ["plain", "Cléo 🎟️", "café", ""]) expect(fixText(text)).toBe(text);
  });
});

describe("callSeconds", () => {
  it("reads a call record's call_duration as whole seconds connected, 0 for one never answered, and nothing else", () => {
    expect(callSeconds({ call_duration: 4320 })).toBe(4320);
    expect(callSeconds({ call_duration: 61.6 })).toBe(62);
    expect(callSeconds({ call_duration: 0 })).toBe(0);
    for (const call_duration of [undefined, null, "120", -5, Number.NaN]) expect(callSeconds({ call_duration }), String(call_duration)).toBeUndefined();
    expect(callSeconds({})).toBeUndefined();
  });
});

describe("facebook-dyi", () => {
  it("reads every part of the sample together, as one export, unpacked beside its zips", async () => {
    const parts = await writeDyiParts(dir);
    await unpackExport(dir);
    const { of, mediaDir } = await read([dir]);

    const conversations = of("conversation");
    expect(conversations).toHaveLength(DYI_SAMPLE.chats);
    expect(conversations.map((c) => c.id).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `thread:100000000000000${n}`));
    const byId = Object.fromEntries(conversations.map((c) => [c.id.slice(-1), c]));
    expect(byId[1]).toMatchObject({ type: "direct", title: "Ada Sample", members: ["Ada Sample", SELF] });
    // Names are decoded from Facebook's escaping.
    expect(byId[2]).toMatchObject({ type: "direct", title: "Cléo Example" });
    // Someone who left a group was still in it.
    expect(byId[3]).toMatchObject({ type: "group", title: "Old flat", members: ["Dev Testington", "Esme Fictional", "Former Flatmate", SELF] });
    // Two people left in a group with a name of its own: still a group. Read from the zip inside a part.
    expect(byId[6]).toMatchObject({ type: "group", title: "Climbing crew" });
    // The chat file sitting directly in inbox/ joins its chat by its thread_path.
    expect(byId[7]).toMatchObject({ type: "direct", title: "Hana Newface" });
    // A Marketplace chat: marked, direct, titled with the item.
    expect(byId[8]).toMatchObject({ type: "direct", title: "Nora · Road bike, 54 cm", marketplace: true });
    expect(conversations.filter((c) => c.marketplace)).toHaveLength(1);

    const accounts = of("account");
    expect(accounts.filter((a) => a.isSelf).map((a) => a.key)).toEqual([SELF]);
    // Each "Facebook user" chat is a different unknown account.
    const placeholders = accounts.filter((a) => a.displayName === "Facebook user");
    expect(new Set(placeholders.map((a) => a.key)).size).toBe(2);
    expect(accounts.map((a) => a.key)).toContain("Cléo Example");

    const messages = of("message");
    expect(messages).toHaveLength(DYI_SAMPLE.records);
    // The duplicate record (in both of Ada's files) shares an id; the two records in one millisecond do not.
    expect(new Set(messages.map((m) => m.id)).size).toBe(DYI_SAMPLE.records - 1);
    const text = (t: string) => messages.find((m) => m.text === t);
    expect(text("Welcome to Melbourne! 🎉")).toMatchObject({ sender: "Ada Sample", isFromSelf: false, type: "text" });
    expect(text("Ça va? Les billets sont arrivés 🎟️")).toBeDefined();
    // A call record says how long the call was connected: kept as its length.
    expect(text("Ada called you.")).toMatchObject({ type: "call", callSeconds: 120 });
    expect(messages.filter((m) => m.type !== "call" && m.callSeconds !== undefined)).toEqual([]);
    expect(text("https://example.com/crag")).toMatchObject({ type: "link", isFromSelf: true });
    expect(messages.filter((m) => m.unsent)).toEqual([expect.objectContaining({ sender: "Ada Sample", unsent: true })]);
    expect(messages.filter((m) => m.unsent)[0].text).toBeUndefined();

    expect(of("reaction")).toEqual([
      { kind: "reaction", message: text("Welcome to Melbourne! 🎉")!.id, actor: SELF, emoji: "❤", addedAt: Date.parse("2019-05-01T18:01:00+10:00") },
    ]);

    const attachments = of("attachment");
    expect(attachments.map((a) => [a.filename, a.type, a.mime, a.inPlace !== undefined]).sort()).toEqual([
      ["111.jpg", "image", "image/jpeg", true],
      ["112.jpg", "image", "image/jpeg", false],
      ["114.gif", "gif", "image/gif", true],
      ["115.mp4", "video", "video/mp4", true],
      ["116.pdf", "file", "application/pdf", true],
      ["369239263222822.png", "sticker", "image/png", true],
      ["notes.json", "file", undefined, true],
      ["voice_113.mp4", "audio", "audio/mp4", true],
    ]);
    // Each file is pointed at where it lies in the unpacked tree, hashed, and nothing is copied.
    expect(attachments.every((a) => a.stored === undefined)).toBe(true);
    for (const { inPlace } of attachments) {
      if (!inPlace) continue;
      expect(inPlace.path.startsWith(`${dir}/your_facebook_activity/messages/`)).toBe(true);
      const bytes = await readFile(inPlace.path);
      expect([createHash("sha256").update(bytes).digest("hex"), bytes.length]).toEqual([inPlace.sha256, inPlace.size]);
    }
    expect(await readdir(mediaDir).catch(() => [])).toEqual([]);

    expect(Object.fromEntries(of("tally").map((t) => [t.name, t.count]))).toEqual({
      "media not in the export": 1,
    });
    const [whole] = of("coverage").filter((c) => c.conversation === undefined);
    expect(whole).toEqual({ kind: "coverage", from: Date.parse("2016-12-24T17:00:00+11:00"), to: Date.parse("2024-01-10T09:00:00+11:00") });
    expect(of("progress").at(-1)).toMatchObject({ done: DYI_SAMPLE.chats, total: DYI_SAMPLE.chats });

    // The zips themselves hold the media, which would have nowhere to stay.
    await expect(read(parts)).rejects.toThrow(/holds them in a zip: put the export in data\/platform-exports\/messenger\/<export date>\//);
  });

  it("gives the same ids when the export is read again", async () => {
    await writeDyiParts(dir);
    await unpackExport(dir);
    const first = (await read([dir])).of("message").map((m) => m.id);
    const second = (await read([dir])).of("message").map((m) => m.id);
    expect(second).toEqual(first);
  });

  it("keeps a message's id when a later export has it edited or unsent", async () => {
    const path = (name: string) => join(dir, name);
    const chat = (message: ReturnType<typeof rec>) =>
      threadFile(["Ada Sample", SELF], "Ada Sample", "inbox/adasample_1", [message, rec(SELF, 2, "hi")]);
    await writeZip(path("before.zip"), [{ name: "your_facebook_activity/messages/inbox/adasample_1/message_1.json", data: chat(rec("Ada Sample", 1, "typo")) }]);
    await writeZip(path("after.zip"), [
      { name: "your_facebook_activity/messages/inbox/adasample_1/message_1.json", data: chat(rec("Ada Sample", 1, undefined, { is_unsent: true })) },
    ]);
    const before = (await read([path("before.zip")], { selfName: SELF })).of("message");
    const after = (await read([path("after.zip")], { selfName: SELF })).of("message");
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
    expect(after.find((m) => m.sender === "Ada Sample")).toMatchObject({ unsent: true });
  });

  it("counts people who left a chat when telling a group from a direct chat", async () => {
    const chat = (n: number, participants: string[], title: string, senders: string[]) => ({
      name: `your_facebook_activity/messages/inbox/c_${n}/message_1.json`,
      data: threadFile(participants, title, `inbox/c_${n}`, senders.map((sender, i) => rec(sender, n * 100 + i, "hi"))),
    });
    await writeZip(join(dir, "left.zip"), [
      // Everyone but A has left this group, which never had a name of its own: it lists just the two of you.
      chat(1, ["Me", "A"], "A", ["Me", "A", "B", "C"]),
      // A plain direct chat.
      chat(2, ["Me", "A"], "A", ["Me", "A"]),
      chat(3, ["Me", "D"], "D", ["D"]),
    ]);
    const conversations = (await read([join(dir, "left.zip")])).of("conversation");
    expect(conversations.map((c) => [c.id, c.type])).toEqual([["thread:1", "group"], ["thread:2", "direct"], ["thread:3", "direct"]]);
    expect(conversations[0].members).toEqual(["A", "B", "C", "Me"]);
  });

  it("finds the captain as the name in most chats, or needs selfName", async () => {
    const chat = (n: number, names: string[]) => ({
      name: `messages/inbox/c_${n}/message_1.json`,
      data: threadFile(names, names[1], `inbox/c_${n}`, [rec(names[1], n, "hello")]),
    });
    // An older export's paths, without your_facebook_activity/.
    await writeZip(join(dir, "most.zip"), [chat(1, ["Me", "A"]), chat(2, ["Me", "B"]), chat(3, ["X", "C"])]);
    expect((await read([join(dir, "most.zip")])).of("account").filter((a) => a.isSelf).map((a) => a.key)).toEqual(["Me"]);
    await writeZip(join(dir, "tie.zip"), [chat(1, ["Me", "A"]), chat(2, ["Me2", "B"])]);
    await expect(read([join(dir, "tie.zip")])).rejects.toThrow(/set "selfName"/);
    const { of } = await read([join(dir, "tie.zip")], { selfName: "Me2" });
    expect(of("account").filter((a) => a.isSelf).map((a) => a.key)).toEqual(["Me2"]);
  });

  it("refuses a compressed zip inside a part, rather than leave its chats out", async () => {
    await writeZip(join(dir, "part.zip"), [
      { name: "your_facebook_activity/messages/inbox/a_1/message_1.json", data: threadFile(["Me", "A"], "A", "inbox/a_1", []) },
      { name: "facebook_1.zip", data: zipBytes([{ name: "x.txt", data: "x" }]) },
    ]);
    await expect(read([join(dir, "part.zip")])).rejects.toThrow(/compressed zip \(facebook_1\.zip\)/);
  });

  it("says which source is not an export, without quoting its content", async () => {
    await writeFile(join(dir, "notes.zip"), facebookJson({ secret: "private words" }));
    await expect(read([join(dir, "notes.zip")])).rejects.toThrow(/not a zip file/);
  });
});

describe("MediaLedger", () => {
  it("copies a file once, into the platform's live folder, and again only when its copy is gone", async () => {
    const mediaDir = join(dir, "media");
    let opened = 0;
    const open = async () => {
      opened++;
      return Readable.from([Buffer.from("placeholder bytes")]);
    };
    const ledger = await MediaLedger.open(mediaDir, "test");
    const stored = await ledger.store("a.jpg|17|1", "messenger", "a.jpg", open);
    expect(stored.path).toMatch(new RegExp(`^messenger/live/${stored.sha256.slice(0, 2)}/${stored.sha256}\\.jpg$`));
    expect(await ledger.store("a.jpg|17|1", "messenger", "a.jpg", open)).toEqual(stored);
    expect(opened).toBe(1);

    // A later run (after an interruption, say) reads what the earlier one copied.
    const again = await MediaLedger.open(mediaDir, "test");
    expect(await again.store("a.jpg|17|1", "messenger", "a.jpg", open)).toEqual(stored);
    expect(opened).toBe(1);

    await rm(join(mediaDir, stored.path));
    expect(await again.store("a.jpg|17|1", "messenger", "a.jpg", open)).toEqual(stored);
    expect(opened).toBe(2);
  });
});
