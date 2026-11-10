// What the archive reads of Grok Bot's conversations, shared by the connector (read.ts) and the content path
// (archive/llmContent.ts), which must agree on every turn's text.
//
// The Grok Bot desktop app keeps its state in ~/Library/Application Support/Grok Bot/sand-client-persistence/, one
// .blob file (JSON) per key, the file named by the key in unpadded lowercase base32. A bot's chat is the key
// sand.client.slice.account.<account>.transcript.replicas.<bot id>, whose value is { schemaVersion: 1, value: {
// entries: [...] } }: its last 200 entries, the file written whole on each change, so older ones drop out within a
// day or two. Only those, and the bots' names (…roster.last-roster: value.rows[], each { id, name }), are read:
// never a draft, the settings, or the secrets and sign-in files beside the folder. The format is the app's own cache,
// undocumented: anything the archive does not know is refused, never guessed at.
//
// The archive's copy of a bot's chat (read.ts) is a log, one entry a line, as the app had it, each entry again only
// when it changed; an entry's last line is the one read. Its entries (each with an `id`, unique in the chat, and an
// increasing `seq`), in order of seq, are on three surfaces, each a session of the index:
//   - the chat window ("chat", the bot's id): a `message` from the captain (role user), typed in the chat, is a
//     prompt; one from another agent (role user, `fromAgent`) is a notice that starts a turn ("agent"); the bot's
//     `send-message` entries (its words, a widget's question, a file, an approval, a request for a secret, an
//     email it drafted or a connector's card ({ connector, serverId, variant }, none of them read), the words being
//     message.content or the widget's prompt; an email draft has none, its subject, recipients and text never read,
//     so a reply that is only a draft is a turn with no words) and its messages to other agents (role assistant) are
//     the reply to what started the turn;
//   - backstage on a call ("backstage", one session for each call's channel, voice:<call id>): the same, for entries
//     on a channel: the call agent passing the captain's words to the bot (a prompt), and the bot's answers to it;
//   - a call ("call", one session for each finished call, a `voice-call` entry): its transcript, conversation.turns,
//     each { id, speaker, text, atMs }: the captain's words (speaker user, his streamed partials joined into one
//     prompt, as rituals' voice calls do) and the bot's (speaker assistant, those in a row one reply).
// A reply whose turn began before the archive's copy did answers "unseen"; one at the start of a call, "call-start".
// The captain's attachments (`user-attachment`) and the app's notes are no turn: its `event`s, and its `notice`s, a
// line of the app's own ({ text }, no role or author: that a background task was stopped, say) set among a reply's
// entries. A notice's text stays in the copy, as every entry's does.

/** One line of a copy's log: an entry, and where its line is. */
export interface LogLine {
  entry: Entry;
  line: number;
  offset: number;
  length: number;
}

export type Entry = Record<string, unknown>;

/** A turn, with its text: the connector keeps only its length, the content path its text. */
export interface GrokTurn {
  id: string;
  session: string;
  role: "prompt" | "reply";
  answers?: string;
  replyTo?: string;
  at: number;
  endAt?: number;
  text: string;
  line: number;
  offset: number;
  length: number;
}

export interface GrokSession {
  id: string;
  /** chat, backstage or call. */
  surface: "chat" | "backstage" | "call";
  startedAt: number;
  endedAt: number;
  turns: GrokTurn[];
}

const ENTRY_KINDS = ["message", "send-message", "voice-call", "user-attachment", "event", "notice"];
const MESSAGE_TYPES = ["text", "widget", "attachment", "auto-review-approval", "secret-request", "email-draft", "connector"];

/** The bot's id in a blob's key when the key is a bot's chat, else null. */
export function chatOf(key: string): string | null {
  return /^sand\.client\.slice\.account\.[^.]+\.transcript\.replicas\.([A-Za-z0-9-]+)$/.exec(key)?.[1] ?? null;
}

/** Whether a key is the bots' roster. */
export function isRoster(key: string): boolean {
  return /^sand\.client\.slice\.account\.[^.]+\.roster\.last-roster$/.test(key);
}

/** A blob's key from its file name (unpadded lowercase base32, then .blob), or null when it is none. */
export function keyOf(name: string): string | null {
  if (!name.endsWith(".blob")) return null;
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of name.slice(0, -".blob".length)) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
}

/** A blob file's name for a key (for tests and fixtures). */
export function blobName(key: string): string {
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of new TextEncoder().encode(key)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return `${out}.blob`;
}

/** A chat blob's entries, or what about it is not as the archive knows it (never quoting a value). */
export function entriesOf(blob: unknown): Entry[] | { refused: string } {
  const object = (v: unknown): v is Entry => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!object(blob) || blob.schemaVersion !== 1 || !object(blob.value) || !Array.isArray(blob.value.entries)) {
    return { refused: "a chat whose file is not as the archive knows it (schemaVersion 1, value.entries)" };
  }
  for (const entry of blob.value.entries) {
    if (!object(entry) || typeof entry.id !== "string" || entry.id === "" || typeof entry.seq !== "number") {
      return { refused: "a chat with an entry that has no id or seq" };
    }
  }
  return blob.value.entries as Entry[];
}

