// npm run main-preview [-- --ref <ref>] [--into <folder>] [--no-network]: builds the main branch's preview, which the
// archive's server serves at /life-archive/main (server/mainPreview.ts; docs/demo.md's "The main preview"), and swaps
// it in whole. Run after main moves, from the checkout the server runs.
//
//   1. main's code (or --ref's) is checked out in a temporary clone of this checkout's git (a clone of its own: no
//      worktree is added to this one, and nothing of this checkout's untracked files comes with it), and its packages
//      installed there (npm ci);
//   2. main's own demo build is run there for the preview's path (npm run build:demo -- --mount /life-archive/main), so
//      the preview is main's code on the made-up data, checked by main's own check against this archive's private
//      names, into a new folder under the preview's builds/;
//   3. the link `current` is pointed at it in one step (a new link renamed over the old), so the server serves the old
//      build or the new one, never half of either; the old build is then removed, and the temporary folder.
//
// The preview's folder is the archive's folder's main-preview/ unless --into names another. A build that fails leaves
// the one served as it was. main's code from before this command existed cannot build a preview: it says so.

import "../server/onPinnedNode.ts";
import "../server/onSettings.ts";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { Clock, Data, Effect } from "effect";
import { run, spawnScoped } from "../server/childProcess.ts";
import { archiveFolder, REPO } from "../server/dataHome.ts";
import { runMain } from "../server/effectRuntime.ts";
import { CURRENT, MAIN_PREVIEW_FOLDER, MAIN_PREVIEW_PATH, servedBuild } from "../server/mainPreview.ts";

/** Why a preview was not built: the build served stays as it was. */
export class MainPreviewFailed extends Data.TaggedError("MainPreviewFailed")<{ readonly message: string }> {}

/** The script main's package.json has once its code can build a preview (this command came with the build's --mount). */
const SCRIPT = "main-preview";

/** Runs `command` in `cwd`, its output shown as it goes; fails saying `what` did not finish. */
const shown = (what: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { exited } = yield* spawnScoped(() => spawn(command, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] }));
      const { code, signal } = yield* exited;
      if (code !== 0) return yield* new MainPreviewFailed({ message: `${what} did not finish (${signal ? `stopped by ${signal}` : `exit ${code}`})` });
    }),
  );

/** Points the link `current` in `into` at `build` in one step: a new link beside it, renamed over it. */
export const swapIn = (into: string, build: string) =>
  Effect.tryPromise({
    try: async () => {
      const link = join(into, `.${CURRENT}.${process.pid}`);
      await rm(link, { force: true });
      await symlink(relative(into, build), link);
      await rename(link, join(into, CURRENT));
    },
    catch: (error) => new MainPreviewFailed({ message: `the new build could not be swapped in: ${(error as Error).message}` }),
  });

/** Builds the preview of `ref` in the git checkout `repo` into `into` and swaps it in (see the top); says what it does with `log`. */
export const buildMainPreview = ({ ref, into, network, log, repo = REPO }: { ref: string; into: string; network: boolean; log: (line: string) => void; repo?: string }) =>
  Effect.gen(function* () {
    const git = (...args: string[]) => run("git", ["-C", repo, ...args]).pipe(Effect.mapError((error) => new MainPreviewFailed({ message: `git ${args[0]}: ${error.message}` })));
    const commit = (yield* git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`)).stdout.trim();
    const subject = (yield* git("log", "-1", "--format=%s", commit)).stdout.trim();
    log(`Building the main preview of ${ref} at ${commit.slice(0, 12)} (${subject}) for ${MAIN_PREVIEW_PATH}.`);
    const now = new Date(yield* Clock.currentTimeMillis).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const build = join(into, "builds", `${now}-${commit.slice(0, 12)}`);
    const before = servedBuild(into);
    yield* Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "life-archive-main-preview-"))),
      (scratch) =>
        Effect.gen(function* () {
          // A clone of its own (the demo's build asks git which modules are tracked), checked out at the commit, no hook run.
          const code = join(scratch, "code");
          yield* git("-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-checkout", repo, code);
          yield* run("git", ["-C", code, "-c", "core.hooksPath=/dev/null", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", commit]).pipe(
            Effect.mapError((error) => new MainPreviewFailed({ message: `git checkout: ${error.message}` })),
          );
          const scripts = (JSON.parse(yield* Effect.promise(() => readFile(join(code, "package.json"), "utf8"))) as { scripts?: Record<string, string> }).scripts ?? {};
          if (!(SCRIPT in scripts)) {
            return yield* new MainPreviewFailed({
              message: `${ref} (${commit.slice(0, 12)}) is from before the main preview: its demo build cannot be built for ${MAIN_PREVIEW_PATH}. Move ${ref} past the commit that added \`npm run ${SCRIPT}\`, then run this again.`,
            });
          }
          log("Installing its packages (npm ci).");
          yield* shown("npm ci", "npm", ["ci", "--no-audit", "--no-fund"], code, process.env);
          yield* Effect.promise(() => mkdir(dirname(build), { recursive: true }));
          // Its own check reads this archive's private names: its folder is named, as the copy has no .env.local.
          const env = { ...process.env, LIFE_ARCHIVE_DATA: archiveFolder() };
          yield* shown("main's demo build", "npm", ["run", "build:demo", "--", "--out", build, "--mount", MAIN_PREVIEW_PATH, ...(network ? [] : ["--no-network"])], code, env).pipe(
            Effect.tapError(() => Effect.promise(() => rm(build, { recursive: true, force: true }))),
          );
        }),
      (scratch) => Effect.promise(() => rm(scratch, { recursive: true, force: true })),
    );
    yield* swapIn(into, build);
    // The build served before, now served no more (never one outside builds/, which this did not make).
    if (before !== null && before !== realpathSync(build) && dirname(before) === realpathSync(dirname(build))) yield* Effect.promise(() => rm(before, { recursive: true, force: true }));
    log(`The main preview of ${commit.slice(0, 12)} is served at ${MAIN_PREVIEW_PATH} (${join(into, CURRENT)} -> ${basename(build)}).`);
    return { commit, build };
  });

if (import.meta.main) {
  const { values } = parseArgs({ options: { ref: { type: "string" }, into: { type: "string" }, "no-network": { type: "boolean" } } });
  const into = resolve(values.into ?? join(archiveFolder(), MAIN_PREVIEW_FOLDER));
  if (!existsSync(dirname(into))) {
    console.error(`No folder at ${dirname(into)} to keep the preview in.`);
    process.exit(1);
  }
  const checkout = REPO.replace(/\/+$/, "");
  if (into === checkout || into.startsWith(`${checkout}${sep}`)) {
    console.error(`The preview is kept outside the checkout (${into} is in it).`);
    process.exit(1);
  }
  await mkdir(into, { recursive: true });
  const done = await runMain(
    buildMainPreview({ ref: values.ref ?? "main", into, network: !values["no-network"], log: (line) => console.log(line) }).pipe(
      Effect.catchTag("MainPreviewFailed", (error) => Effect.sync(() => (console.error(`No new main preview: ${error.message}`), null))),
    ),
  );
  if (!done) process.exit(1);
}
