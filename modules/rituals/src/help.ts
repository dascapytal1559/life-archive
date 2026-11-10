// `bin/ritualctl --help`: every request by name and the weekly-target templates, for an agent to follow.
// HANDOFF.md stays the full contract; this is the index into it, printed as JSON like every other answer.
export const USAGE =
  "Usage: ritualctl [--help | --init | --migrate | --enqueue | --replay | --queue-status | --queue-on-failure]";

const PROVENANCE =
  "Every write needs a stable request_id (the original message ID plus a suffix) and source_text with the verbatim words, source ID and 'Received at <offset instant>'. An identical retry replays; the same request_id with different content is refused.";

export const HELP = {
  usage: USAGE,
  how: "Send one JSON object on stdin and read one JSON acknowledgement on stdout. HANDOFF.md has every field and rule; read AGENTS.md first.",
  provenance: PROVENANCE,
  reads: {
    status: '{"op":"status"}',
    rituals: '{"op":"rituals","from":"YYYY-MM-DD","to":"YYYY-MM-DD"}',
    ritual_status: '{"op":"ritual_status","from":"YYYY-MM-DD","to":"YYYY-MM-DD"} (optional as_of)',
    ritual_checklist: '{"op":"ritual_checklist","ritual":"evening","date":"YYYY-MM-DD"}',
    ritual_attachments: '{"op":"ritual_attachments","ritual":"evening"}',
    attachment_days:
      '{"op":"attachment_days","from":"YYYY-MM-DD","to":"YYYY-MM-DD"} (optional ritual): each temporary item\'s mark and time on every date it applied',
    applicability_exceptions: '{"op":"applicability_exceptions"}',
    workouts: '{"op":"workouts","from":"YYYY-MM-DD","to":"YYYY-MM-DD"} (optional type, group_by week|month)',
    habit_events: '{"op":"habit_events","from":"YYYY-MM-DD","to":"YYYY-MM-DD"} (optional habit)',
    weekly_targets:
      '{"op":"weekly_targets"}: every target with its revision, its dated minimums and the minimum in force this week',
    weekly_target_entries:
      '{"op":"weekly_target_entries","from":"YYYY-MM-DD","to":"YYYY-MM-DD"} (optional target_id): entries with revisions',
    weekly_progress:
      '{"op":"weekly_progress"} (optional weeks, default 8; as_of): each week\'s total, its own minimum, met and entries, newest week first',
    reminders: '{"op":"reminders","mode":"due|review|all"} (optional as_of)',
    history: '{"op":"history","entity":"ENTITY","id":"ID"}: the audit of one record',
    source: '{"op":"source","id":"ID"}',
    backup: '{"op":"backup"}',
    export: '{"op":"export","save":true}',
  },
  writes: {
    ritual_put:
      "A daily ritual report: date, patch, optional events and journal_entry_at (HANDOFF.md Writes). Ticking magnesium, protein, stretching, journalling or wind_down (asked from 2026-11-09; green on the dashboard when done before midnight) true needs that habit's entry in events: {habit, done_at, basis} with basis user_stated or message_received, or done_at null with basis unknown when no time was given (planks need none). journal_entry_at also records the journalling event at that instant once journalling is done.",
    workout_add: "record {date, type, details, optional title}.",
    reminder_add: "record {text, due_at or null}.",
    reminder_mark: "id, status, expected_revision, reason.",
    exception_add: "record {habit, start_date, end_date, reason}.",
    attachment_add: "record {ritual, text, start_date, end_date, role, optional weekday}.",
    attachment_check:
      "attachment_id, date, done. Ticking done true needs done_at and basis, as a habit's event does: basis user_stated or message_received, or done_at null with basis unknown when no time was given.",
    habit_event_remove: "id, expected_revision, reason.",
    target_add: "Add a weekly target (below).",
    target_log: "Log an entry against a weekly target (below).",
    target_entry_remove: "Undo an entry: id, expected_revision, reason (below).",
    correct:
      "entity, id, patch, expected_revision (the record's current revision), reason: edit a recorded value, including targets and their entries.",
  },
  weekly_targets: {
    about:
      "A weekly target has a name, a unit, a weekly minimum, a start_date, an active flag and a display position. Its entries each count for a logical ritual date (00:00-05:59 belongs to the day before, like daily rituals); a week runs Monday to Sunday, and each week is judged against the minimum in force for it. Progress is derived, never written.",
    units: {
      count:
        'Whole times; amount defaults to 1. Optional noun for display: noun "laps" shows "1 / 2 laps". Minimum is a whole number.',
      km: 'A distance in km: 5, 4.2 or "4.2km" (at most three decimals).',
      minutes: 'A duration, stored in whole minutes: 90, "45m", "1h30m", "1h 30m" or "1.5h". Shown as "3h 20m / 5h".',
    },
    add: '{"op":"target_add","record":{"name":"Example target","unit":"minutes","minimum":"5h","start_date":"YYYY-MM-DD"},"request_id":"MSG_ID:target","source_text":"..."} (optional id, noun for count, position; active defaults to true)',
    log: '{"op":"target_log","record":{"target_id":"wt_...","date":"YYYY-MM-DD","amount":"45m","note":"optional words","logged_by":"who made the report"},"request_id":"MSG_ID:target-log","source_text":"..."}',
    list: '{"op":"weekly_target_entries","from":"YYYY-MM-DD","to":"YYYY-MM-DD","target_id":"wt_..."} gives each entry\'s id and revision.',
    undo: '{"op":"target_entry_remove","id":"wte_...","expected_revision":123,"reason":"Logged twice","request_id":"MSG_ID:target-undo","source_text":"..."}',
    edit_entry:
      '{"op":"correct","entity":"weekly_target_entries","id":"wte_...","patch":{"amount":"1h"},"expected_revision":123,"reason":"...","request_id":"...","source_text":"..."} (amount, note and date can change)',
    edit_target:
      '{"op":"correct","entity":"weekly_targets","id":"wt_...","patch":{"minimum":3},"effective_week":"YYYY-MM-DD","expected_revision":45,"reason":"...","request_id":"...","source_text":"..."} (name, noun, minimum, start_date, position, active; never unit; effective_week is optional and only with minimum)',
    retire: 'correct with patch {"active":false}; {"active":true} brings it back.',
    rules:
      "The date is the logical date the entry counts for, decided from the report like ritual_put's date and disclosed in source_text; it cannot be before the target's first week or after the current logical date. A changed minimum is in force from the current week, or from effective_week (any date, read as its Monday: next Monday's date for 'starting next week'); earlier weeks keep the minimum they had. Retired targets take no new entries and show only in weeks that have their entries.",
  },
};