/**
 * A chat's sessions and turns from its log's lines (see the top of this file), or why it is not read: an entry the
 * archive does not know, named by its kind or type only.
 */
export function sessionsOf(bot: string, lines: LogLine[]): GrokSession[] | { refused: string } {
  const latest = new Map<string, LogLine>();
  for (const line of lines) latest.set(line.entry.id as string, line);
  const ordered = [...latest.values()].sort((a, b) => (a.entry.seq as number) - (b.entry.seq as number));
  for (const { entry } of ordered) {
    const unknown = unknownIn(entry);
    if (unknown) return { refused: `a chat with ${unknown}` };
  }

  const surfaces = new Map<string, LogLine[]>();
  const calls: LogLine[] = [];
  for (const line of ordered) {
    const { entry } = line;
    if (entry.kind === "voice-call") calls.push(line);
    if (entry.kind !== "message" && entry.kind !== "send-message") continue;
    const channel = entry.kind === "message" ? entry.channel : (entry.message as Entry).channel;
    const surface = typeof channel === "string" && channel !== "" ? `${bot}/${channel}` : bot;
    surfaces.set(surface, [...(surfaces.get(surface) ?? []), line]);
  }
  const sessions: GrokSession[] = [];
  for (const [id, lines] of surfaces) {
    const turns = chatTurns(bot, id, lines);
    if (turns.length === 0) continue;
    const times = lines.map((l) => l.entry.timestampMs as number);
    sessions.push({ id, surface: id === bot ? "chat" : "backstage", startedAt: Math.min(...times), endedAt: Math.max(...times), turns });
  }
  for (const line of calls) {
    const call = line.entry.call as Entry;
    if (typeof call.endedAtMs !== "number") continue;
    const id = `${bot}/${call.callId as string}`;
    const turns = callTurns(id, line);
    const endedAt = call.endedAtMs;
    const startedAt = Math.min(turns[0]?.at ?? endedAt, typeof call.durationMs === "number" ? endedAt - call.durationMs : endedAt);
    sessions.push({ id, surface: "call", startedAt, endedAt: Math.max(endedAt, ...turns.map((t) => t.endAt ?? t.at)), turns });
  }
  return sessions;
}

/** What in an entry the archive does not know, in words naming kinds and fields only; null when it knows it all. */
function unknownIn(entry: Entry): string | null {
  const kind = entry.kind;
  if (typeof kind !== "string" || !ENTRY_KINDS.includes(kind)) return `an entry of a kind the archive does not know (${String(kind).slice(0, 40)})`;
  if (typeof entry.timestampMs !== "number") return `a ${kind} entry with no time`;
  if (kind === "message") {
    if (entry.role !== "user" && entry.role !== "assistant") return "a message from neither the user nor the assistant";
    if (typeof entry.content !== "string") return "a message with no text";
  }
  if (kind === "send-message") {
    const message = entry.message as Entry | undefined;
    if (typeof message !== "object" || message === null) return "a send-message with no message";
    if (typeof message.type !== "string" || !MESSAGE_TYPES.includes(message.type)) {
      return `a send-message of a type the archive does not know (${String(message.type).slice(0, 40)})`;
    }
    if (message.type === "text" && typeof message.content !== "string") return "a text send-message with no text";
  }
  if (kind === "notice" && typeof entry.text !== "string") return "a notice with no text";
  if (kind === "voice-call") {
    const call = entry.call as Entry | undefined;
    const turns = (entry.conversation as Entry | undefined)?.turns;
    if (typeof call !== "object" || call === null || typeof call.callId !== "string" || call.callId === "") return "a voice-call with no call id";
    if (!Array.isArray(turns)) return "a voice-call with no turns";
    for (const turn of turns as Entry[]) {
      if (typeof turn?.id !== "string" || (turn.speaker !== "user" && turn.speaker !== "assistant") || typeof turn.text !== "string" || typeof turn.atMs !== "number") {
        return "a voice-call turn that is not as the archive knows it (id, speaker user or assistant, text, atMs)";
      }
    }
  }
  return null;
}

/** The words of an entry on a chat surface: its text, a widget's question, or none. */
function wordsOf(entry: Entry): string | null {
  if (entry.kind === "message") return entry.content as string;
  const message = entry.message as Entry;
  if (message.type === "text") return message.content as string;
  if (message.type === "widget") {
    const prompt = (message.widget as Entry | undefined)?.prompt;
    return typeof prompt === "string" ? prompt : null;
  }
  return null;
}

/** Whether a line is the bot's email draft. */
function isEmailDraft(line: LogLine): boolean {
  return line.entry.kind === "send-message" && (line.entry.message as Entry).type === "email-draft";
}

