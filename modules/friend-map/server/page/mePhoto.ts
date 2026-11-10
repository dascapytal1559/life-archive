// Your photo, which Orbits draws in place of the sun: data/me/photo.<ext>,
// one file at most, replaced by each upload and gone when removed. The page
// sends the file's bytes as they are; what it is comes from the bytes, never
// from the name or the type the browser gave it, and only JPEG, PNG, WebP
// and HEIC are kept. A HEIC photo (an iPhone's) is kept as a JPEG, made by
// macOS's sips, since only Safari shows HEIC.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { InvalidInputError } from "../../page/src/invalidInput.ts";
import { atomicWrite, isMissingFile } from "../../../../sdk/server.ts";

/** The largest photo kept: a phone's full-size photo fits well within it. */
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

const TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
export type PhotoExt = keyof typeof TYPES;

/** Turns a HEIC photo's bytes into a JPEG's. */
export type HeicConverter = (heic: Buffer, workDir: string) => Promise<Buffer>;

export function photoDir(dataDir: string): string {
  return join(dataDir, "me");
}

/** What `bytes` are, by their first few: a kind kept as it is, "heic", or null for anything else. */
export function photoKind(bytes: Buffer): PhotoExt | "heic" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  // An ISO media file ("....ftyp" and a brand) whose brand is one of HEIF's.
  if (bytes.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(bytes.subarray(8, 12).toString("latin1"))) {
    return "heic";
  }
  return null;
}

/** The photo kept now: its file, type and when it was kept (for the page's address, so a new one is fetched afresh); null for none. */
export async function currentPhoto(dataDir: string): Promise<{ path: string; type: string; version: number } | null> {
  let names: string[];
  try {
    names = await readdir(photoDir(dataDir));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  for (const ext of Object.keys(TYPES) as PhotoExt[]) {
    if (!names.includes(`photo.${ext}`)) continue;
    const path = join(photoDir(dataDir), `photo.${ext}`);
    return { path, type: TYPES[ext], version: Math.round((await stat(path)).mtimeMs) };
  }
  return null;
}

/** The address the page shows the photo from, or null for none. */
export async function photoUrl(dataDir: string): Promise<string | null> {
  const photo = await currentPhoto(dataDir);
  return photo && `/api/me/photo?v=${photo.version}`;
}

/** Keeps `bytes` as the photo, in place of any before it; refuses anything but a JPEG, PNG, WebP or HEIC photo, or one too big. */
export async function savePhoto(dataDir: string, bytes: Buffer, convert: HeicConverter = heicToJpeg): Promise<void> {
  if (bytes.length === 0) throw new InvalidInputError("no photo was sent");
  if (bytes.length > MAX_PHOTO_BYTES) throw new InvalidInputError(`the photo is over ${MAX_PHOTO_BYTES / 1024 / 1024} MB`);
  const kind = photoKind(bytes);
  if (kind === null) throw new InvalidInputError("the photo must be a JPEG, PNG, WebP or HEIC image");
  const dir = photoDir(dataDir);
  await mkdir(dir, { recursive: true });
  let [ext, kept] = [kind, bytes] as [PhotoExt | "heic", Buffer];
  if (kind === "heic") {
    try {
      kept = await convert(bytes, dir);
    } catch {
      throw new InvalidInputError("this HEIC photo could not be read; try a JPEG or PNG");
    }
    ext = "jpg";
  }
  const path = join(dir, `photo.${ext}`);
  await atomicWrite(path, kept);
  for (const other of Object.keys(TYPES)) if (other !== ext) await rm(join(dir, `photo.${other}`), { force: true });
}

/** Removes the photo, so Orbits draws the sun again. */
export async function removePhoto(dataDir: string): Promise<void> {
  for (const ext of Object.keys(TYPES)) await rm(join(photoDir(dataDir), `photo.${ext}`), { force: true });
}

/** HEIC to JPEG with macOS's sips, through files in `workDir` that are removed after. */
export async function heicToJpeg(heic: Buffer, workDir: string): Promise<Buffer> {
  const stem = join(workDir, `convert-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(`${stem}.heic`, heic);
    await promisify(execFile)("sips", ["-s", "format", "jpeg", `${stem}.heic`, "--out", `${stem}.jpg`]);
    const jpeg = await readFile(`${stem}.jpg`);
    if (photoKind(jpeg) !== "jpg") throw new Error("sips made no JPEG");
    return jpeg;
  } finally {
    await rm(`${stem}.heic`, { force: true });
    await rm(`${stem}.jpg`, { force: true });
  }
}
