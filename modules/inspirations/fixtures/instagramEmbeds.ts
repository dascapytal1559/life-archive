// A made-up Instagram, for the tests of Instagram's previews (../instagram.ts): each post's public
// embed page in the shapes Instagram serves (its contextJSON, or its HTML alone), the empty shell it gives a request
// without a browser's headers, its login wall, a refusal (429), and each post's pictures on a made-up picture server.
// Every account, caption and picture is made up; nothing here reaches Instagram.

import { stripesPng } from "./inspirations.ts";

/** A made-up post: who posted it, its words, and its picture's colours. */
export interface MadeUpPost {
  username: string;
  caption: string;
  colours: Array<[number, number, number]>;
  /** Its page as HTML alone, without the contextJSON. */
  htmlOnly?: boolean;
}

/** How a made-up post's embed page answers: the post, or Instagram's no-post shell, login wall, refusal or a 404. */
export type MadeUpAnswer = MadeUpPost | "shell" | "login" | "refuse" | "missing";

const PICTURES = "https://scontent-syd2-1.cdninstagram.com/v/made-up";

/** Where a made-up post's picture of `width` is. */
export const pictureLink = (code: string, width: number): string => `${PICTURES}/${code}_s${width}x${width}.jpg?stp=made-up&oe=00000000`;

/** The page Instagram gives a browser for the post `code`. */
export function embedPage(code: string, post: MadeUpPost): string {
  const sizes = [150, 240, 320, 480, 640].map((width) => ({ src: pictureLink(code, width), config_width: width, config_height: width }));
  if (post.htmlOnly) {
    const srcset = [...sizes].reverse().map((size) => `${size.src.replace(/&/g, "&amp;")} ${size.config_width}w`).join(",");
    return `<!DOCTYPE html><html><head><title>Instagram</title></head><body><div class="Embed"><div class="Header">
<a class="Username"><span class="UsernameText">${post.username}</span></a></div>
<div class="EmbeddedMedia"><img class="EmbeddedMediaImage" alt="Instagram post shared by &#064;${post.username}" src="${pictureLink(code, 640).replace(/&/g, "&amp;")}" srcset="${srcset}" /></div>
</div></body></html>`;
  }
  const context = {
    context: { type: "GraphImage", shortcode: code },
    gql_data: {
      shortcode_media: {
        __typename: "GraphImage",
        shortcode: code,
        is_video: false,
        display_url: pictureLink(code, 1080),
        display_resources: [640, 750, 1080].map((width) => ({ src: pictureLink(code, width), config_width: width, config_height: width })),
        thumbnail_resources: sizes,
        edge_media_to_caption: { edges: [{ node: { text: post.caption } }] },
        owner: { id: "1", username: post.username, is_verified: false },
      },
    },
  };
  return `<!DOCTYPE html><html><head><title>Instagram</title></head><body><div id="mount"></div>
<script type="application/json">{"require":[["EmbedPostController",[],[{"contextJSON":${JSON.stringify(JSON.stringify(context))}}]]]}</script></body></html>`;
}

/** The shell of Instagram's app, with its error page in it, that a request without a browser's headers is given. */
export const SHELL_PAGE = `<!DOCTYPE html><html><head><title>Instagram</title></head><body><script type="application/json">
{"polarisRouteConfig":{"pageID":"httpErrorPage"},"page_logging":{"name":"httpErrorPage","params":{}},"page_type":"EMBEDS"}</script></body></html>`;

export const LOGIN_PAGE = `<!DOCTYPE html><html><head><title>Login • Instagram</title></head><body><script type="application/json">
{"polarisRouteConfig":{"pageID":"loginPage"}}</script><form id="loginForm"></form></body></html>`;

/** A made-up Instagram as a fetch, noting each request and its headers; anything not made up is a 404. */
export function fakeInstagram(answers: Record<string, MadeUpAnswer>, asked: Array<{ url: string; headers: Record<string, string> }> = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) });
    const page = /^https:\/\/www\.instagram\.com\/p\/([\w-]+)\/embed\/$/.exec(url);
    if (page) {
      const answer = answers[page[1]];
      if (answer === undefined || answer === "missing") return new Response("", { status: 404 });
      if (answer === "refuse") return new Response("Please wait a few minutes before you try again.", { status: 429 });
      const html = answer === "shell" ? SHELL_PAGE : answer === "login" ? LOGIN_PAGE : embedPage(page[1], answer);
      return new Response(html, { status: 200, headers: { "content-type": 'text/html; charset="utf-8"' } });
    }
    const picture = new RegExp(`^${PICTURES.replace(/[.]/g, "\\.")}/([\\w-]+)_s(\\d+)x\\d+\\.jpg\\?`).exec(url);
    const post = picture ? answers[picture[1]] : undefined;
    if (picture && post && typeof post === "object") {
      const width = Number(picture[2]);
      return new Response(new Uint8Array(stripesPng(width, width, post.colours)), { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response("no", { status: 404 });
  }) as typeof fetch;
}
