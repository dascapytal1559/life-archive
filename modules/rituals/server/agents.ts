// Rituals' tools at the archive's MCP door (module.ts's `agents`; the core's server/mcp/): what bin/ritualctl offers an
// assistant, so one that logs the captain's rituals (G, his Grok Bot agent) needs no path to this checkout. Each goes
// through bin/ritualctl itself, run as a process with the store's root named (RITUAL_ROOT: the archive's folder's
// modules/rituals/, where the module reads it) on the server's own Node, so rituals' rules, idempotency, revisions,
// backups and audit stay rituals' own, and the store is still written by ritualctl alone, never by the server.
//
//   rituals_status  facts      a day's standing (today's unless asked), as `ritual_status` derives it: each habit's
//                              status and how it is known, the required checks by id, and whether the whole ritual is
//                              done; never a word of the captain's (no notes, no check's text)
//   rituals_help    facts      ritualctl's own index of its requests, and rituals' logging rules (AGENTS.md)
//   rituals_read    content    any read request ritualctl answers, whole: a checklist with its items' words, the
//                              workouts with their details, a record's history with its source text
//   rituals_write   write      any write request ritualctl answers (ritual_put, workout_add, attachment_check, ...),
//                              with its acknowledgement's facts (the record's keys, revision, replayed), never the record

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Clock, dayKey, defineTool, Effect, Schema, spawnScoped, ToolRefused, type ModuleAgents, type ModuleContext } from "../../../sdk/server.ts";
import { WRITES } from "../src/store.ts";
import { ritualsRoot } from "./view.ts";

/** ritualctl, beside this module's code. */
const RITUALCTL = fileURLToPath(new URL("../bin/ritualctl", import.meta.url));

/** Rituals' logging rules, beside this module's code. */
const RULES = fileURLToPath(new URL("../AGENTS.md", import.meta.url));

/** The read requests rituals_read hands on (ritualctl --help's reads, less backup and export, which write files). */
export const READS = [
  "status", "rituals", "ritual_status", "ritual_checklist", "ritual_attachments", "attachment_days", "applicability_exceptions",
  "workouts", "habit_events", "weekly_targets", "weekly_target_entries", "weekly_progress", "reminders", "history", "source",
] as const;

/**
 * One answer of ritualctl for the store of the archive kept at `folder`: `request` on its stdin (or `args` alone), its
 * JSON answer; its refusal (`{"ok": false, "error": ...}`), or a store it could not reach, as the agent is told it
 * (its own error alone: never what else it printed, which may hold the owner's words).
 */
export const ritualctl = (folder: string, request: unknown, args: readonly string[] = []) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { child, exited } = yield* spawnScoped(() =>
        spawn(RITUALCTL, [...args], { env: { ...process.env, RITUAL_ROOT: ritualsRoot(folder), RITUAL_NODE: process.execPath }, stdio: ["pipe", "pipe", "ignore"] }),
      );
      let stdout = "";
      let failedToStart = "";
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.on("error", (error) => (failedToStart = error.message));
      child.stdin!.end(request === undefined ? "" : JSON.stringify(request));
      const { code } = yield* exited;
      let answer: unknown;
      try {
        answer = JSON.parse(stdout);
      } catch {
        return yield* new ToolRefused({ message: `ritualctl gave no answer (exit ${code})${failedToStart ? `: ${failedToStart}` : ""}` });
      }
      const refusal = answer as { ok?: unknown; error?: unknown };
      if (code !== 0 || refusal?.ok === false) return yield* new ToolRefused({ message: typeof refusal?.error === "string" ? `ritualctl refused: ${refusal.error}` : `ritualctl refused (exit ${code})` });
      return answer;
    }),
  );

const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({ description: "A ritual day, YYYY-MM-DD (an evening's date; 00:00 to 05:59 belongs to the day before)." });

const Request = Schema.Record(Schema.String, Schema.Unknown).annotate({
  description: 'One ritualctl request, exactly as you would send it on its stdin: {"op": ..., ...}. rituals_help lists every one, with templates.',
});

/** The parts of a request that say what it is about, facts alone (never its source text, patch or record), for the call log and the trail. */
const SCOPE_KEYS = ["op", "date", "from", "to", "ritual", "entity", "id", "attachment_id", "request_id"] as const;

