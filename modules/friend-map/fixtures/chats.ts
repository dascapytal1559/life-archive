// Made-up chats imported into a test archive, for tests that query it (sqlQuery.test.ts, queryWriter.test.ts).

import { type ArchiveEvent, type Db, transaction } from "../../../sdk/server.ts";
import { ImportSession } from "../server/write.ts";

/** A chat: each `from` entry is one message by that account ("Me" is the captain), a day apart from 2023-11-15 (Melbourne), each saying `text` (none by default). */
export type Chat = { id: string; type?: "direct" | "group"; members: string[]; from: string[]; selfOnly?: boolean; text?: string };

export const START = 1_700_000_000_000; // 2023-11-15 09:13 in Melbourne
export const DAY = 86_400_000;

/** `n` messages from the captain. */
export const me = (n: number): string[] => Array.from({ length: n }, () => "Me");

/** Imports `chats` on `platform` as one export, each account keyed by its name. */
export function importChats(db: Db, platform: string, chats: Chat[]): void {
  const names = new Set(["Me", ...chats.flatMap((c) => [...c.members, ...c.from])]);
  const events: ArchiveEvent[] = [...names].map((name) => ({
    kind: "account", key: name, keyKind: "name", displayName: name, ...(name === "Me" ? { isSelf: true } : {}),
  }));
  let n = 0;
  for (const chat of chats) {
    events.push({
      kind: "conversation", id: chat.id, type: chat.type ?? "direct", title: chat.id, members: ["Me", ...chat.members],
      ...(chat.selfOnly ? { selfOnly: true } : {}),
    });
    for (const sender of chat.from) {
      events.push({
        kind: "message", id: `${platform}-${chat.id}-${n}`, idKind: "platform", conversation: chat.id, sender,
        isFromSelf: sender === "Me", sentAt: START + n++ * DAY, type: "text", text: chat.text ?? "", raw: {},
      });
    }
  }
  transaction(db, () => {
    const source = Number(db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')")
      .run(platform).lastInsertRowid);
    const session = new ImportSession(db, platform, source, "export");
    for (const event of events) session.apply(event);
  });
}
