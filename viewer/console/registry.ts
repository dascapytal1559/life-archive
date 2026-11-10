// The console's views, one typed list (docs/console.md's "The console"): each view says which aspects it sits under, its slug
// there (its section, which makes its address: /life-archive/dev/<aspect>/<section>), what it is in a line, and what
// draws it. Adding a view to the console is one entry here, or one entry in the list a view's own file gives
// (eventsViews and the rest), or, for a module, one in its viewer.tsx (sdk/viewer.ts). An aspect is an angle on the
// whole archive, not a bucket of it, so a view may sit under
// several aspects and an aspect holds any number of views; an aspect's views are its page's own tabs in this list's
// order, or the order a view's `order` gives (the rail lists the aspects alone), and its address alone opens the first; after them an aspect's links, tabs
// that open a page elsewhere in a browser tab of their own (a module's, from what its settings told the page). An
// aspect renamed keeps its former keys, so an old address still opens it, and a place that moved to another page says
// where (moved.ts: Friend Map's Messages tab, now a table of Events' Tables). registryProblems says what is wrong with a
// list, and registry.test.ts keeps this one right.
//
// The modules' aspects and views (viewer/modules.ts: the viewer.tsx of each module the server said is on, loaded before
// this loads) join the core's here, so a module's page is a page like any other, and a module's view listing a core
// aspect among its own is a tab on that page. ASPECTS and VIEWS are every loaded module's with the core's; what this archive shows (aspectsOn, viewsOn)
// leaves out a module the server said is off or broken, or did not name (PageSettings.modules).

import type { ReactNode } from "react";
import type { PageSettings } from "../wire.ts";
import { consolePath, isSlug, stepsOf } from "./address.ts";
import { EVENTS_ASPECT, eventsViews } from "./EventsSection.tsx";
import type { IconDrawing, IconName } from "./icons.tsx";
import { moduleViewers } from "../modules.ts";
import { MOVED, stepsNow } from "./moved.ts";
import { moduleFailed } from "./ViewFailed.tsx";

/** An aspect: an angle on the whole archive, a place in the rail. */
export interface Aspect {
  /** Its slug in the address. */
  key: string;
  label: string;
  /** What it is, in a line, under its name. */
  blurb: string;
  /** Its icon by name, or a drawing of its own (a module's mark). */
  icon: IconName | IconDrawing;
  /** Its keys before a rename: an address or a kept order naming one means this aspect. */
  formerKeys?: readonly string[];
  /** Tabs after its views that open a page elsewhere, in a browser tab of their own. */
  links?: () => AspectLink[];
}

/** A tab that opens a page elsewhere in a browser tab of its own, rather than showing a view. */
export interface AspectLink {
  label: string;
  /** What it opens, in a line. */
  blurb: string;
  /** Its address, worked out when drawn (the page it opens may be configured, as a module's settings may say where). */
  href: () => string;
}

/** A view: what one of an aspect's tabs shows. */
export interface View {
  /** Unique across the registry. */
  key: string;
  /** Its name on its tab. */
  label: string;
  /** The aspects it sits under, by key: one or more. */
  aspects: readonly string[];
  /** Its slug in the address under each of them; unique within an aspect. */
  section: string;
  /** Sections it answered to before (old addresses), which still open it rather than the aspect's first view. */
  formerSections?: readonly string[];
  /** Aspects it was the page of before it became a tab (old addresses): an address naming one opens it. */
  formerAspects?: readonly string[];
  /** What it shows, in a line. */
  blurb: string;
  /**
   * Where its tab sits among its aspect's tabs: the smaller first, and a view with none after every view that has one, in
   * the registry's order (so a page nobody orders reads as it always did). It is one number for every aspect the view sits
   * under, which is how a module's tab on a core page is placed between the core's own (Events' Daily rituals, 2nd).
   */
  order?: number;
  /** Fills the content area edge to edge with no padding (an embedded page, a map), rather than scrolling inside it. */
  fill?: boolean;
  /** Draws it, told which aspect it is shown under. */
  component: (at: { aspect: Aspect }) => ReactNode;
}

