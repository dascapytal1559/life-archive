// Temporary ritual items: separate observations and completion, never core habit percentages.
import { Result, Schema } from "effect";
import type { StatusRow } from "./applicability.ts";
import { pack, sha } from "./encoding.ts";
import type { RequiresReview } from "./errors.ts";
import { type EventBasis, microsOf } from "./habitEvents.ts";
import { addDays, isoformatLocal, weekday } from "./instants.ts";

export const AttachmentRole = Schema.Literals(["required_check", "reminder_only"]);
export type AttachmentRole = typeof AttachmentRole.Type;
export const AttachmentWeekday = Schema.NullOr(Schema.Literals([1, 2, 3, 4, 5, 6, 7]));

export interface Attachment {
  readonly id: string;
  readonly ritual: string;
  readonly text: string;
  readonly start_date: string;
  readonly end_date: string | null;
  readonly role: AttachmentRole;
  /** ISO weekday: Monday 1 through Sunday 7. Missing/null retains the legacy daily scope. */
  readonly weekday?: typeof AttachmentWeekday.Type;
}

export interface AttachmentCheck {
  readonly id: string;
  readonly attachment_id: string;
  readonly date: string;
  readonly done: boolean | null;
  /** When it was done (schema version 11), by the same rules as a habit event; a check ticked before then has none. */
  readonly done_at?: string | null;
  readonly basis?: EventBasis | null;
  readonly revision?: number;
}

export type AttachmentStatus = "reminder_only" | "done" | "not_done" | "unreported";

export const ATTACHMENT_SQL = `CREATE TABLE ritual_attachments(
 id TEXT PRIMARY KEY,
 ritual TEXT NOT NULL,
 text TEXT NOT NULL,
 start_date TEXT NOT NULL,
 end_date TEXT,
 role TEXT NOT NULL CHECK(role IN ('required_check','reminder_only')),
 CHECK(end_date IS NULL OR start_date<=end_date)
);
CREATE INDEX idx_ritual_attachments_dates ON ritual_attachments(ritual,start_date,end_date);
CREATE TABLE ritual_attachment_checks(
 id TEXT PRIMARY KEY,
 attachment_id TEXT NOT NULL REFERENCES ritual_attachments(id),
 date TEXT NOT NULL,
 done INTEGER CHECK(done IN (0,1)),
 UNIQUE(attachment_id,date)
);`;

export const ATTACHMENT_WEEKDAY_SQL =
  "ALTER TABLE ritual_attachments ADD COLUMN weekday INTEGER CHECK(weekday BETWEEN 1 AND 7);";

// A check's time: nullable, so every tick made before version 11 stays exactly as it was.
export const ATTACHMENT_CHECK_TIME_SQL = `ALTER TABLE ritual_attachment_checks ADD COLUMN done_at TEXT;
ALTER TABLE ritual_attachment_checks ADD COLUMN basis TEXT CHECK(basis IN ('user_stated','message_received','unknown'));`;

export const checkId = (attachmentId: string, day: string): string =>
  "ac_" + sha(pack([attachmentId, day])).slice(0, 24);

export const attachmentApplies = (item: Attachment, ritual: string, day: string): boolean =>
  item.ritual === ritual &&
  item.start_date <= day &&
  (item.end_date === null || day <= item.end_date) &&
  (item.weekday === undefined || item.weekday === null || weekday(day) + 1 === item.weekday);

const statusOf = (item: Attachment, check: AttachmentCheck | undefined): AttachmentStatus =>
  item.role === "reminder_only"
    ? "reminder_only"
    : check?.done === true
      ? "done"
      : check?.done === false
        ? "not_done"
        : "unreported";

export const attachmentViews = (
  items: ReadonlyArray<Attachment>,
  checks: ReadonlyArray<AttachmentCheck>,
  ritual: string,
  day: string,
) =>
  items
    .filter((item) => attachmentApplies(item, ritual, day))
    .map((item) => {
      const check = checks.find((row) => row.attachment_id === item.id && row.date === day);
      const done = check?.done === true;
      return {
        ...item,
        weekday: item.weekday ?? null,
        date: day,
        check_id: item.role === "required_check" ? checkId(item.id, day) : null,
        done: check?.done ?? null,
        // A tick's time, as for a habit event: a tick with none (or from before version 11) is `unknown`.
        done_at: done ? (check?.done_at ?? null) : null,
        basis: done ? (check?.basis ?? "unknown") : null,
        status: statusOf(item, check),
        revision: check?.revision ?? 0,
        requires_response: item.role === "required_check",
      };
    });

