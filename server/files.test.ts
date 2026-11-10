// The shared writers on a scratch folder: whole files, the mode asked for, a file once and never over one there, and no
// temporary file left behind either way.

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite, writeOnce } from "./files.ts";

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "files-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe("atomicWrite", () => {
  it("writes a file whole, in place of the one there, and leaves nothing else", async () => {
    const file = join(folder, "state.json");
    await atomicWrite(file, "one");
    await atomicWrite(file, "two");
    expect(await readFile(file, "utf8")).toBe("two");
    expect(await readdir(folder)).toEqual(["state.json"]);
  });

  it("makes the file with the mode asked for", async () => {
    const file = join(folder, "private.json");
    await atomicWrite(file, "{}", { mode: 0o600 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file when the write fails", async () => {
    await expect(atomicWrite(join(folder, "missing", "file.json"), "x")).rejects.toThrow();
    expect(await readdir(folder)).toEqual([]);
  });
});

describe("writeOnce", () => {
  it("writes a new file, and leaves one already there as it is", async () => {
    const file = join(folder, "call.json");
    expect(await writeOnce(file, "first", { mode: 0o600 })).toBe(true);
    expect(await writeOnce(file, "second")).toBe(false);
    expect(await readFile(file, "utf8")).toBe("first");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(folder)).toEqual(["call.json"]);
  });

  it("never replaces a file written by something else", async () => {
    const file = join(folder, "by-hand.md");
    await writeFile(file, "kept");
    expect(await writeOnce(file, "new")).toBe(false);
    expect(await readFile(file, "utf8")).toBe("kept");
  });
});
