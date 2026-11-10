// The Calendar's year (year.ts has its arithmetic): its totals are the counts in the calendar's kind chips over it (how
// many, on how many days, and its active days after them: CalendarView.tsx, year.ts's yearTally); here twelve small months, Monday first, each day a square shaded by how much happened on it, from
// none to four steps of the accent, today ringed, a day still to come blank. A month is what the year picks ("year
// where we can only select month"): the whole small month is one button that opens it. Hovering a day shows its
// counts above it; a day opens nothing of its own.

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { TIME_ZONE, dayStart, LOCALE } from "../../../src/time.ts";
import { Icon } from "../icons.tsx";
import { countWords, dayNumber, longDateText, monthOf, weekdayOf, weekdayText, weekOf, wordsOf } from "./calendar.ts";
import { YEAR_KINDS, yearLabel, type YearDay, type YearPlan } from "./year.ts";
import { isFutureDay } from "./day.ts";
import "./year.css";

const MONTH_NAME = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, month: "long" });

/** What a shade means, for the legend's title. */
const MEASURE =
  "Each kind on gives a day up to a point: its count against its busy day of the year (the 90th percentile of its days with any), " +
  "so a busy day's messages and a hangout weigh alike. A day's points add up; each shade is a quarter of the year's fullest day.";

/** The tip over a day: which, and where its square's top middle is in the year's box. */
interface Tip {
  day: string;
  x: number;
  y: number;
}

export function YearGrid({
  months, plan, today, loading, onMonth,
}: {
  /** The first day of each of the year's months. */
  months: readonly string[];
  /** The year counted and shaded; null while it is read. */
  plan: YearPlan | null;
  today: string;
  loading: boolean;
  onMonth: (first: string) => void;
}) {
  const byDay = useMemo(() => new Map((plan?.days ?? []).map((d) => [d.day, d])), [plan]);
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  /** The tip over the day square `el`, kept inside the box. */
  const tipOver = (el: HTMLElement | null) => {
    const day = el?.dataset.day;
    const inner = box.current;
    if (!el || !day || !inner) return setTip(null);
    const square = el.getBoundingClientRect();
    const frame = inner.getBoundingClientRect();
    const half = 120;
    const x = Math.min(Math.max(square.left + square.width / 2 - frame.left, half), frame.width - half);
    setTip({ day, x, y: square.top - frame.top });
  };
  const onPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    tipOver((event.target as HTMLElement).closest<HTMLElement>(".cal-yday"));
  };

  const shown = YEAR_KINDS.filter((kind) => plan?.kinds.some((k) => k.kind === kind));
  const tipDay = tip ? byDay.get(tip.day) : undefined;
  return (
    <div className="cal-year-col">
      <div className="cal-year-box">
        <div className="cal-year" ref={box} role="region" aria-label="The year's calendar" aria-busy={loading}>
          <div className="cal-year__head">
            <span className="cal-year__note">
              {loading || !plan ? "loading…" : `Shaded by ${shown.length === 0 ? "nothing on" : listText(shown.map((kind) => yearLabel(kind).toLowerCase()))}`}
            </span>
            <span className="cal-year__legend" title={MEASURE}>
              Less
              {[0, 1, 2, 3, 4].map((shade) => (
                <i key={shade} className="cal-yday cal-yday--key" data-shade={shade} aria-hidden="true" />
              ))}
              More
            </span>
          </div>
          <div className="cal-year__months" onPointerOver={onPointer} onPointerLeave={() => setTip(null)}>
            {months.map((first) => {
              const name = MONTH_NAME.format(dayStart(first));
              return (
                <button
                  key={first}
                  type="button"
                  className={`cal-ymonth${first.slice(0, 7) === today.slice(0, 7) ? " is-now" : ""}`}
                  aria-label={`${name} ${first.slice(0, 4)}: open the month`}
                  onClick={() => onMonth(first)}
                >
                  <span className="cal-ymonth__name">{name}</span>
                  <span className="cal-ymonth__grid" aria-hidden="true">
                    {weekOf(first).map((day) => (
                      <span key={day} className="cal-ymonth__head">
                        {weekdayText(day).slice(0, 1)}
                      </span>
                    ))}
                    {weekdayOf(first) > 0 && <span style={{ gridColumn: `span ${weekdayOf(first)}` }} />}
                    {monthOf(first).map((day) => {
                      const future = isFutureDay(day, today);
                      const of = byDay.get(day);
                      return (
                        <span
                          key={day}
                          className={`cal-yday${day === today ? " is-today" : ""}${future ? " is-future" : ""}`}
                          data-day={day}
                          data-shade={loading || future || !of ? 0 : of.shade}
                        >
                          {dayNumber(day)}
                        </span>
                      );
                    })}
                  </span>
                </button>
              );
            })}
          </div>
          {tip && <DayTip tip={tip} of={tipDay} future={isFutureDay(tip.day, today)} loading={loading} />}
        </div>
      </div>
    </div>
  );
}

/** "messages, calls and workouts". */
function listText(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The tip over a day: its date, then each kind's count with its icon, or that it had nothing. */
function DayTip({ tip, of, future, loading }: { tip: Tip; of: YearDay | undefined; future: boolean; loading: boolean }) {
  const counts = of ? YEAR_KINDS.filter((kind) => (of.counts[kind] ?? 0) > 0) : [];
  const below = tip.y < 76;
  return (
    <div className={`cal-ytip${below ? " is-below" : ""}`} style={{ left: tip.x, top: below ? tip.y + 30 : tip.y }} role="tooltip">
      <strong>{longDateText(tip.day)}</strong>
      {future ? (
        <span className="cal-ytip__none">Still to come</span>
      ) : loading || !of ? (
        <span className="cal-ytip__none">Loading…</span>
      ) : counts.length === 0 ? (
        <span className="cal-ytip__none">Nothing</span>
      ) : (
        <span className="cal-ytip__counts">
          {counts.map((kind) => (
            <span key={kind} className={`cal-ytip__count cal-card--${kind}`}>
              <Icon name={wordsOf(kind).icon} />
              {countWords(kind, of.counts[kind]!)}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
