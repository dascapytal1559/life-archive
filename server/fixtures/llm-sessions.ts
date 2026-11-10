// A made-up store of Claude Code sessions in the format of ~/.claude/projects (see
// server/connectors/llm-sessions/entries.ts), for the llm-sessions connector's tests. Every text in it is made up.
//
//   <root>/-home-sample-Projects-firstmate/
//     <talk>.jsonl        a session someone was at (cli), from 23:50 on 1 March 2026 to past midnight: four prompts
//                         (one with a picture), replies with thinking and tools between their words, a background
//                         task's notice and its reply, a meta entry, a local command, Claude Code's own stand-in
//                         reply, a prompt cut off before any reply, one answered by tools alone, and a last line
//                         still being written
//     <headless>.jsonl    print mode (sdk-cli): nobody saw it
//     <elsewhere>.jsonl   run in /home/sample/Projects.firstmate, whose folder has the same name
//     <silent>.jsonl      someone was at it, but wrote nothing
//     <continued>.jsonl   the next morning, carrying on: it repeats a turn of <talk> and its last reply's line first
//     <talk>/subagents/agent-a1.jsonl   a subagent's own session: never read
//   <root>/-home-sample-Projects-other/<other>.jsonl   another project: not read unless named

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PROJECT = "/home/sample/Projects/firstmate";
export const OTHER_PROJECT = "/home/sample/Projects/other";

export const SESSIONS = {
  talk: "0a1b2c3d-0000-4000-8000-000000000001",
  headless: "0a1b2c3d-0000-4000-8000-000000000002",
  elsewhere: "0a1b2c3d-0000-4000-8000-000000000003",
  silent: "0a1b2c3d-0000-4000-8000-000000000004",
  continued: "0a1b2c3d-0000-4000-8000-000000000005",
  other: "0a1b2c3d-0000-4000-8000-000000000006",
};

/** The made-up texts, to check what reads them back and that nothing else holds them. */
export const TEXTS = {
  p1: "Plan the picnic route along the river.",
  r1a: "The river path is 4 km; start at the boathouse.",
  r1b: "Bring water.",
  p2: "What is this bird?",
  r2: "A sample kingfisher, by its colours.",
  notice: "<task-notification>the sample job is done</task-notification>",
  r3: "The sample job finished: nothing to do.",
  p3: "Thanks, and the weather?",
  p4: "One more: the café hours.",
  p5: "Next week's plan?",
  r5: "Rest on Monday, the hills on Thursday.",
  thinking: "The walker asks about a route.",
  toolOutput: "boathouse.txt\nmap.png",
  meta: "Caveat: the messages below were made by local commands.",
  command: "<command-name>/model</command-name>",
  synthetic: "No response requested.",
  writing: "Opening hours are",
};

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

type Entry = Record<string, unknown>;

