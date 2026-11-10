// Every LLM transcript on this Mac, kept in the archive's folder as its tool wrote it (docs/data.md's "Every LLM transcript"):
// taken each night by the NAS backup's job (npm run nas-backup, before its snapshot, so the snapshot holds it), or by
// hand with npm run nas-backup -- transcripts. Files only: no transcript is read, by anyone, in the normal course; they
// are content (server/privacy/policy.ts), read only when the captain asks.
//
// Claude Code deletes a session 30 days after it last changed, and the life archive's own copies (sessionCopies.ts)
// are only of what it indexes; so each source in TRANSCRIPT_SOURCES (a tool's named folders and files, never its whole
// home, so its auth and secrets files beside them are never taken) is copied into data/transcripts/<source>/, each
// file at its path there with .zst added: the file's bytes, compressed with zstd, which `zstd -dc` gives back exactly.
//
// A stored file only ever grows, and none is written over, renamed or deleted:
//   - A file new to the source is compressed whole, through a temporary file flushed to disk and renamed.
//   - A file its tool added to (Claude Code's sessions, the histories) is checked whole against the sha-256 of what is
//     stored, and what is new is compressed and appended to the stored file as a frame of its own: zstd reads a file
//     of frames as their bytes one after another.
//   - A file that no longer begins with what is stored (rewritten, shorter, a database copy that changed) is a new
//     version beside it, <path>.changed-1.zst (then -2, ...), the newest the highest; the earlier stays.
//   - A file its tool deleted (Codex rewriting a quiet rollout.jsonl as rollout.jsonl.zst, Claude Code's 30 days) stays,
//     marked gone in the index.
// A file whose size and modification time are those recorded is not read again.
//
// Each source's index, data/transcripts/<source>.json, records each file's size, modification time, sha-256, its
// versions and the bytes stored of its newest: it is what has been taken, saved as the pass goes and when it ends. A
// pass cut short leaves a stored file with a frame the index does not know at most, and the next pass cuts it back to
// what the index says before it appends. A SQLite store is taken as a consistent, checked copy (checkedCopy, VACUUM
// INTO, in data/backups/transcripts/, which the snapshot leaves out), only when its file or its -wal changed. A source
// marked `once` (one that no longer changes) is not looked at again after a pass that took all of it.
//
// A pass leaves the disk at least MIN_FREE_BYTES: it refuses to start with less, and stops before a file that would
// take it under (what it took is saved, and the next pass carries on), as the first pass over a big source can.
//
// Written in Effect (docs/effect.md): a pass holds data/backups/transcripts/.lock in its scope, each file is one step
// that runs to its end, and the index is saved however the pass ends, so a signal stops it between two files.

import { createHash, type Hash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, readFile, rename, rm, stat, statfs, truncate } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, matchesGlob, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress, zstdDecompressSync } from "node:zlib";
import { Data, Effect } from "effect";
import { pathSetting } from "../dataHome.ts";
import { atomicWrite } from "../files.ts";
import { checkedCopy } from "./backups.ts";
import { CORE_FILE } from "./coreDb.ts";
import { holdLock } from "./nasBackup.ts";
import { LOCALE } from "../../src/time.ts";

/** Where they are kept, in the archive's folder. */
export const TRANSCRIPTS_FOLDER = "transcripts";
/** How the last pass went, in the archive's folder. */
export const CAPTURE_STATUS_FILE = join(TRANSCRIPTS_FOLDER, "capture.json");
/** Where a pass holds its lock and makes its database copies: in backups/, which the NAS snapshot leaves out. */
export const CAPTURE_STAGING = join("backups", "transcripts");
/** The room a pass leaves this Mac's disk at the least; it refuses to start with less. */
export const MIN_FREE_BYTES = 5e9;
/** zstd's level: about 200 MB/s here, and within 1% of its best on these files. */
const LEVEL = 9;

/**
 * A tool's transcripts: what it is, where its home is, and what is taken there, each a file or a folder (all of it)
 * relative to the home, a * in a segment matching any name (a profile's folder, say). A file named in `databases` is a
 * SQLite store, taken as a checked copy.
 */
