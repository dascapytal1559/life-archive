// Where the Friend Map view finds friend-map's page (FriendMapView.tsx): the archive's own server serves it, under
// /friend-map/ on the same host the console was opened at (the module's page, sdk/server.ts's `page`), on this Mac and
// on the tailnet alike, where Tailscale Serve passes /friend-map on to the same server, so the phone's bookmark
// (/friend-map/) opens the same page; with no login anywhere (the tailnet's ACL is the guard).

import { SITE, type Theme } from "../../../sdk/viewer.ts";

/** friend-map's page's path, on the console's own origin (on the demo's site, in a mounted demo: viewer/mount.ts). */
export const FRIEND_MAP_PATH = `${SITE}/friend-map/`;

// The console's look rules inside the frame too (friend-map's src/theme.ts): the frame opens with ?theme=light|dark,
// which friend-map takes over its own choice while the frame is open, and each later flip of the console's look (the
// rail's switch, or Auto following the device) is posted to the frame as { type: "friend-map:theme", theme }, which
// friend-map takes from its parent alone, so the frame switches with no reload.

/** What friend-map listens for from the page that embeds it. */
export const THEME_MESSAGE = "friend-map:theme";

/** friend-map's address `src` opened in the console's look. */
export function withTheme(src: string, theme: Theme): string {
  const url = new URL(src, "http://placeholder.invalid");
  url.searchParams.set("theme", theme);
  return /^[a-z][a-z0-9+.-]*:/i.test(src) ? url.href : `${url.pathname}${url.search}${url.hash}`;
}

/** Tells the frame's window the console's look; `origin` is friend-map's, so the message goes to friend-map alone. */
export function postTheme(frame: Pick<Window, "postMessage"> | null | undefined, theme: Theme, origin: string): void {
  frame?.postMessage({ type: THEME_MESSAGE, theme }, origin);
}

/**
 * friend-map's address `src` open at the person the console's own address names (?person=<id>, how the Events
 * calendar opens someone in Friend Map): friend-map opens their panel (its page/src/demos/personAddress.ts). `src` as
 * it is for an address that names nobody.
 */
export function atPerson(src: string, consoleSearch: string): string {
  const person = new URLSearchParams(consoleSearch).get("person");
  if (person === null || !/^\d+$/.test(person)) return src;
  const url = new URL(src, "http://placeholder.invalid");
  url.searchParams.set("person", person);
  return /^[a-z][a-z0-9+.-]*:/i.test(src) ? url.href : `${url.pathname}${url.search}${url.hash}`;
}
