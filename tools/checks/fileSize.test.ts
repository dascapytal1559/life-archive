// The 1000-line cap and its ratchet (fileSize.ts): on made-up files, on a made-up checkout, and on this repository.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASELINE_FILE, codeFileLines, fileSizeProblems, isCode, lineCount, MAX_LINES, repositoryFileSizeProblems } from "./fileSize.ts";

const check = (files: Record<string, number>, baseline: Record<string, number> = {}) => fileSizeProblems({ files: new Map(Object.entries(files)), baseline });

describe("the file-size check", () => {
  it("passes files at the limit and a listed file at its ceiling", () => {
    expect(check({ "a.ts": MAX_LINES, "big.ts": 1500 }, { "big.ts": 1500 })).toEqual([]);
  });

  it("fails a new file over the limit, naming it, its lines and the limit, and asking for a split by responsibility", () => {
    const [problem, ...rest] = check({ "server/new.ts": 1001 });
    expect(rest).toEqual([]);
    expect(problem).toContain("server/new.ts has 1001 lines, over the 1000-line limit");
    expect(problem).toContain("by responsibility");
    expect(problem).toContain("not by line count");
  });

  it("fails a listed file that grows past its ceiling", () => {
    const [problem] = check({ "big.ts": 1501 }, { "big.ts": 1500 });
    expect(problem).toContain("big.ts has 1501 lines, over its ceiling of 1500");
    expect(problem).toContain("by responsibility");
  });

  it("asks for a listed file's ceiling to be lowered when it shrinks", () => {
    expect(check({ "big.ts": 1200 }, { "big.ts": 1500 })).toEqual([`big.ts shrank to 1200 lines: lower its ceiling in ${BASELINE_FILE} from 1500 to 1200.`]);
  });

  it("asks for a listed file to leave the list once it fits", () => {
    expect(check({ "big.ts": MAX_LINES }, { "big.ts": 1500 })).toEqual([`big.ts has 1000 lines, within the 1000-line limit: remove it from ${BASELINE_FILE}.`]);
  });

  it("asks for a listed file that is gone to leave the list", () => {
    expect(check({}, { "gone.ts": 1500 })).toEqual([`gone.ts is no longer a code file in the repository: remove it from ${BASELINE_FILE}.`]);
  });

  it("counts lines as an editor shows them", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("one")).toBe(1);
    expect(lineCount("one\n")).toBe(1);
    expect(lineCount("one\ntwo")).toBe(2);
    expect(lineCount("one\n\n")).toBe(2);
  });

  it("takes code by extension, and an extensionless file only as a script", () => {
    for (const path of ["a.ts", "b.tsx", "c.css", "d.swift", "e.sh", "f.command", "g.c", "h.html", "i.js", "j.mjs"]) expect(isCode(path, () => ""), path).toBe(true);
    for (const path of ["a.md", "b.json", "c.png", ".gitignore", ".env.example"]) expect(isCode(path, () => "#!/bin/sh\n"), path).toBe(false);
    expect(isCode("bin/run", () => "#!/bin/sh\n")).toBe(true);
    expect(isCode("NOTES", () => "plain words\n")).toBe(false);
  });
});

describe("a checkout's code files", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "life-archive-file-size-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("are the tracked and new ones git does not ignore, scripts among them", async () => {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, ".gitignore"), "ignored.ts\n");
    await writeFile(join(root, "tracked.ts"), "a\nb\n");
    await writeFile(join(root, "bin/run"), "#!/bin/sh\necho\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    await writeFile(join(root, "new.css"), "a\n");
    await writeFile(join(root, "ignored.ts"), "a\n");
    await writeFile(join(root, "notes.md"), "a\n");
    expect(Object.fromEntries(codeFileLines(root))).toEqual({ "bin/run": 2, "new.css": 1, "tracked.ts": 2 });
  });
});

describe("this repository", () => {
  it("keeps every code file within 1000 lines, or within its ceiling", () => {
    expect(repositoryFileSizeProblems()).toEqual([]);
  });
});