export interface TranscriptSource {
  /** Its folder in data/transcripts/ and its index's name. */
  name: string;
  about: string;
  root: string;
  take: string[];
  /** The files in `take` (by their path in the home) that are SQLite stores: taken as checked copies, not as they lie. */
  databases?: string[];
  /** Taken until a pass takes all of it, then never looked at again. */
  once?: boolean;
}

const home = homedir();
const appSupport = join(home, "Library", "Application Support");
const profiles = pathSetting("CLAUDE_PROFILES_DIR") ?? null;
const t3State = pathSetting("T3_CODE_STATE") ?? null;

/** Every LLM transcript store this archive knows on a Mac. */
export const TRANSCRIPT_SOURCES: TranscriptSource[] = [
  // Every Claude Code session (the CLI, the desktop app's Code tab, every firstmate crew), its subagents and tools'
  // output, the prompt history and the rewind snapshots; never .claude.json, settings or credentials.
  { name: "claude-code", about: "Claude Code", root: join(home, ".claude"), take: ["projects", "history.jsonl", "file-history"] },
  // Claude Code's other profiles, each a folder of CLAUDE_PROFILES_DIR's, when it is named (.env.example).
  ...(profiles ? [{ name: "claude-profiles", about: "Claude Code's other profiles", root: profiles, take: ["*/projects", "*/history.jsonl", "*/file-history"] }] : []),
  // Codex's rollouts, as .jsonl and as the .jsonl.zst it later rewrites them to, and its prompt history; never auth.json.
  { name: "codex", about: "Codex", root: join(home, ".codex"), take: ["sessions", "archived_sessions", "history.jsonl"] },
  { name: "grok", about: "the Grok CLI", root: join(home, ".grok"), take: ["sessions"] },
  { name: "pi", about: "Pi", root: join(home, ".pi", "agent"), take: ["sessions"] },
  { name: "opencode", about: "OpenCode", root: join(home, ".local", "share", "opencode"), take: ["opencode.db"], databases: ["opencode.db"] },
  // T3 Code's own database, T3_CODE_STATE, when it is named.
  ...(t3State ? [{ name: "t3code", about: "T3 Code's own threads", root: dirname(t3State), take: [basename(t3State)], databases: [basename(t3State)] }] : []),
  // OpenSuperWhisper's dictations: each recording's .wav (the app deletes one only when the captain does) and the
  // database that holds their transcripts; never its whisper-models/ (weights that can be downloaded again).
  { name: "opensuperwhisper", about: "OpenSuperWhisper's recordings and their transcripts", root: join(appSupport, "ru.starmel.OpenSuperWhisper"), take: ["recordings", "recordings.sqlite"], databases: ["recordings.sqlite"] },
  // Taken once: they no longer change.
  { name: "t3-usage-archive", about: "the retired machines' copies", root: join(home, ".t3-usage-archive"), take: ["*"], once: true },
  { name: "cursor", about: "Cursor", root: join(appSupport, "Cursor", "User", "globalStorage"), take: ["state.vscdb"], databases: ["state.vscdb"], once: true },
  { name: "windsurf", about: "Windsurf", root: join(home, ".codeium", "windsurf"), take: ["cascade"], once: true },
  { name: "claude-desktop", about: "the Claude desktop app's own sessions", root: join(appSupport, "Claude"), take: ["claude-code-sessions", "local-agent-mode-sessions"], once: true },
];

/**
 * Names never taken, wherever they are in a source, file or folder: sign-ins and keys. The sources name only the
 * folders transcripts are in, so this is a second guard. .claude.json is Claude Code's account file.
 */
export const SECRET_NAMES = [/^auth\.json/i, /credentials/i, /^\.claude\.json/i, /^secrets$/i, /^\.env(\..*)?$/i, /\.(pem|key|p12)$/i, /^id_(rsa|ed25519)/i, /keychain/i];

export function isSecretName(name: string): boolean {
  return SECRET_NAMES.some((pattern) => pattern.test(name));
}

/** What is kept of one file. */
export interface StoredFile {
  /** Its size and modification time when last taken, and the sha-256 of those bytes. */
  size: number;
  mtimeMs: number;
  sha256: string;
  /** How many versions are kept: 1 is <path>.zst alone, 2 adds <path>.changed-1.zst, and so on; the newest is the last. */
  versions: number;
  /** The bytes of the newest version's stored file. */
  stored: number;
  /** The bytes of the earlier versions' stored files, together. */
  earlier: number;
  /** When a pass first found it gone from its tool. */
  goneAt?: string;
  /** A database's file and -wal, as size:mtime, when it was last copied. */
  stamp?: string;
}

