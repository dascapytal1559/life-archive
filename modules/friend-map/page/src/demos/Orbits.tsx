// Orbits, at /: the main view, and the only one that gets new work (the
// others are frozen; see AGENTS.md). You are the sun and everyone you
// talk to circles it. Distance is closeness (closeness.ts): the closer
// someone's score, the nearer the sun, by rank, with rings round the closest
// 10, 25, 50 and so on. Size is how much you have talked, and a soft
// glow in their own colour marks everyone you should reach out to. Everyone is drawn as
// their identicon, the closest strongest, fainter ring by ring, their name
// with them, tinted its colour. A comet trail runs from where someone sat at the start of the
// look-back window (trendMonths in data/settings.json) to where they sit now,
// warm if they moved in, cool if out. Nothing else places anyone: people are
// spread evenly round the sun in name order, or, on the Circles page (at
// /circles, the same map), in friend circles (friendCircles.ts), each marked
// by an arc round the outside. Methodology (Methodology.tsx) spells all this
// out on the page.
//
// OrbitMap draws the sky as of now, and moves people along their orbits when
// it changes. It zooms and pans: places spread out from the sun while the
// sun, names and labels keep their size, and markers grow only until their
// identicons can be read, so zooming in opens room and more people are named.
// The geometry is in orbitsLayout.ts, the zoom's maths in orbitsZoom.ts.

import { Delaunay, easeCubicOut } from "d3";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { IDENTICON_SIZE } from "../identicon.ts";
import { IdenticonCells } from "../Identicon.tsx";
import { useNames } from "../names.ts";
import { scoreLabel } from "./closeness.ts";
import { type DemoModel, type DemoPerson, type Link } from "./model.ts";
import {
  aspiringSize, displacementTrail, drawnSize, glowColour, hearthGlowRadius, nameGlow, READABLE, personOpacity, rings,
  BACKGROUND, circleLabelSpot, DIM, grown, type Box,
} from "./orbitsLayout.ts";
import { useHiddenMarks } from "./hiddenMarks.ts";
import {
  arrivedShare, ASPIRING_NAME_GAP, aspiringEdge, nameOf, onPage, PLAIN, screenOf, stageOf, useMedia, useNameFit, useOrbitBodies, useOrbitNames, useSettled, useTween, NAME_FONT, WEB_NAME_FONT, type Frame, type OrbitOrder, type PlacedName,
} from "./orbitsSky.ts";
import { boundsOf, clampZoom, HOME, panBy, panToShow, pinchZoom, wheelFactor, ZOOM_STEP, zoomAt, zoomBetween, zoomToShow, type Fingers, type Zoom } from "./orbitsZoom.ts";
import "./orbits.css";
import { ORANGE, orbitsPalette, themeSun, useOrbitsTheme } from "./orbitsTheme.ts";
import { ringColours } from "./ringColours.ts";
import { PHOTO_SHARE, Sun, SunControls, useMePhoto } from "./SunPhoto.tsx";
import { trendSummary, windowLabel } from "./trend.ts";
import { aspiringRows, basicRows, fieldRows, number, tipAt, type Demo, type ViewProps } from "./view.tsx";
import { webBoot, type WebMotion } from "./webChoreography.ts";
import { presetOf, useWebColour } from "./webColour.ts";
import { glowLook, glowShown, glowsOf, SWELL, useReachGlow } from "./reachGlow.ts";
import { useWebShadow } from "./webShadow.ts";
import { useWebStrength } from "./webStrength.ts";
import { useWebCurve, useWebSpokes } from "./webStyle.ts";
import { ringTop, webShape } from "./webGeometry.ts";
import { WebLayer } from "./WebLayer.tsx";
import { type WebScene } from "./webLook.ts";
import { webTheme } from "./webTheme.ts";
import { DEFAULT_NAME_PADDING, useNamePadding } from "./namePadding.ts";
import { amongTop, DEFAULT_TOP_NAMES, SURELY_NAMED, useTopNames } from "./topNames.ts";
import { nameHidden, nameStrengthOf, useNameFade } from "./nameFade.ts";

// What this view shares with Orbits 3D (the stage, where everyone sits, who is named where, and how people move) is in orbitsSky.ts.
export type { OrbitOrder };

/**
 * The phone layout's media query, as demos.css has it: a window this narrow,
 * or a short touch screen held sideways. On a phone nobody is named but
 * whoever is picked out (a finger held on them, or their panel open).
 */
export const PHONE = "(max-width: 560px), (max-height: 500px) and (pointer: coarse)";
/** How far beyond everyone, in pixels, the friend circles' arcs run. */
const CIRCLE_ARC = 9;
/** A move, as a share of the room between the sun and the edge, big enough for a trail without hovering. */
const TRAIL_SHOWN = 0.1;
/** How long people take to move to new places (new messages, a new query), in ms. */
const MOVE_MS = 700;
/** How long the zoom must hold still before names are placed for it, in ms. */
const SETTLE_MS = 140;
/** How long a press of + or −, going back to the whole map (0), or bringing someone found into view takes to glide there, in ms. */
const GLIDE_MS = 240;
/** How far in from the edges of what is in view, in pixels, someone found with the find box, or whose panel is open, counts as in view. */
const VIEW_MARGIN = 60;
/** Nobody: the links of nobody picked out. */
const NOBODY: ReadonlySet<number> = new Set();
/** How far, in pixels, a mouse or a finger moves before a press is a drag (a finger wobbles more in a tap). */
const DRAG_START = { mouse: 3, touch: 10 };
/** How long a finger held on someone takes to show their hover card, in ms; letting go then opens nothing. */
const HOLD_MS = 400;
/** How near, in pixels, a finger must land to someone to pick them: further than the pointer's 16, as a fingertip is broad. */
const TOUCH_REACH = 24;

/**
 * Who the map picks out, lit with the people they share group chats with and
 * everyone else dimmed: the one held (whose panel is open, so they stay picked
 * out while it is, whoever the pointer passes over) as long as they are drawn,
 * else the person under the pointer. A held person filtered off the map leaves
 * it to the pointer.
 */
export function focusOf(hovered: number | null, held: number | null, drawn: (id: number) => boolean): number | null {
  return held !== null && drawn(held) ? held : hovered;
}

/**
 * Who a hold is about: whoever is held, if they are picked out (`focusId`, so
 * drawn), and everyone they share group chats with (`linked`); null, everyone,
 * with nobody held. On the Spider web only they can be named, hovered and
 * clicked, and on every view only theirs of the reach-out glows are drawn
 * (glowsOf in reachGlow.ts).
 */
export function heldOnly(held: number | null, focusId: number | null, linked: ReadonlySet<number>): ReadonlySet<number> | null {
  return held !== null && focusId === held ? new Set([held, ...linked]) : null;
}

/**
 * Whether a click at `at` (relative to the sun, px) lands on empty map, as
 * letting go of whoever is held on the Spider web asks: on no one's dot, within
 * `reach` of it or its drawn radius and 8 more as a pick is, and on no name
 * or ring label (`boxes`).
 */
export function emptyAt(at: { x: number; y: number }, dots: Iterable<{ x: number; y: number; r: number }>, boxes: Iterable<Box>, reach: number): boolean {
  for (const dot of dots) if (Math.hypot(dot.x - at.x, dot.y - at.y) <= Math.max(reach, dot.r + 8)) return false;
  for (const box of boxes) if (at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom) return false;
  return true;
}

/**
 * Whose name is at `at` (relative to the sun, px), where a name stands in
 * for its icon: the last of `names` drawn, so the one on top,
 * whose box, `pad` wider all round, holds it; else null.
 */
export function nameAt(at: { x: number; y: number }, names: ReadonlyArray<{ id: number; box: Box }>, pad = 0): number | null {
  for (let i = names.length - 1; i >= 0; i--) {
    const { id, box } = names[i];
    if (at.x >= box.left - pad && at.x <= box.right + pad && at.y >= box.top - pad && at.y <= box.bottom + pad) return id;
  }
  return null;
}

/**
 * Where a name placed for the settled zoom (`label`) is drawn now, its person at `at`: the box it was placed with, carried along with them.
 */
