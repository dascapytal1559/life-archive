// A stand-in for `codex app-server`, for the AI service's tests: it speaks
// enough of the protocol (JSON lines on stdin and stdout) for the service, and
// is steered by files in the folder given as its first argument:
//
//   answers.json   the next turns' outcomes, taken one per turn (and written
//                  back, so a restarted stand-in carries on): {"text": "..."}
//                  answers that, {"fail": {"message", "codexErrorInfo"}}
//                  fails the turn, {"crash": true} exits mid-turn, and
//                  {"hang": true} never finishes it
//   signed-out     when present, no account is signed in
//   broken         when present, it exits at once, saying "boom" on stderr
//   log.jsonl      what it was started with, and every request, one per line

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = process.argv[2];
const log = (entry: object) => appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
log({ started: process.argv.slice(3) });
if (existsSync(join(dir, "broken"))) {
  process.stderr.write("boom\n");
  process.exit(3);
}

type Outcome = { text?: string; fail?: { message: string; codexErrorInfo: unknown }; crash?: boolean; hang?: boolean };
function nextOutcome(): Outcome {
  const file = join(dir, "answers.json");
  const answers = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []) as Outcome[];
  const next = answers.shift() ?? { fail: { message: "the stand-in has no answer left", codexErrorInfo: "other" } };
  writeFileSync(file, JSON.stringify(answers));
  return next;
}

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method: string, params: object) => send({ method, params });
let threads = 0;

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line) as { id?: number; method: string; params: any };
  log({ method, params });
  if (id === undefined) continue;
  const reply = (result: object) => send({ id, result });
  if (method === "initialize") reply({ userAgent: "fake-codex", codexHome: dir, platformFamily: "unix", platformOs: "macos" });
  else if (method === "account/read") {
    const signedIn = !existsSync(join(dir, "signed-out"));
    reply({ account: signedIn ? { type: "chatgpt", email: "captain@example.com", planType: "pro" } : null, requiresOpenaiAuth: true });
  } else if (method === "config/read") reply({ config: { mcp_servers: { "computer-use": {}, node_repl: {} } } });
  else if (method === "thread/start") reply({ thread: { id: `thread-${++threads}` } });
  else if (method === "turn/start") {
    const turnId = `turn-${threads}`;
    reply({ turn: { id: turnId, items: [], status: "inProgress", error: null } });
    const outcome = nextOutcome();
    if (outcome.crash) {
      process.stderr.write("crashed mid-turn\n");
      process.exit(1);
    }
    if (outcome.hang) continue;
    const threadId = params.threadId;
    if (outcome.text !== undefined) {
      notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "m1", text: outcome.text } });
      notify("turn/completed", { threadId, turn: { id: turnId, items: [], status: "completed", error: null } });
    } else {
      notify("turn/completed", { threadId, turn: { id: turnId, items: [], status: "failed", error: { ...outcome.fail, additionalDetails: null } } });
    }
  } else if (method === "turn/interrupt" || method === "thread/unsubscribe") reply({});
  else send({ id, error: { code: -32601, message: `the stand-in does not know ${method}` } });
}
