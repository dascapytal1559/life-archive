// The LLM warehouse's tags (llm_tag, archive/coreDb.ts): the rules' (rules.ts), written by retag, and the captain's
// by hand. A tag is on a session or a turn (target, target_id: llm_session.id or llm_turn.id), in a family, with its
// value, the rule that gave it ('hand' for his) and whether it is a guess; `chosen` marks each family's one value the
// views read: a hand tag's, else a fact's over a guess's, else the earliest rule's (RULES' order).
//
// retag runs every rule over every session of the index (sessions read with their prompts and facts, never a file)
// and brings the rules' tags to what they say: a tag no rule gives any more goes, a new one comes, the rest stay as
// they are (their times too), so running it again changes nothing. Hand tags are never touched by it.

import type { Db } from "../archive/db.ts";
import { transaction } from "../archive/db.ts";
import type { RuleContext } from "./context.ts";
import { RULES, tagsOf, type Proposal, type SessionRecord } from "./rules.ts";
import type { SessionFacts, TurnFacts } from "./types.ts";

/** The families a tag can be in, a session's and a turn's. */
export const SESSION_FAMILIES = ["tool", "app", "session", "task", "project"] as const;
export const TURN_FAMILIES = ["who", "device", "channel"] as const;
export const FAMILIES: readonly string[] = [...SESSION_FAMILIES, ...TURN_FAMILIES];

const parse = <T>(text: string | null): T => {
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return {} as T;
  }
};

/** Every session of the index, with its prompts, as the rules read them. */
export function sessionRecords(db: Db): SessionRecord[] {
  const sessions = db
    .prepare(
      `SELECT s.id, e.origin, e.native_id, coalesce(e.subkind, '') AS entrypoint, s.project, e.at, s.facts
       FROM llm_session s JOIN event e ON e.detail = 'llm_session' AND e.detail_id = s.id ORDER BY s.id`,
    )
    .all() as Array<{ id: number; origin: string; native_id: string; entrypoint: string; project: string; at: number; facts: string | null }>;
  const prompts = new Map<number, SessionRecord["prompts"]>();
  for (const row of db
    .prepare(`SELECT t.id, t.session_id, e.at, t.facts FROM llm_turn t JOIN event e ON e.detail = 'llm_turn' AND e.detail_id = t.id WHERE t.role = 'prompt' ORDER BY e.at, t.id`)
    .all() as Array<{ id: number; session_id: number; at: number; facts: string | null }>) {
    const list = prompts.get(row.session_id) ?? [];
    list.push({ id: row.id, at: row.at, facts: parse<TurnFacts>(row.facts) });
    prompts.set(row.session_id, list);
  }
  return sessions.map((s) => ({
    id: s.id, origin: s.origin, nativeId: s.native_id, entrypoint: s.entrypoint, project: s.project, at: s.at,
    facts: parse<SessionFacts>(s.facts), prompts: prompts.get(s.id) ?? [],
  }));
}

export interface RetagResult {
  sessions: number;
  added: number;
  removed: number;
  kept: number;
}

const keyOf = (t: { target: string; targetId: number; family: string; value: string; rule: string }) => `${t.target}|${t.targetId}|${t.family}|${t.value}|${t.rule}`;

/** Every rule over every session (see the top of this file), in one transaction. */
export function retag(db: Db, context: RuleContext, now = Date.now()): RetagResult {
  return transaction(db, () => {
    const records = sessionRecords(db);
    const proposed = new Map<string, Proposal>();
    for (const record of records) for (const p of tagsOf(record, context)) if (!proposed.has(keyOf(p))) proposed.set(keyOf(p), p);
    const existing = db.prepare("SELECT id, target, target_id AS targetId, family, value, rule, guess FROM llm_tag WHERE rule <> 'hand'").all() as Array<{ id: number; target: string; targetId: number; family: string; value: string; rule: string; guess: number }>;
    const result: RetagResult = { sessions: records.length, added: 0, removed: 0, kept: 0 };
    const remove = db.prepare("DELETE FROM llm_tag WHERE id = ?");
    const setGuess = db.prepare("UPDATE llm_tag SET guess = ? WHERE id = ?");
    for (const row of existing) {
      const p = proposed.get(keyOf(row));
      if (!p) {
        remove.run(row.id);
        result.removed++;
        continue;
      }
      proposed.delete(keyOf(row));
      if (Number(p.guess) !== row.guess) setGuess.run(Number(p.guess), row.id);
      result.kept++;
    }
    const insert = db.prepare("INSERT INTO llm_tag (target, target_id, family, value, rule, guess, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const p of proposed.values()) {
      insert.run(p.target, p.targetId, p.family, p.value, p.rule, Number(p.guess), now);
      result.added++;
    }
    choose(db);
    return result;
  });
}

