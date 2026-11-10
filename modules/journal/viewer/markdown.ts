// The Journal page's Markdown, its own and small (no library), for what the journals use and what Obsidian shows of
// it: headings, paragraphs (a single newline a line break, as Obsidian shows one), lists (nested, numbered, tasks),
// quotes, code, rules, emphasis, strong, struck and highlighted text, inline code, links (bare ones too), images, the
// wikilinks [[target|label]] and embeds ![[file]], front matter (left out), and HTML comments (hidden, kept so a
// section's `<!-- sources: … -->` can be read). A word the cleaner was unsure of stays in brackets, `[like this?]`
// (the cleaning guide's rule), and is a `guess` of its own, so the page can mark it. Raw HTML is never drawn: what is
// not Markdown is text. Parsing is plain code over a string into a tree (this file); Markdown.tsx draws the tree.

export type Inline =
  | { type: "text"; text: string }
  | { type: "em" | "strong" | "del" | "mark"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "image"; src: string; alt: string }
  | { type: "wikilink"; target: string; label: string; embed: boolean }
  | { type: "guess"; text: string }
  | { type: "comment"; text: string }
  | { type: "break" };

export interface ListItem {
  /** A task's box: checked or not; null for a plain item. */
  task: boolean | null;
  blocks: Block[];
}

export type Block =
  | { type: "heading"; level: number; id: string; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "quote"; blocks: Block[] }
  | { type: "code"; lang: string; text: string }
  | { type: "rule" }
  | { type: "comment"; text: string };

