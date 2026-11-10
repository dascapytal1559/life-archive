// Generate through the core's AI service (server/codex.ts's CodexService, with a stand-in for Codex): friend map's query
// writer (queryWriter.ts) asking it, as the Query bar's Generate does.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnavailableError } from "../../../sdk/server.ts";
import { CodexService, NOT_INSTALLED, NOT_SIGNED_IN, type CodexServiceOptions } from "../../../sdk/testing.ts";
import { QueryError, type QueryPerson, type QueryVocabulary } from "./query.ts";
import { aiQueryModel, QUERY_INSTRUCTIONS, writeQuery } from "./queryWriter.ts";


const FAKE = fileURLToPath(new URL("../../../server/fixtures/fake-codex.ts", import.meta.url));

let dir: string;
let service: CodexService | null;
let lines: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-ai-"));
  service = null;
  lines = [];
});

afterEach(async () => {
  await service?.stop();
  await rm(dir, { recursive: true, force: true });
});

/** The service, running the stand-in (fixtures/fake-codex.ts) steered from `dir`. */
function start(options: Partial<CodexServiceOptions> = {}): CodexService {
  service = new CodexService({
    model: "sample-model",
    command: [process.execPath, FAKE, dir],
    workDir: join(dir, "work"),
    log: (line) => lines.push(line),
    restartDelaysMs: [50],
    ...options,
  });
  service.start();
  return service;
}

const answers = (...outcomes: object[]) => writeFile(join(dir, "answers.json"), JSON.stringify(outcomes));
const logged = async () => (await readFile(join(dir, "log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { started?: string[]; method?: string; params?: any });
const starts = async () => (await logged()).filter((entry) => entry.started).length;
const question = { instructions: "Answer in JSON.", prompt: "Who codes?" };

/** Resolves once `check` holds, looking every 20 ms for up to 10 s. */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("Generate through the AI service", () => {
  const person = (id: number, tags: string[]): QueryPerson => ({
    id, tags, archived: null, shouldReachOut: false, fields: { platform: ["telegram"] },
    messageCount: 1, directMessageCount: 1, groupMessageCount: 0, lastMessageAt: null,
  });
  const people = [person(1, ["lives-berlin"]), person(2, ["lives-paris", "climbing"]), person(3, ["lives-toronto"])];
  const vocabulary: QueryVocabulary = { tags: ["lives-berlin", "lives-paris", "lives-toronto", "climbing"], fields: { platform: ["telegram"] } };
  const EUROPE = "SELECT person_id FROM people WHERE lives IN ('Berlin', 'Paris')";
  const NOT_CLIMBING = `${EUROPE}\nEXCEPT\nSELECT person_id FROM people WHERE tags = 'climbing'`;
  /** The archive, as far as these queries go. */
  const run = async (query: string) => {
    const found = ({ [EUROPE]: [1, 2], [NOT_CLIMBING]: [1] } as Record<string, number[]>)[query];
    if (!found) throw new QueryError("SQL: no such column: lives_in");
    return found;
  };
  const generate = (current: string, transcript: string) =>
    writeQuery(aiQueryModel(service!), { current, transcript, people, vocabulary, now: Date.parse("2026-09-30T12:00:00+10:00") }, run);
  const answer = (query: string, parts: object[] = []) => ({ text: JSON.stringify({ query, parts }) });
  const turns = async () => (await logged()).filter((entry) => entry.method === "turn/start").map((entry) => entry.params);

  it("writes a new query and changes one, asking Codex with the query instructions and the answer's shape", async () => {
    await answers(answer(EUROPE), answer(NOT_CLIMBING, [{ said: "not climbers", in_query: true, why_not: "" }, { said: "outdoorsy", in_query: false, why_not: "no tag says who is outdoorsy" }]));
    start();
    expect(await generate("", "people in Europe")).toEqual({ query: EUROPE, count: 2, note: "" });
    expect(await generate(EUROPE, "but not climbers, and outdoorsy")).toEqual({ query: NOT_CLIMBING, count: 1, note: "Not in the query: outdoorsy (no tag says who is outdoorsy)." });
    const [first, second] = await turns();
    expect(first.input[0].text).toContain("Current query: (none: write a new one)");
    expect(second.input[0].text).toContain(`Current query: ${EUROPE}`);
    expect(first.outputSchema).toMatchObject({ required: ["query", "parts"] });
    expect((await logged()).find((entry) => entry.method === "thread/start")!.params.baseInstructions).toBe(QUERY_INSTRUCTIONS);
  });

  it("sends back a query that does not run once, with the error", async () => {
    const typo = "SELECT person_id FROM people WHERE lives_in = 'Berlin'";
    await answers(answer(typo), answer(EUROPE));
    start();
    expect(await generate("", "people in Germany or France")).toMatchObject({ query: EUROPE, count: 2 });
    expect((await turns())[1].input[0].text).toContain(`You answered with the query ${JSON.stringify(typo)}, which does not run: SQL: no such column: lives_in`);
  });

  it("says so when Codex declines, or answers with something that is not the answer's shape", async () => {
    await answers({ fail: { message: "no", codexErrorInfo: "misalignmentPolicyViolation" } }, { text: "Sorry, I can't help with that." });
    start();
    await expect(generate("", "people in Europe")).rejects.toThrow("Codex declined to answer");
    await expect(generate("", "people in Europe")).rejects.toThrow("the model's answer could not be read: Sorry, I can't help with that.");
  });

  it("says so, plainly, when Codex is signed out", async () => {
    await writeFile(join(dir, "signed-out"), "");
    start();
    await expect(generate("", "people in Europe")).rejects.toThrow(NOT_SIGNED_IN);
  });
});
