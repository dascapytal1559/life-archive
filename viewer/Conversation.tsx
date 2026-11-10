// A conversation opened from a row's drawer, only when the captain asks for it ("Show the chat", "Show the
// conversation"): the chat a message is in, around that message, who said what; or the LLM session an event is in,
// his prompts and the model's replies in order, each reply's tool calls folded. Older and newer pages load as he
// scrolls to either end (server/viewer/content.ts, each page kept in the trail of content reads). Over the page at a
// reading width on a wide screen, the whole screen on a phone; ✕ or Escape goes back to the row. Nothing of it is
// kept in the address, so a page opened again reads nothing until asked. Attachments are named by kind, never loaded.

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { TimelineMessage } from "../src/archive.ts";
import { dayKey } from "../src/time.ts";
import { fetchChat, fetchSession } from "./api.ts";
import { dateText, lengthText, timeText } from "./format.ts";
import { CONVERSATION_PAGE, type ChatPage, type SessionPage, type SessionTurn, type TurnPart } from "./wire.ts";

/** The tabs whose rows open a conversation, and the drawer's words for it. */
export const CONVERSATIONS: Record<string, string> = { messages: "Show the chat", llm: "Show the conversation" };

interface Props {
  kind: string;
  /** The row's id: a message's, or an LLM event's. */
  id: number;
  onClose: () => void;
}

export function Conversation({ kind, id, onClose }: Props) {
  return kind === "llm" ? <Session id={id} onClose={onClose} /> : <Chat id={id} onClose={onClose} />;
}

type Busy = "first" | "earlier" | "later" | null;

/**
 * Pages fetched one at a time, the newest request's alone answered; its error said. The first page is asked for once as
 * it mounts (once even as React's StrictMode mounts it twice, so one press is one read in the trail); `more` asks for
 * another. One closed before its page comes ignores it.
 */
function usePages(first: (signal: AbortSignal) => Promise<void>) {
  const [busy, setBusy] = useState<Busy>("first");
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<AbortController | null>(null);
  const started = useRef(false);
  const open = useRef(true);
  const run = (which: Exclude<Busy, null>, work: (signal: AbortSignal) => Promise<void>) => {
    latest.current?.abort();
    const controller = (latest.current = new AbortController());
    const current = () => open.current && !controller.signal.aborted;
    setBusy(which);
    setError(null);
    work(controller.signal)
      .then(() => current() && setBusy(null))
      .catch((e: Error) => {
        if (!current()) return;
        setError(e.message);
        setBusy(null);
      });
  };
  useEffect(() => {
    open.current = true;
    if (!started.current) {
      started.current = true;
      run("first", first);
    }
    return () => void (open.current = false);
  }, []);
  return { busy, error, more: run };
}

function Chat({ id, onClose }: { id: number; onClose: () => void }) {
  const [head, setHead] = useState<ChatPage["conversation"] | null>(null);
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const { busy, error, more } = usePages(async (signal) => {
    const page = await fetchChat(id, {}, signal);
    setHead(page.conversation);
    setMessages(page.messages);
    setBefore(page.before);
    setAfter(page.after);
    setFocus(page.focus);
  });
  const earlier = () =>
    before && more("earlier", async (signal) => {
      const page = await fetchChat(id, { before }, signal);
      setMessages((shown) => [...page.messages, ...shown]);
      setBefore(page.before);
    });
  const later = () =>
    after && more("later", async (signal) => {
      const page = await fetchChat(id, { after }, signal);
      setMessages((shown) => [...shown, ...page.messages]);
      setAfter(page.after);
    });

  const group = head?.type === "group";
  const title = head ? head.title ?? (group ? "Group chat" : "One-to-one chat") : "Chat";
  return (
    <Shell
      title={title}
      subtitle={head ? `${head.app} · ${group ? "group chat" : "one-to-one chat"}` : ""}
      busy={busy}
      error={error}
      earlier={before ? { label: "Earlier messages", load: earlier } : null}
      later={after ? { label: "Later messages", load: later } : null}
      firstKey={messages[0]?.id ?? null}
      onClose={onClose}
    >
      {messages.map((message, i) => {
        const previous = messages[i - 1];
        const following = messages[i + 1];
        const newDay = !previous || dayKey(previous.sentAt) !== dayKey(message.sentAt);
        const notice = message.type === "system" || (message.sender === null && !message.fromSelf);
        const sameSender = (other: TimelineMessage | undefined) => other && other.fromSelf === message.fromSelf && other.sender === message.sender;
        // Who it is from, in a group, when someone else starts saying something; the time when a run of theirs ends.
        const named = group && !message.fromSelf && !notice && (newDay || !sameSender(previous));
        const timed = !following || !sameSender(following) || following.sentAt - message.sentAt > 10 * 60_000 || dayKey(following.sentAt) !== dayKey(message.sentAt);
        return (
          <Fragment key={message.id}>
            {newDay && <p className="conversation__day">{dateText(message.sentAt)}</p>}
            <div
              className={`msg ${notice ? "msg--notice" : message.fromSelf ? "msg--self" : "msg--them"}${message.id === focus ? " msg--focus" : ""}`}
              data-focus={message.id === focus || undefined}
            >
              {named && <span className="msg__sender">{message.sender ?? "Someone"}</span>}
              <div className="msg__bubble">
                <MessageBody message={message} />
              </div>
              {(timed || message.id === focus) && <span className="msg__time">{timeText(message.sentAt)}</span>}
            </div>
          </Fragment>
        );
      })}
    </Shell>
  );
}

