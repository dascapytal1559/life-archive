// Takes WeChat's own files out of an iPhone backup (see ../iphoneBackup.ts)
// into data/platform-exports/wechat/<backup date>/, the folder
// `npm run archive -- import wechat-ios` reads:
//
//   npm run extract-wechat -- [<backup folder, or host:folder>] [--data <dir>] [--date YYYY-MM-DD]
//
// With no folder it reads the backup Finder took last, in ~/Library/Application Support/MobileSync/Backup/.
//
// From the app's domain it takes, for each account folder
// Documents/<md5 of the account's wxid>/ that holds DB/WCDB_Contact.sqlite, at
// the app's own paths:
//   DB/MM.sqlite, DB/WCDB_Contact.sqlite, DB/message_<n>.sqlite   (and a -wal beside any)
//   Img/, Video/, Audio/, OpenData/    the chats' media, a folder per chat (the md5 of its id),
//                                      less the files the app had not finished writing
// The date is the day the backup was taken, local time. The folder is filled
// under a temporary name and given the date's name only once every file is in,
// so a folder with that name is always whole; one already there is never
// written over. It prints counts only, never a file's name or contents.

import "../../../../sdk/command.ts";
import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { archiveFolder, dayKey, EXPORTS_FOLDER } from "../../../../sdk/connector.ts";
import { finderBackup, IphoneBackup, type BackupFile } from "../iphoneBackup.ts";

export const WECHAT_DOMAIN = "AppDomain-com.tencent.xin";

const DATABASE = /^Documents\/([0-9a-f]{32})\/DB\/(MM|WCDB_Contact|message_\d+)\.sqlite(-wal)?$/;
const MEDIA = /^Documents\/([0-9a-f]{32})\/(Img|Video|Audio|OpenData)\/[^/]+\/[^/]+$/;
const ACCOUNT = /^Documents\/([0-9a-f]{32})\/DB\/WCDB_Contact\.sqlite$/;
/** What the app writes while a file is still coming: "12.pic.tmp", "3.pic.dftemp", "5_temp.mp4", "7.aud_tmp". */
const UNFINISHED = /(\.tmp|\.dftemp|_tmp|_temp)(\.|$)/;

export interface Chosen {
  files: BackupFile[];
  /** Account folders, each the md5 of a wxid. */
  accounts: string[];
  /** Files by what they are: "DB", "Img", "Video", "Audio", "OpenData". */
  counts: Record<string, number>;
  unfinished: number;
}

/** The files of WeChat's domain to take: each account's message databases and media. */
export function chooseWeChatFiles(files: BackupFile[]): Chosen {
  const accounts = new Set(files.flatMap((file) => file.relativePath.match(ACCOUNT)?.[1] ?? []));
  const chosen: BackupFile[] = [];
  const counts: Record<string, number> = {};
  let unfinished = 0;
  for (const file of files) {
    const database = file.relativePath.match(DATABASE);
    const media = file.relativePath.match(MEDIA);
    const account = database?.[1] ?? media?.[1];
    if (!account || !accounts.has(account)) continue;
    if (media && UNFINISHED.test(file.relativePath.slice(file.relativePath.lastIndexOf("/") + 1))) {
      unfinished += 1;
      continue;
    }
    const kind = database ? "DB" : media![2];
    counts[kind] = (counts[kind] ?? 0) + 1;
    chosen.push(file);
  }
  return { files: chosen, accounts: [...accounts].sort(), counts, unfinished };
}

export interface Extracted extends Chosen {
  folder: string;
  missing: number;
  bytes: number;
}

/** Copies WeChat's files from the backup at `location` into <exportsDir>/wechat/<date>/. */
export async function extractWeChat(location: string, exportsDir: string, options: { date?: string } = {}): Promise<Extracted> {
  const work = await mkdtemp(join(tmpdir(), "friend-map-iphone-backup-"));
  let backup: IphoneBackup | null = null;
  try {
    backup = await IphoneBackup.open(location, work);
    const date = options.date ?? dayKey(backup.takenAt);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`the date must be YYYY-MM-DD, not ${date}`);
    const folder = join(exportsDir, "wechat", date);
    if (await stat(folder).catch(() => null)) throw new Error(`${folder} is already there; it is never written over`);
    const chosen = chooseWeChatFiles(backup.files(WECHAT_DOMAIN));
    if (chosen.accounts.length === 0) throw new Error(`the backup holds no WeChat account (no ${WECHAT_DOMAIN} Documents/<account>/DB/WCDB_Contact.sqlite)`);
    const partial = `${folder}.partial`;
    await rm(partial, { recursive: true, force: true });
    const missing = await backup.copyOut(chosen.files, partial, (file) => file.relativePath);
    await rename(partial, folder);
    return { ...chosen, folder, missing: missing.length, bytes: await sizeOf(folder) };
  } finally {
    backup?.close();
    await rm(work, { recursive: true, force: true });
  }
}

async function sizeOf(folder: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) bytes += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return bytes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { data: { type: "string" }, date: { type: "string" } },
  });
  try {
    if (positionals.length > 1) {
      throw new Error("Usage: npm run extract-wechat -- [<iPhone backup folder, or host:folder>] [--data <dir>] [--date YYYY-MM-DD]");
    }
    const dataDir = archiveFolder();
    const location = positionals[0] ?? (await finderBackup(homedir()));
    if (!positionals[0]) console.log(`The backup Finder took last: ${location}`);
    const result = await extractWeChat(location, join(dataDir, EXPORTS_FOLDER), { date: values.date });
    console.log(`WeChat: ${result.accounts.length} account${result.accounts.length === 1 ? "" : "s"} into ${result.folder}`);
    for (const [kind, count] of Object.entries(result.counts)) console.log(`  ${kind}: ${count} files`);
    console.log(`  ${(result.bytes / 1024 / 1024).toFixed(1)} MB in all`);
    if (result.unfinished > 0) console.log(`  left out: ${result.unfinished} files the app had not finished writing`);
    if (result.missing > 0) console.log(`  missing: ${result.missing} files the backup lists but does not hold`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
