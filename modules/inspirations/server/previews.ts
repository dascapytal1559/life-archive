// An inspiration's preview: what its link's own platform says of it in public, fetched once by the server
// (worker.ts), filling only what is still empty (Inspirations.setPreview). Never behind a login:
//
//   YouTube    its public oEmbed (title, channel, thumbnail), no key
//   X          its public oEmbed (the post's text and author), no key
//   Instagram  nothing here: its oEmbed needs an app review and no longer gives the author or a picture, and its
//              pages ask for a login; its post's public embed page is read in a slow lane of its own (instagram.ts),
//              and until then what the captain's Grok Bot agent saw (inspiration add's --title, --author and
//              --description) is what the archive knows
//   any other  the page's own meta tags (og:, twitter:, <title>, author), from its first megabyte
//
// Only http and https links to a named host are fetched, never this Mac, the local network or an address alone, and
// each redirect is checked the same way. Written in Effect (docs/effect.md): a fetch is a tryPromise with the signal
// it is given, its time limited by a timeout.

import { Data, Effect } from "effect";
import type { Preview, PreviewWork } from "./store.ts";
import { acceptLanguage, decodeEntities } from "../../../sdk/server.ts";

/** A preview that could not be had: the network, the site, or a page that is not one. */
export class PreviewFailed extends Data.TaggedError("PreviewFailed")<{ readonly message: string }> {}

export interface PreviewOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** What is read of a page at most. */
const MAX_BYTES = 1024 * 1024;
const REDIRECTS = 5;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

/** The preview of `work`'s link: done with what was found, none when its platform gives nothing, or PreviewFailed. */
export const fetchPreview = (work: PreviewWork, options: PreviewOptions = {}): Effect.Effect<{ state: "done" | "none"; preview: Preview }, PreviewFailed> =>
  Effect.gen(function* () {
    if (work.platform === "instagram") return { state: "none" as const, preview: {} };
    const preview = work.platform === "youtube"
      ? yield* youtube(work.link, options)
      : work.platform === "x"
        ? yield* x(work.given.find((link) => /\/status\//.test(link) && !/\/i\/status\//.test(link)) ?? work.link, options)
        : yield* metaTags(work.link, options);
    const found = Object.values(preview).some((value) => typeof value === "string" && value !== "");
    return { state: found ? ("done" as const) : ("none" as const), preview };
  });

const youtube = (link: string, options: PreviewOptions) =>
  json(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(link)}`, options).pipe(
    Effect.map((body): Preview => ({ title: text(body.title), author: text(body.author_name), imageUrl: text(body.thumbnail_url) })),
  );

const x = (link: string, options: PreviewOptions) =>
  json(`https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(link)}`, options).pipe(
    Effect.map((body): Preview => {
      // The post's text is the first paragraph of the blockquote it gives.
      const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(text(body.html) ?? "")?.[1];
      return { author: text(body.author_name), description: paragraph ? decodeEntities(paragraph.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")) : null };
    }),
  );

const metaTags = (link: string, options: PreviewOptions) =>
  page(link, options).pipe(
    Effect.map(({ html, url }): Preview => {
      const end = html.search(/<\/head>/i);
      const head = end >= 0 ? html.slice(0, end) : html;
      const meta = metaOf(head);
      const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
      const title = meta["og:title"] ?? meta["twitter:title"] ?? (titleTag ? decodeEntities(titleTag).replace(/\s+/g, " ") : null);
      const image = meta["og:image"] ?? meta["og:image:url"] ?? meta["twitter:image"] ?? null;
      let imageUrl: string | null = null;
      try {
        imageUrl = image ? new URL(image, url).toString() : null;
      } catch {
        imageUrl = null;
      }
      return {
        title: title?.trim() || null,
        author: meta.author ?? meta["article:author"] ?? meta["twitter:creator"] ?? meta["og:site_name"] ?? null,
        description: meta["og:description"] ?? meta["twitter:description"] ?? meta.description ?? null,
        imageUrl: imageUrl?.startsWith("https://") ? imageUrl : null,
      };
    }),
  );

/** Every <meta> of a page's head, by its property or name, lowercase; the first of each kept. */
export function metaOf(head: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attribute = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    const key = attribute("property") ?? attribute("name");
    const content = attribute("content");
    if (!key || !content) continue;
    const name = (key[2] ?? key[3] ?? key[4]).toLowerCase();
    const value = decodeEntities(content[2] ?? content[3] ?? content[4]).trim();
    if (value && !(name in found)) found[name] = value;
  }
  return found;
}

/** A string, or null for anything else. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Whether a link may be fetched: http or https, to a host by name, never this Mac, the local network or an address. */
export function mayFetch(link: string): boolean {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".ts.net")) return false;
  // An address alone (IPv4 or IPv6) is never fetched: the archive's previews are of sites, by name.
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith("[")) return false;
  return host.includes(".");
}

/** GET `link` (its redirects checked as it is), within the time limit. */
const get = (link: string, accept: string, { fetch = globalThis.fetch, timeoutMs = 8000 }: PreviewOptions) =>
  Effect.gen(function* () {
    let url = link;
    for (let hop = 0; hop <= REDIRECTS; hop++) {
      if (!mayFetch(url)) return yield* new PreviewFailed({ message: `${url} is not a link the archive fetches` });
      const asked = url;
      const res = yield* Effect.tryPromise({
        try: (signal) => fetch(asked, { redirect: "manual", signal, headers: { accept, "user-agent": USER_AGENT, "accept-language": acceptLanguage() } }),
        catch: (error) => new PreviewFailed({ message: `could not fetch ${asked}: ${(error as Error).message}` }),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location")!, asked).toString();
        continue;
      }
      if (!res.ok) return yield* new PreviewFailed({ message: `${asked} answered ${res.status}` });
      return { res, url: asked };
    }
    return yield* new PreviewFailed({ message: `${link} redirected more than ${REDIRECTS} times` });
  }).pipe(
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new PreviewFailed({ message: `${link} took more than ${Math.round(timeoutMs / 1000)} s` })) }),
  );

const json = (link: string, options: PreviewOptions) =>
  get(link, "application/json", options).pipe(
    Effect.flatMap(({ res }) => Effect.tryPromise({ try: () => res.json() as Promise<Record<string, unknown>>, catch: () => new PreviewFailed({ message: `${link} gave no JSON` }) })),
    Effect.map((body) => (body && typeof body === "object" ? body : {})),
  );

/** A page's HTML, its first MAX_BYTES, and where it ended up after its redirects. */
const page = (link: string, options: PreviewOptions) =>
  get(link, "text/html,application/xhtml+xml", options).pipe(
    Effect.flatMap(({ res, url }) => {
      if (!/html/i.test(res.headers.get("content-type") ?? "text/html")) return Effect.fail(new PreviewFailed({ message: `${url} is not a page` }));
      return Effect.tryPromise({
        try: async () => {
          const reader = res.body?.getReader();
          if (!reader) return { html: "", url };
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (size < MAX_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.length;
          }
          await reader.cancel().catch(() => {});
          return { html: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES)), url };
        },
        catch: (error) => new PreviewFailed({ message: `could not read ${url}: ${(error as Error).message}` }),
      });
    }),
  );
