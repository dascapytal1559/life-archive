// The Calendar's day (day.ts has its arithmetic), the calendar's building block: "it should almost feel like a time
// machine where I can go through moment by moment and I can see some summaries up top". Its summaries are the counts in
// the calendar's kind chips over it (CalendarView.tsx, day.ts's spanTally: "we can just combine the count. Into the
// filter chips"). Here the day event by event (DayList.tsx), with no
// hour grid and no empty hours ("I feel like the day view used to be like event by event as opposed to a fixed time
// grid ... on the days that I have a lot of spacing, I don't need to see that"): a hangout with no time first, then each
// call, hangout and workout in time order, its time, its kind, its title, when it ran and how it went, and who; the
// present a line on today. At the side everyone on the day, the most messages first, each opening that day's chat
// with them (DayPeople.tsx). Over the list + Hangout and + Call add one of the captain's own on the day (viewer/
// AddRow.tsx, the date filled in). ↑ and ↓ (or J and K) step from row to row; a click or Enter opens its row's drawer.
// Messages and agent sessions are never rows: the day counts them. The week lists its days the same way (WeekList.tsx).

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from "react";
import { countText, lengthText, timeText } from "../../format.ts";
import { Icon } from "../icons.tsx";
import { addTitle } from "../../AddRow.tsx";
import type { KindSpec } from "../../wire.ts";
import { EVENTS_DAY_BEGINS, peopleOn, rangeText, wordsOf, zoneText, type CalendarEvent, type CalendarKind, type Messaged } from "./calendar.ts";
import { cardHours, momentsOf, noMomentsText, stepMoment, type DayItem } from "./day.ts";
import { DayList } from "./DayList.tsx";
import { DayPeople } from "./DayPeople.tsx";
import "./day.css";
import { zonePlace } from "../../../src/time.ts";

