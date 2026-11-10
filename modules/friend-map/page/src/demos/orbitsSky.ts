// The sky that Orbits (Orbits.tsx) and Orbits 3D (Orbits3D.tsx) share: the
// stage round the sun, where everyone is placed (the geometry in
// orbitsLayout.ts, the zoom's maths in orbitsZoom.ts), how they move there,
// and which names are placed where. Both views draw the same people in the
// same places from these hooks, so a change to where someone sits or who is
// named is made once, here, and Orbits 3D seen from straight above is Orbits.
// Nothing here draws: each view draws what it is given its own way.

import { easeCubicInOut, easeCubicOut, max, scaleSqrt } from "d3";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { livesTogether } from "../archive.ts";
import { isAspiring } from "../aspiring.ts";
import type { Names } from "../names.ts";
import { friendCircles, presence } from "./friendCircles.ts";
import { standing, trendAt, type DemoModel, type DemoPerson } from "./model.ts";
import {
  ASPIRING_CLEAR, aspiringPlaces, aspiringSize, byName, centreOnIcons, directions, drawnSize, fitNames, glowOf, hearth, movesVisibly, namedIds, orbitRadius, placeBodies, READABLE, spread,
  textUnits, TIERS, trailStartRank, wrap,
  type Box, type Drawn, type LabelSpot, type Placed, type RankScale,
} from "./orbitsLayout.ts";
import { DEFAULT_NAME_FADE, nameHidden, type NameFade } from "./nameFade.ts";
import { chooseNamed, type Zoom } from "./orbitsZoom.ts";
import { SURELY_NAMED } from "./topNames.ts";

/**
 * How many of the closest have markers at least READABLE, so their
 * identicons can be read: the last tier (TIERS), the closest 100, however
 * many a view names (its Show top names, topNames.ts), so changing that never
 * moves anyone.
 */
export const READABLE_CLOSEST = TIERS[TIERS.length - 1].closest;
/** How many of those have their name at full size; the rest are a little smaller. */
export const NAMED_LARGE = 14;
/** The smaller names' type size, as a share of the full size (orbits__name--minor). */
export const MINOR_SCALE = 0.84;
/**
 * An average character's width in the Spider web's names (orbits.css: 11 pixels
 * of a monospaced type, 0.04em apart), as centreOnIcons measures names: wider
 * than Orbits' serif, whose 6.6 centreOnIcons takes unless told otherwise.
 */
export const WEB_CHAR_WIDTH = 7.25;
/** A marker this small or smaller (the least talked-to) may sit under a name that has no room nearby otherwise. */
const FAINT = 3.4;
/** Beyond the last orbit: the belt of people with no closeness yet. */
export const BELT = 11;
/** How far, in pixels, someone still on the move has to go before their name and trail start to show. */
export const ARRIVED = 36;
/** Kept clear at the top, in radians, for the ring labels. */
export const TOP_GAP = 0.26;

/** The order round the sun: A to Z by name on Orbits, friend circles on Circles. */
export type OrbitOrder = "name" | "circles";

/** What is drawn for one person at one moment; tweened as it changes. */
export type Frame = Drawn;

export type XY = { x: number; y: number };

/**
 * The stage: the sun in the middle of the space under the header (`top`
 * pixels of it), orbits out to leave room for the belt of people with no
 * closeness yet and their names: 70 pixels a side across, and down to 34
 * from the window's foot, where nothing else sits. Everything is placed
 * relative to the sun, unzoomed; the zoom spreads it out from there when it
 * is drawn.
 */
export function stageOf(width: number, height: number, top: number): { outer: number; inner: number; cx: number; cy: number } {
  const area = height - top - 24;
  const outer = Math.max(90, Math.min(width / 2 - 70, area / 2 - 16));
  const inner = Math.max(34, outer * 0.16);
  return { outer, inner, cx: width / 2, cy: top + area / 2 + 6 };
}

/** Kept clear of the page's sides beside an aspiring friend's bubble, for the name under it. */
const ASPIRING_SIDE = 64;
/** Kept clear over and under an aspiring friend's bubble: a little over it, and under it for their name. */
const ASPIRING_OVER = 8;
const ASPIRING_UNDER = 26;
/** How far under an aspiring friend's bubble the middle of their name sits. */
export const ASPIRING_NAME_GAP = 12;

