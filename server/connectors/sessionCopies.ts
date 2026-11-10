// The archive's own copies of an agent's conversations (conversations.ts), which their apps keep only for a while:
// Claude Code deletes a session file 30 days after it last changed, and Grok Bot keeps only a conversation's last 200
// entries. The archive keeps a copy of every conversation it reads, and reads the copy: the index's places in a file
// (llm_turn) are places in the copy, which outlasts the app's.
//
// The copies are in the archive's folder, data/llm/<origin>/ (LLM_FOLDER), each origin's in its own layout (Claude
// Code's as its app lays them out, data/llm/claude-code/<project folder>/<session id>.jsonl), so another agent's
// conversations are one more origin beside them.
//
// A copy only ever grows: nothing is taken out of it or written over it.
//   - It is first written whole, through a temporary file flushed to disk and renamed (atomicWrite), and then only
//     added to: what is new is appended and flushed to disk. Every byte of a mirrored copy is one its source had, in
//     its place, so a write cut short by a crash leaves a copy its source still extends, which the next pass carries on.
//   - A source that is gone leaves its copy.
//   - mirror (a source copied byte for byte, as Claude Code's are): a source that no longer extends its copy (shorter,
//     or different within it) never touches it. It is mirrored beside it instead, into <copy>.changed-1 (or -2, ...:
//     the first that it extends, or a new one), and nothing reads those but people.
// One pass at a time keeps an origin's copies (withCopiesLock, in Effect: docs/effect.md), in any process, so two never
// write one copy at once.

import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Data, Effect, Schedule } from "effect";
import { isAlive } from "../alive.ts";
import { atomicWrite } from "../files.ts";
import { type ConnectorError, connectorError } from "./contract.ts";

/** The folder of every origin's copies, in the archive's folder. */
export const LLM_FOLDER = "llm";

/** What became of a copy in a pass. */
export type CopyOutcome = "new" | "grown" | "same" | "changed" | "gone";

/** How much of a copy is checked against its source, back from its end, when the pass is not thorough. */
const CHECKED_TAIL = 64 * 1024;

/**
 * Brings the byte-for-byte copy at `copy` up to date with `source` (see above): to its last whole line when
 * `wholeLines`, checking all of the copy against the source when `thorough` and its last 64 KB otherwise. Returns
 * what became of it and its size. Throws when neither is there.
 */
export async function mirror(source: string, copy: string, { wholeLines = false, thorough = false } = {}): Promise<{ outcome: CopyOutcome; bytes: number }> {
  const sourceSize = await sizeOf(source);
  const copySize = await sizeOf(copy);
  if (sourceSize === null) {
    if (copySize === null) throw new Error(`neither ${source} nor its copy is there`);
    return { outcome: "gone", bytes: copySize };
  }
  const grown = await extend(source, sourceSize, copy, copySize, { wholeLines, thorough });
  if (grown !== null) return { outcome: grown, bytes: (await sizeOf(copy))! };
  // The source no longer extends the copy: mirror it beside it, into the first copy it extends or a new one.
  for (let n = 1; ; n++) {
    const beside = `${copy}.changed-${n}`;
    if ((await extend(source, sourceSize, beside, await sizeOf(beside), { wholeLines, thorough: true })) !== null) {
      return { outcome: "changed", bytes: copySize! };
    }
  }
}

/** Writes the source's new bytes into `copy` when the source extends it, returning what became of it; null when it does not. */
async function extend(
  source: string, sourceSize: number, copy: string, copySize: number | null, { wholeLines, thorough }: { wholeLines: boolean; thorough: boolean },
): Promise<"new" | "grown" | "same" | null> {
  const from = copySize ?? 0;
  if (sourceSize < from) return null;
  const fd = openSync(source, "r");
  try {
    if (copySize !== null && copySize > 0) {
      const start = thorough ? 0 : Math.max(0, copySize - CHECKED_TAIL);
      if (!readAt(fd, start, copySize - start).equals(await readRange(copy, start, copySize - start))) return null;
    }
    let added = readAt(fd, from, sourceSize - from);
    if (wholeLines) added = added.subarray(0, added.lastIndexOf(0x0a) + 1);
    if (copySize === null) {
      await mkdir(dirname(copy), { recursive: true });
      await atomicWrite(copy, added);
      return "new";
    }
    if (added.length === 0) return "same";
    await appendFlushed(copy, added);
    return "grown";
  } finally {
    closeSync(fd);
  }
}

/** Appends `bytes` to the file at `path`, flushed to disk. */
export async function appendFlushed(path: string, bytes: Uint8Array | string): Promise<void> {
  await appendFile(path, bytes, { flush: true });
}

/** A file's size, or null when it is not there. */
export async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Up to `length` bytes of an open file from `position` (fewer at its end). */
function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) break;
    done += read;
  }
  return buffer.subarray(0, done);
}

async function readRange(path: string, position: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Another process has kept an origin's copies for longer than withCopiesLock waits. */
export class CopiesLockHeld extends Data.TaggedError("CopiesLockHeld")<{ readonly message: string }> {}

/**
 * Runs `work` while holding the lock on the copies in `folder` (one origin's), so one pass at a time writes them.
 * The lock is a file there naming the process holding it; a process that finds it held waits, looking again every
 * `everyMs`, and takes it when its process has died. It gives up after `waitMs`, saying another import is running.
 * The lock is let go however `work` ends.
 */
export const withCopiesLock = <A, E, R>(
  folder: string,
  work: Effect.Effect<A, E, R>,
  { waitMs = 10 * 60_000, everyMs = 200 } = {},
): Effect.Effect<A, E | ConnectorError | CopiesLockHeld, R> => {
  const lock = join(folder, ".importing");
  /** Takes the lock, giving null; or gives the process holding it (0 when it cannot be told). */
  const take = (): number | null => {
    for (;;) {
      try {
        writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let holder = 0;
      try {
        holder = Number(readFileSync(lock, "utf8").trim());
      } catch {
        // Let go between the two: look again.
      }
      if (!(Number.isInteger(holder) && holder > 0 && holder !== process.pid && !isAlive(holder))) return holder || 0;
      rmSync(lock, { force: true });
    }
  };
  const acquire = Effect.gen(function* () {
    const holder = yield* Effect.try({
      try: () => {
        mkdirSync(folder, { recursive: true });
        return take();
      },
      catch: connectorError,
    }).pipe(
      Effect.repeat({ schedule: Schedule.spaced(everyMs).pipe(Schedule.while(({ elapsed }) => elapsed < waitMs)), until: (holder) => holder === null }),
    );
    if (holder !== null) {
      return yield* new CopiesLockHeld({ message: `another import is keeping the copies in ${folder} (process ${holder || "unknown"}); try again when it has finished` });
    }
  });
  return Effect.acquireUseRelease(acquire, () => work, () => Effect.sync(() => rmSync(lock, { force: true })));
};
