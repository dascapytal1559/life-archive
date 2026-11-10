// The day's People, beside the day event by event (DayView.tsx): everyone on the day, the most messages first, each
// with the apps they were messaged on and how many messages and moments, then the day's group chats; the captain's
// choice for reading a day's messages ("actually you know what i would like A"): nothing is read as the day opens, a
// click on someone lists that day's chat with them under their name, a plain list (ChatLines.tsx), and a click on
// another takes its place; a group chat opens the same way. Each chat opened is read then, a page at a time, and kept
// in the trail of content reads (the module's day routes, modules/friend-map/server/dayChats.ts); the day's chats by
// count are metadata, read as the day opens. Nothing of it is kept in the address, so a day opened again reads nothing
// until asked. An open person's chat has "Only <name>", which narrows the day to them (a click on someone did that
// before), and "Friend Map", which opens their panel there. People friend map hides (archived, or with a tag its Hide
// starts on) are left out, and a switch over the list shows them. On a phone the people are a strip, and the chat opens
// under it. Under the list one line says what the day's counts hold.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TimelineMessage } from "../../../src/archive.ts";
import { fetchDayChat, fetchDayChats } from "../../api.ts";
import { ChatLines } from "../../ChatLines.tsx";
import type { DayChat, DayChatsAnswer } from "../../wire.ts";
import { Icon } from "../icons.tsx";
import { counted, onDayText, rangeText, type OnDay } from "./calendar.ts";
import { Face } from "./faces.tsx";
import { useNarrow } from "./narrow.ts";
import "./dayPeople.css";

/** What the day's counts hold, in one line: the Events calendar's days begin at 06:00, and every message counts. */
export const COUNT_LINE =
  "Counted 06:00 to 06:00. Messages counts every message of the day, groups too; a person's count is their one-to-one chats and what they wrote anywhere else.";

/** The chat open: someone's day, or a group chat's. */
export type Opened = { person: number } | { chat: number };

/** "Messenger", "Messenger, WhatsApp": the apps of someone's one-to-one chats on the day, the most messages first. */
export function appsOf(chats: readonly DayChat[], person: number): string {
  return [...new Set(chats.filter((chat) => chat.type === "direct" && chat.people[0] === person).map((chat) => chat.app))].join(", ");
}

/** A group chat's name: its title, else the first three who wrote that day, else "Group chat". */
export function groupName(chat: DayChat, names: Record<number, string>): string {
  if (chat.title) return chat.title;
  const by = chat.people.slice(0, 3).map((id) => (names[id] ?? `Person ${id}`).split(/\s+/)[0]);
  return by.length === 0 ? "Group chat" : `${by.join(", ")}${chat.people.length > 3 ? " and others" : ""}`;
}

/** Everyone on the day shown: all of them while the switch shows the hidden, else those not hidden. */
export function shownPeople(who: readonly OnDay[], hidden: ReadonlySet<number>, showHidden: boolean): OnDay[] {
  return showHidden ? [...who] : who.filter((on) => !hidden.has(on.id));
}