/**
 * The edge aspiring friends sit on (aspiringPlaces), relative to the sun at (`cx`, `cy`): as far out as a bubble of
 * `size` and its name stay on a page `width` by `height`, under the header (`top` pixels of it).
 */
export function aspiringEdge(width: number, height: number, top: number, cx: number, cy: number, size: number): Box {
  return {
    left: ASPIRING_SIDE + size - cx,
    right: width - ASPIRING_SIDE - size - cx,
    top: top + ASPIRING_OVER + size - cy,
    bottom: height - ASPIRING_UNDER - size - cy,
  };
}

/** Where everyone is headed: each person's frame and place, and how far the system reaches from the sun. */
export interface Targets {
  frames: Map<number, Frame>;
  placed: Map<number, Placed>;
  /** The box round the system, relative to the sun, unzoomed. */
  extent: Box;
  /** How far from the sun the furthest edge is: the belt, or anyone nudged beyond it, aspiring friends aside. */
  reach: number;
}

/**
 * Where everyone sits round the sun as of month `at`, placed relative to the
 * sun, unzoomed (see orbitsLayout.ts): ranks run over everyone on the map,
 * whoever you live with sits in the sun (hearth), and the rest are
 * placed on their orbits by closeness rank, spread A to Z or in friend
 * circles (`order`), nudged apart. With it, what the views need of each
 * person: their standing now, their place by closeness (`closest`, 1 for the
 * closest), their trend over the look-back window, and where their comet
 * trail starts (`trailFrom`), and how far from the sun a rank sits (`radius`):
 * on Orbits' own scale, or the Spider web's even one (`scale`, RankScale).
 * Aspiring friends (`aspiring`) sit out on `edge` (aspiringEdge), away from
 * everyone else, who are placed as if they were not there.
 */
