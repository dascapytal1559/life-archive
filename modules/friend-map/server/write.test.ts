import { describe, expect, it } from "vitest";
import { openArchive } from "./db.ts";
import { ImportSession } from "./write.ts";

describe("edit events", () => {
  it("change a message's text, keep the text before, and never undo a later edit or bring back an unsent message", () => {
    const db = openArchive(":memory:");
    const source = (label: string) =>
      Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('telegram', 'live', 'live', ?, 1, 'ok')")
        .run(label).lastInsertRowid);
    const first = new ImportSession(db, "telegram", source("one"), "live");
    first.apply({ kind: "account", key: "1", keyKind: "id", displayName: "Ada" });
    first.apply({ kind: "conversation", id: "user:1", type: "direct", members: ["1"] });
    for (const id of ["a", "b"]) {
      first.apply({ kind: "message", id, idKind: "platform", conversation: "user:1", sender: "1", isFromSelf: false, sentAt: 10, type: "text", text: "first", raw: {} });
    }
    // In the same source as the message, as a live batch or a history walk has it.
    first.apply({ kind: "edit", message: "a", text: "second", editedAt: 20 });
    expect(first.counts.messages).toMatchObject({ added: 2, edited: 1 });

    const later = new ImportSession(db, "telegram", source("two"), "live");
    later.apply({ kind: "edit", message: "a", text: "older", editedAt: 15 });
    later.apply({ kind: "edit", message: "a", text: "third", editedAt: 30 });
    // The message as first sent, read again, leaves the edit alone.
    later.apply({ kind: "message", id: "a", idKind: "platform", conversation: "user:1", sender: "1", isFromSelf: false, sentAt: 10, type: "text", text: "first", raw: {} });
    later.apply({ kind: "message", id: "b", idKind: "platform", conversation: "user:1", sender: "1", isFromSelf: false, sentAt: 10, type: "text", unsent: true, raw: {} });
    later.apply({ kind: "edit", message: "b", text: "back again", editedAt: 40 });
    expect(later.counts.messages).toMatchObject({ edited: 1, unchanged: 3, updated: 1 });

    const rows = db.prepare("SELECT platform_message_id AS id, text, edited_at, unsent FROM message ORDER BY id").all();
    expect(rows).toEqual([
      { id: "a", text: "third", edited_at: 30, unsent: 0 },
      { id: "b", text: null, edited_at: null, unsent: 1 },
    ]);
    expect(db.prepare("SELECT text FROM message_version ORDER BY rowid").all()).toEqual([{ text: "first" }, { text: "second" }]);
    expect(() => later.apply({ kind: "edit", message: "nope", text: "x", editedAt: 1 })).toThrow(/refers to a message that no earlier event announced/);
    db.close();
  });
});

describe("account names", () => {
  it("follow the newest source, except that a placeholder or a bare number never replaces a name a source found", () => {
    const db = openArchive(":memory:");
    const session = (label: string) => new ImportSession(db, "whatsapp", Number(
      db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('whatsapp', 'x', 'app-db', ?, 1, 'ok')").run(label).lastInsertRowid,
    ), "app-db");
    const ada = { kind: "account", key: "61491571266@s.whatsapp.net", keyKind: "id" } as const;
    const name = () => db.prepare("SELECT display_name AS name, name_source AS source, handle FROM import_person").get();

    session("import").apply({ ...ada, displayName: "Ada Sample", nameSource: "addressBook" });
    session("live").apply({ ...ada, displayName: "+61491571266", nameSource: "number", handle: "+61491571266" });
    expect(name()).toEqual({ name: "Ada Sample", source: "addressBook", handle: "+61491571266" });
    session("live").apply({ ...ada, displayName: "WhatsApp user", nameSource: "none" });
    expect(name()).toEqual({ name: "Ada Sample", source: "addressBook", handle: "+61491571266" });
    // A name found elsewhere still replaces it, and a found name replaces a stand-in.
    session("live").apply({ ...ada, displayName: "Ada S.", nameSource: "profile" });
    expect(name()).toMatchObject({ name: "Ada S.", source: "profile" });
    const bea = { kind: "account", key: "61491571491@s.whatsapp.net", keyKind: "id" } as const;
    session("live").apply({ ...bea, displayName: "+61491571491", nameSource: "number" });
    session("import").apply({ ...bea, displayName: "Bea Example", nameSource: "addressBook" });
    expect(db.prepare("SELECT display_name AS name FROM import_person WHERE key = ?").get(bea.key)).toEqual({ name: "Bea Example" });
    db.close();
  });
});

describe("a message's kind", () => {
  it("is learned from a newer source when an older one could not tell it, with its sender, and never lost again", () => {
    const db = openArchive(":memory:");
    const session = (label: string) => new ImportSession(db, "whatsapp", Number(
      db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('whatsapp', 'x', 'app-db', ?, 1, 'ok')").run(label).lastInsertRowid,
    ), "app-db");
    const call = { kind: "message", id: "CA110000000000000000000000000001", idKind: "platform", conversation: "61491571266@s.whatsapp.net", sentAt: 10, raw: {} } as const;
    const older = session("older");
    older.apply({ kind: "account", key: "me", keyKind: "id", displayName: "Me", isSelf: true });
    older.apply({ kind: "account", key: "61491571266@s.whatsapp.net", keyKind: "id", displayName: "Ada Sample" });
    older.apply({ kind: "conversation", id: "61491571266@s.whatsapp.net", type: "direct", members: ["me", "61491571266@s.whatsapp.net"] });
    // An older reader kept an unknown kind as from whoever sent it.
    older.apply({ ...call, sender: "me", isFromSelf: true, type: "other" });
    const row = () => db.prepare("SELECT type, call_seconds AS seconds, (SELECT key FROM import_person WHERE id = sender_account_id) AS sender, is_from_self AS fromSelf FROM message").get();

    const newer = session("newer");
    newer.apply({ ...call, sender: "61491571266@s.whatsapp.net", isFromSelf: false, type: "call", callSeconds: 2460 });
    expect(newer.counts.messages).toMatchObject({ updated: 1 });
    expect(row()).toEqual({ type: "call", seconds: 2460, sender: "61491571266@s.whatsapp.net", fromSelf: 0 });

    // A source that cannot tell takes nothing away: the kind and its sender stay.
    const unsure = session("unsure");
    unsure.apply({ ...call, sender: "me", isFromSelf: true, type: "other", callSeconds: 2460 });
    expect(unsure.counts.messages).toMatchObject({ unchanged: 1 });
    expect(row()).toEqual({ type: "call", seconds: 2460, sender: "61491571266@s.whatsapp.net", fromSelf: 0 });
    db.close();
  });
});
