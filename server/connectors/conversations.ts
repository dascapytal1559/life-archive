// What every connector of an agent's conversations shares (llm-sessions for Claude Code, grok-bot for Grok Bot): each
// is a plug-in (a ConversationSource: where its conversations are, how to copy one, how a copy becomes sessions and
// turns), and this does the rest, alike for all.
//
// A pass, under the lock on the origin's copies (sessionCopies.ts):
//   1. brings the archive's copy of each conversation up to date, adding only what is new (a copy only ever grows),
//      and keeps the copy of one whose source is gone;
//   2. reads each copy that has changed since its bookmark (its size when last read) into sessions and turns, and
//      writes them, sessions by when they began, a turn another session of the pass has already left out;
//   3. ends with a checkpoint whose cursor is the bookmarks, which the host stores in the same transaction as the
//      pass's events (sync.ts, and host.ts for a history import), so a crash leaves nothing half done: the copies are
//      ahead of the bookmarks at most, and the next pass reads them again (reading again changes nothing).
//
// History (`npm run archive -- import <connector>`) runs one thorough pass that reads every copy again. Sync runs in
// the archive's server, as the live bridges do, for as long as it runs:
//   - a thorough pass when it starts, from the bookmarks the host hands back, and every hour, for any change missed
//     or made while it was not running;
//   - a pass of the files that changed, about 2 s after the last change in a folder settles (macOS's file events,
//     fs.watch), or at most 10 s after the first while they keep changing;
//   - one pass at a time, here and with any other process (the copies' lock).
// Written in Effect (docs/effect.md): sync is the watchers' changes, gathered as they settle (`settled`), and the
// hourly rescan, merged into one stream of passes, run in turn until the connector's process edge interrupts it; a
// pass begun is finished first.

import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { relative } from "node:path";
import { Clock, Effect, Option, Queue, Schedule, Stream } from "effect";
import {
  type Connector,
  ConnectorError,
  connectorError,
  type ConnectorEvent,
  type ConnectorManifest,
  type Emit,
  type HistoryOptions,
  type LlmSessionEvent,
  type LlmTurnEvent,
  type SyncOptions,
  whole,
} from "./contract.ts";
import { type CopiesLockHeld, type CopyOutcome, sizeOf, withCopiesLock } from "./sessionCopies.ts";

/** One conversation: its file in the agent's store (null once the agent has deleted it), and the archive's copy. */
export interface Conversation {
  source: string | null;
  copy: string;
}

/** A session read from a copy, and its turns. */
export interface ReadSession {
  event: Omit<LlmSessionEvent, "device">;
  turns: LlmTurnEvent[];
}

/** Counts something left out or noticed, by a name that never quotes content. */
export type Tally = (name: string, n?: number) => void;

/**
 * A conversation the plug-in will not read because something in it is not as it knows it (an app's undocumented
 * format that has changed): never guessed at, it is left as it is, its bookmark where it was, and said in the tallies
 * and the connector's live state until the plug-in learns it.
 */
export interface Refused {
  refused: string;
}

/** A folder of an agent's conversations to watch and read, with what its plug-in needs to know of it. */
export interface Folder {
  path: string;
}

/** One agent's plug-in. */
export interface ConversationSource<F extends Folder = Folder> {
  /** The folders its conversations are in, from the connector's source and settings. */
  folders(source: string, config: Record<string, unknown>): F[];
  /**
   * A folder's conversations: each in its store and each with a copy whose source is gone, or, given `names`
   * (files of the folder that changed), only those that are conversations.
   */
  conversations(folder: F, copiesDir: string, names?: string[]): Promise<Conversation[]>;
  /**
   * Brings a conversation's copy up to date (its source is there): what became of it and its size, or why not this
   * time (a tally's name), or why never as it is.
   */
  keep(conversation: Conversation & { source: string }, options: { thorough: boolean }): Promise<{ outcome: CopyOutcome; bytes: number } | string | Refused>;
  /** A copy's sessions and turns, or why it is left out (a tally's name), or why it is not read as it is. */
  read(copy: string, content: Buffer, folder: F, tally: Tally): Promise<ReadSession[] | string | Refused>;
}

/** The bookmarks: each copy's size when last read, by its path in the origin's copies folder. */
export type Bookmarks = Record<string, number>;

/** How the copies' outcomes are counted (staying the same is not). */
const COPY_TALLIES: Record<Exclude<CopyOutcome, "same">, string> = {
  new: "conversations copied into the archive",
  grown: "conversations that grew, their copies brought up to date",
  gone: "conversations the app no longer has, read from the archive's copy",
  changed: "conversations changed other than by growing: the archive's copy kept, the changed one kept beside it",
};

