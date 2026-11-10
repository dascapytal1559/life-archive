// Opening a person's panel must not cost more for a friend with a huge chat
// than for one with a few messages: the panel's first requests (the person,
// the chat's newest page, the chats to send into) stay small and bounded
// whatever the history holds, and nothing counts every message on the way.
// Made-up people and placeholder text only.

import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ArchiveEvent, type PeopleListing, type PersonSummary, type TimelinePage, transaction } from "../../../sdk/server.ts";
import { archiveHandler } from "../testing/routes.ts";
import { ImportSession } from "./write.ts";

const BIG = 20_000;
const SMALL = 12;
/** The chat's first page, as the panel asks for it (Timeline.tsx's PAGE). */
const FIRST_PAGE = 50;

let dataDir: string;
let archive: TestArchive;
let server: Server;
let base: string;

function chat(id: string, friend: string, count: number): ArchiveEvent[] {
  const events: ArchiveEvent[] = [
    { kind: "account", key: friend, keyKind: "id", displayName: friend },
    { kind: "conversation", id, type: "direct", title: friend, members: ["Me", friend] },
  ];
  for (let n = 0; n < count; n++) {
    const sender = n % 2 === 0 ? friend : "Me";
    events.push({
      kind: "message", id: `${id}-${n}`, idKind: "platform", conversation: id, sender, isFromSelf: sender === "Me",
      sentAt: 1_600_000_000_000 + n * 60_000, type: "text", text: `placeholder ${n}`, raw: {},
    });
  }
  return events;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-panel-open-"));
  archive = await openTestArchive(dataDir);
  transaction(archive.db, () => {
    const source = Number(archive.db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'test', 'export', 'test', 0, 'ok')")
      .run().lastInsertRowid);
    const session = new ImportSession(archive.db, "messenger", source, "export");
    session.apply({ kind: "account", key: "Me", keyKind: "id", displayName: "Riley Self", isSelf: true });
    for (const event of [...chat("big", "Bea Bigchat", BIG), ...chat("small", "Sid Smallchat", SMALL)]) session.apply(event);
  });
  archive.people.runRules();
  const handler = archiveHandler(archive);
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/archive`;
}, 60_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  archive.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function get(path: string): Promise<{ body: unknown; bytes: number }> {
  const response = await fetch(`${base}${path}`);
  expect(response.status, path).toBe(200);
  const text = await response.text();
  return { body: JSON.parse(text), bytes: Buffer.byteLength(text) };
}

/** What the person panel asks for as it opens (PeoplePanel.tsx, Timeline.tsx, Composer.tsx), and nothing more. */
const openingRequests = (id: number) => [
  `/people/${id}`,
  `/content/people/${id}/timeline?limit=${FIRST_PAGE}`,
  `/people/${id}/send-targets`,
];

describe("opening a person with a very large chat", () => {
  it("asks for the same few small things as for a small chat", async () => {
    const people = ((await get("/people")).body as PeopleListing).people;
    const big = people.find((p) => p.name === "Bea Bigchat")!;
    const small = people.find((p) => p.name === "Sid Smallchat")!;
    expect(big.messageCount).toBe(BIG);
    expect(small.messageCount).toBe(SMALL);

    const bigAnswers = await Promise.all(openingRequests(big.id).map(get));
    const smallAnswers = await Promise.all(openingRequests(small.id).map(get));

    // The person: their row and accounts, whatever the size of the chat.
    expect((bigAnswers[0].body as PersonSummary).id).toBe(big.id);
    expect(bigAnswers[0].bytes).toBeLessThan(2 * smallAnswers[0].bytes + 200);

    // The chat's newest page only: 50 messages, no count of the whole history, and a way to the older ones.
    const page = bigAnswers[1].body as TimelinePage;
    expect(page.messages).toHaveLength(FIRST_PAGE);
    expect(page.messages[0].sentAt).toBe(1_600_000_000_000 + (BIG - 1) * 60_000);
    expect(page.total).toBeUndefined();
    expect(page.nextBefore).not.toBeNull();
    expect(bigAnswers[1].bytes).toBeLessThan(Math.ceil(FIRST_PAGE / SMALL) * smallAnswers[1].bytes + 1000);

    // Everything the panel starts with stays small, however long the history.
    const total = bigAnswers.reduce((sum, a) => sum + a.bytes, 0);
    expect(total).toBeLessThan(50_000);
  });
});