export interface SourceIndex {
  root: string;
  /** A `once` source: when a pass took all of it. */
  takenOnceAt?: string;
  files: Record<string, StoredFile>;
}

/** Where a version of a file is stored: `store` is its path in the source's folder, without .zst. */
export function versionFile(store: string, version: number): string {
  return version === 1 ? `${store}.zst` : `${store}.changed-${version - 1}.zst`;
}

export type Outcome = "new" | "grown" | "replaced" | "same";

export interface SourceResult {
  name: string;
  root: string;
  /** Why it was not looked at: taken once already, or its home is not on this Mac. */
  skipped?: "once" | "not there";
  /** What this pass did, file by file (would do, in a dry run). */
  new: number;
  grown: number;
  replaced: number;
  same: number;
  /** Files first found gone in this pass. */
  gone: number;
  /** Bytes read from the tool's files. */
  read: number;
  /** All it keeps: files, those since gone from their tool, their newest versions' bytes, and the bytes stored for every version. */
  files: number;
  goneTotal: number;
  rawBytes: number;
  storedBytes: number;
  /** Symbolic links left alone, and names left out by SECRET_NAMES (by their path in the source). */
  links: number;
  secrets: string[];
  /** What could not be read, each with why. */
  problems: string[];
}

export interface CaptureStatus {
  startedAt: string;
  finishedAt: string;
  sources: SourceResult[];
}

/** What stops a pass: no archive, too little room, another pass. */
export class TranscriptsError extends Data.TaggedError("TranscriptsError")<{ readonly message: string }> {}

export interface CaptureOptions {
  dataDir: string;
  /** TRANSCRIPT_SOURCES, named by the caller so a test never takes the real ones. */
  sources: TranscriptSource[];
  log?: (line: string) => void;
  now?: number;
  /** Look only: what a pass would take, by size and time; nothing read or written. */
  dryRun?: boolean;
  minFreeBytes?: number;
  /** How much room the disk has now; the disk of `dataDir` by default. A test lets the disk fill. */
  freeBytes?: () => Promise<number>;
}

/** One pass over every source (see the top of this file); a source that cannot be read is said, and the rest are taken. */
export const captureTranscripts = ({ dataDir, sources, log = () => {}, now = Date.now(), dryRun = false, minFreeBytes = MIN_FREE_BYTES, freeBytes }: CaptureOptions): Effect.Effect<CaptureStatus, TranscriptsError> =>
  Effect.scoped(
    Effect.gen(function* () {
      // An archive's folder, before friend map was a module (archive.sqlite at its root) or after (core.sqlite): the
      // transcripts are taken either way, as nothing here reads the archive.
      if (!existsSync(join(dataDir, CORE_FILE)) && !existsSync(join(dataDir, "archive.sqlite"))) return yield* new TranscriptsError({ message: `there is no archive in ${dataDir} (no ${CORE_FILE})` });
      const staging = join(dataDir, CAPTURE_STAGING);
      yield* holdLock(staging, "transcripts' pass").pipe(Effect.mapError((error) => new TranscriptsError({ message: error.message })));
      const room: Room = {
        free:
          freeBytes ??
          (async () => {
            const stats = await statfs(dataDir);
            return stats.bavail * stats.bsize;
          }),
        minFreeBytes,
      };
      const free = yield* files(room.free);
      if (free < minFreeBytes) return yield* new TranscriptsError({ message: `this Mac has ${bytes(free)} free, under the ${bytes(minFreeBytes)} the transcripts' pass leaves it` });
      const results: SourceResult[] = [];
      for (const source of sources) {
        const result = yield* captureSource(source, { dataDir, staging, now, dryRun, room });
        log(sourceLine(result, dryRun));
        for (const problem of result.problems) log(`PROBLEM ${source.name}: ${problem}`);
        results.push(result);
      }
      const status: CaptureStatus = { startedAt: new Date(now).toISOString(), finishedAt: new Date().toISOString(), sources: results };
      if (!dryRun) yield* files(() => atomicWrite(join(dataDir, CAPTURE_STATUS_FILE), `${JSON.stringify(status, null, 2)}\n`));
      return status;
    }),
  );

