// npm run build:demo [-- --out <dir>] [--no-network] [--keep] [--mount <path>]: the static demo (docs/demo.md), a site
// of plain files with no server behind it, in dist-demo/ unless --out names another (new or emptied first), built for
// the root of a site of its own, or with --mount to be served under another server's path (viewer/mount.ts: the main
// preview, /life-archive/main):
//
//   1. a made-up folder, the testing data's crowd (npm run testing-data -- --crowd), in a temporary folder;
//   2. the archive's server run over it, and asked what the demo keeps of it (record.ts): each answer at
//      demo-data/answers/, each file it answers at its own path; with the network, the made-up runs' area's open map
//      and terrain first (the exercise module's part);
//   3. its databases copied in, gzipped, at demo-data/db/, for what the pages answer themselves (sdk/demo.ts);
//   4. the console's page and each module page's (friend-map's) built over the demo's backend (vite.ts);
//   5. what Cloudflare Pages reads beside the files (_redirects, _headers) and the pages' 404s (site.ts);
//   6. the check (check.ts): only what a demo is made of, and nothing of a real archive's; it fails the build.
//
// Nothing of this machine's goes in: the made-up folder alone is read, the server is run with a bare environment, and
// the check scans every file with the archive's private names when this machine has an archive (none on a build server;
// in a worktree, the main checkout's archive), and says so loudly when it found none.

import "../../server/onPinnedNode.ts";
import "../../server/onSettings.ts";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { Effect } from "effect";
import { build } from "vite";
import { answerFile, databaseFile, DEMO_DATA } from "../../sdk/demo.ts";
import { CORE_FILE } from "../../server/archive/coreDb.ts";
import { CALENDAR_FILE } from "../../server/calendar/db.ts";
import { run } from "../../server/childProcess.ts";
import { archivesOf, NO_ENV_FILE, REPO } from "../../server/dataHome.ts";
import { runMain } from "../../server/effectRuntime.ts";
import { loadModules, TRACKED_MODULES_ONLY } from "../../server/modules/loader.ts";
import { moduleDatabaseFile } from "../../server/modules/store.ts";
import { checkDemo, privacyOfArchives, uncheckedLine } from "./check.ts";
import { recordDemo } from "./record.ts";
import { writeSite } from "./site.ts";
import { consoleDemoConfig, pageDemoConfig, pageDemoRoot } from "./vite.ts";
import { isMount, siteOf } from "../../viewer/mount.ts";

/** Where the demo is built unless --out names another. */
export const DEMO_OUT = join(REPO, "dist-demo");

