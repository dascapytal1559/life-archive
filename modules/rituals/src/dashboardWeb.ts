// Dashboard-only API projections and frontends; source records are never exposed.
//
// Daily rituals show derived habit cells and each day's workouts (type and details, for the owner's pop-up);
// the weekly page shows only the weekly targets' progress (no entry notes).
import { Effect, Result } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { SqlError } from "effect/sql/SqlError";
import { type Cell, dailyStatus, type Habit, statusReport } from "./applicability.ts";
import { type Deadline, deadlineOf } from "./deadlines.ts";
import { sha256Base64 } from "./encoding.ts";
import type { HabitEvent } from "./habitEvents.ts";
import type { ApplicabilityConflict, RequiresReview } from "./errors.ts";
import { isoformatUtc, type Micros, nowMicros, TIMEZONE, updatedDisplay } from "./instants.ts";
import * as dashboard from "./dashboard.ts";
import * as theme from "./dashboardTheme.ts";
import type { EntryView, Progress, TargetProgress, WeekProgress } from "./weeklyTargets.ts";

export const HABITS = dashboard.HABIT_COLUMNS;

export interface CellView {
  readonly status: Cell["status"];
  readonly basis: Cell["basis"];
  readonly text: string;
  readonly label: string;
  readonly numeric: boolean;
  /** For a habit with a deadline (wind-down's midnight), on a day it was asked: how its tick stood against it. */
  readonly deadline?: Deadline;
}

const LABELS: Record<Cell["status"], string> = {
  done: "Done",
  not_done: "Not done",
  not_applicable: "Not applicable",
  unreported: "Open — not reported",
};
const TEXT: Record<Cell["status"], string> = { done: "✓", not_done: "×", not_applicable: "N/A", unreported: "·" };

export const cellView = (cell: Cell, seconds: number | null = null): CellView => {
  const state = cell.status;
  const numeric = state === "done" && seconds !== null;
  const text = numeric ? (dashboard.plank(seconds) as string) : TEXT[state];
  return { status: state, basis: cell.basis, text, label: numeric ? `${seconds} seconds` : LABELS[state], numeric };
};

export interface Rate {
  readonly done: number;
  readonly denominator: number;
  readonly percentage: number | null;
}

export interface DashboardRow {
  readonly date: string;
  readonly display_date: string;
  readonly full_date: string;
  readonly period: string;
  readonly annotation: string;
  readonly checkin_times: ReadonlyArray<dashboard.CheckinItem>;
  readonly cells: Record<Habit, CellView>;
  readonly workouts: {
    readonly labels: ReadonlyArray<string>;
    readonly count: number;
    readonly items: ReadonlyArray<WorkoutItem>;
  };
}

export interface WorkoutItem {
  readonly type: string;
  readonly details: string;
}

export interface DashboardData {
  readonly generated_at: string;
  readonly updated_display: string;
  readonly timezone: string;
  readonly count: number;
  readonly rates: Record<string, Rate>;
  readonly rows: ReadonlyArray<DashboardRow>;
}

export type DataError = RequiresReview | ApplicabilityConflict;

/**
 * The daily projection from already-read records, so the day cutoff is computed for `asOf`. With `through` (a day), a
 * row too for every day after the last record through it, derived as rituals derives any day (an exception's day not
 * applicable, a closed day with no answer not done, today, or a day not closed yet, unreported), while the rates stay
 * over the days the records span.
 */
