# Operating cookbook

LOCAL.md, wherever this cookbook names it, is the installation's own private notes, beside the store at its root, never in a checkout: `~/life-archive-data/modules/rituals/LOCAL.md` for the captain's (it was `~/Projects/rituals/LOCAL.md` until 7 November 2026, when the rituals repository was retired).

Rituals is a module of the life archive (`modules/rituals/` of its checkout; README.md beside this file says what the module is, and the life archive's `docs/modules.md` how a module is laid out). This cookbook is rituals' own, brought in with its code: every request below is sent to `bin/ritualctl` here as it always was. Run logging, reads and backup commands from this folder; the store they write is in the life archive's data folder (below), never beside the code. Commands here need an authorized Mac executor; they do not provide cloud access while the Mac is unavailable. No previous chat or agent workspace is required. The logging and date rules are in AGENTS.md beside this file.

Every `bin/` command runs TypeScript directly on Node.js 24 from the life archive's `node_modules` (its root's; `npm install` there, once). The wrappers choose the Node binary in this order (`bin/node.sh`): `RITUAL_NODE` in the environment (an explicit override, used as given), then the first line of the ignored per-installation file `config/node` beside the code (the absolute path of a Node.js 24 binary), then `node` on PATH only when it is version 24 or newer. Otherwise they print `{"ok": false, "error": "Rituals needs Node.js 24 or later…"}` and exit 1 without running anything, and a wrong version named explicitly is refused the same way. Where the store is (`data/ritual.sqlite3`, its backups, exports and snapshots, and `queue/`), they are told by `RITUAL_ROOT` in the environment, else the first line of the ignored per-installation file `config/root` (an absolute path), else the code's own folder (`src/root.ts`). In a life archive that is its data folder's `modules/rituals/`, where rituals' tabs read the store. Write both once per installation, so logging never depends on the caller's PATH or working folder:

```sh
mkdir -p config
printf '%s\n' /absolute/path/to/node > config/node       # a Node.js 24 binary, e.g. what `command -v node` prints where `node --version` is v24
printf '%s\n' ~/life-archive-data/modules/rituals > config/root   # the life archive's data folder's modules/rituals/
bin/ritualctl --queue-status                              # proves the resolution works
```

## First run (new installation only)

```sh
bin/ritualctl --init          # creates an empty data/ritual.sqlite3 under the store's root; refuses if one exists
bin/ritualctl <<'JSON'
{"op":"status"}
JSON
```

Never use `--init` to "fix" an installation whose database is missing: that is a recovery situation (see Backup, export and restore).

## Start a turn

```sh
cd /path/to/life-archive/modules/rituals
bin/ritual-agent status
bin/ritualctl --queue-status
bin/ritualctl <<'JSON'
{"op":"status"}
JSON
```

Then the current records relevant to the request. Normal logging requires no edit claim or commit. For a migration of the store (`--migrate`) use `bin/ritual-agent claim YOUR_UNIQUE_TASK_ID 'specific scope'` first; release that same ID after. A claim prevents cooperating agents taking the same edit role; it does not block ordinary CLI writes or uncooperative editors. Coordinate and hold reports for migrations. Never forcibly remove an active claim. Code changes land through the life archive's own flow, not here (see Code changes).

## Reads

Send one JSON object on stdin to bin/ritualctl:

```json
{"op":"rituals","from":"2026-10-01","to":"2026-10-03"}
{"op":"history","entity":"rituals","id":"2026-10-03"}
{"op":"ritual_status","from":"2026-09-01","to":"2026-10-03"}
{"op":"ritual_checklist","ritual":"evening","date":"2026-10-03"}
{"op":"ritual_attachments","ritual":"evening"}
{"op":"attachment_days","from":"2026-10-01","to":"2026-10-07"}
{"op":"attachment_days","from":"2026-10-01","to":"2026-10-07","ritual":"morning"}
{"op":"applicability_exceptions"}
{"op":"workouts","from":"2026-09-01","to":"2026-09-30","group_by":"week"}
{"op":"workouts","from":"2026-09-01","to":"2026-09-30","group_by":"month"}
{"op":"reminders","mode":"review"}
{"op":"reminders","mode":"due","as_of":"2026-10-05T08:00:00+11:00"}
{"op":"habit_events","from":"2026-10-01","to":"2026-10-31"}
{"op":"habit_events","from":"2026-10-01","to":"2026-10-31","habit":"protein"}
{"op":"history","entity":"habit_events","id":"he_0123456789abcdef01234567"}
{"op":"weekly_targets"}
{"op":"weekly_target_entries","from":"2026-10-01","to":"2026-10-31"}
{"op":"weekly_target_entries","from":"2026-10-01","to":"2026-10-31","target_id":"wt_0123456789abcdef01234567"}
{"op":"weekly_progress"}
{"op":"weekly_progress","weeks":12,"as_of":"2026-10-19T01:00:00+11:00"}
```

`bin/ritualctl --help` prints every request by name with the weekly-target templates (JSON, like every answer).

Use actual requested dates/as_of; omit as_of for current-time behavior. Rituals/workouts/reminders/habit_events records return entity revision for corrections. `habit_events` lists each logical date's events with known times first (by time), then unknown ones; `habit` is optional (magnesium, protein, stretching, planks, journalling or wind_down). `weekly_targets` lists every target with its revision (active first, then by position); `weekly_target_entries` lists entries by logical date with revisions; `weekly_progress` is the progress described under "Weekly targets" below. `attachment_days` lists every temporary item of every ritual (or of one `ritual`) on each date from `from` to `to` that it applied, by date then ritual: the same rows as a checklist's `attachments`, with `status`, `done_at`, `basis`, `check_id` and `revision`. Review includes stashed/outstanding reminders; due returns timed pending items whose time arrived. Neither sends a message or changes state. Status derives the 06:00 next-day closure in the store's time zone (README.md), including DST; raw null remains unchanged. The derived range is bounded to observed coverage. source/id retrieves original evidence privately.

## Read-only view for other local programs

`bin/ritual-view` takes no arguments (any argument is refused) and prints one JSON envelope for another program on this machine to show the rituals without touching the store:

```json
{"format":7,"daily":{...},"events":[...],"weekly_targets":{...},"attachments":{...}}
```

