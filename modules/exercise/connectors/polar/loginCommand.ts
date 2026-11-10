// The terminal's side of `npm run exercise -- polar login` (login.ts): its questions asked at the terminal (a secret
// unseen), Polar's page opened with macOS's `open`, and the Keychain the login one.

import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Effect } from "effect";
import { runMain } from "../../../../sdk/server.ts";
import { polarLogin } from "./login.ts";
import { keychainSecrets } from "./secrets.ts";
import { settingsFile } from "./settings.ts";

export async function polarLoginCommand(dataDir: string, { newClient }: { newClient: boolean }): Promise<void> {
  const outcome = await runMain(
    polarLogin({
      secrets: keychainSecrets(),
      settingsFile: settingsFile(dataDir),
      ask: (question, { secret = false } = {}) => Effect.promise(() => (secret ? askUnseen(question) : ask(question))),
      open: (url) => Effect.sync(() => void execFile("/usr/bin/open", [url], () => {})),
      log: (line) => console.log(line),
      newClient,
    }).pipe(Effect.result),
  );
  if (outcome?._tag === "Failure") throw new Error(`Polar is not connected: ${outcome.failure.message}`);
}

async function ask(question: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await lines.question(question);
  } finally {
    lines.close();
  }
}

/** Asks with the answer unseen: the terminal in raw mode, nothing echoed. */
function askUnseen(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) return ask(question);
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let typed = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const done = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", take);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(typed);
    };
    const take = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new Error("stopped"));
        if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    input.on("data", take);
  });
}
