// npm run check-demo [-- --out <dir>]: whether a built demo (build.ts, which runs this last and fails on what it finds)
// is fit to publish (docs/demo.md): made of what a demo is made of, and holding nothing of a real archive.
//
//   1. Only a demo's files: the pages (index.html, 404.html and their assets/), the site's _redirects, _headers and
//      404.html, the recorded answers (demo-data/answers/), the copied made-up databases (demo-data/db/, gzipped), and
//      the files the server answered at their own paths (under the routes', /life-archive/api/ and /friend-map/api/).
//      No raw database, log, record or settings file anywhere; no file over Cloudflare Pages' 25 MiB, and no more than
//      its 20,000.
//   2. Nothing the guard stops (server/guard/scan.ts, the commit check's own): every file's text and every text value of
//      every copied database, scanned with the archive's private names and terms where this machine has an archive
//      (on a build server there is none: the patterns alone, emails, phone numbers, hosts, addresses, this machine's
//      names). Each finding says where and by which rule, never what it matched.
//   3. No file byte for byte any file in the archive's folder, whatever it is called (where there is one), but the
//      demo's own: the build checked, where it is built in that folder, and the main preview's builds there.

import "../../server/onPinnedNode.ts";
import "../../server/onSettings.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { DEMO_API_PATHS, DEMO_DATA } from "../../sdk/demo.ts";
import { archivesOf } from "../../server/dataHome.ts";
import { emptyDictionary, loadPrivateData } from "../../server/guard/dictionary.ts";
import { LIFE_ARCHIVE } from "../../server/guard/policies/lifeArchive.ts";
import { MAIN_PREVIEW_FOLDER } from "../../server/mainPreview.ts";
import { lineAndColumn, PrivacyScanner, RULES } from "../../server/guard/scan.ts";

/** Cloudflare Pages' limits: a file's size and a site's files. */
const MOST_BYTES = 25 * 1024 * 1024;
const MOST_FILES = 20_000;

/** What the check scans with: the guard's scanner, and the archive's folder to compare files against (none without one). */
export interface DemoPrivacy {
  scanner: PrivacyScanner;
  archive: string | null;
  /** What it could not check, in a line. */
  note?: string;
}

/** The guard's scanner over the archive at `archive` (its names and terms, when it has them), as the life archive's policy allows. */
export function privacyOf(archive: string): DemoPrivacy {
  const { dictionary, allowed, terms, note } = loadPrivateData(archive);
  let machine: string[] = [];
  try {
    machine = [userInfo().username, hostname().split(".")[0]!];
  } catch {
    // No user record (some sandboxes): nothing to add.
  }
  const scanner = new PrivacyScanner(dictionary ?? emptyDictionary(), { allowed: [...allowed, ...(LIFE_ARCHIVE.allowed ?? [])], machine, terms });
  return { scanner, archive: existsSync(archive) ? archive : null, ...(note ? { note } : {}) };
}

/**
 * The scan for a demo built beside the archives `archives` (dataHome.ts's archivesOf: in a worktree, the main checkout's
 * too): the first that holds the private dictionary, else the first, whose note says what could not be checked.
 */
export function privacyOfArchives(archives: readonly string[]): DemoPrivacy {
  const each = archives.map(privacyOf);
  if (each.length === 0) throw new Error("no archive's folder to check the demo against");
  return each.find((privacy) => privacy.note === undefined) ?? each[0]!;
}

/** The line a build or check says, loudly, when it ran without the archive's names. */
export const uncheckedLine = (note: string): string => `WARNING: the demo was checked without the archive's private names: ${note}. On a machine with an archive, that means the check did not find it.`;

/** Every file under `dir`, by its path from it. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name))).sort();
}

/** Which of a demo's files `path` is (see the top), or null for none. */
export function kindOf(path: string): "site" | "page" | "answer" | "database" | "served" | null {
  if (/(?:^|\/)\.env|\.sqlite\d?(?:-|$)|\.(?:log|jsonl)$/.test(path)) return null;
  if (["_redirects", "_headers", "404.html"].includes(path)) return "site";
  const data = DEMO_DATA.slice(1);
  if (path === `${data}/answers.json` || new RegExp(`^${data}/answers/[0-9a-f]{14}\\.json$`).test(path)) return "answer";
  if (path.startsWith(`${data}/db/`)) return path.endsWith(".gz") ? "database" : null;
  if (DEMO_API_PATHS.some((api) => path.startsWith(api.slice(1)))) return "served";
  if (/^[a-z0-9-]+\/(?:index\.html|404\.html|assets\/[\w.-]+\.(?:m?js|css|wasm|svg|png|jpg|webp|woff2?|ttf))$/.test(path)) return "page";
  return null;
}

