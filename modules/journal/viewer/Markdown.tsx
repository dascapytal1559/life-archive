// Draws the Journal page's Markdown (markdown.ts's tree) as React elements, never as HTML, so nothing in a note can
// run. A link opens only the web, mail or a note in Obsidian (obsidian://open, never an action that writes; links.ts);
// a link to a raw file of the day opens it in the side pane; a wikilink to a day opens that day; a picture is shown
// only from the day's assets/ (through the module's route, which keeps the read in the trail), any other as its words.
// A guess, the cleaner's `[word?]`, is marked to check.

import type { ReactNode } from "react";
import { opensOutside } from "./links.ts";
import type { Block, Inline } from "./markdown.ts";

/** What a note's links and pictures may reach, worked out by the page. */
export interface MarkdownLinks {
  /** The address to show a picture at, for one of the day's assets; null for any other, shown as its words. */
  image(src: string): string | null;
  /** Called for a link that is not to the web, mail or Obsidian's open (a raw file of the day, another day): true when the page opened it. */
  open(target: string): boolean;
  /** Whether a link of this target opens something on the page (so it is drawn as a link). */
  opens(target: string): boolean;
}

function inlines(nodes: readonly Inline[], links: MarkdownLinks, key = ""): ReactNode[] {
  return nodes.map((node, i) => {
    const k = `${key}${i}`;
    switch (node.type) {
      case "text":
        return node.text;
      case "break":
        return <br key={k} />;
      case "comment":
        return null;
      case "code":
        return <code key={k}>{node.text}</code>;
      case "guess":
        return (
          <span key={k} className="jn-guess" title="A word the cleaner was unsure of: check it against the recording">
            {node.text}
            <span className="jn-guess__mark">?</span>
          </span>
        );
      case "em":
        return <em key={k}>{inlines(node.children, links, `${k}.`)}</em>;
      case "strong":
        return <strong key={k}>{inlines(node.children, links, `${k}.`)}</strong>;
      case "del":
        return <del key={k}>{inlines(node.children, links, `${k}.`)}</del>;
      case "mark":
        return <mark key={k}>{inlines(node.children, links, `${k}.`)}</mark>;
      case "image": {
        const src = links.image(node.src);
        return src ? <img key={k} src={src} alt={node.alt} loading="lazy" /> : <span key={k} className="jn-missing">{node.alt || node.src}</span>;
      }
      case "wikilink": {
        const src = node.embed ? links.image(node.target) : null;
        if (src) return <img key={k} src={src} alt={node.label} loading="lazy" />;
        if (links.opens(node.target)) return <a key={k} href="#" className="jn-wikilink" onClick={(e) => (e.preventDefault(), links.open(node.target))}>{node.label}</a>;
        return <span key={k} className="jn-wikilink jn-wikilink--none">{node.label}</span>;
      }
      case "link": {
        const children = inlines(node.children, links, `${k}.`);
        if (opensOutside(node.href)) return <a key={k} href={node.href} target="_blank" rel="noreferrer noopener">{children}</a>;
        if (links.opens(node.href)) return <a key={k} href="#" onClick={(e) => (e.preventDefault(), links.open(node.href))}>{children}</a>;
        return <span key={k} className="jn-link--none">{children}</span>;
      }
    }
  });
}

/** One block, its key `key`. */
export function MarkdownBlock({ block, links }: { block: Block; links: MarkdownLinks }): ReactNode {
  switch (block.type) {
    case "heading": {
      const Tag = `h${Math.min(block.level, 6)}` as "h1";
      return <Tag id={`jn-${block.id}`}>{inlines(block.children, links)}</Tag>;
    }
    case "paragraph":
      // A paragraph of nothing but a comment shows nothing.
      return block.children.every((n) => n.type === "comment") ? null : <p>{inlines(block.children, links)}</p>;
    case "comment":
      return null;
    case "rule":
      return <hr />;
    case "code":
      return <pre><code>{block.text}</code></pre>;
    case "quote":
      return <blockquote><MarkdownBlocks blocks={block.blocks} links={links} /></blockquote>;
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i} className={item.task === null ? undefined : `jn-task${item.task ? " jn-task--done" : ""}`}>
          {item.task !== null && <span className="jn-task__box" aria-label={item.task ? "done" : "not done"} />}
          <MarkdownBlocks blocks={item.blocks} links={links} />
        </li>
      ));
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
    }
  }
}

export function MarkdownBlocks({ blocks, links }: { blocks: readonly Block[]; links: MarkdownLinks }): ReactNode {
  return blocks.map((block, i) => <MarkdownBlock key={i} block={block} links={links} />);
}
