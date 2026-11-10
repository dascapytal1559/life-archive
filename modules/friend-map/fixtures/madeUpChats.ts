// friend map's made-up data for a testing folder (sdk/server.ts's `fixtures`, `npm run testing-data`; never anyone's):
// the sample Messenger export (made-up chats with photos, a video, a voice note, reactions and group chats), read by
// its own connector's reader in this process and imported as the host imports it, and the sample people
// (data/people.json), named and tagged; or with `crowd` the made-up crowd for the map views (crowd.ts: about 120 people
// over two and a half years, their calls, crowdCalls.ts, and their hangouts, crowdHangouts.ts), or with "long" about
// 700 people from 2008, most of them last spoken with years ago. Written straight into the archive's database, before
// the core opens it; the core builds the calendar after, from every module's rows.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { transaction, type ArchiveEvent } from "../../../sdk/server.ts";
import { readMessengerExport } from "../connectors/messenger-export/read.ts";
import { ArchiveStructure } from "../server/structure.ts";
import { People } from "../server/people.ts";
import { applyChats } from "../server/write.ts";
import type { Db } from "../server/db.ts";
import { makeCrowd, makeLongCrowd } from "./crowd.ts";
import { crowdCalls } from "./crowdCalls.ts";
import { crowdHangouts } from "./crowdHangouts.ts";
import { sampleMessengerExport } from "./exports.ts";
import { addSamplePeople, type SamplePerson } from "./samplePeople.ts";

const SAMPLE_PEOPLE = new URL("./data/people.json", import.meta.url);

/** `events` as one import of `platform` by `connector` into `db`, its source recorded as the host records one. */
export function importMadeUp(db: Db, dataDir: string, platform: string, connector: string, events: Iterable<ArchiveEvent>): void {
  transaction(db, () => {
    const now = Date.now();
    const source = Number(db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, finished_at, status) VALUES (?, ?, 'export', 'made up', ?, ?, 'ok')")
      .run(platform, connector, now, now).lastInsertRowid);
    const { counts } = applyChats(events, db, { id: source, platform, kind: "export", seenAt: now, folder: dataDir }, () => {});
    db.prepare("UPDATE source SET counts_json = ? WHERE id = ?").run(JSON.stringify(counts), source);
  });
}

/** The sample Messenger export's events, as its connector reads them from the export unpacked into `dataDir`. */
export async function sampleEvents(dataDir: string): Promise<ArchiveEvent[]> {
  const events: ArchiveEvent[] = [];
  await readMessengerExport({
    sources: [await sampleMessengerExport(dataDir)],
    config: {},
    mediaDir: join(dataDir, "platform-exports"),
    emit: async (event) => {
      events.push(event as ArchiveEvent);
    },
  });
  return events;
}

/** Writes friend map's made-up data into the testing folder `dataDir`, its archive open in `db`. */
export async function writeMadeUpChats(dataDir: string, { db }: { db: Db }, { crowd }: { crowd?: "crowd" | "long" } = {}): Promise<void> {
  const people = new People(db);
  const into = { db, people, structure: new ArchiveStructure(db, people) };
  if (!crowd) {
    importMadeUp(db, dataDir, "messenger", "messenger-export", await sampleEvents(dataDir));
    people.runRules();
    addSamplePeople(into, JSON.parse(await readFile(SAMPLE_PEOPLE, "utf8")) as SamplePerson[]);
    return;
  }
  const made = crowd === "long" ? makeLongCrowd() : makeCrowd();
  const calls = crowd === "long" ? null : crowdCalls(made);
  importMadeUp(db, dataDir, "messenger", "crowd", [...made.events, ...(calls?.messenger ?? [])]);
  if (calls) importMadeUp(db, dataDir, "phone", "crowd", calls.phone);
  people.runRules();
  addSamplePeople(into, [...made.people, ...(calls?.people ?? [])]);
  if (crowd === "long") return;
  const named = new Map(into.structure.listPeople().people.map((p) => [p.name, p.id]));
  for (const h of crowdHangouts(made)) people.addCatchUp({ day: h.day, time: h.time, hours: h.hours, personIds: h.names.map((name) => named.get(name)!), others: h.others });
}
