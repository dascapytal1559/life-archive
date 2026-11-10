import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, plainText, sectionsOf } from "./markdown.ts";

describe("the Journal page's Markdown", () => {
  it("reads a day as the journals are shaped: its H1, a section a source with its italic line, paragraphs, and the comment citing its sources", () => {
    const blocks = parseMarkdown([
      "# Sunday 2026-11-08",
      "",
      "## A slow run along the creek",
      "",
      "*From voice memo 1, recorded 08:42. Verbatim in [raw/2026-11-08](raw/2026-11-08/); one guess in brackets.*",
      "",
      "Went out early. Did the loop past the [Larder?] bridge.",
      "Felt better after.",
      "",
      "<!-- sources: voicememo-20261108 084211-1A2B3C4D -->",
      "",
      "## Lunch with Ada",
      "",
      "Ate too much. <!-- sources: voice-0001 -->",
    ].join("\n"));
    expect(blocks.map((b) => b.type)).toEqual(["heading", "heading", "paragraph", "paragraph", "comment", "heading", "paragraph"]);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1, id: "sunday-2026-11-08" });
    const italic = blocks[2] as Extract<(typeof blocks)[number], { type: "paragraph" }>;
    expect(italic.children[0]).toMatchObject({ type: "em" });
    const para = blocks[3] as Extract<(typeof blocks)[number], { type: "paragraph" }>;
    expect(para.children).toEqual([
      { type: "text", text: "Went out early. Did the loop past the " },
      { type: "guess", text: "Larder" },
      { type: "text", text: " bridge." },
      { type: "break" },
      { type: "text", text: "Felt better after." },
    ]);
    const sections = sectionsOf(blocks);
    expect(sections.map((s) => [s.heading && plainText(s.heading.children), s.sources])).toEqual([
      [null, []],
      ["A slow run along the creek", ["voicememo-20261108 084211-1A2B3C4D"]],
      ["Lunch with Ada", ["voice-0001"]],
    ]);
  });

  it("hides a comment over several lines, and leaves out front matter", () => {
    const blocks = parseMarkdown("---\ntags: x\n---\nBefore <!-- a\nlong\nnote --> after\n\n<!--\nsources: m1\n-->");
    expect(blocks).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "Before " }, { type: "comment", text: "a\nlong\nnote" }, { type: "text", text: " after" }] },
      { type: "comment", text: "sources: m1" },
    ]);
  });

  it("reads lists, nested, numbered and ticked, quotes, code and rules", () => {
    const blocks = parseMarkdown("- one\n- two\n  - two a\n- [x] done\n\n3. third\n4. fourth\n\n> quoted\n> on\n\n```\ncode *not em*\n```\n\n---");
    expect(blocks.map((b) => b.type)).toEqual(["list", "list", "quote", "code", "rule"]);
    const list = blocks[0] as Extract<(typeof blocks)[number], { type: "list" }>;
    expect(list.items).toHaveLength(3);
    expect(list.items[1]!.blocks.map((b) => b.type)).toEqual(["paragraph", "list"]);
    expect(list.items[2]!.task).toBe(true);
    expect(blocks[1]).toMatchObject({ ordered: true, start: 3 });
    expect(blocks[3]).toEqual({ type: "code", lang: "", text: "code *not em*" });
  });

  it("reads the marks, links, images, wikilinks and bare addresses, and draws no HTML", () => {
    expect(parseInline("**bold** *it* _it_ ~~gone~~ ==lit== `co*de` snake_case_name")).toEqual([
      { type: "strong", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "it" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "it" }] },
      { type: "text", text: " " },
      { type: "del", children: [{ type: "text", text: "gone" }] },
      { type: "text", text: " " },
      { type: "mark", children: [{ type: "text", text: "lit" }] },
      { type: "text", text: " " },
      { type: "code", text: "co*de" },
      { type: "text", text: " snake_case_name" },
    ]);
    expect(parseInline("![a photo](assets/2026-11-08/apple-journal/one.jpg) [[2026-11-07|Saturday]] ![[pic.png]]")).toEqual([
      { type: "image", alt: "a photo", src: "assets/2026-11-08/apple-journal/one.jpg" },
      { type: "text", text: " " },
      { type: "wikilink", target: "2026-11-07", label: "Saturday", embed: false },
      { type: "text", text: " " },
      { type: "wikilink", target: "pic.png", label: "pic.png", embed: true },
    ]);
    expect(parseInline("see https://example.com/a, or [the site](https://example.com) <b>hi</b>")).toEqual([
      { type: "text", text: "see " },
      { type: "link", href: "https://example.com/a", children: [{ type: "text", text: "https://example.com/a" }] },
      { type: "text", text: ", or " },
      { type: "link", href: "https://example.com", children: [{ type: "text", text: "the site" }] },
      { type: "text", text: " <b>hi</b>" },
    ]);
    // A bracket that is no guess and no link is text.
    expect(parseInline("[just brackets] and 2 * 3 * 4")).toEqual([{ type: "text", text: "[just brackets] and 2 * 3 * 4" }]);
  });
});