export function drawnBox(label: PlacedName, at: { x: number; y: number }): Box {
  const [dx, dy] = [at.x + label.dx - label.x, at.y + label.dy - label.y];
  return { left: label.left + dx, right: label.right + dx, top: label.top + dy, bottom: label.bottom + dy };
}

/**
 * The links drawn to whoever is picked out (`focus`): everyone they share a
 * group chat with, or, with `group` (the members of the group chat open in
 * their panel, the user's ask), only those of them in it.
 */
export function linksOf(links: Link[], focus: number | null, group?: readonly number[]): Link[] {
  if (focus === null) return [];
  const members = group && new Set(group);
  return links.filter((l) => {
    if (l.source !== focus && l.target !== focus) return false;
    return !members || members.has(l.source === focus ? l.target : l.source);
  });
}

/**
 * The links drawn to whoever is picked out (`focus`) on Orbits, Orbits 3D and
 * the City: while they are held (`held`, their panel open) with one of their
 * group chats open in it (`heldGroup`), only to its members (linksOf), and to
 * nobody when it is one they are unlinked from; else to everyone they share a
 * group chat with. A group chat they are not in (a stale one from the panel
 * before) is left alone.
 */
export function focusLinksOf(
  model: Pick<DemoModel, "groups" | "links">,
  focus: number | null,
  held: number | null,
  heldGroup: number | null,
): Link[] {
  const group = held === null || focus !== held ? undefined
    : model.groups.find((g) => g.id === heldGroup && (g.memberIds.includes(held) || g.unlinkedIds.includes(held)));
  if (group && !group.memberIds.includes(held!)) return [];
  return linksOf(model.links, focus, group?.memberIds);
}

/**
 * How strongly someone's marker, name, trail and glow are drawn: by their tier
 * (TIERS; `place`, their place by closeness), someone to reach out to at least
 * as the last tier, lifted toward full by the Reach-out glow (`lift`, glowLook's); while someone is picked out (`focusId`), they at full
 * strength, those linked to them at 70%, and everyone else at one flat
 * BACKGROUND.
 */
export function strengthOf(id: number, place: number | null, reachOut: boolean, focusId: number | null, linked: ReadonlySet<number>, lift = 0): number {
  if (focusId === null) return personOpacity(place, reachOut, { lift });
  return id === focusId ? 1 : linked.has(id) ? 0.7 : BACKGROUND;
}

/**
 * How a name is styled: filled in its person's `colour`, with their glow's
 * halo (nameGlow, `shine` of the way in) as strong as the Reach-out glow
 * `boost` says; past its halfway (`pulse`, glowLook's) it breathes between that
 * and a swell more (orbits.css), and `pulsing` says to add the class that does.
 */
export function nameStyle(colour: string, shine: number, boost: number, pulse: number): { style: CSSProperties; pulsing: boolean } {
  const rest = nameGlow(colour, shine, boost);
  if (rest === undefined || pulse <= 0) return { style: { fill: colour, filter: rest }, pulsing: false };
  const peak = nameGlow(colour, shine, boost * (1 + SWELL.halo * pulse));
  return { style: { fill: colour, filter: rest, "--glow-rest": rest, "--glow-peak": peak } as CSSProperties, pulsing: true };
}

/**
 * The zoom, kept while the page is open, so switching to another view and
 * back, or running a new query, keeps it; a reload starts unzoomed.
 */
export const keptZoom: { current: Zoom } = { current: HOME };

/** How the map is drawn: Orbits' own night sky, or the Spider web view's web (webLook.ts). */
export type OrbitLook = "night" | "web";

/** Whether two zooms are the same. */
const sameZoom = (a: Zoom, b: Zoom) => a.k === b.k && a.x === b.x && a.y === b.y;

/**
 * The sky as of now; people rise out of the sun when it first appears. It
 * zooms and pans (orbitsZoom.ts): the wheel or a trackpad pinch zooms about
 * the pointer, dragging empty space pans, and the + − and 0 keys zoom about
 * the middle and go back to the whole map. On a
 * touch screen, two fingers pinch to zoom, one drags to pan (from anywhere,
 * people too), a tap opens someone, and a finger held on them shows their
 * hover card.
 * Someone picked in the find box (`find`) is brought into view. People go
 * round the sun A to Z, or in friend circles with `order` "circles". The
 * night look's sun and rings are in `theme` (orbitsTheme.ts), the orange
 * unless Orbits' own setting says otherwise. The closest `named` are named
 * unzoomed (the view's Show top names, topNames.ts), and on the Spider web lock in with a
 * bracket as it boots. Names are fitted `padding` pixels apart (the view's Name padding, namePadding.ts).
 */
