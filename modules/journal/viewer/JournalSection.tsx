// The Journal page (the journal module's page half; docs/console.md's "Journal"): A · Notebook's Days, read-only, as
// the captain chose it (firstmate's la-journal-page-explore report, 9 November 2026). On a desk, three panes: the days
// by month (their names and sizes alone, and once a day is opened its first heading), the day drawn from its
// Journals/<day>.md (Markdown.tsx), and its side pane (SidePane.tsx: outline, sources with their recordings and
// transcripts, the cleaner's edits). On a phone, the list, then the day with its sources under it and a player docked
// at its foot. Obsidian edits a day: "Open in Obsidian" (on a phone "Edit in Obsidian") opens it there.
//
// A day is read only when it is opened (each read kept in the trail of content reads by the module's route): on a
// desk, opening the page opens its latest day, as a notebook opens on its last page; on a phone nothing is read until
// a day is tapped. The day open is in the address (?day=YYYY-MM-DD), so a reload, the back button or a link opens it.

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import { Icon, LOCALE, timeText, type View } from "../../../sdk/viewer.ts";
import { dayKey } from "../../../sdk/wire.ts";
import { DAY_NAME, dayPath, daysPath, obsidianUrl, type JournalDay, type JournalDayRow, type JournalDays, type JournalSource } from "../wire.ts";
import { noteAsset, rawFileOf } from "./links.ts";
import { MarkdownBlock, MarkdownBlocks, type MarkdownLinks } from "./Markdown.tsx";
import { parseMarkdown, plainText, sectionsOf, tally } from "./markdown.ts";
import { clock, usePlayer, type Player } from "./player.ts";
import { getJson, PlayButton, playableOf, Seek, SidePane, sourceName, useReads, type OutlineEntry } from "./SidePane.tsx";
import "./journal.css";

/** The Journal aspect's key in the registry. */
export const JOURNAL_ASPECT = "journal";

export function journalViews(): View[] {
  return [
    {
      key: "journal-days",
      label: "Days",
      aspects: [JOURNAL_ASPECT],
      section: "days",
      blurb: "Every day's journal from the vault, read as Obsidian shows it, with its recordings and transcripts beside it.",
      fill: true,
      component: () => <JournalDaysView />,
    },
  ];
}