export function useOrbitBodies(model: DemoModel, at: number, inner: number, outer: number, order: OrbitOrder, edge: Box, scale: RankScale = "log") {
  // Aspiring friends, A to Z; everyone else, who have the orbits to themselves.
  const far = useMemo(() => model.people.filter(isAspiring).sort(byName), [model.people]);
  const aspiring = useMemo(() => new Set(far.map((p) => p.id)), [far]);
  const ringed = useMemo(() => (far.length > 0 ? model.people.filter((p) => !aspiring.has(p.id)) : model.people), [model.people, far, aspiring]);
  // Ranks run over everyone on the orbits.
  const count = ringed.length;
  // Whoever you live with: ranked first (closenessRanks), and set in the sun (hearth).
  const together = useMemo(() => ringed.filter(livesTogether).map((p) => p.id), [ringed]);
  // How far from the sun someone of a rank sits, unzoomed; a guide ring by its rank (rings) too.
  const radius = useCallback(
    (rank: number | null) => orbitRadius(rank, inner, outer, count, together.length, scale),
    [inner, outer, count, together, scale],
  );

  const bySize = useMemo(() => {
    const top = max(ringed, (p) => p.total) || 1;
    return scaleSqrt().domain([0, top]).range([2.8, Math.min(15, Math.max(8, outer * 0.04))]);
  }, [ringed, outer]);

  const standings = useMemo(() => new Map(model.people.map((p) => [p.id, standing(p, at, model)])), [model, at]);
  // Everyone's place by closeness (1 for the closest), which sets how strongly they and their name are drawn (TIERS);
  // the belt, with no closeness yet, has none.
  const closest = useMemo(() => new Map(namedIds(ringed, at, count).map((id, i) => [id, i + 1])), [ringed, at, count]);
  // Friend circles, worked out only while chosen, and then once per change to who is on the map: each person takes
  // room round the ring by how much they show (presence, by their tier), so the circles near the sun get the most.
  const circles = useMemo(
    () => (order === "circles" ? friendCircles(ringed, model.groups, new Map(ringed.map((p) => [p.id, presence(closest.get(p.id) ?? null)]))) : null),
    [order, ringed, model.groups, closest],
  );
  const aim = useMemo(
    () => (circles ? spread(circles.order, TOP_GAP, { weights: circles.weights, gaps: circles.gaps }) : directions(ringed, TOP_GAP)),
    [circles, ringed],
  );
  const trends = useMemo(() => new Map(model.people.map((p) => [p.id, trendAt(p, at, model)])), [model, at]);
  // Where each person sat at the start of the look-back window before `at` (or their first month in it):
  // their comet trail runs from there to where they sit now.
  const trailFrom = useMemo(
    () => new Map(model.people.map((p) => {
      const rank = trailStartRank(p.rank, at, model.settings.trendMonths);
      return [p.id, rank === null ? null : radius(rank)];
    })),
    [model, at, radius],
  );

  const targets = useMemo((): Targets => {
    const home = new Set(together);
    const bodies = ringed.map((p) => {
      const s = standings.get(p.id)!;
      const silent = p.rank[at] === 0;
      return {
        id: p.id,
        orbit: silent ? outer + BELT : radius(p.rank[at]),
        // The closest READABLE_CLOSEST are drawn big enough to read their identicons; the rest by how much you have talked.
        size: silent ? 2.6 : (closest.get(p.id) ?? Infinity) <= READABLE_CLOSEST ? Math.max(READABLE, bySize(s.total)) : bySize(s.total),
        ...aim.get(p.id)!,
      };
    });
    // Nudged out rather than in: a crowd near the sun spreads to the orbits just beyond. Whoever you live
    // with sits in the sun, inside them all, and is never nudged.
    const bubble = aspiringSize(outer);
    const placed = new Map([
      ...placeBodies(bodies.filter((b) => !home.has(b.id)), { giveIn: 4, giveOut: (outer - inner) * 0.12 + 8, minR: inner * 0.92 }),
      ...hearth(together, aim, inner),
      ...aspiringPlaces(far.map((p) => p.id), edge, outer + BELT + ASPIRING_CLEAR + bubble),
    ]);
    const sizes = new Map([...bodies.map((b): [number, number] => [b.id, b.size]), ...far.map((p): [number, number] => [p.id, bubble])]);
    const frames = new Map<number, Frame>();
    // How far the system reaches from the sun: the belt, and anyone nudged beyond it.
    const extent = { left: -(outer + BELT), right: outer + BELT, top: -(outer + BELT), bottom: outer + BELT };
    // How far from the sun the furthest edge is: the belt, or anyone nudged beyond it.
    let reach = outer + BELT;
    model.people.forEach((person) => {
      const size = sizes.get(person.id)!;
      const p = placed.get(person.id)!;
      const silent = person.rank[at] === 0;
      frames.set(person.id, {
        angle: p.angle,
        r: p.r,
        size,
        glow: glowOf(person),
        opacity: 1,
        silent,
      });
      extent.left = Math.min(extent.left, p.x - size);
      extent.right = Math.max(extent.right, p.x + size);
      extent.top = Math.min(extent.top, p.y - size);
      extent.bottom = Math.max(extent.bottom, p.y + size);
      if (!aspiring.has(person.id)) reach = Math.max(reach, p.r + size);
    });
    return { frames, placed, extent, reach };
  }, [model.people, ringed, far, aspiring, edge, at, standings, aim, inner, outer, bySize, closest, together, radius]);

  return { count, together, aspiring, radius, bySize, standings, closest, circles, aim, trends, trailFrom, targets };
}

/** A map's names' type, as orbits.css draws them: sizes in pixels, at full size and smaller (MINOR_SCALE's), the family, the spacing between letters in ems, and an average letter's width (centreOnIcons' charWidth). */
export interface NameFont {
  size: number;
  minor: number;
  family: string;
  spacing: number;
  charWidth: number;
}
/** Orbits' names' type (.orbits__name; its family is demos.css's --serif). */
export const NAME_FONT: NameFont = { size: 12.5, minor: 10.5, family: '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif', spacing: 0, charWidth: 6.6 };
/** The Spider web's names' type (.orbits--web .orbits__name). */
export const WEB_NAME_FONT: NameFont = { size: 11, minor: 9.5, family: "ui-monospace, Menlo, monospace", spacing: 0.04, charWidth: WEB_CHAR_WIDTH };
let inkCanvas: CanvasRenderingContext2D | null | undefined;

/**
 * What a name centred on its person's spot (centreOnIcons) covers, as offsets
 * from that spot: its ink, as the browser draws it in the map's type (`font`,
 * at full size or, with `scale` MINOR_SCALE, smaller), measured on a canvas, so a name of narrow letters takes less
 * room than one as long of wide ones, and one with no descender sits higher; where there is no canvas (the
 * tests), as centreOnIcons estimates a name, a box of its average width.
 */
