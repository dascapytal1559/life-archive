// Daily rituals' whole run (run.ts has its arithmetic, run.css its look): today carved out in a column of its own at
// the left, each row's today mark in it (done, not done, still going, or a grey dot when it is not asked today), then a
// gap, then every day before today as a thin tick, newest at the left (yesterday, beside today) and oldest at the right,
// fit to the card's width with no scrollbar. Each row is named at its newest end, the left, with how many of its counted
// days were done, today never among them until its day closes; a habit that began lately has its empty days before it
// at the right. A day it was not asked is a grey dot; a closed day with no answer is a not done, the red mark, counted
// ("On daily rituals no answer is considered not done"). When the days no longer
// fit at MIN_DAY_PX a day, the most recent that do are shown (a row's count says since when). There is no legend: the
// captain does not need one ("Don't need the legend"). A habit's days before its routine began have no cell. Pointing at a tick or
// today's mark, or tapping it on a phone, shows its date and what rituals says of it (pointing.tsx).

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { isMonday, type DotRow, type Slot } from "./dots.ts";
import { MARK_CLASS, usePointing } from "./pointing.tsx";
import { axisLabels, fitDays, runCount, runMark, runWords, type RunMark } from "./run.ts";
import "./run.css";

const RUN_CLASS: Record<RunMark, string> = { ...MARK_CLASS, not_asked: "not-asked", before: "before" };

export function RunRows({ label, today, history, rows }: { label: string; today: Slot; history: readonly Slot[]; rows: readonly DotRow[] }) {
  const axis = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const { block, pointedKey, handlers, tip } = usePointing();

  // The width the days have, as the card is laid out and each time it changes (a window resized, a phone turned).
  useLayoutEffect(() => {
    const el = axis.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const { days } = fitDays(history, width);
  const oldest = days.at(-1);
  const labels = axisLabels(days, days.length > 0 ? width / days.length : 0);
  const columns = { "--n": Math.max(days.length, 1) } as CSSProperties;
  const pointed = (key: string) => (pointedKey === key ? " run__day--pointed" : "");

  return (
    <div className="run" ref={block}>
      <div className="run__rows" role="group" aria-label={label} {...handlers}>
        <div className="run__row run__row--axis" aria-hidden="true">
          <span className="run__today run__today--head">Today</span>
          <div className="run__axis" ref={axis}>
            {labels.map((tick) => (
              <i
                key={tick.at}
                className={`run__tick--${tick.edge}`}
                style={tick.edge === "start" ? { left: `${(tick.at / days.length) * 100}%` } : { right: `${((days.length - tick.at - 1) / days.length) * 100}%` }}
              >
                {tick.text}
              </i>
            ))}
          </div>
        </div>
        {rows.map((row) => {
          // Today is never an unanswered not done: its dot (done, not done, still going) or else a grey dot.
          const nowMark = row.dots.get(today.key)?.mark ?? "not_asked";
          const nowKey = `${row.key}/${today.key}`;
          const count = runCount(row, days);
          const from = oldest && oldest.key > row.since ? ` since ${oldest.label}` : "";
          return (
            <div key={row.key} className="run__row">
              <span className="run__today">
                <i
                  className={`run__now run__now--${RUN_CLASS[nowMark]}${pointed(nowKey)}`}
                  role="img"
                  data-dot={nowKey}
                  aria-label={`${today.label}: ${row.dots.get(today.key)?.words ?? "Not asked today"}`}
                />
              </span>
              <div className="run__history">
                <div className="run__label">
                  <span className="run__name" title={row.name}>
                    {row.name}
                  </span>
                  <span className="run__count" title={`${count.done} of ${count.counted} counted ${count.counted === 1 ? "day" : "days"} done${from}, not counting today until its day closes at 06:00`}>
                    {count.done}/{count.counted}
                  </span>
                </div>
                <div className="run__days" style={columns}>
                  {days.map((slot) => {
                    const mark = runMark(row, slot.key);
                    const key = `${row.key}/${slot.key}`;
                    const monday = isMonday(slot.key) ? " run__day--monday" : "";
                    if (mark === "before") return <span key={slot.key} className="run__day run__day--before" />;
                    return (
                      <span
                        key={slot.key}
                        className={`run__day run__day--${RUN_CLASS[mark]}${monday}${pointed(key)}`}
                        role="img"
                        data-dot={key}
                        aria-label={`${slot.label}: ${runWords(row, slot.key)}`}
                      >
                        <i />
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {tip}
    </div>
  );
}