const captureSource = (source: TranscriptSource, { dataDir, staging, now, dryRun, room }: { dataDir: string; staging: string; now: number; dryRun: boolean; room: Room }): Effect.Effect<SourceResult, TranscriptsError> => {
  /**
   * Before a file that will be read: the room left must still be the pass's minimum after it (twice its size for a
   * database, which is copied before it is stored). The pass stops there with what it has taken saved, and the next
   * carries on: the first pass over a big source (OpenSuperWhisper's recordings, several GB) can fill a disk the start's check let in.
   */
  const ensureRoom = (src: TranscriptSource, { rel, size, mtimeMs }: FoundFile, entry: StoredFile | undefined) => {
    const database = isDatabase(src, rel);
    if (entry && !database && entry.size === size && entry.mtimeMs === mtimeMs) return Effect.void;
    return files(room.free).pipe(
      Effect.flatMap((free) => {
        const needed = room.minFreeBytes + size * (database ? 2 : 1);
        return free < needed
          ? Effect.fail(new TranscriptsError({ message: `stopped at ${src.name}/${rel}: this Mac has ${bytes(free)} free, under the ${bytes(needed)} (the ${bytes(room.minFreeBytes)} it leaves and the file's own ${bytes(size)}); what was taken is kept, and the next pass carries on` }))
          : Effect.void;
      }),
    );
  };
  return Effect.gen(function* () {
    const indexFile = join(dataDir, TRANSCRIPTS_FOLDER, `${source.name}.json`);
    const storeDir = join(dataDir, TRANSCRIPTS_FOLDER, source.name);
    const index = yield* files(() => readIndex(indexFile, source.root));
    const result: SourceResult = {
      name: source.name, root: source.root, new: 0, grown: 0, replaced: 0, same: 0, gone: 0, read: 0, files: 0, goneTotal: 0, rawBytes: 0, storedBytes: 0, links: 0, secrets: [], problems: [],
    };
    const finish = () => {
      const kept = Object.values(index.files);
      Object.assign(result, {
        files: kept.length, goneTotal: kept.filter((f) => f.goneAt).length,
        rawBytes: kept.reduce((sum, f) => sum + f.size, 0), storedBytes: kept.reduce((sum, f) => sum + f.stored + f.earlier, 0),
      });
      return result;
    };
    if (source.once && index.takenOnceAt) return { ...finish(), skipped: "once" as const };
    if (!existsSync(source.root)) return { ...finish(), skipped: "not there" as const };

    const at = new Date(now).toISOString();
    let unsaved = 0;
    const vanished = new Set<string>();
    const save = Effect.suspend(() => (dryRun || unsaved === 0 ? Effect.void : files(() => atomicWrite(indexFile, JSON.stringify(index))).pipe(Effect.tap(() => Effect.sync(() => (unsaved = 0))))));
    /** One file's step: runs to its end once begun, and its index entry is changed only once its bytes are stored. */
    const take = (rel: string, path: string) =>
      Effect.uninterruptible(
        Effect.tryPromise({
          try: async () => {
            const entry = index.files[rel];
            if (dryRun) return dryOutcome(path, entry);
            const taken = isDatabase(source, rel)
              ? await takeDatabase(path, join(storeDir, rel), entry, join(staging, `${source.name}-${rel.replaceAll("/", "-")}`))
              : await takeFile(path, join(storeDir, rel), entry);
            index.files[rel] = taken.entry;
            if (taken.outcome !== "same" || entry?.goneAt || entry?.mtimeMs !== taken.entry.mtimeMs) unsaved++;
            return taken;
          },
          catch: (error) => error as Error,
        }),
      ).pipe(
        Effect.tap(({ outcome, read }) =>
          Effect.sync(() => {
            result[outcome]++;
            result.read += read;
          }),
        ),
        Effect.catch((error: Error) =>
          Effect.sync(() => {
            // Deleted between the walk and its step: gone, as if not found.
            if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(path)) vanished.add(rel);
            else result.problems.push(`${rel}: ${(error as NodeJS.ErrnoException).code ?? error.message}`);
          }),
        ),
        Effect.andThen(() => (unsaved >= 100 ? save : Effect.void)),
      );

    yield* Effect.gen(function* () {
      const found = yield* files(() => walk(source));
      result.links = found.links;
      result.secrets = found.secrets;
      result.problems.push(...found.problems);
      for (const file of found.files) {
        if (!dryRun) yield* ensureRoom(source, file, index.files[file.rel]);
        yield* take(file.rel, file.path);
      }
      // Every file not found is gone, but under a folder that could not be read.
      const seen = new Set(found.files.map((f) => f.rel).filter((rel) => !vanished.has(rel)));
      for (const [rel, entry] of Object.entries(index.files)) {
        if (seen.has(rel) || entry.goneAt || found.unread.some((folder) => rel === folder || rel.startsWith(`${folder}/`))) continue;
        result.gone++;
        if (!dryRun) {
          entry.goneAt = at;
          unsaved++;
        }
      }
      if (source.once && !dryRun && result.problems.length === 0) {
        index.takenOnceAt = at;
        unsaved++;
      }
    }).pipe(Effect.ensuring(Effect.ignore(save)));
    // Said when the save above, however the pass ended, could not be made.
    yield* save;
    return finish();
  });
};

