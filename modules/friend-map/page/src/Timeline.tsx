// A person's messages across platforms, or one group chat's, laid out as a
// messaging app does: oldest at the top, newest at the bottom, under a heading
// per local day.
// This is the page's only view of message text and attachment files (the
// archive's content path): photos and GIFs as thumbnails that open larger,
// videos and voice messages as players, other files as links. Each loads only
// when it is scrolled near or played. What they said in group chats is shown
// only with `groups`, and Marketplace chats only when you ask for them;
// the name of the group each was said in opens that group (`onOpenGroup`). A
// group chat's own messages name every sender and leave out the platform, since
// a group is on one.
// With `fold`, the chat sits under a "Messages · 120" heading that opens and
// closes it (the person panel's, closed to start): nothing is asked of the
// archive until it is first opened, and closing it again keeps what has loaded.
// Its controls (`fold.tools`, the panel's "Show group messages", and "Load
// all") sit inside it, on a line above the chat, shown only while it is open.
// Messages come a page at a time, newest first: the first page as soon as the
// chat opens, and each older one as the reader scrolls near the top; "Load all"
// fetches the rest of the history in big pages. When new messages come in (a
// live chat), they are added at the bottom, and everything loaded stays.
// Opened at a moment instead (`moment`, a chip in the Table's Who), the chat loads a page
// on each side of it and scrolls to what it marks there (the call or the
// hangout), outlined; newer pages then come as the reader scrolls near the
// bottom, as older ones do at the top, and new messages wait until the chat has
// paged down to its newest.
//
// The chat scrolls in its own box, at the end of the person panel, so that it
// can open at its bottom while the panel opens at the person's name. The box is
// a reversed flex column, so the browser measures its scroll from the bottom:
// it starts at the newest message with no jump, and an older page arriving, or
// a player above growing as it loads, leaves the message in view where it is.
//
// A person's calls in no chat (the phone's call history, and an app's call
// with several people, `calls`) sit among the messages at their time, "Call ·
// 3 h 12 min" or "Missed call", an app's with the app and how many others were
// on it ("WhatsApp · with 2 others"): all of them once the whole
// history has loaded, else those since the oldest message loaded. The calls
// you logged sit there too, and so do your hangouts (`catchUps`), at their
// time or the start of their day; both open to be changed in place, and each
// day's heading offers "+ event" on that day (CatchUps.tsx). An account's own
// chat and a group chat's have no hangouts.
//
// Only the days in and near the view are drawn (`Days`), each of the rest
// standing in at its measured height, or a guess until it has been drawn, so
// tens of thousands of messages scroll as smoothly as fifty. A wrong guess above
// the view moves nothing, since the box is anchored at its bottom; one below it
// is made up for by scrolling by the difference once the day is measured.

import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { AttachmentInfo, CallAnswer, CatchUp, GroupPerson, PersonCall, TimelineMessage, TimelinePage } from "./archive.ts";
import { archiveApi } from "./archiveApi.ts";
import { reportError } from "./errors.ts";
import { useNames } from "./names.ts";
import { Name, platformName } from "./PersonParts.tsx";
import { callRecords, type CallRecordState } from "./callRecords.ts";
import { CALL_LENGTH_MOST_MINUTES, callLabel, callPlatformName, messageCallLabel } from "./calls.ts";
import { catchUpWhen } from "./catchUps.ts";
import { CallNoteLine, ChatCatchUp, ChatLoggedCall, NewChatEvent } from "./CatchUps.tsx";
import { saveCallAnswered, saveCallLength } from "./changeChip.ts";
import { offers } from "./contract/handshake.ts";
import { useReadOnly } from "./readOnly.ts";
import {
  aimAt, chatDays, type ChatMoment, dayWindow, loadingAllLabel, momentCursor, sameDay, withEvents, withNewest, type CallEntry, type CatchUpEntry,
} from "./chatDays.ts";
import { dayKey, zonedFormat } from "./time.ts";

const PAGE = 50;
/** A page while loading everything: the server's largest. */
const BULK_PAGE = 5000;
/** How far above and below the view days are drawn, in pixels, so a quick scroll finds them ready. */
const DRAWN_MARGIN = 1500;
/** Guesses at a day's height until it is drawn: its heading, and each message. */
const DAY_HEADING = 42;
const MESSAGE_HEIGHT = 60;
const timeFormat = zonedFormat({ hour: "numeric", minute: "2-digit" });
const dayFormat = zonedFormat({ weekday: "short", day: "numeric", month: "short", year: "numeric" });

