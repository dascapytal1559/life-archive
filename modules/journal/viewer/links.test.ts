import { describe, expect, it } from "vitest";
import { JOURNAL_API } from "../wire.ts";
import { noteAsset, opensOutside, rawFileOf } from "./links.ts";

describe("what a day's links and pictures may reach", () => {
  it("opens the web, mail and a note in Obsidian outside the page, but none of Obsidian's actions that write to the vault", () => {
    expect(opensOutside("https://example.com/a")).toBe(true);
    expect(opensOutside("mailto:someone@example.com")).toBe(true);
    expect(opensOutside("obsidian://open?vault=Notes&file=Journals%2F2026-11-08")).toBe(true);
    expect(opensOutside("obsidian://new?vault=Notes&file=Journals%2F2026-11-08&content=gone&overwrite=true")).toBe(false);
    expect(opensOutside("obsidian://new?vault=Notes&name=x&append=true")).toBe(false);
    expect(opensOutside("obsidian:new?vault=Notes")).toBe(false);
    expect(opensOutside("javascript:alert(1)")).toBe(false);
  });

  it("shows a picture of a day's assets/ at the module's route, its steps encoded", () => {
    expect(noteAsset("assets/2026-11-08/photos/creek walk.jpg")).toBe(`${JOURNAL_API}/days/2026-11-08/assets/photos/creek%20walk.jpg`);
    expect(noteAsset("./assets/2026-11-08/creek%20walk.jpg")).toBe(`${JOURNAL_API}/days/2026-11-08/assets/creek%20walk.jpg`);
  });

  it("refuses a picture whose path steps out of the day's assets/, or names nothing, or a hidden file", () => {
    expect(noteAsset("assets/2026-11-08/../../2026-11-01")).toBeNull();
    expect(noteAsset("assets/2026-11-08/%2E%2E/%2E%2E/2026-11-01")).toBeNull();
    expect(noteAsset("assets/2026-11-08/./a.jpg")).toBeNull();
    expect(noteAsset("assets/2026-11-08/photos//a.jpg")).toBeNull();
    expect(noteAsset("assets/2026-11-08/.hidden.jpg")).toBeNull();
    expect(noteAsset("images/a.jpg")).toBeNull();
  });

  it("takes a malformed address for nothing rather than failing", () => {
    expect(noteAsset("assets/2026-11-08/50%.jpg")).toBeNull();
    expect(rawFileOf("raw/2026-11-08/50%.md", "2026-11-08")).toBeNull();
  });

  it("reads which file of the day's raw/ a link is to, and nothing for another day or folder", () => {
    expect(rawFileOf("raw/2026-11-08/memo%201.md", "2026-11-08")).toBe("memo 1.md");
    expect(rawFileOf("./raw/2026-11-08/memo.md", "2026-11-08")).toBe("memo.md");
    expect(rawFileOf("raw/2026-11-07/memo.md", "2026-11-08")).toBeNull();
    expect(rawFileOf("raw/2026-11-08/", "2026-11-08")).toBeNull();
  });
});
