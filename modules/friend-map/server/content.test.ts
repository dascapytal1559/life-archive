import { describe, expect, it } from "vitest";
import { ArchiveContent } from "./content.ts";
import { openArchive } from "./db.ts";
import { ImportSession } from "./write.ts";

describe("timeline attachments", () => {
  it("mark Messenger's like sticker in each of its sizes, and nothing else", () => {
    const db = openArchive(":memory:");
    const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'facebook-dyi', 'export', 'one', 1, 'ok')")
      .run().lastInsertRowid);
    const session = new ImportSession(db, "messenger", source, "export");
    session.apply({ kind: "account", key: "Ada", keyKind: "name", displayName: "Ada" });
    session.apply({ kind: "conversation", id: "thread:1", type: "direct", members: ["Ada"] });
    const sent: Array<[string, "sticker" | "image"]> = [
      ["369239263222822.png", "sticker"],
      ["369239343222814.png", "sticker"],
      ["369239383222810.png", "sticker"],
      ["227878347358915.png", "sticker"],
      // The like's file name on a photo is only a photo.
      ["369239263222822.png", "image"],
    ];
    sent.forEach(([filename, type], i) => {
      const id = `m${i}`;
      session.apply({ kind: "message", id, idKind: "synthetic", conversation: "thread:1", sender: "Ada", isFromSelf: false, sentAt: 10 - i, type: type === "image" ? "media" : "sticker", raw: {} });
      session.apply({ kind: "attachment", message: id, ordinal: 0, type, filename, mime: "image/png" });
    });

    const conversation = Number((db.prepare("SELECT id FROM conversation").get() as { id: number }).id);
    const page = new ArchiveContent(db, "/nowhere").conversation(conversation);
    expect(page.messages.map((m) => m.attachments.map((a) => [a.type, a.like]))).toEqual([
      [["sticker", "small"]],
      [["sticker", "medium"]],
      [["sticker", "large"]],
      [["sticker", null]],
      [["image", null]],
    ]);
    db.close();
  });
});
