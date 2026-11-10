// Judged flags: firstmate's word on a finding of the commit check (scan.ts) that is plainly not private, a version
// string read as an IP address or a made-up test value, so the next check lets that one finding through. Only
// firstmate judges (docs/guard.md's "The privacy guard"): the guard's refusal tells the committing agent to hand it the
// finding's id, and gives the command firstmate runs.
//
// A finding is known by a key: a hash of where it is (the file, its file name, or the commit message), its rule, the
// exact text it matched (hashed), which of that rule's matches of that text it is there, and the text the check read
// around it (hashed: the run of lines the commit adds, or the message), so an allow covers that match in exactly that
// text and any change to either stops it again. Each policy keeps two more records beside the others (records.ts), in
// guard/<policy>/, appended to a line at a time and never holding a matched text:
//
//   flagged-findings.jsonl   every finding the check stopped, once each: when, its id and key, where, its rule and
//                            kind, and the two hashes
//   judgements.jsonl         every judgement: the finding as flagged, the verdict (allow or block), the reason, who
//                            judged and when; the latest for a key is the one that counts
//
// Some findings are never let through, whoever judges: one of the captain's private terms, this machine's own name,
// and the kinds content and secret (a note about a real person is content); an unknown rule neither.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendLines, readLines } from "./records.ts";
import { RULES } from "./scan.ts";

export const FLAGGED_FILE = "flagged-findings.jsonl";
export const JUDGEMENTS_FILE = "judgements.jsonl";

/** Each rule of the commit check as the kind of the privacy policy it finds (BLOCK_KINDS), or "private-term". */
export const RULE_KINDS: Readonly<Record<string, string>> = {
  [RULES.captain]: "name",
  [RULES.captainId]: "account",
  [RULES.person]: "name",
  [RULES.group]: "name",
  [RULES.accountId]: "account",
  [RULES.note]: "content",
  [RULES.phone]: "phone-number",
  [RULES.email]: "email",
  [RULES.chatId]: "account",
  [RULES.tailnet]: "private-host",
  [RULES.lan]: "private-host",
  [RULES.ip]: "ip-address",
  [RULES.street]: "street-address",
  [RULES.machine]: "private-host",
  [RULES.term]: "private-term",
};

const NEVER_KINDS = new Set(["content", "secret"]);

/** Why a finding of this rule can never be let through, or undefined when firstmate may judge it. */
export function neverAllowed(rule: string): string | undefined {
  if (rule === RULES.term) return "it is one of the captain's private terms";
  if (rule === RULES.machine) return "it is this machine's own name, kept as a private term is";
  const kind = RULE_KINDS[rule];
  if (kind === undefined) return "its rule is not one the judgements know";
  if (NEVER_KINDS.has(kind)) return `its kind is ${kind}`;
  return undefined;
}

/** A finding the check stopped, as flagged and judged: never its text. */
export interface Flag {
  /** The first twelve characters of the key: what the guard prints and firstmate judges by. */
  id: string;
  key: string;
  /** Where, for a person to find it: "src/a.ts:12:9", "abc1234 commit message, line 3, column 41". */
  where: string;
  /** The file it is in, "<file> (its file name)" or "commit message". */
  subject: string;
  rule: string;
  kind: string;
  matchHash: string;
  contentHash: string;
}

export interface FlagEntry extends Flag {
  at: string;
  policy: string;
}

export interface JudgementEntry extends FlagEntry {
  verdict: "allow" | "block";
  reason: string;
  by: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * A commit message as the key reads it, the same whether the commit-msg hook (comment lines blanked) or a later check
 * (the message git kept) has it: each line's trailing space gone, blank lines run together, none at either end.
 */
export function messageForKey(message: string): string {
  return message.split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}

/** A finding's key and id, and its two hashes: the `occurrence`th (from 0) match of this text by this rule in `content`. */
export function flagKey(subject: string, rule: string, matched: string, occurrence: number, content: string) {
  const matchHash = sha256(matched);
  const contentHash = sha256(content);
  const key = sha256(JSON.stringify([subject, rule, matchHash, occurrence, contentHash]));
  return { id: key.slice(0, 12), key, matchHash, contentHash };
}

/** Whether any stretch of a text (a judgement's reason) is the matched text, by its hash. */
export function quotesMatch(text: string, matchHash: string): boolean {
  for (let start = 0; start < text.length; start++) {
    for (let end = start + 1; end <= text.length; end++) if (sha256(text.slice(start, end)) === matchHash) return true;
  }
  return false;
}

const parsed = <T>(lines: string[]): T[] =>
  lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });

export const readFlags = async (folder: string) => parsed<FlagEntry>(await readLines(join(folder, FLAGGED_FILE)));

/** Records the findings the check stopped, each key once. */
export async function addFlags(folder: string, entries: FlagEntry[]): Promise<void> {
  const known = new Set((await readFlags(folder)).map((entry) => entry.key));
  const fresh = entries.filter((entry) => !known.has(entry.key) && !!known.add(entry.key));
  await appendLines(folder, FLAGGED_FILE, fresh);
}

export const readJudgements = async (folder: string) => parsed<JudgementEntry>(await readLines(join(folder, JUDGEMENTS_FILE)));

export const addJudgement = (folder: string, entry: JudgementEntry) => appendLines(folder, JUDGEMENTS_FILE, [entry]);

/** The judgement that counts for each key: the latest. */
export function verdicts(entries: JudgementEntry[]): Map<string, JudgementEntry> {
  return new Map(entries.map((entry) => [entry.key, entry]));
}

/** Whether a finding is let through: its latest judgement allows it, and its rule may be allowed at all. */
export function allowedBy(judged: Map<string, JudgementEntry>, flag: Flag): boolean {
  return judged.get(flag.key)?.verdict === "allow" && neverAllowed(flag.rule) === undefined;
}

/** The judgements, newest last, two lines each: when, which policy, the verdict, where and the rule; who and why. */
export function formatJudgements(entries: JudgementEntry[]): string {
  if (entries.length === 0) return "No judgements yet.";
  return entries
    .map((e) => `${e.at.replace("T", " ").slice(0, 16)}  ${e.policy}  ${e.verdict}  ${e.where}  ${e.rule}  (finding ${e.id})\n  by ${e.by}: ${e.reason}`)
    .join("\n");
}
