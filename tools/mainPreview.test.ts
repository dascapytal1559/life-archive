// The main preview's command (mainPreview.ts): a new build swapped in by its link in one step, and main's code from
// before the preview refused, saying so, with the build served left as it was. (The build itself is the demo's,
// tools/demo/check.test.ts's.)

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { CURRENT, servedBuild } from "../server/mainPreview.ts";
import { buildMainPreview, swapIn } from "./mainPreview.ts";

const scratch = () => Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "life-archive-main-preview-test-"))), (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })));

describe("the main preview's command", () => {
  it.live("swaps a new build in by its link, the old one served until then", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const into = yield* scratch();
        for (const name of ["one", "two"]) {
          yield* Effect.promise(() => mkdir(join(into, "builds", name, "life-archive"), { recursive: true }));
          yield* Effect.promise(() => writeFile(join(into, "builds", name, "which"), name));
          yield* Effect.promise(() => writeFile(join(into, "builds", name, "life-archive", "index.html"), "<!doctype html>"));
        }
        expect(servedBuild(into)).toBeNull();
        yield* swapIn(into, join(into, "builds", "one"));
        expect(yield* Effect.promise(() => readFile(join(into, CURRENT, "which"), "utf8"))).toBe("one");
        yield* swapIn(into, join(into, "builds", "two"));
        expect(yield* Effect.promise(() => readFile(join(into, CURRENT, "which"), "utf8"))).toBe("two");
        expect(servedBuild(into)).toMatch(/builds\/two$/);
      }),
    ));

  it.live("refuses main's code from before the preview, and leaves the build served as it was", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* scratch();
        const repo = join(dir, "repo");
        const into = join(dir, "preview");
        yield* Effect.promise(() => mkdir(repo));
        yield* Effect.promise(() => writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { "build:demo": "node build.ts" } })));
        const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args]);
        git("init", "-q", "-b", "main");
        git("add", "package.json");
        git("commit", "-q", "-m", "Before the preview");
        yield* Effect.promise(() => mkdir(join(into, "builds", "kept", "life-archive"), { recursive: true }));
        yield* Effect.promise(() => writeFile(join(into, "builds", "kept", "life-archive", "index.html"), "<!doctype html>"));
        yield* Effect.promise(() => symlink(join("builds", "kept"), join(into, CURRENT)));
        const failed = yield* buildMainPreview({ ref: "main", into, network: false, log: () => {}, repo }).pipe(Effect.flip);
        expect(failed._tag).toBe("MainPreviewFailed");
        expect(failed.message).toMatch(/is from before the main preview: .* Move main past the commit that added `npm run main-preview`/);
        expect(servedBuild(into)).toMatch(/builds\/kept$/);
        const missing = yield* buildMainPreview({ ref: "no-such-branch", into, network: false, log: () => {}, repo }).pipe(Effect.flip);
        expect(missing.message).toMatch(/^git rev-parse/);
      }),
    ));
});