const requestScope = (request: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(SCOPE_KEYS.flatMap((key) => (typeof request[key] === "string" ? [[key, request[key] as string]] : [])));

/** The parts of a written record that say which one it is, facts alone. */
const RECORD_KEYS = ["id", "date", "ritual", "habit", "attachment_id", "target_id", "week"] as const;

/**
 * A write's acknowledgement, its facts alone: which record it wrote (by its keys), the revision, when, whether it
 * replayed, its backup and its events' ids. ritualctl's whole acknowledgement holds the merged record, notes and all,
 * which is content: a key granted only `write:rituals` would read it without the trail, so rituals_read gives it.
 */
export function writeAck(answer: unknown) {
  const ack = (answer ?? {}) as Record<string, unknown>;
  const facts: Record<string, unknown> = {};
  for (const key of ["revision", "recorded_at", "replayed", "backup", "import_id"]) if (key in ack) facts[key] = ack[key];
  if (ack.record && typeof ack.record === "object") {
    const record = ack.record as Record<string, unknown>;
    facts.record = Object.fromEntries(RECORD_KEYS.flatMap((key) => (typeof record[key] === "string" || typeof record[key] === "number" ? [[key, record[key]]] : [])));
  }
  if (Array.isArray(ack.events)) facts.events = (ack.events as Array<Record<string, unknown>>).map((e) => ({ id: e.id, revision: e.revision }));
  return facts;
}

/** A day of `ritual_status`, its facts alone: no check's words, nothing the captain wrote. */
function dayFacts(day: Record<string, unknown>) {
  const habits = Object.fromEntries(
    Object.entries((day.habits ?? {}) as Record<string, Record<string, unknown>>).map(([habit, h]) => [habit, { status: h.status, basis: h.basis, applicable: h.applicable, ...(habit === "planks" && typeof h.raw === "number" ? { seconds: h.raw } : {}) }]),
  );
  const attachments = ((day.attachments ?? []) as Array<Record<string, unknown>>).map((a) => ({ id: a.id, ritual: a.ritual, role: a.role, status: a.status, done_at: a.done_at, basis: a.basis, requires_response: a.requires_response }));
  return { date: day.date, period: day.period, closes_at: day.closes_at, has_ritual: day.has_ritual, has_activity: day.has_activity, habits, required_and_reminder_items: attachments, full_completion: day.full_completion };
}

/** Rituals' tools, for the archive kept at `folder`. */
export function ritualsAgents({ folder }: ModuleContext): ModuleAgents {
  return {
    about:
      "The owner's daily rituals (an evening's habits: magnesium, protein, stretching, planks, journalling, wind_down from 2026-11-09 (due by midnight), and the temporary items attached to a ritual) and weekly targets, kept in rituals' own store and written only through ritualctl. A ritual day closes at 06:00 the next morning. rituals_help has the logging rules: read them before any write.",
    tools: [
      defineTool({
        name: "rituals_status",
        title: "A day's rituals",
        description:
          "How a ritual day stands, today's unless you name one: each habit's status (done, not_done, unreported, not_applicable) and how it is known, a plank's seconds, each required check and reminder by id with its mark, and whether the whole ritual is complete (full_completion.complete). Facts only: the items' words and the owner's notes need rituals_read.",
        access: "facts",
        input: { date: Schema.optionalKey(Day) },
        run: ({ date }) =>
          Effect.gen(function* () {
            const today = dayKey(yield* Clock.currentTimeMillis);
            const answer = (yield* ritualctl(folder, { op: "ritual_status", from: date ?? today, to: date ?? today })) as Record<string, unknown>;
            const records = (answer.records ?? []) as Array<Record<string, unknown>>;
            const day = date === undefined ? (answer.active_period as Record<string, unknown>) : records.find((r) => r.date === date);
            if (!day) return yield* new ToolRefused({ message: `rituals has no record of ${date}: the store covers ${JSON.stringify(answer.coverage)}` });
            return { as_of: answer.as_of, timezone: answer.timezone, active_date: answer.active_date, active_closes_at: answer.active_closes_at, day: dayFacts(day) };
          }),
      }),
      defineTool({
        name: "rituals_help",
        title: "How to log rituals",
        description: "Every request ritualctl answers, with templates (reads, writes, weekly targets), and rituals' logging rules: dates and the 06:00 close, habit times, request ids and source text, corrections. Read it before any rituals_write.",
        access: "facts",
        input: {},
        run: () =>
          Effect.gen(function* () {
            const requests = yield* ritualctl(folder, undefined, ["--help"]);
            const rules = yield* Effect.promise(() => readFile(RULES, "utf8"));
            return { rules, requests, note: "Send each request through rituals_read (reads) or rituals_write (writes) as its `request`, exactly as ritualctl takes it on stdin." };
          }),
      }),
      defineTool({
        name: "rituals_read",
        title: "Read rituals' store",
        description: `Any read request ritualctl answers, answered whole, the owner's words included: ${READS.join(", ")}. Use ritual_checklist before a ritual invitation or a completion reply.`,
        access: "content",
        input: { request: Request },
        scope: ({ request }) => requestScope(request),
        run: ({ request }) =>
          (READS as readonly unknown[]).includes(request.op)
            ? ritualctl(folder, request)
            : Effect.fail(new ToolRefused({ message: `rituals_read answers ${READS.join(", ")}; ${JSON.stringify(request.op)} is ${WRITES.has(String(request.op)) ? "a write: use rituals_write" : "not one of them"}` })),
      }),
      defineTool({
        name: "rituals_write",
        title: "Log to rituals",
        description: `Any write request ritualctl answers: ${[...WRITES].join(", ")}. Its acknowledgement names the record written (its id or date), its revision, when and whether it replayed, never the record's words: read it back with rituals_read. Every write needs a stable request_id and source_text with the owner's verbatim words, the message's id and "Received at <instant>"; follow rituals_help's rules exactly. An identical retry replays safely.`,
        access: "write",
        input: { request: Request },
        scope: ({ request }) => requestScope(request),
        run: ({ request }) =>
          WRITES.has(String(request.op))
            ? Effect.map(ritualctl(folder, request), writeAck)
            : Effect.fail(new ToolRefused({ message: `rituals_write sends ${[...WRITES].join(", ")}; ${JSON.stringify(request.op)} is ${(READS as readonly unknown[]).includes(request.op) ? "a read: use rituals_read" : "not one of them"}` })),
      }),
    ],
  };
}
