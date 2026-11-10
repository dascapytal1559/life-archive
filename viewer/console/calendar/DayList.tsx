// The day event by event (day.ts's dayListOf orders it), the frame the archive's day (DayView.tsx) draws its rows in: down the left each row's time (its start; none for those with
// no time, at the top), a line through the day with a dot at each row in its kind's colour, and the row itself beside it, as its
// page draws it. No hours are drawn and no empty stretch is said: the rows follow each other however far apart they are
// ("on the days that I have a lot of spacing, I don't need to see that"). On today the present is a line where it falls.

import type { CSSProperties, KeyboardEventHandler, ReactNode, Ref } from "react";
import { timeText } from "../../format.ts";
import type { Timed } from "./calendar.ts";
import { idleRows, nowIndex, type DayItem } from "./day.ts";

export function DayList<E extends Timed & { kind: string }>({
  items, now, empty, label, listRef, onKeyDown, row, dotClass = (event) => `cal-mdot--${event.kind}`,
}: {
  items: readonly DayItem<E>[];
  /** The present, on today alone; null on another day. */
  now: number | null;
  /** What a day with no row says, or null to say nothing (the page says it). */
  empty: ReactNode;
  label: string;
  listRef?: Ref<HTMLOListElement>;
  onKeyDown?: KeyboardEventHandler<HTMLOListElement>;
  /** A row's card, beside its time and its dot. */
  row: (item: DayItem<E>, index: number) => ReactNode;
  /** A row's dot's class, its kind's colour. */
  dotClass?: (event: E) => string;
}) {
  const present = nowIndex(items, now);
  const idle = idleRows(items);
  const nowLine =
    now === null ? null : (
      <li key="now" className="cal-tl__now">
        <span className="cal-tl__time">{timeText(now)}</span>
        <span>Now</span>
      </li>
    );
  return (
    <ol className="cal-tl" ref={listRef} onKeyDown={onKeyDown} aria-label={label}>
      {items.map((item, i) => (
        <DayListRow key={item.event.key} item={item} present={present === i ? nowLine : null} dot={dotClass(item.event)} idle={idle[i]}>
          {row(item, i)}
        </DayListRow>
      ))}
      {present === items.length && nowLine}
      {items.length === 0 && empty !== null && <li className="cal-tl__none">{empty}</li>}
    </ol>
  );
}

/** A row (apart from the one before by how long the day was quiet, day.ts's idleRows): the present before it when it falls there, then its time (none for one with no time), its dot, and its card. */
function DayListRow({ item, present, dot, idle, children }: { item: DayItem<Timed>; present: ReactNode; dot: string; idle: number; children: ReactNode }) {
  const { event, before } = item;
  return (
    <>
      {present}
      <li className={`cal-tl__row${event.allDay ? " is-allday" : ""}${idle ? " is-idle" : ""}`} style={idle ? ({ "--idle-gap": `${idle}px` } as CSSProperties) : undefined}>
        <span className="cal-tl__time" title={before ? "Begun the day before" : undefined}>
          {event.allDay ? "" : timeText(event.at)}
        </span>
        <span className={`cal-tl__dot ${dot}`} aria-hidden="true" />
        <div className="cal-tl__card">{children}</div>
      </li>
    </>
  );
}
