// Instagram's previews: the author, the post's own words and one small picture of each Instagram item, read from the
// post's public embed page (https://www.instagram.com/p/<code>/embed/), the page Instagram gives any site that embeds
// the post. Always logged out: no login, no cookie, no account, no session, nothing of the captain's. The one file kept
// is a picture about 320 px across (its smallest of 320 or more), never a video, a full-size image or a carousel's
// others; the page shows the live embed only when he asks for it (viewer/InspirationsView.tsx).
//
// Slowly, so Instagram never sees a burst (the captain's choice, 2026-10-19: downloading the posts whole risked his
// account): one post at a time, 15 to 30 s apart, its picture a few seconds after its page, at most 100 posts a day.
// When Instagram refuses one (429, 401 or 403, a login wall, a challenge), or five posts in a row show nothing, it
// stops for 6 hours, then twice that each time, up to two days, and goes on with the same post. Every fetch is recorded
// (inspiration_fetch), so the pace holds across the server's restarts. A post whose page shows nothing is tried twice
// more, a day apart, then skipped (removed, private, or not to be embedded); one whose fetch fails (the network, a
// timeout) is tried again after a growing wait, then given up on. Each item keeps what its last try said
// (preview_note): why it was skipped, that Instagram refused, or that it has no picture.
//
// Logged out, the page carries the post (its contextJSON: the owner, the caption, the picture's sizes) only when it is
// asked for as a browser asks for a page, with a browser's document headers; asked otherwise it is an empty shell of
// Instagram's app with an error page in it, which reads here as no post (checked on this Mac, 2026-10-19, on a few of
// the captain's saves). Its HTML (EmbeddedMediaImage, UsernameText) is read when that JSON is not there.
//
// The worker (worker.ts) runs one post at a time from Inspirations' queue (nextInstagram); `npm run archive --
// inspiration instagram start` puts every Instagram item without a picture on it. Written in Effect (docs/effect.md):
// the waits are Effect.sleep on its Clock and their jitter its Random, so a test moves them.

import { Data, Effect, Random } from "effect";
import { canonicalLink } from "./links.ts";
import type { FetchRecord, InstagramWork, Preview, PreviewProgress } from "./store.ts";
import { acceptLanguage, decodeEntities } from "../../../sdk/server.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How slowly Instagram is asked (see the top). */
export interface InstagramPace {
  /** Between one post and the next: gapMs, plus up to jitterMs more. */
  gapMs: number;
  jitterMs: number;
  /** Between a post's page and its picture. */
  pictureGapMs: number;
  pictureJitterMs: number;
  /** Posts in any 24 hours. */
  dailyCap: number;
  /** The first stop after a refusal, doubled each time in a row, up to longestPauseMs. */
  pauseMs: number;
  longestPauseMs: number;
  /** This many posts in a row showing nothing is taken as a refusal. */
  emptyRun: number;
  /** A post that shows nothing is tried this many times, emptyWaitMs apart, then skipped. */
  emptyTries: number;
  emptyWaitMs: number;
  /** A fetch that fails is tried this many times, failWaitMs, then twice that..., apart. */
  failTries: number;
  failWaitMs: number;
}

export const INSTAGRAM_PACE: InstagramPace = {
  gapMs: 15_000,
  jitterMs: 15_000,
  pictureGapMs: 3000,
  pictureJitterMs: 3000,
  dailyCap: 100,
  pauseMs: 6 * HOUR,
  longestPauseMs: 48 * HOUR,
  emptyRun: 5,
  emptyTries: 3,
  emptyWaitMs: DAY,
  failTries: 4,
  failWaitMs: HOUR,
};

export const INSTAGRAM = "instagram";

/** The widest picture kept: Instagram's 320 px size is about 20 to 40 KB. */
const PICTURE_WIDTH = 320;
const MAX_PICTURE_BYTES = 400 * 1024;
/** What is read of an embed page at most (they are 0.2 to 0.6 MB). */
const MAX_PAGE_BYTES = 3 * 1024 * 1024;

/** The headers a browser asks for a page with (a Mac's Chrome), without which the embed page is an empty shell. */
const PAGE_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": acceptLanguage(),
  "sec-ch-ua": '"Google Chrome";v="141", "Chromium";v="141", "Not(A:Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

const PICTURE_HEADERS: Record<string, string> = {
  accept: "image/avif,image/webp,image/jpeg,image/*;q=0.8",
  "accept-language": acceptLanguage(),
  "sec-fetch-dest": "image",
  "sec-fetch-mode": "no-cors",
  "sec-fetch-site": "cross-site",
  "user-agent": PAGE_HEADERS["user-agent"],
};

