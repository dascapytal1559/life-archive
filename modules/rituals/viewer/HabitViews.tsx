// Rituals in the console (the module's page half, ../viewer.tsx): two views, each a tab on another page, now that the
// Rituals page is gone (the captain: "we're gonna fold the rituals page into exercise and we're gonna change exercise to
// fitness"). Both draw rituals' habits and targets a row each (dots.ts makes the rows).
//
//   Daily rituals, on the Events page (/life-archive/dev/events/daily): every habit of rituals' (magnesium,
//     protein, stretches, the plank, journalling and winding down before midnight, and any it adds) and the temporary
//     checks running now, such as the morning's and the evening's, together in the order they were added (dots.ts's byAdded), as their whole run (RunRows.tsx): today in a column of its own at the left, then
//     every day before it fit to the card's width, a thin tick a day, yesterday beside today and the oldest at the right. A day's tooltip on the journalling row says when
//     he checked in that evening.
//   Habits, on Fitness (/life-archive/dev/fitness/habits): the weekly targets but the fish one, as rows of dots
//     (DotRows.tsx), a week a dot, this week's progress under each name. The Rituals page's old Weekly and Previous
//     addresses open it.
//
// Both read what rituals' own dashboard served (GET /life-archive/api/m/rituals/dashboard, ../wire.ts's
// RitualsDashboard): asked when the tab opens, when the browser tab comes back into view and each minute in view,
// keeping what it last had and saying so when an ask fails.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Card, type View } from "../../../sdk/viewer.ts";
import { WIND_DOWN_NAME } from "../../../sdk/wire.ts";
import { RITUALS_DASHBOARD_API, type RitualsDashboard, type RitualsDashboardAnswer } from "../wire.ts";
import { DotLegend, DotRows } from "./DotRows.tsx";
import { RunRows } from "./RunRows.tsx";
import { byAdded, CHECKIN_HABIT, checkRow, daySpan, fitnessTargets, habitRow, habitsOf, runningChecks, targetRows, weekSlots } from "./dots.ts";
import "./dots.css";

/** How often a tab asks again while it is in view. */
export const REFRESH_MS = 60_000;

/** The aspects the two views sit under: the core's Events page, and the exercise module's Fitness page. */
const EVENTS = "events";
const FITNESS = "fitness";

export function ritualsViews(): View[] {
  return [
    {
      key: "rituals-daily",
      label: "Daily rituals",
      aspects: [EVENTS],
      section: "daily",
      // Events' second tab, between the Calendar (1) and Tables (3) (EVENTS_ORDER in viewer/console/EventsSection.tsx).
      order: 2,
      blurb: `Each daily ritual's whole run, today at the left and every day before it as a thin tick: magnesium, protein, stretches, the plank, journalling, the morning's and evening's checks and ${WIND_DOWN_NAME.toLowerCase()}.`,
      component: () => <DailyRituals />,
    },
    {
      key: "rituals-fitness",
      label: "Habits",
      aspects: [FITNESS],
      section: "habits",
      // The Rituals page's Weekly targets and Previous: its addresses open this tab, where the weekly targets now are.
      formerSections: ["weekly", "previous"],
      blurb: "The weekly targets as rows of dots, a week a dot, this week's progress under each.",
      component: () => <FitnessHabits />,
    },
  ];
}

/** The dashboard as last read, and whether the last ask failed (and why, when rituals said). */
interface Read {
  dashboard: RitualsDashboard | null;
  failed: string | null;
}

/** The dashboard, asked for on opening, on coming back into view and each minute in view; the last one had is kept. */
function useDashboard(): Read {
  const [read, setRead] = useState<Read>({ dashboard: null, failed: null });
  const asking = useRef<AbortController | null>(null);

  const ask = useCallback(() => {
    if (asking.current) return;
    const abort = (asking.current = new AbortController());
    fetch(RITUALS_DASHBOARD_API, { cache: "no-store", credentials: "same-origin", signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const answer = (await res.json()) as RitualsDashboardAnswer;
        if (answer.state === "ok") setRead({ dashboard: answer.dashboard, failed: null });
        else setRead((was) => ({ ...was, failed: answer.reason }));
      })
      .catch((error: Error) => abort.signal.aborted || setRead((was) => ({ ...was, failed: error.message })))
      .finally(() => {
        if (asking.current === abort) asking.current = null;
      });
  }, []);

  useEffect(() => {
    ask();
    const every = setInterval(() => document.hidden || ask(), REFRESH_MS);
    const back = () => document.hidden || ask();
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(every);
      document.removeEventListener("visibilitychange", back);
      asking.current?.abort();
      asking.current = null;
    };
  }, [ask]);

  return read;
}

/** What the tab says while it has nothing, or above what it last had when an ask failed. */
function Frame({ read, children }: { read: Read; children: (dashboard: RitualsDashboard) => ReactNode }) {
  if (!read.dashboard) {
    if (!read.failed) return <p className="hd__message" role="status">Loading…</p>;
    return (
      <p className="hd__message" role="status">
        Rituals is unavailable: {read.failed}
      </p>
    );
  }
  return (
    <div className="hd">
      {read.failed && (
        <p className="hd__warn" role="status">
          Rituals did not answer ({read.failed}). What is shown is from the last time it did.
        </p>
      )}
      {children(read.dashboard)}
    </div>
  );
}

/** Today's ritual date, rituals' (the 06:00 cutoff applied). */
const todayOf = (dashboard: RitualsDashboard) => dashboard.attachments.active_date;

/** Events › Daily rituals: every habit and the temporary checks running now, in the order they were added. */
function DailyRituals() {
  const read = useDashboard();
  return (
    <Frame read={read}>
      {(dashboard) => {
        const today = todayOf(dashboard);
        const checks = runningChecks(dashboard.attachments);
        // The span ends today: today is carved out, the run is the days before it.
        const days = daySpan(dashboard.daily, checks, today);
        // Habits and checks together, in the order they were added: the latest at the bottom.
        const rows = byAdded(
          [
            ...habitsOf(dashboard.daily).map((habit) => habitRow(dashboard.daily, habit, today, { checkins: habit === CHECKIN_HABIT })),
            ...checks.map((item) => checkRow(item, today)),
          ],
          days[0]!.key,
        );
        return (
          <Card title="Daily rituals" aside={`Updated ${dashboard.daily.updated_display}`}>
            <RunRows label="Daily rituals: today, then every day before it" today={days.at(-1)!} history={days.slice(0, -1)} rows={rows} />
          </Card>
        );
      }}
    </Frame>
  );
}

/** Fitness › Habits: the weekly targets but the fish one, a week a dot. */
function FitnessHabits() {
  const read = useDashboard();
  return (
    <Frame read={read}>
      {(dashboard) => {
        const targets = fitnessTargets(dashboard.targets);
        const current = targets.weeks.find((week) => week.current);
        return (
          <Card title="Weekly targets" aside={current ? `${current.met} of ${current.targets.length} met this week` : undefined}>
            {targets.weeks.length === 0 ? (
              <p className="hd__none">No weekly targets yet.</p>
            ) : (
              <>
                <DotRows label="Weekly targets, a week a dot" slots={weekSlots(targets)} rows={targetRows(targets)} />
                <DotLegend />
              </>
            )}
          </Card>
        );
      }}
    </Frame>
  );
}
