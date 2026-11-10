// The vault's Journals/ as the Journal page reads it (server/http.ts answers with these): the days by their files'
// names and sizes, and a day, a raw file of it and a file of its assets, each only inside Journals/. A day is named
// by its date (wire.ts's DAY_NAME); every other step of a path is one name, never empty, never starting with a dot
// (so never `..`), never holding a slash; and each file is opened only once its real path, every link followed, is
// still inside Journals/ (the vault itself may be a link, into iCloud Drive say, so Journals/ is its real path too).
// Nothing here writes: the page reads, and Obsidian edits.
//
// A day's sources come from its raw/<day>/ records (rituals' journal contract, modules/rituals/HANDOFF.md's
// "Journal"): each `*.source.json` is a source, its transcripts the raw files it names and those named after it, its
// recording the asset it names under assets/<day>/, and its edit list the `<name>-edits.md` beside it.

import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { isMissingFile } from "../../../sdk/server.ts";
import { DAY_NAME, isPlainName, JOURNALS_FOLDER, type JournalDay, type JournalDayRow, type JournalDays, type JournalRawFile, type JournalSource, type SourceKind, type SourceTranscript } from "../wire.ts";

/** The vault's Journals/, found: its real path, and the vault's name as Obsidian knows it. */
export interface Journals {
  readonly root: string;
  readonly vault: string;
}

/** Why a path was refused or not found, said to the page as a 400 or a 404 (server/http.ts). */
export class JournalPathError extends Error {
  /** Whether the path was fine but names nothing there (404), rather than refused (400). */
  readonly missing: boolean;

  constructor(message: string, missing: boolean) {
    super(message);
    this.missing = missing;
  }
}

/** The largest raw file answered: a transcript of an hour is some tens of kilobytes. */
const RAW_MAX_BYTES = 4 * 1024 * 1024;

/** The types of what assets/<day>/ keeps that the page shows: recordings, and the pictures a day's journal embeds. */
export const ASSET_TYPES: Readonly<Record<string, string>> = {
  m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", wav: "audio/wav", caf: "audio/x-caf", qta: "video/quicktime",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic",
};

const AUDIO = /\.(m4a|mp4|aac|mp3|wav|caf|qta)$/i;

const inside = (root: string, path: string): boolean => path.startsWith(root + sep);

