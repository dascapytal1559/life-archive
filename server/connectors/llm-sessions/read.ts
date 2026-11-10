// Reads the captain's conversations with an LLM from Claude Code's session files, for the event index
// (archive/events.ts): each session, each prompt he wrote, and each reply he was given, by when, which model, how
// long and where in the file, never their text (entries.ts says what is read of the files).
//
// It is the Claude Code plug-in of conversations.ts, which runs it live in the archive's server and by hand as an
// import. Claude Code deletes a session file 30 days after it last changed, so the archive keeps its own copy of
// every session file it reads, byte for byte (sessionCopies.ts' mirror: data/llm/claude-code/<project folder>/<session
// id>.jsonl, only ever grown; to its last whole line, as it is read), and reads the copy: the session's file in the
// index is the copy, and a session whose file Claude Code has deleted is still read from it. Every session file is
// copied, whether the index keeps it or leaves it out.
//
// The source is Claude Code's store of sessions, ~/.claude/projects, which holds a folder per project, named by its
// path with every character but a letter or digit made "-" (/Users/me/Projects/firstmate is
// -Users-me-Projects-firstmate). Only the projects in the `projects` setting are read (llmSessions.projects
// in the archive's settings, unless said), and of each only the sessions at the top of its folder: what is in the folders
// beside them (a session's subagents, its tools' output) never is. A session is left out, and counted, when
//   - it ran headless (its entrypoint is sdk-cli, print mode, or sdk-ts or sdk-py, the Agent SDK): nobody saw it;
//   - it ran in another folder than the project (two paths can make one folder name);
//   - the captain wrote nothing in it.
//
// A turn begins at a user entry that has an origin: a prompt (origin "human"), which is an event of its own, or a
// notice Claude Code passed on (a background task's, "task-notification"). The model's entries after it, until the
// next turn begins, are its reply: an event when they hold any text, from the first entry to the last, with the
// model that wrote most of them and how many tools they called. A prompt's model is its reply's.
//
// Everything is keyed on Claude Code's own ids (the session's id, each prompt's entry id, each reply's first entry
// id), so importing again adds only what is new, and a session still going on is brought up to date. A file is
// read to its last whole line: one still being written is read to where it had got. An entry another session's file
// repeats (a continued session) is kept with the session that has it first.

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type ConversationSource, conversationConnector, filesIn, type Folder, type ReadSession, type Tally } from "../conversations.ts";
import type { LlmTurnEvent } from "../contract.ts";
import { expandHome } from "../lines.ts";
import { mirror, sizeOf } from "../sessionCopies.ts";
import { charsOf, type Entry, isHeadless, joinReply, promptText, replyParts, startedBy, timeOf, wholeLines } from "./entries.ts";
import { manifest } from "./manifest.ts";
import { settings } from "../../settings.ts";

/** The Claude Code plug-in (conversations.ts): one folder per project, a session file each, copied byte for byte. */
export const claudeCode: ConversationSource<ProjectFolder> = {
  folders: (root, config) => projectsOf(config).map((project) => ({ path: join(root, projectFolder(project)), project })),
  async conversations(folder, copiesDir, names) {
    const copies = join(copiesDir, projectFolder(folder.project));
    // Every session file in Claude Code's folder, and every one the archive has a copy of, gone from there or not.
    const all = names?.filter(isSessionFile) ?? [...new Set([...await filesIn(folder.path, isSessionFile), ...await filesIn(copies, isSessionFile)])];
    const conversations = [];
    for (const name of all.sort()) {
      const source = join(folder.path, name);
      const copy = join(copies, name);
      if ((await sizeOf(source)) !== null) conversations.push({ source, copy });
      else if ((await sizeOf(copy)) !== null) conversations.push({ source: null, copy });
    }
    return conversations;
  },
  keep: ({ source, copy }, { thorough }) => mirror(source, copy, { wholeLines: true, thorough }),
  read: async (copy, content, folder, tally) => {
    const read = readSession(copy, content, folder.project, tally);
    return typeof read === "string" ? read : [read];
  },
};

export const llmSessions = conversationConnector(manifest, claudeCode);

interface ProjectFolder extends Folder {
  /** The project's folder, absolute, whose sessions these are. */
  project: string;
}

const isSessionFile = (name: string) => name.endsWith(".jsonl");

/** Claude Code's folder for a project's sessions: its path with every character but a letter or digit made "-". */
export function projectFolder(project: string): string {
  return project.replace(/[^A-Za-z0-9]/g, "-");
}


/** A reply being gathered: the turn's start, and the model's entries so far. */
interface Gathering {
  answers: string;
  /** The prompt that started it, if the captain's. */
  prompt?: LlmTurnEvent;
  first?: { id: string; line: number; offset: number; at: number };
  end: number;
  endAt: number;
  texts: string[];
  toolCalls: number;
  models: Map<string, number>;
}