const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(```+|~~~+)\s*([\w+-]*)/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;

/** The text a heading's id is made from: its words, lowercased, joined with dashes. */
function slug(children: Inline[]): string {
  return plainText(children).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
}

/** The words of inline content, without its marks. */
export function plainText(children: readonly Inline[]): string {
  return children
    .map((node) => {
      if (node.type === "text" || node.type === "code" || node.type === "guess") return node.text;
      if (node.type === "break") return " ";
      if (node.type === "wikilink") return node.label;
      if (node.type === "image" || node.type === "comment") return "";
      return plainText(node.children);
    })
    .join("");
}

/** Lines with each HTML comment that runs over several of them joined into one, so a comment is never split. */
function logicalLines(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    while (line.lastIndexOf("<!--") > line.lastIndexOf("-->") && i + 1 < lines.length) line += `\n${lines[++i]}`;
    out.push(line);
  }
  return out;
}

const indentOf = (line: string): number => /^[ \t]*/.exec(line)![0].replace(/\t/g, "    ").length;

function dedent(line: string, by: number): string {
  let removed = 0;
  let at = 0;
  while (at < line.length && removed < by && (line[at] === " " || line[at] === "\t")) {
    removed += line[at] === "\t" ? 4 : 1;
    at++;
  }
  return line.slice(at);
}

/** Parses Markdown into blocks; a note's front matter is left out. */
export function parseMarkdown(markdown: string): Block[] {
  let lines = logicalLines(markdown);
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) lines = lines.slice(end + 1);
  }
  const ids = new Map<string, number>();
  return blocksOf(lines, ids);
}

function blocksOf(lines: readonly string[], ids: Map<string, number>): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      flush();
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      while (++i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) body.push(lines[i]!);
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("<!--") && trimmed.endsWith("-->") && trimmed.indexOf("-->") === trimmed.length - 3) {
      flush();
      blocks.push({ type: "comment", text: trimmed.slice(4, -3).trim() });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const children = parseInline(heading[2]!);
      const base = slug(children);
      const seen = ids.get(base) ?? 0;
      ids.set(base, seen + 1);
      blocks.push({ type: "heading", level: heading[1]!.length, id: seen === 0 ? base : `${base}-${seen + 1}`, children });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      i--;
      blocks.push({ type: "quote", blocks: blocksOf(body, ids) });
      continue;
    }
    if (ITEM.test(line) && (paragraph.length === 0 || indentOf(line) === 0)) {
      flush();
      i = listAt(lines, i, ids, blocks) - 1;
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Parses the list starting at line `start` into `blocks`; the line after it. */
function listAt(lines: readonly string[], start: number, ids: Map<string, number>, blocks: Block[]): number {
  const first = ITEM.exec(lines[start]!)!;
  const indent = indentOf(lines[start]!);
  const ordered = /\d/.test(first[2]!);
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const item = ITEM.exec(lines[i]!);
    if (!item || indentOf(lines[i]!) !== indent || /\d/.test(item[2]!) !== ordered) break;
    // What follows the marker sets how far the item's own lines are indented.
    const inner = indent + item[2]!.length + 1;
    const body = [item[3]!];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.trim() === "") {
        // A blank line ends the item unless what follows is indented into it.
        const after = lines.slice(i + 1).find((l) => l.trim() !== "");
        if (after === undefined || indentOf(after) < inner) break;
        body.push("");
        i++;
        continue;
      }
      if (indentOf(next) <= indent && (ITEM.test(next) || indentOf(next) < inner)) {
        if (ITEM.test(next) || HEADING.test(next) || QUOTE.test(next) || RULE.test(next)) break;
        // A lazy line, not indented, carries on the item's paragraph.
        if (indentOf(next) === 0 && body.at(-1) !== "") {
          body.push(next);
          i++;
          continue;
        }
        break;
      }
      body.push(dedent(next, Math.min(inner, indentOf(next))));
      i++;
    }
    const task = /^\[([ xX])\][ \t]+/.exec(body[0]!);
    if (task) body[0] = body[0]!.slice(task[0].length);
    items.push({ task: task ? task[1] !== " " : null, blocks: blocksOf(body, ids) });
    while (i < lines.length && lines[i]!.trim() === "" && ITEM.test(lines.slice(i).find((l) => l.trim() !== "") ?? "")) i++;
  }
  blocks.push({ type: "list", ordered, start: ordered ? Number(/\d+/.exec(first[2]!)![0]) : 1, items });
  return i;
}

const URL_START = /^(https?:\/\/|obsidian:\/\/|mailto:)/i;

/** Parses inline Markdown: marks, links, images, wikilinks, guesses, comments; anything else is text. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const push = (node: Inline) => {
    if (text) out.push({ type: "text", text });
    text = "";
    out.push(node);
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const rest = source.slice(i);
    if (c === "\\" && i + 1 < source.length && /[\\`*_{}[\]()#+\-.!|~=<>]/.test(source[i + 1]!)) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      push({ type: "break" });
      i++;
      continue;
    }
    if (rest.startsWith("<!--")) {
      const end = source.indexOf("-->", i + 4);
      const close = end === -1 ? source.length : end;
      push({ type: "comment", text: source.slice(i + 4, close).trim() });
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (c === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const end = source.indexOf(ticks, i + ticks.length);
      if (end !== -1) {
        push({ type: "code", text: source.slice(i + ticks.length, end).replace(/^ (.*) $/s, "$1") });
        i = end + ticks.length;
        continue;
      }
    }
    const wiki = /^(!?)\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/.exec(rest);
    if (wiki) {
      push({ type: "wikilink", target: wiki[2]!.trim(), label: (wiki[3] ?? wiki[2]!).trim(), embed: wiki[1] === "!" });
      i += wiki[0].length;
      continue;
    }
    const image = /^!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
    if (image) {
      push({ type: "image", alt: image[1]!, src: image[2]! });
      i += image[0].length;
      continue;
    }
    if (c === "[") {
      const close = matching(source, i);
      if (close !== -1) {
        const href = /^\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(source.slice(close + 1));
        if (href) {
          push({ type: "link", href: href[1]!, children: parseInline(source.slice(i + 1, close)) });
          i = close + 1 + href[0].length;
          continue;
        }
        const inside = source.slice(i + 1, close);
        if (inside.endsWith("?") && inside.length > 1 && !inside.includes("\n")) {
          push({ type: "guess", text: inside.slice(0, -1) });
          i = close + 1;
          continue;
        }
      }
    }
    if (c === "<") {
      const auto = /^<((?:https?|obsidian|mailto):[^>\s]+)>/i.exec(rest);
      if (auto) {
        push({ type: "link", href: auto[1]!, children: [{ type: "text", text: auto[1]! }] });
        i += auto[0].length;
        continue;
      }
    }
    if ((i === 0 || /[\s(]/.test(source[i - 1]!)) && URL_START.test(rest)) {
      const url = /^\S+/.exec(rest)![0].replace(/[.,;:!?)\]'"]+$/, "");
      push({ type: "link", href: url, children: [{ type: "text", text: url }] });
      i += url.length;
      continue;
    }
    const mark = markAt(source, i);
    if (mark) {
      push({ type: mark.type, children: parseInline(source.slice(i + mark.width, mark.end)) });
      i = mark.end + mark.width;
      continue;
    }
    text += c;
    i++;
  }
  if (text) out.push({ type: "text", text });
  return out;
}