/** How much room this Mac's disk has now, and the least a pass leaves it. */
interface Room {
  free: () => Promise<number>;
  minFreeBytes: number;
}

/** A file a source takes: its path in the source, where it is, and its size and time as the walk found them. */
interface FoundFile {
  rel: string;
  path: string;
  size: number;
  mtimeMs: number;
}

/** Whether a source takes this file as a checked copy of a SQLite store. */
const isDatabase = (source: TranscriptSource, rel: string): boolean => source.databases?.includes(rel) ?? false;

/** What a dry run says a file's step would do: by its size and time alone, a database's by its stamp. */
async function dryOutcome(path: string, entry: StoredFile | undefined): Promise<{ outcome: Outcome; read: number }> {
  if (!entry) return { outcome: "new", read: 0 };
  const { size, mtimeMs } = await stat(path);
  if (entry.stamp !== undefined) return { outcome: entry.stamp === (await databaseStamp(path)) ? "same" : "replaced", read: 0 };
  if (size === entry.size && mtimeMs === entry.mtimeMs) return { outcome: "same", read: 0 };
  return { outcome: size > entry.size ? "grown" : "replaced", read: 0 };
}

/** A database's file and -wal as size:mtime, which change with any write. */
async function databaseStamp(path: string): Promise<string> {
  const part = async (file: string) => {
    const info = await stat(file).catch(() => null);
    return info ? `${info.size}:${info.mtimeMs}` : "-";
  };
  return `${await part(path)}|${await part(`${path}-wal`)}`;
}

/** A SQLite store: a checked copy taken (when its file or -wal changed since the last), then kept as a file is. */
async function takeDatabase(path: string, store: string, entry: StoredFile | undefined, copy: string): Promise<{ outcome: Outcome; entry: StoredFile; read: number }> {
  const stamp = await databaseStamp(path);
  if (entry && entry.stamp === stamp) return { outcome: "same", entry: { ...entry, goneAt: undefined }, read: 0 };
  await rm(copy, { force: true });
  try {
    await checkedCopy(path, copy);
    const taken = await takeFile(copy, store, entry, { always: true });
    return { ...taken, entry: { ...taken.entry, stamp } };
  } finally {
    await rm(copy, { force: true });
  }
}

/**
 * Brings what is kept of one file up to date with it (see the top of this file): `store` is where it is kept, without
 * .zst. `always` reads it even when its size and time are as recorded (a database's fresh copy).
 */