export const dashboardData = (records: dashboard.Records, asOf: Micros, through?: string): Result.Result<DashboardData, DataError> => {
  const reported = statusReport(records.rituals, records.workouts, records.exceptions, asOf);
  if (Result.isFailure(reported)) return Result.fail(reported.failure);
  const report = reported.success;
  const derived = new Map(report.records.map((r) => [r.date, r] as const));
  const items = new Map<string, Array<WorkoutItem>>();
  for (const w of records.workouts) {
    const day = items.get(w.date) ?? [];
    day.push({ type: w.type, details: w.details });
    items.set(w.date, day);
  }
  const eventsOn = new Map<string, Array<HabitEvent>>();
  for (const event of records.events ?? []) eventsOn.set(event.date, [...(eventsOn.get(event.date) ?? []), event]);
  const beforeRoutine = new Set(records.exceptions.filter((exception) => exception.start_date === null).map((exception) => exception.id));
  const rows: Array<DashboardRow> = [];
  let workoutDays = 0;
  let closedDays = 0;
  for (const row of dashboard.matrix(records.rituals, records.workouts, through)) {
    const known = derived.get(row.date);
    const status = known === undefined ? dailyStatus(row.date, undefined, false, records.exceptions, report) : Result.succeed(known);
    if (Result.isFailure(status)) return Result.fail(status.failure);
    const state = status.success;
    const closed = known !== undefined && state.period === "closed";
    closedDays += closed ? 1 : 0;
    workoutDays += closed && row.workout_count > 0 ? 1 : 0;
    const annotation = dashboard.dayNote(state, row);
    const times = dashboard.checkinTimes(row);
    if (Result.isFailure(times)) return Result.fail(times.failure);
    const labels = dashboard.dateLabels(row.date);
    const cells = {} as Record<Habit, CellView>;
    for (const [habit] of HABITS) {
      const derivedCell = state.habits[habit];
      // An exception with no start is open from the store's beginning: the days it covers are before the habit's routine
      // began, not a gap in it, so the page draws no cell for them.
      const beforeStart = derivedCell.exception_id !== null && beforeRoutine.has(derivedCell.exception_id);
      const base = cellView(derivedCell, habit === "planks" ? row.plank_seconds : null);
      const cell = beforeStart ? { ...base, basis: "not_started" as const } : base;
      const deadline = deadlineOf(habit, row.date, state.habits[habit], eventsOn.get(row.date) ?? [], asOf);
      if (Result.isFailure(deadline)) return Result.fail(deadline.failure);
      cells[habit] = deadline.success === null ? cell : { ...cell, deadline: deadline.success };
    }
    rows.push({
      date: row.date,
      display_date: labels.display,
      full_date: labels.full,
      period: state.period,
      annotation,
      checkin_times: times.success,
      cells,
      workouts: { labels: row.activities, count: row.workout_count, items: items.get(row.date) ?? [] },
    });
  }
  const rates: Record<string, Rate> = {};
  for (const [habit] of HABITS) {
    const metric = report.by_habit[habit];
    rates[habit] = { done: metric.done, denominator: metric.applicable, percentage: metric.percentage };
  }
  rates.workout = {
    done: workoutDays,
    denominator: closedDays,
    percentage: closedDays > 0 ? (100 * workoutDays) / closedDays : null,
  };
  return Result.succeed({
    generated_at: isoformatUtc(asOf),
    updated_display: updatedDisplay(asOf),
    timezone: TIMEZONE,
    count: rows.length,
    rates,
    rows,
  });
};

export type ReadError = SqlError | PlatformError | DataError;

/** Read the store fresh and project it (with rows `through` a day, as dashboardData says); every request recomputes the day cutoff. */
export const readDashboardData = (root: string, asOf?: Micros, through?: string): Effect.Effect<DashboardData, ReadError> =>
  Effect.gen(function* () {
    const records = yield* dashboard.readRecords(root);
    const stamp = asOf ?? (yield* nowMicros);
    return yield* Effect.fromResult(dashboardData(records, stamp, through));
  });

/** Weekly target progress at one instant, stamped like the other projections. */
export interface TargetsData extends Progress {
  readonly generated_at: string;
  readonly updated_display: string;
  readonly timezone: string;
}

export const targetsData = (progress: Progress, asOf: Micros): TargetsData => ({
  generated_at: isoformatUtc(asOf),
  updated_display: updatedDisplay(asOf),
  timezone: TIMEZONE,
  ...progress,
});

export const readTargetsData = (root: string, asOf?: Micros): Effect.Effect<TargetsData, SqlError> =>
  Effect.gen(function* () {
    const stamp = asOf ?? (yield* nowMicros);
    return targetsData(yield* dashboard.readTargetProgress(root, stamp), stamp);
  });

