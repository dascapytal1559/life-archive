// The inspirations' boundary, beside sdk.test.ts's (which holds that no file of the core's imports a module, and a
// module the core through the SDK alone): nothing outside the module reads or writes their tables or their kept files,
// but the schema histories that made the tables before the module (the core's first migration; friend map's
// archive's, from when they were its) and the old friend map step's move, which copies the core's tables by the names
// coreDb.ts keeps of them. Tests may reach in, as they do everywhere. Read from the repository's own files, never data/.

import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The module's own folder. */
const OWN = "modules/inspirations/";

/** The schema histories that made their tables before the module, which may name them: shipped migrations are never edited. */
const SCHEMA_HISTORIES = ["server/archive/coreDb.ts", "modules/friend-map/server/db.ts"];

/** What may name where their files were kept before the module, as words: the privacy policy, which says what is kept there. */
const DESCRIBES = ["server/privacy/policy.ts"];

/** Every code file outside the module, but tests, with its text. */
function outside(): Array<{ file: string; text: string }> {
  return globSync(["**/*.ts", "**/*.tsx"], {
    cwd: ROOT,
    exclude: (path) => /^(?:data|dist[^/]*)(?:\/|$)|(?:^|\/)node_modules(?:\/|$)/.test(path),
  })
    .filter((file) => !file.startsWith(OWN) && !/\.test\.tsx?$/.test(file))
    .map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));
}

/** The lines of `text` (the file `file`) that read or write an inspiration table or a kept file, but its comments. */
function crossings(file: string, text: string): string[] {
  const sql = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES|ON)\s+inspiration(?:_[a-z_]+)?\b|["'`]inspiration(?:_[a-z_]+)?["'`]/;
  const kept = /platform-exports\/inspirations\b|modules\/inspirations\/files\b|["'`]inspirations["'`]\s*,\s*Readable/;
  return text.split("\n").flatMap((line, i) => {
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*") || line.trimStart().startsWith("--")) return [];
    if (sql.test(line) && !SCHEMA_HISTORIES.includes(file)) return [`${file}:${i + 1}: ${line.trim()}`];
    if (kept.test(line) && !DESCRIBES.includes(file)) return [`${file}:${i + 1}: ${line.trim()}`];
    return [];
  });
}

describe("the inspirations' boundary", () => {
  const files = outside();

  it("is where every read and write of their tables and kept files is", () => {
    expect(files.flatMap(({ file, text }) => crossings(file, text))).toEqual([]);
  });

  it("finds a table read or a kept file when there is one, so a pass is not a blind one", () => {
    expect(crossings("server/sample.ts", `db.prepare("SELECT id FROM inspiration_tag")`)).toEqual([`server/sample.ts:1: db.prepare("SELECT id FROM inspiration_tag")`]);
    expect(crossings("server/sample.ts", `const at = "modules/inspirations/files/ab";`)).toHaveLength(1);
    expect(crossings("server/sample.ts", `// FROM inspiration, said in a comment`)).toEqual([]);
    expect(files.some(({ file }) => file === "server/serverLayer.ts")).toBe(true);
    expect(files.some(({ file }) => file.startsWith(OWN))).toBe(false);
  });
});