export function DayPeople({
  day, loading, isFuture, who, names, hidden, showHidden, person, onShowHidden, onPerson, onFriendMap,
}: {
  day: string;
  loading: boolean;
  isFuture: boolean;
  /** Everyone on the day, the most messages first (calendar.ts's peopleOn). */
  who: readonly OnDay[];
  names: Record<number, string>;
  /** Who friend map hides, of everyone on the day. */
  hidden: ReadonlySet<number>;
  showHidden: boolean;
  /** The person the day is narrowed to, if any. */
  person: number | null;
  onShowHidden: (show: boolean) => void;
  onPerson: (person: number | null) => void;
  /** Opens someone's panel in Friend Map. */
  onFriendMap: (person: number) => void;
}) {
  const narrow = useNarrow();
  const [chats, setChats] = useState<DayChatsAnswer | null>(null);
  useEffect(() => {
    if (isFuture) return;
    const abort = new AbortController();
    fetchDayChats(day, abort.signal).then(setChats, () => undefined);
    return () => abort.abort();
  }, [day, isFuture]);
  const [opened, setOpened] = useState<Opened | null>(null);
  const isOpen = (of: Opened) => opened !== null && ("person" in of ? "person" in opened && opened.person === of.person : "chat" in opened && opened.chat === of.chat);
  const toggle = (of: Opened) => setOpened(isOpen(of) ? null : of);

  const shown = shownPeople(who, hidden, showHidden);
  const hiddenCount = who.length - shownPeople(who, hidden, false).length;
  const groups = (chats?.chats ?? []).filter((chat) => chat.type === "group");
  const allNames = { ...chats?.people, ...names };
  const nameOf = (id: number) => allNames[id] ?? `Person ${id}`;
  const firstName = (id: number) => nameOf(id).split(/\s+/)[0];

  /** The chat open, drawn under its row on a desk, or under the strip on a phone. */
  const chatOf = (of: Opened): ReactNode => {
    if ("person" in of) {
      const on = who.find((w) => w.id === of.person);
      return (
        <OpenChat key={`p${of.person}`} day={day} of={of} count={on?.messages ?? 0} title={nameOf(of.person)} sub={appsOf(chats?.chats ?? [], of.person)} phone={narrow} onClose={() => setOpened(null)}>
          <button type="button" className={`cal-chat__act${person === of.person ? " is-on" : ""}`} aria-pressed={person === of.person} onClick={() => onPerson(person === of.person ? null : of.person)}>
            Only {firstName(of.person)}
          </button>
          <button type="button" className="cal-chat__act" title={`Open ${nameOf(of.person)}'s panel in Friend Map`} onClick={() => onFriendMap(of.person)}>
            Friend Map <Icon name="out" />
          </button>
        </OpenChat>
      );
    }
    const chat = groups.find((g) => g.id === of.chat);
    if (!chat) return null;
    return <OpenChat key={`c${of.chat}`} day={day} of={of} count={chat.messages} title={groupName(chat, allNames)} sub={chat.app} phone={narrow} onClose={() => setOpened(null)} />;
  };

  const personRow = (on: OnDay) => {
    const apps = appsOf(chats?.chats ?? [], on.id);
    const note = [apps, onDayText(on, "moment")].filter(Boolean).join(" · ");
    const of = { person: on.id };
    const open = isOpen(of);
    return (
      <div key={on.id} className={`cal-chat${open ? " is-open" : ""}`}>
        <button type="button" className={`cal-person${person === on.id ? " is-on" : ""}${hidden.has(on.id) ? " is-hidden" : ""}`} aria-expanded={open} onClick={() => toggle(of)} title={`${nameOf(on.id)} · ${note}`}>
          <Face id={on.id} name={nameOf(on.id)} />
          <span className="cal-person__words">
            <span className="cal-person__name">{nameOf(on.id)}</span>
            <span className="cal-person__note">{note}</span>
          </span>
          <Icon name="chevron" className="cal-person__chev" />
        </button>
        {open && !narrow && chatOf(of)}
      </div>
    );
  };
  const groupRow = (chat: DayChat) => {
    const of = { chat: chat.id };
    const open = isOpen(of);
    const note = [chat.app, chat.people.length > 0 ? `${counted(chat.people.length, "person", "people")} wrote` : "", counted(chat.messages, "message", "messages")].filter(Boolean).join(" · ");
    const name = groupName(chat, allNames);
    return (
      <div key={chat.id} className={`cal-chat${open ? " is-open" : ""}`}>
        <button type="button" className="cal-person" aria-expanded={open} onClick={() => toggle(of)} title={`${name} · ${note}`}>
          <i className="cal-face cal-face--group" aria-hidden="true">
            <Icon name="group" />
          </i>
          <span className="cal-person__words">
            <span className="cal-person__name">{name}</span>
            <span className="cal-person__note">{note}</span>
          </span>
          <Icon name="chevron" className="cal-person__chev" />
        </button>
        {open && !narrow && chatOf(of)}
      </div>
    );
  };

  return (
    <aside className="cal-dayv__people" aria-label="Everyone on the day">
      <h3>
        People <span className="cal-group__count">{loading ? "" : shown.length}</span>
        {!loading && (hiddenCount > 0 || showHidden) && (
          <button
            type="button"
            className="cal-hidden-switch"
            aria-pressed={showHidden}
            title={showHidden ? "Leave out the people Friend Map hides (archived, or tagged to hide)" : "Show the people Friend Map hides (archived, or tagged to hide)"}
            onClick={() => onShowHidden(!showHidden)}
          >
            {showHidden ? `${hiddenCount} hidden shown` : `${hiddenCount} hidden`}
          </button>
        )}
      </h3>
      {isFuture && shown.length === 0 ? null : !loading && shown.length === 0 ? (
        <div className="cal-group__none">Nobody on this day{hiddenCount > 0 && !showHidden ? " but the hidden" : ""}.</div>
      ) : (
        <div className="cal-dayv__people-list">{shown.map(personRow)}</div>
      )}
      {narrow && opened !== null && "person" in opened && chatOf(opened)}
      {groups.length > 0 && !loading && (
        <>
          <h3 className="cal-people__sub">
            Group chats <span className="cal-group__count">{groups.length}</span>
          </h3>
          <div className="cal-dayv__people-list">{groups.map(groupRow)}</div>
          {narrow && opened !== null && "chat" in opened && chatOf(opened)}
        </>
      )}
      {!isFuture && !loading && <p className="cal-count-line">{COUNT_LINE}</p>}
    </aside>
  );
}