/** Lines of a session, each entry with what every entry carries. */
function session(sessionId: string, cwd: string, entrypoint: string) {
  const lines: Entry[] = [];
  let version = "2.1.290";
  let n = 0;
  const uuid = (name: string) => `${sessionId.slice(-4)}-${name}`;
  const base = (at: string) => ({ parentUuid: null, isSidechain: false, userType: "external", cwd, sessionId, version, gitBranch: "main", entrypoint, timestamp: at });
  const add = (entry: Entry) => {
    lines.push(entry);
    n++;
    return entry;
  };
  return {
    lines,
    uuid,
    upgrade: (next: string) => void (version = next),
    other: (type: string, fields: Entry = {}) => add({ type, sessionId, ...fields }),
    prompt: (name: string, at: string, content: unknown) =>
      add({ ...base(at), type: "user", uuid: uuid(name), promptSource: "typed", origin: { kind: "human" }, turnOrigin: "human", message: { role: "user", content } }),
    notice: (name: string, at: string, text: string) =>
      add({ ...base(at), type: "user", uuid: uuid(name), promptSource: "system", origin: { kind: "task-notification" }, turnOrigin: "task_notification", message: { role: "user", content: text } }),
    sdk: (name: string, at: string, text: string) =>
      add({ ...base(at), type: "user", uuid: uuid(name), promptSource: "sdk", turnOrigin: "sdk", message: { role: "user", content: text } }),
    meta: (name: string, at: string, text: string) =>
      add({ ...base(at), type: "user", uuid: uuid(name), isMeta: true, message: { role: "user", content: [{ type: "text", text }] } }),
    plainUser: (name: string, at: string, text: string) => add({ ...base(at), type: "user", uuid: uuid(name), message: { role: "user", content: text } }),
    model: (name: string, at: string, model: string, block: Entry) =>
      add({ ...base(at), type: "assistant", uuid: uuid(name), requestId: `req-${n}`, message: { model, id: `msg-${name}`, type: "message", role: "assistant", content: [block], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5 } } }),
    toolResult: (name: string, at: string, text: string) =>
      add({ ...base(at), type: "user", uuid: uuid(name), toolUseResult: { stdout: text }, sourceToolAssistantUUID: uuid("tool"), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tool-${name}`, content: text }] } }),
    system: (at: string) => add({ ...base(at), type: "system", subtype: "turn_duration", durationMs: 1000, uuid: uuid(`system-${n}`) }),
  };
}

const text = (value: string) => ({ type: "text", text: value });
const tool = (name: string) => ({ type: "tool_use", id: `tool-${name}`, name: "Bash", input: { command: "ls" } });
const at = (time: string) => new Date(time).toISOString();

function jsonl(lines: Entry[], partial?: Entry): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("") + (partial ? JSON.stringify(partial).slice(0, 40) : "");
}

/** Writes the store under `root`; returns where each session file is. */
export async function writeLlmSessionsFixture(root: string): Promise<Record<keyof typeof SESSIONS, string>> {
  const folder = join(root, "-home-sample-Projects-firstmate");
  const otherFolder = join(root, "-home-sample-Projects-other");
  await mkdir(join(folder, SESSIONS.talk, "subagents"), { recursive: true });
  await mkdir(otherFolder, { recursive: true });
  const file = (id: string) => join(folder, `${id}.jsonl`);

  const talk = session(SESSIONS.talk, PROJECT, "cli");
  talk.other("permission-mode", { permissionMode: "auto" });
  talk.prompt("p1", at("2026-03-01T23:50:00+11:00"), TEXTS.p1);
  talk.model("r1-think", at("2026-03-01T23:50:05+11:00"), OPUS, { type: "thinking", thinking: TEXTS.thinking, signature: "sig" });
  talk.model("r1-tool", at("2026-03-01T23:50:06+11:00"), OPUS, tool("r1"));
  talk.toolResult("r1-result", at("2026-03-01T23:50:07+11:00"), TEXTS.toolOutput);
  talk.model("r1-a", at("2026-03-01T23:50:09+11:00"), OPUS, text(TEXTS.r1a));
  talk.model("r1-b", at("2026-03-01T23:50:10+11:00"), OPUS, text(TEXTS.r1b));
  talk.system(at("2026-03-01T23:50:11+11:00"));
  talk.other("ai-title", { aiTitle: "Picnic route" });
  talk.prompt("p2", at("2026-03-01T23:55:00+11:00"), [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }, text(TEXTS.p2)]);
  talk.model("r2", at("2026-03-01T23:55:03+11:00"), SONNET, text(TEXTS.r2));
  talk.notice("n1", at("2026-03-02T00:05:00+11:00"), TEXTS.notice);
  talk.model("r3", at("2026-03-02T00:05:02+11:00"), OPUS, text(TEXTS.r3));
  talk.meta("meta", at("2026-03-02T00:06:00+11:00"), TEXTS.meta);
  talk.plainUser("command", at("2026-03-02T00:06:01+11:00"), TEXTS.command);
  talk.model("stand-in", at("2026-03-02T00:06:30+11:00"), "<synthetic>", text(TEXTS.synthetic));
  talk.upgrade("2.1.291");
  talk.prompt("p3", at("2026-03-02T00:08:00+11:00"), TEXTS.p3);
  talk.prompt("p4", at("2026-03-02T00:09:00+11:00"), TEXTS.p4);
  talk.model("r4-tool", at("2026-03-02T00:09:05+11:00"), OPUS, tool("r4"));
  talk.toolResult("r4-result", at("2026-03-02T00:09:06+11:00"), TEXTS.toolOutput);
  const writing = { type: "assistant", uuid: talk.uuid("r4-text"), timestamp: at("2026-03-02T00:09:09+11:00"), message: { model: OPUS, content: [text(TEXTS.writing)] } };
  await writeFile(file(SESSIONS.talk), jsonl(talk.lines, writing));

  const headless = session(SESSIONS.headless, PROJECT, "sdk-cli");
  headless.sdk("s1", at("2026-03-01T22:00:00+11:00"), "Check the crew's status files.");
  headless.model("s1-r", at("2026-03-01T22:00:04+11:00"), SONNET, text("All quiet."));
  await writeFile(file(SESSIONS.headless), jsonl(headless.lines));

  const elsewhere = session(SESSIONS.elsewhere, "/home/sample/Projects.firstmate", "cli");
  elsewhere.prompt("e1", at("2026-03-01T21:00:00+11:00"), "A prompt in the other folder.");
  elsewhere.model("e1-r", at("2026-03-01T21:00:03+11:00"), OPUS, text("Answered there."));
  await writeFile(file(SESSIONS.elsewhere), jsonl(elsewhere.lines));

  const silent = session(SESSIONS.silent, PROJECT, "cli");
  silent.other("permission-mode", { permissionMode: "auto" });
  silent.meta("m", at("2026-03-01T20:00:00+11:00"), TEXTS.meta);
  await writeFile(file(SESSIONS.silent), jsonl(silent.lines));

  // Carrying on from <talk>: its second turn and its last reply's line, repeated as Claude Code repeats them, first.
  const continued = session(SESSIONS.continued, PROJECT, "cli");
  const repeated = talk.lines.filter((line) => [talk.uuid("p2"), talk.uuid("r2"), talk.uuid("r3")].includes(line.uuid as string));
  continued.lines.push(...[repeated[2], repeated[0], repeated[1]].map((line) => ({ ...line, sessionId: SESSIONS.continued })));
  continued.prompt("p5", at("2026-03-02T08:00:00+11:00"), TEXTS.p5);
  continued.model("r5", at("2026-03-02T08:00:04+11:00"), OPUS, text(TEXTS.r5));
  await writeFile(file(SESSIONS.continued), jsonl(continued.lines));

  const subagent = session(SESSIONS.talk, PROJECT, "cli");
  subagent.prompt("sub", at("2026-03-01T23:50:06+11:00"), "A subagent's task.");
  await writeFile(join(folder, SESSIONS.talk, "subagents", "agent-a1.jsonl"), jsonl(subagent.lines));

  const other = session(SESSIONS.other, OTHER_PROJECT, "cli");
  other.prompt("o1", at("2026-03-01T19:00:00+11:00"), "A prompt in another project.");
  other.model("o1-r", at("2026-03-01T19:00:02+11:00"), OPUS, text("Answered in the other project."));
  await writeFile(join(otherFolder, `${SESSIONS.other}.jsonl`), jsonl(other.lines));

  return {
    talk: file(SESSIONS.talk), headless: file(SESSIONS.headless), elsewhere: file(SESSIONS.elsewhere), silent: file(SESSIONS.silent),
    continued: file(SESSIONS.continued), other: join(otherFolder, `${SESSIONS.other}.jsonl`),
  };
}

/** Lines to add to <talk>, as Claude Code would go on writing it: the reply being written, finished, and a new prompt answered. */
export function moreOfTalk(): string {
  const talk = session(SESSIONS.talk, PROJECT, "cli");
  talk.upgrade("2.1.291");
  talk.model("r4-text", at("2026-03-02T00:09:09+11:00"), OPUS, text(TEXTS.writing));
  talk.prompt("p6", at("2026-03-02T00:20:00+11:00"), "And tomorrow?");
  talk.model("r6", at("2026-03-02T00:20:04+11:00"), OPUS, text("Sunny."));
  return jsonl(talk.lines);
}