/** A chat surface's turns (see the top of this file). */
function chatTurns(bot: string, session: string, lines: LogLine[]): GrokTurn[] {
  const turns: GrokTurn[] = [];
  let reply: { first: LogLine; parts: LogLine[]; texts: string[]; answers: string; replyTo?: string } | null = null;
  let answers = "unseen";
  let prompt: string | undefined;
  const flush = () => {
    if (reply && (reply.texts.length > 0 || reply.parts.some(isEmailDraft))) {
      const start = Math.min(...reply.parts.map((p) => p.offset));
      const end = Math.max(...reply.parts.map((p) => p.offset + p.length));
      const times = reply.parts.map((p) => p.entry.timestampMs as number);
      turns.push({
        id: `${bot}/${reply.first.entry.id as string}`, session, role: "reply", answers: reply.answers,
        ...(reply.replyTo ? { replyTo: reply.replyTo } : {}),
        at: Math.min(...times), endAt: Math.max(...times), text: reply.texts.join("\n\n"),
        line: reply.parts.find((p) => p.offset === start)!.line, offset: start, length: end - start,
      });
    }
    reply = null;
  };
  for (const line of lines) {
    const { entry } = line;
    const starts = entry.kind === "message" && entry.role === "user";
    if (starts) {
      flush();
      if (entry.fromAgent) {
        answers = "agent";
        prompt = undefined;
      } else {
        answers = "human";
        prompt = `${bot}/${entry.id as string}`;
        turns.push({ id: prompt, session, role: "prompt", at: entry.timestampMs as number, text: entry.content as string, line: line.line, offset: line.offset, length: line.length });
      }
      continue;
    }
    reply ??= { first: line, parts: [], texts: [], answers, ...(prompt ? { replyTo: prompt } : {}) };
    reply.parts.push(line);
    const words = wordsOf(entry);
    if (words !== null && words !== "") reply.texts.push(words);
  }
  flush();
  return turns;
}

/** A call's turns from its voice-call entry (see the top of this file). */
function callTurns(session: string, line: LogLine): GrokTurn[] {
  const spoken = ((line.entry.conversation as Entry).turns as Array<{ id: string; speaker: string; text: string; atMs: number }>)
    .toSorted((a, b) => a.atMs - b.atMs);
  const place = { line: line.line, offset: line.offset, length: line.length };
  const turns: GrokTurn[] = [];
  let prompt: string | undefined;
  for (let i = 0; i < spoken.length; i++) {
    const turn = spoken[i];
    if (turn.speaker === "user") {
      // The captain's streamed partials, each a longer telling of the one before, are one prompt: the last's words, the first's time.
      let last = i;
      while (spoken[last + 1]?.speaker === "user" && extendsTurn(spoken[last].text, spoken[last + 1].text)) last++;
      prompt = `${session}/${spoken[last].id}`;
      turns.push({ id: prompt, session, role: "prompt", at: turn.atMs, text: spoken[last].text, ...place });
      i = last;
      continue;
    }
    let last = i;
    while (spoken[last + 1]?.speaker === "assistant") last++;
    const said = spoken.slice(i, last + 1);
    turns.push({
      id: `${session}/${turn.id}`, session, role: "reply", answers: prompt ? "human" : "call-start", ...(prompt ? { replyTo: prompt } : {}),
      at: turn.atMs, endAt: spoken[last].atMs, text: said.map((t) => t.text).join("\n\n"), ...place,
    });
    i = last;
  }
  return turns;
}

/**
 * Whether user turn `b` is a later streamed telling of user turn `a`: longer, and agreeing with `a` but for a short
 * revised tail (the transcriber rewrites its last few words as speech goes on). As the journal's Grok calls job has it (modules/journal/jobs/grok-calls/format.ts).
 */
export function extendsTurn(a: string, b: string): boolean {
  if (b.length < a.length) return false;
  let common = 0;
  while (common < a.length && a[common] === b[common]) common += 1;
  const tail = a.slice(common).trim();
  return common * 2 >= a.length && (tail === "" || tail.split(/\s+/).length <= 8);
}

/** The lines of a log: each whole line that is a JSON entry with an id and seq (a line cut short by a crash is passed over). */
export function logLines(content: Buffer): LogLine[] {
  const lines: LogLine[] = [];
  let offset = 0;
  let line = 0;
  while (offset < content.length) {
    const end = content.indexOf(0x0a, offset);
    if (end === -1) break;
    line++;
    try {
      const entry = JSON.parse(content.toString("utf8", offset, end)) as unknown;
      if (typeof entry === "object" && entry !== null && typeof (entry as Entry).id === "string" && typeof (entry as Entry).seq === "number") {
        lines.push({ entry: entry as Entry, line, offset, length: end - offset });
      }
    } catch {
      // Not a whole entry: a line cut short.
    }
    offset = end + 1;
  }
  return lines;
}
