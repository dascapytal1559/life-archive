// What the guard keeps for each repository's policy, in the archive's folder (guard/<policy>/), never committed:
//
//   reviewed-commits.jsonl   every commit the model's review passed, by its full sha, with when and why: settled, and
//                            neither check reads it again; and each commit settled with all its history (`npm run guard
//                            -- settle`, `"history": true`): history published before the guard was installed, which no
//                            check reads, nor who made it
//   privacy-reviews.jsonl    every review: when, the remote, which commits, the verdict, how many findings stopped it
//                            and how many were suggestions, the model, its effort and how long it took, never what it
//                            read
//   privacy-findings.jsonl   every finding of the model's: when, the remote, the model, its commit, file and line, its
//                            kind, whether it stopped the push and if not why not, and the model's reason and
//                            suggestion, never the text it quoted; `npm run guard -- findings` lists them, for the
//                            captain to look over now and then
//   flagged-findings.jsonl   every finding the commit check stopped, and
//   judgements.jsonl         firstmate's judgement of each it judged (judgements.ts)
//
// All are appended to, a line at a time. A line that cannot be read is passed over, which for the record only means
// its commits are checked again.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { guardFolder } from "./dictionary.ts";

export const LOG_FILE = "privacy-reviews.jsonl";
export const REVIEWED_FILE = "reviewed-commits.jsonl";
export const FINDINGS_FILE = "privacy-findings.jsonl";

/** Where a policy's records are kept. */
export const recordsFolder = (archiveDir: string, policy: string) => join(guardFolder(archiveDir), policy);

export interface LogEntry {
  at: string;
  remote: string;
  range: string;
  commits: number;
  /** "findings" when a finding stopped it; "pass" when none did, suggestions or not. */
  verdict: "pass" | "findings" | "unavailable" | "bypassed";
  /** How many findings stopped it. */
  findings?: number;
  /** How many were suggestions, which stop nothing. */
  suggestions?: number;
  why?: string;
  model: string;
  effort: string;
  calls?: number;
  seconds: number;
}

/** One line of the record: commits the review passed (full shas), when and why; with `history`, settled with all before them. */
export interface ReviewedEntry {
  at: string;
  why: string;
  commits: string[];
  history?: boolean;
}

/** A record's lines, none without the file. */
export const readLines = async (path: string) => (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean);

/** Appends entries to a record, a line each, in one write; nothing for none. */
export async function appendLines(folder: string, file: string, entries: object[]): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(folder, { recursive: true });
  await appendFile(join(folder, file), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}

const append = (folder: string, file: string, entry: object) => appendLines(folder, file, [entry]);

export async function readLog(folder: string): Promise<LogEntry[]> {
  return (await readLines(join(folder, LOG_FILE))).flatMap((line) => {
    try {
      return [JSON.parse(line) as LogEntry];
    } catch {
      return [];
    }
  });
}

export const addLog = (folder: string, entry: LogEntry) => append(folder, LOG_FILE, entry);

/** One finding of the model's review, as the guard judged it. */
export interface FindingEntry {
  at: string;
  remote: string;
  model: string;
  /** The commit's full sha, or "" for a place the model did not name. */
  commit: string;
  file: string;
  line: number;
  /** One of the policy's kinds, or "other" for a suggestion. */
  kind: string;
  stops: boolean;
  /** Why it did not stop the push: a suggestion, its text not found, or plainly made up. */
  why?: string;
  reason: string;
  suggestion: string;
}

export const addFindings = (folder: string, entries: FindingEntry[]) => appendLines(folder, FINDINGS_FILE, entries);

export async function readFindings(folder: string): Promise<FindingEntry[]> {
  return (await readLines(join(folder, FINDINGS_FILE))).flatMap((line) => {
    try {
      return [JSON.parse(line) as FindingEntry];
    } catch {
      return [];
    }
  });
}

/** The findings, newest last, each on its own lines: when, which policy, where, whether it stopped the push, why, and what instead. */
export function formatFindings(entries: Array<FindingEntry & { policy: string }>): string {
  if (entries.length === 0) return "No findings yet.";
  return entries
    .map((e) => {
      const place = e.commit ? `${e.commit.slice(0, 10)} ${e.file === "commit message" ? `commit message, line ${e.line}` : e.line === 0 ? `${e.file} (its file name)` : `${e.file}:${e.line}`}` : "(a place it did not name)";
      const verdict = e.stops ? `stopped: ${e.kind}` : e.kind === "other" ? "suggestion" : `${e.kind}, not stopped: ${e.why}`;
      const head = `${e.at.replace("T", " ").slice(0, 16)}  ${e.policy}  ${place}  [${verdict}]`;
      return [head, `  ${e.reason}`, ...(e.suggestion ? [`  instead: ${e.suggestion}`] : [])].join("\n");
    })
    .join("\n");
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Every commit the review has passed, by its full sha (or, `history` alone, each settled with its history): none without the record. */
export async function readReviewed(folder: string, { history = false } = {}): Promise<Set<string>> {
  const shas = new Set<string>();
  for (const line of await readLines(join(folder, REVIEWED_FILE))) {
    try {
      const entry = JSON.parse(line) as Partial<ReviewedEntry>;
      if (history && entry.history !== true) continue;
      if (Array.isArray(entry.commits)) for (const sha of entry.commits) if (typeof sha === "string" && FULL_SHA.test(sha)) shas.add(sha);
    } catch {
      // not a line of the record
    }
  }
  return shas;
}

/** Records commits as settled with all their history, with when and why; those already so are not added again. */
export async function addSettled(folder: string, shas: string[], why: string, at: Date): Promise<string[]> {
  const known = await readReviewed(folder, { history: true });
  const commits = [...new Set(shas)].filter((sha) => !known.has(sha));
  if (commits.length > 0) await append(folder, REVIEWED_FILE, { at: at.toISOString(), why, commits, history: true } satisfies ReviewedEntry);
  return commits;
}

/** Records commits the review passed, with when and why; those already recorded are not added again. */
export async function addReviewed(folder: string, shas: string[], why: string, at: Date): Promise<void> {
  const known = await readReviewed(folder);
  const commits = [...new Set(shas)].filter((sha) => !known.has(sha));
  if (commits.length === 0) return;
  await append(folder, REVIEWED_FILE, { at: at.toISOString(), why, commits } satisfies ReviewedEntry);
}

/** The log as a table, newest last. */
export function formatLog(entries: LogEntry[]): string {
  if (entries.length === 0) return "No privacy reviews yet.";
  const rows = entries.map((e) => [
    e.at.replace("T", " ").slice(0, 19),
    e.remote || "(review)",
    e.range,
    String(e.commits),
    e.verdict + (e.findings ? ` (${e.findings})` : "") + (e.suggestions ? ` +${e.suggestions} suggested` : ""),
    `${e.seconds} s`,
    `${e.model} ${e.effort}`,
    e.why ?? "",
  ]);
  const head = ["when (UTC)", "remote", "range", "commits", "verdict", "time", "model", ""];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [head, ...rows].map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}