/** What a message says: its words, a call's length and note, its attachments by kind (never loaded), its reactions. */
export function MessageBody({ message }: { message: TimelineMessage }) {
  if (message.unsent) return <span className="msg__unsent">Unsent</span>;
  const call = message.type === "call"
    ? message.callSeconds === 0 ? "Call, not answered" : `Call${message.callSeconds ? `, ${lengthText(message.callSeconds)}` : ""}`
    : null;
  return (
    <>
      {call && <span className="msg__call">{call}</span>}
      {message.text && (call ? message.text !== call && <span className="msg__dim"> · {message.text}</span> : message.text)}
      {message.callNote && <span className="msg__dim"> · {message.callNote}</span>}
      {message.attachments.length > 0 && (
        <span className="msg__chips">
          {message.attachments.map((a) => (
            <span key={a.id} className="msg__chip">{a.like ? "like" : a.type}{a.missing ? " (not kept)" : ""}</span>
          ))}
        </span>
      )}
      {!call && !message.text && message.attachments.length === 0 && <span className="msg__dim">{message.type}</span>}
      {message.reactions.length > 0 && (
        <span className="msg__reactions">
          {message.reactions.map((r, i) => (
            <span key={i} title={r.actor}>{r.emoji}</span>
          ))}
        </span>
      )}
    </>
  );
}

function Session({ id, onClose }: { id: number; onClose: () => void }) {
  const [head, setHead] = useState<SessionPage["session"] | null>(null);
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [first, setFirst] = useState(0);
  const [total, setTotal] = useState(0);
  const [focus, setFocus] = useState<number | null>(null);
  const { busy, error, more } = usePages(async (signal) => {
    const page = await fetchSession(id, null, signal);
    setHead(page.session);
    setTurns(page.turns);
    setFirst(page.offset);
    setTotal(page.total);
    setFocus(page.focus);
  });
  const earlier = () =>
    more("earlier", async (signal) => {
      const offset = Math.max(0, first - CONVERSATION_PAGE);
      const page = await fetchSession(id, offset, signal);
      // A page from the start may reach turns already shown.
      setTurns((shown) => [...page.turns.slice(0, first - offset), ...shown]);
      setFirst(offset);
    });
  const later = () =>
    more("later", async (signal) => {
      const page = await fetchSession(id, first + turns.length, signal);
      setTurns((shown) => [...shown, ...page.turns]);
      setTotal(page.total);
    });

  return (
    <Shell
      title={head ? folderName(head.project) : "Conversation"}
      subtitle={head ? `${head.app} · ${total} ${total === 1 ? "turn" : "turns"}` : ""}
      busy={busy}
      error={error}
      earlier={first > 0 ? { label: "Earlier turns", load: earlier } : null}
      later={first + turns.length < total ? { label: "Later turns", load: later } : null}
      firstKey={turns[0]?.event ?? null}
      onClose={onClose}
    >
      {turns.map((turn, i) => {
        const newDay = i === 0 || dayKey(turns[i - 1].at) !== dayKey(turn.at);
        return (
          <Fragment key={turn.event}>
            {newDay && <p className="conversation__day">{dateText(turn.at)}</p>}
            <div className={`turn turn--${turn.role}${turn.event === focus ? " turn--focus" : ""}`} data-focus={turn.event === focus || undefined}>
              <span className="turn__who">
                {turn.role === "prompt" ? "You" : (turn.model ?? "The model")} · {timeText(turn.at)}
              </span>
              <div className="turn__body">
                <TurnParts parts={turn.parts} />
                {turn.images > 0 && <span className="msg__chip">{turn.images === 1 ? "a picture" : `${turn.images} pictures`}</span>}
              </div>
            </div>
          </Fragment>
        );
      })}
    </Shell>
  );
}

