// The Journal page's side pane for the day open (A · Notebook's right pane, read-only): its outline, its sources (each
// recording playable and seekable, each transcript opened on asking, either engine), the cleaner's edits, and where its
// files are in the vault. A transcript and an edit list are read from the module's route (each read kept in the trail);
// the edit lists are read as the day opens, the transcripts only when asked for.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { dateText, Icon, type IconDrawing, timeText } from "../../../sdk/viewer.ts";
import { assetPath, JOURNALS_FOLDER, rawPath, type JournalDay, type JournalRawFile, type JournalSource } from "../wire.ts";
import { MarkdownBlocks, type MarkdownLinks } from "./Markdown.tsx";
import { parseMarkdown, type Block } from "./markdown.ts";
import { clock, type Playable, type Player } from "./player.ts";
import "./sidepane.css";

const glyph = (body: ReactNode): IconDrawing => ({ viewBox: "0 0 24 24", body });
export const PLAY = glyph(<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />);
export const PAUSE = glyph(<path d="M8.5 5v14M15.5 5v14" />);
const MIC = glyph(<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />);

/** Fetches JSON from the module's route, its error said in words. */
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { cache: "no-store", signal });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/**
 * Reads each of `urls` once while mounted (each read of a journal is a read in the trail, so once even as React's
 * StrictMode mounts twice, as the drawer's Conversation does): what each answered, or its error, by its url; one not
 * answered yet is missing. A url added later is read then.
 */
export function useReads<T>(urls: readonly string[]): Record<string, T | Error> {
  const [read, setRead] = useState<Record<string, T | Error>>({});
  const asked = useRef(new Set<string>());
  const live = useRef(true);
  const key = urls.join("\n");
  useEffect(() => {
    live.current = true;
    for (const url of key ? key.split("\n") : []) {
      if (asked.current.has(url)) continue;
      asked.current.add(url);
      const keep = (value: T | Error) => live.current && setRead((was) => ({ ...was, [url]: value }));
      getJson<T>(url).then(keep, keep);
    }
    return () => void (live.current = false);
  }, [key]);
  return read;
}

/** A source's name: the label its app keeps, else what it is, memos numbered in the day's order. */
export function sourceName(source: JournalSource, sources: readonly JournalSource[]): string {
  if (source.label) return source.label;
  if (source.kind === "call") return "Call";
  if (source.kind === "memo") {
    const memos = sources.filter((s) => s.kind === "memo" && !s.label);
    return memos.length > 1 ? `Voice memo ${memos.indexOf(source) + 1}` : "Voice memo";
  }
  return source.id;
}

/** What a source's play button plays. */
export const playableOf = (day: string, source: JournalSource, sources: readonly JournalSource[]): Playable | null =>
  source.audio ? { key: source.id, src: assetPath(day, source.audio), label: sourceName(source, sources) } : null;

export function PlayButton({ item, player, small = false }: { item: Playable; player: Player; small?: boolean }) {
  const on = player.now?.key === item.key && player.playing;
  return (
    <button type="button" className={`jn-play${small ? " jn-play--small" : ""}`} onClick={() => player.toggle(item)} aria-label={`${on ? "Pause" : "Play"} ${item.label}`}>
      <Icon name={on ? PAUSE : PLAY} />
    </button>
  );
}

/** Where a loaded recording is, to drag to another place in it. */
export function Seek({ player, label }: { player: Player; label: string }) {
  const duration = player.duration ?? 0;
  return (
    <input
      type="range"
      className="jn-seek"
      min={0}
      max={duration || 1}
      step={0.1}
      value={Math.min(player.time, duration || 1)}
      disabled={!duration}
      onChange={(event) => player.seek(Number(event.target.value))}
      aria-label={`Where in ${label}`}
      style={{ "--jn-seek": `${duration ? (player.time / duration) * 100 : 0}%` } as CSSProperties}
    />
  );
}

function Timer({ player, seconds }: { player: Player; seconds: number | null }) {
  const length = player.duration ?? seconds;
  return <span className="jn-src__time">{clock(player.time)}{length !== null ? ` / ${clock(length)}` : ""}</span>;
}