export function nameInk(text: string, scale: number, font: NameFont = NAME_FONT): Box {
  if (inkCanvas === undefined) inkCanvas = typeof document === "undefined" ? null : (document.createElement("canvas").getContext?.("2d") ?? null);
  const baseline = 4 * scale;
  if (inkCanvas) {
    const px = scale < 1 ? font.minor : font.size;
    inkCanvas.font = `400 ${px}px ${font.family}`;
    inkCanvas.letterSpacing = `${font.spacing * px}px`;
    inkCanvas.textAlign = "center";
    const m = inkCanvas.measureText(text);
    return { left: -m.actualBoundingBoxLeft, right: m.actualBoundingBoxRight, top: baseline - m.actualBoundingBoxAscent, bottom: baseline + m.actualBoundingBoxDescent };
  }
  const [w, h] = [textUnits(text) * font.charWidth * scale, 13 * scale];
  return { left: -w / 2, right: w / 2, top: -h / 2, bottom: h / 2 };
}

/**
 * Everyone worth naming, closest first: those with a closeness score
 * (`ranked` of them, in `closest`'s order), then the belt, most talked to
 * first, named only once zooming in opens room for them.
 */
export function nameOrderOf(
  people: readonly DemoPerson[],
  at: number,
  closest: ReadonlyMap<number, number>,
  keep: (id: number) => boolean = () => true,
): { order: number[]; ranked: number } {
  const ranked = [...closest.keys()].filter(keep);
  const belt = people.filter((p) => !(p.rank[at] > 0) && keep(p.id)).sort((a, b) => b.total - a.total || a.id - b.id);
  return { order: [...ranked, ...belt.map((p) => p.id)], ranked: ranked.length };
}

/**
 * Whose names may be drawn, by how names fade (`fade`, nameFade.ts): everyone
 * but those whose names have faded out entirely (nameHidden), who keep their
 * icons; and of the people to reach out to, named wherever they are, those.
 */
export function nameable(closest: ReadonlyMap<number, number>, reachOut: ReadonlySet<number>, fade: NameFade): { keep: (id: number) => boolean; always: ReadonlySet<number> } {
  if (fade.faintest > 0) return { keep: () => true, always: reachOut };
  const keep = (id: number) => !nameHidden(closest.get(id) ?? null, fade);
  return { keep, always: new Set([...reachOut].filter(keep)) };
}

/** The type size of the name of whoever is `place`th closest (1 the closest), as a share of the full size: the closest NAMED_LARGE at full size. */
export function nameScale(place: number | undefined): number {
  return (place ?? Infinity) <= NAMED_LARGE ? 1 : MINOR_SCALE;
}

export interface FitInput {
  /** Whether names are fitted at all: only on Orbits and the Spider web in A to Z order, off a phone, with some named. */
  on: boolean;
  model: DemoModel;
  at: number;
  closest: ReadonlyMap<number, number>;
  /** How many of the closest are named unzoomed (Show top names), and who else is named wherever they are. */
  named: number;
  reachOut: ReadonlySet<number>;
  /** Whoever you live with, in the sun: never moved. */
  together: readonly number[];
  label: Names["label"];
  /** The names' type: Orbits', or the Spider web's. */
  font: NameFont;
  /** Marks names stay off as off each other (the ring labels), relative to the sun, unzoomed. */
  around: readonly Box[];
  /** The clear space, in pixels, kept between two names' ink, and between a name and a mark `around` (the view's Name padding, namePadding.ts). */
  padding: number;
  /** How names fade (nameFade.ts): a name faded out entirely is not fitted. */
  fade?: NameFade;
}

/**
 * Where everyone sits, each name standing in for its person's icon: the people named on the whole map (as useOrbitNames names
 * them unzoomed) turned round their orbits until no name covers another
 * (fitNames), each name measured as drawn (nameInk, in Orbits' type or the
 * Spider web's), the closest kept where
 * they are and further ones turned aside a few degrees into the nearest free
 * room, off the ring labels too, `padding` pixels clear of each. Distance from the sun, closeness, never
 * changes, nor does anyone else's place. Zooming in only spreads the map out,
 * so names clear unzoomed stay clear. `targets` as they are when `on` is false.
 */
