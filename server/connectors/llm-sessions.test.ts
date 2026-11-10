import { appendFile, mkdtemp, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moreOfTalk, OTHER_PROJECT, PROJECT, SESSIONS, TEXTS, writeLlmSessionsFixture } from "../fixtures/llm-sessions.ts";
import { runPromise } from "../effectRuntime.ts";
import { type ConnectorEvent, validateEvent } from "./contract.ts";
import { llmSessions, projectFolder } from "./llm-sessions/read.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-llm-sessions-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Where the archive keeps its copies of the sessions, and its copy of one in the project's folder. */
const copies = () => join(dir, "data", "llm", "claude-code");
const copyOf = (session: string) => join(copies(), "-home-sample-Projects-firstmate", `${session}.jsonl`);

async function read(config: Record<string, unknown> = { projects: [PROJECT] }) {
  const events: ConnectorEvent[] = [];
  await runPromise(llmSessions.history({ sources: [join(dir, "store")], config, mediaDir: join(dir, "media"), copiesDir: copies(), emit: async (event) => void events.push(event) }));
  const of = <K extends ConnectorEvent["kind"]>(kind: K) => events.filter((e): e is Extract<ConnectorEvent, { kind: K }> => e.kind === kind);
  return { events, of, tallies: Object.fromEntries(of("tally").map((t) => [t.name, t.count])) };
}

const ms = (time: string) => Date.parse(time);
const uuid = (session: string, name: string) => `${session.slice(-4)}-${name}`;
const chars = (text: string) => [...text].length;

