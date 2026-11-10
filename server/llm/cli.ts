// npm run llm -- <command>: the LLM warehouse (docs/events.md's "The LLM warehouse"). Structure only: no command prints a
// word of a prompt or reply.
//
//   import [--again]         read every LLM tool's sessions on this Mac into the index (warehouse.ts), the files
//                            changed since the last pass (every one with --again), then retag
//   retag                    every rule over the whole history again (tags.ts), after a rule changed
//   tags [--json]            how many sessions and prompts have each chosen tag, and how many of them are guesses
//   summary [--by <family>] [--grain day|week|month] [--json]
//                            prompts over time, split by a family's chosen tag (who unless said)
//   rules                    the rules, what each reads
//   tag <event> <family> <value> --why "<words>"     the captain's own tag on a session or prompt (its event number)
//   untag <event> <family>   take his tag off again
// Options: --data <dir> the archive's folder (as npm run archive's); --core <file> another core database to write,
// for a trial (the archive's folder is then only read, for its copies of transcripts deleted by their tools).

import "../onPinnedNode.ts";
import "../onDataFlag.ts";
import "../onSettings.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { CORE_FILE, openCore } from "../archive/coreDb.ts";
import { archiveFolder } from "../dataHome.ts";
import { runMain } from "../effectRuntime.ts";
import { dayKey, LOCALE } from "../../src/time.ts";
import { readContext } from "./context.ts";
import { warehousePass } from "./pass.ts";
import { RULES } from "./rules.ts";
import { FAMILIES, retag, type RetagResult, tagByHand, tagCounts, untagByHand } from "./tags.ts";
import { PROMPTS_SQL } from "./views.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: "string" }, core: { type: "string" }, again: { type: "boolean" }, json: { type: "boolean" },
    by: { type: "string" }, grain: { type: "string" }, why: { type: "string" }, help: { type: "boolean", short: "h" },
  },
});
const [command, ...args] = positionals;
const HELP = readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith("//")).slice(0, 15).map((line) => line.slice(3)).join("\n");
if (!command || values.help) {
  console.log(HELP);
  process.exit(command || values.help ? 0 : 1);
}

const dataDir = archiveFolder();
const n = (value: number) => value.toLocaleString(LOCALE);
const retagLine = (r: RetagResult & { ms: number }) =>
  `Retagged ${n(r.sessions)} sessions in ${(r.ms / 1000).toFixed(1)} s: ${n(r.added)} tags added, ${n(r.removed)} taken off, ${n(r.kept)} as they were.`;

if (command === "import") {
  const program = warehousePass({ dataDir, ...(values.core ? { coreFile: resolve(values.core) } : {}), again: values.again ?? false, log: (line) => console.log(line) }).pipe(
    Effect.catchTag("WarehouseError", (error) => Effect.sync(() => {
      console.error(error.message);
      process.exitCode = 1;
      return null;
    })),
  );
  const done = await runMain(program);
  if (done) {
    const { imported: result, retagged } = done;
    console.log(`Read ${n(result.read)} of ${n(result.files)} session files in ${(result.ms / 1000).toFixed(1)} s: ${n(result.indexed)} sessions indexed, ${n(result.measured)} of the connectors' measured.`);
    for (const [why, count] of Object.entries(result.leftOut).sort((a, b) => b[1] - a[1])) console.log(`  ${n(count)} ${why}`);
    for (const [kind, c] of Object.entries(result.counts)) if (c) console.log(`  ${kind}: ${n(c.added)} added, ${n(c.updated)} updated, ${n(c.unchanged)} unchanged`);
    console.log(retagLine(retagged));
  }
  process.exit();
}

const coreFile = values.core ? resolve(values.core) : join(dataDir, CORE_FILE);
if (!values.core && !existsSync(coreFile)) {
  console.error(`there is no archive in ${dataDir} (no ${CORE_FILE})`);
  process.exit(1);
}
const db = openCore(coreFile);