/** A connector of an agent's conversations: written in Effect, its history and sync are Effects. */
export interface ConversationConnector extends Connector {
  history(options: HistoryOptions): Effect.Effect<void, ConnectorError | CopiesLockHeld>;
  sync?(options: SyncOptions): Effect.Effect<void, ConnectorError | CopiesLockHeld>;
}

/** The connector of an agent's conversations, from its manifest (which must keep copies) and plug-in. */
export function conversationConnector<F extends Folder>(manifest: ConnectorManifest, source: ConversationSource<F>): ConversationConnector {
  return {
    manifest,
    history: (options) => readConversations(source, options),
    ...(manifest.capabilities.sync ? { sync: (options: SyncOptions) => syncConversations(source, options) } : {}),
  };
}

/** Writes one event, as an Effect. */
const say = (emit: Emit, event: ConnectorEvent) => whole(() => emit(event));

/** A history import: one thorough pass reading every copy again, ending with the bookmarks. */
export const readConversations = <F extends Folder>(source: ConversationSource<F>, options: HistoryOptions) =>
  Effect.gen(function* () {
    const { bookmarks } = yield* pass(source, options, { thorough: true, reread: true, bookmarks: {} });
    yield* say(options.emit, { kind: "checkpoint", cursor: { files: bookmarks } });
  });

/** How often sync looks again; for tests, the connector's settings can say otherwise. */
const SETTLE_MS = 2_000;
const MAX_WAIT_MS = 10_000;
const RESCAN_MS = 60 * 60_000;

/** Files that changed, by folder: their names, or null for the whole folder. */
export type Changes = Map<string, Set<string> | null>;

/** One change a folder's watcher saw: a file's name, or null when it could not say which. */
export interface Change {
  folder: string;
  name: string | null;
}

/**
 * The changes on `queue`, gathered into one each time they settle: once none has come for `settleMs`, or at most
 * `maxWaitMs` after the first of them.
 */
export const settled = (queue: Queue.Dequeue<Change>, { settleMs, maxWaitMs }: { settleMs: number; maxWaitMs: number }): Stream.Stream<Changes> =>
  Stream.fromEffectRepeat(
    Effect.gen(function* () {
      const changes: Changes = new Map();
      const add = ({ folder, name }: Change) => {
        const names = changes.get(folder);
        if (name === null || names === null) changes.set(folder, null);
        else changes.set(folder, (names ?? new Set()).add(name));
      };
      add(yield* Queue.take(queue));
      const first = yield* Clock.currentTimeMillis;
      for (;;) {
        const now = yield* Clock.currentTimeMillis;
        const next = yield* Queue.take(queue).pipe(Effect.timeoutOption(Math.max(0, Math.min(settleMs, first + maxWaitMs - now))));
        if (Option.isNone(next)) return changes;
        add(next.value);
      }
    }),
  );

/**
 * Sync: a thorough pass now and every hour, and a pass of what changed as it changes, one at a time, until it is
 * interrupted. A pass begun is finished, its checkpoint written, before it stops.
 */
export const syncConversations = <F extends Folder>(source: ConversationSource<F>, options: SyncOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { config, emit } = options;
      const timing = (key: string, otherwise: number) => (typeof config[key] === "number" ? (config[key] as number) : otherwise);
      const settleMs = timing("settleMs", SETTLE_MS);
      const maxWaitMs = timing("maxWaitMs", MAX_WAIT_MS);
      const rescanMs = timing("rescanMs", RESCAN_MS);
      let bookmarks: Bookmarks = { ...((options.cursor as { files?: Bookmarks } | null)?.files ?? {}) };
      const folders = source.folders(options.sources[0], config);
      const changes = yield* Queue.unbounded<Change>();
      const watchers = new Map<string, FSWatcher>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const watcher of watchers.values()) watcher.close();
          watchers.clear();
        }),
      );
      /** Watches each folder not yet watched that is there; one that is not is looked for again at the next rescan. */
      const watchAll = Effect.try({
        try: () => {
          for (const folder of folders) {
            if (watchers.has(folder.path)) continue;
            try {
              const watcher = watch(folder.path, (_event, name) => Queue.offerUnsafe(changes, { folder: folder.path, name: name === null ? null : String(name) }));
              watcher.on("error", () => {
                watcher.close();
                watchers.delete(folder.path);
              });
              watchers.set(folder.path, watcher);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        },
        catch: connectorError,
      });

      /** The conversations refused, by copy, as the live state says. */
      const refused = new Map<string, string>();
      let said = "";
      const passOf = (only?: Changes) =>
        Effect.gen(function* () {
          const done = yield* pass(source, options, { thorough: only === undefined, reread: false, bookmarks, only });
          bookmarks = done.bookmarks;
          for (const copy of done.read) refused.delete(copy);
          for (const [copy, why] of done.refused) refused.set(copy, why);
          yield* say(emit, { kind: "checkpoint", cursor: { files: bookmarks } });
          const watching = `watching ${watchers.size} of ${folders.length} ${folders.length === 1 ? "folder" : "folders"}`;
          const detail = refused.size === 0 ? watching : `${watching}; ${refused.size} not read: ${[...new Set(refused.values())].join("; ")}`;
          if (detail !== said) yield* say(emit, { kind: "state", state: refused.size === 0 ? "connected" : "error", detail });
          said = detail;
        }).pipe(Effect.uninterruptible);

      yield* say(emit, { kind: "state", state: "connecting", detail: "reading every conversation" });
      // A thorough pass now and every rescanMs, and a pass of each settled set of changes: one at a time, in turn.
      const thorough = Stream.fromSchedule(Schedule.fixed(rescanMs)).pipe(Stream.prepend([0]), Stream.map(() => undefined));
      yield* Stream.merge(thorough, settled(changes, { settleMs, maxWaitMs })).pipe(
        Stream.runForEach((only) => (only ? passOf(only) : watchAll.pipe(Effect.andThen(passOf())))),
      );
    }),
  );

