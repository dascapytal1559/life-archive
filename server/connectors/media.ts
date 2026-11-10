// Where attachment bytes go. An export's files stay where they are in the
// export, unpacked under data/platform-exports/<platform>/<export date>/, and
// are only hashed (keepInPlace). Media with no export behind them (what a live
// connector downloads) are copied into the platform's live folder there, named
// by content hash (storeMedia):
//
//   <media>/<platform>/live/<first two hex digits>/<sha256>.<ext>
//
// where <media> is data/platform-exports. The bytes are streamed through a
// hash and never decoded, rendered or inspected: photos and videos are
// organised by hash and metadata only. The same file stored twice lands on the
// same path.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AttachmentType, InPlaceMedia, StoredMedia } from "./contract.ts";

/** The folder in a platform's exports that holds its media with no export behind them. */
export const LIVE_FOLDER = "live";

/** Copies the bytes into the platform's live folder under `mediaDir` (data/platform-exports), by content hash. */
export async function storeMedia(mediaDir: string, platform: string, bytes: Readable, fileName: string): Promise<StoredMedia> {
  const stored = await keepByHash(join(mediaDir, platform, LIVE_FOLDER), bytes, fileName, join(mediaDir, ".incoming"));
  return { ...stored, path: join(platform, LIVE_FOLDER, stored.path) };
}

/** Where `keepByHash` keeps a file of hash `sha256`, from its folder: <first two hex digits>/<sha256>.<ext of `fileName`>. */
export function hashedPath(sha256: string, fileName: string): string {
  return join(sha256.slice(0, 2), `${sha256}${safeExtension(fileName)}`);
}

/**
 * Copies the bytes into `folder` by content hash (hashedPath), through a temporary file in `incoming` (`folder`'s
 * .incoming unless said) renamed into place, so a file is never there half written: its hash, size and path from `folder`.
 */
export async function keepByHash(folder: string, bytes: Readable, fileName: string, incoming = join(folder, ".incoming")): Promise<StoredMedia> {
  const temporaryDir = incoming;
  await mkdir(temporaryDir, { recursive: true });
  const temporary = join(temporaryDir, randomBytes(8).toString("hex"));
  const hash = createHash("sha256");
  let size = 0;
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(bytes, measure, createWriteStream(temporary));
    const sha256 = hash.digest("hex");
    const path = hashedPath(sha256, fileName);
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await rename(temporary, join(folder, path));
    return { sha256, size, path };
  } finally {
    await rm(temporary, { force: true });
  }
}

/** A file of an unpacked export, hashed where it lies and kept there, never copied. */
export async function keepInPlace(path: string): Promise<InPlaceMedia> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), size, path: resolve(path) };
}

/**
 * The error for an export whose media are still in a zip: an export's media
 * are kept where they are, so it is unpacked first (`exports unpack`) and
 * imported as its folder.
 */
export function unpackFirst(connector: string, platform: string, zip: string): Error {
  return new Error(
    `${connector} keeps media where they are in the export, and ${zip} holds them in a zip: put the export in ` +
      `data/platform-exports/${platform}/<export date>/, unpack it there (npm run archive -- exports unpack <that folder>) and import that folder`,
  );
}

export function safeExtension(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

const TYPES: Record<string, [AttachmentType, string]> = {
  ".jpg": ["image", "image/jpeg"],
  ".jpeg": ["image", "image/jpeg"],
  ".png": ["image", "image/png"],
  ".webp": ["image", "image/webp"],
  ".heic": ["image", "image/heic"],
  ".gif": ["gif", "image/gif"],
  ".mp4": ["video", "video/mp4"],
  ".mov": ["video", "video/quicktime"],
  ".ogg": ["audio", "audio/ogg"],
  ".opus": ["audio", "audio/ogg"],
  ".wav": ["audio", "audio/wav"],
  ".m4a": ["audio", "audio/mp4"],
  ".mp3": ["audio", "audio/mpeg"],
  ".aac": ["audio", "audio/aac"],
  ".pdf": ["file", "application/pdf"],
};

/** The attachment type and MIME type implied by a file name's extension. */
export function mediaTypeOf(fileName: string): { type: AttachmentType; mime?: string } {
  const known = TYPES[extname(fileName).toLowerCase()];
  return known ? { type: known[0], mime: known[1] } : { type: "file" };
}

/**
 * What a live connector has already copied into the media folder, by a key of
 * its choosing that names a source file (such as its Matrix content URI), so a
 * read interrupted part-way through skips those files when it runs again. Kept
 * at <media>/.ledger/<name>.jsonl, one `{key, stored}` line per file. A copy
 * since removed from the media folder is made again.
 */
export class MediaLedger {
  private readonly mediaDir: string;
  private readonly file: string;
  private readonly entries: Map<string, StoredMedia>;

  private constructor(mediaDir: string, file: string, entries: Map<string, StoredMedia>) {
    this.mediaDir = mediaDir;
    this.file = file;
    this.entries = entries;
  }

  static async open(mediaDir: string, name: string): Promise<MediaLedger> {
    const file = join(mediaDir, ".ledger", `${name}.jsonl`);
    const entries = new Map<string, StoredMedia>();
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const line of text.split("\n")) {
      try {
        const { key, stored } = JSON.parse(line) as { key: string; stored: StoredMedia };
        entries.set(key, stored);
      } catch {
        // An empty line, or the last line cut short by an interruption: that file is copied again.
      }
    }
    await mkdir(dirname(file), { recursive: true });
    return new MediaLedger(mediaDir, file, entries);
  }

  /** The copy made for `key`, copying the bytes first if there is none yet. */
  async store(key: string, platform: string, fileName: string, open: () => Promise<Readable>): Promise<StoredMedia> {
    const known = this.entries.get(key);
    if (known && (await stat(join(this.mediaDir, known.path)).catch(() => null))?.size === known.size) return known;
    const stored = await storeMedia(this.mediaDir, platform, await open(), fileName);
    this.entries.set(key, stored);
    await appendFile(this.file, `${JSON.stringify({ key, stored })}\n`);
    return stored;
  }
}