/** The ORDER BY that ranks a family's tags: a hand tag first (the latest), then facts before guesses, then by rule. */
const RANK = `(rule = 'hand') DESC, guess, CASE rule ${RULES.map((r, i) => `WHEN '${r.id}' THEN ${i}`).join(" ")} ELSE ${RULES.length} END, at DESC, id`;

/** Marks each family's chosen tag, over every target (or one target's family). */
export function choose(db: Db, only?: { target: string; targetId: number; family: string }): void {
  const where = only ? "WHERE target = ? AND target_id = ? AND family = ?" : "";
  const params = only ? [only.target, only.targetId, only.family] : [];
  db.prepare(
    `UPDATE llm_tag SET chosen = (id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY target, target_id, family ORDER BY ${RANK}) AS n FROM llm_tag ${where}) WHERE n = 1)) ${where}`,
  ).run(...params, ...params);
}

/** What an event of the index is, as a tag's target: its session or turn. */
export function targetOf(db: Db, eventId: number): { target: "session" | "turn"; targetId: number } | null {
  const row = db.prepare("SELECT detail, detail_id FROM event WHERE id = ? AND detail IN ('llm_session', 'llm_turn')").get(eventId) as { detail: string; detail_id: number } | undefined;
  return row ? { target: row.detail === "llm_session" ? "session" : "turn", targetId: row.detail_id } : null;
}

/** The captain's tag: `value` in `family` on the event's session or turn, over every rule's, with his words; his earlier one in the family goes. */
export function tagByHand(db: Db, eventId: number, family: string, value: string, note: string | null, now = Date.now()): void {
  if (!FAMILIES.includes(family)) throw new Error(`a tag's family is one of ${FAMILIES.join(", ")}, not ${JSON.stringify(family)}`);
  if (value.trim() === "") throw new Error("give the tag a value");
  const target = targetOf(db, eventId);
  if (!target) throw new Error(`event ${eventId} is not an LLM session, prompt or reply`);
  transaction(db, () => {
    db.prepare("DELETE FROM llm_tag WHERE target = ? AND target_id = ? AND family = ? AND rule = 'hand'").run(target.target, target.targetId, family);
    db.prepare("INSERT INTO llm_tag (target, target_id, family, value, rule, guess, note, at) VALUES (?, ?, ?, ?, 'hand', 0, ?, ?)").run(target.target, target.targetId, family, value.trim(), note, now);
    choose(db, { ...target, family });
  });
}

/** Takes the captain's tag in `family` off the event's session or turn, the rules' chosen again; false when he had none. */
export function untagByHand(db: Db, eventId: number, family: string): boolean {
  const target = targetOf(db, eventId);
  if (!target) throw new Error(`event ${eventId} is not an LLM session, prompt or reply`);
  return transaction(db, () => {
    const gone = db.prepare("DELETE FROM llm_tag WHERE target = ? AND target_id = ? AND family = ? AND rule = 'hand'").run(target.target, target.targetId, family).changes > 0;
    choose(db, { ...target, family });
    return gone;
  });
}

/** How many sessions or turns have each chosen value of each family, and how many of those are guesses. */
export function tagCounts(db: Db): Array<{ target: string; family: string; value: string; count: number; guesses: number; hand: number }> {
  return db
    .prepare(
      `SELECT target, family, value, count(*) AS count, sum(guess) AS guesses, sum(rule = 'hand') AS hand FROM llm_tag WHERE chosen = 1
       GROUP BY target, family, value ORDER BY target, family, count DESC, value`,
    )
    .all() as Array<{ target: string; family: string; value: string; count: number; guesses: number; hand: number }>;
}