/** One pass (see the top of this file); gives the bookmarks after it, the copies read, and those refused (by copy, with why). */
const pass = <F extends Folder>(
  source: ConversationSource<F>,
  { sources, config, copiesDir, emit }: HistoryOptions,
  { thorough, reread, bookmarks, only }: { thorough: boolean; reread: boolean; bookmarks: Bookmarks; only?: Changes },
) =>
  Effect.gen(function* () {
    if (!copiesDir) return yield* new ConnectorError({ message: "no folder for the archive's copies given (--copies)" });
    const tallies = new Map<string, number>();
    const tally: Tally = (name, n = 1) => {
      if (n > 0) tallies.set(name, (tallies.get(name) ?? 0) + n);
    };
    const after = { ...bookmarks };
    const sessions: ReadSession[] = [];
    const read: string[] = [];
    const refused = new Map<string, string>();
    const refuse = (copy: string, why: string) => {
      tally(`conversations not read, ${why}`);
      refused.set(copy, why);
    };
    yield* withCopiesLock(copiesDir, whole(async () => {
      for (const root of sources) {
        for (const folder of source.folders(root, config)) {
          if (only && !only.has(folder.path)) continue;
          const names = only?.get(folder.path);
          const conversations = await source.conversations(folder, copiesDir, names ? [...names] : undefined);
          if (conversations.length === 0 && thorough) tally("folders with no conversations");
          for (const [i, conversation] of conversations.entries()) {
            const kept = conversation.source === null
              ? { outcome: "gone" as const, bytes: (await sizeOf(conversation.copy))! }
              : await source.keep(conversation as Conversation & { source: string }, { thorough });
            if (typeof kept === "string") {
              tally(kept);
              continue;
            }
            if ("refused" in kept) {
              refuse(conversation.copy, kept.refused);
              continue;
            }
            if (kept.outcome !== "same") tally(COPY_TALLIES[kept.outcome]);
            const bookmark = relative(copiesDir, conversation.copy);
            if (reread || after[bookmark] !== kept.bytes) {
              const got = await source.read(conversation.copy, await readFile(conversation.copy), folder, tally);
              if (typeof got !== "string" && "refused" in got) {
                refuse(conversation.copy, got.refused);
                continue;
              }
              if (typeof got === "string") tally(got);
              else sessions.push(...got);
              after[bookmark] = kept.bytes;
            }
            read.push(conversation.copy);
            if (thorough) await emit({ kind: "progress", done: i + 1, total: conversations.length, note: "conversations" });
          }
        }
      }
    }));

    yield* whole(async () => {
      const device = `computer:${hostname()}`;
      if (sessions.length > 0) await emit({ kind: "device", key: device, name: hostname().replace(/\.local$/, ""), deviceKind: "computer" });
      sessions.sort((a, b) => a.event.startedAt - b.event.startedAt || a.event.id.localeCompare(b.event.id));
      /** Turns already written, so one a continued session repeats is written once. */
      const written = new Set<string>();
      for (const session of sessions) {
        await emit({ ...session.event, device });
        for (const turn of session.turns) {
          if (written.has(turn.id)) {
            tally("turns another session has already, left out");
            continue;
          }
          written.add(turn.id);
          await emit(turn);
        }
      }
      for (const [name, count] of tallies) await emit({ kind: "tally", name, count });
    });
    return { bookmarks: after, read, refused };
  });

/** The files at the top of a folder whose names `keep` says yes to (none when there is no folder). */
export async function filesIn(folder: string, keep: (name: string) => boolean): Promise<string[]> {
  try {
    return (await readdir(folder, { withFileTypes: true })).filter((e) => e.isFile() && keep(e.name)).map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}