/** The core's aspects, in no order of their own: the rail's is RAIL's. Events, the home, is always on (src/pages.ts); every other page is a module's. */
const CORE_ASPECTS: readonly Aspect[] = [
  {
    key: EVENTS_ASPECT, label: "Events", icon: "events",
    blurb: "The life archive's home: every message, call, hangout, LLM session, workout and ritual, as metadata, on a calendar; every table the archive keeps, each as it is kept; and where each comes from.",
  },
];

/**
 * The rail, in the captain's order, by key: the default, which he may change on a desk (order.ts keeps his own on the
 * device). Events first, the home (HOME), then Journal, by the captain's word ("rail second after Events, sure", 9 November 2026). A module's aspect (Health Record, Fitness) is placed by its key here too, so the rail reads the same whether
 * a page is the core's or a module's; an aspect not named (a module added since) follows the named ones, in the modules' order.
 */
export const RAIL: readonly string[] = [EVENTS_ASPECT, "journal", "friend-map", "health-record", "fitness", "inspirations", "shopping"];

/** The console's home, what the archive's own address opens: Events, the captain's ("events is almost gonna become like home page for life archive"). */
export const HOME = EVENTS_ASPECT;

/** `aspects` in RAIL's order, those RAIL does not name after them in their own order. */
export function railOrder(aspects: readonly Aspect[]): Aspect[] {
  const place = (aspect: Aspect) => {
    const at = RAIL.indexOf(aspect.key);
    return at === -1 ? RAIL.length : at;
  };
  return [...aspects].sort((a, b) => place(a) - place(b));
}

/**
 * The keys of the pages of each module this repository holds, by its id, known without its viewer.tsx: where a module
 * whose viewer.tsx did not load says so, at its pages' own addresses. Rituals has none (its tabs are on Events and
 * Fitness), so it says so as a tab on Events; a module not named (a private one) says so at its id.
 */
export const MODULE_PAGES: Readonly<Record<string, readonly string[]>> = {
  exercise: ["fitness"], "friend-map": ["friend-map"], health: ["health-record"], inspirations: ["inspirations"], journal: ["journal"], rituals: [], shopping: ["shopping"],
};

/** What stands in for the module `id`'s page half, which did not load (`why`): moduleFailed at its pages (MODULE_PAGES), or on Events with none. */
export function moduleStandIn(id: string, why: string) {
  const pages = Object.hasOwn(MODULE_PAGES, id) ? MODULE_PAGES[id]! : [id];
  return moduleFailed(id, why, pages, pages.length > 0 ? pages : [EVENTS_ASPECT]);
}

/** The modules' page halves, loaded before this (viewer/main.tsx): only those the server said are on, one that did not load as a page saying so. */
const MODULE_VIEWERS = moduleViewers().map(({ id, viewer, failed }) => ({ id, viewer: viewer ?? moduleStandIn(id, failed) }));

/** The module each aspect of the modules belongs to, by the aspect's key; a core aspect is in neither map. */
const MODULE_OF_ASPECT: ReadonlyMap<string, string> = new Map(MODULE_VIEWERS.flatMap(({ id, viewer }) => viewer.aspects.map((aspect) => [aspect.key, id] as const)));
/** The module each view of the modules belongs to, by the view's key. */
const MODULE_OF_VIEW: ReadonlyMap<string, string> = new Map(MODULE_VIEWERS.flatMap(({ id, viewer }) => viewer.views.map((view) => [view.key, id] as const)));

/** The rail: the core's aspects and every loaded module's, in RAIL's order. */
export const ASPECTS: readonly Aspect[] = railOrder([...CORE_ASPECTS, ...MODULE_VIEWERS.flatMap(({ viewer }) => viewer.aspects)]);

/** Every view: the core's, then each loaded module's. */
export const VIEWS: readonly View[] = [...eventsViews(), ...MODULE_VIEWERS.flatMap(({ viewer }) => viewer.views)];

