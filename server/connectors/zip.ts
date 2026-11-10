// A small zip reader (and a writer, for test fixtures and a deleted workout's export), so export
// archives are read in place, entry by entry, without extracting them and
// without a native dependency. Handles stored and deflated entries, Zip64
// sizes and offsets, and a zip stored (not compressed) inside another; not
// encryption or multi-disk archives.

import { createReadStream } from "node:fs";
import { open, writeFile, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { crc32, createInflateRaw, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc32: number;
  localHeaderOffset: number;
}

const EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipFile {
  readonly path: string;
  readonly entries: ZipEntry[];
  private readonly handle: FileHandle;
  /** Where this zip starts in the file at `path`: 0, or the offset of a zip stored inside another. */
  private readonly base: number;

  private constructor(path: string, handle: FileHandle, entries: ZipEntry[], base: number) {
    this.path = path;
    this.handle = handle;
    this.entries = entries;
    this.base = base;
  }

  static async open(path: string): Promise<ZipFile> {
    const handle = await open(path, "r");
    try {
      return new ZipFile(path, handle, await readCentralDirectory(handle, 0, (await handle.stat()).size), 0);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /** A zip stored uncompressed as an entry of this one, read in place. Close it separately. */
  async openNested(entry: ZipEntry): Promise<ZipFile> {
    if (entry.method !== 0) throw new Error(`zip entry ${entry.name} is compressed, so it cannot be read in place`);
    const start = await this.dataStart(entry);
    const handle = await open(this.path, "r");
    try {
      return new ZipFile(this.path, handle, await readCentralDirectory(handle, start, entry.size), start);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /** The entry's uncompressed bytes as a stream. */
  async stream(entry: ZipEntry): Promise<Readable> {
    const start = await this.dataStart(entry);
    if (entry.compressedSize === 0) return Readable.from([]);
    const raw = createReadStream(this.path, { start, end: start + entry.compressedSize - 1 });
    if (entry.method === 0) return raw;
    if (entry.method === 8) return raw.pipe(createInflateRaw());
    raw.destroy();
    throw new Error(`zip entry ${entry.name} uses unsupported compression method ${entry.method}`);
  }

  async read(entry: ZipEntry): Promise<Buffer> {
    return buffer(await this.stream(entry));
  }

  close(): Promise<void> {
    return this.handle.close();
  }

  /** Where the entry's (possibly compressed) bytes start in the file. */
  private async dataStart(entry: ZipEntry): Promise<number> {
    const at = this.base + entry.localHeaderOffset;
    const header = await readAt(this.handle, at, 30);
    if (header.readUInt32LE(0) !== LOCAL) throw new Error(`zip entry ${entry.name} has no local header`);
    return at + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  }
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await handle.read(bytes, 0, length, position);
  return bytes.subarray(0, bytesRead);
}

/** Reads the central directory of the zip that fills `length` bytes of the file from `base`; offsets in it are relative to `base`. */
async function readCentralDirectory(handle: FileHandle, base: number, length: number): Promise<ZipEntry[]> {
  const tailLength = Math.min(length, 22 + 0xffff);
  const tail = await readAt(handle, base + length - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory record)");

  let count = tail.readUInt16LE(eocd + 10);
  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);
  const locator = eocd - 20;
  if (locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR) {
    const record = await readAt(handle, base + Number(tail.readBigUInt64LE(locator + 8)), 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD) throw new Error("broken Zip64 end of central directory record");
    count = Number(record.readBigUInt64LE(32));
    directorySize = Number(record.readBigUInt64LE(40));
    directoryOffset = Number(record.readBigUInt64LE(48));
  }

  const directory = await readAt(handle, base + directoryOffset, directorySize);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (directory.readUInt32LE(at) !== CENTRAL) throw new Error("broken zip central directory");
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const nameBytes = directory.subarray(at + 46, at + 46 + nameLength);
    const entry: ZipEntry = {
      // Bit 11 marks UTF-8 names; older tools leave it unset but still write UTF-8, so both read as UTF-8.
      name: nameBytes.toString("utf8"),
      method: directory.readUInt16LE(at + 10),
      crc32: directory.readUInt32LE(at + 16),
      compressedSize: directory.readUInt32LE(at + 20),
      size: directory.readUInt32LE(at + 24),
      localHeaderOffset: directory.readUInt32LE(at + 42),
    };
    applyZip64Extra(entry, directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength));
    entries.push(entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Zip64 moves any size or offset that overflowed 32 bits into extra field 0x0001, in this order. */
function applyZip64Extra(entry: ZipEntry, extra: Buffer): void {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (id === 0x0001) {
      let field = at + 4;
      const next = () => {
        const value = Number(extra.readBigUInt64LE(field));
        field += 8;
        return value;
      };
      if (entry.size === 0xffffffff) entry.size = next();
      if (entry.compressedSize === 0xffffffff) entry.compressedSize = next();
      if (entry.localHeaderOffset === 0xffffffff) entry.localHeaderOffset = next();
      return;
    }
    at += 4 + length;
  }
}

export type ZipInput = Array<{ name: string; data: Buffer | string; stored?: boolean }>;

/**
 * Writes a zip of the given files (deflated unless `stored`), for test fixtures and for an export's zip written again
 * without a deleted workout's copy (exercise/delete.ts). Entries are stamped 2026-01-01; no Zip64, so under 4 GiB.
 */
export async function writeZip(path: string, files: ZipInput): Promise<void> {
  await writeFile(path, zipBytes(files));
}

/** The bytes of a zip of the given files, as writeZip writes them. */
export function zipBytes(files: ZipInput): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const file of files) {
    const data = Buffer.from(file.data);
    const method = file.stored ? 0 : 8;
    const compressed = file.stored ? data : deflateRawSync(data);
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(dosTime, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    chunks.push(local, name, compressed);
    central.push(header, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