/** A turn's words, each run of tool calls between them folded into one line that opens to list them. */
function TurnParts({ parts }: { parts: TurnPart[] }) {
  const runs: Array<{ text: string } | { tools: Array<{ name: string; input: string }> }> = [];
  for (const part of parts) {
    const last = runs.at(-1);
    if (part.type === "text") runs.push({ text: part.text });
    else if (last && "tools" in last) last.tools.push(part);
    else runs.push({ tools: [part] });
  }
  return runs.map((run, i) =>
    "text" in run ? (
      <Prose key={i} text={run.text} />
    ) : (
      <details key={i} className="turn__tools">
        <summary>
          {run.tools.length === 1 ? "1 tool call" : `${run.tools.length} tool calls`}: {[...new Set(run.tools.map((t) => t.name))].join(", ")}
        </summary>
        <ol>
          {run.tools.map((tool, j) => (
            <li key={j}>
              <strong>{tool.name}</strong> <code>{tool.input}</code>
            </li>
          ))}
        </ol>
      </details>
    ),
  );
}

/** Words as written, their fenced code (```) set apart; never HTML. */
function Prose({ text }: { text: string }) {
  return text.split(/^```.*$/m).map((piece, i) => {
    const trimmed = piece.replace(/^\n+|\n+$/g, "");
    if (!trimmed) return null;
    return i % 2 ? (
      <pre key={i} className="turn__code">
        <code>{trimmed}</code>
      </pre>
    ) : (
      <p key={i} className="turn__text">{trimmed}</p>
    );
  });
}

/** A folder's last part: /home/sample/Projects/garden-planner is garden-planner. */
function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").at(-1) || path;
}

interface More {
  label: string;
  load: () => void;
}

/**
 * The conversation's frame: its header, its error, and the scrolling list with a way to more at either end, asked for
 * as it scrolls into view (or pressed). The message or turn it was opened at is scrolled to the middle once it comes,
 * and the list stays where it was as older pages come in above it.
 */
function Shell(props: {
  title: string;
  subtitle: string;
  busy: Busy;
  error: string | null;
  earlier: More | null;
  later: More | null;
  /** The first item's key, which changes as an older page comes in above. */
  firstKey: number | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const { title, subtitle, busy, error, earlier, later, firstKey, onClose, children } = props;
  const body = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  /** The list's height before an older page came in above, to keep what was shown in place. */
  const anchor = useRef<number | null>(null);
  const placed = useRef(false);

  useEffect(() => close.current?.focus(), []);

  useLayoutEffect(() => {
    const list = body.current;
    if (!list) return;
    if (!placed.current && busy === null && firstKey !== null) {
      placed.current = true;
      list.querySelector("[data-focus]")?.scrollIntoView({ block: "center" });
    }
    if (anchor.current !== null && busy !== "earlier") {
      list.scrollTop += list.scrollHeight - anchor.current;
      anchor.current = null;
    }
  }, [busy, firstKey]);

  const loadEarlier = () => {
    if (!earlier || busy !== null) return;
    anchor.current = body.current?.scrollHeight ?? null;
    earlier.load();
  };
  const loadLater = () => later && busy === null && later.load();

  return (
    <div className="conversation" role="dialog" aria-modal="true" aria-label={title}>
      <section className="conversation__panel">
        <header className="conversation__header">
          <div className="conversation__heading">
            <h2>{title}</h2>
            {subtitle && <span className="conversation__subtitle">{subtitle}</span>}
          </div>
          <button ref={close} type="button" className="drawer__close" aria-label="Back to the row" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="conversation__body" ref={body}>
          {error && <p className="viewer__error">{error}</p>}
          {busy === "first" && <p className="drawer__note">Reading…</p>}
          {earlier && busy !== "first" && <MoreButton more={earlier} busy={busy === "earlier"} load={loadEarlier} root={body} />}
          {children}
          {later && busy !== "first" && <MoreButton more={later} busy={busy === "later"} load={loadLater} root={body} />}
        </div>
      </section>
    </div>
  );
}

/**
 * A way to more at one end of the list: pressed, or scrolled into view. Not when it is in view as the list first
 * shows, so opening a conversation reads one page, and no more until the captain scrolls or presses.
 */
function MoreButton({ more, busy, load, root }: { more: More; busy: boolean; load: () => void; root: RefObject<HTMLDivElement | null> }) {
  const button = useRef<HTMLButtonElement>(null);
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    let first = true;
    const seen = new IntersectionObserver((entries) => {
      const shown = entries.some((e) => e.isIntersecting);
      if (!first && shown) latest.current();
      first = false;
    }, { root: root.current, rootMargin: "200px 0px" });
    if (button.current) seen.observe(button.current);
    return () => seen.disconnect();
  }, [root]);
  return (
    <button ref={button} type="button" className="conversation__more" disabled={busy} onClick={load}>
      {busy ? "Reading…" : more.label}
    </button>
  );
}
