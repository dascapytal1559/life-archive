// LLM sessions for the made-up crowd (friend map's modules/friend-map/fixtures/crowd.ts, with its hangouts), so the
// viewer's LLM tab and its charts have something to show: the captain's made-up conversations with an LLM over the last
// six weeks, in made-up project folders, written as session files in the archive's copies and read by the llm-sessions
// connector's own reader, so a session opened in the viewer has made-up words. Seeded apart from the crowd, so the
// crowd is as it was.
//
//   npm run testing-data -- /tmp/life-archive-crowd --crowd

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { addDays, dayKey } from "../../src/time.ts";
import { claudeCode, projectFolder } from "../connectors/llm-sessions/read.ts";
import { LLM_FOLDER } from "../connectors/sessionCopies.ts";
import type { ArchiveEvent } from "../connectors/contract.ts";

const PROJECTS = ["garden-planner", "recipe-box", "trail-map", "life-archive"].map((name) => `/home/sample/Projects/${name}`);
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"];

/** What the captain asks, made up: a project's own asks, then any project's. */
const ASKS: Record<string, string[]> = {
  "garden-planner": ["Add a frost warning to the planting calendar.", "Why do the tomato beds show twice on the plan?", "Make the watering schedule skip rainy days."],
  "recipe-box": ["Let me scale a recipe by the number of guests.", "The shopping list should merge the same ingredient.", "Sort the soups by how long they take."],
  "trail-map": ["Show each trail's climb as a small chart.", "The map loses the last waypoint when I zoom out. Can you look?", "Add the huts along the coast walk."],
  "life-archive": ["Make the table remember its sort.", "Can the chart split by app?", "The drawer should say which device a session ran on."],
  any: ["Run the tests and tell me what fails.", "Tidy up that last change, the names are confusing.", "Write the devlog entry for this.", "Looks good, commit it.", "What would you change before we ship this?"],
};
const ANSWERS = [
  "Done. I added it beside the existing check, so both paths share one rule, and the tests cover the new case.",
  "Found it: the list was built twice, once on load and once on every change. It now builds once and updates in place.",
  "Here is the change:\n\n```ts\nexport function scaled(recipe: Recipe, guests: number): Recipe {\n  const factor = guests / recipe.serves;\n  return { ...recipe, serves: guests, items: recipe.items.map((item) => ({ ...item, amount: item.amount * factor })) };\n}\n```\n\nAmounts keep their units; only the numbers change.",
  "All 214 tests pass, and the typecheck is clean.",
  "Two things I would change first:\n\n1. The settings are read in three places; one reader would do.\n2. The empty state says nothing about why it is empty.\n\nNeither blocks shipping.",
  "Committed as one change, with the devlog entry and its screenshot.",
  "I renamed the helpers after what they return rather than how, and moved the date maths into one place.",
];
const NOTICES = ["The background build finished.", "The test run in the background finished: all passed."];
const TOOLS: Array<[string, Record<string, string>]> = [
  ["Bash", { command: "npm test" }], ["Bash", { command: "npm run typecheck" }], ["Bash", { command: "git status --short" }],
  ["Read", { file_path: "/home/sample/Projects/src/plan.ts" }], ["Grep", { pattern: "watering" }],
  ["Edit", { file_path: "/home/sample/Projects/src/list.ts", old_string: "items.push(item)", new_string: "items.set(item.id, item)" }],
];

/**
 * The captain's made-up conversations with an LLM over the last six weeks, written as Claude Code's session files in
 * the archive's copies under `dataDir` (data/llm/claude-code/<project folder>/<session>.jsonl, as the llm-sessions
 * connector keeps them), and their events as the connector reads them (its own reader, claudeCode.read), on a made-up
 * device: so the LLM tab has rows and a session opened from a drawer has words to read. Every word is made up.
 */
export async function crowdLlm(dataDir: string, end = Date.now()): Promise<ArchiveEvent[]> {
  const random = mulberry32(20261014);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const events: ArchiveEvent[] = [{ kind: "device", key: "computer:sample-mac", name: "sample-mac", deviceKind: "computer" }];
  let n = 0;
  for (let s = 0; s < 36; s++) {
    const startedAt = end - Math.floor((1 - s / 36) * 42 * 86_400_000) + Math.floor(random() * 6 * 3_600_000);
    if (startedAt >= end - 3_600_000) continue;
    const id = `00000000-0000-4000-8000-${String(s).padStart(12, "0")}`;
    const project = PROJECTS[Math.floor(random() ** 1.3 * PROJECTS.length)];
    const model = MODELS[random() < 0.75 ? 0 : 1];
    const lines: Array<Record<string, unknown>> = [];
    let at = startedAt;
    const base = () => ({ parentUuid: null, isSidechain: false, userType: "external", cwd: project, sessionId: id, version: "2.1.0", gitBranch: "main", entrypoint: "cli", timestamp: new Date(at).toISOString() });
    const user = (origin: string, text: string) =>
      lines.push({ ...base(), type: "user", uuid: `e-${n++}`, origin: { kind: origin }, message: { role: "user", content: text } });
    const said = (block: Record<string, unknown>) =>
      lines.push({ ...base(), type: "assistant", uuid: `e-${n++}`, message: { model, id: `msg-${n}`, type: "message", role: "assistant", content: [block] } });
    const reply = (text: string, tools: number) => {
      for (let t = 0; t < tools; t++) {
        const [name, input] = pick(TOOLS);
        said({ type: "tool_use", id: `tool-${n}`, name, input });
        at += 2_000 + Math.floor(random() * 20_000);
        lines.push({ ...base(), type: "user", uuid: `e-${n++}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tool-${n}`, content: "ok" }] } });
      }
      at += 3_000 + Math.floor(random() * 30_000);
      said({ type: "text", text });
    };
    const asks = [...ASKS[folderName(project)], ...ASKS.any];
    for (let p = 2 + Math.floor(random() * 26); p > 0 && at < end - 120_000; p--) {
      user("human", pick(asks));
      at += 5_000 + Math.floor(random() * 20_000);
      reply(pick(ANSWERS), Math.floor(random() ** 2 * 8));
      if (random() < 0.3) {
        at += 60_000 + Math.floor(random() * 600_000);
        user("task-notification", pick(NOTICES));
        at += 10_000;
        reply("Noted: nothing more to do there.", Math.floor(random() * 2));
      }
      at += 60_000 + Math.floor(random() ** 3 * 3_600_000);
    }
    const file = join(dataDir, LLM_FOLDER, "claude-code", projectFolder(project), `${id}.jsonl`);
    await mkdir(dirname(file), { recursive: true });
    const content = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
    await writeFile(file, content);
    const read = await claudeCode.read(file, Buffer.from(content), { path: file, project }, () => {});
    if (typeof read === "string" || "refused" in read) throw new Error(`the made-up session ${id} was not read: ${typeof read === "string" ? read : read.refused}`);
    for (const session of read) events.push({ ...session.event, device: "computer:sample-mac" }, ...session.turns);
  }
  return events;
}

/** A folder's last part. */
function folderName(path: string): string {
  return path.split("/").at(-1)!;
}

/** A small seeded random number generator (as crowd.ts's), so the events are the same every time. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
