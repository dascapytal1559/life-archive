// The week event by event (day.ts's weekListOf orders it): the captain's "Explore if weekly calendar could also look like
// day calendar with the events event by event layout", and then "this is a backwards looking calendar, so we don't
// actually need the grid", so it is the week's only layout, its hours grid gone.
// The same seven columns, Monday to Sunday, under the same heads and summary rows (the page draws them: the days' heads,
// whom he messaged, the agents, the rituals on Events), but each column lists its day's events one by one in the order they began, as the day
// does (DayList.tsx): what has no time first, then each at its time, its time, its kind's icon, its title and a few
// words. No hours are drawn, so a quiet day is short and the columns end where their days do; the present a line on
// today where it falls. On a phone the days stack, each its head (sticky while its day scrolls by), its summaries and
// its events, and the week opens on the day picked.

import { Fragment, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { timeText } from "../../format.ts";
import { Icon, type IconName } from "../icons.tsx";
import { longDateText, wordsOf, type CalendarEvent, type ListEvent } from "./calendar.ts";
import { cardHours, idleRows, isFutureDay, nowIndex, type DayItem, type WeekDay } from "./day.ts";
import "./week.css";

/** A summary row over the lists (Messaged, Agents): its label at the left, and its cell on each day (each the page's own element, as on the hours). */
export interface WeekRow {
  key: string;
  label: ReactNode;
  cell: (day: string, index: number) => ReactNode;
}

/** A card's icon, the calendar's for its kind. */
const kindIcon = (event: ListEvent): IconName => wordsOf(event.kind as CalendarEvent["kind"]).icon;

/** Whether the days stack (the console's phone break): there the week opens on the day picked. */
const stacked = () => matchMedia("(max-width: 899px)").matches;

export function WeekList<E extends ListEvent = CalendarEvent>({
  week, now, nowDay, picked, openKey, loading, label, corner, head, rows = [], scrollKey, iconOf = kindIcon, onOpen,
}: {
  week: readonly WeekDay<E>[];
  now: number;
  nowDay: string;
  /** The day picked: on a phone the week opens on it. */
  picked: string;
  openKey: string | null;
  loading: boolean;
  /** The region's name: "The week's calendar". */
  label: string;
  /** The corner over the labels (the zone). */
  corner?: ReactNode;
  /** A day's head, the cell over its column. */
  head: (day: string, index: number) => ReactNode;
  /** The summary rows under the heads, in order. */
  rows?: readonly WeekRow[];
  /** What is shown (the week's first instant): a new one opens on the day picked again. */
  scrollKey: number;
  iconOf?: (event: E) => IconName;
  onOpen: (event: E) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledTo = useRef<number | null>(null);
  useEffect(() => {
    const box = scroller.current;
    if (loading || !box || scrolledTo.current === scrollKey) return;
    scrolledTo.current = scrollKey;
    if (!stacked()) return;
    const section = box.querySelector<HTMLElement>(`[data-day="${picked}"]`);
    box.scrollTop = section && section !== box.querySelector("[data-day]") ? section.offsetTop : 0;
  }, [loading, scrollKey, picked]);

  return (
    <div className="cal-grid-box cal-wlist-box">
      <div className="cal-scroll" ref={scroller} role="region" aria-label={label} aria-busy={loading}>
        <div
          className="cal-grid cal-wlist"
          style={{ gridTemplateColumns: `var(--cal-gutter) repeat(${week.length}, minmax(var(--cal-wcol), 1fr))`, gridTemplateRows: `repeat(${rows.length + 1}, auto) 1fr` }}
        >
          <div className="cal-wlist__gutter">
            {corner}
            {rows.map((row) => (
              <Fragment key={row.key}>{row.label}</Fragment>
            ))}
            <div className="cal-wlist__rail" aria-hidden="true" />
          </div>
          {week.map(({ day, items }, i) => (
            <section key={day} className="cal-wlist__day" data-day={day} aria-label={longDateText(day)}>
              {head(day, i)}
              {rows.map((row) => (
                <Fragment key={row.key}>{row.cell(day, i)}</Fragment>
              ))}
              <DayColumn
                items={loading ? [] : items}
                now={day === nowDay ? now : null}
                last={i === week.length - 1}
                today={day === nowDay}
                empty={!loading && !isFutureDay(day, nowDay)}
                openKey={openKey}
                iconOf={iconOf}
                onOpen={onOpen}
              />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A day's column: its events one by one, the present among them on today, or a quiet word for a day with none. */
function DayColumn<E extends ListEvent>({
  items, now, last, today, empty, openKey, iconOf, onOpen,
}: {
  items: readonly DayItem<E>[];
  now: number | null;
  last: boolean;
  today: boolean;
  /** Whether a day with nothing says so (not while loading). */
  empty: boolean;
  openKey: string | null;
  iconOf: (event: E) => IconName;
  onOpen: (event: E) => void;
}) {
  const present = nowIndex(items, now);
  const idle = idleRows(items);
  const nowLine =
    now === null ? null : (
      <li key="now" className="cal-wnow" aria-label={`Now, ${timeText(now)}`}>
        <span>{timeText(now)}</span>
      </li>
    );
  return (
    <ol className={`cal-wcol${today ? " is-today" : ""}${last ? " is-last" : ""}`}>
      {items.map((item, i) => (
        <WeekRowItem key={item.event.key} item={item} present={present === i ? nowLine : null} idle={idle[i]} lit={openKey === item.event.key} icon={iconOf(item.event)} onOpen={onOpen} />
      ))}
      {present === items.length && nowLine}
      {items.length === 0 && empty && <li className="cal-wcol__none">Nothing</li>}
    </ol>
  );
}

/** An event in its day's column: when (its start, none for one with no time, or until when for one begun the day before), its icon and title, a few words (how long it took among them). */
function WeekRowItem<E extends ListEvent>({
  item, present, idle, lit, icon, onOpen,
}: {
  item: DayItem<E>;
  present: ReactNode;
  /** Apart from the event before, px, by how long the day was quiet (day.ts's idleRows). */
  idle: number;
  lit: boolean;
  icon: IconName;
  onOpen: (event: E) => void;
}) {
  const { event, before } = item;
  const when = event.allDay ? null : before ? `Until ${timeText(event.until)}` : timeText(event.at);
  const words = `${event.title}${before ? " · From the day before, until " + timeText(event.until) : when ? ` · ${when}` : ""}${event.detail ? ` · ${event.detail}` : ""}`;
  return (
    <>
      {present}
      <li style={idle ? ({ "--idle-gap": `${idle}px` } as CSSProperties) : undefined}>
        <button
          type="button"
          className={`cal-wev cal-card--${event.kind}${lit ? " is-lit" : ""}${event.allDay ? " is-allday" : ""}`}
          data-key={event.key}
          title={words}
          aria-label={words}
          style={{ "--card-hours": cardHours(event) } as CSSProperties}
          onClick={() => onOpen(event)}
        >
          {when && <span className="cal-wev__when">{when}</span>}
          <span className="cal-wev__head">
            <Icon name={icon} />
            <span className="cal-wev__title">{event.title}</span>
          </span>
          {event.detail && <span className="cal-wev__meta">{event.detail}</span>}
        </button>
      </li>
    </>
  );
}