export function useNameFit(targets: Targets, input: FitInput): Targets {
  const { on, model, at, closest, named, reachOut, together, label, font, around, padding, fade = DEFAULT_NAME_FADE } = input;
  return useMemo(() => {
    if (!on) return targets;
    const { keep, always } = nameable(closest, reachOut, fade);
    const { order, ranked } = nameOrderOf(model.people, at, closest, keep);
    const place = new Map(order.map((id, i) => [id, i]));
    const room = Math.min(named, ranked);
    const chosen = chooseNamed(order, Math.min(room, SURELY_NAMED), 1, () => true, always, room);
    const home = new Set(together);
    const names = [...chosen.required, ...chosen.optional]
      .sort((a, b) => place.get(a)! - place.get(b)!)
      .flatMap((id) => {
        const text = nameOf(model.people, id, label);
        if (text === "") return [];
        return [{ id, box: nameInk(text, nameScale(closest.get(id)), font), fixed: home.has(id) }];
      });
    const placed = fitNames(targets.placed, names, { topGap: TOP_GAP, around, pad: padding });
    const frames = new Map(targets.frames);
    const extent = { ...targets.extent };
    for (const [id, p] of placed) {
      const frame = targets.frames.get(id)!;
      if (p.angle === frame.angle) continue;
      frames.set(id, { ...frame, angle: p.angle });
      extent.left = Math.min(extent.left, p.x - frame.size);
      extent.right = Math.max(extent.right, p.x + frame.size);
      extent.top = Math.min(extent.top, p.y - frame.size);
      extent.bottom = Math.max(extent.bottom, p.y + frame.size);
    }
    return { frames, placed, extent, reach: targets.reach };
  }, [on, targets, model.people, at, closest, named, reachOut, together, label, font, around, padding, fade]);
}

/** A name as placed on the map: its spot (see centreOnIcons), as an offset (`dx`, `dy`) from its person, so it is carried along with them. */
export interface PlacedName extends LabelSpot {
  dx: number;
  dy: number;
  /** Named only because they are linked to whoever is held: drawn at the Faintest name (nameFade.ts). */
  linkedOnly: boolean;
}

export interface NamesInput {
  model: DemoModel;
  at: number;
  /** Everyone's place by closeness (useOrbitBodies). */
  closest: ReadonlyMap<number, number>;
  /** How many of the closest are named unzoomed (the view's Show top names, topNames.ts; ALL for everyone). */
  named: number;
  /** People to reach out to: named wherever they are. */
  reachOut: ReadonlySet<number>;
  names: Names;
  phone: boolean;
  /** The zoom the names are placed for (the settled one), and where the sun is on the page at it. */
  k: number;
  sun: XY;
  /** Where each person is at that zoom, relative to the sun, in pixels. The same function until that changes, so the names are placed once per change. */
  spot: (id: number) => XY;
  width: number;
  height: number;
  /** The header's height: only those below it are in view. */
  top: number;
  /** An average character's width in the names' type (centreOnIcons' charWidth): WEB_CHAR_WIDTH on the Spider web, else Orbits' own. */
  charWidth?: number;
  /** Who is picked out, who is held (their panel open), and who shares group chats with whoever is picked out. */
  focusId: number | null;
  held: number | null;
  linked: ReadonlySet<number>;
  /** How names fade (nameFade.ts): a name faded out entirely is not drawn, nor a linked one at none. */
  fade?: NameFade;
}

/**
 * Names for the closest `named` people (see namedIds), every one of them (with
 * All, the closest SURELY_NAMED, then everyone else in view), placed on the
 * settled layout and carried along with each person while they move; zoomed
 * in, more of those in view, the closest first (chooseNamed); then whoever is
 * picked out. While someone is held, everyone they share group chats with who
 * is in view is named too, closest first, those with no name of their own
 * faintly (linkedOnly, at the Faintest name, none at all with it at Hidden); not
 * on a phone. Otherwise nobody whose name has faded out entirely (`fade`,
 * nameable) is named. With No name, nobody
 * is named; on a phone, only whoever is picked out. Anyone whose label is
 * empty (No name except… leaves out everyone not picked) is left out of all
 * of that, and nobody takes their place. Every name is centred where its
 * person's icon would be (centreOnIcons), standing in for it: the views leave
 * out the icons under them. On Orbits and the Spider web they have been turned
 * round their orbits so they cover no other (useNameFit); elsewhere names pile
 * up as they will, whoever is picked out drawn last, over the rest. `named`
 * is who is named before anyone is picked out, so a view can draw the rest of
 * the map once for any pick.
 */
