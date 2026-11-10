// The parts of one Meta "Download your information" export (Facebook's or
// Instagram's), read together as one set of files. A large download comes as
// several zips (facebook-<user>-<date>-<random>.zip), each holding some of the
// files under one tree, and a part can hold a zip of its own
// (facebook_<id>.zip) with more of them. The zips are read in place, entry by
// entry, never extracted.
//
// An export already unpacked is read as it lies: a folder holding anything but
// zips is the tree itself (holding your_instagram_activity/ and the rest), its
// files read from disk, so they can be kept where they are (see `pathOf`). The
// zips it was unpacked from may sit at its top, kept as they came, and are not
// read (`exports unpack` puts a part's own zips there too).
//
// A file that more than one part carries (Facebook repeats some in every part)
// is read from the first part that has it, by part file name.

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { ZipFile, type ZipEntry } from "../../../sdk/connector.ts";

export interface ExportFile {
  /** The path inside the export, such as your_facebook_activity/messages/inbox/<chat>/message_1.json. */
  name: string;
  size: number;
  /** The zip's checksum; 0 for a file on disk. */
  crc32: number;
  /** Where the bytes are: a zip's entry, or a file on disk (absolute). */
  at: { zip: ZipFile; entry: ZipEntry } | { path: string };
}

export class ExportParts {
  readonly files = new Map<string, ExportFile>();
  /** Counts of what was skipped and why, for tallies. Names only. */
  readonly skipped = new Map<string, number>();
  private readonly zips: ZipFile[] = [];

  private constructor() {}

  /** Opens every part: each source is a zip, a folder whose *.zip files are the parts, or a folder that is the unpacked export (beside its zips, if kept). */
  static async open(sources: string[]): Promise<ExportParts> {
    const parts = new ExportParts();
    try {
      const paths: string[] = [];
      const folders: string[] = [];
      for (const source of sources) {
        if ((await stat(source)).isDirectory()) {
          const names = (await readdir(source)).filter((name) => !name.startsWith(".")).sort();
          const zips = names.filter(isZip);
          if (zips.length === names.length) paths.push(...zips.map((name) => join(source, name)));
          else folders.push(source);
        } else {
          paths.push(source);
        }
      }
      for (const path of paths) await parts.add(await ZipFile.open(path), path);
      for (const folder of folders) await parts.addFolder(folder);
    } catch (error) {
      await parts.close();
      throw error;
    }
    return parts;
  }

  stream(file: ExportFile): Promise<Readable> {
    return "path" in file.at ? Promise.resolve(createReadStream(file.at.path)) : file.at.zip.stream(file.at.entry);
  }

  read(file: ExportFile): Promise<Buffer> {
    return "path" in file.at ? readFile(file.at.path) : file.at.zip.read(file.at.entry);
  }

  /** The file's absolute path on disk, or null for one inside a zip. */
  pathOf(file: ExportFile): string | null {
    return "path" in file.at ? file.at.path : null;
  }

  async close(): Promise<void> {
    await Promise.all(this.zips.map((zip) => zip.close()));
  }

  private async add(zip: ZipFile, label: string): Promise<void> {
    this.zips.push(zip);
    const nested: ZipEntry[] = [];
    for (const entry of zip.entries) {
      if (entry.name.endsWith("/")) continue;
      // A zip at the top of a part is more of the export; one deeper down is a file someone sent.
      if (!entry.name.includes("/") && entry.name.toLowerCase().endsWith(".zip")) {
        nested.push(entry);
        continue;
      }
      const known = this.files.get(entry.name);
      if (known) {
        if (known.size !== entry.size || known.crc32 !== entry.crc32) this.skip("files that differ between parts (the first part's kept)");
        continue;
      }
      this.files.set(entry.name, { name: entry.name, size: entry.size, crc32: entry.crc32, at: { zip, entry } });
    }
    for (const entry of nested) {
      if (entry.size === 0) {
        this.skip("empty zips inside the export");
        continue;
      }
      if (entry.method !== 0) {
        throw new Error(`${label} holds a compressed zip (${entry.name}); unzip ${label} into the export's folder and import the folder`);
      }
      await this.add(await zip.openNested(entry), `${entry.name} in ${label}`);
    }
  }

  /** Every file under an unpacked export's folder, by its path inside the export; hidden files and folders are passed over. */
  private async addFolder(folder: string): Promise<void> {
    const root = resolve(folder);
    // By path, so a folder's files come in the same order wherever it is read.
    const paths = (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
    for (const path of paths) {
      const name = path.slice(root.length).replace(/^[/\\]+/, "").split(/[/\\]/).join("/");
      if (name.split("/").some((part) => part.startsWith("."))) continue;
      // A zip at the top is what the export was unpacked from; one deeper down is a file someone sent.
      if (!name.includes("/") && isZip(name)) continue;
      if (this.files.has(name)) continue;
      this.files.set(name, { name, size: (await stat(path)).size, crc32: 0, at: { path } });
    }
  }

  private skip(reason: string): void {
    this.skipped.set(reason, (this.skipped.get(reason) ?? 0) + 1);
  }
}

function isZip(name: string): boolean {
  return name.toLowerCase().endsWith(".zip");
}