/** Every applicable item of every ritual on each logical date from `from` to `to`, date by date: the checklist's rows. */
export const attachmentDays = (
  items: ReadonlyArray<Attachment>,
  checks: ReadonlyArray<AttachmentCheck>,
  from: string,
  to: string,
) => {
  const rituals = [...new Set(items.map((item) => item.ritual))];
  const rows: Array<ReturnType<typeof attachmentViews>[number]> = [];
  for (let day = from; day <= to; day = addDays(day, 1))
    for (const ritual of rituals) rows.push(...attachmentViews(items, checks, ritual, day));
  return rows;
};

/** What a day's mark shows, for a program that only draws it. An old unanswered check stays unreported, never "not done". */
const MARKS: Record<AttachmentStatus, { readonly text: string; readonly label: string }> = {
  done: { text: "✓", label: "Done" },
  not_done: { text: "×", label: "Not done" },
  unreported: { text: "·", label: "Not reported" },
  reminder_only: { text: "", label: "Reminder only, no tick" },
};

export interface AttachmentDayView {
  readonly date: string;
  readonly display_date: string;
  readonly full_date: string;
  readonly status: AttachmentStatus;
  readonly text: string;
  readonly label: string;
  readonly done_at: string | null;
  readonly basis: EventBasis | null;
}

export interface AttachmentView extends Omit<Attachment, "weekday"> {
  readonly weekday: typeof AttachmentWeekday.Type;
  readonly active: boolean;
  readonly days: ReadonlyArray<AttachmentDayView>;
}

export interface AttachmentsView {
  readonly active_date: string;
  readonly items: ReadonlyArray<AttachmentView>;
}

/**
 * The items as other local programs read them (bin/ritual-view): each one that has applied, with its mark on every day
 * it applied up to `activeDate`, newest first. No check ids, revisions, source text or audit. Each day carries its own
 * date labels: a morning's tick comes before any report, when the daily rows have no row for that date yet.
 */
export const attachmentsView = (
  items: ReadonlyArray<Attachment>,
  checks: ReadonlyArray<AttachmentCheck>,
  activeDate: string,
  labels: (day: string) => { readonly display: string; readonly full: string },
): Result.Result<AttachmentsView, RequiresReview> =>
  Result.gen(function* () {
    const started = items.filter((item) => item.start_date <= activeDate);
    const first = started.map((item) => item.start_date).toSorted()[0] ?? activeDate;
    const rows = attachmentDays(started, checks, first, activeDate).toReversed();
    const shown = [];
    for (const item of started) {
      const days = [];
      for (const row of rows.filter((candidate) => candidate.id === item.id)) {
        const at = row.done_at === null ? null : isoformatLocal(yield* microsOf(row.done_at));
        const { display, full } = labels(row.date);
        days.push({
          date: row.date,
          display_date: display,
          full_date: full,
          status: row.status,
          ...MARKS[row.status],
          done_at: at,
          basis: row.basis,
        });
      }
      if (days.length === 0) continue;
      const { id, ritual, text, role, start_date, end_date } = item;
      const active = end_date === null || activeDate <= end_date;
      shown.push({ id, ritual, text, role, start_date, end_date, weekday: item.weekday ?? null, active, days });
    }
    return { active_date: activeDate, items: shown };
  });

export const fullCompletion = (core: StatusRow | null, attached: ReturnType<typeof attachmentViews>) => {
  const remainingCore =
    core === null
      ? []
      : Object.entries(core.habits)
          .filter(([, cell]) => cell.applicable && cell.status !== "done")
          .map(([habit]) => habit);
  const required = attached.filter((item) => item.requires_response);
  const remainingAttached = required.filter((item) => item.done !== true).map((item) => item.id);
  return {
    core_complete: remainingCore.length === 0,
    required_checks_complete: remainingAttached.length === 0,
    complete: remainingCore.length === 0 && remainingAttached.length === 0,
    remaining_core: remainingCore,
    remaining_attached: remainingAttached,
  };
};
