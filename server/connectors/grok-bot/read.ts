// Reads the captain's conversations with his Grok Bot bots, from the desktop app's cache, for the event index: the
// Grok Bot plug-in (conversations.ts). entries.ts says what is read of the cache, and how a chat becomes sessions and
// turns, never their text.
//
// The cache keeps only each bot's last 200 entries, so the archive keeps its own copy of every bot's chat as a log
// (data/llm/grok-bot/<bot id>.jsonl, sessionCopies.ts): each entry it has not seen is added as a line, as the app had
// it, and an entry the app changed (a reply that was still streaming, say) is added again; nothing in the log is ever
// changed or taken out, so an entry the app has dropped stays. The log is what is read.

import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { atomicWrite } from "../../files.ts";
import { type Conversation, conversationConnector, type ConversationSource, filesIn, type ReadSession } from "../conversations.ts";
import { charsOf } from "../llm-sessions/entries.ts";
import { appendFlushed, type CopyOutcome, sizeOf } from "../sessionCopies.ts";
import { chatOf, type Entry, entriesOf, isRoster, keyOf, logLines, sessionsOf } from "./entries.ts";
import { manifest } from "./manifest.ts";

export const grokBotChats: ConversationSource = {
  folders: (root) => [{ path: root }],
  async conversations(folder, copiesDir, names) {
    const chats = new Map<string, string>();
    for (const name of names ?? await filesIn(folder.path, (n) => n.endsWith(".blob"))) {
      const key = keyOf(name);
      const bot = key === null ? null : chatOf(key);
      if (bot) chats.set(bot, join(folder.path, name));
    }
    const conversations: Conversation[] = [];
    const copyOf = (bot: string) => join(copiesDir, `${bot}.jsonl`);
    for (const [bot, blob] of chats) {
      if ((await sizeOf(blob)) !== null) conversations.push({ source: blob, copy: copyOf(bot) });
      else if ((await sizeOf(copyOf(bot))) !== null) conversations.push({ source: null, copy: copyOf(bot) });
    }
    // Every bot the archive has a copy of whose chat the app no longer has.
    if (!names) {
      for (const name of await filesIn(copiesDir, (n) => n.endsWith(".jsonl"))) {
        if (!chats.has(basename(name, ".jsonl"))) conversations.push({ source: null, copy: join(copiesDir, name) });
      }
    }
    return conversations.sort((a, b) => a.copy.localeCompare(b.copy));
  },
  keep: ({ source, copy }) => keepLog(source, copy),
  async read(copy, content, folder) {
    const bot = basename(copy, ".jsonl");
    const sessions = sessionsOf(bot, logLines(content));
    if ("refused" in sessions) return sessions;
    const project = (await botNames(folder.path)).get(bot) ?? bot;
    return sessions.map((session): ReadSession => ({
      event: {
        kind: "llm-session", id: session.id, entrypoint: session.surface, project, file: copy,
        startedAt: session.startedAt, endedAt: session.endedAt, bytes: content.length,
      },
      turns: session.turns.map(({ text, ...turn }) => ({ kind: "llm-turn", ...turn, chars: charsOf(text) })),
    }));
  },
};

export const grokBot = conversationConnector(manifest, grokBotChats);

/** Adds each entry of the chat at `blob` the log at `log` does not have as it is now; what became of the log, or why it could not. */
async function keepLog(blob: string, log: string): Promise<{ outcome: CopyOutcome; bytes: number } | string | { refused: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(blob, "utf8"));
  } catch {
    // Written whole on each change: one caught being written (or gone between the listing and the reading) is read next time.
    return "chats being written as they were read, left for the next pass";
  }
  const entries = entriesOf(parsed);
  if ("refused" in entries) return entries;
  const had = await readFile(log).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const seen = new Map<string, string>();
  for (const { entry } of had ? logLines(had) : []) seen.set(entry.id as string, JSON.stringify(entry));
  const added = entries.filter((entry: Entry) => seen.get(entry.id as string) !== JSON.stringify(entry)).map((entry) => `${JSON.stringify(entry)}\n`).join("");
  if (had === null) {
    await mkdir(dirname(log), { recursive: true });
    await atomicWrite(log, added);
    return { outcome: "new", bytes: Buffer.byteLength(added) };
  }
  if (added === "") return { outcome: "same", bytes: had.length };
  // A line cut short by a crash is left, and passed over when read: what follows starts on a line of its own.
  await appendFlushed(log, had.length > 0 && had[had.length - 1] !== 0x0a ? `\n${added}` : added);
  return { outcome: "grown", bytes: (await sizeOf(log))! };
}

/** The bots' names, by id, from the app's roster in the cache folder (none when it has none). */
async function botNames(folder: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const name of await filesIn(folder, (n) => n.endsWith(".blob"))) {
    const key = keyOf(name);
    if (key === null || !isRoster(key)) continue;
    try {
      const roster = JSON.parse(await readFile(join(folder, name), "utf8")) as { value?: { rows?: unknown } };
      for (const row of Array.isArray(roster.value?.rows) ? roster.value.rows : []) {
        const { id, name: botName } = (row ?? {}) as Entry;
        if (typeof id === "string" && typeof botName === "string" && botName !== "") names.set(id, botName);
      }
    } catch {
      // A roster being written: the bots go by their ids this time.
    }
  }
  return names;
}