export function OrbitMap({ model, width, height, inset: top, seen = width, hover, open, close, held = null, heldGroup = null, find = null, requery = 0, order = "name", look = "night", theme = ORANGE, named = DEFAULT_TOP_NAMES, padding = DEFAULT_NAME_PADDING }: ViewProps & { order?: OrbitOrder; look?: OrbitLook; theme?: string; named?: number; padding?: number }) {
  // Now: the last month.
  const at = model.months.length - 1;
  // The person under the pointer.
  const [hoverId, setHoverId] = useState<number | null>(null);
  const names = useNames();
  // How names fade down the ranking: the Names settings, every map view's (nameFade.ts).
  const fade = useNameFade();
  const phone = useMedia(PHONE);
  // The Spider web view (`look` "web"): a canvas under the SVG draws the web in the colour chosen (WebLayer.tsx, webLook.ts,
  // webColour.ts, webTheme.ts), booted in by a scan line from the top down (webChoreography.ts), played again whenever
  // you re-query (`requery`), and nowhere else: people move to new places as on Orbits. The look's
  // colours for the SVG's own marks, and the sun's colour for the rings and the photo's ring. The web's own rings are
  // the guide rings: Orbits draws none, only their labels, on the level thread across each ring's top, and people sit
  // on its even scale (RankScale in orbitsLayout.ts), the rings evenly spaced out to the closest 250 and everyone placed
  // by rank between them, so the rings stay true.
  const colour = useWebColour();
  const webStrength = useWebStrength();
  const shadow = useWebShadow();
  // How strongly everyone to reach out to glows (reachGlow.ts), the same on every view that glows.
  const reachGlow = useReachGlow();
  const glow = useMemo(() => glowLook(reachGlow), [reachGlow]);
  // The web's own sliders (webStyle.ts): how deep its cross threads sag, and how many spokes it has.
  const webCurve = useWebCurve();
  const webSpokes = useWebSpokes();
  const web = look === "web";
  const scale = web ? "even" : "log";
  // Your photo in place of the sun (SunPhoto.tsx), never on the Spider web, and whether its buttons show: the
  // pointer on the sun, or a tap on it.
  const me = useMePhoto(photoShown(look));
  const [onSun, setOnSun] = useState(false);
  const palette = web ? webTheme(colour).palette : orbitsPalette(theme);
  const sunColour = themeSun(theme);
  const boot = useRef<WebMotion>({ bootStart: null });
  const choreography = useMemo(() => (web ? webBoot(boot) : PLAIN), [web]);

  // The stage (orbitsSky.ts): the sun in the middle of the space under the header, everything placed relative to it,
  // unzoomed; the zoom spreads it out from there when it is drawn.
  const { outer, inner, cx, cy } = stageOf(width, height, top);
  // The edge of the page, where aspiring friends sit: the furthest out they can be seen, unzoomed.
  const edge = useMemo(() => aspiringEdge(width, height, top, cx, cy, aspiringSize(outer)), [width, height, top, cx, cy, outer]);
  // Where everyone sits round the sun, A to Z or in friend circles, and what else is known of each (orbitsSky.ts).
  const { count, together, aspiring, radius, standings, closest, circles, aim, trends, trailFrom, targets: spokes } = useOrbitBodies(model, at, inner, outer, order, edge, scale);
  // The guide rings, as the scale lays them out.
  const guides = useMemo(() => rings(count, scale), [count, scale]);
  // The web (webGeometry.ts), running out past every edge of the stage, its rings at the guide rings.
  const shape = useMemo(() => {
    if (!web) return null;
    const ranks = guides.map((ring) => ({ r: radius(ring.rank), label: ring.label }));
    return webShape({ inner, outer, count, far: 2 * Math.max(width, height), ranks, spokes: webSpokes, curve: webCurve });
  }, [web, webSpokes, webCurve, guides, radius, inner, outer, count, width, height]);
  // How far straight up from the sun a guide ring's label sits, unzoomed: on the ring, or on its level top thread.
  const labelR = (rank: number) => {
    const r = radius(rank);
    return shape ? ringTop(shape, r) : r;
  };
  // Each name stands in for its person's icon, so on Orbits and the Spider web (not Circles) those named on the whole
  // map are turned round their orbits until no name covers another or a ring label (useNameFit), each measured in the
  // view's own type; nobody's distance from the sun changes.
  const fitting = order === "name" && !phone && names.style !== "hide";
  const reachOut = useMemo(() => new Set(model.people.filter((p) => p.shouldReachOut).map((p) => p.id)), [model.people]);
  // Their labels, straight up from the sun where each is drawn, unzoomed. A label's box already keeps the room round it
  // that the default Name padding asks (ringLabelBox), so the fitting, which keeps the view's padding round it as round
  // a name, takes it that much smaller: a label is as clear of names as before at the default, and more or less clear
  // with the padding, as names are of each other.
  const ringBoxes = useMemo(() => guides.map((ring) => grown(ringLabelBox(ring.label, -labelR(ring.rank)), -DEFAULT_NAME_PADDING / 2)), [guides, radius, shape]);
  const font = web ? WEB_NAME_FONT : NAME_FONT;
  // An aspiring friend stays where they are on the edge, one to reach out to too: only the orbits turn.
  const unturned = useMemo(() => [...together, ...aspiring], [together, aspiring]);
  const targets = useNameFit(spokes, { on: fitting, model, at, closest, named, reachOut, together: unturned, label: names.mapLabel, font, around: ringBoxes, padding, fade });

  // While friend circles are chosen, each circle of two or more: who is in it, its name, and its span round the
  // sun, from its first person's direction to its last's and a little beyond, for the arc that marks it.
  const circleArcs = useMemo(() => (circles?.circles ?? []).flatMap((circle) => {
    if (circle.ids.length < 2) return [];
    const [from, to] = [aim.get(circle.ids[0])!.angle, aim.get(circle.ids[circle.ids.length - 1])!.angle];
    const pad = ((to - from) / (circle.ids.length - 1)) * 0.4;
    return [{ ids: new Set(circle.ids), label: circle.label, from: from - pad, to: to + pad }];
  }), [circles, aim]);
  // The arcs run just outside everyone; their names, beyond them, never with No names nor on a phone.
  const arcR = targets.reach + CIRCLE_ARC;
  const circleNames = (zoom: Zoom) => {
    if (names.style === "hide" || phone) return [];
    const sunAt = { x: cx + zoom.x, y: cy + zoom.y };
    const bounds = { left: 6 - sunAt.x, right: width - 6 - sunAt.x, top: top + 4 - sunAt.y, bottom: height - 6 - sunAt.y };
    return circleArcs.flatMap((arc) => (arc.label ? [{ arc, ...circleLabelSpot((arc.from + arc.to) / 2, arcR * zoom.k + 8, arc.label, bounds) }] : []));
  };

  const frames = useTween(targets.frames, MOVE_MS, { from: inner * 0.3, stagger: 700, outer, inner, cy, height }, `${inner}:${outer}`, choreography, web ? requery : 0);
  // Who is picked out: whoever's panel is open, else the person under the pointer.
  const focusId = focusOf(hoverId, held, (id) => targets.frames.has(id));
  // Who shares group chats with whoever is picked out (only the group chat open in the held person's panel, while one is).
  const focusLinks = useMemo(() => focusLinksOf(model, focusId, held, heldGroup), [model, focusId, held, heldGroup]);
  const linked = useMemo(() => new Set(focusLinks.map((l) => (l.source === focusId ? l.target : l.source))), [focusLinks, focusId]);
  // With the person panel docked over the map (Demos.tsx), only the middle `seen` pixels of it are in view across, and
  // the zoom's bounds let the system's edges come into that, VIEW_MARGIN in, so whoever's panel is open can be
  // (clampZoom). They narrow as the panel opens, and widen again as it closes only once the map has glided back within
  // them (below), so it never jumps.
  const [bound, setBound] = useState(seen);
  if (seen < bound) setBound(seen);
  const bounds = useMemo(() => boundsOf(targets.extent, width, bound, VIEW_MARGIN), [targets.extent, width, bound]);

  // The zoom. What is asked for is kept as asked, and brought within bounds
  // for the system as it is now (a new query or a resize changes its reach).
  // Whoever would see nobody at all at it (a new query whose people are all
  // elsewhere, say) goes back to the whole map.
  const page = { left: 0, right: width, top, bottom: height };
  const sees = (zoom: Zoom) => [...targets.placed.values()].some((p) => onPage(screenOf(p, zoom, cx, cy), page, 0));
  const [asked, setAsked] = useState(() => (sees(clampZoom(keptZoom.current, bounds)) ? keptZoom.current : HOME));
  const [askedFor, setAskedFor] = useState(targets);
  if (askedFor !== targets) {
    setAskedFor(targets);
    if (!sees(clampZoom(asked, bounds))) setAsked(HOME);
  }
  const zoom = clampZoom(asked, bounds);
  useEffect(() => void (keptZoom.current = zoom), [zoom.k, zoom.x, zoom.y]);
  // Names are placed for the zoom once it has held still for a moment, and
  // carried along with their people meanwhile, so a pinch or a drag never
  // waits on them.
  const settled = useSettled(zoom, SETTLE_MS, sameZoom);

  // Names (useOrbitNames in orbitsSky.ts), placed for the settled zoom: where each person is at it, relative to the sun.
  const spot = useCallback((id: number) => {
    const p = targets.placed.get(id)!;
    return { x: p.x * settled.k, y: p.y * settled.k };
  }, [targets, settled]);
  // Aspiring friends are named wherever they are, as everyone to reach out to is.
  const alwaysNamed = useMemo(() => new Set([...reachOut, ...aspiring]), [reachOut, aspiring]);
  const { labels: placedLabels, named: placedNamed } = useOrbitNames({
    model, at, closest, named, reachOut: alwaysNamed, names, phone,
    k: settled.k, sun: { x: cx + settled.x, y: cy + settled.y }, spot,
    width, height, top, charWidth: font.charWidth, focusId, held, linked, fade,
  });
  // While someone is held, only they and whoever shares group chats with them glow (nobody at all under No name except…:
  // glowsOf), and on the Spider web only they are named, hovered or clicked (the user's asks); everyone else stays on the
  // map, unnamed and out of reach, until they are let go.
  const holding = useMemo(() => heldOnly(held, focusId, linked), [held, focusId, linked]);
  const glowing = useMemo(() => glowsOf(holding, names.hidden), [holding, names.hidden]);
  const reachable = web ? holding : null;
  // Their names stay where they were placed with everyone's, so holding someone moves no name. An aspiring friend's
  // goes under their bubble.
  const labels = useMemo(() => {
    const kept = reachable ? placedLabels.filter((label) => reachable.has(label.id)) : placedLabels;
    return aspiring.size === 0 ? kept : kept.map((label) => (aspiring.has(label.id) ? underBubble(label, aspiringSize(outer)) : label));
  }, [placedLabels, reachable, aspiring, outer]);
  // Whoever is named is drawn as their name alone, in place of their icon and its glow; everyone else keeps theirs, so
  // nobody leaves the map, and an aspiring friend keeps their bubble, named or not.
  const standIns = useMemo(() => labels.filter((label) => !aspiring.has(label.id)), [labels, aspiring]);
  const nameOnly = useMemo(() => new Set(standIns.map((label) => label.id)), [standIns]);
  // Of them, who is named whoever is picked out, which is how the people's layer (below) is drawn, once for any pick.
  const restNameOnly = useMemo(
    () => new Set([...placedNamed].filter((id) => (!reachable || reachable.has(id)) && !aspiring.has(id))),
    [placedNamed, reachable, aspiring],
  );

  // Where things are drawn. The sky is drawn relative to the sun, spread out
  // by the zoom, in one group moved to wherever the sun is: a pan moves that
  // group alone.
  const { k } = zoom;
  const sun = { x: cx + zoom.x, y: cy + zoom.y };
  const place = (id: number) => {
    const f = frames.get(id)!;
    return { x: Math.cos(f.angle) * f.r * k, y: Math.sin(f.angle) * f.r * k };
  };
  // A marker's radius as drawn at this zoom.
  const sized = (f: Frame) => (f.silent ? f.size : drawnSize(f.size, k));
  // Zoomed in, most people are off the page, and are not drawn. Who is drawn
  // is worked out about a spot that follows the sun only once it has moved a
  // quarter of the page's longer side, taking in half that side beyond the
  // page all round, so dragging redraws the sky only every so often, never
  // leaving a gap at the edge.
  const beyond = Math.max(width, height) / 2;
  const cull = useRef(sun);
  if (Math.abs(sun.x - cull.current.x) > beyond / 2 || Math.abs(sun.y - cull.current.y) > beyond / 2) cull.current = sun;
  const [cullX, cullY] = [cull.current.x, cull.current.y];
  const near = (x: number, y: number) => onPage({ x: cullX + x, y: cullY + y }, { left: 0, right: width, top: 0, bottom: height }, beyond);

  // Hover by nearest person within reach, so even the smallest are easy to
  // catch, found through a triangulation built when the pointer first needs
  // it for each drawing, not on every redraw while the map zooms.
  const svgRef = useRef<SVGSVGElement>(null);
  const nearest = useRef<{ frames: Map<number, Frame>; people: DemoPerson[]; k: number; points: Array<[number, number]>; delaunay: Delaunay<[number, number]> } | null>(null);
  // Who the pointer can reach: everyone, or on the Spider web while someone is held, they and their links alone (`reachable`).
  const pickable = useMemo(() => (reachable ? model.people.filter((p) => reachable.has(p.id)) : model.people), [model.people, reachable]);
  const pick = (event: { clientX: number; clientY: number }, reach = 16) => {
    const box = svgRef.current!.getBoundingClientRect();
    const x = event.clientX - box.left - sun.x;
    const y = event.clientY - box.top - sun.y;
    // A name stands in for its icon: the pointer on it picks its person (a finger a little further out).
    if (nameOnly.size > 0) {
      const id = nameAt({ x, y }, labels.map((label) => ({ id: label.id, box: drawnBox(label, place(label.id)) })), Math.max(2, reach - 16));
      const person = id === null ? undefined : pickable.find((p) => p.id === id);
      if (person && frames.get(person.id)!.opacity >= 0.5) return person;
    }
    let found = nearest.current;
    if (!found || found.frames !== frames || found.people !== pickable || found.k !== k) {
      const points = pickable.map((p) => {
        const q = place(p.id);
        return [q.x, q.y] as [number, number];
      });
      found = nearest.current = { frames, people: pickable, k, points, delaunay: Delaunay.from(points) };
    }
    const i = found.delaunay.find(x, y);
    const person = pickable[i];
    if (!person || frames.get(person.id)!.opacity < 0.5) return null;
    const [px, py] = found.points[i];
    return Math.hypot(px - x, py - y) <= Math.max(reach, drawnSize(frames.get(person.id)!.size, k) + 8) ? person : null;
  };
  const unhover = () => {
    setHoverId(null);
    hover(null);
  };
  // Holding someone on the Spider web lets go of whoever else was under the pointer, out of reach now.
  useEffect(() => {
    if (reachable && hoverId !== null && !reachable.has(hoverId)) unhover();
  }, [reachable]);
  // On the Spider web, a click on empty map (emptyAt: no one's dot, no name, no ring label) lets go of whoever is held,
  // closing their panel (the user's ask); with no panel open, closing does nothing. Not gated on `held`, which
  // follows the panel a render later on a big map, so the first click after opening someone never goes unheard.
  // The rings' labels are 10 px capitals, about 7 px a letter.
  const dropsHold = (event: { clientX: number; clientY: number }, reach: number) => {
    if (!web || !close) return false;
    const box = svgRef.current!.getBoundingClientRect();
    const at = { x: event.clientX - box.left - sun.x, y: event.clientY - box.top - sun.y };
    const dots = model.people.flatMap((p) => {
      const f = frames.get(p.id);
      return f && f.opacity > 0 ? [{ ...place(p.id), r: sized(f) }] : [];
    });
    const names = labels.map((label) => drawnBox(label, place(label.id)));
    const ringLabels = guides.map((ring) => ringLabelBox(ring.label, -labelR(ring.rank) * k));
    return emptyAt(at, dots, [...names, ...ringLabels], reach);
  };
  // Over the sun, where its buttons show (never on the Spider web, which has none).
  const overSun = (event: { clientX: number; clientY: number }) => {
    if (!photoShown(look)) return false;
    const box = svgRef.current!.getBoundingClientRect();
    return Math.hypot(event.clientX - box.left - sun.x, event.clientY - box.top - sun.y) <= inner * PHOTO_SHARE;
  };

  // Zooming. The wheel and a pinch zoom at once, each step building on the
  // last, however many come before the map is drawn again; the keys glide to
  // their zoom, about the middle of the map.
  const reduced = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, []);
  const live = useRef({ extent: bounds, cx, cy, hovering: hoverId !== null, unhover });
  live.current = { extent: bounds, cx, cy, hovering: hoverId !== null, unhover };
  const motion = useRef<{ glide: number; fallback: ReturnType<typeof setTimeout> | undefined }>({ glide: 0, fallback: undefined });
  // Whoever was last picked in the find box, kept in view until you zoom or pan (below).
  const finding = useRef<number | null>(null);
  // Fingers on the map (client coordinates, by pointer id); two pinch, zooming from `from` as they were at `start`.
  // A finger held on someone shows their card (`peek` waiting, then `peeking`). `used`: the last press was a finger.
  const touch = useRef<{
    fingers: Map<number, { clientX: number; clientY: number }>;
    pinch: { from: Zoom; start: Fingers; last: Zoom } | null;
    peek: ReturnType<typeof setTimeout> | undefined;
    peeking: boolean;
    used: boolean;
  }>({ fingers: new Map(), pinch: null, peek: undefined, peeking: false, used: false });
  const stopGlide = () => {
    cancelAnimationFrame(motion.current.glide);
    clearTimeout(motion.current.fallback);
  };
  // A glide, and what to do once it has landed (`then`), unless it is cut short.
  const glide = (to: (e: number) => Zoom, then?: () => void) => {
    stopGlide();
    const land = () => {
      stopGlide();
      setAsked(to(1));
      then?.();
    };
    if (reduced) return land();
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / GLIDE_MS);
      if (p === 1) return land();
      setAsked(to(easeCubicOut(p)));
      motion.current.glide = requestAnimationFrame(tick);
    };
    motion.current.glide = requestAnimationFrame(tick);
    // Where animation frames stall (a tab in the background), land anyway.
    motion.current.fallback = setTimeout(land, GLIDE_MS + 300);
  };
  const middle = { x: 0, y: (top + height) / 2 - cy };
  const zoomBy = (factor: number) => {
    finding.current = null;
    const from = zoom;
    glide((e) => zoomAt(from, factor ** e, middle, bounds));
  };
  const goHome = () => {
    finding.current = null;
    const from = zoom;
    glide((e) => ({ k: from.k ** (1 - e), x: from.x * (1 - e), y: from.y * (1 - e) }));
  };
  const keys = useRef({ zoomBy, goHome });
  keys.current = { zoomBy, goHome };

  // What is in view, relative to the sun's unzoomed spot, VIEW_MARGIN in from its edges: the middle `seen` pixels
  // across, under the header.
  const view = { left: VIEW_MARGIN - seen / 2, right: seen / 2 - VIEW_MARGIN, top: top + VIEW_MARGIN - cy, bottom: height - VIEW_MARGIN - cy };
  // Someone picked in the find box is brought into view, zoomed in far enough
  // to read their identicon, unless they are in view at that already. They are
  // kept in view as the map changes size or their panel docks over it, until
  // you zoom or pan.
  useEffect(() => {
    finding.current = find?.id ?? null;
  }, [find]);
  useEffect(() => {
    const id = finding.current;
    const p = id === null ? undefined : targets.placed.get(id);
    if (id === null || !p) return;
    const f = targets.frames.get(id)!;
    // The belt's rings keep their size however far in.
    const least = f.silent ? 1 : READABLE / f.size;
    const to = zoomToShow(zoom, p, least, view, bounds);
    if (to === zoom) return;
    const from = zoom;
    glide((e) => zoomBetween(from, to, e));
  }, [find, targets, width, height, top, seen]);
  // Whoever's panel is opened (by a click, not the find box) is kept in view beside it as it docks over the map: the
  // map pans just far enough, if need be, at the same zoom. Someone just added opens before they reach the map, so
  // this waits for them.
  const heldPlaced = held !== null && targets.placed.has(held);
  useEffect(() => {
    const p = held === null || held === finding.current ? undefined : targets.placed.get(held);
    if (!p) return;
    const to = panToShow(zoom, p, view, bounds);
    if (to === zoom) return;
    const from = zoom;
    glide((e) => zoomBetween(from, to, e));
  }, [held, heldPlaced, seen]);
  // As the panel closes, the map glides back within the bounds of the whole map before they take hold.
  useEffect(() => {
    if (seen <= bound) return;
    const to = clampZoom(zoom, boundsOf(targets.extent, width, seen, VIEW_MARGIN));
    if (sameZoom(to, zoom)) return setBound(seen);
    const from = zoom;
    glide((e) => zoomBetween(from, to, e), () => setBound(seen));
  }, [seen, bound]);

  useEffect(() => {
    const svg = svgRef.current!;
    const zoomTo = (factor: number, event: { clientX: number; clientY: number }) => {
      stopGlide();
      finding.current = null;
      if (live.current.hovering) live.current.unhover();
      const { extent } = live.current;
      const box = svg.getBoundingClientRect();
      const about = { x: event.clientX - box.left - live.current.cx, y: event.clientY - box.top - live.current.cy };
      setAsked((z) => zoomAt(clampZoom(z, extent), factor, about, extent));
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomTo(wheelFactor(event), event);
    };
    // Safari sends a trackpad pinch as gesture events, with the scale since it began, rather than as the wheel.
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    let pinched = 1;
    // iOS sends them for a pinch on the screen too, which the pointer events below zoom already.
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      pinched = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (touch.current.fingers.size > 0) return;
      const { scale } = event as Gesture;
      zoomTo(scale / pinched, event as Gesture);
      pinched = scale;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]")) return;
      if (event.key === "+" || event.key === "=") keys.current.zoomBy(ZOOM_STEP);
      else if (event.key === "-" || event.key === "_") keys.current.zoomBy(1 / ZOOM_STEP);
      else if (event.key === "0") keys.current.goHome();
      else return;
      event.preventDefault();
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("gesturestart", onGestureStart);
    svg.addEventListener("gesturechange", onGestureChange);
    window.addEventListener("keydown", onKey);
    return () => {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("gesturestart", onGestureStart);
      svg.removeEventListener("gesturechange", onGestureChange);
      window.removeEventListener("keydown", onKey);
      stopGlide();
      clearTimeout(touch.current.peek);
    };
  }, []);

  // Dragging empty space pans. A drag that moved is not a click.
  const drag = useRef<{ x: number; y: number; from: Zoom; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragged = useRef(false);

  // Someone's hover card, at the pointer (or the finger held on them).
  const card = (person: DemoPerson, event: { clientX: number; clientY: number; pointerType?: string }) => {
    if (hoverId !== person.id) setHoverId(person.id);
    const s = standings.get(person.id)!;
    const rank = person.rank[at];
    const tip = tipAt(event, person, aspiring.has(person.id) ? aspiringRows(person) : [
      ["Closeness", rank === 0 ? "none yet" : `#${number(rank)} of ${number(count)} (score ${scoreLabel(person.closeness[at])})`],
      ...fieldRows(person),
      ...basicRows(person, s),
      [windowLabel(model.settings.trendMonths), trendSummary(trends.get(person.id)!)],
    ]);
    // On the Spider web the card has one place for each person, beside their dot on the side away from the spider, off its
    // beam, wherever the pointer is on them (tipPlace).
    if (web && !tip.touch) {
      const box = svgRef.current!.getBoundingClientRect();
      const hub = { x: box.left + sun.x, y: box.top + sun.y };
      const p = place(person.id);
      // A name in place of the icon keeps the card off itself, as far out as half its width.
      const name = nameOnly.has(person.id) ? labels.find((label) => label.id === person.id) : undefined;
      const r = name ? Math.max(sized(frames.get(person.id)!), (name.right - name.left) / 2) : sized(frames.get(person.id)!);
      Object.assign(tip, { x: hub.x + p.x, y: hub.y + p.y, dot: { r, hub } });
    }
    hover(tip);
  };

  // Touch (see `touch` above). A finger pans from anywhere, people too, since
  // on a crowded map it rarely lands on empty sky; held still on someone, it
  // shows their card. A second finger turns it into a pinch.
  const fromSun = (finger: { clientX: number; clientY: number }) => {
    const box = svgRef.current!.getBoundingClientRect();
    return { x: finger.clientX - box.left - cx, y: finger.clientY - box.top - cy };
  };
  const twoFingers = (): Fingers => {
    const [a, b] = [...touch.current.fingers.values()];
    return [fromSun(a), fromSun(b)];
  };
  const touchDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    const fingers = touch.current;
    fingers.fingers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    clearTimeout(fingers.peek);
    if (fingers.fingers.size > 2) return;
    if (fingers.fingers.size === 2) {
      drag.current = null;
      fingers.peeking = false;
      stopGlide();
      finding.current = null;
      if (hoverId !== null) unhover();
      fingers.pinch = { from: zoom, start: twoFingers(), last: zoom };
      return;
    }
    fingers.peeking = false;
    drag.current = { x: event.clientX, y: event.clientY, from: zoom, moved: false };
    const person = pick(event, TOUCH_REACH);
    if (!person) return;
    const where = { clientX: event.clientX, clientY: event.clientY, pointerType: "touch" };
    fingers.peek = setTimeout(() => {
      fingers.peeking = true;
      card(person, where);
    }, HOLD_MS);
  };

  const drawn = useMemo(() => [...model.people].sort((a, b) => b.total - a.total), [model.people]);
  // Everyone glows in their own identicon colour (glowColour), and their name is drawn in it, so both are plainly theirs.
  const glowColours = useMemo(() => new Map(model.people.map((p) => [p.id, glowColour(p.identiconSeed, p.identiconHue)])), [model.people]);
  // Where someone counts among the closest for how strongly they are drawn: an aspiring friend, far off as they are, as strongly as the closest.
  const strengthPlace = useCallback((id: number) => (aspiring.has(id) ? 1 : closest.get(id) ?? null), [aspiring, closest]);
  // How strongly someone's marker, name, trail and glow are drawn (strengthOf).
  const strength = useCallback((id: number) => strengthOf(id, strengthPlace(id), reachOut.has(id), focusId, linked, glow.lift), [strengthPlace, reachOut, focusId, linked, glow]);
  // How strongly with nobody picked out, as the people's layer draws everyone (sky, below).
  const restStrength = useCallback((id: number) => strengthOf(id, strengthPlace(id), reachOut.has(id), null, NOBODY, glow.lift), [strengthPlace, reachOut, glow]);
  // 1 once someone is within a few pixels of where they are headed, fading to 0 by ARRIVED pixels away:
  // names and trails belong to where people settle, so they wait while people rise out of the sun or move.
  const arrived = useCallback((id: number) => arrivedShare(frames.get(id)!, targets.placed.get(id)!), [frames, targets]);
  // A name is drawn by how names fade (nameFade.ts), as strongly as its person until the Names settings are moved; one
  // shown only because they are linked to whoever is held, at the Faintest name.
  const labelOpacity = useCallback(
    (label: { id: number; linkedOnly: boolean }) => frames.get(label.id)!.opacity * arrived(label.id)
      * (label.linkedOnly ? fade.faintest : nameStrengthOf(label.id, strengthPlace(label.id), focusId, linked, fade)),
    [frames, arrived, strengthPlace, reachOut, focusId, linked, fade, glow],
  );
  // Whoever you live with, who glow like the sun.
  const home = useMemo(() => new Set(together), [together]);
  /**
   * The marks of `people` (in `drawn` order), in four kinds, each over the last: comet trails, the glow round whoever
   * you live with, the reach-out glow and markers. Each is as strong as `s` says, with whoever is `focus` lit; anyone in
   * `named` is drawn as their name (in the names' layer) and has neither glow nor marker. `layer` keeps a layer's
   * gradients its own, and `tag` marks each mark with whose it is (data-p), for useHiddenMarks.
   */
  const marksFor = ({ people, s, focus, named, layer, tag }: {
    people: DemoPerson[];
    s: (id: number) => number;
    focus: number | null;
    named: ReadonlySet<number>;
    layer: string;
    tag: boolean;
  }) => {
    // What is picked out: the person and, a little less, the people they share group chats with.
    const lit = (id: number) => focus === id;
    const p = (id: number) => (tag ? id : undefined);
    return (
      <>
        {/* Comet trails: from where people sat at the start of the look-back window to now, for those who moved a long way, and whoever is picked out. */}
        <g className="orbits__trails">
          {people.map((person) => {
            const f = frames.get(person.id)!;
            if (f.opacity <= 0.01 || f.silent) return null;
            const from = trailFrom.get(person.id);
            if (from == null) return null;
            // Shorter than the body's radius and a little more, the move would hide behind it: no real change.
            const size = sized(f);
            const minShift = lit(person.id) ? size + 4 : Math.max(size + 4, (outer - inner) * k * TRAIL_SHOWN);
            const trail = displacementTrail({ angle: f.angle, r: f.r * k }, from * k, { width: size * 1.15, minShift });
            if (!trail) return null;
            const { x, y } = place(person.id);
            const [tx, ty] = trail.tail;
            if (!near(x, y) && !near(tx, ty) && !near((x + tx) / 2, (y + ty) / 2)) return null;
            const id = `orbits-${layer}trail-${person.id}`;
            const color = from > f.r ? palette.trail.warm : palette.trail.cool;
            return (
              <g key={person.id} opacity={f.opacity * arrived(person.id) * (lit(person.id) ? 0.95 : 0.32 * s(person.id))} data-p={p(person.id)}>
                <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={x} y1={y} x2={tx} y2={ty}>
                  <stop offset="0" stopColor={color} stopOpacity="0.9" />
                  <stop offset="1" stopColor={color} stopOpacity="0" />
                </linearGradient>
                <path d={`M${trail.outline.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join("L")}Z`} fill={`url(#${id})`} />
              </g>
            );
          })}
        </g>

        {/*
          The sun's own glow, smaller, round whoever you live with: the sun's gradient, shared, so it costs a circle each.
          It stands in for their reach-out glow, which would only muddy it; their name keeps its reach-out halo.
        */}
        <g>
          {people.map((person) => {
            const f = frames.get(person.id)!;
            if (!home.has(person.id) || f.opacity <= 0.01 || named.has(person.id)) return null;
            const { x, y } = place(person.id);
            if (!near(x, y)) return null;
            return (
              <circle
                key={person.id}
                cx={x}
                cy={y}
                r={hearthGlowRadius(sized(f), inner)}
                fill="url(#orbits-sun)"
                opacity={f.opacity * s(person.id)}
                className="orbits__glow"
                data-p={p(person.id)}
              />
            );
          })}
        </g>

        {/*
          The glow round everyone you should reach out to, in their own identicon colour: a gradient each, only for those
          glowing, as far and as bright as the Reach-out glow says, breathing past its halfway (orbits.css).
        */}
        <g>
          {people.map((person) => {
            const f = frames.get(person.id)!;
            if (f.opacity <= 0.01 || f.glow < 0.02 || !glowShown(person.id, glowing) || home.has(person.id) || named.has(person.id)) return null;
            const { x, y } = place(person.id);
            if (!near(x, y)) return null;
            const colour = glowColours.get(person.id);
            return (
              <g key={person.id} data-p={p(person.id)}>
                <radialGradient id={glowId(person.id, layer)}>
                  <stop offset="0.25" stopColor={colour} stopOpacity={glow.core} />
                  <stop offset="0.6" stopColor={colour} stopOpacity={glow.mid} />
                  <stop offset="1" stopColor={colour} stopOpacity="0" />
                </radialGradient>
                <circle
                  cx={x}
                  cy={y}
                  r={sized(f) + (5 + 13 * f.glow) * glow.reach}
                  fill={`url(#${glowId(person.id, layer)})`}
                  opacity={f.opacity * f.glow * s(person.id)}
                  className={glow.pulse > 0 ? "orbits__glow orbits__glow--pulse" : "orbits__glow"}
                  style={glow.pulse > 0 ? ({ "--swell": 1 + SWELL.reach * glow.pulse } as CSSProperties) : undefined}
                />
              </g>
            );
          })}
        </g>

        {/*
          Everyone's marker, filled with their identicon (src/identicon.ts; the patterns are below), as strong as their tier.
          The belt, with no closeness yet, are rings. Whoever is named has no marker: their name is it. An aspiring friend
          is a thought bubble (Bubble) on the page's edge.
        */}
        <g>
          {people.map((person) => {
            const f = frames.get(person.id)!;
            if (f.opacity <= 0.01 || named.has(person.id)) return null;
            const { x, y } = place(person.id);
            if (!near(x, y)) return null;
            if (aspiring.has(person.id)) {
              return (
                <Bubble
                  key={person.id}
                  person={person}
                  x={x}
                  y={y}
                  r={sized(f)}
                  colour={lit(person.id) ? palette.body.lit : glowColours.get(person.id)!}
                  opacity={f.opacity * s(person.id)}
                  layer={layer}
                  tag={p(person.id)}
                />
              );
            }
            return (
              <circle
                key={person.id}
                cx={x}
                cy={y}
                r={sized(f)}
                className="orbits__body"
                fill={f.silent ? "none" : `url(#${faceId(person.id)})`}
                stroke={lit(person.id) ? palette.body.lit : f.silent ? palette.body.silent : palette.body.plain(glowColours.get(person.id)!)}
                strokeWidth={lit(person.id) ? palette.body.width.lit : f.silent ? palette.body.width.silent : palette.body.width.plain}
                opacity={f.opacity * s(person.id)}
                data-p={p(person.id)}
              />
            );
          })}
        </g>
      </>
    );
  };
  // The people's layer: everyone's marks, each as strong as with nobody picked out, in an SVG of its own (peopleLayer
  // below). Drawn again only when what is in it changes: not for a pan, which moves it whole, and not for a hover. While
  // someone is picked out the whole layer is dimmed at once (DIM), and they and whoever shares group chats with them are
  // drawn again over it (lit), their own marks here hidden meanwhile (useHiddenMarks), as is the marker of anyone the
  // pick names; so a hover changes one opacity and a few marks, not every mark on the map.
  const sky = useMemo(
    () => marksFor({ people: drawn, s: restStrength, focus: null, named: restNameOnly, layer: "", tag: true }),
    [frames, k, cullX, cullY, width, height, beyond, trailFrom, together, home, aspiring, inner, outer, drawn, glowColours, palette, restStrength, arrived, restNameOnly, glow, glowing],
  );
  // Who is drawn over the dimmed layer: whoever is picked out and whoever shares group chats with them.
  const picked = useMemo(
    () => (focusId === null ? [] : drawn.filter((p) => (p.id === focusId || linked.has(p.id)) && frames.has(p.id))),
    [drawn, focusId, linked, frames],
  );
  // Whose marks the people's layer hides: theirs, and whoever the pick names, whose name stands in for their marker.
  const hiddenMarks = useMemo(
    () => new Set([...picked.map((p) => p.id), ...[...nameOnly].filter((id) => !restNameOnly.has(id))]),
    [picked, nameOnly, restNameOnly],
  );
  const peopleRef = useRef<SVGSVGElement>(null);
  useHiddenMarks(peopleRef, hiddenMarks, sky);
  // The picked out, at their full strengths (strengthOf), over the dimmed layer.
  const lit = useMemo(
    () => (picked.length === 0 ? null : marksFor({ people: picked, s: strength, focus: focusId, named: nameOnly, layer: "lit-", tag: false })),
    [picked, strength, focusId, nameOnly, k, cullX, cullY, width, height, beyond, trailFrom, home, aspiring, inner, outer, glowColours, palette, arrived, glow, glowing],
  );
  // The rings' labels, over the people so a big one near the top can't hide "top 10".
  const ringLabels = useMemo(() => (
    <g className="orbits__rings">
      {guides.map((ring) => (
        <text key={ring.label} y={-labelR(ring.rank) * k + 3.5} textAnchor="middle" style={{ fill: ringColours(ring.rank, sunColour).label }}>{ring.label}</text>
      ))}
    </g>
  ), [guides, radius, shape, k, sunColour]);
  // The sun keeps its size: zooming in spreads the orbits out from it.
  const sunMark = useMemo(() => <Sun inner={inner} photo={me.photo} onBroken={me.broken} />, [inner, me.photo]);
  // The names, over everything in the sky. They are an SVG of their own over the sky's (nameLayer below), so the sky
  // redrawn (the Spider web's flowing links, the people's layer dimmed) never repaints hundreds of names, nor the names
  // the sky's markers.
  // Each name in its person's own colour, with the outline every name has and nothing behind it, its glow on the letters,
  // as strong as the Reach-out glow says, breathing past its halfway (orbits.css) between that and a swell more.
  const nameMarks = useMemo(() => labels.map((label) => {
    const at = place(label.id);
    const opacity = labelOpacity(label);
    const shine = glowShown(label.id, glowing) ? frames.get(label.id)!.glow : 0;
    const { style, pulsing } = nameStyle(glowColours.get(label.id)!, shine, reachGlow, glow.pulse);
    return (
      <text
        key={label.id}
        className={`orbits__name${label.scale < 1 ? " orbits__name--minor" : ""}${label.id === focusId ? " orbits__name--focus" : ""}${pulsing ? " orbits__name--pulse" : ""}`}
        x={at.x + label.dx}
        y={at.y + label.dy}
        textAnchor={label.anchor}
        style={style}
        opacity={opacity}
      >
        {nameOf(model.people, label.id, names.mapLabel)}
      </text>
    );
  }), [labels, frames, k, focusId, model.people, names.mapLabel, glowColours, labelOpacity, reachGlow, glow, glowing]);
  // What the web layer draws from this render (WebScene), while a spider-web look is on.
  const webPeople = useMemo(() => drawn.map((p) => ({ id: p.id, colour: glowColours.get(p.id)! })), [drawn, glowColours]);
  // Whoever is surely named unzoomed: the closest `named` (with All, SURELY_NAMED), and everyone to reach out to.
  const lockIn = useCallback(
    (id: number) => (amongTop(closest.get(id), Math.min(named, SURELY_NAMED)) || reachOut.has(id)) && !nameHidden(closest.get(id) ?? null, fade),
    [closest, named, reachOut, fade],
  );
  // Each name drawn in place of its icon, as wide and tall as it was placed: the web fits round it.
  const webNames = useMemo(() => new Map(standIns.map((label) => [label.id, { wide: label.right - label.left, tall: label.bottom - label.top }])), [standIns]);
  const scene: WebScene | null = web && shape ? {
    colour, webStrength, shadow, reachGlow, width, height, top, sun, k, inner, outer, shape, frames, people: webPeople, strength, arrived, lockIn, focusId, linked,
    glows: (id) => glowShown(id, glowing), hoverId, heldId: held !== null && targets.frames.has(held) ? held : null, reduced, names: webNames,
  } : null;
  // Everyone's identicon, as a pattern their marker is filled with; drawn again only when who is on the map changes.
  const faces = useMemo(
    () => model.people.map((person) => (
      <pattern key={person.id} id={faceId(person.id)} width="1" height="1" viewBox={`0 0 ${IDENTICON_SIZE} ${IDENTICON_SIZE}`} shapeRendering="crispEdges">
        <IdenticonCells seed={person.identiconSeed} hue={person.identiconHue} />
      </pattern>
    )),
    [model.people],
  );

  // The sky's SVG and the names' over it share their look (the class) and its colours (the style).
  const svgClass = web ? `orbits orbits--web orbits--${presetOf(colour)}` : "orbits";
  const svgColours = (web ? webTheme(colour).css : { "--me": sunColour }) as CSSProperties;
  const svg = (
    <svg
      ref={svgRef}
      className={svgClass}
      width={width}
      height={height}
      onPointerDown={(event) => {
        dragged.current = false;
        touch.current.used = event.pointerType === "touch";
        if (event.pointerType === "touch") return touchDown(event);
        if (event.button !== 0 || pick(event)) return;
        drag.current = { x: event.clientX, y: event.clientY, from: zoom, moved: false };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const fingers = touch.current;
        if (event.pointerType === "touch") {
          if (!fingers.fingers.has(event.pointerId)) return;
          fingers.fingers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
          if (fingers.pinch) {
            if (fingers.fingers.size === 2) setAsked((fingers.pinch.last = pinchZoom(fingers.pinch.from, fingers.pinch.start, twoFingers(), bounds)));
            return;
          }
        }
        const pan = drag.current;
        if (pan) {
          const [dx, dy] = [event.clientX - pan.x, event.clientY - pan.y];
          if (!pan.moved && Math.hypot(dx, dy) < DRAG_START[event.pointerType === "touch" ? "touch" : "mouse"]) return;
          if (!pan.moved) {
            pan.moved = true;
            clearTimeout(fingers.peek);
            stopGlide();
            finding.current = null;
            setDragging(true);
            if (hoverId !== null) unhover();
          }
          setAsked(panBy(pan.from, dx, dy, bounds));
          return;
        }
        if (event.pointerType === "touch") return;
        const person = pick(event);
        if (onSun !== (!person && overSun(event))) setOnSun(!onSun);
        if (person) {
          card(person, event);
        } else if (hoverId !== null) {
          unhover();
        }
      }}
      onPointerUp={(event) => {
        const fingers = touch.current;
        if (event.pointerType === "touch") {
          fingers.fingers.delete(event.pointerId);
          clearTimeout(fingers.peek);
          if (fingers.pinch) {
            // The pinch is over and opens nobody; a finger left on the map pans on from there.
            const [rest] = fingers.fingers.values();
            drag.current = fingers.fingers.size === 1 ? { x: rest.clientX, y: rest.clientY, from: fingers.pinch.last, moved: true } : null;
            fingers.pinch = null;
            dragged.current = true;
            return;
          }
          if (fingers.peeking) {
            // Letting go of a card shown by holding closes it and opens nobody.
            fingers.peeking = false;
            dragged.current = true;
            drag.current = null;
            setDragging(false);
            unhover();
            return;
          }
        }
        dragged.current = drag.current?.moved ?? false;
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={(event) => {
        if (event.pointerType === "touch") {
          const fingers = touch.current;
          fingers.fingers.delete(event.pointerId);
          clearTimeout(fingers.peek);
          fingers.pinch = null;
          fingers.peeking = false;
          if (hoverId !== null) unhover();
        }
        drag.current = null;
        setDragging(false);
      }}
      onPointerLeave={() => {
        if (!drag.current) unhover();
        setOnSun(false);
      }}
      onClick={(event) => {
        if (dragged.current) return;
        const reach = touch.current.used ? TOUCH_REACH : 16;
        const person = pick(event, reach);
        if (person) open(person);
        else if (dropsHold(event, reach)) close!();
        // A finger has no hover: a tap on the sun shows its buttons, and a tap anywhere else hides them.
        if (touch.current.used) setOnSun(!person && overSun(event) && !onSun);
      }}
      style={{ ...svgColours, cursor: dragging ? "grabbing" : hoverId !== null ? "pointer" : k > 1 ? "grab" : undefined }}
    >
      <defs>
        <radialGradient id="orbits-sun">
          {palette.sun.map(([offset, colour, opacity]) => <stop key={offset} offset={offset} stopColor={colour} stopOpacity={opacity} />)}
        </radialGradient>
      </defs>
      <g transform={`translate(${sun.x} ${sun.y})`}>
        {/* Guide rings: the closest 10, 25, 50 and so on; the web's own rings stand in for them. */}
        <g className="orbits__rings">
          {!web && guides.map((ring) => <circle key={ring.label} r={radius(ring.rank) * k} style={{ stroke: ringColours(ring.rank, sunColour).line }} />)}
          {focusId !== null && !aspiring.has(focusId) && frames.get(focusId)!.opacity > 0 && (
            <circle className="orbits__own-ring" r={frames.get(focusId)!.r * k} />
          )}
        </g>

        {/* Friend circles, while chosen: an arc round the outside of each, brighter for whoever's is picked out, and its name. */}
        {circleArcs.length > 0 && (
          <g className="orbits__circles">
            {circleArcs.map((arc) => {
              const r = arcR * k;
              const [x1, y1, x2, y2] = [Math.cos(arc.from) * r, Math.sin(arc.from) * r, Math.cos(arc.to) * r, Math.sin(arc.to) * r];
              return (
                <path
                  key={arc.from}
                  className={focusId !== null && arc.ids.has(focusId) ? "orbits__circle orbits__circle--lit" : "orbits__circle"}
                  d={`M${x1.toFixed(1)},${y1.toFixed(1)}A${r.toFixed(1)},${r.toFixed(1)} 0 ${arc.to - arc.from > Math.PI ? 1 : 0} 1 ${x2.toFixed(1)},${y2.toFixed(1)}`}
                />
              );
            })}
          </g>
        )}

        {sunMark}

        {/* Who shares group chats with the person picked out. */}
        <g className="orbits__links">
          {focusLinks.map((link) => {
            const other = link.source === focusId ? link.target : link.source;
            if (!frames.has(other) || frames.get(other)!.opacity === 0) return null;
            const a = place(focusId!);
            const b = place(other);
            return <line key={other} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={Math.min(2.2, 0.5 + link.weight * 2.5)} />;
          })}
        </g>
      </g>
    </svg>
  );
  // The people's layer (sky), with everyone's identicon that the markers here and over it are filled with, dimmed as a
  // whole while someone is picked out; and over it whoever is (lit), the rings' labels and the friend circles' names.
  // Like the names' layer, the pointer goes through both to the sky beneath.
  const peopleLayer = (
    <svg ref={peopleRef} className={`${svgClass} orbits__people`} width={width} height={height} style={{ ...svgColours, opacity: focusId === null ? undefined : DIM }}>
      <defs>{faces}</defs>
      <g transform={`translate(${sun.x} ${sun.y})`}>{sky}</g>
    </svg>
  );
  const litLayer = (
    <svg className={`${svgClass} orbits__lit`} width={width} height={height} style={svgColours}>
      <g transform={`translate(${sun.x} ${sun.y})`}>
        {lit}
        {ringLabels}
        {/* The friend circles' names, kept on the page as it pans, so drawn apart from the sky, which a pan moves whole. */}
        <g className="orbits__circles">
          {circleNames(zoom).map(({ arc, x, y, anchor }) => (
            <text key={arc.from} x={x} y={y} textAnchor={anchor} className={focusId !== null && arc.ids.has(focusId) ? "orbits__circle--lit" : undefined}>
              {arc.label}
            </text>
          ))}
        </g>
      </g>
    </svg>
  );
  // The names (nameMarks), placed as the sky is; the pointer goes through to the sky beneath.
  const nameLayer = (
    <svg className={`${svgClass} orbits__name-layer`} width={width} height={height} style={svgColours}>
      <g transform={`translate(${sun.x} ${sun.y})`}>{nameMarks}</g>
    </svg>
  );
  const layers = <>{svg}{peopleLayer}{litLayer}{nameLayer}</>;
  return (
    <>
    {scene ? <WebLayer scene={scene} motion={boot}>{layers}</WebLayer> : layers}
    {photoShown(look) && <SunControls x={sun.x} y={sun.y} inner={inner} photo={me.photo} shown={onSun} onPhoto={me.setPhoto} />}
    </>
  );
}

/** A name placed on its person (`label`) moved under an aspiring friend's bubble of radius `size`, where it stays with them. */
export function underBubble(label: PlacedName, size: number): PlacedName {
  return { ...label, dy: label.dy + size + ASPIRING_NAME_GAP };
}

/**
 * An aspiring friend's marker: a thought bubble, for the conversations you have with them in your head. Their identicon
 * dim behind a dashed ring in their `colour`, as nobody on the orbits is, and two dots trailing back toward the sun.
 */
export function Bubble({ person, x, y, r, colour, opacity, layer = "", tag }: {
  person: Pick<DemoPerson, "id" | "identiconSeed" | "identiconHue">;
  /** Where it is, relative to the sun. */
  x: number;
  y: number;
  r: number;
  colour: string;
  opacity: number;
  /** What keeps its identicon's pattern id its layer's own, as Orbits' marks have (marksFor). */
  layer?: string;
  /** Whose it is, as its layer tags its marks (data-p), if it does. */
  tag?: number;
}) {
  const out = Math.hypot(x, y) || 1;
  const [ux, uy] = [x / out, y / out];
  const face = `orbits-${layer}bubble-${person.id}`;
  return (
    <g className="orbits__bubble" opacity={opacity} data-p={tag}>
      <pattern id={face} width="1" height="1" viewBox={`0 0 ${IDENTICON_SIZE} ${IDENTICON_SIZE}`} shapeRendering="crispEdges">
        <IdenticonCells seed={person.identiconSeed} hue={person.identiconHue} />
      </pattern>
      <circle cx={x - ux * (r + 7)} cy={y - uy * (r + 7)} r={r * 0.17} fill={colour} />
      <circle cx={x - ux * (r + 15)} cy={y - uy * (r + 15)} r={r * 0.1} fill={colour} />
      <circle cx={x} cy={y} r={r} fill={`url(#${face})`} opacity={0.55} />
      <circle cx={x} cy={y} r={r} fill="none" stroke={colour} strokeWidth={1.4} strokeDasharray={`${r * 0.34} ${r * 0.2}`} />
    </g>
  );
}

/** Whether a look shows your photo in place of the sun, with its "+" and "×": Orbits' own does, the Spider web never. */
export function photoShown(look: OrbitLook): boolean {
  return look !== "web";
}

/** What a guide ring's label (`label`, drawn centred at `y` straight up from the sun) covers, with a little room round it. */
export function ringLabelBox(label: string, y: number): Box {
  const half = (label.length * 7) / 2 + 4;
  return { left: -half, right: half, top: y - 8, bottom: y + 6 };
}

/** The id of the gradient a person glows with when you should reach out to them, in a layer (`layer`, marksFor's). */
function glowId(personId: number, layer: string): string {
  return `orbits-${layer}glow-${personId}`;
}

/** The id of the pattern holding a person's identicon. */
function faceId(id: number): string {
  return `orbits-face-${id}`;
}

/** Orbits in the theme colour its settings choose (orbitsTheme.ts), its alone, naming as many as its Show top names says. */
function OrbitsView(props: ViewProps) {
  return <OrbitMap {...props} theme={useOrbitsTheme()} named={useTopNames("orbits")} padding={useNamePadding("orbits")} />;
}

/** The Spider web, naming as many as its own Show top names says. */
function WebView(props: ViewProps) {
  return <OrbitMap {...props} look="web" named={useTopNames("web")} padding={useNamePadding("web")} />;
}

export const orbits: Demo = {
  slug: "orbits",
  title: "Orbits",
  keepsSize: true,
  View: OrbitsView,
};

/** The same map, round the sun in friend circles. */
export const circles: Demo = {
  slug: "circles",
  title: "Circles",
  keepsSize: true,
  View: (props) => <OrbitMap {...props} order="circles" />,
};

/** The same map as a spider's web (webLook.ts), in the colour the address says (webColour.ts): a scan boots it in, and again on every re-query. */
export const web: Demo = {
  slug: "web",
  title: "Spider web",
  keepsSize: true,
  View: WebView,
};