export function DayView({
  day, from, isToday, isFuture, now, events, messaged, people, hidden, showHidden, kinds, person, loading, openKey, adds, onPerson, onShowHidden, onFriendMap, onOpen, onAdd, stepRef,
}: {
  day: string;
  /** The day's start, ms. */
  from: number;
  isToday: boolean;
  /** A day still to come: no "Nothing" on it. */
  isFuture: boolean;
  now: number;
  /** Every card of the day, of every kind and everyone (the person and the kinds narrow them here). */
  events: readonly CalendarEvent[];
  /** Whom he messaged on the day, everyone. */
  messaged: readonly Messaged[];
  people: Record<number, string>;
  /** Who friend map hides, of everyone on the day; left out of the People list unless `showHidden`. */
  hidden: ReadonlySet<number>;
  showHidden: boolean;
  kinds: readonly CalendarKind[];
  person: number | null;
  loading: boolean;
  /** The block whose drawer is open. */
  openKey: string | null;
  /** The tables a row of the captain's own can be added to on the day (hangouts, calls): an Add each. */
  adds: readonly KindSpec[];
  onPerson: (person: number | null) => void;
  onShowHidden: (show: boolean) => void;
  onFriendMap: (person: number) => void;
  onOpen: (event: CalendarEvent) => void;
  onAdd: (spec: KindSpec) => void;
  /** Set to step the moment from outside (the view's ↑ and ↓ wherever the focus is). */
  stepRef: MutableRefObject<((by: number) => void) | null>;
}) {
  const shown = useMemo(
    () => events.filter((event) => kinds.includes(event.kind) && (person === null || event.people.includes(person))),
    [events, kinds, person],
  );
  const items = useMemo(() => momentsOf(shown, day, EVENTS_DAY_BEGINS), [shown, day]);
  const who = useMemo(() => peopleOn(events, messaged), [events, messaged]);
  const nameOf = (id: number) => people[id] ?? `Person ${id}`;

  // The row stepped to, by its place in the list; none at first.
  const [cursor, setCursor] = useState<number | null>(null);
  const at = cursor !== null && cursor < items.length ? cursor : null;
  const list = useRef<HTMLOListElement>(null);
  const bring = (index: number) => {
    setCursor(index);
    const el = list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const step = (by: number) => {
    const next = stepMoment(at, by, items.length);
    if (next !== null) bring(next);
  };
  const onListKey = (event: ReactKeyboardEvent<HTMLOListElement>) => {
    if ((event.key === "Home" || event.key === "End") && items.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      bring(event.key === "Home" ? 0 : items.length - 1);
    }
  };
  useEffect(() => {
    stepRef.current = step;
    return () => {
      stepRef.current = null;
    };
  });

  const timed = items.filter((item) => !item.event.allDay).length;
  const tabbable = at ?? 0;
  return (
    <div className="cal-dayv">
      <div className="cal-dayv__body">
        <section className="cal-dayv__main" aria-label="The day, event by event" aria-busy={loading}>
          <div className="cal-dayv__steps">
            <span className="cal-zone" title={`${zonePlace()}'s clock`}>{zoneText(from)}</span>
            <span className="cal-dayv__where">
              {loading
                ? "loading…"
                : items.length === 0
                  ? isFuture ? "" : "Nothing at a time"
                  : at === null
                    ? `${countText(timed)} at a time${items.length > timed ? ` · ${countText(items.length - timed)} with no time` : ""} · ↑ ↓ to step through`
                    : `${at + 1} of ${countText(items.length)} · ${items[at].event.allDay ? "No time" : timeText(items[at].event.at)}`}
            </span>
            <span className="cal-dayv__step-buttons">
              {adds.map((spec) => (
                <button key={spec.kind} type="button" className="cal-dayv__add" title={`${addTitle(spec)} on this day: it goes in the record of edits, and Undo takes it away again`} onClick={() => onAdd(spec)}>
                  <span aria-hidden="true">+</span> {spec.noun[0][0].toUpperCase() + spec.noun[0].slice(1)}
                </button>
              ))}
              <button type="button" aria-label="The moment before" title="The moment before (↑)" disabled={items.length === 0 || at === 0} onClick={() => step(-1)}>
                <Icon name="prev" className="cal-icon--up" />
              </button>
              <button type="button" aria-label="The moment after" title="The moment after (↓)" disabled={items.length === 0 || at === items.length - 1} onClick={() => step(1)}>
                <Icon name="next" className="cal-icon--down" />
              </button>
            </span>
          </div>
          <DayList
            items={loading ? [] : items}
            now={isToday ? now : null}
            label="The day's events"
            empty={loading || isFuture ? null : noMomentsText(kinds, person === null ? null : nameOf(person))}
            listRef={list}
            onKeyDown={onListKey}
            row={(item, index) => (
              <Moment item={item} index={index} on={index === at} lit={openKey === item.event.key} tabbable={index === tabbable} onFocus={setCursor} onOpen={onOpen} />
            )}
          />
        </section>
        <DayPeople
          day={day}
          loading={loading}
          isFuture={isFuture}
          who={who}
          names={people}
          hidden={hidden}
          showHidden={showHidden}
          person={person}
          onShowHidden={onShowHidden}
          onPerson={onPerson}
          onFriendMap={onFriendMap}
        />
      </div>
    </div>
  );
}

/** A row's card: its kind's icon, its title and how long it took, when it ran and what came of it (its title names who was in it). */
function Moment({
  item, index, on, lit, tabbable, onFocus, onOpen,
}: {
  item: DayItem;
  index: number;
  on: boolean;
  lit: boolean;
  tabbable: boolean;
  onFocus: (index: number) => void;
  onOpen: (event: CalendarEvent) => void;
}) {
  const { event, before } = item;
  const when = event.allDay ? null : `${before ? "From the day before · " : ""}${rangeText(event.at, event.until)}`;
  const meta = [when, event.detail].filter(Boolean).join(" · ");
  const words = [event.title, meta].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className={`cal-moment cal-card--${event.kind}${on ? " is-on" : ""}${lit ? " is-lit" : ""}`}
      data-index={index}
      data-key={event.key}
      tabIndex={tabbable ? 0 : -1}
      aria-label={words}
      title={words}
      style={{ "--card-hours": cardHours(event) } as CSSProperties}
      onFocus={() => onFocus(index)}
      onClick={() => onOpen(event)}
    >
      <span className="cal-moment__head">
        <Icon name={wordsOf(event.kind).icon} />
        <span className="cal-moment__title">{event.title}</span>
        {event.length > 0 && <span className="cal-moment__len">{lengthText(event.length)}</span>}
      </span>
      {meta && <span className="cal-moment__meta">{meta}</span>}
    </button>
  );
}