/** The post's code in an Instagram link (https://www.instagram.com/p/<code>/), or null for one that is not a post's. */
export function instagramCode(link: string): string | null {
  try {
    const canonical = canonicalLink(link);
    return canonical.platform === INSTAGRAM ? canonical.nativeId : null;
  } catch {
    return null;
  }
}

/** The post's public embed page, which the page also shows live when asked. */
export const embedLink = (code: string): string => `https://www.instagram.com/p/${code}/embed/`;

/** The placeholder title an import gave a post it knew nothing of. */
export const placeholderTitle = (code: string): string => `Instagram save ${code}`;

/** Whether a picture's link is Instagram's own picture server, over https. */
export function pictureAllowed(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && (url.hostname.endsWith(".cdninstagram.com") || url.hostname.endsWith(".fbcdn.net"));
  } catch {
    return false;
  }
}

/** What an embed page shows: the post, nothing (no post on it), or Instagram's refusal (a login wall, a challenge). */
export type EmbedPage =
  | { kind: "post"; author: string | null; description: string | null; picture: string | null }
  | { kind: "empty" }
  | { kind: "blocked"; why: string };

/** Reads an embed page (see the top): its contextJSON first, else its HTML. */
export function readEmbed(html: string): EmbedPage {
  if (/"pageID":"(login|challenge|checkpoint)/i.test(html) || /<form[^>]*\bid="loginForm"/i.test(html) || /<title>\s*Login\b[^<]*Instagram/i.test(html)) {
    return { kind: "blocked", why: "its embed page asks for a login" };
  }
  const media = contextMedia(html);
  if (media) {
    const owner = media.owner as Record<string, unknown> | undefined;
    const edges = ((media.edge_media_to_caption as Record<string, unknown> | undefined)?.edges ?? []) as Array<{ node?: { text?: unknown } }>;
    const sizes = [media.thumbnail_resources, media.display_resources]
      .map((list) => (Array.isArray(list) ? list : []).map((size: Record<string, unknown>) => ({ src: text(size.src), width: Number(size.config_width) })))
      .find((list) => list.some((size) => size.src && pictureAllowed(size.src))) ?? [];
    const username = text(owner?.username);
    return {
      kind: "post",
      author: username ? `@${username}` : null,
      description: text(edges[0]?.node?.text),
      picture: choosePicture(sizes) ?? (text(media.display_url) && pictureAllowed(text(media.display_url)!) ? text(media.display_url) : null),
    };
  }
  const image = /<img\b[^>]*class="EmbeddedMediaImage"[^>]*>/i.exec(html)?.[0];
  if (!image) return { kind: "empty" };
  const attribute = (name: string) => {
    const found = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(image)?.[1];
    return found === undefined ? null : decodeEntities(found);
  };
  const sizes = (attribute("srcset") ?? "")
    .split(/,\s*(?=https:)/)
    .map((entry) => {
      const [src, width] = entry.trim().split(/\s+/);
      return { src: src || null, width: Number.parseInt(width ?? "", 10) };
    });
  const named = /<span class="UsernameText">([^<]+)<\/span>/i.exec(html)?.[1] ?? /shared by @([\w.]+)/.exec(attribute("alt") ?? "")?.[1];
  const src = attribute("src");
  return {
    kind: "post",
    author: named ? `@${decodeEntities(named).trim().replace(/^@/, "")}` : null,
    description: null,
    picture: choosePicture(sizes) ?? (src && pictureAllowed(src) ? src : null),
  };
}

/** The smallest picture at least PICTURE_WIDTH across, else the widest there is; only Instagram's own. */
export function choosePicture(sizes: ReadonlyArray<{ src: string | null; width: number }>): string | null {
  const fit = sizes.filter((size): size is { src: string; width: number } => size.src !== null && Number.isFinite(size.width) && pictureAllowed(size.src));
  const wide = fit.filter((size) => size.width >= PICTURE_WIDTH).sort((a, b) => a.width - b.width);
  if (wide.length > 0) return wide[0].src;
  return fit.sort((a, b) => b.width - a.width)[0]?.src ?? null;
}

