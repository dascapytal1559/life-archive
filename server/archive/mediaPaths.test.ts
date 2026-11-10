import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homeOf, homeRank, localPathOf, resolveLocalPath } from "./mediaPaths.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-media-paths-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = { sha256: "0".repeat(64), size: 1 };

describe("localPathOf", () => {
  it("names a live copy and a file kept in place, both under platform-exports/, relative to the data folder", () => {
    expect(localPathOf({ stored: { ...file, path: "telegram/live/ab/abc.jpg" } }, undefined)).toBe("platform-exports/telegram/live/ab/abc.jpg");
    expect(localPathOf({ inPlace: { ...file, path: join(dir, "platform-exports/instagram/2026-10-05/a/1.jpg") } }, dir))
      .toBe("platform-exports/instagram/2026-10-05/a/1.jpg");
    expect(localPathOf({}, dir)).toBeNull();
  });

  it("refuses a file kept in place anywhere else", () => {
    for (const path of [join(dir, "archive.sqlite"), join(dir, "platform-exports"), join(dir, "platform-exports/../backups/x"), "/tmp/x.jpg"]) {
      expect(() => localPathOf({ inPlace: { ...file, path } }, dir), path).toThrow(/must be inside/);
    }
    expect(() => localPathOf({ inPlace: { ...file, path: join(dir, "platform-exports/x.jpg") } }, undefined)).toThrow(/needs the data folder/);
  });
});

describe("homeOf and homeRank", () => {
  it("tell an export, the live folder and an old copy apart", () => {
    expect(homeOf("platform-exports/messenger/2026-09-28/your_facebook_activity/messages/inbox/a_1/photos/1.jpg"))
      .toEqual({ kind: "export", platform: "messenger", folder: "2026-09-28" });
    expect(homeOf("platform-exports/telegram/live/ab/abc.jpg")).toEqual({ kind: "export", platform: "telegram", folder: "live" });
    expect(homeOf("archive/media/whatsapp/ab/abc.jpg")).toEqual({ kind: "copies", platform: "whatsapp" });
    for (const path of ["archive.sqlite", "platform-exports/messenger/x.jpg", "archive/media/x.jpg", "platform-exports/../backups/a/b"]) {
      expect(homeOf(path), path).toBeNull();
    }
  });

  it("rank a later export over an earlier one, any export over the live folder, and the live folder over an old copy", () => {
    const ordered = [
      "archive/media/messenger/ab/abc.jpg",
      "platform-exports/messenger/live/ab/abc.jpg",
      "platform-exports/messenger/2026-09-28/a/1.jpg",
      "platform-exports/messenger/2026-10-06/a/1.jpg",
    ];
    for (let i = 1; i < ordered.length; i++) expect(homeRank(ordered[i]) > homeRank(ordered[i - 1]), ordered[i]).toBe(true);
  });
});

describe("resolveLocalPath", () => {
  it("finds files only inside archive/media/ or platform-exports/, wherever a symlink points", async () => {
    await mkdir(join(dir, "archive/media/x"), { recursive: true });
    await mkdir(join(dir, "platform-exports/instagram"), { recursive: true });
    await writeFile(join(dir, "archive/media/x/1.jpg"), "a");
    await writeFile(join(dir, "platform-exports/instagram/2.jpg"), "b");
    await writeFile(join(dir, "archive.sqlite"), "c");
    await symlink(join(dir, "archive.sqlite"), join(dir, "platform-exports/instagram/link.jpg"));
    expect(await resolveLocalPath(dir, "archive/media/x/1.jpg")).toMatch(/archive\/media\/x\/1\.jpg$/);
    expect(await resolveLocalPath(dir, "platform-exports/instagram/2.jpg")).toMatch(/platform-exports\/instagram\/2\.jpg$/);
    for (const path of ["archive.sqlite", "platform-exports/instagram/link.jpg", "platform-exports/../archive.sqlite", "archive/media"]) {
      expect(await resolveLocalPath(dir, path), path).toBeNull();
    }
  });
});