/**
 * A chat opened on the day: its messages that day as a plain list, the first page read as it opens (once, even as
 * React's StrictMode mounts it twice, so one click is one read in the trail), later ones when "Later messages" is
 * pressed; none read for someone with no messages that day. On a phone it has a head of its own (who, the app, when,
 * and ✕), since its row is up in the strip.
 */
function OpenChat({ day, of, count, title, sub, phone, onClose, children }: {
  day: string;
  of: Opened;
  count: number;
  title: string;
  sub: string;
  phone: boolean;
  onClose: () => void;
  /** What the chat's head offers beside it (an open person's Only and Friend Map). */
  children?: ReactNode;
}) {
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [busy, setBusy] = useState(count > 0);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const live = useRef(true);
  const read = (from: string | null) => {
    setBusy(true);
    setError(null);
    fetchDayChat(day, of, from).then(
      (page) => {
        if (!live.current) return;
        setMessages((was) => [...was, ...page.messages]);
        setAfter(page.after);
        setBusy(false);
      },
      (e: Error) => {
        if (!live.current) return;
        setError(e.message);
        setBusy(false);
      },
    );
  };
  useEffect(() => {
    live.current = true;
    if (!started.current && count > 0) {
      started.current = true;
      read(null);
    }
    return () => void (live.current = false);
  }, []);
  const span = messages.length > 0 ? rangeText(messages[0].sentAt, messages.at(-1)!.sentAt) : "";
  return (
    <div className={`cal-chat__open${phone ? " cal-strip-chat" : ""}`}>
      {phone && (
        <div className="cal-strip-chat__head">
          <strong>{title}</strong>
          <span>{[sub, span].filter(Boolean).join(" · ")}</span>
          <button type="button" className="cal-strip-chat__close" aria-label="Close the chat" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {children && <div className="cal-chat__acts">{children}</div>}
      {error && <p className="viewer__error">{error}</p>}
      {count === 0 ? (
        <p className="cal-chat__none">No messages this day.</p>
      ) : (
        <ChatLines messages={messages} chat={"chat" in of ? of.chat : null} label={`${title}'s messages this day`} />
      )}
      {busy && <p className="cal-chat__none">Reading…</p>}
      {!busy && after && (
        <button type="button" className="cal-chat__more" onClick={() => read(after)}>
          Later messages
        </button>
      )}
    </div>
  );
}
