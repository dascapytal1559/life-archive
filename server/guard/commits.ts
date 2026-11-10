// What a commit, a push or a range of commits would publish, as the guard reads it from git: each commit's message
// and the lines and new file names its diff adds (never what it removes), its author's and committer's emails, and,
// for a commit being made, what is staged (for a merge, as its push will read it). git runs in the guarded repository
// with the environment it was given, so a hook sees the index git means (GIT_INDEX_FILE, for `git commit -a` or a
// partial commit).

import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { run, type RunFailed } from "../childProcess.ts";

/** git's output in the repository at `top`, or a RunFailed. */
export const git = (top: string, args: string[]): Effect.Effect<string, RunFailed> => run("git", ["-C", top, ...args]).pipe(Effect.map(({ stdout }) => stdout));

/** Whether git succeeds, for a question asked by exit code (does this object exist?). */
const succeeds = (top: string, args: string[]) => git(top, args).pipe(Effect.as(true), Effect.catchTag("RunFailed", () => Effect.succeed(false)));

/** What a diff adds to one file: its runs of added lines, numbered as in the new file, and whether its name is new too. */
export interface AddedFile {
  path: string;
  /** New, or newly named, so its name is published too. */
  named: boolean;
  /** A binary file, whose contents the diff does not show. */
  binary: boolean;
  runs: { first: number; lines: string[] }[];
}

/** What one commit adds: its message and the lines and new file names its diff adds. */
export interface CommitMaterial {
  /** The commit's full sha, as the record of reviewed commits keeps it. */
  sha: string;
  /** The short id the model and the report use. */
  id: string;
  message: string;
  files: AddedFile[];
}

/** A unit of text to scan and how to name a place in it. */
export interface Text {
  text: string;
  place: (line: number, column: number) => string;
  /** What it is, the same whichever check reads it (judgements.ts): a file's path, "<path> (its file name)" or "commit message". */
  subject: string;
}

export const MESSAGE = "commit message";

const unquote = (path: string) => path.replace(/^"(.*)"$/, "$1");