/** One source's card: what it is and when, its recording, its transcripts. */
function SourceCard({ day, source, sources, player, open, setOpen, section }: {
  day: string; source: JournalSource; sources: readonly JournalSource[]; player: Player;
  open: boolean; setOpen: (open: boolean) => void; section: string | null;
}) {
  const item = playableOf(day, source, sources);
  const loaded = item !== null && player.now?.key === item.key;
  const name = sourceName(source, sources);
  const [engine, setEngine] = useState(0);
  const file = source.transcripts[engine]?.file;
  // A transcript is read only when it is opened, and once: opened again, or its other engine and back, it is as read.
  const path = file ? rawPath(day, file) : null;
  const reads = useReads<JournalRawFile>(open && path ? [path] : []);
  const read = path ? reads[path] : undefined;
  const shown = read instanceof Error ? read : read?.text;
  return (
    <div className={`jn-src${source.cited === false ? " jn-src--outside" : ""}${loaded ? " is-on" : ""}`} id={`jn-src-${source.id}`}>
      <div className="jn-src__head">
        <span className={`jn-kind jn-kind--${source.kind}`}><Icon name={source.kind === "call" ? "call" : source.kind === "memo" ? MIC : "file"} /></span>
        <span className="jn-src__name">{name}</span>
        {source.at && <span className="jn-src__at">{timeText(Date.parse(source.at))}</span>}
      </div>
      {item ? (
        <div className="jn-src__player">
          <PlayButton item={item} player={player} small />
          {loaded ? <Seek player={player} label={name} /> : <span className="jn-seek jn-seek--idle" />}
          {loaded ? <Timer player={player} seconds={source.seconds} /> : <span className="jn-src__time">{source.seconds !== null ? clock(source.seconds) : ""}</span>}
        </div>
      ) : source.kind === "call" ? (
        <p className="jn-src__note">A call: its transcript, both speakers{source.seconds !== null ? `, ${clock(source.seconds)}` : ""}.</p>
      ) : null}
      {loaded && player.problem && <p className="jn-src__note jn-src__note--problem">{player.problem}</p>}
      {source.cited === false && <p className="jn-src__note">Not in this day's journal: left out when the day was cleaned.</p>}
      {source.transcripts.length > 0 && (
        <div className="jn-src__foot">
          <button type="button" className="jn-link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide transcript" : "Transcript"}</button>
          {section && <span className="jn-src__to">→ {section}</span>}
        </div>
      )}
      {open && (
        <div className="jn-src__text">
          {source.transcripts.length > 1 && (
            <div className="jn-seg" role="group" aria-label="Which transcript">
              {source.transcripts.map((t, i) => (
                <button key={t.file} type="button" aria-pressed={i === engine} onClick={() => setEngine(i)}>{t.engine}</button>
              ))}
            </div>
          )}
          {shown === undefined ? <p className="jn-src__note">Reading…</p> : shown instanceof Error ? <p className="jn-src__note jn-src__note--problem">{shown.message}</p> : <Verbatim text={shown} />}
        </div>
      )}
    </div>
  );
}

/** A transcript as it is kept: its header lines (where it came from, which engine) small, then the words. */
function Verbatim({ text }: { text: string }) {
  const lines = text.split("\n");
  const body = lines.findIndex((line, i) => i > 0 && line.trim() !== "" && !line.startsWith("#") && !line.startsWith("- "));
  const head = body === -1 ? [] : lines.slice(0, body).filter((line) => line.startsWith("- "));
  return (
    <>
      {head.length > 0 && <div className="jn-verbatim__head">{head.map((line) => <div key={line}>{line.slice(2)}</div>)}</div>}
      <div className="jn-verbatim">{(body === -1 ? text : lines.slice(body).join("\n")).trim()}</div>
    </>
  );
}

/** A recording of the day's assets no source claims: playable, with no more said of it. */
function RecordingCard({ day, path, player }: { day: string; path: string; player: Player }) {
  const name = path.split("/").at(-1)!;
  const item: Playable = { key: path, src: assetPath(day, path), label: name };
  const loaded = player.now?.key === path;
  return (
    <div className={`jn-src jn-src--outside${loaded ? " is-on" : ""}`}>
      <div className="jn-src__head">
        <span className="jn-kind jn-kind--other"><Icon name={MIC} /></span>
        <span className="jn-src__name">{name}</span>
      </div>
      <div className="jn-src__player">
        <PlayButton item={item} player={player} small />
        {loaded ? <Seek player={player} label={name} /> : <span className="jn-seek jn-seek--idle" />}
        {loaded && <Timer player={player} seconds={null} />}
      </div>
      <p className="jn-src__note">A recording with no record in raw/{day}/.</p>
    </div>
  );
}