export function useOrbitNames(input: NamesInput): { labels: PlacedName[]; large: ReadonlySet<number>; named: ReadonlySet<number> } {
  const { model, at, closest, named, reachOut, names, phone, k, sun, spot, width, height, top, charWidth, focusId, held, linked, fade = DEFAULT_NAME_FADE } = input;
  const unnamed = names.style === "hide";
  const onlyFocus = unnamed || phone;
  const { keep, always } = useMemo(() => nameable(closest, reachOut, fade), [closest, reachOut, fade]);
  // Everyone worth naming, and of them those whose names have not faded out (linked names are drawn whatever their fade).
  const everyone = useMemo(() => (onlyFocus ? { order: [], ranked: 0 } : nameOrderOf(model.people, at, closest)), [model.people, at, closest, onlyFocus]);
  const nameOrder = useMemo(() => (onlyFocus ? everyone : nameOrderOf(model.people, at, closest, keep)), [everyone, model.people, at, closest, onlyFocus, keep]);
  const labelRoom = useMemo(() => {
    const page = { left: 0, right: width, top, bottom: height };
    const shown = (id: number) => {
      const p = spot(id);
      return onPage({ x: sun.x + p.x, y: sun.y + p.y }, page, 0);
    };
    // Every one of the closest `named` (or SURELY_NAMED, with All), and with All everyone else in view.
    const room = Math.min(named, nameOrder.ranked);
    const chosen = chooseNamed(nameOrder.order, Math.min(room, SURELY_NAMED), k, shown, onlyFocus ? undefined : always, room);
    return { chosen, shown, charWidth };
  }, [nameOrder, named, always, onlyFocus, k, sun.x, sun.y, spot, width, height, top, charWidth]);
  // The closest NAMED_LARGE have their names at full size.
  const large = useMemo(() => new Set(everyone.order.slice(0, Math.min(NAMED_LARGE, everyone.ranked))), [everyone]);
  const candidate = (id: number) => {
    const p = spot(id);
    return { id, x: p.x, y: p.y, text: nameOf(model.people, id, names.mapLabel), scale: large.has(id) ? 1 : MINOR_SCALE };
  };
  const namedLabels = useMemo(
    () => centreOnIcons([...labelRoom.chosen.required, ...labelRoom.chosen.optional].map(candidate).filter(spoken), labelRoom),
    [labelRoom, large, model.people, names.mapLabel],
  );
  const labels = useMemo(() => {
    const named = new Set(namedLabels.map((l) => l.id));
    const focus = focusId !== null && !unnamed && labelRoom.shown(focusId) && !named.has(focusId) ? [focusId] : [];
    const linkedOnly = held !== null && focusId === held && !phone && fade.faintest > 0
      ? everyone.order.filter((id) => linked.has(id) && !named.has(id) && labelRoom.shown(id))
      : [];
    const wanted = [...focus, ...linkedOnly].map(candidate).filter(spoken);
    // Whoever is picked out last, so their name is drawn over any it lands on.
    const all = [...namedLabels.filter((l) => l.id !== focusId), ...centreOnIcons(wanted, labelRoom), ...namedLabels.filter((l) => l.id === focusId)];
    const faint = new Set(linkedOnly);
    // Each name as an offset from its person, so it is carried along with them as they move or the map zooms.
    return all.map((s): PlacedName => {
      const p = spot(s.id);
      return { ...s, dx: s.x - p.x, dy: s.y - p.y, linkedOnly: faint.has(s.id) };
    });
  }, [namedLabels, focusId, held, linked, everyone, unnamed, phone, labelRoom, large, model.people, names.mapLabel, fade.faintest]);
  // Who is named whoever is picked out: everyone in `labels` but the names a pick adds.
  const namedIds = useMemo(() => new Set(namedLabels.map((l) => l.id)), [namedLabels]);
  return { labels, large, named: namedIds };
}

