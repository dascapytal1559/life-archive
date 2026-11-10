// The messenger-export connector's reader (read.ts) on the committed made-up sample export.

import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeZip, ZipFile, type ConnectorEvent } from "../../../../sdk/server.ts";
import { unpackedExport } from "../../fixtures/exports.ts";
import { MESSENGER_SAMPLE } from "../../fixtures/make-fixtures.ts";
import { exportFiles, phoneExportPair, SELF, THREADS } from "../../fixtures/messenger.ts";
import { readMessengerExport } from "./read.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-connectors-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("messenger-export", () => {
  const unpacked = () => unpackedExport(MESSENGER_SAMPLE, join(dir, "2026-09-27"));

  async function read(source?: string, config: Record<string, unknown> = {}) {
    source ??= await unpacked();
    const events: ConnectorEvent[] = [];
    const mediaDir = join(dir, "media");
    await readMessengerExport({ sources: [source], config, mediaDir, emit: async (event) => void events.push(event) });
    const of = <K extends ConnectorEvent["kind"]>(kind: K) => events.filter((e): e is Extract<ConnectorEvent, { kind: K }> => e.kind === kind);
    return { events, of, mediaDir };
  }

  it("the committed sample export matches its definition", async () => {
    const regenerated = join(dir, "regenerated.zip");
    await writeZip(regenerated, exportFiles());
    expect(await readFile(regenerated)).toEqual(await readFile(MESSENGER_SAMPLE));
  });

  it("maps chats, names, messages, reactions and media", async () => {
    const { of, mediaDir } = await read();
    const folder = join(dir, "2026-09-27");
    const conversations = of("conversation");
    expect(conversations).toHaveLength(THREADS.length);
    expect(conversations.filter((c) => c.type === "group").map((c) => c.title).sort()).toEqual(["Climbing crew", "Old flat"]);
    expect(conversations.find((c) => c.title === "Ada Sample")).toMatchObject({ type: "direct", members: ["Ada Sample", SELF] });

    const accounts = of("account");
    expect(accounts.filter((a) => a.isSelf)).toEqual([{ kind: "account", key: SELF, keyKind: "name", displayName: SELF, nameSource: "export", isSelf: true }]);
    // Each "Facebook user" chat is a different unknown account.
    const placeholders = accounts.filter((a) => a.displayName === "Facebook user");
    expect(placeholders).toHaveLength(4);
    expect(new Set(placeholders.map((a) => a.key)).size).toBe(4);
    expect(new Set(conversations.filter((c) => c.title === "Facebook user").map((c) => c.id)).size).toBe(4);

    const messages = of("message");
    const records = THREADS.reduce((n, t) => n + t.messages.length, 0);
    expect(messages).toHaveLength(records);
    const ids = messages.map((m) => m.id);
    // Only the exact duplicate shares an id; the burst photos, alike but for their media, do not.
    expect(new Set(ids).size).toBe(records - 1);
    expect(messages.every((m) => m.idKind === "synthetic")).toBe(true);
    const unsent = messages.filter((m) => m.unsent);
    expect(unsent).toHaveLength(2);
    expect(unsent.every((m) => m.text === undefined)).toBe(true);
    expect(messages.filter((m) => m.isFromSelf).every((m) => m.sender === SELF)).toBe(true);

    expect(of("reaction")).toHaveLength(4);
    const attachments = of("attachment");
    expect(attachments.map((a) => [a.filename, a.type, a.inPlace !== undefined])).toEqual([
      ["crag_view.jpeg", "image", true],
      ["top_out.mp4", "video", false],
      ["burst_1.jpeg", "image", true],
      ["burst_2.jpeg", "image", true],
      ["wave.gif", "gif", true],
      ["voice_note.ogg", "audio", true],
    ]);
    // Each file is pointed at where it lies in the unpacked export, hashed, and nothing is copied.
    expect(attachments.every((a) => a.stored === undefined)).toBe(true);
    for (const { inPlace } of attachments) {
      if (!inPlace) continue;
      expect(inPlace.path.startsWith(`${folder}/media/`)).toBe(true);
      const bytes = await readFile(inPlace.path);
      expect([createHash("sha256").update(bytes).digest("hex"), bytes.length]).toEqual([inPlace.sha256, inPlace.size]);
    }
    expect(await readdir(mediaDir).catch(() => [])).toEqual([]);
    expect(of("tally")).toEqual([{ kind: "tally", name: "media not in the export", count: 1 }]);
    expect(of("coverage").filter((c) => c.conversation === undefined)).toHaveLength(1);
  });

  it("gives the same ids when the same export is read again", async () => {
    const first = (await read()).of("message").map((m) => m.id);
    const second = (await read()).of("message").map((m) => m.id);
    expect(second).toEqual(first);
  });

  it("refuses the zip itself when it holds media, which would have nowhere to stay", async () => {
    await expect(read(MESSENGER_SAMPLE)).rejects.toThrow(/holds them in a zip: put the export in data\/platform-exports\/messenger\/<export date>\//);
  });

  it("reads an empty link, which is how the export keeps a call, as a call of no known length", async () => {
    const path = join(dir, "calls.zip");
    const at = Date.parse("2025-11-02T18:40:00+11:00");
    const item = (minute: number, rest: Record<string, unknown>) => ({ senderName: "Ada Sample", timestamp: at + minute * 60_000, reactions: [], ...rest });
    await writeZip(path, [{
      name: "AdaSample_1.json",
      data: JSON.stringify({
        participants: ["Ada Sample", "Me"], threadName: "Ada Sample",
        messages: [
          item(0, { type: "link", text: "", media: [] }),
          item(1, { type: "link", text: "https://example.com/crag", media: [] }),
          item(2, { type: "link", text: "", media: [], isUnsent: true }),
          item(3, { type: "text", text: "" }),
          { ...item(4, { type: "link" }), senderName: "Me" },
        ],
      }),
    }]);
    const { of } = await read(path, { selfName: "Me" });
    expect(of("message").map((m) => [m.type, m.text ?? null, "callSeconds" in m, m.isFromSelf])).toEqual([
      ["call", null, false, false],
      ["link", "https://example.com/crag", false, false],
      ["link", null, false, false],
      ["text", null, false, false],
      ["call", null, false, true],
    ]);
  });

  it("needs selfName when no single name is in every chat", async () => {
    const path = join(dir, "two.zip");
    await writeZip(path, [
      { name: "A_1.json", data: JSON.stringify({ participants: ["Me", "A"], threadName: "A", messages: [] }) },
      { name: "B_2.json", data: JSON.stringify({ participants: ["Me2", "B"], threadName: "B", messages: [] }) },
    ]);
    await expect(read(path)).rejects.toThrow(/set "selfName"/);
    const { of } = await read(path, { selfName: "Me" });
    expect(of("account").filter((a) => a.isSelf).map((a) => a.key)).toEqual(["Me"]);
  });

  it("keys a chat by its name, so a later export, which numbers its chats anew, gives the same chats the same ids", async () => {
    const pair = phoneExportPair();
    const exports = [];
    for (const [name, files] of [["first", pair.first], ["later", pair.later]] as const) {
      const zip = join(dir, `${name}.zip`);
      await writeZip(zip, files);
      exports.push(await read(await unpackedExport(zip, join(dir, name))));
    }
    const [first, later] = exports;
    const ids = (e: typeof first, kind: "conversation" | "message") => new Set(e.of(kind).map((x) => x.id));
    // Every chat and message of the first is the later's too: the group (crew_21 is crew_24), and the "Facebook user"
    // chats, with messages and without (whose newest message in the export moved on).
    for (const kind of ["conversation", "message"] as const) {
      expect([...ids(first, kind)].filter((id) => !ids(later, kind).has(id))).toEqual([]);
    }
    expect(ids(later, "conversation").size).toBe(ids(first, "conversation").size + 1);
    expect(later.of("conversation").filter((c) => c.type === "group").map((c) => c.title).sort()).toEqual(["Climbing crew", "Old flat"]);
    const unknown = (e: typeof first) => e.of("account").filter((a) => a.displayName === "Facebook user").map((a) => a.key).sort();
    expect(unknown(later)).toEqual(unknown(first));
    expect(unknown(first)).toHaveLength(3);
  });

  it("takes only the export's own number off a chat's name", async () => {
    const path = join(dir, "names.zip");
    const group = (file: string, threadName: string) =>
      ({ name: file, data: JSON.stringify({ participants: ["Me", "Ada Sample", "Cleo Example"], threadName, messages: [] }) });
    await writeZip(path, [
      group("Crag trip 2024_3.json", "Crag trip 2024_3"),
      group("Crew_7_4.json", "Crew_7_4"),
      // A threadName that is not its file's name is kept whole.
      group("Book club_5.json", "Book club_9"),
      group("Sunday_6.json", "Sunday"),
    ]);
    const { of } = await read(path, { selfName: "Me" });
    expect(of("conversation").map((c) => c.title).sort()).toEqual(["Book club_9", "Crag trip 2024", "Crew_7", "Sunday"]);
    // Four groups of the same people with different names are four chats; two of the same name in one export, two.
    expect(new Set(of("conversation").map((c) => c.id)).size).toBe(4);
    await writeZip(path, [group("Crew_1.json", "Crew_1"), group("Crew_2.json", "Crew_2")]);
    expect(new Set((await read(path, { selfName: "Me" })).of("conversation").map((c) => c.id)).size).toBe(2);
  });
});