try {
  switch (command) {
    case "retag": {
      const started = Date.now();
      const context = readContext();
      if (context.t3.problem) console.error(`The rules run without T3's records: ${context.t3.problem}`);
      const result = retag(db, context);
      console.log(retagLine({ ...result, ms: Date.now() - started }));
      break;
    }
    case "tags": {
      const counts = tagCounts(db);
      if (values.json) {
        console.log(JSON.stringify(counts, null, 2));
        break;
      }
      let last = "";
      for (const row of counts) {
        const head = `${row.target === "turn" ? "turns" : "sessions"} by ${row.family}`;
        if (head !== last) console.log(`\n${head}`);
        last = head;
        console.log(`  ${row.value.padEnd(22)} ${n(row.count).padStart(9)}${row.guesses ? `  (${n(row.guesses)} guessed)` : ""}${row.hand ? `  (${n(row.hand)} by hand)` : ""}`);
      }
      break;
    }
    case "summary": {
      const by = values.by ?? "who";
      const columns = ["who", "device", "channel", "tool", "app", "session_kind", "task", "project", "origin"];
      const column = by === "session" ? "session_kind" : by;
      if (!columns.includes(column)) throw new Error(`summary splits by one of ${[...FAMILIES, "origin"].join(", ")}`);
      const grain = values.grain ?? "month";
      if (!["day", "week", "month"].includes(grain)) throw new Error("--grain is day, week or month");
      const rows = db.prepare(`SELECT at, ${column} AS value FROM (${PROMPTS_SQL})`).all() as Array<{ at: number; value: string }>;
      const bucket = (at: number) => {
        const day = dayKey(at);
        if (grain === "day") return day;
        if (grain === "month") return day.slice(0, 7);
        const date = new Date(`${day}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
        return `week of ${date.toISOString().slice(0, 10)}`;
      };
      const table = new Map<string, Map<string, number>>();
      const totals = new Map<string, number>();
      for (const row of rows) {
        const b = bucket(row.at);
        const value = row.value || "(none)";
        const counts = table.get(b) ?? new Map<string, number>();
        counts.set(value, (counts.get(value) ?? 0) + 1);
        table.set(b, counts);
        totals.set(value, (totals.get(value) ?? 0) + 1);
      }
      const order = [...totals].sort((a, b) => b[1] - a[1]).map(([value]) => value);
      if (values.json) {
        console.log(JSON.stringify({ by, grain, values: order, buckets: [...table].sort().map(([b, counts]) => ({ bucket: b, ...Object.fromEntries(counts) })) }, null, 2));
        break;
      }
      console.log(`Prompts by ${by}, a ${grain} at a time (${n(rows.length)} in all)`);
      console.log(["".padEnd(20), ...order.map((v) => v.padStart(14))].join(""));
      for (const [b, counts] of [...table].sort()) console.log([b.padEnd(20), ...order.map((v) => n(counts.get(v) ?? 0).padStart(14))].join(""));
      console.log(["all".padEnd(20), ...order.map((v) => n(totals.get(v)!).padStart(14))].join(""));
      break;
    }
    case "rules":
      for (const rule of RULES) console.log(`${rule.id}: ${rule.about}`);
      break;
    case "tag": {
      const [event, family, ...value] = args;
      if (!event || !family || value.length === 0) throw new Error('tag <event> <family> <value> --why "<the captain\'s words>"');
      if (!values.why) throw new Error("give the captain's words for it with --why");
      tagByHand(db, Number(event), family, value.join(" "), values.why);
      console.log(`Tagged event ${event} ${family} ${value.join(" ")} by hand; npm run llm -- untag ${event} ${family} takes it off.`);
      break;
    }
    case "untag": {
      const [event, family] = args;
      if (!event || !family) throw new Error("untag <event> <family>");
      console.log(untagByHand(db, Number(event), family) ? `Took the hand tag in ${family} off event ${event}.` : `Event ${event} had no hand tag in ${family}.`);
      break;
    }
    default:
      throw new Error(`no command ${JSON.stringify(command)}: npm run llm -- --help`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
