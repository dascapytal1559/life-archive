// How the Inspirations page writes what it shows: an item's name, where it is from, where a save came from, its
// changes' lines, and the tags typed into a box.

import type { InspirationSummary } from "../wire.ts";

const PLATFORMS: Record<string, string> = {
  instagram: "Instagram", x: "X", youtube: "YouTube", tiktok: "TikTok", pinterest: "Pinterest", reddit: "Reddit", vimeo: "Vimeo",
  threads: "Threads", facebook: "Facebook", spotify: "Spotify", soundcloud: "SoundCloud", behance: "Behance", dribbble: "Dribbble",
  web: "Web", file: "Kept file",
};

/** "Instagram", "YouTube", "Web"; a platform it does not know by its own word. */
export function platformLabel(platform: string): string {
  return PLATFORMS[platform] ?? platform;
}

/** "Instagram reel", "YouTube short", "Web article", "Kept image". */
export function sourceLabel(item: Pick<InspirationSummary, "platform" | "form">): string {
  if (item.platform === "file") return item.form === "image" ? "Kept image" : item.form === "video" ? "Kept video" : "Kept file";
  return item.form === "other" ? platformLabel(item.platform) : `${platformLabel(item.platform)} ${item.form}`;
}

/**
 * What an item is called: its title, else the first line of his words, else of its description (an Instagram post's
 * own words), else its link's host and path.
 */
export function itemName(item: Pick<InspirationSummary, "title" | "caption" | "link" | "description">): string {
  if (item.title) return item.title;
  const line = item.caption.split("\n")[0].trim() || (item.description ?? "").split("\n")[0].trim();
  if (line) return line;
  if (item.link) {
    const url = new URL(item.link);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`;
  }
  return "A kept file";
}

/** Where a save came from, as the page says it: "Grok Bot", "the CLI", "chrome". */
export function originLabel(origin: string): string {
  if (origin === "grok-bot") return "Grok Bot";
  if (origin === "cli") return "the CLI";
  return origin;
}

/** Tags as typed into a box: separated by commas (or Enter), written as the archive writes them, without repeats. */
export function typedTags(text: string): string[] {
  const tags = text.split(",").map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean);
  return [...new Set(tags)];
}

/** A link as a card shows it: its host, path and query, without www. or a trailing slash (instagram.com/p/AbC123). */
export function shortLink(link: string): string {
  const url = new URL(link);
  return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

/** The post's code in an Instagram item's link (kept as https://www.instagram.com/p/<code>/), or null. */
export function instagramCode(item: Pick<InspirationSummary, "platform" | "link">): string | null {
  if (item.platform !== "instagram" || !item.link) return null;
  return /^https:\/\/www\.instagram\.com\/p\/([\w-]+)\/$/.exec(item.link)?.[1] ?? null;
}

/** The post's public embed page, shown live in the item only when asked for. */
export const instagramEmbed = (code: string): string => `https://www.instagram.com/p/${code}/embed/`;