/** The vault at `vaultFolder` in the archive's folder `dataDir` and its Journals/, or null when either is missing. */
export async function openJournals(dataDir: string, vaultFolder: string): Promise<Journals | null> {
  try {
    const vault = await realpath(join(dataDir, vaultFolder));
    const root = await realpath(join(vault, JOURNALS_FOLDER));
    return (await stat(root)).isDirectory() ? { root, vault: basename(vault) } : null;
  } catch (error) {
    if (isMissingFile(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
}

/** The real path of `steps` under Journals/, or null when it is missing, is not of `kind`, or its real path leaves Journals/. */
async function within(journals: Journals, steps: readonly string[], kind: "file" | "directory"): Promise<string | null> {
  try {
    const real = await realpath(join(journals.root, ...steps));
    // Journals/ itself is a folder it may list; anything else must be inside it.
    if (real !== journals.root && !inside(journals.root, real)) return null;
    const info = await stat(real);
    return (kind === "file" ? info.isFile() : info.isDirectory()) ? real : null;
  } catch (error) {
    if (isMissingFile(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
}

/** The names in a folder under Journals/ (none when it is missing), with what each is. */
async function entries(journals: Journals, steps: readonly string[]): Promise<Dirent[]> {
  const folder = await within(journals, steps, "directory");
  return folder ? readdir(folder, { withFileTypes: true }) : [];
}

function checkDay(day: string): void {
  if (!DAY_NAME.test(day)) throw new JournalPathError(`a day is named YYYY-MM-DD, not ${JSON.stringify(day)}`, false);
}

/** A source's kind, by its record's name: a Voice Memos recording's (`0842-voice.source.json`), a call's (`voice-<id>.source.json`), or another's. */
export function kindOf(record: string): SourceKind {
  if (/^\d{4}-voice(-\d+)?\.source\.json$/.test(record)) return "memo";
  if (/^voice-.+\.source\.json$/.test(record)) return "call";
  return "other";
}

const isEdits = (name: string): boolean => /[-.]edits\.md$/.test(name);

/** Every day Journals/ holds, by its files' and folders' names and sizes alone: a day file, or a raw folder, or both. */
export async function listDays(journals: Journals): Promise<JournalDays> {
  const days = new Map<string, JournalDayRow>();
  const row = (day: string) => days.get(day) ?? days.set(day, { day, bytes: null, memos: 0, calls: 0, others: 0, edits: false }).get(day)!;
  for (const entry of await entries(journals, [])) {
    const day = entry.name.slice(0, -3);
    if (!entry.isFile() || !entry.name.endsWith(".md") || !DAY_NAME.test(day)) continue;
    row(day).bytes = (await stat(join(journals.root, entry.name))).size;
  }
  for (const folder of await entries(journals, ["raw"])) {
    if (!folder.isDirectory() || !DAY_NAME.test(folder.name)) continue;
    const names = (await entries(journals, ["raw", folder.name])).filter((e) => e.isFile()).map((e) => e.name);
    const records = names.filter((name) => name.endsWith(".source.json"));
    // A raw folder with nothing in it says nothing of a day.
    if (records.length === 0 && !days.has(folder.name)) continue;
    const day = row(folder.name);
    for (const record of records) day[`${kindOf(record)}s` as const]++;
    day.edits = names.some(isEdits);
  }
  return { vault: journals.vault, days: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)) };
}

/** Who wrote a transcript, in words, by its file's name. */
export function engineOf(file: string): string {
  if (/-transcript-osw\.md$/.test(file)) return "OpenSuperWhisper";
  if (/-transcript-nemotron\.md$/.test(file)) return "Nemotron";
  if (/\.relayed\.md$/.test(file)) return "Relayed, not verbatim";
  if (/\.transcript\.md$/.test(file)) return "Transcript";
  return file;
}

/** The source ids the day's journal cites (`<!-- sources: a, b -->`), or null when it cites none. */
export function citedSources(markdown: string): Set<string> | null {
  const cited = [...markdown.matchAll(/<!--\s*sources:\s*([^>]*?)\s*-->/g)].flatMap((m) => m[1]!.split(",").map((id) => id.trim()).filter(Boolean));
  return cited.length > 0 ? new Set(cited) : null;
}

/** A source's length in seconds, as its record says: "Length 92 s." in its time basis, or a call's start and end. */
function secondsOf(record: Record<string, unknown>): number | null {
  const basis = typeof record.time_basis === "string" ? /Length (\d+(?:\.\d+)?) s\b/.exec(record.time_basis) : null;
  if (basis) return Number(basis[1]);
  if (record.channel === "voice-call" && typeof record.sent_at === "string" && typeof record.received_at === "string") {
    const seconds = (Date.parse(record.received_at) - Date.parse(record.sent_at)) / 1000;
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }
  return null;
}

/** A day as the page opens it: its journal, and each source its raw folder records. Throws JournalPathError for no such day. */
export async function readDay(journals: Journals, day: string): Promise<JournalDay> {
  checkDay(day);
  const file = await within(journals, [`${day}.md`], "file");
  const markdown = file ? await readFile(file, "utf8") : null;
  const modifiedAt = file ? (await stat(file)).mtime.toISOString() : null;
  const rawFolder = await within(journals, ["raw", day], "directory");
  if (markdown === null && rawFolder === null) throw new JournalPathError(`there is no journal for ${day}`, true);
  const names = new Set((await entries(journals, ["raw", day])).filter((e) => e.isFile()).map((e) => e.name));
  const cited = markdown === null ? null : citedSources(markdown);
  const claimed = new Set<string>();
  const audioClaimed = new Set<string>();
  const sources: JournalSource[] = [];
  for (const record of [...names].filter((name) => name.endsWith(".source.json")).sort()) {
    const stem = record.slice(0, -".source.json".length);
    let json: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await readFile(join(rawFolder!, record), "utf8")) as unknown;
      if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
    } catch {
      // A record that does not parse is still a source, known by its name alone.
    }
    const named = [json.raw_file, ...(Array.isArray(json.related_files) ? json.related_files : [])].filter((f): f is string => typeof f === "string");
    const own = [...names].filter((name) => name === `${stem}.md` || [`${stem}-transcript`, `${stem}.transcript`, `${stem}.relayed`].some((start) => name.startsWith(start)));
    const transcripts: SourceTranscript[] = [...new Set([...named, ...own.sort()])]
      .filter((name) => names.has(name) && name.endsWith(".md") && !isEdits(name))
      .map((name) => (claimed.add(name), { engine: engineOf(name), file: name }));
    const assetPrefix = `../../assets/${day}/`;
    let audio: string | null = null;
    for (const related of named.filter((f) => f.startsWith(assetPrefix) && AUDIO.test(f))) {
      const path = related.slice(assetPrefix.length);
      if (path.split("/").every(isPlainName) && (await within(journals, ["assets", day, ...path.split("/")], "file"))) {
        audio = path;
        break;
      }
    }
    if (audio) audioClaimed.add(audio);
    const edits = [`${stem}-edits.md`, `${stem}.edits.md`].find((name) => names.has(name)) ?? null;
    if (edits) claimed.add(edits);
    const id = typeof json.source_id === "string" && json.source_id !== "" ? json.source_id : stem;
    const providerRef = json.provider_ref && typeof json.provider_ref === "object" ? (json.provider_ref as Record<string, unknown>) : {};
    sources.push({
      id,
      kind: kindOf(record),
      at: typeof json.sent_at === "string" ? json.sent_at : null,
      label: typeof providerRef.label === "string" && providerRef.label !== "" ? providerRef.label : null,
      seconds: secondsOf(json),
      transcripts,
      audio,
      edits,
      cited: cited === null ? null : cited.has(id) || cited.has(stem),
    });
  }
  sources.sort((a, b) => (a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : a.at ? -1 : b.at ? 1 : a.id.localeCompare(b.id)));
  const recordings = (await entries(journals, ["assets", day, "voice-memos"]))
    .filter((e) => e.isFile() && AUDIO.test(e.name) && isPlainName(e.name))
    .map((e) => `voice-memos/${e.name}`)
    .filter((path) => !audioClaimed.has(path))
    .sort();
  return {
    day,
    vault: journals.vault,
    markdown,
    modifiedAt,
    sources,
    edits: [...names].filter((name) => isEdits(name) && !claimed.has(name)).sort(),
    recordings,
  };
}

/** A text file of raw/<day>/ (a transcript, an edit list), by its name. Throws JournalPathError for a name refused or missing. */
export async function readRaw(journals: Journals, day: string, file: string): Promise<JournalRawFile> {
  checkDay(day);
  if (!isPlainName(file) || !file.endsWith(".md")) throw new JournalPathError(`a raw file is a Markdown file's name in raw/${day}/, not ${JSON.stringify(file)}`, false);
  const path = await within(journals, ["raw", day, file], "file");
  if (!path) throw new JournalPathError(`there is no raw/${day}/${file}`, true);
  if ((await stat(path)).size > RAW_MAX_BYTES) throw new JournalPathError(`raw/${day}/${file} is over ${RAW_MAX_BYTES / 1024 / 1024} MB`, false);
  return { day, file, text: await readFile(path, "utf8") };
}

/** A file of assets/<day>/ the page shows (ASSET_TYPES), by its path under it: where it is, how long, and its type. Throws JournalPathError for a path refused or missing. */
export async function findAsset(journals: Journals, day: string, steps: readonly string[]): Promise<{ path: string; size: number; type: string }> {
  checkDay(day);
  const shown = steps.join("/");
  if (steps.length === 0 || !steps.every(isPlainName)) throw new JournalPathError(`an asset is a path of names under assets/${day}/, not ${JSON.stringify(shown)}`, false);
  const type = ASSET_TYPES[/\.([a-z0-9]+)$/i.exec(steps.at(-1)!)?.[1]?.toLowerCase() ?? ""];
  if (!type) throw new JournalPathError(`assets/${day}/${shown} is not a recording or a picture the page shows`, false);
  const path = await within(journals, ["assets", day, ...steps], "file");
  if (!path) throw new JournalPathError(`there is no assets/${day}/${shown}`, true);
  return { path, size: (await stat(path)).size, type };
}