/** The post in the page's contextJSON (gql_data.shortcode_media), or null when it has none. */
function contextMedia(html: string): Record<string, unknown> | null {
  const key = '"contextJSON":"';
  const at = html.indexOf(key);
  if (at < 0) return null;
  // The JSON is a string inside the page's own JSON: read to its closing quote, then decode it twice.
  let end = at + key.length;
  while (end < html.length && html[end] !== '"') end += html[end] === "\\" ? 2 : 1;
  try {
    const context = JSON.parse(JSON.parse(html.slice(at + key.length - 1, end + 1)) as string) as { gql_data?: { shortcode_media?: unknown } };
    const media = context.gql_data?.shortcode_media;
    return media && typeof media === "object" ? (media as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** What one try at a post came to. A refusal of its picture after its page (refused) still stops the lane. */
export type InstagramTry =
  | { outcome: "found"; author: string | null; description: string | null; picture: { bytes: Uint8Array; mime: string } | null; note: string | null; refused: string | null }
  | { outcome: "empty"; note: string }
  | { outcome: "blocked"; note: string }
  | { outcome: "failed"; note: string };

export interface InstagramOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  pace?: InstagramPace;
}

/** Why a request came to nothing: Instagram refused it, there was nothing there, or it failed on the way. */
class Refused extends Data.TaggedError("Refused")<{ readonly message: string }> {}
class Missing extends Data.TaggedError("Missing")<{ readonly message: string }> {}
class Failed extends Data.TaggedError("Failed")<{ readonly message: string }> {}

/** Asks Instagram for the post `code`'s embed page, then its picture (see the top). Never fails: every end is an outcome. */
export const tryInstagram = (code: string, options: InstagramOptions = {}): Effect.Effect<InstagramTry> =>
  Effect.gen(function* () {
    const pace = options.pace ?? INSTAGRAM_PACE;
    const html = new TextDecoder().decode(yield* get(embedLink(code), PAGE_HEADERS, MAX_PAGE_BYTES, { cut: true, ...options }));
    const page = readEmbed(html);
    if (page.kind === "blocked") return { outcome: "blocked" as const, note: `Instagram refused: ${page.why}` };
    if (page.kind === "empty") return { outcome: "empty" as const, note: "its embed page shows no post" };
    const found = { outcome: "found" as const, author: page.author, description: page.description, picture: null, note: null, refused: null };
    if (!page.picture) return { ...found, note: "its embed page has no picture" };
    yield* Effect.sleep(yield* Random.nextBetween(pace.pictureGapMs, pace.pictureGapMs + pace.pictureJitterMs));
    const picture = yield* Effect.result(getPicture(page.picture, options));
    if (picture._tag === "Success") return { ...found, picture: picture.success };
    const why = picture.failure.message;
    return picture.failure._tag === "Refused" ? { ...found, note: `its picture was refused: ${why}`, refused: why } : { ...found, note: `its picture could not be kept: ${why}` };
  }).pipe(
    Effect.catchTags({
      Refused: (error) => Effect.succeed({ outcome: "blocked" as const, note: `Instagram refused: ${error.message}` }),
      Missing: (error) => Effect.succeed({ outcome: "empty" as const, note: error.message }),
      Failed: (error) => Effect.succeed({ outcome: "failed" as const, note: error.message }),
    }),
  );

const getPicture = (link: string, options: InstagramOptions) =>
  get(link, PICTURE_HEADERS, MAX_PICTURE_BYTES, options).pipe(
    Effect.flatMap((bytes) => {
      const mime = imageType(bytes);
      return mime ? Effect.succeed({ bytes, mime }) : Effect.fail(new Failed({ message: "its picture is not a JPEG, PNG or WebP" }));
    }),
  );

/** A picture's type from its first bytes (what Instagram serves: JPEG, sometimes WebP or PNG), or null. */
export function imageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/**
 * GETs `link`, at most `max` bytes (cut short there with `cut`, else refused as too big), never following a redirect
 * off Instagram, and one to its login or challenge a refusal.
 */
const get = (link: string, headers: Record<string, string>, max: number, { fetch = globalThis.fetch, timeoutMs = 15_000, cut = false }: InstagramOptions & { cut?: boolean }) =>
  Effect.gen(function* () {
    let url = link;
    for (let hop = 0; hop <= 2; hop++) {
      const asked = url;
      const res = yield* Effect.tryPromise({
        try: (signal) => fetch(asked, { redirect: "manual", signal, headers, credentials: "omit" }),
        catch: (error) => new Failed({ message: `could not reach Instagram: ${(error as Error).message}` }),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const next = new URL(res.headers.get("location")!, asked);
        if (/^\/(accounts|challenge|checkpoint|consent)\b/.test(next.pathname)) return yield* new Refused({ message: `it sent the request to ${next.pathname}` });
        if (!(next.hostname === "www.instagram.com" || pictureAllowed(next.toString()))) return yield* new Failed({ message: `it redirected off Instagram, to ${next.hostname}` });
        url = next.toString();
        continue;
      }
      if (res.status === 429 || res.status === 401 || res.status === 403) return yield* new Refused({ message: `it answered ${res.status}` });
      if (res.status === 404 || res.status === 410) return yield* new Missing({ message: `its embed page answered ${res.status}: no such post` });
      if (!res.ok) return yield* new Failed({ message: `Instagram answered ${res.status}` });
      return yield* Effect.tryPromise({
        try: () => readCapped(res, max, cut),
        catch: (error) => new Failed({ message: (error as Error).message }),
      });
    }
    return yield* new Failed({ message: "Instagram redirected too many times" });
  }).pipe(
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new Failed({ message: `Instagram took more than ${Math.round(timeoutMs / 1000)} s` })) }),
  );