/**
 * The rules that read only a shape of digits, which compiled code is full of (a minifier writes a hash's hex constants
 * as digits): left out for the pages' compiled code, built from the repository the guard checks commit by commit and
 * its packages; a real number the archive holds is still the dictionary's (accountId).
 */
const DIGIT_SHAPES: ReadonlySet<string> = new Set([RULES.phone, RULES.ip]);
const isCompiled = (path: string) => /\/assets\/[\w.-]+\.(?:m?js|css)$/.test(path);

/** A file read as text, for the scan: its bytes as UTF-8, any that are not shown as nothing. */
const textOf = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(bytes).replaceAll("�", " ");

/** Every text value of every table of the database `bytes`, a line each, with where it is. */
async function databaseText(bytes: Uint8Array): Promise<Array<{ where: string; text: string }>> {
  const scratch = await mkdtemp(join(tmpdir(), "life-archive-check-"));
  const file = join(scratch, "copy.sqlite");
  await writeFile(file, bytes);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    const found: Array<{ where: string; text: string }> = [];
    for (const { name } of tables) {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const columns = (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(name) as Array<{ name: string }>).map((c) => c.name);
      if (columns.length === 0) continue;
      const rows = db.prepare(`SELECT ${columns.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ")} FROM ${quoted}`).all() as Array<Record<string, unknown>>;
      const lines = rows.flatMap((row) => Object.values(row).filter((value): value is string => typeof value === "string"));
      if (lines.length > 0) found.push({ where: `table ${name}`, text: lines.join("\n") });
    }
    return found;
  } finally {
    db.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Every file in `dir` whose size is one of `sizes`, by size (the archive's folder, for the byte-for-byte check), but those under the folders `skip`. */
async function bySize(dir: string, sizes: ReadonlySet<number>, skip: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (skip.some((folder) => path.startsWith(`${folder}${sep}`))) continue;
    const size = await stat(path).then((s) => s.size, () => -1);
    if (sizes.has(size)) found.push(path);
  }
  return found;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** What is wrong with the demo built at `out` (see the top), a line each; none when it is fit to publish. */
export async function checkDemo(out: string, { scanner, archive }: DemoPrivacy): Promise<string[]> {
  const problems: string[] = [];
  const files = await filesUnder(out);
  if (files.length > MOST_FILES) problems.push(`${files.length} files: Cloudflare Pages takes at most ${MOST_FILES}`);
  const hashes = new Map<string, string>();
  const sizes = new Set<number>();
  for (const path of files) {
    const kind = kindOf(path);
    if (kind === null) {
      problems.push(`${path}: not a file a demo is made of`);
      continue;
    }
    const bytes = new Uint8Array(await readFile(join(out, path)));
    if (bytes.length > MOST_BYTES) problems.push(`${path}: ${bytes.length} bytes, over Cloudflare Pages' 25 MiB a file`);
    hashes.set(sha(bytes), path);
    sizes.add(bytes.length);
    const scan = (text: string, where: string) => {
      for (const finding of scanner.scan(text)) {
        if (isCompiled(path) && DIGIT_SHAPES.has(finding.rule)) continue;
        const { line, column } = lineAndColumn(text, finding.start);
        problems.push(`${path}${where ? ` (${where})` : ""}:${line}:${column}: ${finding.rule}`);
      }
    };
    if (kind === "database") {
      for (const { where, text } of await databaseText(gunzipSync(bytes))) scan(text, where);
    } else if (!/\.(?:wasm|png|jpg|webp|woff2?|ttf)$/.test(path) && !(kind === "served" && /^\x89PNG|^\xff\xd8|^RIFF/.test(String.fromCharCode(...bytes.slice(0, 4))))) {
      scan(textOf(bytes), "");
    }
  }
  if (archive !== null) {
    for (const file of await bySize(resolve(archive), sizes, [resolve(out), resolve(archive, MAIN_PREVIEW_FOLDER)])) {
      const same = hashes.get(sha(new Uint8Array(await readFile(file))));
      if (same) problems.push(`${same}: the same bytes as a file in the archive's folder`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const out = resolve(values.out ?? join(import.meta.dirname, "..", "..", "dist-demo"));
  if (!existsSync(out)) {
    console.error(`No demo in ${out}: npm run build:demo builds one.`);
    process.exit(2);
  }
  const privacy = privacyOfArchives(archivesOf());
  if (privacy.note) console.error(uncheckedLine(privacy.note));
  const problems = await checkDemo(out, privacy);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log(`The demo in ${out} holds only a demo's files, and nothing the guard stops.`);
}
