// Rows of dots (dots.ts makes them), Fitness's Habits' (Daily rituals has its whole run, RunRows.tsx): a target a row,
// its name and how many of its counted weeks were met held at the left, then a dot a slot, oldest at the left, and an
// axis above naming the months. Pointing at a dot, or tapping it on a phone, shows its date and what rituals says of it
// above it (pointing.tsx). When the dots are wider than the card (a phone) the strip scrolls sideways under the held
// names, opened at the newest.

import { useLayoutEffect, useRef } from "react";
import type { DotRow, Slot } from "./dots.ts";
import { MARK_CLASS, usePointing } from "./pointing.tsx";

/** The words for a dot, for a screen reader and its tooltip: "Fri 6 Nov: Done". */
const dotLabel = (slot: Slot, words: string) => `${slot.label}: ${words}`;

export function DotRows({ label, slots, rows }: { label: string; slots: readonly Slot[]; rows: readonly DotRow[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const { block, pointedKey, handlers, clear, tip } = usePointing();

  // Opened at the newest: the newest slots are at the right.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [slots.length]);

  return (
    <div className="dots dots--week" ref={block}>
      <div className="dots__scroll" ref={scroller} role="group" aria-label={label} {...handlers} onScroll={clear}>
        <div className="dots__row dots__row--axis" aria-hidden="true">
          <span className="dots__head" />
          <span className="dots__strip">
            {slots.map((slot) => (
              <span key={slot.key} className="dots__slot">
                {slot.tick && <i className="dots__tick">{slot.tick}</i>}
              </span>
            ))}
          </span>
        </div>
        {rows.map((row) => (
          <div key={row.key} className="dots__row">
            <span className="dots__head">
              <span className="dots__name" title={row.name}>
                <span className="dots__label">{row.name}</span>
                {row.note && <small className="dots__note">{row.note}</small>}
              </span>
              <span className="dots__count" title={`${row.done} of ${row.counted} counted ${row.counted === 1 ? "week" : "weeks"} met`}>
                {row.done}/{row.counted}
              </span>
            </span>
            <span className="dots__strip">
              {slots.map((slot) => {
                const dot = row.dots.get(slot.key);
                const key = `${row.key}/${slot.key}`;
                return (
                  <span key={slot.key} className="dots__slot">
                    {dot && (
                      <i
                        className={`dot dot--${MARK_CLASS[dot.mark]}${pointedKey === key ? " dot--pointed" : ""}`}
                        role="img"
                        data-dot={key}
                        aria-label={dotLabel(slot, dot.words)}
                      />
                    )}
                  </span>
                );
              })}
            </span>
          </div>
        ))}
      </div>
      {tip}
    </div>
  );
}

/** What the marks mean, under the rows. */
export function DotLegend() {
  return (
    <p className="dots__legend">
      <span>
        <i className="dot dot--done" aria-hidden="true" /> met
      </span>
      <span>
        <i className="dot dot--not-done" aria-hidden="true" /> missed
      </span>
      <span>
        <i className="dot dot--open" aria-hidden="true" /> this week, still going
      </span>
      <span>no dot: not counted that week (not counted)</span>
    </p>
  );
}