async function readCapped(res: Response, max: number, cut: boolean): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size <= max) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  if (cut) return Buffer.concat(chunks).subarray(0, max);
  throw new Error(`it is more than ${Math.round(max / 1024)} KB, more than a small picture`);
}

/** When Instagram may next be asked: now, or not before `at`, while its last fetch's wait runs, or its day's cap is used. */
export function paceAt(lastDay: readonly number[], last: FetchRecord | null, now: number, pace: InstagramPace = INSTAGRAM_PACE):
  { due: true } | { due: false; at: number; why: "spacing" | "paused" | "cap" } {
  if (last && last.nextAt > now) return { due: false, at: last.nextAt, why: last.outcome === "blocked" ? "paused" : "spacing" };
  if (lastDay.length >= pace.dailyCap) return { due: false, at: lastDay[lastDay.length - pace.dailyCap] + DAY, why: "cap" };
  return { due: true };
}

/** What a try at `work` comes to (see the top): the item's preview and progress, and the fetch to record. */
export function settle(work: InstagramWork, code: string, tried: InstagramTry, recent: readonly FetchRecord[], now: number, gapMs: number, pace: InstagramPace = INSTAGRAM_PACE):
  { state: "done" | "none" | "failed" | "pending"; preview: Preview; progress: PreviewProgress; record: FetchRecord } {
  const inRow = (outcome: FetchRecord["outcome"]) => {
    const other = recent.findIndex((fetch) => fetch.outcome !== outcome);
    return other < 0 ? recent.length : other;
  };
  const pause = now + Math.min(pace.longestPauseMs, pace.pauseMs * 2 ** inRow("blocked"));
  const record = (outcome: FetchRecord["outcome"], note: string | null, nextAt: number): FetchRecord => ({ platform: INSTAGRAM, inspirationId: work.id, at: now, outcome, note, nextAt });
  const paused = (why: string) => ({
    state: "pending" as const,
    preview: {},
    progress: { tries: work.tries, retryAt: 0, note: `blocked: ${why}; paused until ${new Date(pause).toISOString()}` },
    record: record("blocked", why, pause),
  });
  switch (tried.outcome) {
    case "found":
      return {
        state: "done",
        preview: { author: tried.author, description: tried.description, placeholderTitle: placeholderTitle(code) },
        progress: { tries: work.tries + 1, retryAt: 0, note: tried.note },
        record: tried.refused ? record("blocked", `its picture: ${tried.refused}`, pause) : record("found", tried.note, now + gapMs),
      };
    case "blocked":
      return paused(tried.note);
    case "empty": {
      if (inRow("empty") + 1 >= pace.emptyRun) return paused(`${pace.emptyRun} posts in a row showed nothing, taken as Instagram refusing`);
      const tries = work.tries + 1;
      if (tries >= pace.emptyTries) {
        return {
          state: "none",
          preview: {},
          progress: { tries, retryAt: 0, note: `skipped: ${tried.note} after ${tries} tries (removed, private, or not to be embedded)` },
          record: record("empty", tried.note, now + gapMs),
        };
      }
      return {
        state: "pending",
        preview: {},
        progress: { tries, retryAt: now + pace.emptyWaitMs, note: `${tried.note} (try ${tries} of ${pace.emptyTries}); tried again in a day` },
        record: record("empty", tried.note, now + gapMs),
      };
    }
    case "failed": {
      const tries = work.tries + 1;
      return {
        state: tries >= pace.failTries ? "failed" : "pending",
        preview: {},
        progress: { tries, retryAt: now + pace.failWaitMs * 2 ** (tries - 1), note: tries >= pace.failTries ? `given up on: ${tried.note}` : `${tried.note} (try ${tries} of ${pace.failTries})` },
        record: record("failed", tried.note, now + gapMs),
      };
    }
  }
}
