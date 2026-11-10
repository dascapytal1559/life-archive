// npm run archive -- inspiration ... and inspiration-tag ... (cli.ts, handed on by the archive's own CLI), run as the
// captain's Grok Bot agent and an agent in a chat would: a capture with what the agent saw, a kept photo, the list's
// filters, his tags as changesets that undo, a bulk edit's dry run and --expect, and the vocabulary. Every item is made up.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CORE_FILE, openCore, openModuleDatabase } from "../../../sdk/testing.ts";
import { INSPIRATIONS_DATABASE, INSPIRATIONS_DB } from "./db.ts";
import { inspirationsFolder } from "./files.ts";
import { Inspirations } from "./store.ts";

const SCRIPT = fileURLToPath(new URL("../../../server/archive/cli.ts", import.meta.url));

/** The module's database in the test's folder, open, for a test to fill before the command reads it. */
const openStore = () => openModuleDatabase(join(inspirationsFolder(dataDir), INSPIRATIONS_DB), INSPIRATIONS_DATABASE).db;

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "life-archive-inspiration-cli-"));
  openCore(join(dataDir, CORE_FILE)).close();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function archive(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--no-warnings", SCRIPT, ...args, "--data", dataDir]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
}

/** A command's output without the changeset line it ends with (checked to be there). */
function changed(output: { stdout: string }): string {
  const line = /^Changeset #\d+, after the backup \S+\.sqlite; undo it with: npm run archive -- inspiration changes undo \d+\n/m;
  expect(output.stdout).toMatch(line);
  return output.stdout.replace(line, "");
}

it("captures a link with the agent's words and what it saw, and a second save of it joins the item", async () => {
  const first = await archive("inspiration", "add", "https://www.instagram.com/reel/AbC123xyz/?igsh=MWQ1", "--caption", "the slow hands thing, I want to try this",
    "--tag", "craft,Art", "--title", "Throwing a tall vase", "--author", "@studio.example", "--description", "A potter throws a tall vase on a wheel", "--origin", "grok-bot");
  expect(first.code).toBe(0);
  expect(first.stdout).toBe([
    "Inspiration #1 (new): https://www.instagram.com/p/AbC123xyz/ [instagram reel]",
    "  title: Throwing a tall vase",
    "  author: @studio.example",
    "  caption: the slow hands thing, I want to try this",
    "  tags: craft, art",
    "  AI tags: on their way: the archive's server makes them within a minute (--wait waits for them)",
    "",
  ].join("\n"));
  const again = await archive("inspiration", "add", "instagram.com/p/AbC123xyz", "--caption", "for the kids' clay day", "--tag", "parenting", "--origin", "grok-bot");
  expect(again.stdout).toContain("Inspiration #1 (another save of it): https://www.instagram.com/p/AbC123xyz/");
  expect(again.stdout).toContain("  caption: the slow hands thing, I want to try this\n           \n           for the kids' clay day");
  const shown = await archive("inspiration", "show", "1", "--json");
  expect(JSON.parse(shown.stdout)).toMatchObject({ tags: ["craft", "art", "parenting"], description: "A potter throws a tall vase on a wheel", saveCount: 2 });
  expect(await archive("inspiration", "add", "not a link")).toMatchObject({ code: 1, stderr: `"not a link" is neither a link nor a file\n` });
});

it("asks for no probe, but still shows the one an old item carries", async () => {
  await archive("inspiration", "add", "https://blog.example.com/lamp", "--caption", "build this", "--origin", "share-sheet");
  const fresh = await archive("inspiration", "show", "1");
  expect(fresh.code).toBe(0);
  expect(fresh.stdout).not.toContain("probe");
  // Nothing sets a probe's result any more: the command is gone.
  expect(await archive("inspiration", "probe", "1", "--result", "https://boards.example.com/session/made-up")).toMatchObject({ code: 1 });
  // An item kept before that carries its fields, which stay readable, stored as they were.
  const db = openStore();
  db.prepare("UPDATE inspiration SET probe_requested_at = ?, probe_result = ?, probe_result_at = ? WHERE id = 1").run(Date.parse("2026-11-07T10:00:00Z"), "https://boards.example.com/session/made-up", Date.parse("2026-11-07T12:00:00Z"));
  db.close();
  expect((await archive("inspiration", "show", "1")).stdout).toMatch(/\n {2}probe: asked of firstmate \d{4}-\d\d-\d\d [^;]+; result https:\/\/boards\.example\.com\/session\/made-up \(\d{4}-\d\d-\d\d [^)]+\)\n/);
  expect(JSON.parse((await archive("inspiration", "show", "1", "--json")).stdout).probe).toMatchObject({ result: "https://boards.example.com/session/made-up" });
});

it("keeps a photo by its content hash in the module's files/", async () => {
  const photo = join(dataDir, "..", `made-up-${Date.now()}.png`);
  await writeFile(photo, "made-up image bytes");
  try {
    const kept = await archive("inspiration", "add", photo, "--caption", "tiles for the bathroom", "--tag", "interior-design");
    expect(kept.stdout).toContain("Inspiration #1 (new): a kept file [file image]");
    const [folder] = await readdir(join(inspirationsFolder(dataDir), "files"));
    expect((await readdir(join(inspirationsFolder(dataDir), "files", folder)))[0]).toMatch(/^[0-9a-f]{64}\.png$/);
    expect((await archive("inspiration", "add", photo)).stdout).toContain("Inspiration #1 (another save of it)");
  } finally {
    await rm(photo, { force: true });
  }
});