/** Whether the module `id` is on, as the server told the page: one it did not name is off. */
const moduleOn = ({ modules }: PageSettings, id: string | undefined): boolean => id === undefined || modules[id] === true;

/**
 * The aspects this archive has: all but a module's whose module is off (viewer/wire.ts's PageSettings). An unfinished
 * page (src/pages.ts) is one of these: the server says its module is off.
 */
export function aspectsOn(settings: PageSettings, aspects: readonly Aspect[] = ASPECTS): Aspect[] {
  return aspects.filter((aspect) => moduleOn(settings, MODULE_OF_ASPECT.get(aspect.key)));
}

/** The views this archive has: all but a module's whose module is off, wherever they sit (the rituals module's Daily rituals on Events). */
export function viewsOn(settings: PageSettings, views: readonly View[] = VIEWS): View[] {
  return views.filter((view) => moduleOn(settings, MODULE_OF_VIEW.get(view.key)));
}

/** The aspect with `key`, if the console has it. */
export function aspectOf(key: string, aspects: readonly Aspect[] = ASPECTS): Aspect | undefined {
  return aspects.find((aspect) => aspect.key === key);
}

/** The aspect `key` names, its own key or one it had before a rename. */
export function aspectNamed(key: string, aspects: readonly Aspect[] = ASPECTS): Aspect | undefined {
  return aspectOf(key, aspects) ?? aspects.find((aspect) => aspect.formerKeys?.includes(key));
}

/** The views under the aspect `key`: its page's tabs, by their `order`, then the registry's. */
export function viewsOf(key: string, views: readonly View[] = VIEWS): View[] {
  // Array.prototype.sort is stable, so views with the same order (or none) keep the registry's order.
  const place = (view: View) => view.order ?? Number.POSITIVE_INFINITY;
  return views.filter((view) => view.aspects.includes(key)).sort((a, b) => (place(a) < place(b) ? -1 : place(a) > place(b) ? 1 : 0));
}

/** A place in the console: a view under an aspect. */
export interface Place {
  aspect: Aspect;
  view: View;
}

/** The console's home: HOME at its first view, wherever the rail's order puts it. */
export function homeOf(aspects: readonly Aspect[] = ASPECTS, views: readonly View[] = VIEWS): Place {
  return { aspect: aspectOf(HOME, aspects)!, view: viewsOf(HOME, views)[0] };
}

/**
 * The place an address names: none (undefined, the console opens its home) for the console itself or an aspect it does not know, an aspect's first
 * view for the aspect alone or a section it does not have (a link to a view since renamed), a view by a section it
 * had before (formerSections), else that view. An aspect
 * renamed is found by its former key too (Fitness at /life-archive/dev/exercise, its address before), and a page
 * that became a tab by its old key opens that tab, whatever section follows (Don't Die's, Fitness's Bryan Johnson).
 * An address naming a place that moved (`moved`: Friend Map's Messages tab, now a table of Events' Tables) is read as
 * the address it moved to.
 */
export function placeOf(pathname: string, aspects: readonly Aspect[] = ASPECTS, views: readonly View[] = VIEWS, moved: Readonly<Record<string, string>> = MOVED): Place | undefined {
  const [aspectKey, section] = stepsNow(stepsOf(pathname), moved);
  const aspect = aspectNamed(aspectKey, aspects);
  if (!aspect) {
    const moved = views.find((v) => v.formerAspects?.includes(aspectKey));
    const under = moved && aspectOf(moved.aspects[0], aspects);
    return moved && under ? { aspect: under, view: moved } : undefined;
  }
  const under = viewsOf(aspect.key, views);
  const view = under.find((v) => v.section === section) ?? under.find((v) => v.formerSections?.includes(section)) ?? under[0];
  return view ? { aspect, view } : undefined;
}

/** The address of a place, as the console writes it: an aspect's first view is the aspect's address itself. */
export function pathOf(place: Place, views: readonly View[] = VIEWS): string {
  const first = viewsOf(place.aspect.key, views)[0];
  return consolePath(place.aspect.key, place.view === first ? undefined : place.view.section);
}

