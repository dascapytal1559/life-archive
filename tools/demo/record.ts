// What the static demo keeps of the archive's server (docs/demo.md): the server itself, run over a made-up folder (the
// testing data) on a spare port of this machine, and asked every question the demo's pages can ask of a route whose
// questions can all be asked beforehand; each answer kept as it gave it, by its question (sdk/demo.ts's answerKey and
// answerFile), and each file it answers (a map's tile, a kept image) at its own path. The core's own routes are asked
// here; each module's by its module.ts's `demo` (sdk/server.ts's DemoRecorder). What the pages ask whose questions are
// open (the Events tables' filters, a chat's pages) is answered in the page instead (sdk/demo.ts's live routes).
//
// The server is given nothing of this machine's but the folder: a bare environment and no .env.local (dataHome.ts's
// NO_ENV_FILE), so no key, host or address of the machine the demo is built on can reach an answer it keeps.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Data, Effect, Schedule } from "effect";
import { answerKey, type RecordedAnswer } from "../../sdk/demo.ts";
import type { DemoRecorder } from "../../sdk/server.ts";
import { CORE_FILE } from "../../server/archive/coreDb.ts";
import { spawnScoped } from "../../server/childProcess.ts";
import { NO_ENV_FILE, REPO } from "../../server/dataHome.ts";
import { loadModules, TRACKED_MODULES_ONLY } from "../../server/modules/loader.ts";
import { SETTINGS_FILE, type Settings } from "../../server/settings.ts";
import { SOURCES_API } from "../../viewer/sourcesWire.ts";
import { API_BASE, CONTENT_API, CONVERSATION_PAGE, SETTINGS_API, type SessionPage } from "../../viewer/wire.ts";

export class RecordFailed extends Data.TaggedError("RecordFailed")<{ readonly message: string }> {}

/** What the server answered, as the demo keeps it: each JSON answer by its question, and each file by its path. */
export interface Recorded {
  answers: Map<string, RecordedAnswer>;
  files: Map<string, Uint8Array>;
}

/** How many questions are asked of the server at once. */
const AT_ONCE = 12;

/** A port nothing on this machine listens on now. */
const sparePort = Effect.callback<number>((resume) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resume(Effect.succeed(port)));
  });
});

/** The page switches the demo's server runs with: those a settings.json can name (settings.ts). */
type PageSwitches = Pick<Settings, "pages" | "modules">;

/**
 * Makes the made-up folder a fresh install's for its pages (src/pages.ts): the testing data's settings say every page,
 * and the demo shows what a new archive offers, the pages marked ready. The server, run over it, then says the rest are
 * off, and the console leaves them out as any archive's does. Its switches, as the server reads them.
 */
function asFreshInstall(folder: string): PageSwitches {
  const file = join(folder, SETTINGS_FILE);
  const written = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) as Partial<PageSwitches>;
  writeFileSync(file, `${JSON.stringify({ ...written, pages: "ready" }, null, 2)}\n`);
  return { pages: "ready", modules: written.modules ?? {} };
}

/** The recorder over the server at `base`: each question asked at most AT_ONCE at a time, each answer kept. */
function recorderAt(base: string, folder: string, network: boolean, recorded: Recorded): DemoRecorder {
  let running = 0;
  const waiting: Array<() => void> = [];
  const inTurn = async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= AT_ONCE) await new Promise<void>((go) => waiting.push(go));
    running++;
    try {
      return await work();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
  return {
    folder,
    network,
    json: <T>(path: string) =>
      inTurn(async () => {
        const url = new URL(path, base);
        const response = await fetch(url);
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`GET ${path} answered ${response.status} with no JSON`);
        }
        recorded.answers.set(answerKey("GET", url), { status: response.status, body });
        return body as T;
      }),
    file: (path) =>
      inTurn(async () => {
        const url = new URL(path, base);
        const response = await fetch(url);
        if (response.status !== 200) return false;
        recorded.files.set(decodeURIComponent(url.pathname), new Uint8Array(await response.arrayBuffer()));
        return true;
      }),
  };
}

/** The core's own routes, as the console asks them: its settings, tables, sources and LLM sessions. */
async function recordCore(recorder: DemoRecorder): Promise<void> {
  await Promise.all([recorder.json(SETTINGS_API), recorder.json(`${API_BASE}/kinds`), recorder.json(SOURCES_API)]);
  const core = new DatabaseSync(join(recorder.folder, CORE_FILE), { readOnly: true });
  try {
    // Metadata alone: which sessions there are, to ask for each.
    const sessions = core.prepare("SELECT id FROM event WHERE detail = 'llm_session' ORDER BY id").all() as Array<{ id: number }>;
    // Every page of every session, from its start: the page answers a page from anywhere else from these (viewer/demo/backend.ts).
    await Promise.all(sessions.map(async ({ id }) => {
      const first = await recorder.json<SessionPage>(`${CONTENT_API}/llm/${id}/session?offset=0`);
      for (let offset = CONVERSATION_PAGE; offset < first.total; offset += CONVERSATION_PAGE) await recorder.json(`${CONTENT_API}/llm/${id}/session?offset=${offset}`);
    }));
  } finally {
    core.close();
  }
}

/**
 * Runs the archive's server over the made-up folder `folder` and records what the demo keeps of it (see the top), the
 * modules' parts by their `demo`, with `home` (an empty folder) as its HOME, so nothing of this machine's own (its
 * jobs' schedules) is asked; `network` lets a module fetch open data first (the exercise module's map).
 */
export const recordDemo = (folder: string, { home, network, log }: { home: string; network: boolean; log: (line: string) => void }): Effect.Effect<Recorded, RecordFailed> =>
  Effect.scoped(
    Effect.gen(function* () {
      const switches = asFreshInstall(folder);
      const port = yield* sparePort;
      const base = `http://127.0.0.1:${port}`;
      let output = "";
      const server = yield* spawnScoped(() => {
        const child = spawn(process.execPath, ["--no-warnings", join(REPO, "server", "main.ts")], {
          cwd: REPO,
          env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, LIFE_ARCHIVE_DATA: folder, LIFE_ARCHIVE_URL: base, [NO_ENV_FILE]: "1", [TRACKED_MODULES_ONLY]: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        return child;
      });
      // Up once its tables answer: the archive is open and its calendar built.
      yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${base}${API_BASE}/kinds`);
          if (!response.ok) throw new Error(`answered ${response.status}`);
        },
        catch: (error) => new RecordFailed({ message: String(error) }),
      }).pipe(
        Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240, while: () => !server.ended() }),
        Effect.mapError(() => new RecordFailed({ message: `the archive's server did not start over ${folder}:\n${output.slice(-3000)}` })),
      );
      log(`The archive's server is up over the made-up folder, at ${base}; asking it what the demo keeps.`);
      const recorded: Recorded = { answers: new Map(), files: new Map() };
      const recorder = recorderAt(base, folder, network, recorded);
      // The modules the server loaded (those git tracks): an unfinished one is off, and nothing of it is kept.
      const modules = yield* Effect.promise(() => loadModules({ switches: switches.modules, pages: switches.pages, env: { [TRACKED_MODULES_ONLY]: "1" } }));
      yield* Effect.tryPromise({
        try: async () => {
          await recordCore(recorder);
          for (const module of modules.on) await module.definition.demo?.record(recorder);
        },
        catch: (error) => new RecordFailed({ message: `${(error as Error).message}\n${output.slice(-2000)}` }),
      });
      log(`Kept ${recorded.answers.size} answers and ${recorded.files.size} files.`);
      return recorded;
    }),
  );