/** One session file: its session and turns, or why it is left out (a tally's name). The LLM warehouse asks it which sessions are this connector's (server/llm/claude.ts). */
export function readSession(file: string, buffer: Buffer, project: string, tally: Tally): ReadSession | string {
  const entries: Array<{ entry: Entry; line: number; offset: number; length: number }> = [];
  let notJson = 0;
  const lines = wholeLines(buffer);
  for (const place of lines) {
    try {
      const entry = JSON.parse(buffer.toString("utf8", place.offset, place.offset + place.length)) as unknown;
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) entries.push({ entry: entry as Entry, ...place });
      else notJson++;
    } catch {
      notJson++;
    }
  }
  tally("lines that are not a JSON entry, passed over", notJson);
  const last = lines.at(-1);
  const bytes = last ? last.offset + last.length + 1 : 0;

  const first = <T>(read: (entry: Entry) => T | undefined): T | undefined => {
    for (const { entry } of entries) {
      const value = read(entry);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const text = (key: string) => (entry: Entry) => (typeof entry[key] === "string" && entry[key] !== "" ? (entry[key] as string) : undefined);
  const entrypoint = first(text("entrypoint"));
  if (entrypoint === undefined) return "sessions that do not say how they were run, left out";
  if (isHeadless(entrypoint)) return `sessions run headless (${entrypoint}), left out`;
  if (first(text("cwd")) !== project) return "sessions run in another folder, left out";

  const turns: LlmTurnEvent[] = [];
  const models = new Map<string, number>();
  let startedAt = Infinity;
  let endedAt = -Infinity;
  let noId = 0;
  let current: Gathering | null = null;
  /** Ends the turn being gathered: its reply is an event when it holds any text. */
  const flush = () => {
    if (current?.first && current.texts.length > 0) {
      const model = mostOf(current.models);
      turns.push({
        kind: "llm-turn", id: current.first.id, session: "", role: "reply", answers: current.answers,
        ...(current.prompt ? { replyTo: current.prompt.id } : {}),
        at: current.first.at, endAt: current.endAt, ...(model ? { model } : {}), chars: charsOf(joinReply(current.texts)),
        toolCalls: current.toolCalls, line: current.first.line, offset: current.first.offset, length: current.end - current.first.offset,
      });
      if (current.prompt && model) current.prompt.model = model;
    } else if (current) {
      tally("turns with no reply text");
    }
    current = null;
  };
  for (const { entry, line, offset, length } of entries) {
    const at = timeOf(entry);
    const id = typeof entry.uuid === "string" && entry.uuid !== "" ? entry.uuid : null;
    if (at !== null) {
      startedAt = Math.min(startedAt, at);
      endedAt = Math.max(endedAt, at);
    }
    const by = startedBy(entry);
    if (by !== null) {
      flush();
      if (id === null || at === null) {
        noId++;
        continue;
      }
      current = { answers: by, end: 0, endAt: at, texts: [], toolCalls: 0, models: new Map() };
      if (by === "human") {
        const { text, images } = promptText(entry);
        current.prompt = { kind: "llm-turn", id, session: "", role: "prompt", at, chars: charsOf(text), images, line, offset, length };
        turns.push(current.prompt);
      }
      continue;
    }
    if (entry.type !== "assistant" || entry.isSidechain === true) continue;
    const parts = replyParts(entry);
    if (parts === null) {
      tally("Claude Code's own stand-in replies, left out");
      continue;
    }
    if (!current) {
      tally("replies before anything started a turn, left out");
      continue;
    }
    if (id === null || at === null) {
      noId++;
      continue;
    }
    current.first ??= { id, line, offset, at };
    current.end = offset + length;
    current.endAt = Math.max(current.endAt, at);
    current.texts.push(...parts.texts);
    current.toolCalls += parts.toolCalls;
    if (parts.model) {
      current.models.set(parts.model, (current.models.get(parts.model) ?? 0) + 1);
      models.set(parts.model, (models.get(parts.model) ?? 0) + 1);
    }
  }
  flush();
  tally("entries with no id or time, passed over", noId);
  if (!turns.some((t) => t.role === "prompt")) return "sessions with no prompt from the captain, left out";

  const id = basename(file, ".jsonl");
  const version = [...entries].reverse().map(({ entry }) => text("version")(entry)).find((v) => v !== undefined);
  const model = mostOf(models);
  return {
    event: {
      kind: "llm-session", id, entrypoint, project, file,
      ...(version ? { version } : {}), ...(model ? { model } : {}),
      startedAt, endedAt, bytes,
    },
    turns: turns.map((turn) => ({ ...turn, session: id })),
  };
}

/** The projects to read, absolute, from the `projects` setting (a list of folders, ~ for home), else llmSessions.projects in the archive's settings. */
export function projectsOf(config: Record<string, unknown>): string[] {
  const named = config.projects ?? settings().llmSessions.projects;
  if (!Array.isArray(named) || named.length === 0 || !named.every((p) => typeof p === "string" && p !== "")) {
    throw new Error("the projects setting must be a list of folders, such as [\"~/Projects/my-project\"]");
  }
  return named.map((path) => resolve(homedir(), expandHome(path)));
}

/** The key seen most often (the first of those seen as often), or undefined for none. */
function mostOf(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  for (const [key, n] of counts) if (best === undefined || n > counts.get(best)!) best = key;
  return best;
}
