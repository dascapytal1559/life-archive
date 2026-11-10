// The weekly zone 2 target, at the top of the Fitness page: this week's minutes in zone 2 (Monday to Sunday,
// local) against the target the archive keeps (data/exercise.json's zone2WeeklyMinutes), as a wide bar in the
// style of T3 Code's usage page (the minutes done filled, the rest hatched, a tick at how far through the week we
// are, near-black by day and white at night), and each recent week's minutes, a bar a week under a line at
// the target. Every activity's minutes are counted once (its zone2: its trusted heart rate's zones, else its Rituals
// log saying zone 2), so nothing is counted twice; under the bar, whose zones they are (exercise.json's, or Polar's). Pointing at a week names it ("Oct 26 – Nov 2") and its minutes;
// the weeks are labelled by month (WeekChart.tsx).

import { useEffect, useState } from "react";
import type { Zone2Target, ZoneSettings } from "../wire.ts";
import { minutesText, weekElapsed, weekSpan, zone2WeekText, zonesNote, type WeekTotals } from "./format.ts";
import { WeekChart } from "./WeekChart.tsx";

/** How far through this week we are, read again each minute so the tick moves while the page is open. */
function useWeekElapsed(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return weekElapsed(now);
}

export function Zone2Panel({ weeks, target, zones }: { weeks: readonly WeekTotals[]; target: Zone2Target; zones: ZoneSettings }) {
  const week = weeks[weeks.length - 1];
  const goal = target.minutes;
  const done = week.zone2Minutes;
  const elapsed = useWeekElapsed();
  const most = Math.max(goal ?? 0, ...weeks.map((w) => w.zone2Minutes), 1);
  return (
    <section className="z2" aria-label="Zone 2 this week">
      <div className="z2__now">
        <div className="z2__value">
          {Math.round(done)}
          <small>{goal !== null ? ` of ${Math.round(goal)} min of zone 2 this week` : " min of zone 2 this week"}</small>
        </div>
        {goal !== null ? (
          <div
            className={`z2__bar${done >= goal ? " z2__bar--met" : ""}`}
            role="meter"
            aria-valuemin={0}
            aria-valuemax={goal}
            aria-valuenow={Math.round(done)}
            aria-label={`${Math.round(done)} of ${Math.round(goal)} minutes in zone 2 this week, ${Math.round(elapsed * 100)}% of the week gone`}
          >
            <i className="z2__done" style={{ width: `${Math.min(100, (done / goal) * 100)}%` }} />
            <i className="z2__elapsed" style={{ left: `${elapsed * 100}%` }} title={`${Math.round(elapsed * 100)}% of the week gone`} />
          </div>
        ) : (
          <div className="z2__note">{target.why}</div>
        )}
        <div className="z2__note">{zonesNote(zones)}.</div>
      </div>
      <WeekChart
        weeks={weeks}
        label={`Recent weeks${goal !== null ? `, against ${minutesText(goal)}` : ""}`}
        chartClass="z2__chart"
        summary={`Minutes in zone 2 each week, the last ${weeks.length}: ${weeks.map((w) => `${weekSpan(w.from)} ${Math.round(w.zone2Minutes)}`).join("; ")}.`}
        describe={zone2WeekText}
        overlay={goal !== null && <span className="z2__goal" style={{ bottom: `${(goal / most) * 100}%` }} aria-hidden="true" />}
        column={(w, i) => (
          <i
            className={`${goal !== null && w.zone2Minutes >= goal ? "z2__week--met" : ""}${i === weeks.length - 1 ? " z2__week--now" : ""}`.trim() || undefined}
            style={{ height: `${Math.max(w.zone2Minutes > 0 ? 2 : 0, (w.zone2Minutes / most) * 100)}%` }}
          />
        )}
      />
    </section>
  );
}
