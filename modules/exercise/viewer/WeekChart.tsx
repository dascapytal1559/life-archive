// The frame every weekly chart on the Fitness page shares (Zone2.tsx's bars, Gym.tsx's chips, Pillars.tsx's five
// pillars): a column a week, oldest first (or, with newestFirst, this week at the left and older weeks to its right, as
// the Bryan Johnson tab draws them), under a heading that names the week the pointer is on (or the one tapped, on a
// phone) and its total, over an x axis labelled by month at each month's first Monday (never forced at the ends; drawn
// from that week towards the month's newer weeks, so rightwards oldest first and leftwards newest first).
// What each column draws, and how a week is said, is the card's.

import { useState, type ReactNode } from "react";
import { monthTicks } from "./format.ts";

export function WeekChart<W extends { from: string }>({
  weeks,
  label,
  chartClass,
  summary,
  describe,
  overlay,
  column,
  newestFirst = false,
}: {
  /** Oldest first, whichever way they are drawn. */
  weeks: readonly W[];
  /** The heading when no week is pointed at ("Recent weeks"). */
  label: string;
  chartClass: string;
  /** Every week in words, for a screen reader. */
  summary: string;
  /** A week in words, shown in the heading while it is pointed at. */
  describe: (week: W) => string;
  /** Drawn over the columns (zone 2's target line). */
  overlay?: ReactNode;
  column: (week: W, i: number) => ReactNode;
  /** Draw this week at the left and older weeks to its right; `i` stays each week's place in `weeks`. */
  newestFirst?: boolean;
}) {
  const [on, setOn] = useState<number | null>(null);
  const ticks = monthTicks(weeks.map((w) => w.from));
  const order = weeks.map((_, i) => i);
  if (newestFirst) order.reverse();
  return (
    <div className={newestFirst ? "z2__weeks wk--newest-first" : "z2__weeks"}>
      <div className="wk__head">
        <div className={on === null ? "z2__label" : "z2__label wk__readout"}>
          {on === null ? label : describe(weeks[on])}
        </div>
      </div>
      <div className={`wk__chart ${chartClass}`} role="img" aria-label={summary} onMouseLeave={() => setOn(null)}>
        {overlay}
        {order.map((i) => (
          <div
            key={weeks[i].from}
            className={`wk__col${i === weeks.length - 1 ? " wk__col--now" : ""}${on === i ? " wk__col--on" : ""}`}
            onMouseEnter={() => setOn(i)}
            onClick={() => setOn((was) => (was === i ? null : i))}
          >
            {column(weeks[i], i)}
          </div>
        ))}
      </div>
      <div className="wk__axis" aria-hidden="true">
        {order.map((i) => (
          <span key={weeks[i].from}>{ticks[i]}</span>
        ))}
      </div>
    </div>
  );
}
