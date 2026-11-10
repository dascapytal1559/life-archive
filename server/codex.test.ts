import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexService, NOT_INSTALLED, NOT_SIGNED_IN, type CodexServiceOptions } from "./codex.ts";
import { UnavailableError } from "./errors.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.ts", import.meta.url));

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

describe("the AI service", () => {
  it("starts Codex at once, read-only with no approvals and the captain's extras off, and asks it in a scratch folder", async () => {
    await answers({ text: '{"query":"is-programmer","note":""}' });
    const ai = start();
    await until(() => ai.state.running, "Codex to start");
    expect(lines).toEqual(["running"]);
    const schema = { type: "object" };
    expect(await ai.ask({ ...question, schema })).toBe('{"query":"is-programmer","note":""}');

    const log = await logged();
    const args = log[0].started!;
    expect(args[0]).toBe("app-server");
    expect(args.join(" ")).toContain('-c sandbox_mode="read-only" -c approval_policy="never" -c web_search="disabled" -c notify=[]');
    for (const feature of ["apps", "plugins", "hooks", "computer_use", "browser_use"]) expect(args.join(" ")).toContain(`--disable ${feature}`);
    const thread = log.find((entry) => entry.method === "thread/start")!.params;
    expect(thread).toMatchObject({
      cwd: join(dir, "work"),
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      baseInstructions: "Answer in JSON.",
      config: { "mcp_servers.computer-use.enabled": false, "mcp_servers.node_repl.enabled": false },
    });
    const turn = log.find((entry) => entry.method === "turn/start")!.params;
    expect(turn).toMatchObject({ threadId: "thread-1", input: [{ type: "text", text: "Who codes?" }], effort: "low", outputSchema: schema });
  });

  it("stays running: each question reuses the one Codex, a new thread each", async () => {
    await answers({ text: "one" }, { text: "two" }, { text: "three" });
    const ai = start();
    expect(await ai.ask(question)).toBe("one");
    expect(await Promise.all([ai.ask(question), ai.ask(question)])).toEqual(expect.arrayContaining(["two", "three"]));
    expect(await starts()).toBe(1);
    expect((await logged()).filter((entry) => entry.method === "thread/start")).toHaveLength(3);
  });

  it("when Codex stops mid-answer, says so, and starts it again after a wait", async () => {
    await answers({ crash: true }, { text: "back" });
    const ai = start();
    const error = await ai.ask(question).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnavailableError);
    expect((error as Error).message).toBe("the Codex service stopped (crashed mid-turn) while it answered: try again");
    await until(async () => (await starts()) === 2 && ai.state.running, "the restart");
    expect(lines).toEqual(["running", "the Codex service stopped (crashed mid-turn); starting again in 0 s", "running again"]);
    expect(await ai.ask(question)).toBe("back");
  });

  it("while waiting to start again, a question starts Codex at once", async () => {
    await answers({ crash: true }, { text: "at once" });
    const ai = start({ restartDelaysMs: [60_000] });
    await ai.ask(question).catch(() => {});
    expect(ai.state).toEqual({ running: false, problem: "the Codex service stopped (crashed mid-turn)" });
    expect(await ai.ask(question)).toBe("at once");
    expect(await starts()).toBe(2);
  });

  it("says plainly when Codex is signed out, and works once it is signed in, without a restart of the server", async () => {
    await writeFile(join(dir, "signed-out"), "");
    await answers({ text: "signed in" });
    const ai = start({ restartDelaysMs: [60_000] });
    await until(() => lines.length > 0, "the first start");
    expect(lines).toEqual([`${NOT_SIGNED_IN}; starting again in 1 min`]);
    await expect(ai.ask(question)).rejects.toThrow(NOT_SIGNED_IN);
    // Said once in the log, however often it is asked.
    expect(lines).toHaveLength(1);
    await rm(join(dir, "signed-out"));
    expect(await ai.ask(question)).toBe("signed in");
    expect(lines.at(-1)).toBe("running again");
  });

  it("says when Codex signs out while running, and starts again to find out afresh", async () => {
    await answers({ fail: { message: "401", codexErrorInfo: "unauthorized" } });
    const ai = start({ restartDelaysMs: [60_000] });
    await expect(ai.ask(question)).rejects.toThrow(NOT_SIGNED_IN);
    expect(ai.state.running).toBe(false);
    expect(lines.at(-1)).toBe(`${NOT_SIGNED_IN}; starting again in 1 min`);
  });

  it("says when Codex is not installed, or fails as it starts", async () => {
    const missing = start({ command: [join(dir, "no-such-codex")] });
    await expect(missing.ask(question)).rejects.toThrow(NOT_INSTALLED);
    await missing.stop();

    await writeFile(join(dir, "broken"), "");
    const broken = start();
    await expect(broken.ask(question)).rejects.toThrow("the Codex service stopped (boom)");
  });

  it("says why a turn failed: the plan's usage limit, a refusal, an error, or no answer in time", async () => {
    await answers(
      { fail: { message: "limit", codexErrorInfo: "usageLimitExceeded" } },
      { fail: { message: "no", codexErrorInfo: "cyberPolicy" } },
      { fail: { message: "the server had a problem", codexErrorInfo: "internalServerError" } },
      { hang: true },
    );
    const ai = start({ answerTimeoutMs: 300 });
    await expect(ai.ask(question)).rejects.toThrow("Codex has reached the ChatGPT plan's usage limit for now: try again later");
    await expect(ai.ask(question)).rejects.toThrow("Codex declined to answer");
    await expect(ai.ask(question)).rejects.toThrow("Codex could not answer: the server had a problem");
    await expect(ai.ask(question)).rejects.toThrow("Codex took more than 0 s to answer: try again");
    await until(async () => (await logged()).some((entry) => entry.method === "turn/interrupt"), "the hung turn to be interrupted");
    // None of these stops Codex.
    expect(ai.state.running).toBe(true);
    expect(await starts()).toBe(1);
  });

  it("answers a question it was answering when it is stopped, rather than leave it waiting", async () => {
    await answers({ hang: true });
    const ai = start();
    const asked = ai.ask(question).then(() => null, (e: unknown) => e as Error);
    await until(async () => (await logged().catch(() => [])).some((entry) => entry.method === "turn/start"), "the question to be asked");
    await ai.stop();
    expect((await asked)?.message).toMatch(/^the Codex service stopped \(.*\) while it answered: try again$/);
    await expect(ai.ask(question)).rejects.toThrow("the Codex service is stopped");
  });

  it("stops Codex when told to, and starts nothing more", async () => {
    const ai = start();
    await until(() => ai.state.running, "Codex to start");
    await ai.stop();
    expect(ai.state.running).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await starts()).toBe(1);
  });
});