it("lists by his tags or the AI's, edits as changesets that undo, and edits many after a dry run", async () => {
  const db = openStore();
  const store = new Inspirations(db);
  const now = Date.parse("2026-10-18T09:00:00+11:00");
  for (const [link, tags] of [["https://example.com/vase", ["craft", "art"]], ["https://example.com/lullaby", ["music"]], ["https://example.com/soup", []]] as const) {
    store.capture({ link, tags, origin: "cli", savedAt: now, now });
  }
  store.setAiTags(3, ["cooking", "comfort-food"], "made-up-model", now);
  db.close();
  expect((await archive("inspiration", "list", "--tag", "art")).stdout).toBe("#1  2026-10-18  web  https://example.com/vase  [craft, art]\n1 of 1 inspiration.\n");
  expect((await archive("inspiration", "list", "--ai-tag", "cooking")).stdout).toContain("#3  2026-10-18  web  https://example.com/soup  [untagged]  AI: cooking, comfort-food\n");
  expect((await archive("inspiration", "list", "--tag", "art", "--ai-tag", "cooking")).stderr).toContain("not both at once");
  expect(changed(await archive("inspiration", "untag", "1", "art", "--why", "not art after all"))).toBe("#1  2026-10-18  web  https://example.com/vase  [craft]\n");
  expect(changed(await archive("inspiration", "changes", "undo", "1"))).toContain(`inspiration #1 "https://example.com/vase": tags craft -> craft, art`);

  const dry = await archive("inspiration", "edit", "tag", "Cooking", "--ai-tag", "cooking");
  expect(dry.stdout).toBe([
    "inspiration edit tag cooking: 1 chosen.",
    "Would change 1:",
    "  #3  https://example.com/soup: (none) -> cooking",
    "Already so 0.",
    `Nothing written (a dry run). To make it, run the same with --apply --expect 1 --why "<the captain's words>".`,
    "",
  ].join("\n"));
  expect((await archive("inspiration", "edit", "tag", "cooking", "--ai-tag", "cooking", "--apply", "--expect", "2")).stderr).toContain("this would change 1 item, not 2");
  expect(changed(await archive("inspiration", "edit", "tag", "cooking", "--ai-tag", "cooking", "--apply", "--expect", "1"))).toBe("Changed 1:\n  #3  https://example.com/soup: (none) -> cooking\n");
  expect((await archive("inspiration", "edit", "tag", "cooking")).stderr).toContain("choose the items with --items");
});

it("keeps his vocabulary: add with what it covers, rename onto another to merge, move, delete", async () => {
  changed(await archive("inspiration-tag", "add", "Interior", "design", "--description", "rooms, tiles and furniture"));
  changed(await archive("inspiration-tag", "add", "rooms"));
  changed(await archive("inspiration-tag", "move", "rooms", "1"));
  expect(changed(await archive("inspiration-tag", "rename", "rooms", "interior-design"))).toBe("Merged rooms into interior-design.\n");
  expect((await archive("inspiration-tag", "list")).stdout).toBe("1  interior-design (0): rooms, tiles and furniture\n1 tags; 0 of 0 items tagged.\nAI tags in use: none yet.\n");
  expect(changed(await archive("inspiration-tag", "delete", "interior-design"))).toBe("Deleted the inspiration tag interior-design, taken from 0 items.\n");
  expect((await archive("inspiration-tag", "delete", "nothing")).stderr).toBe(`there is no inspiration tag "nothing"\n`);
});

it("starts and stops Instagram's previews, and says how they stand, with no changeset", async () => {
  const db = openStore();
  const store = new Inspirations(db);
  const now = Date.parse("2026-10-19T09:00:00+11:00");
  for (const code of ["MadeUpA001", "MadeUpA002"]) {
    const { id } = store.capture({ link: `https://www.instagram.com/p/${code}/`, title: `Instagram save ${code}`, origin: "instagram-saves-import", nativeId: code, savedAt: now, now });
    store.setPreview(id, "none");
  }
  db.close();
  expect((await archive("inspiration", "instagram")).stdout).toBe([
    "Instagram's previews: 0 found, 0 waiting, 0 skipped, 0 given up on, 2 not asked for.",
    "  0 of 100 posts fetched in the last 24 hours.",
    "",
  ].join("\n"));
  const started = await archive("inspiration", "instagram", "start");
  expect(started.stdout).toBe([
    "Asked for 2 Instagram previews. The archive's server fetches them one post at a time, 15 to 30 s apart, at most 100 a day: about 1 day for the 2 waiting.",
    "Instagram's previews: 0 found, 2 waiting, 0 skipped, 0 given up on, 0 not asked for.",
    "  0 of 100 posts fetched in the last 24 hours.",
    "  The next is due now: the archive's server fetches it within a few seconds, if it is running.",
    "",
  ].join("\n"));
  expect((await archive("inspiration", "instagram", "start")).stdout).toContain("Every Instagram item has its preview, or is waiting for it, already.\n");
  expect((await archive("inspiration", "instagram", "stop")).stdout).toContain("Stopped: 2 Instagram previews are asked for no more (inspiration instagram start asks again).\n");
  expect((await archive("inspiration", "show", "1")).stdout).toContain("  preview: none (stopped: inspiration instagram start asks again)\n");
  expect((await archive("inspiration", "instagram", "now")).stderr).toContain("inspiration instagram | inspiration instagram start | inspiration instagram stop");
  expect((await archive("changes", "list")).stdout).not.toContain("instagram");
});