describe("llm-sessions", () => {
  it("names a project's folder as Claude Code does: every character but a letter or digit made a dash", () => {
    expect(projectFolder("/home/sample/Projects/firstmate")).toBe("-home-sample-Projects-firstmate");
    expect(projectFolder("/home/sample/.treehouse/friend-map-2ba474/3/friend-map")).toBe("-home-sample--treehouse-friend-map-2ba474-3-friend-map");
  });

  it("reads only the sessions someone was at, in the named project's folder, never a subagent's", async () => {
    const files = await writeLlmSessionsFixture(join(dir, "store"));
    const { events, of, tallies } = await read();
    expect(of("device")).toEqual([{ kind: "device", key: `computer:${hostname()}`, name: hostname().replace(/\.local$/, ""), deviceKind: "computer" }]);
    expect(of("llm-session").map((s) => s.id)).toEqual([SESSIONS.talk, SESSIONS.continued]);
    expect(of("llm-session")[0]).toEqual({
      // Read from the archive's copy of its file.
      kind: "llm-session", id: SESSIONS.talk, entrypoint: "cli", device: `computer:${hostname()}`, project: PROJECT, file: copyOf(SESSIONS.talk),
      // The version it last wrote, and the model most of its replies came from.
      version: "2.1.291", model: "claude-opus-5-5",
      startedAt: ms("2026-03-01T23:50:00+11:00"), endedAt: ms("2026-03-02T00:09:06+11:00"),
      // To its last whole line: the one still being written is left for the next import.
      bytes: (await readFile(files.talk)).lastIndexOf(0x0a) + 1,
    });
    expect(tallies).toEqual({
      // Every session file at the top of the project's folder, those left out too, never a subagent's.
      "conversations copied into the archive": 5,
      "sessions run headless (sdk-cli), left out": 1,
      "sessions run in another folder, left out": 1,
      "sessions with no prompt from the captain, left out": 1,
      "Claude Code's own stand-in replies, left out": 1,
      // The prompt cut off before any reply, and the one answered by tools alone (its words still being written).
      "turns with no reply text": 2,
      // <continued> repeats <talk>'s last reply's line before anything starts a turn, and then its second turn.
      "replies before anything started a turn, left out": 1,
      "turns another session has already, left out": 2,
    });
  });

  it("makes each prompt and reply a turn: when, which model, how long, and where its lines are, never its text", async () => {
    const files = await writeLlmSessionsFixture(join(dir, "store"));
    const { events, of } = await read();
    const talk = (name: string) => uuid(SESSIONS.talk, name);
    expect(of("llm-turn").map(({ id, session, role, answers, replyTo, at, endAt, model, chars, images, toolCalls, line }) =>
      ({ id, session, role, answers, replyTo, at, endAt, model, chars, images, toolCalls, line }))).toEqual([
      { id: talk("p1"), session: SESSIONS.talk, role: "prompt", answers: undefined, replyTo: undefined, at: ms("2026-03-01T23:50:00+11:00"), endAt: undefined, model: "claude-opus-5-5", chars: chars(TEXTS.p1), images: 0, toolCalls: undefined, line: 2 },
      // Its thinking and tools are on its way: its text is its two text blocks, a blank line apart.
      { id: talk("r1-think"), session: SESSIONS.talk, role: "reply", answers: "human", replyTo: talk("p1"), at: ms("2026-03-01T23:50:05+11:00"), endAt: ms("2026-03-01T23:50:10+11:00"), model: "claude-opus-5-5", chars: chars(`${TEXTS.r1a}\n\n${TEXTS.r1b}`), images: undefined, toolCalls: 1, line: 3 },
      { id: talk("p2"), session: SESSIONS.talk, role: "prompt", answers: undefined, replyTo: undefined, at: ms("2026-03-01T23:55:00+11:00"), endAt: undefined, model: "claude-sonnet-5-5", chars: chars(TEXTS.p2), images: 1, toolCalls: undefined, line: 10 },
      { id: talk("r2"), session: SESSIONS.talk, role: "reply", answers: "human", replyTo: talk("p2"), at: ms("2026-03-01T23:55:03+11:00"), endAt: ms("2026-03-01T23:55:03+11:00"), model: "claude-sonnet-5-5", chars: chars(TEXTS.r2), images: undefined, toolCalls: 0, line: 11 },
      // A reply to a background task's notice, which is no prompt.
      { id: talk("r3"), session: SESSIONS.talk, role: "reply", answers: "task-notification", replyTo: undefined, at: ms("2026-03-02T00:05:02+11:00"), endAt: ms("2026-03-02T00:05:02+11:00"), model: "claude-opus-5-5", chars: chars(TEXTS.r3), images: undefined, toolCalls: 0, line: 13 },
      // Prompts with no reply text have no model.
      { id: talk("p3"), session: SESSIONS.talk, role: "prompt", answers: undefined, replyTo: undefined, at: ms("2026-03-02T00:08:00+11:00"), endAt: undefined, model: undefined, chars: chars(TEXTS.p3), images: 0, toolCalls: undefined, line: 17 },
      { id: talk("p4"), session: SESSIONS.talk, role: "prompt", answers: undefined, replyTo: undefined, at: ms("2026-03-02T00:09:00+11:00"), endAt: undefined, model: undefined, chars: chars(TEXTS.p4), images: 0, toolCalls: undefined, line: 18 },
      { id: uuid(SESSIONS.continued, "p5"), session: SESSIONS.continued, role: "prompt", answers: undefined, replyTo: undefined, at: ms("2026-03-02T08:00:00+11:00"), endAt: undefined, model: "claude-opus-5-5", chars: chars(TEXTS.p5), images: 0, toolCalls: undefined, line: 4 },
      { id: uuid(SESSIONS.continued, "r5"), session: SESSIONS.continued, role: "reply", answers: "human", replyTo: uuid(SESSIONS.continued, "p5"), at: ms("2026-03-02T08:00:04+11:00"), endAt: ms("2026-03-02T08:00:04+11:00"), model: "claude-opus-5-5", chars: chars(TEXTS.r5), images: undefined, toolCalls: 0, line: 5 },
    ]);
    // Each turn's bytes are its lines in its session's file: from its first entry to its reply's last.
    const file = { [SESSIONS.talk]: await readFile(copyOf(SESSIONS.talk)), [SESSIONS.continued]: await readFile(copyOf(SESSIONS.continued)) };
    for (const turn of of("llm-turn")) {
      const lines = file[turn.session].subarray(turn.offset, turn.offset + turn.length).toString("utf8").split("\n");
      expect(JSON.parse(lines[0]).uuid, turn.id).toBe(turn.id);
      expect(lines.length, turn.id).toBe(turn.role === "prompt" ? 1 : turn.id === talk("r1-think") ? 5 : 1);
    }
    // No text of any session's, anywhere.
    const written = JSON.stringify(events);
    for (const [name, value] of Object.entries(TEXTS)) expect(written.includes(value), name).toBe(false);
    for (const event of events) expect(validateEvent(event), event.kind).toEqual({ event });
  });

  it("reads every project the settings name, and refuses a setting that is no list of folders", async () => {
    await writeLlmSessionsFixture(join(dir, "store"));
    // Every project's sessions, by when they began.
    expect((await read({ projects: [PROJECT, OTHER_PROJECT] })).of("llm-session").map((s) => s.id)).toEqual([SESSIONS.other, SESSIONS.talk, SESSIONS.continued]);
    expect((await read({ projects: ["/home/sample/Projects/none"] })).tallies).toEqual({ "folders with no conversations": 1 });
    await expect(read({ projects: "~/Projects/firstmate" })).rejects.toThrow(/the projects setting must be a list of folders/);
  });

  it("keeps a copy of every session file, and reads a session from it once Claude Code has deleted the file", async () => {
    const files = await writeLlmSessionsFixture(join(dir, "store"));
    const first = await read();
    // Each copy is its file to its last whole line, the one still being written left for the next import.
    for (const session of [SESSIONS.talk, SESSIONS.headless, SESSIONS.elsewhere, SESSIONS.silent, SESSIONS.continued]) {
      const source = await readFile(join(dir, "store", "-home-sample-Projects-firstmate", `${session}.jsonl`));
      expect(await readFile(copyOf(session)), session).toEqual(source.subarray(0, source.lastIndexOf(0x0a) + 1));
    }
    // Never a subagent's, nor a project not named.
    expect(await readdir(join(copies(), "-home-sample-Projects-firstmate"))).toHaveLength(5);
    expect(await readdir(copies())).toEqual(["-home-sample-Projects-firstmate"]);

    await rm(files.talk);
    const again = await read();
    expect(again.tallies["conversations the app no longer has, read from the archive's copy"]).toBe(1);
    expect(again.tallies["conversations copied into the archive"]).toBeUndefined();
    // Every session and turn as before, the deleted file's too.
    const indexed = (r: typeof first) => r.events.filter((e) => e.kind !== "tally");
    expect(indexed(again)).toEqual(indexed(first));
  });

  it("brings a copy up to date as its file grows, and never cuts it short or overwrites it", async () => {
    const files = await writeLlmSessionsFixture(join(dir, "store"));
    await read();
    const copy = copyOf(SESSIONS.talk);
    const whole = await readFile(copy);

    // The reply being written is finished, and more said: the copy grows with it.
    await truncate(files.talk, whole.length);
    await appendFile(files.talk, moreOfTalk());
    const grown = await read();
    expect(grown.tallies["conversations that grew, their copies brought up to date"]).toBe(1);
    expect(await readFile(copy)).toEqual(await readFile(files.talk));
    const longer = await readFile(copy);

    // Cut short: the copy stays as it was, and the shorter file is mirrored beside it; it grows there as the file
    // grows from it, and a file that extends neither starts another.
    await truncate(files.talk, whole.length);
    expect((await read()).tallies["conversations changed other than by growing: the archive's copy kept, the changed one kept beside it"]).toBe(1);
    await read();
    const besides = async () => (await readdir(dirname(copy))).filter((name) => name.startsWith(`${SESSIONS.talk}.jsonl.changed-`)).sort();
    expect(await besides()).toEqual([`${SESSIONS.talk}.jsonl.changed-1`]);
    expect(await readFile(`${copy}.changed-1`)).toEqual(whole);
    const changed = Buffer.from(longer.toString("utf8").replace("Sunny.", "Rainy."));
    await writeFile(files.talk, changed);
    await read();
    expect(await readFile(`${copy}.changed-1`)).toEqual(changed);
    await writeFile(files.talk, longer.subarray(1));
    const after = await read();
    expect(await besides()).toEqual([`${SESSIONS.talk}.jsonl.changed-1`, `${SESSIONS.talk}.jsonl.changed-2`]);
    expect(await readFile(copy)).toEqual(longer);
    // The session is read from the copy, as it was: the prompt that came after the cut is still there.
    expect(after.of("llm-turn").some((t) => t.id === uuid(SESSIONS.talk, "p6"))).toBe(true);
  });

  it("needs the folder for its copies", async () => {
    await writeLlmSessionsFixture(join(dir, "store"));
    await expect(runPromise(llmSessions.history({ sources: [join(dir, "store")], config: { projects: [PROJECT] }, mediaDir: join(dir, "media"), emit: async () => {} })))
      .rejects.toThrow(/no folder for the archive's copies/);
  });

  it("is refused by the host when an event of it carries text or a raw record", () => {
    const turn = { kind: "llm-turn", id: "t", session: "s", role: "prompt", at: 1, chars: 5, line: 1, offset: 0, length: 9 };
    expect(validateEvent(turn)).toEqual({ event: turn });
    expect(validateEvent({ ...turn, text: "hello" })).toEqual({ error: "(llm-turn) must carry no text or raw record, only where the content is" });
    expect(validateEvent({ ...turn, answers: "human" })).toEqual({ error: "(llm-turn) answers is only for a reply" });
    expect(validateEvent({ ...turn, line: 0 })).toEqual({ error: "(llm-turn) line counts from 1" });
    const session = { kind: "llm-session", id: "s", entrypoint: "cli", project: "/p", file: "/p/s.jsonl", startedAt: 2, endedAt: 1, bytes: 0 };
    expect(validateEvent(session)).toEqual({ error: "(llm-session) startedAt must not be after endedAt" });
    expect(validateEvent({ ...session, endedAt: 2, raw: {} })).toEqual({ error: "(llm-session) must carry no text or raw record, only where the content is" });
    expect(validateEvent({ ...session, endedAt: 2, file: "s.jsonl" })).toEqual({ error: "(llm-session) file must be an absolute path" });
    // A bot's name stands for the project of an agent that runs in no folder.
    expect(validateEvent({ ...session, endedAt: 2, project: "Pebble" })).toEqual({ event: { ...session, endedAt: 2, project: "Pebble" } });
  });
});