/** Whether a name is there to draw: not an empty label (someone No name except… leaves out). */
const spoken = (candidate: { text: string }) => candidate.text !== "";

/** Where a spot placed relative to the sun (unzoomed) is drawn at `zoom`, the sun's unzoomed spot being (cx, cy). */
export function screenOf(p: XY, zoom: Zoom, cx: number, cy: number): XY {
  return { x: cx + zoom.x + p.x * zoom.k, y: cy + zoom.y + p.y * zoom.k };
}

/** Whether a point is on the page, or within `margin` pixels of it. */
export function onPage(p: XY, page: Box, margin: number): boolean {
  return p.x >= page.left - margin && p.x <= page.right + margin && p.y >= page.top - margin && p.y <= page.bottom + margin;
}

/** A person's name as the map draws it (`label`, a view's names.mapLabel; see displayName). */
export function nameOf(people: DemoPerson[], id: number, label: Names["label"]): string {
  const person = people.find((p) => p.id === id);
  return person ? label(person).primary : "";
}

/** Whether the window meets the media `query`, kept up to date as it changes (a phone turned on its side, say). */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const change = () => setMatches(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [query]);
  return matches;
}

/** `value` once it has stayed put for `ms` (by `same`): names are placed for this one. */
export function useSettled<T>(value: T, ms: number, same: (a: T, b: T) => boolean): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (same(settled, value)) return;
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

/** The entrance: where people rise from, how long the rising is staggered over, and the stage (the sun's height on it and its height, for the Spider web's scan). */
export interface Entrance {
  from: number;
  stagger: number;
  inner: number;
  outer: number;
  cy?: number;
  height?: number;
}

/** When one person's move in a tween starts (ms after the change) and how long it takes, with its easing (0 to 1 in, 0 to 1 out). */
export interface Timed {
  delay: number;
  length: number;
  ease?: (p: number) => number;
}

/**
 * How a look brings people in (useTween): where each starts for the entrance
 * and when they rise. The Spider web's has them condense in place as its scan
 * reaches them (webChoreography.ts); Orbits' own is PLAIN. Every later move
 * is the same for every look: everyone at once, over the tween's length.
 */
export interface Choreography {
  entranceFrom(to: Frame, entrance: Entrance): Frame;
  entrance(to: Frame, entrance: Entrance): Timed;
  /** Told when the entrance begins, with the clock's time (performance.now), so a drawing can run with it. */
  began?(now: number): void;
}

/** How long the entrance takes each person, once their turn comes, in ms. */
const ENTRANCE_MS = 1300;

/** Orbits' own: everyone rises out of the sun, the nearest first. */
export const PLAIN: Choreography = {
  entranceFrom: (t, entrance) => ({ ...t, r: entrance.from, angle: t.angle - 0.9, size: t.size * 0.4, opacity: 0, glow: 0 }),
  entrance: (t, entrance) => ({ delay: (entrance.stagger * (t.r - entrance.inner)) / Math.max(1, entrance.outer - entrance.inner), length: ENTRANCE_MS, ease: easeCubicOut }),
};

/**
 * How a change of targets plays (useTween): as the entrance (the first, or one
 * still playing when the targets change again, and every replay, which brings
 * everyone in again from nothing however little moved), at once (under reduced
 * motion, always, for a change that only rescales the map, and for one nobody
 * would see move), or as a move.
 */
export function tweenOf(change: { entering: boolean; replayed: boolean; reduced: boolean; rescaled: boolean; visible: boolean }): "entrance" | "atOnce" | "move" {
  if (change.reduced) return "atOnce";
  if (change.entering || change.replayed) return "entrance";
  return change.rescaled || !change.visible ? "atOnce" : "move";
}

/**
 * Frames moving smoothly to `targets` over `duration` ms whenever they change:
 * along the orbit (angle) and in or out (radius), rather than in a straight
 * line, so people swing around the sun. First, everyone rises out of the sun
 * (`entrance`), the nearest first. When `scale` changes (the map was resized,
 * say, as the person panel slides in), everyone jumps to where they are headed:
 * a move that only rescales the map says nothing, and each animated frame
 * redraws the whole map. A look's `choreography` may time each person's
 * entrance its own way (PLAIN is Orbits' own). Whenever `replay` changes the
 * entrance plays again, everyone brought in from nothing to where they are
 * headed (the Spider web's scan when you re-query); never under reduced motion.
 */
