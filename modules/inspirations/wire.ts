// What the Inspirations page and its server say to each other (/life-archive/api/inspirations/..., server/http.ts).
// Inspirations are metadata, his caption and tags included (docs/features.md's "Inspirations"), so every answer
// carries them whole. His tags (manual) and the AI's are kept apart and never merged: a list is filtered by one kind
// or the other.

import { API_BASE } from "../../sdk/wire.ts";

/**
 * Where the routes answer: the address they had while they were the core's, which the iPhone's Inspire shortcut posts
 * its captures to, so the module mounts its route there (module.ts's `mounts`) as well as at its own.
 */
export const INSPIRATIONS_API = `${API_BASE}/inspirations`;

/** Which tags a filter reads: his own, or the AI's. */
export const TAG_KINDS = ["manual", "ai"] as const;
export type TagKind = (typeof TAG_KINDS)[number];

/** What a list is narrowed to: tags all of which an item has (of one kind), words, untagged (no tags of his), a platform, hidden. */
export interface InspirationFilter {
  tags: string[];
  tagKind: TagKind;
  /** Words, each found in its caption, title, author, description, link or any of its tags. */
  q: string;
  untagged: boolean;
  /** One platform's items alone (instagram, youtube, web, file...); "" for every platform's. */
  platform: string;
  /** The hidden items instead of the rest. */
  hidden: boolean;
}

export const NO_INSPIRATION_FILTER: InspirationFilter = { tags: [], tagKind: "manual", q: "", untagged: false, platform: "", hidden: false };

/** Where the AI's tags are: asked for and waiting, done, or given up on after several tries (with why). */
export type AiTagsState = "pending" | "done" | "failed";

/** An item's picture: a file kept for it (his own, else its preview's), or its preview's picture where its platform keeps it. */
export type InspirationImage = { fileId: number } | { url: string } | null;

/**
 * The probe an old item carries (nothing makes one any more): when his words were found to ask for something to be
 * done and firstmate was told, and the probe's result, a report's or preview's link (with when). Null for an item that
 * has neither.
 */
export interface InspirationProbe {
  requestedAt: number | null;
  result: string | null;
  resultAt: number | null;
}

export interface InspirationSummary {
  id: number;
  /** Its canonical link; null for a kept file alone. */
  link: string | null;
  platform: string;
  form: string;
  title: string | null;
  author: string | null;
  /** What is known of it in words: a page's description, a post's own words. */
  description: string | null;
  caption: string;
  /** His tags, in his order. */
  tags: string[];
  /** The AI's, best first. */
  aiTags: string[];
  aiState: AiTagsState;
  image: InspirationImage;
  /** When it first came in, ms. */
  createdAt: number;
  saveCount: number;
  hidden: boolean;
  /** The probe an old item carries, and its result; null for an item with neither. */
  probe: InspirationProbe | null;
}

export interface InspirationSave {
  id: number;
  /** Where it came from: share-sheet (the iPhone's Inspire shortcut), grok-bot, cli, and later the back-fill importers' (chrome, instagram-saved...). */
  origin: string;
  link: string | null;
  /** The words that came with this save. */
  caption: string;
  /** When, ms; null when the source does not say. */
  savedAt: number | null;
}

export interface InspirationFileInfo {
  id: number;
  role: "item" | "preview";
  mime: string;
  bytes: number;
}

export interface InspirationDetail extends InspirationSummary {
  saves: InspirationSave[];
  files: InspirationFileInfo[];
  previewState: "pending" | "done" | "none" | "failed";
  /** What its preview's last try said, for one fetched slowly (Instagram's): skipped and why, refused, or why there is no picture. */
  previewNote: string | null;
  ai: { state: AiTagsState; model: string | null; at: number | null; error: string | null };
  editedAt: number | null;
}

export interface InspirationList {
  items: InspirationSummary[];
  /** How many match, in all. */
  total: number;
}

export interface InspirationTagInfo {
  name: string;
  /** What it covers, in his words; empty when he has not said. */
  description: string;
  /** How many items (hidden ones aside) have it. */
  count: number;
}

export interface InspirationTagsAnswer {
  /** His vocabulary, in his order. */
  tags: InspirationTagInfo[];
  /** Every AI tag in use, the most items first. */
  aiTags: Array<{ name: string; count: number }>;
  /** Every platform items come from, with how many (hidden ones aside), the most first. */
  platforms: Array<{ platform: string; count: number }>;
  /** Items (hidden ones aside) with none of his tags, and all of them. */
  untagged: number;
  total: number;
  hidden: number;
}

/** An edit's answer: the item as it is after, and the changeset it made (null when it changed nothing), for Undo. */
export interface InspirationSaved {
  item: InspirationDetail;
  changeset: number | null;
}

/** A vocabulary edit's answer: the tags after, and its changeset. */
export interface InspirationTagsSaved {
  tags: InspirationTagsAnswer;
  changeset: number | null;
}

/** The query string a filter is sent as, and read back from (the page's address keeps it too). */
export function inspirationParams(filter: InspirationFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.tags.length > 0) params.set("tags", filter.tags.join(","));
  if (filter.tagKind !== "manual") params.set("kind", filter.tagKind);
  if (filter.q.trim()) params.set("q", filter.q.trim());
  if (filter.untagged) params.set("untagged", "1");
  if (filter.platform) params.set("platform", filter.platform);
  if (filter.hidden) params.set("hidden", "1");
  return params;
}

export function readInspirationFilter(params: URLSearchParams): InspirationFilter {
  const kind = params.get("kind");
  return {
    tags: (params.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
    tagKind: kind === "ai" ? "ai" : "manual",
    q: params.get("q") ?? "",
    untagged: params.get("untagged") === "1",
    platform: params.get("platform")?.trim() ?? "",
    hidden: params.get("hidden") === "1",
  };
}