- `format`: the envelope version, currently 7. Any change to the envelope's shape, including a change to the `daily` or `weekly_targets` projections inside it, bumps `format` in `src/view.ts` (`VIEW_FORMAT`) in the same commit, so a consumer can refuse a shape it does not know.
- `daily`: exactly the body of the dashboard's `/api/dashboard` (`readDashboardData`): `generated_at`, `updated_display`, `timezone`, `count`, `rates` and `rows`, with the 06:00 cutoff, applicability and check-in basis already derived.
- `events`: every habit event, as `{"id","date","habit","done_at","basis"}`: `date` is the logical ritual date, `habit` one of `magnesium`, `protein`, `stretching`, `planks`, `journalling`, `wind_down` (the keys of a daily row's `cells`), `done_at` the instant in the store's time zone with its offset (`2026-10-16T21:00:00+11:00`) or null when unknown, and `basis` `user_stated`, `message_received` or `unknown` (see "Habit times" below). Sorted by date, then known times in order, then unknown ones. No source text, audit or revisions. A store not yet migrated to version 7 gives `[]`, because no event exists before the migration; one not yet at version 8 gives `weekly_targets` with no weeks.
- `weekly_targets`: each weekly target's progress for the current week and the seven before it, newest week first (the same as `{"op":"weekly_progress"}`, stamped like the other parts):
  - top level: `generated_at`, `updated_display`, `timezone`, `active_date` (the current logical ritual date, 06:00 cutoff applied), `current_week` (its Monday) and `weeks`.
  - each week: `week_start` (Monday) and `week_end` (Sunday) of logical dates, `display` ("Oct 26 – Nov 1") and `full` ("Week of Monday 26 October – Sunday 1 November 2026"), `current` (true only for the week holding `active_date`, which is still open, so not met there means not yet), `met` (how many of its targets are met) and `targets`. A week with no target to show is left out, so a store without targets gives `weeks: []`.
  - each target, in display order (`position`, then name): `id`, `name`, `unit` (`count`, `km` or `minutes`), `noun` (a count's display noun or null), `minimum` (the one in force that week), `active`, `position`, `total`, `remaining` (what is still needed, 0 once met), `met` (total ≥ minimum), `fraction` (total / minimum, at most 1, for a bar), and display text: `total_text`, `minimum_text`, `remaining_text` and `progress_text` ("1 / 2 laps", "3.5 / 5 km", "3h 20m / 5h"). Amounts are in the unit: a count's times, km, or whole minutes. A target shows from the week of its `start_date`; a retired one (`active` false) only in weeks that have its entries.
  - each entry, by date: `id`, `date` (the logical date it counts for), `display_date` ("Wed 28"), `amount`, `amount_text` ("1h 30m"), `note` (or null) and `logged_by` (who made the report). No source text, audit or revisions.
- `attachments`: every ritual's temporary items with their marks day by day, computed at the same instant as the other parts:
  - top level: `active_date` (the current logical ritual date, 06:00 cutoff applied) and `items`, by ritual, then start date. An item shows from the first day it applies, so one that has not started yet is left out; a finished one stays, with `active` false, because its days are history.
  - each item: `id`, `ritual` (`morning`, `noon`, `evening` or any other identity), `text`, `role` (`required_check` or `reminder_only`), `start_date`, `end_date` (null when ongoing), `weekday` (ISO 1–7 or null), `active` (its end date has not passed) and `days`.
  - each day, newest first, every logical date the item applied up to `active_date`: `date`, `display_date` and `full_date` (as in a daily row, because `daily.rows` stops at the last day with a report, so a morning's tick can come before its date has a row there), `status` (`done`, `not_done`, `unreported` or `reminder_only`), `text` (the mark: ✓ × · or empty), `label` (the same in words), and for a tick `done_at` (in the store's time zone with its offset, or null) and `basis` (`user_stated`, `message_received` or `unknown`); both are null on any other day. An old unanswered check stays `unreported`, never `not_done`: a closed day's silence is not an answer. No check ids, revisions, source text or audit. A store not yet migrated to version 4 gives no items; one not yet at version 11 gives its ticks `basis` `unknown`.
- `daily` and `weekly_targets` are computed at the same instant, so their `generated_at` match. Each part is its own read transaction, like the API routes.
- Format 2 only added `events`; `daily` and `weekly` are exactly what format 1 carried. A consumer written for format 1 moves to 2 by accepting `format` 2 and the `events` array (or ignoring it).
- Format 3 only added `weekly_targets`; everything else is exactly what format 2 carried. A consumer written for format 2 moves to 3 by accepting `format` 3 and reading `weekly_targets` (or ignoring it). The dashboard's `/api/targets` is the same progress without each entry's `note` and `logged_by`, plus each target's `entries_text` for the page.
- Format 4 only removed `weekly`, the weekly review answers (the store no longer keeps them, see schema version 9); everything else is exactly what format 3 carried. A consumer written for format 3 moves to 4 by accepting `format` 4 without `weekly`.
- Format 5 only added `attachments`; everything else is exactly what format 4 carried. A consumer written for format 4 moves to 5 by accepting `format` 5 and reading `attachments` (or ignoring it). A consumer that refuses a format it does not know must accept 5 before this one lands, because every `bin/` command runs the sources directly: the new format is live the moment they change.
- Format 6 only added `basis` to each cell of `daily`'s rows (`exception`, `source_report`, `explicit_report`, `missing_after_close` or `open_day`, so a `not_done` nobody answered can be told from a reported one); everything else is exactly what format 5 carried. A consumer written for format 5 moves to 6 by accepting `format` 6 and reading `basis` (or ignoring it). A consumer that refuses a format it does not know must accept 6 before this one lands.
- Format 7 only added the sixth habit, `wind_down`: a key of every row's `cells` and of `rates`, a `habit` of `events`, a cell `basis` `not_started` (a day before the habit joined the ritual, `not_applicable`), and on each wind-down cell of a day it was asked a `deadline` (`at`, the midnight after its logical date with its offset; `on_time`, true when its first known time is before `at`, false when at or after it, when it is `not_done`, answered or closed without a tick, or when the day is still open with no answer and `at` has passed (red at once after midnight, though a tick until 06:00 still counts as done), and null when not judged: a tick with no time, or the day still open before `at`; `done_at`, that first known time or null; `time_basis`, how it is known, `unknown` for a tick with no time, null when not done). Everything else is exactly what format 6 carried. A consumer written for format 6 moves to 7 by accepting `format` 7 and the new habit (or ignoring it).

It reads only through the dashboard's `mode=ro` client: it never opens the store read-write, never changes its file mode and never regenerates `data/views/`, so it works on a read-only (0400) copy and leaves the store and snapshots untouched. A missing store is an error (`{"ok":false,"error":...}`, exit 1), never a new empty one. Consumers read through this command and never open `ritual.sqlite3`, copy records or reimplement the date rules themselves.

## Writes: templates, not real reports

Replace every example value with an established user report before production use. Every action needs stable request_id and source_text containing verbatim words, original message ID, receipt instant, occurrence qualification and disclosed date inference. Omitted fields remain intact. An ordinary completion report does not establish check-in; authorized journal defaults use the dedicated option below.

### Temporary items attached to a ritual

Use an explicit ritual identity (`evening` names the existing daily core ritual), logical date and inclusive configured start/end. Other identities can carry their own attached items without using evening core/check-ins. End null means ongoing only when explicitly requested. Role `required_check` needs a dated explicit answer; `reminder_only` belongs in the ritual/review message but has no tick. There is no permanent dashboard column or effect on core completion percentages.

Optional `weekday` restricts the attachment to one ISO weekday (Monday 1 through Sunday 7); omitted/null retains the existing daily date-range behavior. A Sunday weekly check uses `ritual:"evening", weekday:7`, its authorized start date and end null when no end was given. It appears only on applicable logical Sundays, including an after-midnight continuation of that Sunday. Each answer uses that Sunday's logical date; the reviewed week is the Monday-to-Sunday week ending there. Never infer an answer from food/activity mentions. Recurrence changes require a new definition so prior scope/answers are not rewritten.

Fictional setup and answer (replace with the authorized scope and actual report):

```json
{"op":"attachment_add","record":{"id":"fictional-temporary-check","ritual":"evening","text":"Fictional temporary check","start_date":"2027-02-01","end_date":"2027-02-07","role":"required_check"},"request_id":"ORIGINAL_SETUP_ID:attachment","source_text":"Exact authorized setup, source ID and qualified receipt; no answer inferred."}
{"op":"attachment_check","attachment_id":"fictional-temporary-check","date":"2027-02-03","done":true,"done_at":null,"basis":"unknown","request_id":"ORIGINAL_REPORT_ID:attachment:2027-02-03","source_text":"Exact answer, source ID, original receipt and disclosed logical date; actual occurrence unknown."}
```

`done` is true/false/null; absence/null remains unreported even after expiry. It never becomes a check-in or another habit. Same request ID/payload replays safely; changed payload with the same ID fails. A later changed nonnull answer uses `correct`, entity `ritual_attachment_checks`, id `check_id` from the checklist, current attachment-check revision, reason and fresh source/action ID. Only `done`, `done_at` and `basis` can change; preserve identity/date and history. Taking a tick back clears its time, which its audit keeps. Do not infer earlier dates from a latest answer.

A tick carries its time by the rules of "Habit times" below, with no separate event: `done_at` and `basis` sit on the check itself. An `attachment_check` or `correct` that newly ticks `done:true` is refused unless the request says when (`user_stated`, or `message_received` with the same instant as `Received at …`), or says it is unknown with `"done_at":null,"basis":"unknown"`, and the refusal says how. `done_at` must fall inside the logical date and must not be in the future. A `false` or null answer has no time. Restating a tick keeps its time; a different time is a `correct`, as is giving a time to an `unknown` tick or to one made before schema version 11, which read as `unknown`. A morning review stated at 05:30 belongs to the previous logical date under the 06:00 rule, so it is refused on the new date. Requests already acknowledged still replay by their request ID; one prepared and queued before this rule and never sent is refused on replay, which stops, so add the time and send it again with a new request ID.

A ritual other than `evening` has no habits of its own: its checklist is only its attachments, and `full_completion.complete` is true once they are ticked. A daily morning check uses `ritual:"morning"`, end null when it was asked for every day, and is read with `{"op":"ritual_checklist","ritual":"morning","date":"YYYY-MM-DD"}`. Fictional setup and a tick with its stated time:

```json
{"op":"attachment_add","record":{"id":"fictional-morning-check","ritual":"morning","text":"Fictional morning check","start_date":"2027-02-01","end_date":null,"role":"required_check"},"request_id":"ORIGINAL_SETUP_ID:morning","source_text":"Exact authorized setup, source ID and qualified receipt; no answer inferred."}
{"op":"attachment_check","attachment_id":"fictional-morning-check","date":"2027-02-03","done":true,"done_at":"2027-02-03T07:30:00+11:00","basis":"user_stated","request_id":"ORIGINAL_REPORT_ID:morning:2027-02-03","source_text":"Exact words, source ID, Received at OFFSET_BEARING_INSTANT; 7:30 resolved to Melbourne time on ritual date 2027-02-03."}
```

The store records the tick and when; it does not judge whether that was early enough, and it schedules nothing. A morning prompt belongs to the assistant that relays the owner's messages.

Definitions are audited and can use guarded `correct` for text, a future-only end-date adjustment, or an explicit postponement of an unanswered open/future start. A start can only move later when its existing start is not before the current logical ritual date, and it must not exclude any recorded check (including null answers). Preserve the same ID and original setup/correction history; this removes current applicability without creating an answer. Earlier starts and closed historical scope cannot change. Ritual identity/role/weekday cannot rewrite scope; create a new definition for a new phase. End-date corrections cannot remove historical applicability, reactivate an expired scope or exclude recorded answers. Expiry never extends itself. Do not extend/recreate a finished contract without a new explicit request.

Always query `ritual_checklist` before a ritual invitation or completion reply. Its `attachments` contain applicable required checks and reminder-only items, with response requirements, exact state and check revision. Use `full_completion.complete` for the whole ritual; `remaining_core` and `remaining_attached` explain partial completion. `ritual_status` adds the same attachment/full-completion fields to each returned logical day and active period, leaving core `completion`/`by_habit` unchanged. Raw `rituals` records and core dashboard percentages alone do not establish full ritual completion.

Queries use the supplied logical date rather than wall-clock expiry: a late historical answer is accepted inside that contract's range, and an old unanswered check remains readable after the contract ends. Outside the range the attachment is absent. This does not authorize fresh expired nudges; parent owns scheduling and delivery. A query/invitation is not a report.

The existing `--enqueue`, `--replay` and unavailable-Mac contract apply to both attachment writes. Preserve exact prepared payload/ID, original receipt and logical date; replay stops on conflicts. Queue setup before its dependent answer. Don't claim a database save while merely queued, create an empty replacement store, or infer delivery from a query.

Partial habit report (ticking a habit needs its `events` entry too, see "Habit times"; planks are reported as `plank_seconds` and need none):
```json
{"op":"ritual_put","date":"2026-10-03","patch":{"journalling":true},"events":[{"habit":"journalling","done_at":null,"basis":"unknown"}],"request_id":"ORIGINAL_MESSAGE_ID:ritual","source_text":"Verbatim words. Source ID ORIGINAL_MESSAGE_ID. Received at OFFSET_BEARING_INSTANT. Assigned ritual date from stated/contextual intent; actual completion time unknown."}
```

Explicit check-in with only receipt instant available:
```json
{"op":"ritual_put","date":"2026-10-03","patch":{"checkins":["2026-10-03T12:00:00Z"]},"request_id":"ORIGINAL_MESSAGE_ID:checkin","source_text":"Checking in [replace with exact words]. Source ID ORIGINAL_MESSAGE_ID. Received at 2026-10-03T12:00:00Z. This is message receipt time; exact physical check-in instant unknown. Ritual date 2026-10-03 [replace with established interpretation]."}
```

Patch fields: checkins array of offset-bearing instants; magnesium/protein/stretching/journalling/wind_down true/false/null (wind_down only on a logical date from 2026-11-09); plank_seconds nonnegative integer/null; notes text/null. checkins merges without discarding existing timestamps. A changed existing nonnull habit requires correction, not another put.

### Habit times (events)

The daily tick stays what the dashboard shows. Underneath it, each reported doing of a habit can be a habit event: its logical date, habit (`magnesium`, `protein`, `stretching`, `planks`, `journalling`, `wind_down`), `done_at` and `basis`. Add them as top-level `events` on the same `ritual_put` that reports the habit. This is required, so a time is never left out by accident: a `ritual_put` whose patch ticks `magnesium`, `protein`, `stretching`, `journalling` or `wind_down` true is refused unless the request carries that habit's event, and the refusal says how. Give the time, or say it is unknown with an explicit `{"habit":"…","done_at":null,"basis":"unknown"}`. Planks are exempt (their report is `plank_seconds`), as is restating a habit the day already has ticked, a `false`, and a `correct`. Requests already acknowledged still replay by their request ID as they were saved; one prepared and queued before this rule and never sent is refused on replay, which stops, so add the event and send it again with a new request ID.

- `user_stated`: the user said or clearly implied when ("took magnesium at 9"). Resolve it to an offset-bearing instant in the store's time zone, on the logical date, and disclose that resolution in source_text.
- `message_received`: the words mean "just now" ("just took protein"), so the time is the message receipt. `done_at` must be the same instant source_text gives as `Received at …`; the store refuses anything else.
- `unknown`: no time was given; `done_at` is null (or omitted). Never fill it with a scheduled ping's, an invitation's, a processing or a write time.

`done_at` must fall inside its logical date (06:00 that day to 06:00 the next, in the store's time zone, so after-midnight continuations up to 05:59 fit the evening before, and anything from 06:00 belongs to the new day) and must not be in the future. An event sets the habit's tick (true) in the same transaction, so the patch may leave the habit out; a day already recorded as not done for that habit needs `correct` first. Planks keep their seconds on the day: a plank event needs `plank_seconds` reported (in the same patch or earlier), because a bare completion has no duration. Several events per habit per day are fine (two doses of protein are two events). A restatement of an already-recorded doing is not a new event. An applicability exception refuses an event just as it refuses the tick.

Fictional report with a stated time, a "just now" and an unknown one:
```json
{"op":"ritual_put","date":"2026-10-03","patch":{"stretching":true},"events":[{"habit":"magnesium","done_at":"2026-10-03T21:00:00+10:00","basis":"user_stated"},{"habit":"protein","done_at":"2026-10-03T21:40:00+10:00","basis":"message_received"},{"habit":"stretching","done_at":null,"basis":"unknown"}],"request_id":"ORIGINAL_MESSAGE_ID:ritual","source_text":"Took magnesium at 9, just had protein, did stretches [replace with exact words]. Source ID ORIGINAL_MESSAGE_ID. Received at 2026-10-03T21:40:00+10:00. Magnesium at 9 resolved to 21:00 Melbourne time on ritual date 2026-10-03; protein time is this message's receipt; stretching time unknown."}
```

The acknowledgement adds `events`: each event's `id` (`he_…`, derived from the request ID and its position, so a retry names the same events) and `revision`. Each event is its own audited record (`history` with entity `habit_events`), carrying the report's source_text. Same request ID and payload replays; a changed payload with the same ID is refused, as for every write.

A past day's time stated later (migrated history has ticks and no times): a fresh report on that logical date with its own request ID, `patch:{}` and the event; the tick it sets is already there and stays.
```json
{"op":"ritual_put","date":"2026-09-30","patch":{},"events":[{"habit":"protein","done_at":"2026-09-30T19:00:00+10:00","basis":"user_stated"}],"request_id":"LATER_MESSAGE_ID:ritual:2026-09-30","source_text":"Exact later words giving the time. Source ID LATER_MESSAGE_ID. Received at OFFSET_BEARING_INSTANT. Time applies to ritual date 2026-09-30 as the user stated."}
```
If that day already has an unknown-time event for the doing, give it the time with `correct` instead (only `done_at` and `basis` can change; the habit and date are its identity):
```json
{"op":"correct","entity":"habit_events","id":"he_0123456789abcdef01234567","patch":{"done_at":"2026-09-30T19:00:00+10:00","basis":"user_stated"},"expected_revision":123,"reason":"User later said when","request_id":"LATER_MESSAGE_ID:event","source_text":"Exact words, source ID and receipt; how the time was resolved."}
```
A mistaken event (a restatement saved as a second dose, say) is removed with the same guard; its audit keeps what it was:
```json
{"op":"habit_event_remove","id":"he_0123456789abcdef01234567","expected_revision":123,"reason":"Duplicate of an earlier report","request_id":"NEW_MESSAGE_ID:event-remove","source_text":"Exact words, source ID and receipt."}
```
A tick cannot be taken back while that day's events of the habit remain: remove them first, then `correct` the ritual. Removing the last event leaves the tick, which may rest on a report without a time. Offline queueing and replay work as for every write.

### Wind-down

`wind_down` is a core habit like magnesium from logical date 2026-11-09 on (`HABIT_SINCE` in `src/applicability.ts`): it counts in `full_completion`, so `ritual_checklist` and `ritual_status` list it among `remaining_core` until it is ticked, and its tick needs its event with a time, as every timed habit's does. A day before 2026-11-09 was never asked it: its cell is `not_applicable` with basis `not_started`, and a report or event of wind-down on such a day is refused. The store records only the tick and when; the dashboard judges it against midnight at the end of its logical date (`src/deadlines.ts`): before 00:00 the next calendar day in the store's time zone is on time (green), at or after it late (red, still done for completion, since the day closes at 06:00), a closed day without it red, the open day without it red too once midnight has passed (before then it is still going), and a tick with no time is done without a verdict. Log the time he gives ("wound down at 11:40": `user_stated`, 23:40 on the logical date; "winding down now": `message_received`); a wind-down after midnight still belongs to the evening before, until 06:00.

```json
{"op":"ritual_put","date":"2027-02-03","patch":{},"events":[{"habit":"wind_down","done_at":"2027-02-03T23:40:00+11:00","basis":"user_stated"}],"request_id":"ORIGINAL_MESSAGE_ID:wind-down","source_text":"Exact words [replace]. Source ID ORIGINAL_MESSAGE_ID. Received at OFFSET_BEARING_INSTANT. 11:40 resolved to 23:40 Melbourne time on ritual date 2027-02-03."}
```

### Journal timestamp as a default check-in

Read LOCAL.md before using this opt-in feature: it defines whether journal-default check-in is authorized, its effective time and any specifically authorized historical exception. A bare journalling completion, file creation, import, scheduled ping or photo is not a journal entry timestamp. Never backfill past entries merely because this option exists.

For an eligible first journal report, add top-level `journal_entry_at` to the original idempotent `ritual_put` request. Supply the offset-bearing timestamp from the original journal report/source; when it is a message receipt, label it explicitly in source_text and retain the original words, source ID and date interpretation. Exact physical arrival or completion remains unknown unless separately established. Keep the logical ritual date separate from that instant, including after-midnight continuations and DST. Never substitute current processing/write time or filesystem timestamps.

Fictional combined journal completion/default example (replace all values):
```json
{"op":"ritual_put","date":"2026-10-08","patch":{"journalling":true},"journal_entry_at":"2026-10-09T01:15:00+11:00","request_id":"ORIGINAL_JOURNAL_MESSAGE_ID:ritual","source_text":"Exact original journal words. Original source ID ORIGINAL_JOURNAL_MESSAGE_ID. Received at 2026-10-09T01:15:00+11:00. Authorized first-journal default check-in uses this original message receipt; actual physical arrival/completion instant unknown. Logical ritual date 2026-10-08 is the disclosed prior-evening interpretation."}
```

The store validates the instant and applies it only when checkins is empty after merging any explicit checkins patch, within the same write transaction. In the same transaction it also records that instant as the day's journalling event ("Habit times"), unless the request carries its own journalling event or the day already has one: `message_received` when source_text names the same instant as "Received at …", otherwise `user_stated`. It does so only when the day's journalling is done after the request (a tick in the patch, or earlier), because the instant alone never marks journalling complete; an instant outside its logical date is refused, as for any event. Existing check-ins therefore win, and retries or later journal reports cannot shift the first default. The journal option can accompany `patch:{}` when only a default is being recorded; it does not itself mark journalling complete or change other habits. For later continuations, preserve the source and append the journal; omit this option and avoid a new database write unless there is a separate reported change. An explicitly corrected check-in remains intact.

Use stable original source/action IDs and preserve exact prepared payloads in the offline queue. On reconnect replay in source order; do not create a new ID or recompute a timestamp for a lost acknowledgement. Do not add this option to previously acknowledged or queued requests with the same ID: changed payloads are rejected. A separately authorized retrospective application needs a fresh authorization/action ID linking the original journal evidence. Changing an existing recorded check-in still uses `correct` with current expected_revision, fresh source and reason; defaulting is not an override.

Correction after reading current entity revision (replace 123):
```json
{"op":"correct","entity":"rituals","id":"2026-10-03","patch":{"journalling":false},"expected_revision":123,"reason":"User corrected the original report","request_id":"NEW_CORRECTION_MESSAGE_ID:ritual","source_text":"Exact correction words, ID and receipt time; original intent/date qualification."}
```

On stale revision, read/reconcile the original correction intent before preparing a new guarded action. Don't remove the guard or reuse an ID with changed content. Identity fields cannot change; date reassignment needs an explicit supported multi-record plan, preserving original evidence.

Workout:
```json
{"op":"workout_add","record":{"date":"2026-10-03","type":"gym push","details":"Verbatim sets/weights or other free text"},"request_id":"ORIGINAL_MESSAGE_ID:workout:1","source_text":"Original words, source ID and receipt/date context"}
```

Workouts have no duration/distance/split/sets columns; `type` is the category (normalised lower-case; indexed with date, so `{"op":"workouts","from":...,"to":...,"type":"gym push"}` is an index read) and optional `title` is a glanceable label: pass `title` explicitly, or omit it and it is derived (`gym <x>` → "Gym X", `bike` + one stated duration → "Bike N min", `run` + one stated distance → "Run Xk"), else null. Fill a missing title on an old row with `correct` (patch `{"title":...}`, fresh request_id, expected_revision, reason). Multiple workouts/day have separate IDs. Reminder:
```json
{"op":"reminder_add","record":{"text":"Exact task","due_at":"2026-10-05T08:00:00+11:00"},"request_id":"ORIGINAL_MESSAGE_ID:reminder:1","source_text":"Exact timing words, source ID, receipt and resolved Melbourne timing"}
```

Omit/null due_at for stashed. States pending/delivered/done/cancelled: delivery isn't completion. `reminder_mark` needs id,status,expected_revision,reason,request_id,source_text. Snooze is `correct` on reminders/due_at. Don't invent a date or replace explicit early timing with noon review. Applicability: exception_add record={habit,start_date,end_date,reason}, optional id, same provenance. Bounds inclusive; null start covers earlier dates. Overlap/positive-report conflicts require review. Corrections use entity=applicability_exceptions.

### Weekly targets

A weekly target is a minimum to reach each Monday-to-Sunday week: a name, a unit, the weekly minimum, the `start_date` it counts from, an `active` flag and a display `position`. The store keeps the minimum's dated history, `minimums`: each `{"week_start","minimum"}` is in force from that Monday until the next one, the first from the target's first week (the week of its `start_date`). Each week is judged against the minimum in force for it, so changing the minimum never re-judges the weeks before the change. Its entries live in their own log, like daily rituals: each records the target, the `amount`, the logical `date` it counts for, an optional `note` and `logged_by`, the person or assistant who made the report. Progress (each week's total against the minimum, whether it is met, and the entries behind it) is derived on every read, never written; read it with `{"op":"weekly_progress"}`.

Units, and how an amount or minimum may be written:
- `count`: whole times; an entry's `amount` defaults to 1. An optional `noun` names what is counted for display (`"noun":"laps"` shows "1 / 2 laps").
- `km`: a distance in km, `5`, `4.2` or `"4.2km"`, at most three decimals.
- `minutes`: a duration, stored in whole minutes: `90`, `"45m"`, `"1h30m"`, `"1h 30m"` or `"1.5h"`. A stated time that is not whole minutes ("1.33h") is refused, never rounded. It reads "3h 20m / 5h".

The date is the logical ritual date the entry counts for: decide it from the report as for `ritual_put` (00:00–05:59 belongs to the previous evening) and disclose that in source_text. It cannot be before the Monday of the target's start week, or after the current logical date. Setting up a target is a request like any other; its name and entries are data in the store, never in tracked files. Fictional templates (replace every value):

```json
{"op":"target_add","record":{"name":"Fictional laps","unit":"count","noun":"laps","minimum":2,"start_date":"2027-02-01"},"request_id":"ORIGINAL_SETUP_ID:target","source_text":"Exact setup words, source ID and receipt; the minimum and unit as the user gave them."}
{"op":"target_add","record":{"name":"Fictional easy minutes","unit":"minutes","minimum":"5h","start_date":"2027-02-01"},"request_id":"ORIGINAL_SETUP_ID:target:2","source_text":"..."}
{"op":"target_log","record":{"target_id":"wt_0123456789abcdef01234567","date":"2027-02-03","amount":"1h30m","note":"Fictional ride","logged_by":"example-assistant"},"request_id":"ORIGINAL_REPORT_ID:target-log","source_text":"Exact words, source ID, Received at OFFSET_BEARING_INSTANT; logical date 2027-02-03 as reported."}
{"op":"target_log","record":{"target_id":"wt_89abcdef0123456789abcdef","date":"2027-02-03","logged_by":"example-assistant"},"request_id":"ORIGINAL_REPORT_ID:target-log:2","source_text":"..."}
```

`target_add` gives the target id (`wt_…` from the request ID unless `id` is supplied), `active` true and the next `position` unless given; the acknowledgement's record shows the minimum in its unit (`"5h"` is stored as 300) as the first entry of `minimums`. `weekly_targets` lists each target's `minimums` and, beside them, `minimum`: the one in force this week. `target_log` gives the entry id (`wte_…`). Same request ID and payload replays; a changed payload with the same ID is refused. Log only what was reported: a journal mention is a report only when the assistant reads it as one and cites it; nothing is filled in from workouts or other apps.

Undo, edit and retire, each after reading the current revision (`weekly_target_entries` or `weekly_targets`):
```json
{"op":"target_entry_remove","id":"wte_0123456789abcdef01234567","expected_revision":123,"reason":"Logged twice","request_id":"NEW_MESSAGE_ID:target-undo","source_text":"Exact words, source ID and receipt."}
{"op":"correct","entity":"weekly_target_entries","id":"wte_0123456789abcdef01234567","patch":{"amount":"1h","date":"2027-02-04"},"expected_revision":124,"reason":"User corrected the duration and day","request_id":"NEW_MESSAGE_ID:target-entry","source_text":"..."}
{"op":"correct","entity":"weekly_targets","id":"wt_0123456789abcdef01234567","patch":{"minimum":"6h"},"expected_revision":45,"reason":"User raised the target","request_id":"NEW_MESSAGE_ID:target","source_text":"..."}
{"op":"correct","entity":"weekly_targets","id":"wt_0123456789abcdef01234567","patch":{"minimum":3},"effective_week":"2027-02-08","expected_revision":46,"reason":"User raised the target from next week","request_id":"NEW_MESSAGE_ID:target-next","source_text":"..."}
{"op":"correct","entity":"weekly_targets","id":"wt_0123456789abcdef01234567","patch":{"active":false},"expected_revision":46,"reason":"User dropped the target","request_id":"NEW_MESSAGE_ID:target-retire","source_text":"..."}
```
An entry's `amount`, `note` and `date` can change; its target and `logged_by` cannot (remove it and log a new one). A removed entry stays readable in its audit (`history`, entity `weekly_target_entries`). A target's `name`, `noun`, `minimum`, `start_date`, `position` and `active` can change; its `unit` cannot, because its entries are in that unit (retire it and add a new one). A start date cannot move past a logged entry's week. A changed minimum is in force from the current week by default, or from `effective_week`, any date read as its Monday ("starting next week" is next Monday's date); the weeks before it keep the minimum they had, and a change already set for a later week is replaced. A target not started yet takes the change from its first week; an `effective_week` before the first week is refused, and `effective_week` goes only with a `minimum` patch. `minimums` is never patched directly. An `effective_week` in the past re-judges the weeks from it on, so use it only when the user says the minimum was wrong from then. A start-date correction moves the history's first entry to the new first week (a later start keeps the minimum in force then). A retired target takes no new entries (correct it to `active:true` first) and shows only in weeks that have its entries. Offline queueing and replay work as for every write.

## Journal contract

Every assistant that saves journals follows this, whichever provider or app it runs in, so switching providers loses nothing. LOCAL.md names this installation's journal folder, its provider slugs and its journal policies (such as the default check-in above). The contract is prospective: files saved before it stay exactly as they are, and are never renamed, rewritten or "upgraded".

Layout inside the journal folder, where `<date>` is the logical ritual date (in the store's time zone; an after-midnight continuation belongs to the previous evening until that day's 06:00 close, disclosed in `date_basis`; `bin/ritual-voice-calls` files a call by its start time this way):

- `<date>.md`: the lightly cleaned, editable daily entry in the user's own voice, without invented thoughts. Each section ends with a comment citing the sources it came from, e.g. `<!-- sources: EXAMPLE_MSG_1, voice-0000aaaa-1111-2222-3333-444455556666 -->`. Appending never duplicates a source already cited.
- `raw/<date>/<source_id>.<ext>`: **verbatim only**, the exact words as typed, dictated or transcribed. Never a paraphrase, summary or "relayed narrative". If an assistant only has a paraphrase (for example what a separate call agent passed on), it may keep it as `raw/<date>/<source_id>.relayed.md`, which says it is not verbatim, and it still gets the verbatim source.
- `raw/<date>/<source_id>.source.json`: one sidecar per source, in the schema below.
- `assets/<date>/`: photos and audio as original bytes.

`source_id` is stable, unique and safe as a file name (letters, digits, `.`, `_`, `-`): the provider's own message ID when it exposes one, `voice-<call uuid>` for a voice call, otherwise `<provider>-<UTC receipt as YYYYMMDDTHHMMSSZ>`. Retrying a source never duplicates it.

Sidecar (`journal-source-v1`). Every key is always present; anything unknown is `null`, never guessed. Fictional example:

```json
{
  "schema": "journal-source-v1",
  "source_id": "EXAMPLE_MSG_1",
  "provider": "example-bot",
  "provider_ref": {"message_id": "EXAMPLE_MSG_1"},
  "channel": "dictation",
  "verbatim": true,
  "sent_at": "2026-10-09T01:14:58+11:00",
  "received_at": "2026-10-09T01:15:00+11:00",
  "time_basis": "sent_at from the app's message record; received_at is the assistant's receipt",
  "logical_ritual_date": "2026-10-08",
  "date_basis": "After-midnight continuation of the 2026-10-08 evening, before the 06:00 close",
  "continuation_of": null,
  "raw_file": "EXAMPLE_MSG_1.md",
  "raw_sha256": "sha256 of raw_file's bytes",
  "related_files": [],
  "cleanup_sha256": null,
  "ambiguous_transcriptions": null,
  "request_ids": ["EXAMPLE_MSG_1:ritual"]
}
```

- `provider`: a lowercase slug for the assistant or importer (`example-bot`, `apple-journal`). `provider_ref`: that provider's own IDs, as an object.
- `channel`: `text`, `dictation`, `voice-call`, `paste` or `import`. `verbatim`: true for raw files; false only for a `.relayed.md`.
- `sent_at` / `received_at`: offset-bearing instants of when the words were produced and when the assistant got them (for a call, its start and end); `time_basis` says where each came from and its precision. Never filesystem or processing time.
- `continuation_of`: the earlier `source_id` this continues, or null. `related_files`: other files of the same source in the folder (a transcript rendering, a relayed note).
- `cleanup_sha256`: hash of the daily section made from this source, when there is one. `ambiguous_transcriptions`: a list of words the transcriber may have misheard, or null. `request_ids`: the `bin/ritualctl` request IDs this source produced.
- The raw file is never edited after saving. The writer may fill `cleanup_sha256`, `ambiguous_transcriptions` and `request_ids` in the sidecar later.

Voice calls keep the full turn-by-turn transcript, both speakers with timestamps, as `raw/<date>/voice-<id>.transcript.json` (the app's call record unchanged, plus the streamed partials joined into utterances) and a readable `voice-<id>.transcript.md`, with `voice-<id>.source.json`. Relayed call notes are optional extras named `.relayed.md`. Write the daily entry from the transcript, using the user's words and citing `voice-<id>`.

The life archive's journal module copies every finished call still in a chat app's local cache into that layout: `npm run journal -- grok-calls` (or `bin/ritual-voice-calls --cache DIR --journals DIR --provider SLUG`, its old command, which hands the run to it). It only reads the cache; it never replaces an existing file (a rerun fills in only what is missing, and flags a saved transcript whose cached call has changed since with `"differs": true`); it prints IDs and counts, never words. LOCAL.md says which app cache it reads here and whether it runs automatically. To run it automatically on a Mac, `npm run journal -- grok-calls install` from the life archive's checkout writes and loads the launchd agent `local.life-archive-voice-calls` (the journal module's README, "Grok calls"); it runs when the cache changes and every 30 minutes. An assistant with shell access may also run it right after a call. If a call's transcript is still missing from `raw/<date>/` a few minutes after the call (or the app has no local cache), ask the user to open the call's card in the app and paste its full transcript, then save the paste verbatim as `voice-<id>.transcript.md` with `channel` `paste`, where `<id>` is the call's ID if the app shows one, otherwise `<provider>-<UTC call end as YYYYMMDDTHHMMSSZ>`.

Files are mode 0600 and folders 0700 (`umask 077`). Journal text stays in the journal folder and the store's own records: never in tracked files or progress notes. The store write is unchanged: the journalling tick and any default check-in are a `ritual_put` as described above, and its request ID goes into `request_ids`.

## Offline queue and lost acknowledgements

Parent holds unreachable-Mac inputs durably with message_id,received_at,original_text,interpretation,delivery_state=held_for_mac and prepared_requests. This envelope is not a CLI request. Do not invent correction revisions offline. On reconnect deliver exact prepared JSON to `bin/ritualctl --enqueue`, then `bin/ritualctl --replay` in original order. --queue-status lists outstanding IDs.

Enqueue means queued_on_mac/database_confirmed=false; replay confirms application. Receipts and original requests remain in queue/sent. Lost acknowledgement: retry identical ID/payload, which returns existing revision. Same ID/different payload is rejected. Replay stops at conflict and retains it and later inputs. Resolve original intent with current record; never discard pending inputs to make the queue appear clear. --queue-on-failure handles local storage failures while the Mac executor runs, not a powered-off Mac. Reads report unavailability, not fabricated emptiness.

## Code changes

Rituals' code is the life archive's (`modules/rituals/`): a change is made on a branch of the life archive's repository, as its `AGENTS.md` says, tested with `npm test` and `npm run typecheck` at the root (which run `tests/*.test.ts` here with the rest, on `tests/fixtures/`; a local evidence folder can still be used with `RITUAL_FIXTURE_DIR=/path/to/evidence`), and landed through its flow. Keep the conventions for Effect code (`src/`): every operation an `Effect`, the tagged errors in `src/errors.ts`, resources scoped, SQLite through `@effect/sql-sqlite-node` with `disableWAL: true` (the store's journal mode stays `delete`), and `pack`, `sha`, `instantZ`, `isoformatUtc` and `fixed1` byte-compatible with the Python store, never "improved". The shape of `bin/ritual-view`'s envelope (`src/view.ts`, `VIEW_FORMAT`) is what rituals' tabs read, pinned as types in `../wire.ts`: a change to it fails the life archive's typecheck until the wire follows.

## The dashboard's code

`src/dashboard.ts` (the shared matrix, the weekly targets page, the static snapshots) and `src/dashboardWeb.ts` (the live projections, which `src/view.ts` reads) derive everything rituals' tabs show; `src/dashboardTheme.ts` is the old page's theme. The dashboard server, the native menu-bar app and the browser checks were retired on 2 November 2026 and stayed in rituals' repository: the life archive's Daily rituals and Habits tabs show the same habits and targets (`modules/rituals/viewer/`). `bin/ritual-dashboard` still regenerates the local HTML snapshots under `data/views/`, as every write does; nothing serves them. A returned dashboard.updated=false/record_saved=true means the save succeeded: fix the view only.

## Schema migrations

A schema change that moves or removes data is never applied implicitly. When new code needs a newer schema, every request except status, backup and export fails with "needs the reviewed migration" until it is applied, and status shows `"migration_required": true`. Apply it once, in a maintenance window with incoming reports held and the edit claim taken:

```sh
bin/ritualctl <<'JSON'
{"op":"export","save":true}
JSON
bin/ritualctl --migrate
```

`--migrate` takes its own consistent backup first (path and sha256 in the result), applies the change in one transaction, regenerates the snapshots and is a no-op once applied. It refuses on a frozen backup copy. Version 3 added `weekly_reviews` and moved every whole `Weekly: ...` note line into it; version 9 removes that table again, so migrating an older store now records version 3 without creating or moving anything, and its `Weekly:` note lines stay in the notes as written. A new store from `--init` starts at the current schema.

Version 4 adds only `ritual_attachments` (identity, ritual, text, start/end, role) and `ritual_attachment_checks` (identity, attachment, logical date, nullable done). Existing records stay unchanged and no historical answers are created. Exports include config, answers and exact audit/revision history; restoring older exports adds empty attachment tables without invented checks.

Version 5 adds only nullable `ritual_attachments.weekday`, with ISO values 1–7; existing definitions default to null (daily date-range behavior), and every original field, answer, request hash and audit row is preserved. Version 4 exports restore with null weekday while preserving their original audit.

Version 6 adds only nullable `workouts.title`; existing workouts keep a null title until a `correct` fills it.

Version 7 adds only `habit_events` (identity, logical date, habit, nullable `done_at`, `basis`). Explicit `--migrate` backs up first, leaves every existing table, tick, request hash and audit row unchanged, and creates no events: past days keep their ticks without times. Older exports restore with no events.

Version 8 adds only `weekly_targets` and `weekly_target_entries`, empty. Explicit `--migrate` backs up first and leaves every existing table and audit row unchanged; targets are then set up with `target_add` requests. Older exports restore with no targets.

Version 10 dates each weekly target's minimum: it replaces the `minimum` column with `minimums`, the history described under "Weekly targets", and gives each existing target its minimum as in force from its first week, so every week is judged exactly as before. Every other column, table and audit row is unchanged, so every revision stays the same (audit rows written before keep `minimum` in their before/after records, as written). The dashboard reads a version 8–9 store the same way before its migration, and restoring an older export records the same history.

Version 11 adds only two nullable columns to `ritual_attachment_checks`: `done_at` and `basis`, a tick's time. Explicit `--migrate` backs up first and leaves every existing check, table, request hash and audit row unchanged: past ticks get no time and read as `unknown`. Older exports restore with no times. Until the migration, `bin/ritualctl` refuses everything but status, backup and export, so apply it as soon as the code lands; `bin/ritual-view` keeps answering either side of it.

Version 12 adds only the wind-down tick: a nullable `rituals.wind_down` column, and the habit check of `habit_events` and `applicability_exceptions` widened to take `wind_down` (both tables rebuilt with the same columns and rows). Explicit `--migrate` backs up first and leaves every existing tick, event, exception, request hash and audit row unchanged: every day already recorded reads `wind_down` null, and no day before 2026-11-09 is asked it, so no past day's completion changes. Older exports restore with no wind-down answered. Until the migration, `bin/ritualctl` refuses everything but status, backup and export, so apply it as soon as the code lands; `bin/ritual-view` and the life archive's tabs keep answering either side of it (a store before it reads wind-down as not reported).

Version 9 removes the weekly review answers: it drops `weekly_reviews` and deletes their audit rows (`changes` with entity `weekly_reviews`), and changes nothing else. Explicit `--migrate` backs up the whole store first, so the backup it names is the only copy of the answers afterwards. Restoring an older export leaves its weekly review answers and their audit out the same way. The `weekly_put` and `weekly_reviews` requests and `/api/weekly` are gone; the weekly page is now Weekly targets, and its snapshot is `data/views/weekly-targets.html` (an old `weekly-review.html` snapshot is no longer written and can be deleted).

## Backup, export and restore

Each write automatically creates a consistent backup before applying it. Explicit commands:
```sh
bin/ritualctl <<'JSON'
{"op":"backup"}
JSON
bin/ritualctl <<'JSON'
{"op":"export","save":true}
JSON
```

Full exports include private source/audit records: retain locally with existing private modes, never put in UI/public logs/repos. Export without save returns snapshot JSON on stdout, so redirect privately rather than printing it into a transcript. Verify an export by restoring it to a new empty temporary Store through the supported API and comparing returned data_sha256. See tests/agent-handover.test.ts for a complete isolated roundtrip. Restore accepts only an empty store; don't run restore against production or replace the live DB ad hoc. Production recovery requires an explicit plan, current backup/export, stopped writers/service and preservation of the displaced DB/queue. This handbook does not authorize deleting originals or applying a destructive restore.

Each write's automatic backup goes to `data/backups/` under the store's root (never pruned here); the life archive's NAS backup sends a checked copy of the store each night and leaves those backups out (its README, "The NAS copy").

## End a turn

Release your edit claim if you took one. The next agent queries live state instead of relying on stale notes. Never claim simultaneous code edits are safe: only sequential workflow and existing transaction/idempotency/revision/replay guards are validated.