export interface DashboardTarget extends Omit<TargetProgress, "entries"> {
  readonly entries_text: string;
  readonly entries: ReadonlyArray<Omit<EntryView, "note" | "logged_by">>;
}

/** /api/targets: the progress without entry notes or who logged them, and each target's entries as one line. */
export const dashboardTargets = (
  data: TargetsData,
): Omit<TargetsData, "weeks"> & {
  readonly weeks: ReadonlyArray<Omit<WeekProgress, "targets"> & { readonly targets: ReadonlyArray<DashboardTarget> }>;
} => ({
  ...data,
  weeks: data.weeks.map((week) => ({
    ...week,
    targets: week.targets.map((target) => ({
      ...target,
      entries_text: dashboard.entriesText(target),
      entries: target.entries.map(({ note: _note, logged_by: _by, ...rest }) => rest),
    })),
  })),
});

// Shared by both pages: text-only DOM building and a refresh on load, on return to the tab and each visible minute.
export const LOADER = `const body = document.querySelector('tbody');
const message = document.querySelector('#message');
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function load(url, render) {
  let loading = false;
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch(url, {cache:'no-store',credentials:'same-origin'});
      if (!response.ok) throw new Error('Unavailable');
      render(await response.json());
    } catch (_) {
      message.textContent = 'Dashboard unavailable. Last loaded values may be out of date. Refresh to retry.';
      message.hidden = false;
    } finally { loading = false; }
  }
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
`;
// The daily page is the app's base address. Serve forwards a mount without its trailing slash (/rituals) as / too,
// so add the slash before anything resolves a relative URL, or api/dashboard and weekly would escape the mount.
export const DAILY_SCRIPT =
  `if (!location.pathname.endsWith('/')) history.replaceState(null, '', location.pathname + '/' + location.search + location.hash);
` +
  LOADER +
  `const habits = ${JSON.stringify(HABITS.map(([habit]) => habit))};
// Workout pop-up: a native modal dialog filled with text only. The cell's button takes focus before the dialog opens
// (a tap on the cell's padding, or on a button in Safari, focuses nothing), so closing restores focus to it at once;
// the close handler finds the cell again by date only when a refresh rebuilt the table meanwhile.
const dialog = document.querySelector('#workout-dialog');
let openedFrom = null;
function showWorkouts(row, opener) {
  openedFrom = row.date;
  opener.focus({preventScroll:true});
  document.querySelector('#workout-dialog-title').textContent = row.full_date;
  const count = row.workouts.items.length;
  document.querySelector('#workout-dialog-count').textContent = count+' '+(count === 1 ? 'workout' : 'workouts');
  const list = row.workouts.items.map((item) => {
    const entry = element('li');
    entry.append(element('h3', item.type, 'workout-type'));
    entry.append(item.details ? element('p', item.details, 'workout-details') : element('p', 'No details recorded', 'workout-details none'));
    return entry;
  });
  document.querySelector('#workout-list').replaceChildren(...list);
  dialog.showModal();
}
dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => {
  const opener = [...body.querySelectorAll('.workout-open')].find((node) => node.dataset.date === openedFrom);
  if (opener && document.activeElement !== opener) opener.focus();
});
function render(data) {
  const fragment = document.createDocumentFragment();
  for (const row of data.rows) {
    const tr = element('tr');
    const date = element('th', undefined, 'date'); date.scope = 'row';
    const time = element('time', row.display_date); time.dateTime = row.date;
    time.title = row.full_date; time.setAttribute('aria-label', row.full_date); date.append(time);
    if (row.annotation) date.append(element('small', row.annotation, row.period === 'closed' ? '' : 'open-badge'));
    tr.append(date);
    const checkin = element('td', undefined, 'checkin');
    const times = row.checkin_times || [];
    if (!times.length) {
      const empty = element('span', '—', 'none');
      empty.title = 'No evening check-in recorded'; checkin.append(empty);
    }
    for (const item of times) {
      const entry = element('div', undefined, 'checkin-entry');
      const time = element('time', item.text); time.dateTime = item.datetime;
      time.title = item.label; time.setAttribute('aria-label', item.label); entry.append(time);
      checkin.append(entry);
    }
    tr.append(checkin);
    for (const habit of habits) {
      const cell = row.cells[habit];
      const td = element('td');
      const classes = {done:'done',not_done:'not-done',not_applicable:'na',unreported:'unknown'};
      const mark = element('span', cell.text, cell.numeric ? 'time' : 'mark '+classes[cell.status]);
      mark.title = cell.label; mark.setAttribute('aria-label', cell.label);
      if (!cell.numeric) mark.setAttribute('role','img');
      td.append(mark);tr.append(td);
    }
    const workouts = element('td', undefined, 'activities');
    const types = element('span', row.workouts.labels.length ? row.workouts.labels.join(', ') : '—', row.workouts.labels.length ? 'activity-text' : 'none');
    types.title = row.workouts.count+' recorded workouts';
    if (row.workouts.items.length) {
      const open = element('button', undefined, 'workout-open'); open.type = 'button'; open.dataset.date = row.date;
      open.setAttribute('aria-haspopup', 'dialog'); open.setAttribute('aria-label', 'Workout details for '+row.full_date+': '+types.textContent);
      open.append(types); open.addEventListener('click', () => showWorkouts(row, open));
      workouts.classList.add('has-workouts'); workouts.addEventListener('click', (event) => { if (event.target === workouts) open.click(); });
      workouts.append(open);
    } else workouts.append(types);
    tr.append(workouts);
    fragment.append(tr);
  }
  body.replaceChildren(fragment);
  document.querySelector('#day-count').textContent = data.count+' '+(data.count === 1 ? 'day' : 'days');
  for (const node of document.querySelectorAll('[data-rate]')) {
    const metric = data.rates[node.dataset.rate];
    node.textContent = metric.percentage === null ? '—' : metric.percentage.toFixed(1)+'%';
    node.title = metric.done+' of '+metric.denominator+(node.dataset.rate === 'workout' ? ' closed days with a recorded workout' : ' applicable closed days');
  }
  document.querySelector('#updated').textContent = 'Updated '+data.updated_display;
  message.textContent = data.count ? '' : 'No dates recorded yet.';message.hidden = data.count !== 0;
}
load('api/dashboard', render);`;
// The targets section mirrors dashboard.renderTargets: a card per current-week target (bar or icons), then its earlier weeks' marks.
export const WEEKLY_SCRIPT =
  LOADER +
  `const targets = document.querySelector('#targets');
const icons = ` +
  JSON.stringify(dashboard.TARGET_ICONS) +
  `;
function iconRow(target, d) {
  return Array.from({ length: Math.max(target.minimum, target.total) }, (_, i) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'target-icon'+(i < target.total ? ' logged' : ''));
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('fill-rule', 'evenodd'); path.setAttribute('d', d);
    svg.append(path); return svg;
  });
}
function targetCard(target, earlier) {
  const item = element('li', undefined, 'target'+(target.met ? ' met' : '')); item.dataset.target = target.id;
  const top = element('div', undefined, 'target-top');
  top.append(element('h3', target.name, 'target-name'), element('span', target.met ? '✓ Met' : target.remaining_text+' to go', 'target-badge '+(target.met ? 'met' : 'to-go')));
  item.append(top, element('p', target.progress_text, 'target-count'));
  const percent = Math.round(target.fraction*100);
  const icon = target.unit === 'count' && target.noun !== null && Object.hasOwn(icons, target.noun) ? icons[target.noun] : undefined;
  const bar = element('div', undefined, icon === undefined ? 'target-bar' : 'target-icons'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', target.name);
  bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(percent)); bar.setAttribute('aria-valuetext', target.progress_text);
  if (icon === undefined) { const fill = element('span'); fill.style.width = percent+'%'; bar.append(fill); } else bar.append(...iconRow(target, icon));
  item.append(bar, element('p', target.entries_text, 'target-entries'));
  if (earlier.length) {
    const weeks = element('ol', undefined, 'target-weeks'); weeks.setAttribute('aria-label', 'Earlier weeks');
    for (const [display, t] of earlier) {
      const label = display+': '+t.progress_text+', '+(t.met ? 'met' : 'not met');
      const mark = element('li', t.met ? '✓' : '×', 'mark '+(t.met ? 'done' : 'not-done'));
      mark.title = label; mark.setAttribute('aria-label', label); weeks.append(mark);
    }
    item.append(weeks);
  }
  return item;
}
function render(data) {
  const current = data.weeks.find((w) => w.current);
  document.querySelector('#updated').textContent = 'Updated '+data.updated_display;
  targets.hidden = !current;
  message.textContent = current ? '' : ` +
  JSON.stringify(dashboard.TARGETS_EMPTY) +
  `;message.hidden = !!current;
  if (!current) return;
  const time = targets.querySelector('.targets-week time');
  time.textContent = current.display; time.dateTime = current.week_start; time.title = current.full;
  targets.querySelector('#targets-met').textContent = current.met+' of '+current.targets.length+' met';
  const earlier = (id) => data.weeks.filter((w) => !w.current).flatMap((w) => { const t = w.targets.find((c) => c.id === id); return t ? [[w.display, t]] : []; }).reverse();
  targets.querySelector('.target-list').replaceChildren(...current.targets.map((target) => targetCard(target, earlier(target.id))));
}
load('api/targets', render);`;
export const SCRIPTS: Record<dashboard.Ritual, string> = { daily: DAILY_SCRIPT, weekly: WEEKLY_SCRIPT };
export const scriptHash = (script: string): string => sha256Base64(script);
export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src " +
  [...Object.values(SCRIPTS), theme.SCRIPT].map((x) => `'sha256-${scriptHash(x)}'`).join(" ") +
  "; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Filled per day by DAILY_SCRIPT; empty until a workout cell opens it.