/**
 * What the browser's tab says of a place: the view, its page and the archive, or for a page of one view (which has no
 * tabs, so its view's name is seen nowhere) the page and the archive.
 */
export function titleOf(place: Place, views: readonly View[] = VIEWS): string {
  const alone = viewsOf(place.aspect.key, views).length < 2;
  return `${alone ? "" : `${place.view.label} · `}${place.aspect.label} · Life archive`;
}

/** What is wrong with a registry, each in a line; nothing for a sound one. `moved` is its places that moved (moved.ts's MOVED). */
export function registryProblems(aspects: readonly Aspect[], views: readonly View[], moved: Readonly<Record<string, string>> = {}): string[] {
  const problems: string[] = [];
  for (const [from, to] of Object.entries(moved)) {
    const [fromAspect = "", fromSection = "", ...fromMore] = from.split("/");
    const [toAspect = "", toSection = "", ...toMore] = to.split("/");
    if (![fromAspect, fromSection, toAspect, toSection].every(isSlug) || fromMore.length > 0 || toMore.length > 0) {
      problems.push(`moved ${from} to ${to}: each is an aspect's slug and a section's, joined by a slash`);
      continue;
    }
    if (views.some((view) => view.aspects.includes(fromAspect) && view.section === fromSection)) problems.push(`moved ${from}: a view is still at that address, which would never be reached`);
    if (Object.hasOwn(moved, to)) problems.push(`moved ${from} to ${to}: that place moved too; name where it is now`);
    const under = aspects.some((aspect) => aspect.key === toAspect) ? views.filter((view) => view.aspects.includes(toAspect)) : [];
    if (!under.some((view) => view.section === toSection || view.formerSections?.includes(toSection))) problems.push(`moved ${from} to ${to}: no view answers to that address`);
  }
  const aspectKeys = new Set<string>();
  for (const aspect of aspects) {
    if (!isSlug(aspect.key)) problems.push(`aspect ${JSON.stringify(aspect.key)}: its key is not a slug (lowercase words joined by dashes)`);
    if (aspectKeys.has(aspect.key)) problems.push(`aspect ${aspect.key}: two aspects have this key`);
    aspectKeys.add(aspect.key);
    if (!aspect.label.trim()) problems.push(`aspect ${aspect.key}: no label`);
    if (viewsOf(aspect.key, views).length === 0) problems.push(`aspect ${aspect.key}: no view sits under it`);
    for (const former of aspect.formerKeys ?? []) {
      if (!isSlug(former)) problems.push(`aspect ${aspect.key}: its former key ${JSON.stringify(former)} is not a slug`);
      if (aspects.some((other) => other.key === former)) problems.push(`aspect ${aspect.key}: its former key ${former} is another aspect's key`);
    }
  }
  const viewKeys = new Set<string>();
  const sections = new Set<string>();
  for (const view of views) {
    if (viewKeys.has(view.key)) problems.push(`view ${view.key}: two views have this key`);
    viewKeys.add(view.key);
    if (!view.label.trim()) problems.push(`view ${view.key}: no label`);
    if (!isSlug(view.section)) problems.push(`view ${view.key}: its section ${JSON.stringify(view.section)} is not a slug`);
    if (view.aspects.length === 0) problems.push(`view ${view.key}: under no aspect`);
    for (const former of view.formerAspects ?? []) {
      if (!isSlug(former)) problems.push(`view ${view.key}: its former aspect ${JSON.stringify(former)} is not a slug`);
      if (aspects.some((a) => a.key === former || a.formerKeys?.includes(former))) problems.push(`view ${view.key}: its former aspect ${former} still names an aspect, so its address never reaches the view`);
    }
    for (const key of view.aspects) {
      if (!aspectKeys.has(key)) problems.push(`view ${view.key}: no aspect ${key}`);
      const at = `${key}/${view.section}`;
      if (sections.has(at)) problems.push(`view ${view.key}: another view is already at ${at}`);
      sections.add(at);
    }
  }
  return problems;
}
