// Every hand-written code file is at most 1000 lines, so an agent can read one whole and the file tree stays the map of
// what does what. The files that were longer when the cap came in are on a ratchet (oversized-files.json): each may not
// grow past the length it records, its ceiling is lowered as it shrinks, and it leaves the list once it fits.
// fileSize.test.ts runs this on the repository.
//   npm run file-size

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { REPO } from "../../server/dataHome.ts";

export const MAX_LINES = 1000;

/** The ratchet, from the repository's root: each oversized file and the most lines it may have. */
export const BASELINE_FILE = "oversized-files.json";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".css", ".swift", ".sh", ".command", ".c", ".html", ".js", ".mjs"]);

/** Whether a file is code: by its extension, or, with none, by starting as a script does (`#!`). */
export const isCode = (path: string, text: () => string): boolean => {
  const name = basename(path);
  return name.includes(".") ? CODE_EXTENSIONS.has(extname(name)) : text().startsWith("#!");
};

/** The lines a text has, a last line without its newline counted too. */
export const lineCount = (text: string): number => {
  if (text === "") return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
};

const SPLIT = "split it by responsibility (each part with one job), not by line count";

/** What is wrong with these code files' lengths, given the ratchet; none when all is well. */
export function fileSizeProblems({ files, baseline }: { files: ReadonlyMap<string, number>; baseline: Readonly<Record<string, number>> }): string[] {
  const problems: string[] = [];
  for (const [path, lines] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const ceiling = baseline[path];
    if (ceiling === undefined) {
      if (lines > MAX_LINES) problems.push(`${path} has ${lines} lines, over the ${MAX_LINES}-line limit: ${SPLIT}.`);
    } else if (lines <= MAX_LINES) {
      problems.push(`${path} has ${lines} lines, within the ${MAX_LINES}-line limit: remove it from ${BASELINE_FILE}.`);
    } else if (lines > ceiling) {
      problems.push(`${path} has ${lines} lines, over its ceiling of ${ceiling} in ${BASELINE_FILE} (the limit is ${MAX_LINES}, and a file over it may not grow): ${SPLIT}.`);
    } else if (lines < ceiling) {
      problems.push(`${path} shrank to ${lines} lines: lower its ceiling in ${BASELINE_FILE} from ${ceiling} to ${lines}.`);
    }
  }
  for (const path of Object.keys(baseline).sort()) {
    if (!files.has(path)) problems.push(`${path} is no longer a code file in the repository: remove it from ${BASELINE_FILE}.`);
  }
  return problems;
}

/** Each code file git tracks, or would (new files it does not ignore), in the checkout at `root`, with its lines. */
export function codeFileLines(root = REPO): Map<string, number> {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  const files = new Map<string, number>();
  for (const path of new Set(listed.split("\0").filter(Boolean))) {
    const file = join(root, path);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    let text: string | undefined;
    const read = () => (text ??= readFileSync(file, "utf8"));
    if (isCode(path, read)) files.set(path, lineCount(read()));
  }
  return files;
}

export const readBaseline = (root = REPO): Record<string, number> => JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8"));

/** The problems in the checkout at `root`. */
export const repositoryFileSizeProblems = (root = REPO): string[] =>
  fileSizeProblems({ files: codeFileLines(root), baseline: readBaseline(root) });

if (import.meta.main) {
  const problems = repositoryFileSizeProblems();
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`Every code file is within ${MAX_LINES} lines, or within its ceiling in ${BASELINE_FILE}.`);
}