export const WORKOUT_DIALOG =
  '<dialog id="workout-dialog" class="workout-dialog" aria-labelledby="workout-dialog-title"><div class="dialog-body">' +
  '<div class="dialog-head"><div><p class="dialog-count" id="workout-dialog-count"></p><h2 id="workout-dialog-title"></h2></div>' +
  '<button type="button" class="dialog-close" aria-label="Close">×</button></div><ul class="workout-list" id="workout-list"></ul></div></dialog>';
export const LOADING = '<p class="empty" id="message" role="status">Loading dashboard…</p>';

export const frontend = (ritual: dashboard.Ritual = "daily"): string => {
  let table: string;
  if (ritual === "daily") {
    const headers = HABITS.map(
      ([h, label]) =>
        `<th class="${h === "planks" ? "plank-col" : "check-col"}" scope="col">${label}<span class="header-metric">(<span data-rate="${h}">—</span>)</span></th>`,
    ).join("");
    table = `<table aria-label="Daily ritual and workout matrix"><thead><tr><th class="date" scope="col">Date<span class="header-metric">(<span id="day-count">—</span>)</span></th>${dashboard.CHECKIN_HEADER}${headers}<th class="activities" scope="col">Workout<span class="header-metric">(<span data-rate="workout">—</span>)</span></th></tr></thead><tbody></tbody></table>`;
  } else {
    table = `<section class="targets" id="targets" aria-labelledby="targets-title" hidden><div class="targets-head"><h2 id="targets-title">This week</h2><p class="targets-week"><time></time> · <span id="targets-met"></span></p></div><ul class="target-list"></ul></section>`;
  }
  const dialog = ritual === "daily" ? WORKOUT_DIALOG : "";
  const body = `<div class="sheet"><div class="scroll">${table}${LOADING}</div></div>${dialog}\n<script>${SCRIPTS[ritual]}</script>`;
  return dashboard.page(ritual, CSP, body, dashboard.LIVE_PATHS, '<p class="snapshot" id="updated">Updated —</p>');
};

export const jsonResponse = (root: string): Effect.Effect<string, ReadError> =>
  Effect.map(readDashboardData(root), (data) => JSON.stringify(data));

export const targetsResponse = (root: string): Effect.Effect<string, SqlError> =>
  Effect.map(readTargetsData(root), (data) => JSON.stringify(dashboardTargets(data)));