export async function takeFile(path: string, store: string, entry: StoredFile | undefined, { always = false } = {}): Promise<{ outcome: Outcome; entry: StoredFile; read: number }> {
  const handle = await open(path, "r");
  try {
    const { size, mtimeMs } = await handle.stat();
    if (!always && entry && entry.size === size && entry.mtimeMs === mtimeMs) return { outcome: "same", entry: { ...entry, goneAt: undefined }, read: 0 };
    if (entry && size >= entry.size) {
      const hash = createHash("sha256");
      await hashRange(handle, 0, entry.size, hash, path);
      if (hash.copy().digest("hex") === entry.sha256) {
        if (size === entry.size) return { outcome: "same", entry: { ...entry, mtimeMs, goneAt: undefined }, read: size };
        // Added to: the new bytes appended as a frame, after cutting back a frame a pass cut short left.
        const newest = versionFile(store, entry.versions);
        const kept = (await stat(newest)).size;
        if (kept < entry.stored) throw new Error(`${newest} is shorter than its index says: something else changed it`);
        if (kept > entry.stored) await truncate(newest, entry.stored);
        await compressRange(handle, entry.size, size, hash, newest, "a", path);
        return { outcome: "grown", entry: { ...entry, size, mtimeMs, sha256: hash.digest("hex"), stored: (await stat(newest)).size, goneAt: undefined }, read: size };
      }
    }
    // New, or no longer what is kept: a version of its own, written whole.
    const versions = entry ? entry.versions + 1 : 1;
    const target = versionFile(store, versions);
    const partial = `${target}.partial`;
    await mkdir(dirname(target), { recursive: true });
    const hash = createHash("sha256");
    try {
      await compressRange(handle, 0, size, hash, partial, "w", path);
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    const stored = (await stat(target)).size;
    return {
      outcome: entry ? "replaced" : "new",
      entry: { size, mtimeMs, sha256: hash.digest("hex"), versions, stored, earlier: entry ? entry.earlier + entry.stored : 0 },
      read: (entry && size >= entry.size ? entry.size : 0) + size,
    };
  } finally {
    await handle.close();
  }
}

/** The bytes from `start` to `end` of an open file, read in order. */
function rangeStream(handle: FileHandle, start: number, end: number): Readable {
  return start < end ? handle.createReadStream({ start, end: end - 1, autoClose: false }) : Readable.from([]);
}

async function hashRange(handle: FileHandle, start: number, end: number, hash: Hash, path: string): Promise<void> {
  let read = 0;
  for await (const chunk of rangeStream(handle, start, end)) {
    read += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  if (read !== end - start) throw new Error(`${path} got shorter while it was read`);
}

/** The bytes from `start` to `end`, into `hash` and as one zstd frame (with its checksum) into `file`, flushed to disk. */
async function compressRange(handle: FileHandle, start: number, end: number, hash: Hash, file: string, flags: "a" | "w", path: string): Promise<void> {
  let read = 0;
  await pipeline(
    rangeStream(handle, start, end),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        read += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
    },
    createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: LEVEL, [constants.ZSTD_c_checksumFlag]: 1 } }),
    createWriteStream(file, { flags, flush: true }),
  );
  if (read !== end - start) throw new Error(`${path} got shorter while it was read`);
}

/** Every file a source takes, by its path in the source, and what was left: links, secrets' names, folders that could not be read. */
async function walk(source: TranscriptSource): Promise<{ files: FoundFile[]; links: number; secrets: string[]; problems: string[]; unread: string[] }> {
  const found = { files: [] as FoundFile[], links: 0, secrets: [] as string[], problems: [] as string[], unread: [] as string[] };
  const visit = async (rel: string): Promise<void> => {
    const path = join(source.root, rel);
    const name = rel.split("/").at(-1)!;
    if (isSecretName(name)) {
      found.secrets.push(rel);
      return;
    }
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      found.problems.push(`${rel}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
      found.unread.push(rel);
      return;
    }
    if (info.isSymbolicLink()) found.links++;
    else if (info.isFile()) found.files.push({ rel, path, size: info.size, mtimeMs: info.mtimeMs });
    else if (info.isDirectory()) {
      let entries: string[];
      try {
        entries = await readdir(path);
      } catch (error) {
        found.problems.push(`${rel}/: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
        found.unread.push(rel);
        return;
      }
      for (const entry of entries.sort()) await visit(`${rel}/${entry}`);
    }
  };
  for (const rel of await expand(source.root, source.take, found)) await visit(rel);
  return found;
}