/** The day's edit lists, read as the day opens, each drawn as the Markdown it is. */
function Edits({ day, files, links }: { day: string; files: readonly string[]; links: MarkdownLinks }) {
  const reads = useReads<JournalRawFile>(files.map((file) => rawPath(day, file)));
  const parsed = useMemo(() => {
    const out: Record<string, Block[] | Error> = {};
    for (const [path, read] of Object.entries(reads)) out[path] = read instanceof Error ? read : parseMarkdown(read.text);
    return out;
  }, [reads]);
  if (files.length === 0) return <p className="jn-src__note">No edit list for this day.</p>;
  return (
    <div className="jn-edits">
      {files.map((file) => {
        const blocks = parsed[rawPath(day, file)];
        return (
          <div key={file} className="jn-edits__file">
            {files.length > 1 && <div className="jn-edits__name">{file}</div>}
            {blocks === undefined ? <p className="jn-src__note">Reading…</p> : blocks instanceof Error ? <p className="jn-src__note jn-src__note--problem">{blocks.message}</p> : <MarkdownBlocks blocks={blocks.filter((b) => !(b.type === "heading" && b.level === 1))} links={links} />}
          </div>
        );
      })}
    </div>
  );
}

export interface OutlineEntry {
  id: string;
  level: number;
  text: string;
  /** The time of the source its section cites, when it does. */
  at: string | null;
}

export function SidePane({ day, outline, sectionOf, player, openTranscript, setOpenTranscript, links, onOutline }: {
  day: JournalDay; outline: readonly OutlineEntry[]; sectionOf: (source: JournalSource) => string | null; player: Player;
  openTranscript: string | null; setOpenTranscript: (id: string | null) => void; links: MarkdownLinks; onOutline: (id: string) => void;
}) {
  // One list for as long as the files are the same, so a render does not read them again.
  const editKey = [...day.sources.flatMap((s) => (s.edits ? [s.edits] : [])), ...day.edits].join("\n");
  const editFiles = useMemo(() => (editKey ? editKey.split("\n") : []), [editKey]);
  const audio = day.sources.filter((s) => s.audio).length + day.recordings.length;
  return (
    <aside className="jn-side" aria-label={`${day.day}: outline, sources and edits`}>
      {outline.length > 0 && (
        <section>
          <div className="jn-side__h"><h4>Outline</h4><span>{outline.length}</span></div>
          <nav className="jn-outline">
            {outline.map((entry) => (
              <a key={entry.id} href={`#${entry.id}`} className={`jn-outline__row jn-outline__row--${entry.level}`} onClick={(e) => (e.preventDefault(), onOutline(entry.id))}>
                {outline.some((e) => e.at) && <span className="jn-outline__at">{entry.at ? timeText(Date.parse(entry.at)) : ""}</span>}
                <span>{entry.text}</span>
              </a>
            ))}
          </nav>
        </section>
      )}
      <section id="jn-sources">
        <div className="jn-side__h"><h4>Sources</h4><span>{day.sources.length + day.recordings.length}{audio > 0 ? ` · ${audio} with audio` : ""}</span></div>
        {day.sources.length + day.recordings.length === 0 && <p className="jn-src__note">No sources in raw/{day.day}/: this day was written by hand.</p>}
        <div className="jn-srcs">
          {day.sources.map((source) => (
            <SourceCard
              key={source.id}
              day={day.day}
              source={source}
              sources={day.sources}
              player={player}
              open={openTranscript === source.id}
              setOpen={(open) => setOpenTranscript(open ? source.id : null)}
              section={sectionOf(source)}
            />
          ))}
          {day.recordings.map((path) => <RecordingCard key={path} day={day.day} path={path} player={player} />)}
        </div>
      </section>
      <section>
        <div className="jn-side__h"><h4>The cleaner's edits</h4><span>{editFiles.length || ""}</span></div>
        <Edits day={day.day} files={editFiles} links={links} />
      </section>
      <section>
        <div className="jn-side__h"><h4>In the vault</h4></div>
        <div className="jn-files">
          <div><span>{JOURNALS_FOLDER}/{day.day}.md</span><span>{day.modifiedAt ? `changed ${dateText(Date.parse(day.modifiedAt))}` : "not written yet"}</span></div>
          <div><span>raw/{day.day}/</span><span>{day.sources.length} {day.sources.length === 1 ? "source" : "sources"}</span></div>
          <div><span>assets/{day.day}/</span><span>{audio} {audio === 1 ? "recording" : "recordings"}</span></div>
        </div>
      </section>
    </aside>
  );
}
