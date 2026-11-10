// The archive's health results (docs/features.md's "Health"):
//
//   npm run health -- import             reads every health export (Everlab's and My Health Record's, each in
//                                        platform-exports/<platform>/<export date>/) and writes imported.json beside
//                                        by-hand.json (modules/health/, or health/ where an archive keeps them still;
//                                        server/store.ts); says what each file gave and what by-hand.json holds,
//                                        never the results
//   npm run health -- import --dry-run   the same, writing nothing
//   npm run health -- ranges             the one authority on range (ranges.ts, with the labs' intervals in
//                                        lab-intervals.json, beside them): each test, its source and bands, and its grades
//                                        past the line, each source with its stars
//
// The archive's folder is found as every entry point finds it (the core's dataHome.ts, through the SDK). It never opens
// archive.sqlite. A module's command: sdk/command.ts first (the pinned Node, the settings), then the SDK for the rest.

import { DATA_OPTION } from "../../sdk/command.ts";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { archiveFolder } from "../../sdk/server.ts";
import { TESTS, testOf } from "./server/catalogue.ts";
import { importHealth } from "./server/import.ts";
import { rangesWith, readLabIntervals, sourcesWith } from "./server/labIntervals.ts";
import { gradingFor, RANGES_VERSION, type SourceKey } from "./server/ranges.ts";
import { byHandReadings, fileOf, healthDir, healthFileText, onlyTranscribed, printedDifferently, readByHand, writeImported, BY_HAND_FILE, LAB_INTERVALS_FILE } from "./server/store.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { ...DATA_OPTION, "dry-run": { type: "boolean" } } });
const command = positionals[0] ?? "help";

try {
  if (command === "import") await runImport(values["dry-run"] ?? false);
  else if (command === "ranges") await printRanges();
  else {
    console.log("Usage: npm run health -- import [--dry-run] | ranges");
    if (command !== "help") process.exitCode = 1;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}

async function runImport(dryRun: boolean): Promise<void> {
  const dataDir = archiveFolder();
  const byHand = await readByHand(dataDir);
  if (byHand === null) console.log(`No ${healthFileText(dataDir, BY_HAND_FILE)} yet: every file it would transcribe is listed as unread.`);
  const imported = await importHealth({ dataDir, byHand });
  const perFile = new Map<string, number>();
  for (const reading of imported.readings) for (const source of reading.sources) perFile.set(fileOf(source), (perFile.get(fileOf(source)) ?? 0) + 1);
  const why = new Map((byHand?.skipped ?? []).map((s) => [s.file, s.why]));
  for (const file of imported.files) {
    const what = {
      report: `${perFile.get(file.path) ?? 0} results`,
      "by-hand": `transcribed in ${BY_HAND_FILE}`,
      skipped: `skipped in ${BY_HAND_FILE}: ${why.get(file.path)}`,
      unread: "UNREAD: no report the import reads; transcribe it in by-hand.json",
    }[file.read];
    console.log(`  ${file.path}: ${what}`);
  }
  const all = [...imported.readings, ...(byHand ? byHandReadings(byHand) : [])];
  const unknown = [...new Set(all.filter((r) => !testOf(r.test)).map((r) => r.printed))];
  if (unknown.length > 0) console.log(`Printed names no test has (add each to a test's printed names in modules/health/server/catalogue.ts): ${unknown.join(", ")}`);
  // Where two exports print one lab's result for a test on a day, the page shows it once; say where they disagree.
  for (const differ of printedDifferently(all)) console.log(`PRINTED DIFFERENTLY: ${differ.test} on ${differ.date} (${differ.lab}), by ${differ.sources.join("; ")}`);
  if (byHand) {
    const records = [...(byHand.medicare?.services ?? []), ...(byHand.medicare?.pbs ?? [])];
    console.log(
      `${BY_HAND_FILE} holds ${byHand.immunisations?.length ?? 0} immunisations, ${byHand.medicines?.length ?? 0} medicine records, ` +
        `${byHand.medicare?.services.length ?? 0} Medicare services and ${byHand.medicare?.pbs.length ?? 0} PBS items (${records.filter((r) => onlyTranscribed(r, byHand)).length} of those read from a transcription alone).`,
    );
  }
  const unread = imported.files.filter((f) => f.read === "unread").length;
  console.log(`${imported.files.length} files: ${imported.readings.length} results read${unread ? `, ${unread} unread` : ""}.`);
  if (dryRun) return console.log("A dry run: nothing written.");
  await mkdir(healthDir(dataDir), { recursive: true });
  console.log(`Wrote ${await writeImported(dataDir, imported)}`);
}

async function printRanges(): Promise<void> {
  const labs = await readLabIntervals(archiveFolder());
  const [RANGES, SOURCES] = [rangesWith(labs), sourcesWith(labs)];
  console.log(`The authority on range, version ${RANGES_VERSION} (modules/health/server/ranges.ts), with ${labs.length} labs' printed intervals (${healthFileText(archiveFolder(), LAB_INTERVALS_FILE)})`);
  for (const test of TESTS) {
    const authority = RANGES[test.key];
    if (!authority) {
      console.log(`  ${test.name}: NO ENTRY`);
      continue;
    }
    if ("none" in authority) {
      console.log(`  ${test.name}: none. ${authority.none}`);
      continue;
    }
    const bands = authority.bands.map((band) => {
      const who = [band.sex ?? "", band.ages ? `${band.ages[0]}${band.ages[1] === null ? "+" : `–${band.ages[1] - 1}`}` : ""].filter(Boolean).join(" ");
      const low = band.low === undefined ? "" : `${band.lowOpen ? ">" : "≥"}${band.low}`;
      const high = band.high === undefined ? "" : `${band.highOpen ? "<" : "≤"}${band.high}`;
      return `${who ? `${who}: ` : ""}${[low, high].filter(Boolean).join(" and ")}`;
    });
    const stars = (key: SourceKey) => `${SOURCES[key].name} ${"★".repeat(SOURCES[key].stars) || "no stars"}`;
    console.log(`  ${test.name}${test.unit ? ` (${test.unit})` : ""}: ${bands.join("; ") || "by its words"} [${stars(authority.source)}]${authority.note ? ` ${authority.note}` : ""}`);
    for (const side of ["above", "below"] as const) {
      if (!authority.bands.some((band) => (side === "above" ? band.high : band.low) !== undefined)) continue;
      const grading = gradingFor(authority, side);
      if (!grading) {
        console.log(`      ${side}: out past the line; no source grades further`);
        continue;
      }
      console.log(`      ${side}: ${grading.steps.map((step) => `${step.grade}: ${step.label}`).join("; ")} [${stars(grading.source)}]`);
    }
  }
}
