// The same messages reaching the archive through two connectors (Messenger's
// phone export and Facebook's "Download your information") are kept once,
// whichever is imported first, and re-importing either adds nothing.

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, writeZip } from "../../../sdk/server.ts";
import { openArchive } from "../server/db.ts";
import { unpackExport } from "../server/platformExports.ts";
import { exportFolder, unpackedExport } from "../fixtures/exports.ts";
import { DYI_SAMPLE, overlappingExports, writeDyiParts } from "../fixtures/facebook-dyi.ts";
import { SELF } from "../fixtures/messenger.ts";
import { loadRegistry, type ConnectorHost } from "../../../sdk/testing.ts";
import { chatHost } from "../testing/host.ts";

let dataDir: string;
let db: Db;
let host: ConnectorHost;
const pair = overlappingExports();
const paths = { phone: "", dyi: "", later: "" };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-overlap-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  host = await chatHost(db, dataDir);
  await host.setEnabled("messenger-export", true);
  // A download of one chat cannot tell who the captain is, so the later one needs selfName.
  await writeFile(join(dataDir, "connectors", "facebook-dyi.json"), JSON.stringify({ enabled: true, selfName: SELF }));
  // Each export in its own folder, unpacked beside its zip, as the captain keeps them.
  const dates = { phone: "2026-09-27", dyi: "2026-09-28", later: "2026-10-04" };
  for (const name of ["phone", "dyi", "later"] as const) {
    const zip = join(dataDir, `${name}.zip`);
    await writeZip(zip, pair[name]);
    paths[name] = await unpackedExport(zip, exportFolder(dataDir, "messenger", dates[name]));
  }
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const rows = <T>(sql: string) => db.prepare(sql).all() as T[];
const count = (table: string) => rows<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0].n;

/** Every message the archive holds, as sender, time and text, sorted. */
function messages(): string[] {
  return rows<{ who: string | null; sent_at: number; text: string | null }>(
    `SELECT a.display_name AS who, m.sent_at, m.text FROM message m LEFT JOIN import_person a ON a.id = m.sender_account_id`,
  ).map((m) => `${m.who} ${m.sent_at} ${m.text ?? ""}`).sort();
}

describe("the same messages from two connectors", () => {
  it("are kept once when the phone export comes first, and the download adds only what it alone has", async () => {
    const phone = await host.importHistory("messenger-export", paths.phone);
    expect(phone.counts.messages).toMatchObject({ added: 8, matched: 0 });

    const dyi = await host.importHistory("facebook-dyi", paths.dyi);
    // Shared: the text, the burst (one download message for two phone records), the link, the reacted text,
    // the "Facebook user" message and the group message. New: the older one, the one a millisecond later,
    // and the captain's in the same millisecond as Ada's.
    expect(dyi.counts.messages).toMatchObject({ added: 3, matched: pair.shared, unchanged: 0 });
    expect(count("message")).toBe(11);
    expect(count("message_alias")).toBe(pair.shared);
    // The same people: one account per name, whichever export named them.
    expect(rows<{ n: number }>("SELECT count(*) AS n FROM import_person WHERE display_name = 'Ada Sample'")[0].n).toBe(1);
    // The reaction both exports have is kept once; the burst keeps the phone export's two photos.
    expect(count("reaction")).toBe(1);
    expect(dyi.counts.reactions.added).toBe(0);
    expect(rows<{ filename: string }>("SELECT filename FROM attachment ORDER BY filename").map((a) => a.filename))
      .toEqual(["burst_a.jpeg", "burst_b.jpeg"]);
    // Unknown accounts stay a person per chat, one from each connector, and are not proposed for a merge.
    const unknown = rows<{ key: string }>("SELECT key FROM import_person WHERE display_name = 'Facebook user'");
    expect(unknown).toHaveLength(2);
    expect(count("merge_proposal")).toBe(0);

    const before = messages();
    for (const [connector, path] of [["facebook-dyi", paths.dyi], ["messenger-export", paths.phone]]) {
      const again = await host.importHistory(connector, path);
      expect(again.counts.messages).toMatchObject({ added: 0, matched: 0, updated: 0 });
      expect(again.counts.reactions.added).toBe(0);
      expect(again.counts.attachments).toMatchObject({ added: 0, updated: 0 });
    }
    expect(messages()).toEqual(before);

    // A newer, overlapping download adds only its new message.
    const later = await host.importHistory("facebook-dyi", paths.later);
    expect(later.counts.messages).toMatchObject({ added: 1, matched: 0, unchanged: 1 });
    expect(count("message")).toBe(12);
  });

  it("are kept once when the download comes first", async () => {
    const dyi = await host.importHistory("facebook-dyi", paths.dyi);
    expect(dyi.counts.messages).toMatchObject({ added: 9, matched: 0 });
    const phone = await host.importHistory("messenger-export", paths.phone);
    // Both of the phone export's burst records are the download's one message with two photos.
    expect(phone.counts.messages).toMatchObject({ added: 1, matched: pair.shared + 1 });
    expect(count("message")).toBe(10);
    expect(rows<{ filename: string }>("SELECT filename FROM attachment ORDER BY filename").map((a) => a.filename))
      .toEqual(["301.jpg", "302.jpg"]);
    expect(count("reaction")).toBe(1);

    const again = await host.importHistory("messenger-export", paths.phone);
    expect(again.counts.messages).toMatchObject({ added: 0, matched: 0, unchanged: 8 });
  });

  it("from the same connector are never matched this way", async () => {
    // The download's own records in one millisecond (the phone sample's burst, say) stay apart by their ids;
    // only another connector's messages are candidates.
    await host.importHistory("facebook-dyi", paths.dyi);
    const once = count("message");
    await host.importHistory("facebook-dyi", paths.later);
    expect(count("message")).toBe(once + 1);
    expect(count("message_alias")).toBe(0);
  });
});

describe("a large download", () => {
  it("imports from a folder of parts, and an interrupted import leaves nothing behind and can simply be run again", async () => {
    const parts = exportFolder(dataDir, "messenger", "2026-09-29");
    await mkdir(parts, { recursive: true });
    await writeDyiParts(parts);
    await unpackExport(parts);

    await expect(host.importHistory("facebook-dyi", parts, { timeoutMs: 1 })).rejects.toThrow(/did not finish/);
    expect(count("message")).toBe(0);
    expect(count("import_person")).toBe(0);

    const result = await host.importHistory("facebook-dyi", parts);
    expect(result.source).toBe(parts);
    const messages = DYI_SAMPLE.records - 1;
    expect(result.counts.messages).toMatchObject({ added: messages, duplicates: 1 });
    expect(result.counts.attachments).toMatchObject({ added: 8, stored: 7, missing: 1 });
    const again = await host.importHistory("facebook-dyi", parts);
    expect(again.counts.messages).toMatchObject({ added: 0, unchanged: messages });
    expect(count("message")).toBe(messages);
    // Nothing is left in the spool.
    expect(await readdir(join(dataDir, "archive", ".spool"))).toEqual([]);
  });
});
