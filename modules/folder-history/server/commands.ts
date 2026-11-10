// The folder history's command of `npm run archive` (sdk/server.ts's `commands`), which the archive's CLI hands on:
//
//   history [<folder>] [--last <n>]   with no folder, each folder's state (folderReport); with one, its state and its
//                                     last commits, each with the files it added, changed or deleted, never their content
//
// It reads only: the settings, the folder's file list and the history's log; it never writes into either.

import { dayKey, runPromise, timeOfDay } from "../../../sdk/server.ts";
import { conflictText, type FileChange, folderReport, type FolderReport, historyDir, readSettings, recentCommits, SETTINGS_FILE } from "./folderHistory.ts";

/** What `npm run archive` lists of it, among the structure commands. */
export const HISTORY_HELP = `  history [<folder>] [--last <n>]       the folder history, of each folder data/${SETTINGS_FILE} names:
                                        its history's commits, what is not in it yet and Drive's conflict copies; for
                                        one folder (data/history/<folder>/), its last commits too (20 unless said),
                                        each with the files it added, changed or deleted, never their content`;

/** `history [<folder>]`: a folder's last commits and its conflict copies, or each folder's state; printed through `print`. */
export async function historyCommand(dataDir: string, name: string | undefined, { last: lastText }: { last?: unknown }, print: (line: string) => void = console.log): Promise<void> {
  const { folders } = await runPromise(readSettings(dataDir));
  if (name === undefined) {
    if (folders.length === 0) return print(`folder-history: no folders named (data/${SETTINGS_FILE})`);
    for (const folder of folders) printFolderReport(await runPromise(folderReport(dataDir, folder)), print);
    return;
  }
  const folder = folders.find((f) => f.name === name);
  if (!folder) throw new Error(`no folder ${name} in data/${SETTINGS_FILE}; the folders are ${folders.map((f) => f.name).join(", ") || "none"}`);
  const last = lastText === undefined ? 20 : Number(lastText);
  if (!Number.isInteger(last) || last < 1) throw new Error("--last takes a number of commits");
  const report = await runPromise(folderReport(dataDir, folder));
  printFolderReport(report, print);
  if (report.commits === 0) return;
  print("");
  for (const commit of await runPromise(recentCommits(historyDir(dataDir, folder.name), last))) {
    print(`${dayKey(commit.at)} ${timeOfDay(commit.at)}  ${commit.commit.slice(0, 7)}  ${commit.changes.length} ${commit.changes.length === 1 ? "file" : "files"}`);
    for (const change of commit.changes) print(`  ${change.change} ${change.path}`);
  }
}

const changesText = (changes: readonly FileChange[]) => changes.map((c) => `${c.change} ${c.path}`).join(", ");

function printFolderReport(report: FolderReport, print: (line: string) => void): void {
  const { folder, repo, resolved, commits, last, pending, conflicts, problem } = report;
  print(`folder-history: ${folder.name}`);
  print(`  folder: ${folder.path}${typeof resolved === "string" ? (resolved === folder.path ? "" : ` (at ${resolved})`) : `: ${resolved.missing}`}`);
  const at = (ms: number) => `${dayKey(ms)} ${timeOfDay(ms)}`;
  print(`  history: ${repo}, ${commits === 0 ? "no commits yet" : `${commits} ${commits === 1 ? "commit" : "commits"}`}${last ? `, the last ${at(last.at)} (${last.changes.length} ${last.changes.length === 1 ? "file" : "files"})` : ""}`);
  if (problem) print(`  not kept: ${problem}`);
  if (pending) {
    print(pending.length === 0
      ? "  the history has the folder as it is now"
      : `  ${pending.length} ${pending.length === 1 ? "change" : "changes"} not in the history yet (the server records them seconds after the folder settles): ${changesText(pending.slice(0, 10))}${pending.length > 10 ? ", ..." : ""}`);
  }
  if (conflicts.length > 0) print(`  Drive conflict ${conflicts.length === 1 ? "copy" : "copies"}, to resolve in the folder: ${conflictText(conflicts)}`);
}