/** The files a diff adds to (written with --no-renames, so a file has one name), each with what it adds; deletions are left out. */
export function addedFiles(diff: string): AddedFile[] {
  const files: AddedFile[] = [];
  let file: AddedFile | undefined;
  let named = false;
  let next = 0;
  let run: { first: number; lines: string[] } | undefined;
  const begin = (path: string, binary = false) => {
    file = { path, named, binary, runs: [] };
    files.push(file);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      [file, named, run] = [undefined, false, undefined];
    } else if (line.startsWith("new file mode")) {
      named = true;
    } else if (!file && line.startsWith("+++ ")) {
      const target = unquote(line.slice(4));
      if (target !== "/dev/null") begin(target.replace(/^b\//, ""));
    } else if (!file && line.startsWith("Binary files ")) {
      const target = unquote(/ and (.*) differ$/.exec(line)?.[1] ?? "/dev/null");
      if (target !== "/dev/null") begin(target.replace(/^b\//, ""), true);
    } else if (line.startsWith("@@")) {
      run = undefined;
      next = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (line.startsWith("+") && file) {
      if (!run) file.runs.push((run = { first: next, lines: [] }));
      run.lines.push(line.slice(1));
      next++;
    } else if (line.startsWith("-") || line.startsWith("\\")) {
      // removed lines and "\ No newline at end of file" don't move the new side
    } else {
      run = undefined;
    }
  }
  return files.filter((f) => f.named || f.binary || f.runs.length > 0);
}

/** The lines a diff adds, each run of them as one text (so a name broken over two lines is still one), and every new file's name. */
export function addedTexts(diff: string, prefix = ""): Text[] {
  return filesTexts(addedFiles(diff), prefix);
}

function filesTexts(files: AddedFile[], prefix: string): Text[] {
  return files.flatMap(({ path, named, runs }) => [
    ...(named ? [{ text: path, place: () => `${prefix}${path} (its file name)`, subject: `${path} (its file name)` }] : []),
    ...runs.map(({ first, lines }) => ({ text: lines.join("\n"), place: (line: number, column: number) => `${prefix}${path}:${first + line - 1}:${column}`, subject: path })),
  ]);
}

/** A commit's message and what it adds, as texts to scan. */
export function commitTexts({ id, message, files }: CommitMaterial): Text[] {
  return [{ text: message, place: (line, column) => `${id} ${MESSAGE}, line ${line}, column ${column}`, subject: MESSAGE }, ...filesTexts(files, `${id} `)];
}

/** A commit message as git will keep it: comment lines blanked (so line numbers still match) and nothing from the scissors line on. */
export function messageText(message: string, commentChar = "#"): string {
  const lines = message.split("\n");
  const scissors = lines.findIndex((l) => l === `${commentChar} ------------------------ >8 ------------------------`);
  return (scissors === -1 ? lines : lines.slice(0, scissors)).map((l) => (l.startsWith(commentChar) ? "" : l)).join("\n");
}

const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0", "--src-prefix=a/", "--dst-prefix=b/"];

/** What the commit being made adds: the staged lines and new file names. */
export const stagedTexts = (top: string) => git(top, ["-c", "core.quotePath=false", "diff", "--cached", ...DIFF]).pipe(Effect.map((diff) => addedTexts(diff)));

/** The commits a merge being made merges into HEAD (MERGE_HEAD: one, or an octopus's several), or none when no merge is under way. */
export const mergeHeads = (top: string) =>
  Effect.gen(function* () {
    const file = (yield* git(top, ["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"])).trim();
    const heads = yield* Effect.promise(() => readFile(file, "utf8").catch(() => ""));
    return heads.split("\n").map((line) => line.trim()).filter(Boolean);
  });

/**
 * A commit's message and what its diff adds. A merge of two adds only what its resolution changed from the merge git
 * would have made by itself (a remerge diff): what each side brings is checked as that side's own commits, or is
 * published or settled already. An octopus merge, which git cannot remerge, is read against its first parent.
 */
const commitMaterial = (top: string, sha: string) =>
  Effect.gen(function* () {
    const [parents = "", message = ""] = (yield* git(top, ["log", "-1", "--format=%P%x00%B", sha])).split("\0");
    const merges = parents.trim().split(" ").length > 2 ? "first-parent" : "remerge";
    const diff = yield* git(top, ["-c", "core.quotePath=false", "show", "--format=", `--diff-merges=${merges}`, ...DIFF, sha]);
    return { sha, id: sha.slice(0, 7), message, files: addedFiles(diff) } satisfies CommitMaterial;
  });

/** Each commit's material, in the order given. */
export const commitsMaterial = (top: string, shas: Iterable<string>) => Effect.forEach(shas, (sha) => commitMaterial(top, sha));

/**
 * What a merge being made adds, read as a push will read its commit (commitMaterial): what is staged, made into a
 * commit of HEAD and the merged heads that no ref names, so its remerge diff gives what the resolution adds to the
 * merge git would have made by itself (an octopus's, against HEAD). That commit is never used, and git prunes it.
 */
export const stagedMergeTexts = (top: string, heads: string[]) =>
  Effect.gen(function* () {
    const tree = (yield* git(top, ["write-tree"])).trim();
    const parents = ["HEAD", ...heads].flatMap((parent) => ["-p", parent]);
    const sha = (yield* git(top, ["-c", "commit.gpgSign=false", "commit-tree", tree, ...parents, "-m", "The guard's reading of the merge being made"])).trim();
    return filesTexts((yield* commitMaterial(top, sha)).files, "");
  });

/** Who a commit says made it: the emails of its author and its committer, which publishing it publishes too. */
export interface CommitIdentity {
  sha: string;
  /** The short id the report uses. */
  id: string;
  author: string;
  committer: string;
}

/** Each commit's author and committer emails, in the order given, a few hundred commits to a git call. */
export const identities = (top: string, shas: string[]) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(shas.length / 500) }, (_, i) => shas.slice(i * 500, (i + 1) * 500)),
    (part) => git(top, ["log", "--no-walk=unsorted", "--format=%H%x00%ae%x00%ce", ...part]),
  ).pipe(
    Effect.map((outs) =>
      outs.flatMap((out) =>
        out.split("\n").filter(Boolean).map((line): CommitIdentity => {
          const [sha = "", author = "", committer = ""] = line.split("\0");
          return { sha, id: sha.slice(0, 7), author, committer };
        }),
      ),
    ),
  );

/** The commits the revisions name, oldest first, but those `not` reaches (`--remotes=upstream`, a commit settled with its history). */
export const revList = (top: string, revisions: string[], not: string[] = []) =>
  git(top, ["rev-list", "--reverse", ...revisions, ...(not.length > 0 ? ["--not", ...not] : [])]).pipe(Effect.map((out) => out.split("\n").filter(Boolean)));

const ZERO = /^0+$/;

/** One ref a push sends, as git gives it to pre-push: the local ref and its sha, and the remote ref and the sha it has. */
export interface PushedRef {
  localRef: string;
  local: string;
  remoteRef: string;
  remoteSha: string;
}

/** The refs a push sends, from pre-push's standard input, one a line. */
export const pushedRefs = (refs: string): PushedRef[] =>
  refs
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [localRef = "", local = "", remoteRef = "", remoteSha = ""] = line.split(" ");
      return { localRef, local, remoteRef, remoteSha };
    });

/** Whether a pushed ref deletes the remote's, which sends nothing. */
export const isDeletion = (ref: PushedRef) => !ref.local || ZERO.test(ref.local);

/**
 * The commits a push sends, each once, oldest first: from what the remote has to what is pushed, or all not yet on the
 * remote; but those `not` reaches.
 */
export const pushShas = (top: string, remote: string, refs: PushedRef[], not: string[] = []) =>
  Effect.gen(function* () {
    const shas = new Set<string>();
    for (const ref of refs) {
      if (isDeletion(ref)) continue;
      const { local, remoteSha } = ref;
      const known = !ZERO.test(remoteSha || "0") && (yield* exists(top, remoteSha));
      for (const sha of yield* revList(top, known ? [`${remoteSha}..${local}`] : [local], known ? not : [`--remotes=${remote}`, ...not])) shas.add(sha);
    }
    return [...shas];
  });

/** Whether the repository has this commit. */
export const exists = (top: string, sha: string) => succeeds(top, ["cat-file", "-e", `${sha}^{commit}`]);

/** A file as a commit has it, or undefined where that commit has no such file. */
export const fileAt = (top: string, commit: string, path: string) =>
  Effect.gen(function* () {
    if (!(yield* succeeds(top, ["cat-file", "-e", `${commit}:${path}`]))) return undefined;
    return yield* git(top, ["show", `${commit}:${path}`]);
  });

/** A setting from the repository's config (its own, the user's and the system's), or undefined. */
export const gitConfig = (top: string, key: string, scope: string[] = []) =>
  git(top, ["config", ...scope, "--get", key]).pipe(
    Effect.map((value) => value.trim() || undefined),
    Effect.catchTag("RunFailed", () => Effect.succeed(undefined)),
  );