const PHONE = "(max-width: 899px)";
const noon = (day: string) => new Date(`${day}T12:00:00Z`);
const weekday = (day: string, width: "long" | "short" = "long") => noon(day).toLocaleDateString(LOCALE, { weekday: width, timeZone: "UTC" });
const monthOf = (day: string) => noon(day).toLocaleDateString(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" });
const shortDay = (day: string) => noon(day).toLocaleDateString(LOCALE, { day: "numeric", month: "short", timeZone: "UTC" });
const nextDay = (day: string) => new Date(noon(day).getTime() + 86_400_000).toISOString().slice(0, 10);

const dayInAddress = (): string | null => {
  const day = new URLSearchParams(location.search).get("day");
  return day && DAY_NAME.test(day) ? day : null;
};

function addressOf(day: string | null): string {
  const query = new URLSearchParams(location.search);
  if (day) query.set("day", day);
  else query.delete("day");
  const search = query.toString();
  return `${location.pathname}${search ? `?${search}` : ""}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

/** A day row's line under its title: what its sources' names and its file's size say. */
function rowMeta(row: JournalDayRow): string {
  const parts = [
    row.memos > 0 ? plural(row.memos, "memo") : null,
    row.calls > 0 ? plural(row.calls, "call") : null,
    row.others > 0 ? plural(row.others, "other source") : null,
    row.bytes !== null ? sizeText(row.bytes) : "not written yet",
  ];
  return parts.filter(Boolean).join(" · ");
}


function JournalDaysView() {
  const [days, setDays] = useState<JournalDays | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(dayInAddress);
  const [filter, setFilter] = useState("");
  const [titles, setTitles] = useState<Record<string, string>>({});
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    getJson<JournalDays>(daysPath(), abort.signal)
      .then((answer) => {
        setDays(answer);
        // On a desk the page opens on its latest day, as a notebook does; a phone starts at the list.
        if (!dayInAddress() && answer.days[0] && !matchMedia(PHONE).matches) {
          history.replaceState(history.state, "", addressOf(answer.days[0].day));
          setOpen(answer.days[0].day);
        }
      })
      .catch((error: Error) => abort.signal.aborted || setProblem(error.message));
    return () => abort.abort();
  }, []);

  useEffect(() => {
    const moved = () => setOpen(dayInAddress());
    addEventListener("popstate", moved);
    return () => removeEventListener("popstate", moved);
  }, []);

  useEffect(() => {
    document.title = `${open ? `${open} · ` : ""}Journal · Life archive`;
  }, [open]);

  const go = useCallback((day: string | null) => {
    history.pushState(history.state, "", addressOf(day));
    setOpen(day);
  }, []);

  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase();
    if (!days || !words) return days?.days ?? [];
    return days.days.filter((row) => [row.day, weekday(row.day), monthOf(row.day), titles[row.day] ?? ""].some((text) => text.toLowerCase().includes(words)));
  }, [days, filter, titles]);

  const titled = useCallback((day: string, title: string) => setTitles((was) => (was[day] === title ? was : { ...was, [day]: title })), []);

  if (problem) return <p className="jn-message">The journals are not available: {problem}</p>;
  if (!days) return <p className="jn-message">Reading the vault's days…</p>;
  if (days.days.length === 0) return <p className="jn-message">There are no journals in the vault's Journals/ yet.</p>;

  const groups: { month: string; rows: JournalDayRow[] }[] = [];
  for (const row of shown) {
    const month = monthOf(row.day);
    if (groups.at(-1)?.month !== month) groups.push({ month, rows: [] });
    groups.at(-1)!.rows.push(row);
  }
  const oldest = days.days.at(-1)!.day;

  return (
    <div ref={root} className={`jn${open ? " jn--open" : ""}`}>
      <aside className="jn-list" aria-label="Days">
        <h1 className="jn-list__title">Journal</h1>
        <div className="jn-list__find">
          <label className="jn-field">
            <Icon name="search" />
            <input type="search" placeholder="Filter days" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter days by date, weekday or month" />
          </label>
          <div className="jn-list__count">
            <span>{plural(days.days.length, "day")}</span>
            <span>since {noon(oldest).toLocaleDateString(LOCALE, { month: "short", year: "numeric", timeZone: "UTC" })}</span>
          </div>
        </div>
        <div className="jn-days">
          {groups.length === 0 && <p className="jn-message">No day matches.</p>}
          {groups.map(({ month, rows }) => (
            <div key={month}>
              <div className="jn-month">{month}</div>
              {rows.map((row) => (
                <a
                  key={row.day}
                  href={addressOf(row.day)}
                  className={`jn-day${row.day === open ? " is-current" : ""}`}
                  aria-current={row.day === open ? "page" : undefined}
                  onClick={(event: MouseEvent) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                    event.preventDefault();
                    go(row.day);
                  }}
                >
                  <span className="jn-day__date"><b>{Number(row.day.slice(8))}</b><i>{weekday(row.day, "short")}</i></span>
                  <span className="jn-day__body">
                    <span className="jn-day__title">{titles[row.day] ?? weekday(row.day)}</span>
                    <span className="jn-day__meta">{rowMeta(row)}</span>
                  </span>
                </a>
              ))}
            </div>
          ))}
        </div>
      </aside>
      {open ? <DayView key={open} day={open} vault={days.vault} known={days.days} go={go} titled={titled} root={root} /> : <section className="jn-doc jn-doc--empty"><p className="jn-message">Pick a day.</p></section>}
    </div>
  );
}

function DayView({ day, vault, known, go, titled, root }: {
  day: string; vault: string; known: readonly JournalDayRow[]; go: (day: string | null) => void;
  titled: (day: string, title: string) => void; root: RefObject<HTMLDivElement | null>;
}) {
  // The day is read once as it opens (each open one read in the trail).
  const answer: JournalDay | Error | null = useReads<JournalDay>([dayPath(day)])[dayPath(day)] ?? null;
  const [openTranscript, setOpenTranscript] = useState<string | null>(null);
  const player = usePlayer();
  const doc = useRef<HTMLElement>(null);

  // A body, not an arrow's value: a browser's scrollTo may answer a promise, which React would take for a cleanup.
  useEffect(() => {
    root.current?.scrollTo(0, 0);
  }, [day, root]);

  const blocks = useMemo(() => (answer && !(answer instanceof Error) && answer.markdown !== null ? parseMarkdown(answer.markdown) : []), [answer]);
  const sections = useMemo(() => sectionsOf(blocks), [blocks]);

  useEffect(() => {
    const first = sections.find((s) => s.heading)?.heading;
    if (first) titled(day, plainText(first.children));
  }, [sections, day, titled]);

  const scrollTo = useCallback((id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), []);

  const links: MarkdownLinks = useMemo(() => {
    const has = new Set(known.map((row) => row.day));
    const dayOf = (target: string) => {
      const name = target.replace(/\.md$/, "").replace(/^Journals\//, "");
      return DAY_NAME.test(name) && has.has(name) ? name : null;
    };
    const transcriptOf = (target: string) => {
      const file = rawFileOf(target, day);
      return answer && !(answer instanceof Error) && file ? answer.sources.find((s) => s.transcripts.some((t) => t.file === file)) : undefined;
    };
    const isRawFolder = (target: string) => new RegExp(`^(?:\\./)?raw/${day}/?$`).test(target);
    return {
      image: noteAsset,
      opens: (target) => dayOf(target) !== null || isRawFolder(target) || transcriptOf(target) !== undefined,
      open(target) {
        const other = dayOf(target);
        if (other) return go(other), true;
        const source = transcriptOf(target);
        if (source) {
          setOpenTranscript(source.id);
          requestAnimationFrame(() => scrollTo(`jn-src-${source.id}`));
          return true;
        }
        if (isRawFolder(target)) return scrollTo("jn-sources"), true;
        return false;
      },
    };
  }, [known, day, answer, go, scrollTo]);

  const back = (
    <button type="button" className="jn-back" onClick={() => go(null)}>
      <Icon name="prev" />
      Days
    </button>
  );
  const obsidian = (
    <a className="jn-btn" href={obsidianUrl(vault, day)}>
      <Icon name="out" />
      <span className="jn-desk-only">Open in Obsidian</span>
      <span className="jn-phone-only">Edit in Obsidian</span>
    </a>
  );

  if (answer === null || answer instanceof Error) {
    return (
      <section className="jn-doc" ref={doc}>
        <div className="jn-bar">{back}<span className="jn-path">Journals / <b>{day}.md</b></span></div>
        <p className="jn-message">{answer ? `This day is not available: ${answer.message}` : "Opening the day…"}</p>
      </section>
    );
  }

  const sourceById = new Map<string, JournalSource>(answer.sources.map((s) => [s.id, s]));
  const citedBy = (ids: readonly string[]) => ids.map((id) => sourceById.get(id)).filter((s): s is JournalSource => s !== undefined);
  const outline: OutlineEntry[] = sections.flatMap((section) =>
    section.heading ? [{ id: `jn-${section.heading.id}`, level: section.heading.level, text: plainText(section.heading.children), at: citedBy(section.sources)[0]?.at ?? null }] : [],
  );
  const sectionOf = (source: JournalSource) => {
    const section = sections.find((s) => s.heading && s.sources.includes(source.id));
    return section?.heading ? plainText(section.heading.children) : null;
  };
  const { words, guesses } = tally(blocks.filter((b) => !(b.type === "heading" && b.level === 1)));
  const audioSeconds = answer.sources.reduce((n, s) => n + (s.audio && s.seconds ? s.seconds : 0), 0);
  const facts = [
    `${weekday(day)} 06:00 → ${weekday(nextDay(day))} 06:00`,
    answer.markdown !== null ? plural(outline.filter((o) => o.level === 2).length, "section") : null,
    answer.markdown !== null ? plural(words, "word") : null,
    guesses > 0 ? `${plural(guesses, "guess", "guesses")} to check` : null,
    plural(answer.sources.length + answer.recordings.length, "source"),
    audioSeconds > 0 ? `${Math.max(1, Math.round(audioSeconds / 60))} min of audio` : null,
  ].filter(Boolean);

  return (
    <>
      <section className="jn-doc" ref={doc} aria-label={`${weekday(day)} ${day}`}>
        <div className="jn-bar">
          {back}
          <span className="jn-path">Journals / <b>{day}.md</b></span>
          <span className="jn-bar__gap" />
          {answer.modifiedAt && (
            <span className="jn-changed" title="When the file last changed: in Obsidian, on the phone through iCloud, or by the morning's clean">
              <i />Changed {shortDay(dayKey(Date.parse(answer.modifiedAt)))}, {timeText(Date.parse(answer.modifiedAt))}
            </span>
          )}
          {obsidian}
        </div>
        <article className="jn-page">
          <div className="jn-facts">{facts.map((fact) => <span key={fact}>{fact}</span>)}</div>
          {answer.markdown === null ? (
            <>
              <h1>{weekday(day)} {day}</h1>
              <p className="jn-message">No journal is written for this day yet; its sources are beside it, in raw/{day}/.</p>
            </>
          ) : (
            <div className="jn-md">
              {sections.map((section, i) => (
                <div key={i} className="jn-section">
                  {section.heading && <SectionHead section={section} sources={citedBy(section.sources)} all={answer.sources} day={day} player={player} links={links} />}
                  <MarkdownBlocks blocks={section.blocks} links={links} />
                </div>
              ))}
            </div>
          )}
        </article>
      </section>
      {/* One side pane: the desk's third column, and on a phone the day's foot, under its text. */}
      <SidePane day={answer} outline={outline} sectionOf={sectionOf} player={player} openTranscript={openTranscript} setOpenTranscript={setOpenTranscript} links={links} onOutline={scrollTo} />
      {player.now && <MiniPlayer player={player} />}
    </>
  );
}

/** A section's heading, with a play button for the recording it was cleaned from, when it cites one with audio. */
function SectionHead({ section, sources, all, day, player, links }: {
  section: ReturnType<typeof sectionsOf>[number]; sources: readonly JournalSource[]; all: readonly JournalSource[]; day: string; player: Player; links: MarkdownLinks;
}) {
  const playable = sources.map((s) => playableOf(day, s, all)).find((p) => p !== null);
  return (
    <div className="jn-section__head">
      <MarkdownBlock block={section.heading!} links={links} />
      {playable && (
        <span className="jn-section__play" title={`Play ${sourceName(sources.find((s) => s.id === playable.key)!, all)}`}>
          <PlayButton item={playable} player={player} small />
        </span>
      )}
    </div>
  );
}

/** The phone's player, docked at the foot of the day while a recording is loaded. */
function MiniPlayer({ player }: { player: Player }) {
  const now = player.now!;
  return (
    <div className="jn-mini jn-phone-only">
      <PlayButton item={now} player={player} small />
      <div className="jn-mini__body">
        <div className="jn-mini__top">
          <b>{now.label}</b>
          <span className="jn-src__time">{clock(player.time)}{player.duration !== null ? ` / ${clock(player.duration)}` : ""}</span>
        </div>
        <Seek player={player} label={now.label} />
      </div>
    </div>
  );
}
