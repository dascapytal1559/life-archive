// Every view of the map: Orbits 2D, the flat sky, hidden from the switcher
// for now (`hidden`) but still at /orbits; Orbits, the same sky as a solar
// system (at /orbits-3d; its slug, "orbits-3d", is the name its usage and
// settings are kept under); the same map in friend circles (Circles), the
// same map as a spider's web (Spider web), the City (the same closeness as a
// cyberspace city) and the Time river (messages, calls or hangouts over time,
// in the river's look; the Table of everyone and the Calendar that sat before
// it folded into the Events page's on 10 November 2026: movedToEvents.ts),
// then the frozen views, which keep working on the same data but get no new
// work. The view switcher lists them in this order, the main views
// (MAIN_VIEWS: Orbits, the Spider web and the City) first, as a group of
// their own. No React here, so the server's usage report (npm run usage) can
// read the list too.
//
// The app opens on the Spider web (DEFAULT_VIEW): the bare address, /, which is
// no view's own, leads to it, as does any address that names no view.
//
// A view that reads more of the backend than the map (`needs`) is offered only
// where the backend's handshake says it serves that (src/contract/handshake.ts).
//
// The demo (demoMode.ts) is two of this list's views again, on a made-up
// crowd: Orbits (at /orbits-3d) and the Spider web, at the root of the static
// demo's own site, the public demo (PUBLIC_DEMO). The app does not hold it: its
// switcher's Demo opens the public demo, and an old /demo address leads there
// (server/oldDemo.ts).
// It offers the views in DEMO_VIEWS, so a view added here is in the demo only
// once it is added there too.

import type { Capability } from "./archive.ts";
import { offers } from "./contract/handshake.ts";

export interface ViewInfo {
  /** The name usage is recorded under. */
  slug: string;
  path: string;
  title: string;
  /** Frozen: kept as it is, not extended; see AGENTS.md. */
  frozen: boolean;
  /** Left out of the view switcher, though its address still opens it. */
  hidden?: boolean;
  /** What of the data contract it reads beside `map` (archive.ts, CAPABILITIES): a backend without them has no such view. */
  needs?: readonly Capability[];
}

export const VIEWS: ViewInfo[] = [
  { slug: "orbits", path: "/orbits", title: "Orbits 2D", frozen: false, hidden: true },
  { slug: "orbits-3d", path: "/orbits-3d", title: "Orbits", frozen: false },
  { slug: "circles", path: "/circles", title: "Circles", frozen: false },
  { slug: "web", path: "/spider", title: "Spider web", frozen: false },
  { slug: "city", path: "/city", title: "City", frozen: false },
  { slug: "time-river", path: "/time-river", title: "Time river", frozen: false, needs: ["river"] },
  { slug: "river", path: "/river", title: "The river", frozen: true },
  { slug: "reciprocity", path: "/reciprocity", title: "Reciprocity", frozen: true },
];

/** The main views, listed first in the switcher, under "Main views", each naming as many as its own Show top names says (topNames.ts). */
export const MAIN_VIEWS: readonly string[] = ["orbits", "orbits-3d", "web", "city"];

/** The views the demo offers, in this list's order: Orbits (the solar system, at /orbits-3d) and the Spider web, both main views. */
export const DEMO_VIEWS: readonly string[] = ["orbits-3d", "web"];

/** The view the app opens on, at its bare address and at any that names no view: the Spider web, in the demo too. */
export const DEFAULT_VIEW = "web";

/** The views a page offers: the demo's (`demo`), or every one; either way, only those whose backend serves what they read (`offered`). */
export function viewsFor(demo: boolean, offered: (capability: Capability) => boolean = offers): ViewInfo[] {
  return (demo ? VIEWS.filter((view) => DEMO_VIEWS.includes(view.slug)) : VIEWS).filter((view) => (view.needs ?? []).every(offered));
}

/**
 * The public demo, the static demo published on Cloudflare Pages (docs/demo.md), at its Spider web: where the Demo in
 * the real app's switcher opens, in a tab of its own (the demo's switcher has none), and an old /demo address leads.
 */
export const PUBLIC_DEMO = "https://friend-map-demo.pages.dev/spider";

/**
 * Where an address the app's demo once had leads, now the demo is only the public one: /demo to its Spider web, and
 * /demo/<view> to the same address on its site (/demo/orbits-3d to its Orbits; one it has not, to its Spider web, as
 * its site shows any address that names none of its views), the query kept. Null for any other address.
 */
export function oldDemoAddress(url: string): string | null {
  const match = /^\/demo(\/[^?#]*)?\/?([?#].*)?$/.exec(url);
  if (!match) return null;
  const rest = match[1]?.replace(/\/+$/, "");
  return `${rest ? new URL(rest, PUBLIC_DEMO).href : PUBLIC_DEMO}${match[2] ?? ""}`;
}

/** The view at `pathname` among `views` (every view, unless a page offers fewer); undefined for an address that names none. */
export function viewAt(pathname: string, views: readonly ViewInfo[] = VIEWS): ViewInfo | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return views.find((view) => view.path === path);
}

/**
 * Where an address that is no view's own leads: the bare address, /, to the
 * view the app opens on (DEFAULT_VIEW); the demos moved
 * from /demos/<slug> to /<slug>, and the list of demos gave way to the
 * switcher; the Web is now the Spider web, so /web leads to /spider (its slug
 * is still "web", the name its usage is
 * kept under); the canvas (/canvas), the Time machine (/time-machine),
 * Constellations (/constellations) and Friend galaxies (/galaxies) are
 * retired, so their addresses lead to the default view. The Table and the
 * Calendar are no views here now: /demos/table and /demos/calendar lead to
 * /table and /calendar, which movedToEvents.ts sends on to the Events page.
 * Null when the address is current.
 */
export function movedPath(pathname: string): string | null {
  const home = VIEWS.find((view) => view.slug === DEFAULT_VIEW)!.path;
  if (/^\/?$/.test(pathname)) return home;
  if (/^\/(canvas|time-machine|constellations|galaxies)\/?$/.test(pathname)) return home;
  if (/^\/web\/?$/.test(pathname)) return "/spider";
  const match = /^\/demos(?:\/([^/]*))?\/?$/.exec(pathname);
  if (!match) return null;
  if (match[1] === "table" || match[1] === "calendar") return `/${match[1]}`;
  return VIEWS.find((view) => view.slug === match[1])?.path ?? home;
}

/** Where an older address now lives (movedPath), its query and hash kept, so /web?colour=3dff9a opens the Spider web in that colour; null when it is current. */
export function movedAddress(at: Pick<Location, "pathname" | "search" | "hash">): string | null {
  const moved = movedPath(at.pathname);
  return moved === null ? null : `${moved}${at.search}${at.hash}`;
}