export function useTween(
  targets: Map<number, Frame>,
  duration: number,
  entrance: Entrance,
  scale: string,
  choreography: Choreography = PLAIN,
  replay = 0,
): Map<number, Frame> {
  const reduced = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, []);
  const [frames, setFrames] = useState<Map<number, Frame>>(() =>
    reduced
      ? targets
      : new Map([...targets].map(([id, t]) => [id, choreography.entranceFrom(t, entrance)])),
  );
  const current = useRef(frames);
  // Cleared once the entrance has played, not when it starts, since React
  // may start an effect twice in development.
  const first = useRef(!reduced);
  const lastScale = useRef(scale);
  const lastReplay = useRef(replay);
  const dance = useRef(choreography);
  dance.current = choreography;
  useEffect(() => {
    const replayed = lastReplay.current !== replay;
    lastReplay.current = replay;
    const kind = tweenOf({
      entering: first.current,
      replayed,
      reduced,
      rescaled: lastScale.current !== scale,
      // A change nobody would see move (new messages, most often) is taken at once, in one redraw.
      visible: movesVisibly(current.current, targets),
    });
    lastScale.current = scale;
    const isEntrance = kind === "entrance";
    if (isEntrance) first.current = true;
    // A replay brings everyone in from nothing; the first entrance, or one interrupted, goes on from where they are.
    const from = replayed && isEntrance
      ? new Map([...targets].map(([id, t]) => [id, dance.current.entranceFrom(t, entrance)]))
      : current.current;
    const start = performance.now();
    if (isEntrance) dance.current.began?.(start);
    // Each person's timing: at once, their turn in the entrance, or the whole move's length.
    const timed = new Map<number, Timed>();
    let longest = 0;
    for (const [id, to] of targets) {
      const t: Timed = kind === "atOnce" ? { delay: 0, length: 0 }
        : isEntrance ? dance.current.entrance(to, entrance)
          : { delay: 0, length: duration };
      timed.set(id, t);
      longest = Math.max(longest, t.delay + t.length);
    }
    let raf = 0;
    const tick = (now: number) => {
      const next = new Map<number, Frame>();
      for (const [id, to] of targets) {
        const a = from.get(id) ?? { ...to, opacity: 0 };
        const { delay, length, ease = easeCubicInOut } = timed.get(id)!;
        const p = length === 0 ? 1 : Math.min(1, Math.max(0, (now - start - delay) / length));
        const e = ease(p);
        next.set(id, {
          angle: a.angle + wrap(to.angle - a.angle) * e,
          r: a.r + (to.r - a.r) * e,
          size: a.size + (to.size - a.size) * e,
          glow: a.glow + (to.glow - a.glow) * e,
          opacity: a.opacity + (to.opacity - a.opacity) * e,
          silent: e < 0.5 ? a.silent : to.silent,
        });
      }
      current.current = next;
      setFrames(next);
      if (now - start < longest) raf = requestAnimationFrame(tick);
      else {
        first.current = false;
        clearTimeout(fallback);
      }
    };
    raf = requestAnimationFrame(tick);
    // Where animation frames stall (a tab in the background, a browser driven
    // by a tool taking screenshots), settle everyone anyway, so the map is
    // never left mid-move with people heaped by the sun.
    const fallback = setTimeout(() => {
      cancelAnimationFrame(raf);
      tick(start + longest);
    }, longest + 400);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fallback);
    };
  }, [targets, replay]);
  // Until the next tick, anyone new (a person whose id changed when their file
  // was made, say) waits, unseen, where they are headed.
  return useMemo(() => {
    if ([...targets.keys()].every((id) => frames.has(id))) return frames;
    const filled = new Map(frames);
    for (const [id, to] of targets) if (!filled.has(id)) filled.set(id, { ...to, opacity: 0 });
    return filled;
  }, [frames, targets]);
}

/** 1 once someone is within a few pixels of where they are headed, fading to 0 by ARRIVED pixels away: names and trails belong to where people settle. */
export function arrivedShare(f: Frame, to: XY): number {
  const away = Math.hypot(Math.cos(f.angle) * f.r - to.x, Math.sin(f.angle) * f.r - to.y);
  return Math.min(1, Math.max(0, 1 - (away - 4) / ARRIVED));
}
