// An inspiration's link, reduced to one canonical form per platform, so saves of the same thing from anywhere are
// one item (inspirations.ts): what the captain shared from his phone, what his Grok Bot agent sends, and later what
// a back-fill importer reads. Pure: nothing here fetches or reads a file.
//
//   Instagram  /p/<code>/, /reel/<code>/, /reels/<code>/, /tv/<code>/ (also under a user's path) -> /p/<code>/,
//              the form a reel when it was one
//   X          twitter.com, x.com, mobile. and the like, /<user>/status/<id> or /i/status/<id> -> x.com/i/status/<id>
//   YouTube    youtu.be/<id>, /watch?v=<id>, /shorts/<id>, /embed/<id>, /live/<id>, m. and music. -> /watch?v=<id>,
//              the form a short when it was one
//   any other  the scheme and host lowercase, no fragment, no tracking parameters (utm_*, fbclid, igsh, si, ...),
//              no trailing slash; the platform named from the host when it is one of a few, else "web"

import { InvalidInputError } from "../../../sdk/server.ts";

/** What a shared thing is, as far as its link (or file) says. */
export const INSPIRATION_FORMS = ["post", "reel", "video", "short", "tweet", "article", "image", "other"] as const;
export type InspirationForm = (typeof INSPIRATION_FORMS)[number];

/** A link as the archive keeps it: canonical (the item's key), its platform and form, and the platform's own id when it has one. */
export interface CanonicalLink {
  link: string;
  platform: string;
  form: InspirationForm;
  /** The post's code, the status's id or the video's id; null for any other link. */
  nativeId: string | null;
}

/** Query parameters that only say where a link was shared from, dropped everywhere. */
const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igsh|igshid|si|ref_src|ref_url|_hsenc|_hsmi|mkt_tok|spm|share_id)$/i;

/** Hosts named for their platform when the link is none of the three above. */
const HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)pinterest\.[a-z.]+$|(^|\.)pin\.it$/, "pinterest"],
  [/(^|\.)reddit\.com$|(^|\.)redd\.it$/, "reddit"],
  [/(^|\.)vimeo\.com$/, "vimeo"],
  [/(^|\.)threads\.net$|(^|\.)threads\.com$/, "threads"],
  [/(^|\.)facebook\.com$|(^|\.)fb\.watch$/, "facebook"],
  [/(^|\.)spotify\.com$/, "spotify"],
  [/(^|\.)soundcloud\.com$/, "soundcloud"],
  [/(^|\.)behance\.net$/, "behance"],
  [/(^|\.)dribbble\.com$/, "dribbble"],
];

/** Whether `text` reads as a web link (http or https, or a bare host such as youtu.be/... or www.example.com/...). */
export function looksLikeLink(text: string): boolean {
  return /^https?:\/\//i.test(text.trim()) || /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i.test(text.trim());
}

/** The canonical form of `raw` (see the top); throws InvalidInputError for anything that is not a web link. */
export function canonicalLink(raw: string): CanonicalLink {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new InvalidInputError(`"${raw}" is not a link`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new InvalidInputError(`"${raw}" is not a web link`);
  if (!url.hostname.includes(".")) throw new InvalidInputError(`"${raw}" is not a web link`);
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile|music)\./, "");
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "instagram.com" || host === "instagr.am") {
    const at = parts.findIndex((part) => ["p", "reel", "reels", "tv"].includes(part));
    const code = at >= 0 ? parts[at + 1] : undefined;
    if (code && /^[\w-]+$/.test(code)) {
      const form: InspirationForm = parts[at] === "p" ? "post" : parts[at] === "tv" ? "video" : "reel";
      return { link: `https://www.instagram.com/p/${code}/`, platform: "instagram", form, nativeId: code };
    }
    return { link: cleaned(url, "www.instagram.com"), platform: "instagram", form: "other", nativeId: null };
  }

  if (host === "x.com" || host === "twitter.com" || host === "fxtwitter.com" || host === "vxtwitter.com" || host === "fixupx.com") {
    const at = parts.findIndex((part) => part === "status" || part === "statuses");
    const id = at >= 0 ? parts[at + 1] : undefined;
    if (id && /^\d{1,25}$/.test(id)) return { link: `https://x.com/i/status/${id}`, platform: "x", form: "tweet", nativeId: id };
    return { link: cleaned(url, "x.com"), platform: "x", form: "other", nativeId: null };
  }

  if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") {
    const id = host === "youtu.be"
      ? parts[0]
      : parts[0] === "watch"
        ? url.searchParams.get("v") ?? undefined
        : ["shorts", "embed", "live", "v"].includes(parts[0] ?? "")
          ? parts[1]
          : undefined;
    if (id && /^[\w-]{6,20}$/.test(id)) {
      return { link: `https://www.youtube.com/watch?v=${id}`, platform: "youtube", form: parts[0] === "shorts" ? "short" : "video", nativeId: id };
    }
    return { link: cleaned(url, "www.youtube.com"), platform: "youtube", form: "other", nativeId: null };
  }

  const platform = HOSTS.find(([pattern]) => pattern.test(host))?.[1] ?? "web";
  return { link: cleaned(url, url.hostname.toLowerCase()), platform, form: platform === "web" ? "article" : "post", nativeId: null };
}

/** `url` on `host` over https, with no fragment, no tracking parameters and no trailing slash. */
function cleaned(url: URL, host: string): string {
  const params = [...url.searchParams].filter(([key]) => !TRACKING.test(key));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  const path = url.pathname.replace(/\/+$/, "");
  return `https://${host}${url.port ? `:${url.port}` : ""}${path}${query}`;
}

/** The form of a kept file with no link, from its name: an image, a video, or something else. */
export function fileForm(fileName: string): InspirationForm {
  if (/\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i.test(fileName)) return "image";
  if (/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(fileName)) return "video";
  return "other";
}