/**
 * Whose messages the chat shows: a person's (their one-to-one chats, and with
 * `groups` what they said in group chats), with `account` only that account's
 * of theirs, or one group chat's.
 */
export type ChatSource = { person: number; groups: boolean; account?: number } | { group: number };

/**
 * How a message is drawn: in a group chat's own chat (every sender named, no platform), or in a person's, where a
 * group's name can open it, and catch-ups are with `catchUpWith`. The Calendar's day draws each chat as a group chat's own.
 */
export const ChatContext = createContext<{ inGroup: boolean; openGroup?: (id: number) => void; catchUpWith?: GroupPerson }>({ inGroup: false });

/** The chat with its section title, "Load all" sitting on the title's line (inside the fold, with one), and `children` between the title and the chat. */
export function Timeline({ title, source, moment, calls = [], catchUps, marketplaceCount = 0, version, onOpenGroup, fold, children }: {
  title: ReactNode;
  source: ChatSource;
  /** Where it opens, and what it marks there, in place of its newest message. Fixed for the chat's life: a new one is a new chat (its key). */
  moment?: ChatMoment;
  /** Their calls, newest first, to show among the messages at their time. */
  calls?: readonly PersonCall[];
  /** The person's catch-ups, newest first, to show at the start of their days and change there, and the person (who "+ event" is with, and logged calls). */
  catchUps?: { list: readonly CatchUp[]; person: GroupPerson };
  marketplaceCount?: number;
  /** Changes when its messages do (their counts and last message): what came in since is added. */
  version: string;
  /** Opens a group chat, from its name on a message said there. */
  onOpenGroup?: (id: number) => void;
  /** The chat under a heading (`label`) that opens and closes it, open as `open` says: loaded once first opened; `tools` sit beside "Load all" inside it. */
  fold?: { label: ReactNode; open: boolean; onChange: (open: boolean) => void; tools?: ReactNode };
  children?: ReactNode;
}) {
  const shut = fold !== undefined && !fold.open;
  // Nothing loads until the chat is first opened; then it stays loaded, open or closed.
  const [started, setStarted] = useState(!shut);
  if (!shut && !started) setStarted(true);
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  /** Where the next newer page starts, while the chat (opened at a moment) does not yet reach its newest message. */
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [marketplace, setMarketplace] = useState(false);
  /** While "Load all" runs: how many messages have loaded, of how many (once the first page says). */
  const [loadingAll, setLoadingAll] = useState<{ loaded: number; total: number | null } | null>(null);
  /** Bumped to abandon what is loading: when "Load all" is stopped, or the switches change what is shown. */
  const generation = useRef(0);
  /** Set while an older page or "Load all" is loading, at once, so a scroll and a click can't both start one. */
  const busy = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  /** Where the reader is, kept as a newer page is added below (Days). */
  const hold = useRef<ViewHold | null>(null);
  /** Bumped to load the chat afresh (new messages in a chat that showed none). */
  const [fresh, loadFresh] = useReducer((n: number) => n + 1, 0);
  const inGroup = "group" in source;
  // What is shown: changing it starts the chat afresh.
  const sourceKey = "group" in source ? `group:${source.group}` : `person:${source.person}:${source.groups}:${source.account ?? "all"}`;
  const fetchPage = (page: { before?: string; after?: string; limit: number; count?: boolean }): Promise<TimelinePage> =>
    "group" in source
      ? archiveApi.conversation(source.group, page)
      : archiveApi.timeline(source.person, { ...page, groups: source.groups, account: source.account, marketplace });

  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    generation.current++;
    busy.current = false;
    setLoadingAll(null);
    setLoading(true);
    // At a moment: a page on each side of it, the newer page's messages above the older's, as the chat runs newest first.
    const pages = moment
      ? Promise.all([fetchPage({ limit: PAGE, after: momentCursor(moment) }), fetchPage({ limit: PAGE, before: momentCursor(moment) })])
        .then(([after, before]) => ({ messages: [...after.messages, ...before.messages], nextBefore: before.nextBefore, nextAfter: after.nextAfter ?? null }))
      : fetchPage({ limit: PAGE }).then((page) => ({ ...page, nextAfter: null }));
    pages.then(
      (page) => {
        if (cancelled) return;
        hold.current = null;
        setMessages(page.messages);
        setNextBefore(page.nextBefore);
        setNextAfter(page.nextAfter);
        setLoading(false);
        // Back to the newest message when the groups or Marketplace choice changes what is shown (at a moment, Days
        // scrolls to it). Any value past the end lands on the bottom, however the browser counts a reversed box's scroll.
        if (scroller.current && !moment) scroller.current.scrollTop = scroller.current.scrollHeight;
      },
      (error) => !cancelled && (setLoading(false), reportError(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [sourceKey, marketplace, fresh, started]);

  // New messages: pages from the newest back to the newest one shown, folded in (withNewest).
  const shown = useRef({ messages, filter: "", nextAfter });
  shown.current = { messages, filter: `${sourceKey}:${marketplace}`, nextAfter };
  const seenVersion = useRef(version);
  useEffect(() => {
    if (seenVersion.current === version) return;
    seenVersion.current = version;
    // Not loaded yet: the first page, once opened, is the newest.
    if (!started) return;
    const { messages: before, filter, nextAfter: below } = shown.current;
    // Short of the newest (opened at a moment), what came in arrives with the newer pages.
    if (below !== null) return;
    if (before.length === 0) {
      loadFresh();
      return;
    }
    const known = new Set(before.map((m) => m.id));
    let cancelled = false;
    void (async () => {
      const newest: TimelineMessage[] = [];
      let from: string | undefined;
      for (;;) {
        const page = await fetchPage({ limit: from ? BULK_PAGE : PAGE, before: from });
        if (cancelled) return;
        newest.push(...page.messages);
        if (!page.nextBefore || page.messages.some((m) => known.has(m.id))) break;
        from = page.nextBefore;
      }
      // Unless the switches have changed what is shown meanwhile.
      if (shown.current.filter === filter) setMessages((messages) => withNewest(messages, newest));
    })().catch((error) => !cancelled && reportError(error));
    return () => {
      cancelled = true;
    };
  }, [version]);

  const loadOlder = async () => {
    if (!nextBefore || loading || busy.current) return;
    busy.current = true;
    const run = generation.current;
    setLoading(true);
    try {
      const page = await fetchPage({ limit: PAGE, before: nextBefore });
      if (generation.current !== run) return;
      setMessages((shown) => [...shown, ...page.messages]);
      setNextBefore(page.nextBefore);
    } catch (error) {
      if (generation.current === run) reportError(error);
    } finally {
      if (generation.current === run) {
        busy.current = false;
        setLoading(false);
      }
    }
  };

  const loadNewer = async () => {
    if (!nextAfter || loading || busy.current) return;
    busy.current = true;
    const run = generation.current;
    setLoading(true);
    try {
      const page = await fetchPage({ limit: PAGE, after: nextAfter });
      if (generation.current !== run) return;
      if (scroller.current && messages.length > 0) hold.current = viewHold(scroller.current, dayKey(messages[0].sentAt));
      setMessages((shown) => withNewest(shown, page.messages));
      setNextAfter(page.nextAfter ?? null);
    } catch (error) {
      if (generation.current === run) reportError(error);
    } finally {
      if (generation.current === run) {
        busy.current = false;
        setLoading(false);
      }
    }
  };

  const loadAll = async () => {
    if (!nextBefore || loading || busy.current) return;
    busy.current = true;
    const run = ++generation.current;
    const fetchBulk = (before: string, count: boolean) => {
      const request = fetchPage({ limit: BULK_PAGE, before, count });
      request.catch(() => {}); // A page fetched ahead and then abandoned by Stop fails quietly.
      return request;
    };
    let loaded = messages.length;
    let total: number | null = null;
    setLoading(true);
    setLoadingAll({ loaded, total });
    try {
      let request = fetchBulk(nextBefore, true);
      for (;;) {
        const page = await request;
        if (generation.current !== run) return;
        // Fetch the next page while this one is drawn.
        if (page.nextBefore) request = fetchBulk(page.nextBefore, false);
        total ??= page.total ?? null;
        loaded += page.messages.length;
        setMessages((shown) => [...shown, ...page.messages]);
        setNextBefore(page.nextBefore);
        setLoadingAll({ loaded, total });
        if (!page.nextBefore) break;
      }
    } catch (error) {
      if (generation.current === run) reportError(error);
    } finally {
      if (generation.current === run) {
        busy.current = false;
        setLoading(false);
        setLoadingAll(null);
      }
    }
  };
  const stopLoadingAll = () => {
    generation.current++;
    busy.current = false;
    setLoading(false);
    setLoadingAll(null);
  };

  // The next page loads by itself once "Older messages" at the top (or "Newer messages" at the bottom) scrolls near; the button stays for a click.
  const more = useRef<HTMLButtonElement>(null);
  const newer = useRef<HTMLButtonElement>(null);
  const loaders = useRef({ loadOlder, loadNewer });
  loaders.current = { loadOlder, loadNewer };
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) void (entry.target === newer.current ? loaders.current.loadNewer() : loaders.current.loadOlder());
      }
    }, { root: scroller.current, rootMargin: "600px 0px" });
    for (const button of [more.current, newer.current]) if (button) observer.observe(button);
    return () => observer.disconnect();
  }, [nextBefore, nextAfter, loadingAll === null, shut]);

  const marketplaceSwitch = marketplaceCount > 0 && (
    <label className="timeline__marketplace muted">
      <input type="checkbox" checked={marketplace} onChange={(e) => setMarketplace(e.target.checked)} />
      Show {marketplaceCount} Marketplace {marketplaceCount === 1 ? "message" : "messages"}
    </label>
  );
  const actions = loadingAll ? (
    <div className="timeline__loading-all" role="status">
      {loadingAllLabel(loadingAll.loaded, loadingAll.total)}
      <button type="button" className="link-button timeline__load-all" onClick={stopLoadingAll}>Stop</button>
    </div>
  ) : nextBefore && messages.length > 0 && (
    <button type="button" className="link-button timeline__load-all" disabled={loading} onClick={() => void loadAll()}>
      Load all
    </button>
  );
  const header = (
    <>
      <div className="timeline__header">
        <h3>{title}</h3>
        {!fold && actions}
      </div>
      {children && <div className="timeline__intro">{children}</div>}
      {fold && (
        <button type="button" className="field__toggle timeline__toggle" aria-expanded={fold.open} onClick={() => fold.onChange(!fold.open)}>
          <span aria-hidden="true">{fold.open ? "▾" : "▸"}</span> {fold.label}
        </button>
      )}
    </>
  );
  // Calls and catch-ups among the messages, once the first page has said how far back they reach.
  const catchUpList = catchUps?.list ?? NO_CATCH_UPS;
  const entries = useMemo(
    () => (loading && messages.length === 0 ? messages : withEvents(messages, calls, catchUpList, nextBefore === null, nextAfter === null)),
    [messages, calls, catchUpList, nextBefore, nextAfter, loading],
  );
  // The same value while nothing in it changes, so the days and messages that read it are not drawn again for nothing.
  const catchUpWith = catchUps?.person;
  const chat = useMemo(() => ({ inGroup, openGroup: onOpenGroup, catchUpWith }), [inGroup, onOpenGroup, catchUpWith]);
  // The header stays where it is in every case, so opening or closing the chat, or its loading, never draws it (and
  // what `children` holds, such as the activity chart) anew; so does the fold's line of controls while the chat loads.
  const tools = fold && (fold.tools || actions) && (
    <div className="timeline__tools">
      {fold.tools}
      {actions}
    </div>
  );
  return (
    <>
      {header}
      {!shut && tools}
      {shut ? null : entries.length === 0 ? (
        <>
          {loading ? <p className="muted">Loading messages…</p> : marketplaceSwitch}
          {!loading && ("group" in source ? <p className="muted">No messages here.</p> : !source.groups && <p className="muted">No one-to-one messages.</p>)}
        </>
      ) : (
        <>
          {marketplaceSwitch}
          <div ref={scroller} className="timeline__scroller">
            <div className="timeline">
              {nextBefore && !loadingAll && (
                <div className="timeline__more-row">
                  <button ref={more} type="button" className="timeline__more" disabled={loading} onClick={() => void loadOlder()}>
                    {loading ? "Loading…" : "Older messages"}
                  </button>
                </div>
              )}
              {/* A fresh start, measurements and all, when the switches change which messages are shown. */}
              <ChatContext.Provider value={chat}>
                <Days key={`${sourceKey}:${marketplace}`} entries={entries} scroller={scroller} moment={moment} hold={hold} />
              </ChatContext.Provider>
              {nextAfter && (
                <div className="timeline__more-row">
                  <button ref={newer} type="button" className="timeline__more" disabled={loading} onClick={() => void loadNewer()}>
                    {loading ? "Loading…" : "Newer messages"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

const NO_CATCH_UPS: readonly CatchUp[] = [];

type ChatEntry = TimelineMessage | CallEntry | CatchUpEntry;
type ChatDay = { day: string; messages: ChatEntry[] };

/**
 * The days in and near the view, between blank spaces as tall as the days left out. Opened at a moment, it scrolls to
 * what the moment marks (aimAt), drawing the days around it first, and outlines it; until that has loaded, to the
 * first entry at or after the moment. A newer page added below (`hold`) leaves the reader where they were.
 */
function Days({ entries, scroller, moment, hold }: {
  entries: ChatEntry[];
  scroller: RefObject<HTMLDivElement | null>;
  moment?: ChatMoment;
  hold: RefObject<ViewHold | null>;
}) {
  const days = useMemo(() => chatDays(entries), [entries]);
  /** Each day's height as last laid out: measured once drawn, guessed until then (and the guess kept, so it can't move anything). */
  const heights = useRef(new Map<string, number>());
  const [view, setView] = useState({ scrolledUp: 0, height: 0 });
  const [, measured] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    let frame = 0;
    // Any way a browser counts a reversed box's scroll, its size is the distance from the bottom.
    const look = () => ((frame = 0), setView({ scrolledUp: Math.abs(box.scrollTop), height: box.clientHeight }));
    const onScroll = () => (frame ||= requestAnimationFrame(look));
    look();
    box.addEventListener("scroll", onScroll, { passive: true });
    const resized = new ResizeObserver(onScroll);
    resized.observe(box);
    return () => {
      box.removeEventListener("scroll", onScroll);
      resized.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scroller]);

  const observer = useMemo(() => new ResizeObserver((entries) => {
    const box = scroller.current;
    let below = 0;
    let changed = false;
    for (const entry of entries) {
      const section = entry.target as HTMLElement;
      const day = section.dataset.day!;
      const height = section.offsetHeight;
      if (height === 0 || height === heights.current.get(day)) continue;
      // A day below the view pushes what is in view up as it grows: scroll up with it.
      if (box && section.getBoundingClientRect().top >= box.getBoundingClientRect().bottom) below += height - (heights.current.get(day) ?? height);
      heights.current.set(day, height);
      changed = true;
    }
    if (box && below) box.scrollTop -= below;
    if (changed) measured();
  }), [scroller]);
  useEffect(() => () => observer.disconnect(), [observer]);

  const newestFirst = days.map((_, i) => {
    const day = days[days.length - 1 - i];
    let height = heights.current.get(day.day);
    if (height === undefined) heights.current.set(day.day, (height = DAY_HEADING + day.messages.length * MESSAGE_HEIGHT));
    return height;
  });
  // Opened at a moment: what to scroll to, until the entry it marks has been scrolled to once.
  const aimed = useRef<"none" | "near" | "marked">("none");
  const aim = moment && aimed.current !== "marked" ? aimAt(entries, moment) : null;
  const target = aim && (aim.marked || aimed.current === "none") ? aim : null;
  const markedId = useRef<number | undefined>(undefined);
  const marked = aim?.marked ? aim.entry.id : aimed.current === "marked" ? markedId.current : undefined;
  /** How far up from the bottom the days newer than `day` reach (null when there is no such day). */
  const newerThan = (day: string) => {
    const i = days.findIndex((d) => d.day === day);
    return i < 0 ? null : newestFirst.slice(0, days.length - 1 - i).reduce((sum, h) => sum + h, 0);
  };
  const viewHeight = view.height || 1000;
  // Where the view is about to be, so the right days are drawn: at the target's day, or where it was above what a newer page added.
  const held = hold.current;
  const targetDay = target && dayKey(target.entry.sentAt);
  const scrolledUp = targetDay
    ? Math.max(0, (newerThan(targetDay) ?? 0) + (heights.current.get(targetDay) ?? 0) / 2 - viewHeight / 2)
    : held ? view.scrolledUp + (newerThan(held.newestDay) ?? 0) : view.scrolledUp;

  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const look = () => setView({ scrolledUp: Math.abs(box.scrollTop), height: box.clientHeight });
    if (target) {
      const element = target.marked ? box.querySelector(".timeline__mark")?.firstElementChild : box.querySelector(`[data-day="${targetDay}"]`);
      if (!element) return;
      element.scrollIntoView({ block: "center" });
      aimed.current = target.marked ? "marked" : "near";
      if (target.marked) markedId.current = target.entry.id;
      hold.current = null;
      look();
    } else if (held) {
      hold.current = null;
      const section = box.querySelector<HTMLElement>(`[data-day="${held.day}"]`);
      if (!section) return;
      box.scrollTop += section.getBoundingClientRect().top - box.getBoundingClientRect().top - held.top;
      look();
    }
  });

  // Until the box has been measured, draw the newest days, as much as a tall screen shows.
  const { newest, oldest, newer, older } = dayWindow(newestFirst, scrolledUp, viewHeight, DRAWN_MARGIN);
  const drawn = newest < 0 ? [] : days.slice(days.length - 1 - oldest, days.length - newest);
  return (
    <>
      {older > 0 && <div style={{ height: older }} />}
      {drawn.map((day) => (
        <Day key={day.day} day={day} observer={observer} marked={marked !== undefined && day.messages.some((e) => e.id === marked) ? marked : undefined} />
      ))}
      {newer > 0 && <div style={{ height: newer }} />}
    </>
  );
}

/** One day's messages, calls and catch-ups; drawn again only when one of them changes or an older page adds to it. */
const Day = memo(function Day({ day, observer, marked }: { day: ChatDay; observer: ResizeObserver; marked?: number }) {
  const section = useRef<HTMLElement>(null);
  const { catchUpWith } = useContext(ChatContext);
  useEffect(() => {
    const element = section.current!;
    observer.observe(element);
    return () => observer.unobserve(element);
  }, [observer]);
  return (
    <section ref={section} className="timeline__day" data-day={day.day}>
      <h4>{dayFormat.format(day.messages[0].sentAt)}</h4>
      {catchUpWith && <NewChatEvent person={catchUpWith} day={day.day} />}
      {day.messages.map((entry) => {
        const drawn = "call" in entry
          ? (entry.call.manual && catchUpWith ? <ChatLoggedCall key={entry.id} call={entry.call} /> : <Call key={entry.id} call={entry.call} />)
          : "catchUp" in entry
            ? <ChatCatchUp key={entry.id} catchUp={entry.catchUp} personId={catchUpWith?.id ?? -1} />
            : <Message key={entry.id} message={entry} />;
        // What the chat was opened at, outlined; the wrapper takes no room of its own, so the bubble lays out as ever.
        return entry.id === marked ? <div key={entry.id} className="timeline__mark">{drawn}</div> : drawn;
      })}
    </section>
  );
}, (before, after) => before.observer === after.observer && before.marked === after.marked && sameDay(before.day, after.day));

/**
 * Where the reader is before a newer page is added below: the topmost day in view, how far its top is from the box's,
 * and the chat's newest day then (`newestDay`), which what is added comes after.
 */
interface ViewHold {
  day: string;
  top: number;
  newestDay: string;
}

function viewHold(box: HTMLElement, newestDay: string): ViewHold | null {
  const boxTop = box.getBoundingClientRect().top;
  const inView = [...box.querySelectorAll<HTMLElement>(".timeline__day")].find((section) => section.getBoundingClientRect().bottom > boxTop);
  return inView ? { day: inView.dataset.day!, top: inView.getBoundingClientRect().top - boxTop, newestDay } : null;
}

export function Message({ message }: { message: TimelineMessage }) {
  const names = useNames();
  const { shown, titled } = names;
  const { inGroup, openGroup } = useContext(ChatContext);
  const { conversation } = message;
  const group = conversation.type === "group" && !conversation.marketplace;
  // A Marketplace chat's title names the seller ("Ada · Bike"), so it goes with names.
  const marketplace = conversation.title ? titled(conversation.title) : "";
  // Where it was said, unless this is that group's own chat.
  const where = inGroup
    ? null
    : conversation.marketplace
      ? `Marketplace${marketplace ? `: ${marketplace}` : ""}`
      : group ? (conversation.title === null ? "a group" : titled(conversation.title)) : null;
  // Your own messages in a one-to-one chat need no name; in a group every sender is named.
  // In a one-to-one chat theirs are named too, unless names are hidden: then it is plainly them.
  const named = inGroup || where !== null;
  const who = message.fromSelf
    ? (named ? "You" : null)
    : message.sender === null || (!named && names.hidden) ? null : shown(message.sender);
  // A call record reads as the phone's calls do ("Call · 12 min"), in place of the words its app wrote for it, with
  // the length, note and answer you gave it on this page since it loaded (callRecords.ts).
  const call = message.type === "call";
  const savedRecord = () => callRecords.get(message.id);
  const saved = useSyncExternalStore(callRecords.subscribe, savedRecord, savedRecord);
  const record: CallRecordState = {
    callSeconds: message.callSeconds, callLengthGiven: message.callLengthGiven, callNote: message.callNote, callAnswer: message.callAnswer ?? null, ...saved,
  };
  const missed = record.callAnswer === "missed" || record.callSeconds === 0;
  return (
    <div className={`message${message.fromSelf ? " message--self" : ""}${message.type === "system" ? " message--system" : ""}${call ? ` message--call${missed ? " message--missed" : ""}` : ""}`}>
      <div className="message__meta">
        {who !== null && <span className="message__who"><Name text={who} /></span>}
        {where !== null && (
          <>
            {" in "}
            {group && openGroup ? (
              <button type="button" className="message__group" title="Open this group chat" onClick={() => openGroup(conversation.id)}><Name text={where} /></button>
            ) : <Name text={where} />}
          </>
        )}
        {who !== null && " · "}
        {timeFormat.format(message.sentAt)}
        {!inGroup && ` · ${platformName(message.platform)}`}
      </div>
      <div className="message__body">
        {message.unsent ? (
          <em className="muted">Message unsent</em>
        ) : call ? (
          <CallRecord message={message} record={record} />
        ) : (
          <>
            {message.text && <p>{message.text}</p>}
            {message.attachments.map((attachment) => <Attachment key={attachment.id} attachment={attachment} />)}
          </>
        )}
      </div>
      {message.reactions.length > 0 && (
        <div className="message__reactions" title={message.reactions.map((r) => (shown(r.actor) ? `${shown(r.actor)}: ${r.emoji}` : r.emoji)).join("\n")}>
          {message.reactions.map((r) => r.emoji).join(" ")}
        </div>
      )}
    </div>
  );
}

/**
 * Another app's call record: what it was ("Call · 25 min"), and the first line of your note on it (hidden with
 * the names). One in a one-to-one chat whose app does not say how long it was may be given its length in whole
 * minutes ("Add length"), which then counts as a call that long, or said to have had no answer ("No answer"), which
 * then reads and counts as a missed call; your own length may be changed or taken away again, and your No answer
 * taken away (as may a No set in Events' Calls table). An app's own length is never changed.
 */
function CallRecord({ message, record }: { message: TimelineMessage; record: CallRecordState }) {
  const readOnly = useReadOnly();
  const names = useNames();
  const [minutes, setMinutes] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const length = { callSeconds: record.callSeconds, callLengthGiven: record.callLengthGiven };
  // Missed as you said: no length of yours, whatever its app's own.
  const missedByYou = record.callAnswer === "missed";
  const label = messageCallLabel({ callSeconds: missedByYou ? 0 : length.callSeconds, fromSelf: message.fromSelf });
  const note = <CallNoteLine note={record.callNote} hidden={names.hidden} />;
  const editable = !readOnly && offers("edit.calls") && message.conversation.type === "direct"
    && (missedByYou || length.callSeconds === null || length.callLengthGiven);
  if (!editable) return <><p>{label}</p>{note}</>;
  const day = catchUpWhen(dayKey(message.sentAt));
  const run = async (change: () => Promise<unknown>) => {
    setSaving(true);
    try {
      await change();
      setMinutes(null);
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(false);
    }
  };
  const save = (value: number | null) => run(() => saveCallLength(message.id, day, length, value));
  const answer = (value: CallAnswer) => run(() => saveCallAnswered({ kind: "record", id: message.id }, day, value, { ...length, callAnswer: record.callAnswer }));
  if (missedByYou) {
    // Taking yours away is saying what its app says (its own length, as a missed call keeps none of yours).
    const itsApps: CallAnswer = length.callSeconds === null ? "unknown" : length.callSeconds > 0 ? "answered" : "missed";
    return (
      <>
        <p>
          {label}
          <span className="muted" title="You said it had no answer"> (yours)</span>{" "}
          <button type="button" className="link-button message__call-length" disabled={saving} title="Take your No answer away" onClick={() => void answer(itsApps)}>
            Remove
          </button>
        </p>
        {note}
      </>
    );
  }
  if (minutes === null) {
    return (
      <>
        <p>
          {label}
          {length.callLengthGiven && <span className="muted" title="The length you gave it"> (yours)</span>}{" "}
          <button type="button" className="link-button message__call-length"
            onClick={() => setMinutes(length.callSeconds === null ? "" : String(Math.round(length.callSeconds / 60)))}>
            {length.callSeconds === null ? "Add length" : "Edit"}
          </button>
          {length.callSeconds === null && (
            <>
              {" ·"}
              <button type="button" className="link-button message__call-length" disabled={saving} title="Say it was not answered" onClick={() => void answer("missed")}>
                No answer
              </button>
            </>
          )}
        </p>
        {note}
      </>
    );
  }
  const value = Number(minutes);
  const valid = minutes.trim() !== "" && Number.isInteger(value) && value >= 1 && value <= CALL_LENGTH_MOST_MINUTES;
  return (
    <form className="message__call-form" onSubmit={(event) => {
      event.preventDefault();
      if (valid) void save(value);
    }}>
      <label>
        Call ·{" "}
        <input type="number" min={1} max={CALL_LENGTH_MOST_MINUTES} step={1} value={minutes} aria-label="Minutes" autoFocus
          onChange={(event) => setMinutes(event.target.value)} onKeyDown={(event) => event.key === "Escape" && setMinutes(null)} />{" "}
        min
      </label>
      <button type="submit" className="link-button" disabled={!valid || saving}>Save</button>
      {length.callLengthGiven && <button type="button" className="link-button" disabled={saving} onClick={() => void save(null)}>Remove</button>}
      <button type="button" className="link-button" disabled={saving} onClick={() => setMinutes(null)}>Cancel</button>
    </form>
  );
}

/**
 * A call among the messages: on your side when you made it, theirs when they did; what it was, and when; for
 * an app's (one with several people in no chat), the app and how many others were on it, named or not; and the first
 * line of your note on it (hidden with the names).
 */
export function Call({ call }: { call: PersonCall }) {
  const names = useNames();
  const outgoing = call.direction === "outgoing";
  const others = call.people - 1;
  return (
    <div className={`message message--call${outgoing ? " message--self" : ""}${call.answered ? "" : " message--missed"}`}>
      <div className="message__meta">
        {timeFormat.format(call.at)} · {outgoing ? "You called" : "They called"}
      </div>
      <div className="message__body">
        <p>{callLabel(call)}</p>
        {call.platform !== "phone" && (
          <span className="muted">
            <span className="platform-badge">{callPlatformName(call.platform)}</span>
            {others > 0 && ` · with ${others} ${others === 1 ? "other" : "others"}`}
          </span>
        )}
        <CallNoteLine note={call.note} hidden={names.hidden} />
      </div>
    </div>
  );
}

const ATTACHMENT_LABELS: Record<string, string> = {
  image: "Photo", video: "Video", audio: "Voice message", gif: "GIF", sticker: "Sticker", file: "File",
};

/** Image types every browser you use can show; others (HEIC, say) are offered as files. */
const SHOWN_IMAGES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function Attachment({ attachment }: { attachment: AttachmentInfo }) {
  const [failed, setFailed] = useState(false);
  const [viewing, setViewing] = useState(false);
  const label = ATTACHMENT_LABELS[attachment.type] ?? "File";
  // Messenger's like reads as the emoji it stands for, so a like whose file is gone is that emoji.
  if (attachment.like && (attachment.missing || failed)) return <span className="attachment-like" title="Like">👍</span>;
  if (attachment.missing) return <span className="attachment attachment--missing">{label} · not in the export</span>;
  if (failed) return <span className="attachment attachment--missing">{label} · file not found</span>;

  const src = archiveApi.attachmentUrl(attachment.id);
  const mime = attachment.mime ?? "";
  const onError = () => setFailed(true);
  // A sticker is drawn whole and never larger than its file: a like at an emoji's size, others at their own up to a cap.
  if (attachment.type === "sticker" && SHOWN_IMAGES.has(mime)) {
    return attachment.like ? (
      <img className={`attachment-like attachment-like--${attachment.like}`} src={src} alt="👍" title="Like" decoding="async" onError={onError} />
    ) : (
      <span className="attachment-sticker">
        <img src={src} alt={label} loading="lazy" decoding="async" onError={onError} />
      </span>
    );
  }
  if (SHOWN_IMAGES.has(mime)) {
    return (
      <>
        <button type="button" className="attachment-image" title={`Open ${label.toLowerCase()}`} onClick={() => setViewing(true)}>
          <img src={src} alt={label} loading="lazy" decoding="async" onError={onError} />
        </button>
        {viewing && <ImageViewer src={src} alt={label} onClose={() => setViewing(false)} />}
      </>
    );
  }
  if (mime.startsWith("video/")) {
    return <video className="attachment-video" src={src} controls preload="none" playsInline onError={onError} />;
  }
  if (mime.startsWith("audio/")) {
    return <audio className="attachment-audio" src={src} controls preload="none" onError={onError} />;
  }
  return (
    <a className="attachment" href={src} target="_blank" rel="noreferrer">
      {label}
      {attachment.size ? ` · ${formatSize(attachment.size)}` : ""}
    </a>
  );
}

/** A photo at full size over the page; a click anywhere or Escape closes it. */
function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="image-viewer" onClose={onClose} onClick={() => dialog.current?.close()}>
      <img src={src} alt={alt} />
    </dialog>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