/** The `]` that closes the `[` at `open`, brackets nested, on the same paragraph; -1 for none. */
function matching(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === "[") depth++;
    else if (source[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

const MARKS: ReadonlyArray<{ open: string; type: "em" | "strong" | "del" | "mark" }> = [
  { open: "**", type: "strong" },
  { open: "__", type: "strong" },
  { open: "~~", type: "del" },
  { open: "==", type: "mark" },
  { open: "*", type: "em" },
  { open: "_", type: "em" },
];

/** A mark opening at `i` (emphasis, strong, struck, highlighted), with where it closes, or null. */
function markAt(source: string, i: number): { type: "em" | "strong" | "del" | "mark"; width: number; end: number } | null {
  for (const { open, type } of MARKS) {
    if (!source.startsWith(open, i)) continue;
    const after = source[i + open.length];
    if (after === undefined || /\s/.test(after)) continue;
    // An underscore inside a word (snake_case) is a letter, not a mark.
    if (open[0] === "_" && i > 0 && /[\p{L}\p{N}]/u.test(source[i - 1]!)) continue;
    let from = i + open.length + 1;
    while (from <= source.length) {
      const end = source.indexOf(open, from);
      if (end === -1) break;
      const closesWord = open[0] !== "_" || end + open.length >= source.length || !/[\p{L}\p{N}]/u.test(source[end + open.length]!);
      // A single * or _ is not the first of a double one; a closer follows a non-space.
      const single = open.length === 1 && (source[end + 1] === open || source[end - 1] === open);
      if (!/\s/.test(source[end - 1]!) && closesWord && !single) return { type, width: open.length, end };
      from = end + 1;
    }
  }
  return null;
}

/** The text of every comment in `blocks`, block or inline, in order. */
export function commentsIn(blocks: readonly Block[]): string[] {
  const inline = (nodes: readonly Inline[]): string[] =>
    nodes.flatMap((node) => (node.type === "comment" ? [node.text] : "children" in node ? inline(node.children) : []));
  return blocks.flatMap((block): string[] => {
    if (block.type === "comment") return [block.text];
    if (block.type === "heading" || block.type === "paragraph") return inline(block.children);
    if (block.type === "quote") return commentsIn(block.blocks);
    if (block.type === "list") return block.items.flatMap((item) => commentsIn(item.blocks));
    return [];
  });
}

function countGuesses(nodes: readonly Inline[]): number {
  return nodes.reduce((n, node) => n + (node.type === "guess" ? 1 : "children" in node ? countGuesses(node.children) : 0), 0);
}

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** How many words `blocks` hold, and how many of them are the cleaner's guesses. */
export function tally(blocks: readonly Block[]): { words: number; guesses: number } {
  let words = 0;
  let guesses = 0;
  const visit = (block: Block) => {
    if (block.type === "heading" || block.type === "paragraph") {
      words += countWords(plainText(block.children));
      guesses += countGuesses(block.children);
    } else if (block.type === "code") words += countWords(block.text);
    else if (block.type === "quote") block.blocks.forEach(visit);
    else if (block.type === "list") block.items.forEach((item) => item.blocks.forEach(visit));
  };
  blocks.forEach(visit);
  return { words, guesses };
}

/** A day's sections: each heading of level 2 with the blocks under it until the next, and what comes before the first. */
export interface Section {
  heading: Extract<Block, { type: "heading" }> | null;
  blocks: Block[];
  /** The source ids its comments cite (`<!-- sources: a, b -->`). */
  sources: string[];
}

/** `blocks` cut into sections at each heading of level 2 (a source each, in the journal contract). */
export function sectionsOf(blocks: readonly Block[]): Section[] {
  const sections: Section[] = [{ heading: null, blocks: [], sources: [] }];
  for (const block of blocks) {
    if (block.type === "heading" && block.level === 2) sections.push({ heading: block, blocks: [], sources: [] });
    else sections.at(-1)!.blocks.push(block);
  }
  for (const section of sections) {
    section.sources = commentsIn(section.blocks)
      .flatMap((comment) => /^sources:\s*(.*)$/s.exec(comment)?.[1]?.split(",") ?? [])
      .map((id) => id.trim())
      .filter(Boolean);
  }
  return sections.filter((section, index) => index > 0 || section.blocks.length > 0);
}
