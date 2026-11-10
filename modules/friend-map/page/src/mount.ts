// Where the page was opened: at the root of its host (http://localhost:4600/spider), or under friend-map's own path
// (https://<host>/friend-map/spider, Tailscale Serve's mount beside other apps; server/basePath.ts), read once from the
// address as it opens. The views and the usage record go by the app's own paths (/spider, /orbits-3d), which
// appPath reads from the address; every link, history entry and request to the server goes through address, so it
// stays under the mount the page was opened at. The static demo is built for the root of its own site, so it never
// has one.

/** friend-map's own path, from Vite's base (vite.config.ts): "/friend-map" in the app, "" in the static demo and the tests. */
const BASE: string = (import.meta.env?.BASE_URL ?? "/").replace(/\/+$/, "");

/** The mount `pathname` is under: `base` when it is that or under it, else "" (the root). */
export function mountOf(pathname: string, base: string = BASE): string {
  return base !== "" && (pathname === base || pathname.startsWith(`${base}/`)) ? base : "";
}

/** The mount this page was opened at, for the life of the page. */
export const mount: string = mountOf(globalThis.location?.pathname ?? "/");

/** The app's own path of an address's path, the mount taken off: /friend-map/spider is /spider, /friend-map is /. */
export function appPath(pathname: string, at: string = mount): string {
  return at !== "" && (pathname === at || pathname.startsWith(`${at}/`)) ? pathname.slice(at.length) || "/" : pathname;
}

/** The address of one of the app's paths (a view, /api/...), under the mount: /spider is /friend-map/spider there. */
export function address(path: string, at: string = mount): string {
  return `${at}${path}`;
}