/** A made-up database at `file`, as the demo copies it: whole (VACUUM INTO, so no -wal is left out) and gzipped. */
function copyDatabase(file: string, to: string, scratch: string): Promise<void> {
  const copy = join(scratch, `copy-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  return readFile(copy).then(async (bytes) => {
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, gzipSync(bytes, { level: 9 }));
    await rm(copy);
  });
}

/** Builds the demo into `out` (see the top). */
/** `archives`: the archive folders on this machine the demo may hold nothing of and is checked against (archivesOf). */
/** `mount`: the path of another server's the demo is built to be served under (viewer/mount.ts: the main preview's), "" for a site of its own. */
export const buildDemo = ({ out, network, keep, log, archives = archivesOf(), mount = "" }: { out: string; network: boolean; keep: boolean; log: (line: string) => void; archives?: readonly string[]; mount?: string }) =>
  Effect.gen(function* () {
    if (mount !== "" && !isMount(mount)) return yield* Effect.die(new Error(`a mount is a path such as /life-archive/main, not ${JSON.stringify(mount)}`));
    const scratch = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "life-archive-demo-")));
    const folder = join(scratch, "made-up");
    const home = join(scratch, "home");
    yield* Effect.promise(() => mkdir(home));
    // A private module (one git does not track) is not installed for any of it: its code, name and database stay out.
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, [NO_ENV_FILE]: "1", [TRACKED_MODULES_ONLY]: "1" };
    yield* Effect.gen(function* () {
      log(`Making the demo's made-up folder (the testing data's crowd) in ${folder}`);
      yield* run(process.execPath, ["--no-warnings", join(REPO, "server", "fixtures", "testing-data.ts"), folder, "--crowd"], { cwd: REPO, env });
      const recorded = yield* recordDemo(folder, { home, network, log });
      yield* Effect.promise(async () => {
        await rm(out, { recursive: true, force: true });
        await mkdir(out, { recursive: true });
        for (const [key, answer] of recorded.answers) {
          const file = join(out, DEMO_DATA, answerFile(key));
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify(answer));
        }
        // The questions themselves, for the check and the tests: which answers the demo has.
        await writeFile(join(out, DEMO_DATA, "answers.json"), JSON.stringify([...recorded.answers.keys()].sort()));
        for (const [path, bytes] of recorded.files) {
          const file = join(out, path);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, bytes);
        }
      });
      const modules = yield* Effect.promise(() => loadModules({ all: true, env }));
      yield* Effect.promise(async () => {
        const databases = [CORE_FILE, CALENDAR_FILE, ...modules.on.flatMap((m) => (m.definition.database ? [moduleDatabaseFile("", m.id, m.definition.database)] : []))];
        for (const name of databases) await copyDatabase(join(folder, name), join(out, DEMO_DATA, databaseFile(name)), scratch);
        log(`Copied the made-up ${databases.join(", ")}.`);
      });
      // Nothing of the made-up folder or of a real archive may be bundled into a page.
      const refused = [folder, ...archives];
      const pages = modules.on.flatMap((m) => (m.definition.page && existsSync(join(pageDemoRoot({ ...m.definition.page, plugins: [] }), "index.html")) ? [m.definition.page] : []));
      yield* Effect.acquireUseRelease(
        // A production build whatever NODE_ENV this runs under (vitest's "test"), which is how Vite decides: a
        // development one carries each file's path on this machine (vite.ts).
        Effect.sync(() => {
          const was = process.env.NODE_ENV;
          process.env.NODE_ENV = "production";
          return was;
        }),
        () =>
          Effect.promise(async () => {
            await build(consoleDemoConfig(join(out, "life-archive"), refused, mount));
            for (const page of pages) await build(pageDemoConfig({ path: page.path, root: page.root, plugins: page.plugins?.(folder) ?? [] }, join(out, page.path.slice(1)), refused, mount));
          }),
        (was) => Effect.sync(() => (was === undefined ? delete process.env.NODE_ENV : (process.env.NODE_ENV = was))),
      );
      yield* Effect.promise(() => writeSite(out, pages.map((page) => page.path), mount));
      log(`Built the console and ${pages.map((page) => page.path).join(", ") || "no module page"} into ${out}${mount ? `, to be served under ${mount} (its console there, the rest under ${siteOf(mount)})` : ""}.`);
    }).pipe(Effect.ensuring(keep ? Effect.sync(() => log(`Kept the made-up folder: ${folder}`)) : Effect.promise(() => rm(scratch, { recursive: true, force: true }))));
    const privacy = privacyOfArchives(archives);
    if (privacy.note) log(uncheckedLine(privacy.note));
    const problems = yield* Effect.promise(() => checkDemo(out, privacy));
    return problems;
  });

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" }, "no-network": { type: "boolean" }, keep: { type: "boolean" }, mount: { type: "string" } } });
  const out = resolve(values.out ?? DEMO_OUT);
  if (values.mount !== undefined && !isMount(values.mount)) {
    console.error(`--mount takes a path such as /life-archive/main, not ${JSON.stringify(values.mount)}.`);
    process.exit(2);
  }
  let unchecked = false;
  const problems = await runMain(
    buildDemo({ out, network: !values["no-network"], keep: values.keep ?? false, mount: values.mount ?? "", log: (line) => (line.startsWith("WARNING") ? ((unchecked = true), console.error(line)) : console.log(line)) }).pipe(
      Effect.catch((error) => Effect.sync(() => [`the build failed: ${error.message}`])),
    ),
  );
  if (problems === undefined) process.exit(130);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`The demo in ${out} is not fit to publish: ${problems.length} problem${problems.length === 1 ? "" : "s"} above.`);
    process.exit(1);
  }
  console.log(`The demo is ready in ${out}${unchecked ? ", checked without the archive's private names (the WARNING above)" : ""}: npm run serve:demo to look at it.`);
}
