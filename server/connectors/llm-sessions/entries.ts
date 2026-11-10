// Claude Code's session files, as the llm-sessions connector reads them and the archive's content path
// (archive/llmContent.ts) reads them back: one JSON entry per line, a file per session,
// ~/.claude/projects/<project folder>/<session id>.jsonl, only ever added to.
//
// What is read of an entry (its text only through promptText and replyParts):
//   every entry       sessionId, uuid, timestamp (ISO), cwd, version, isSidechain, and entrypoint: how the session
//                     was run, cli (a terminal) or claude-desktop (the desktop app) when someone was at it, sdk-cli
//                     (print mode, claude -p) or sdk-ts and sdk-py (the Agent SDK) when it ran headless
//   type "user"       origin.kind: who started the turn it opens, "human" for a prompt the person wrote,
//                     "task-notification" for a background task's notice; message.content, a string or blocks
//                     (text, image). A tool's result, a meta entry and a compaction summary have no origin.
//   type "assistant"  message.model, and message.content's blocks (text, thinking, tool_use): Claude Code writes
//                     each block as an entry of its own. The model "<synthetic>" is Claude Code's own stand-in (an
//                     error, an interruption), not the model's words.
// Every other type (attachments, system notes, titles, queue operations, file snapshots) is passed over.

export type Entry = Record<string, unknown>;

/** Claude Code's model name for a reply it wrote itself rather than the model. */
export const SYNTHETIC_MODEL = "<synthetic>";

/** Whether a session was run with nobody at it: print mode or the Agent SDK. */
export function isHeadless(entrypoint: string): boolean {
  return entrypoint.startsWith("sdk");
}

/** What a user entry starts a turn by: "human" (a prompt the person wrote), another origin's word, or null for none. */
export function startedBy(entry: Entry): string | null {
  if (entry.type !== "user" || entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true) return null;
  const kind = (entry.origin as { kind?: unknown } | undefined)?.kind;
  return typeof kind === "string" && kind !== "" ? kind : null;
}

/** A prompt's text (its text blocks, a line apart) and how many pictures it holds. */
export function promptText(entry: Entry): { text: string; images: number } {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return { text: content, images: 0 };
  const blocks = Array.isArray(content) ? (content as Array<{ type?: unknown; text?: unknown }>) : [];
  return {
    text: blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n"),
    images: blocks.filter((b) => b?.type === "image").length,
  };
}

/** The model's own entry in a reply: its model, its text blocks and how many tools it called; null for anything else. */
export function replyParts(entry: Entry): { model: string | null; texts: string[]; toolCalls: number } | null {
  if (entry.type !== "assistant" || entry.isSidechain === true) return null;
  const message = entry.message as { model?: unknown; content?: unknown } | undefined;
  const model = typeof message?.model === "string" ? message.model : null;
  if (model === SYNTHETIC_MODEL) return null;
  const blocks = Array.isArray(message?.content) ? (message.content as Array<{ type?: unknown; text?: unknown }>) : [];
  return {
    model,
    texts: blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string),
    toolCalls: blocks.filter((b) => b?.type === "tool_use").length,
  };
}

/** A reply's text: its text blocks, a blank line apart. */
export function joinReply(texts: readonly string[]): string {
  return texts.join("\n\n");
}

/** How long a text is, in characters (as redact.ts counts them). */
export function charsOf(text: string): number {
  return [...text].length;
}

/** The whole lines of a file, each where it starts and how many bytes it takes, newline left out; a last line with none is still being written, and is left out. */
export function wholeLines(buffer: Buffer): Array<{ line: number; offset: number; length: number }> {
  const lines = [];
  let offset = 0;
  for (let line = 1; ; line++) {
    const end = buffer.indexOf(0x0a, offset);
    if (end === -1) return lines;
    lines.push({ line, offset, length: end - offset });
    offset = end + 1;
  }
}

/** An entry's time, in milliseconds since the epoch, or null when it has none. */
export function timeOf(entry: Entry): number | null {
  if (typeof entry.timestamp !== "string") return null;
  const at = Date.parse(entry.timestamp);
  return Number.isSafeInteger(at) ? at : null;
}
