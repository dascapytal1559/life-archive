// The weekly gym sessions, beside the zone 2 target: this week's count (Monday to Sunday, local) and each recent
// week's sessions as small text chips, one a session ("Push", "Pull", "Legs", any other gym type its own word),
// stacked in its week's column over the same weeks as zone 2's chart. A session is counted, not measured, so it is
// drawn as a unit rather than a bar; hovering a chip names its day and type, pointing at a week names it
// ("Oct 26 – Nov 2") and its sessions, and the weeks are labelled by month (WeekChart.tsx). A session is an activity
// logged in Rituals under a gym category, counted once whatever its copies. There is no target, so no line;
// the chart holds three sessions a week and grows only for a week with more (gymRows).

import type { CSSProperties } from "react";
import { gymRows, gymSessionText, gymWeekText, gymWord, type WeekTotals } from "./format.ts";
import { WeekChart } from "./WeekChart.tsx";

export function GymPanel({ weeks }: { weeks: readonly WeekTotals[] }) {
  const week = weeks[weeks.length - 1];
  return (
    <section className="z2 z2--gym" aria-label="Gym sessions this week" style={{ "--gym-rows": gymRows(weeks) } as CSSProperties}>
      <div className="z2__now">
        <div className="z2__value">
          {week.gym.length}
          <small>{week.gym.length === 1 ? " gym session this week" : " gym sessions this week"}</small>
        </div>
      </div>
      <WeekChart
        weeks={weeks}
        label="Recent weeks"
        chartClass="gym__chart"
        summary={`Gym sessions each week, the last ${weeks.length}: ${weeks.map(gymWeekText).join("; ")}.`}
        describe={gymWeekText}
        column={(w) => (
          <div className="gym__week">
            {w.gym.map((s, j) => (
              <i key={j} className={`gym__unit gym__unit--${s.kind}`} title={gymSessionText(s)}>
                {gymWord(s)}
              </i>
            ))}
          </div>
        )}
      />
    </section>
  );
}