/** The take's patterns as paths in the source, each * segment matched against what is there. */
async function expand(root: string, take: string[], found: { problems: string[]; unread: string[] }): Promise<string[]> {
  const paths: string[] = [];
  for (const pattern of take) {
    let prefixes = [""];
    for (const segment of pattern.split("/")) {
      if (!/[*?[]/.test(segment)) {
        prefixes = prefixes.map((prefix) => (prefix ? `${prefix}/${segment}` : segment));
        continue;
      }
      const next: string[] = [];
      for (const prefix of prefixes) {
        let names: string[];
        try {
          names = await readdir(join(root, prefix));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
          found.problems.push(`${prefix || "."}/: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
          found.unread.push(prefix);
          continue;
        }
        next.push(...names.filter((name) => matchesGlob(name, segment)).sort().map((name) => (prefix ? `${prefix}/${name}` : name)));
      }
      prefixes = next;
    }
    paths.push(...prefixes);
  }
  return [...new Set(paths)];
}

async function readIndex(file: string, root: string): Promise<SourceIndex> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as SourceIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { root, files: {} };
    throw error;
  }
}

/** The bytes a stored file gives back: each zstd frame in it decompressed in turn (node:zlib reads only a file's first). */
export function storedBytes(file: string): Buffer {
  const data = readFileSync(file);
  const parts: Buffer[] = [];
  for (let at = 0; at < data.length; ) {
    const end = frameEnd(data, at);
    if (data.readUInt32LE(at) === ZSTD_MAGIC) parts.push(zstdDecompressSync(data.subarray(at, end)));
    at = end;
  }
  return Buffer.concat(parts);
}

const ZSTD_MAGIC = 0xfd2fb528;

/** Where the zstd frame at `at` ends (RFC 8878: its header, its blocks, its checksum); a skippable frame by its length. */
function frameEnd(data: Buffer, at: number): number {
  const magic = data.readUInt32LE(at);
  if (magic >>> 4 === 0x184d2a5) return at + 8 + data.readUInt32LE(at + 4);
  if (magic !== ZSTD_MAGIC) throw new Error(`no zstd frame at byte ${at}`);
  const descriptor = data[at + 4];
  const single = (descriptor >> 5) & 1;
  let p = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + [single, 2, 4, 8][descriptor >> 6];
  for (let last = 0; !last; ) {
    const header = data.readUIntLE(p, 3);
    last = header & 1;
    p += 3 + (((header >> 1) & 3) === 1 ? 1 : header >>> 3);
  }
  if (p > data.length) throw new Error(`the zstd frame at byte ${at} is cut short`);
  return p + ((descriptor >> 2) & 1 ? 4 : 0);
}

export interface CheckResult {
  /** Files whose newest version gives back the size and sha-256 recorded. */
  ok: number;
  /** Of them, those still at their tool as taken whose bytes are the same as its file's. */
  matchOriginal: number;
  /** What did not, by source and path, each with what was wrong. */
  bad: string[];
}

/**
 * Reads back every file a source keeps: each version decompressed, the newest checked against the size and sha-256
 * recorded, and against the tool's file itself when that is still as it was taken.
 */
export const checkTranscripts = ({ dataDir, sources, log = () => {} }: { dataDir: string; sources: TranscriptSource[]; log?: (line: string) => void }): Effect.Effect<CheckResult, TranscriptsError> =>
  Effect.gen(function* () {
    const result: CheckResult = { ok: 0, matchOriginal: 0, bad: [] };
    for (const source of sources) {
      const index = yield* files(() => readIndex(join(dataDir, TRANSCRIPTS_FOLDER, `${source.name}.json`), source.root));
      const before = { ...result, bad: result.bad.length };
      for (const [rel, entry] of Object.entries(index.files)) {
        yield* files(async () => {
          const store = join(dataDir, TRANSCRIPTS_FOLDER, source.name, rel);
          try {
            for (let version = 1; version < entry.versions; version++) storedBytes(versionFile(store, version));
            const back = storedBytes(versionFile(store, entry.versions));
            const sha256 = createHash("sha256").update(back).digest("hex");
            if (back.length !== entry.size || sha256 !== entry.sha256) return void result.bad.push(`${source.name}/${rel}: gives back ${back.length} bytes, not the ${entry.size} recorded, or other bytes`);
            result.ok++;
            const original = join(source.root, rel);
            if (!isDatabase(source, rel) && !entry.goneAt && (await stat(original).then((s) => s.size === entry.size && s.mtimeMs === entry.mtimeMs, () => false))) {
              if (createHash("sha256").update(await readFile(original)).digest("hex") === sha256) result.matchOriginal++;
              else result.bad.push(`${source.name}/${rel}: not the bytes of its tool's file, though its size and time are`);
            }
          } catch (error) {
            result.bad.push(`${source.name}/${rel}: ${(error as Error).message}`);
          }
        });
      }
      log(`${source.name}: ${result.ok - before.ok} files read back whole, ${result.matchOriginal - before.matchOriginal} of them byte for byte their tool's file still; ${result.bad.length - before.bad} wrong`);
    }
    for (const bad of result.bad) log(`WRONG ${bad}`);
    return result;
  });

