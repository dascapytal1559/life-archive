// Rituals' two tabs (Events' Daily rituals and Fitness's Habits, viewer/HabitViews.tsx), as rituals' own dashboard
// served them: its /api/dashboard and /api/targets, made here from rituals' whole view (view.ts, which rituals' own
// dashboard code derives). `daily` is /api/dashboard's, its rows through today (below). The weekly targets are
// rituals' own /api/targets (src/dashboardWeb.ts's dashboardTargets): without each entry's note or who logged it, and with each
// target's entries in a line, `entries_text`, in rituals' own words. The temporary items and their marks go on as the
// view has them. The habit events are not handed on: the dashboard showed none. Unlike rituals' own dashboard, whose
// rows stop at the last report, the rows run through today (readView's `daysThroughActive`), so a day after the last
// report is drawn as rituals derives it: not asked where an exception covers it, else no answer.

import { Effect } from "effect";
import { dashboardTargets } from "../src/dashboardWeb.ts";
import type { RitualsDashboard, RitualsDashboardAnswer, RitualsView } from "../wire.ts";
import { readRituals } from "./view.ts";

/**
 * What the dashboard tabs read of rituals' view: the daily matrix whole, the targets without notes, the temporary items
 * with their marks (which the view already leaves without check ids, revisions, source text or audit), nothing else.
 */
export const ritualsDashboard = (view: RitualsView): RitualsDashboard => ({
  daily: view.daily,
  targets: dashboardTargets(view.weekly_targets),
  attachments: view.attachments,
});

/** The dashboard route's answer for the archive kept at `folder`. */
export const ritualsDashboardAnswer = (folder: string, asOf?: number): Effect.Effect<RitualsDashboardAnswer> =>
  readRituals(folder, asOf, { daysThroughActive: true }).pipe(
    Effect.map((view): RitualsDashboardAnswer => ({ state: "ok", dashboard: ritualsDashboard(view) })),
    Effect.catchTag("RitualsUnavailable", (error) => Effect.succeed<RitualsDashboardAnswer>({ state: error.state, reason: error.reason })),
  );