export async function readCaptureStatus(dataDir: string): Promise<CaptureStatus | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, CAPTURE_STATUS_FILE), "utf8")) as CaptureStatus;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** A source's line in the log: what the pass did and what it keeps. */
export function sourceLine(r: SourceResult, dryRun = false): string {
  const keeps = `keeps ${count(r.files, "file")}${r.goneTotal ? ` (${r.goneTotal} since gone from ${shown(r.root)})` : ""}, ${bytes(r.rawBytes)} as written in ${bytes(r.storedBytes)}`;
  if (r.skipped === "once") return `${r.name}: taken once already, not looked at again; ${keeps}`;
  if (r.skipped === "not there") return `${r.name}: ${shown(r.root)} is not on this Mac${r.files ? `; ${keeps}` : ""}`;
  const did = dryRun
    ? `would take ${r.new} new, ${r.grown} grown, ${r.replaced} changed; ${r.gone} gone`
    : `${r.new} new, ${r.grown} grown, ${r.replaced} changed (a version beside), ${r.same} as they were, ${r.gone} gone since the last pass; read ${bytes(r.read)}`;
  const left = [r.links ? count(r.links, "link") : "", r.secrets.length ? `${count(r.secrets.length, "secrets file")} (${r.secrets.slice(0, 3).join(", ")}${r.secrets.length > 3 ? ", ..." : ""})` : ""].filter(Boolean);
  return `${r.name}: ${did}; ${keeps}${left.length ? `; left out ${left.join(" and ")}` : ""}${r.problems.length ? `; ${count(r.problems.length, "problem")}` : ""}`;
}

/** The storage report's line on the transcripts: when the last pass was, what they hold, and what it could not read; two days without one is said. */
export function transcriptsLine(status: CaptureStatus | null, now: number): string {
  if (!status) return "LLM transcripts: none taken yet (npm run nas-backup -- transcripts)";
  const hours = (now - Date.parse(status.finishedAt)) / 3_600_000;
  const age = hours < 1 ? "under an hour ago" : hours < 48 ? `${Math.round(hours)} hours ago` : `${Math.round(hours / 24)} days ago, overdue`;
  const sum = (key: "files" | "goneTotal" | "rawBytes" | "storedBytes") => status.sources.reduce((total, s) => total + s[key], 0);
  const problems = status.sources.flatMap((s) => s.problems.map((p) => `${s.name}: ${p}`));
  return (
    `LLM transcripts: last taken ${status.finishedAt} (${age}), ${count(sum("files"), "file")} from ${status.sources.filter((s) => s.files > 0).length} tools ` +
    `(${sum("goneTotal")} since deleted by them), ${bytes(sum("rawBytes"))} as written in ${bytes(sum("storedBytes"))}` +
    (problems.length ? `; ${count(problems.length, "file")} it could not read: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? "; ..." : ""}` : "")
  );
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString(LOCALE)} ${n === 1 ? noun : `${noun}s`}`;
}

export function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} bytes`;
}

/** File work on this Mac, a failure a TranscriptsError saying what went wrong. */
const files = <A>(work: () => Promise<A>): Effect.Effect<A, TranscriptsError> =>
  Effect.tryPromise({ try: work, catch: (error) => new TranscriptsError({ message: (error as Error).message }) });

/** A path for the log, under ~ when it is in the home folder. */
export function shown(path: string): string {
  const rel = relative(home, path);
  return rel.startsWith("..") ? path : `~/${rel}`;
}
