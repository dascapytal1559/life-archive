// Orbits 3D, at /orbits-3d: Orbits (Orbits.tsx) as a solar system. It opens
// exactly as Orbits does, seen from straight above: the same people in the
// same places (orbitsSky.ts places everyone for both views), the sun, the
// rings, the glows, the trails and the names. Then the camera moves as the
// City's does (cityCamera.ts): a drag with the middle or right button, or
// with Ctrl held, turns the sky round the sun and tilts it; two fingers
// twisted or dragged up and down do the same on a touch screen; and as it
// tilts, the discs round into spheres lit by the sun, each on an orbit that
// leans a little out of the plane by its own inclination (orbits3dScene.ts),
// so the disc opens into a system with depth, the rings become ellipses, and
// the names move into the scene (orbits3dNames.ts): each in its person's
// place, facing the camera, hidden by whatever is nearer. The compass in the bottom-left corner glides the camera back to
// straight above, where it is Orbits again; `?tour=` in the address plays a
// scripted camera move from straight above, for recording a clip
// (orbits3dTour.ts). Everything else is Orbits':
// hovering shows the card, a click opens the panel, whoever's panel is open
// stays picked out with their group-chat lines, the find box, the Query bar,
// Hide, the settings and demo mode apply, and it zooms and pans the same way
// (orbitsZoom.ts).
//
// Drawn on three layers: an SVG beneath for what lies in the sun's plane
// (the rings, the trails, the lines to whoever is picked out), a WebGL
// canvas for the sun, the glows, the spheres and, tilted, the names
// (orbits3dGl.ts), and an SVG above for the text that stays flat (the ring
// labels, and from straight above the names, as Orbits
// draws them), which keeps Orbits' own type and styles. Loaded only when
// opened (Demos.tsx), so no other view carries it.

import { Delaunay, easeCubicOut } from "d3";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNames } from "../names.ts";
import { cameraBetween, squash, turnCamera, twistCamera, type Camera, type Fingers as CameraFingers } from "./cityCamera.ts";
import { scoreLabel } from "./closeness.ts";
import { Compass } from "./Compass.tsx";
import type { DemoPerson } from "./model.ts";
import { Bubble, drawnBox, focusLinksOf, focusOf, heldOnly, nameAt, nameStyle, PHONE, ringLabelBox, underBubble } from "./Orbits.tsx";
import {
  aspiringSize, BACKGROUND, displacementTrail, drawnSize, glowColour, grown, hearthGlowRadius, orbitRadius, personOpacity, READABLE, rings,
} from "./orbitsLayout.ts";
import { drawnAt, heightOf, HOME_VIEW, inclinationOf, lightOn, nearness, paintOrder, ringAxes, sceneExtent, shadeAt } from "./orbits3dScene.ts";
import { COLOUR_GLOW, HOLLOW, NAME, PHOTO, rgb, SkyGl, SPHERE, SUN_CORE, SUN_GLOW, type Sprite } from "./orbits3dGl.ts";
import { NameAtlas, nameKey, namesInScene, type NameLook, type NameSlot } from "./orbits3dNames.ts";
import { tourAt, tourOf } from "./orbits3dTour.ts";
import { arrivedShare, ASPIRING_NAME_GAP, aspiringEdge, NAME_FONT, nameOf, onPage, stageOf, useMedia, useNameFit, useOrbitBodies, useOrbitNames, useSettled, useTween, type XY } from "./orbitsSky.ts";
import { DEFAULT_NAME_PADDING, useNamePadding } from "./namePadding.ts";
import { useTopNames } from "./topNames.ts";
import { nameStrengthOf, useNameFade } from "./nameFade.ts";
import { clampZoom, HOME, panBy, pinchZoom, wheelFactor, ZOOM_STEP, zoomAt, zoomBetween, zoomToShow, type Fingers, type Zoom } from "./orbitsZoom.ts";
import "./orbits.css";
import "./orbits3d.css";
import { COLORS } from "./palette.ts";
import { glowLook, glowShown, glowsOf, useReachGlow } from "./reachGlow.ts";
import { ringColours } from "./ringColours.ts";
import { PHOTO_SHARE, SUN_SHARE, SunControls, useMePhoto } from "./SunPhoto.tsx";
import { trendSummary, windowLabel } from "./trend.ts";
import { aspiringRows, basicRows, fieldRows, number, tipAt, type ViewProps } from "./view.tsx";

/** How long people take to move to new places (new messages, a new query), in ms. */
const MOVE_MS = 700;
/** How long the view must hold still before names are placed for it, in ms. */
const SETTLE_MS = 140;
/** How long a press of + or −, going back to the whole map (0), bringing someone found into view, or the compass takes to glide there, in ms. */
const GLIDE_MS = 240;
/** How far in from the map's edges, in pixels, someone found with the find box counts as in view. */
const FIND_MARGIN = 60;
/** How far, in pixels, a mouse or a finger moves before a press is a drag (a finger wobbles more in a tap). */
const DRAG_START = { mouse: 3, touch: 10 };
/** How long a finger held on someone takes to show their hover card, in ms; letting go then opens nothing. */
const HOLD_MS = 400;
/** How near, in pixels, a finger must land to someone to pick them: further than the pointer's 16, as a fingertip is broad. */
const TOUCH_REACH = 24;
/** A move, as a share of the room between the sun and the edge, big enough for a trail without hovering. */
const TRAIL_SHOWN = 0.1;
/** The canvas is drawn no sharper than this, so a phone's 3× screen does not triple the work. */
const MAX_DPR = 2;
/** How far beyond the page, in pixels, something is still drawn (a glow reaches past its person). */
const BEYOND = 80;

/** The zoom and the camera, kept while the page is open, so switching views and back keeps them; a reload starts from straight above. */
export const keptZoom: { current: Zoom } = { current: HOME };
export const keptCamera: { current: Camera } = { current: HOME_VIEW };

/** Where the view is seen from: the zoom and the camera together, settled together for the names. */
interface View {
  zoom: Zoom;
  camera: Camera;
}
const sameView = (a: View, b: View) =>
  a.zoom.k === b.zoom.k && a.zoom.x === b.zoom.x && a.zoom.y === b.zoom.y && a.camera.bearing === b.camera.bearing && a.camera.tilt === b.camera.tilt;

const STROKE = {
  lit: [...rgb(COLORS.star), 1] as const,
  silent: [...rgb(COLORS.dim), 1] as const,
  body: [7 / 255, 11 / 255, 22 / 255, 0.55] as const,
  photo: [...rgb(COLORS.me), 0.85] as const,
};

export function Orbits3DMap({ model, width, height, inset: top, hover, open, held = null, heldGroup = null, find = null }: ViewProps) {
  // Now: the last month.
  const at = model.months.length - 1;
  const [hoverId, setHoverId] = useState<number | null>(null);
  const names = useNames();
  // How many of the closest are named unzoomed: Orbits 3D's own Show top names (topNames.ts).
  const named = useTopNames("orbits-3d");
  // How many pixels apart its names are fitted: its own Name padding (namePadding.ts).
  const padding = useNamePadding("orbits-3d");
  // How names fade down the ranking: the Names settings, every map view's (nameFade.ts).
  const fade = useNameFade();
  const phone = useMedia(PHONE);
  const reduced = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, []);
  const me = useMePhoto();
  const [onSun, setOnSun] = useState(false);

  // The same stage and the same places as Orbits (orbitsSky.ts), A to Z round the sun.
  const { outer, inner, cx, cy } = stageOf(width, height, top);
  const bubble = aspiringSize(outer);
  const edge = useMemo(() => aspiringEdge(width, height, top, cx, cy, bubble), [width, height, top, cx, cy, bubble]);
  const { count, together, aspiring, radius, standings, closest, trends, trailFrom, targets: spokes } = useOrbitBodies(model, at, inner, outer, "name", edge);
  const reachOut = useMemo(() => new Set(model.people.filter((p) => p.shouldReachOut).map((p) => p.id)), [model.people]);
  // Aspiring friends stay where they are on the edge, and are named wherever they are, as on Orbits 2D.
  const unturned = useMemo(() => [...together, ...aspiring], [together, aspiring]);
  const alwaysNamed = useMemo(() => new Set([...reachOut, ...aspiring]), [reachOut, aspiring]);
  // Those named on the whole map are turned round their orbits until no name covers another or a ring label, `padding`
  // pixels clear (useNameFit), as on Orbits 2D, so from straight above it is that map; nobody's distance changes.
  const ringBoxes = useMemo(() => rings(count).map((ring) => grown(ringLabelBox(ring.label, -radius(ring.rank)), -DEFAULT_NAME_PADDING / 2)), [count, radius]);
  const targets = useNameFit(spokes, {
    on: !phone && names.style !== "hide", model, at, closest, named, reachOut, together: unturned, label: names.mapLabel, font: NAME_FONT, around: ringBoxes, padding, fade,
  });
  const frames = useTween(targets.frames, MOVE_MS, { from: inner * 0.3, stagger: 700, outer, inner }, `${inner}:${outer}`);
  const home = useMemo(() => new Set(together), [together]);
  // How each person's orbit leans out of the plane: from their seed, so it never changes under them.
  const inclines = useMemo(() => new Map(model.people.map((p) => [p.id, inclinationOf(p.identiconSeed)])), [model.people]);
  const heightNow = (id: number) => heightOf(frames.get(id)!, inclines.get(id)!, home.has(id));
  // Where everyone is headed, in height: for the extent, and for the names, which belong where people settle.
  const restHeights = useMemo(
    () => new Map([...targets.frames].map(([id, f]) => [id, heightOf(f, inclines.get(id)!, home.has(id))])),
    [targets, inclines, home],
  );

  // Who is picked out: whoever's panel is open, else the person under the pointer; their group-chat links.
  const focusId = focusOf(hoverId, held, (id) => targets.frames.has(id));
  const focusLinks = useMemo(() => focusLinksOf(model, focusId, held, heldGroup), [model, focusId, held, heldGroup]);
  const linked = useMemo(() => new Set(focusLinks.map((l) => (l.source === focusId ? l.target : l.source))), [focusLinks, focusId]);
  // While someone is held, only they and their links glow, and nobody under No name except… (glowsOf), as on Orbits.
  const glowing = useMemo(() => glowsOf(heldOnly(held, focusId, linked), names.hidden), [held, focusId, linked, names.hidden]);
  // How strongly they glow (reachGlow.ts), as on Orbits; the scene's glows are drawn as things move, so only the flat names breathe.
  const reachGlow = useReachGlow();
  const glow = useMemo(() => glowLook(reachGlow), [reachGlow]);
  // How strongly someone is drawn: by their tier, someone to reach out to at least as the last tier; while someone is
  // picked out, they at full strength, those linked to them at 70%, and everyone else at one flat BACKGROUND.
  const strengthPlace = (id: number) => (aspiring.has(id) ? 1 : closest.get(id) ?? null);
  const strength = (id: number) =>
    focusId === null ? personOpacity(strengthPlace(id), reachOut.has(id), { lift: glow.lift }) : focusId === id ? 1 : linked.has(id) ? 0.7 : BACKGROUND;

  // The camera (cityCamera.ts): turned and tilted by a drag, back to straight above by the compass.
  const [camera, setCamera] = useState(() => keptCamera.current);
  useEffect(() => void (keptCamera.current = camera), [camera]);
  // How far the system reaches as the camera sees it: the disc everyone is on, and the highest and lowest anyone leans.
  const extent = useMemo(() => {
    let above = 0;
    let below = 0;
    for (const h of restHeights.values()) {
      above = Math.max(above, h);
      below = Math.min(below, h);
    }
    // Aspiring friends out at the page's edge are past the disc, and may be panned to.
    const { left, right, top, bottom } = targets.extent;
    return sceneExtent(Math.max(targets.reach, -left, right, -top, bottom), above, below, camera);
  }, [targets, restHeights, camera]);

  // The zoom, as Orbits keeps it: what is asked for is kept as asked, and brought within bounds for the system as
  // it is now; whoever would see nobody at all at it goes back to the whole map.
  const page = { left: 0, right: width, top, bottom: height };
  const sees = (zoom: Zoom) =>
    [...targets.placed.values()].some((p) => {
      const q = drawnAt(camera, p.x, p.y, restHeights.get(p.id)!, zoom.k);
      return onPage({ x: cx + zoom.x + q.x, y: cy + zoom.y + q.y }, page, 0);
    });
  const [asked, setAsked] = useState(() => (sees(clampZoom(keptZoom.current, extent)) ? keptZoom.current : HOME));
  const [askedFor, setAskedFor] = useState(targets);
  if (askedFor !== targets) {
    setAskedFor(targets);
    if (!sees(clampZoom(asked, extent))) setAsked(HOME);
  }
  const zoom = clampZoom(asked, extent);
  useEffect(() => void (keptZoom.current = zoom), [zoom.k, zoom.x, zoom.y]);
  const { k } = zoom;
  const sun = { x: cx + zoom.x, y: cy + zoom.y };
  const view = useMemo((): View => ({ zoom, camera }), [zoom.k, zoom.x, zoom.y, camera]);
  // Names are placed for the view once it has held still for a moment, and carried along with their people meanwhile.
  const settled = useSettled(view, SETTLE_MS, sameView);

  // Where each person is drawn now, relative to the sun, as the camera sees them.
  const place = (id: number): XY => {
    const f = frames.get(id)!;
    return drawnAt(camera, Math.cos(f.angle) * f.r, Math.sin(f.angle) * f.r, heightNow(id), k);
  };
  // Names (useOrbitNames): placed where people settle at the settled view.
  const spot = useCallback((id: number): XY => {
    const p = targets.placed.get(id)!;
    return drawnAt(settled.camera, p.x, p.y, restHeights.get(id)!, settled.zoom.k);
  }, [targets, restHeights, settled]);
  const { labels: placedLabels } = useOrbitNames({
    model, at, closest, named, reachOut: alwaysNamed, names, phone,
    k: settled.zoom.k, sun: { x: cx + settled.zoom.x, y: cy + settled.zoom.y }, spot,
    width, height, top, focusId, held, linked, fade,
  });
  // An aspiring friend's name goes under their bubble.
  const labels = useMemo(
    () => (aspiring.size === 0 ? placedLabels : placedLabels.map((label) => (aspiring.has(label.id) ? underBubble(label, bubble) : label))),
    [placedLabels, aspiring, bubble],
  );
  // Whoever is named is drawn as their name alone, in place of their sphere and its glow; an aspiring friend keeps their bubble.
  const nameOnly = useMemo(() => new Set(labels.filter((label) => !aspiring.has(label.id)).map((label) => label.id)), [labels, aspiring]);

  // Drawing: the WebGL canvas (orbits3dGl.ts) for the sun, the glows, the spheres and, tilted, the names.
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<SkyGl | null>(null);
  const [noGl, setNoGl] = useState(false);
  const dpr = Math.min(MAX_DPR, (typeof window === "undefined" ? 1 : window.devicePixelRatio) || 1);
  const drawn = useMemo(() => [...model.people].sort((a, b) => b.total - a.total), [model.people]);
  const glowRgb = useMemo(() => new Map(model.people.map((p) => [p.id, rgb(glowColour(p.identiconSeed, p.identiconHue))])), [model.people]);
  const glowColours = useMemo(() => new Map(model.people.map((p) => [p.id, glowColour(p.identiconSeed, p.identiconHue)])), [model.people]);
  const sized = (id: number) => {
    const f = frames.get(id)!;
    return f.silent ? f.size : drawnSize(f.size, k);
  };
  const arrived = (id: number) => arrivedShare(frames.get(id)!, targets.placed.get(id)!);
  // A name is drawn by how names fade (nameFade.ts); one shown only because they are linked to whoever is held, at the Faintest name.
  const labelOpacity = (label: { id: number; linkedOnly: boolean }) => frames.get(label.id)!.opacity * arrived(label.id)
    * (label.linkedOnly ? fade.faintest : nameStrengthOf(label.id, strengthPlace(label.id), focusId, linked, fade));

  // The names, tilted (orbits3dNames.ts): how far they are in the scene rather than Orbits' flat overlay, and how each
  // is drawn (Orbits' type, the person's colour, bold when picked out, glowing when to reach out to), each drawn once
  // into the names atlas and uploaded whenever a drawing is new; the same names as the overlay's (useOrbitNames).
  const inScene = namesInScene(camera);
  const looks = useMemo(
    () => new Map(labels.map((label): [number, NameLook] => [label.id, {
      text: nameOf(model.people, label.id, names.mapLabel),
      colour: glowColours.get(label.id)!,
      scale: label.scale,
      bold: label.id === focusId,
      glow: targets.frames.get(label.id)!.glow >= 0.02 && glowShown(label.id, glowing) ? glowColours.get(label.id)! : null,
      boost: reachGlow,
    }])),
    [labels, model.people, names.mapLabel, glowColours, focusId, targets, reachGlow, glowing],
  );
  const lookKeys = useMemo(() => [...looks.values()].map(nameKey).sort().join("\n"), [looks]);
  const atlas = useRef(new NameAtlas());
  const slots = useRef<Map<string, NameSlot>>(new Map());
  useEffect(() => {
    const gl = glRef.current;
    if (!gl || inScene === 0) return;
    const family = getComputedStyle(wrapRef.current!).getPropertyValue("--serif").trim() || "serif";
    const built = atlas.current.build([...looks.values()], dpr, family);
    gl.names(built.canvas);
    slots.current = built.slots;
    drawRef.current();
  }, [lookKeys, dpr, inScene > 0]);

  const draw = () => {
    const gl = glRef.current;
    if (!gl) return;
    const shade = shadeAt(camera);
    const hearthGlows: Sprite[] = [];
    const reachGlows: Sprite[] = [];
    const bodies: Array<Sprite & { near: number }> = [];
    const nameSprites: Array<Sprite & { near: number }> = [];
    // The sun (its solid middle taking a depth, so a name behind it is hidden), and your photo over it;
    // everyone else as the sun lights them.
    bodies.push({ x: 0, y: 0, r: inner * SUN_SHARE, alpha: 1, mode: SUN_GLOW, near: 0 });
    bodies.push({ x: 0, y: 0, r: inner * SUN_SHARE, alpha: 1, mode: SUN_CORE, near: 0 });
    if (gl.photoShown) bodies.push({ x: 0, y: 0, r: inner * PHOTO_SHARE, alpha: 1, mode: PHOTO, colour: STROKE.photo, stroke: 1.5, near: 0 });
    const bounds = { left: -sun.x, right: width - sun.x, top: -sun.y, bottom: height - sun.y };
    const named = inScene > 0 ? new Map(labels.map((label) => [label.id, label])) : null;
    for (const person of drawn) {
      const f = frames.get(person.id)!;
      if (f.opacity <= 0.01) continue;
      const [wx, wy, h] = [Math.cos(f.angle) * f.r, Math.sin(f.angle) * f.r, heightNow(person.id)];
      const p = drawnAt(camera, wx, wy, h, k);
      if (!onPage(p, bounds, BEYOND)) continue;
      const str = strength(person.id);
      const size = sized(person.id);
      const lit = person.id === focusId;
      const near = nearness(camera, wx, wy, h);
      // Whoever is named has no sphere and no glow: their name, below, stands in for them.
      const alone = nameOnly.has(person.id);
      if (alone) {
        // Neither glow: the name's own glow marks someone to reach out to.
      } else if (home.has(person.id)) {
        hearthGlows.push({ x: p.x, y: p.y, r: hearthGlowRadius(size, inner), alpha: f.opacity * str, mode: SUN_GLOW });
      } else if (f.glow >= 0.02 && glowShown(person.id, glowing)) {
        const [r, g, b] = glowRgb.get(person.id)!;
        reachGlows.push({ x: p.x, y: p.y, r: size + (5 + 13 * f.glow) * glow.reach, alpha: f.opacity * f.glow * str * glow.gain, mode: COLOUR_GLOW, colour: [r, g, b, 1] });
      }
      // An aspiring friend's bubble is in the plane, on the SVG under this (`ground`).
      if (!alone && !aspiring.has(person.id)) bodies.push({
        x: p.x, y: p.y, r: size, alpha: f.opacity * str,
        mode: f.silent ? HOLLOW : SPHERE,
        colour: lit ? STROKE.lit : f.silent ? STROKE.silent : STROKE.body,
        stroke: lit ? 1.6 : f.silent ? 1 : 0.8,
        face: person.id,
        light: lightOn(camera, wx, wy, h),
        shade,
        near,
      });
      // Their name, in the scene: over the sphere at its depth, on the device's pixel grid so it is as crisp as drawn.
      const label = named?.get(person.id);
      const look = label && looks.get(person.id);
      const slot = look && slots.current.get(nameKey(look));
      if (!label || !slot) continue;
      const alpha = labelOpacity(label) * inScene;
      if (alpha <= 0.01) continue;
      const snap = (v: number, origin: number) => Math.round((origin + v) * dpr) / dpr - origin;
      const under = aspiring.has(person.id) ? size + ASPIRING_NAME_GAP : 0;
      nameSprites.push({ x: snap(p.x, sun.x), y: snap(p.y + under, sun.y), r: 0, alpha, mode: NAME, uv: slot.uv, wide: slot.wide, tall: slot.tall, near });
    }
    gl.draw([...hearthGlows, ...reachGlows, ...paintOrder(bodies, (b) => b.near), ...paintOrder(nameSprites, (n) => n.near)], sun, width, height, dpr, camera);
  };
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    const canvas = canvasRef.current!;
    const gl = SkyGl.on(canvas);
    glRef.current = gl;
    if (!gl) setNoGl(true);
    return () => {
      gl?.dispose();
      glRef.current = null;
    };
  }, []);
  useEffect(() => {
    glRef.current?.faces(model.people);
    drawRef.current();
  }, [model.people]);
  // Your photo, in place of the sun, once it has loaded.
  const [photoLoaded, setPhotoLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (!me.photo) {
      glRef.current?.photo(null);
      setPhotoLoaded(null);
      return;
    }
    let live = true;
    const image = new Image();
    image.onload = () => {
      if (!live) return;
      glRef.current?.photo(image);
      setPhotoLoaded(me.photo);
    };
    image.onerror = () => live && me.broken();
    image.src = me.photo;
    return () => {
      live = false;
    };
  }, [me.photo]);
  useEffect(() => {
    drawRef.current();
  }, [frames, zoom.k, zoom.x, zoom.y, camera, focusId, linked, width, height, dpr, reachOut, home, closest, photoLoaded, drawn, labels, looks, glow, glowing]);

  // Picking: the nearest person within reach of the pointer, found through a triangulation of where everyone is
  // drawn, built when the pointer first needs it for each drawing.
  const nearest = useRef<{ frames: typeof frames; people: DemoPerson[]; k: number; camera: Camera; points: Array<[number, number]>; delaunay: Delaunay<[number, number]> } | null>(null);
  const pick = (event: { clientX: number; clientY: number }, reach = 16): DemoPerson | null => {
    const box = wrapRef.current!.getBoundingClientRect();
    const x = event.clientX - box.left - sun.x;
    const y = event.clientY - box.top - sun.y;
    // A name stands in for its sphere: the pointer on it picks its person (a finger a little further out).
    if (nameOnly.size > 0) {
      const id = nameAt({ x, y }, labels.map((label) => ({ id: label.id, box: drawnBox(label, place(label.id)) })), Math.max(2, reach - 16));
      const person = id === null ? undefined : model.people.find((p) => p.id === id);
      if (person && frames.get(person.id)!.opacity >= 0.5) return person;
    }
    let found = nearest.current;
    if (!found || found.frames !== frames || found.people !== model.people || found.k !== k || found.camera !== camera) {
      const points = model.people.map((p) => {
        const q = place(p.id);
        return [q.x, q.y] as [number, number];
      });
      found = nearest.current = { frames, people: model.people, k, camera, points, delaunay: Delaunay.from(points) };
    }
    const i = found.delaunay.find(x, y);
    const person = model.people[i];
    if (!person || frames.get(person.id)!.opacity < 0.5) return null;
    const [px, py] = found.points[i];
    return Math.hypot(px - x, py - y) <= Math.max(reach, sized(person.id) + 8) ? person : null;
  };
  const unhover = () => {
    setHoverId(null);
    hover(null);
  };
  const overSun = (event: { clientX: number; clientY: number }) => {
    const box = wrapRef.current!.getBoundingClientRect();
    return Math.hypot(event.clientX - box.left - sun.x, event.clientY - box.top - sun.y) <= inner * PHOTO_SHARE;
  };
  const card = (person: DemoPerson, event: { clientX: number; clientY: number; pointerType?: string }) => {
    if (hoverId !== person.id) setHoverId(person.id);
    const s = standings.get(person.id)!;
    const rank = person.rank[at];
    hover(tipAt(event, person, aspiring.has(person.id) ? aspiringRows(person) : [
      ["Closeness", rank === 0 ? "none yet" : `#${number(rank)} of ${number(count)} (score ${scoreLabel(person.closeness[at])})`],
      ...fieldRows(person),
      ...basicRows(person, s),
      [windowLabel(model.settings.trendMonths), trendSummary(trends.get(person.id)!)],
    ]));
  };

  // Zooming and panning as Orbits, turning and tilting as the City (see their files): the wheel or a trackpad
  // pinch about the pointer, a drag of empty sky, + − 0 about the middle; a drag with the middle or right button
  // or with Ctrl held turns and tilts; on a touch screen two fingers pinch, twist and tilt, one drags, a tap opens
  // someone and a finger held on them shows their card.
  const live = useRef({ extent, origin: { x: cx, y: cy }, hovering: hoverId !== null, unhover });
  live.current = { extent, origin: { x: cx, y: cy }, hovering: hoverId !== null, unhover };
  const motion = useRef<{ glide: number; fallback: ReturnType<typeof setTimeout> | undefined }>({ glide: 0, fallback: undefined });
  const finding = useRef<number | null>(null);
  const touch = useRef<{
    fingers: Map<number, { clientX: number; clientY: number }>;
    pinch: { from: Zoom; fromCamera: Camera; start: Fingers; last: Zoom } | null;
    peek: ReturnType<typeof setTimeout> | undefined;
    peeking: boolean;
    used: boolean;
  }>({ fingers: new Map(), pinch: null, peek: undefined, peeking: false, used: false });
  const stopGlide = () => {
    cancelAnimationFrame(motion.current.glide);
    clearTimeout(motion.current.fallback);
  };
  const glide = (step: (e: number) => void) => {
    stopGlide();
    if (reduced) return step(1);
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / GLIDE_MS);
      step(easeCubicOut(p));
      if (p < 1) motion.current.glide = requestAnimationFrame(tick);
    };
    motion.current.glide = requestAnimationFrame(tick);
    // Where animation frames stall (a tab in the background), land anyway.
    motion.current.fallback = setTimeout(() => {
      cancelAnimationFrame(motion.current.glide);
      step(1);
    }, GLIDE_MS + 300);
  };
  const middle = { x: 0, y: (top + height) / 2 - cy };
  const zoomBy = (factor: number) => {
    finding.current = null;
    const from = zoom;
    glide((e) => setAsked(zoomAt(from, factor ** e, middle, extent)));
  };
  const goHome = () => {
    finding.current = null;
    const from = zoom;
    glide((e) => setAsked({ k: from.k ** (1 - e), x: from.x * (1 - e), y: from.y * (1 - e) }));
  };
  const resetCamera = () => {
    const from = camera;
    glide((e) => setCamera(cameraBetween(from, HOME_VIEW, e)));
  };
  const keys = useRef({ zoomBy, goHome });
  keys.current = { zoomBy, goHome };

  // A tour (?tour=, orbits3dTour.ts) plays from when the map opens, on the glide's frames, so any turn, zoom or pan
  // stops it as it stops a glide; under reduced motion the view goes straight to where its lean ends.
  useEffect(() => {
    const tour = tourOf(window.location.search);
    if (!tour) return;
    const end = tour.hold + Math.max(tour.move, tour.push);
    const show = (t: number) => {
      const { camera, k } = tourAt(tour, t);
      setCamera(camera);
      setAsked({ k, x: 0, y: 0 });
    };
    if (reduced) return show(end);
    const start = performance.now();
    const tick = (now: number) => {
      show(now - start);
      // A tour that drifts on plays until stopped; one that does not is done once it lands.
      if (tour.drift !== 0 || now - start < end) motion.current.glide = requestAnimationFrame(tick);
    };
    motion.current.glide = requestAnimationFrame(tick);
    return stopGlide;
  }, []);

  // Someone picked in the find box is brought into view, zoomed in far enough to read their identicon, unless
  // they are in view at that already, and kept in view as the map changes size until you zoom or pan.
  useEffect(() => {
    finding.current = find?.id ?? null;
  }, [find]);
  useEffect(() => {
    const id = finding.current;
    const p = id === null ? undefined : targets.placed.get(id);
    if (id === null || !p) return;
    const f = targets.frames.get(id)!;
    const least = f.silent ? 1 : READABLE / f.size;
    const view = { left: FIND_MARGIN - cx, right: width - FIND_MARGIN - cx, top: top + FIND_MARGIN - cy, bottom: height - FIND_MARGIN - cy };
    const to = zoomToShow(zoom, drawnAt(camera, p.x, p.y, restHeights.get(id)!, 1), least, view, extent);
    if (to === zoom) return;
    const from = zoom;
    glide((e) => setAsked(zoomBetween(from, to, e)));
  }, [find, targets, width, height, top]);

  useEffect(() => {
    const el = wrapRef.current!;
    const zoomTo = (factor: number, event: { clientX: number; clientY: number }) => {
      stopGlide();
      finding.current = null;
      if (live.current.hovering) live.current.unhover();
      const { extent: reach, origin: o } = live.current;
      const box = el.getBoundingClientRect();
      const about = { x: event.clientX - box.left - o.x, y: event.clientY - box.top - o.y };
      setAsked((z) => zoomAt(clampZoom(z, reach), factor, about, reach));
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomTo(wheelFactor(event), event);
    };
    // Safari sends a trackpad pinch as gesture events, with the scale since it began, rather than as the wheel.
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    let pinched = 1;
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
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      window.removeEventListener("keydown", onKey);
      stopGlide();
      clearTimeout(touch.current.peek);
    };
  }, []);

  const drag = useRef<{ x: number; y: number; from: Zoom; moved: boolean } | null>(null);
  const turning = useRef<{ x: number; y: number; from: Camera } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragged = useRef(false);
  const fromOrigin = (finger: { clientX: number; clientY: number }) => {
    const box = wrapRef.current!.getBoundingClientRect();
    return { x: finger.clientX - box.left - cx, y: finger.clientY - box.top - cy };
  };
  const twoFingers = (): Fingers => {
    const [a, b] = [...touch.current.fingers.values()];
    return [fromOrigin(a), fromOrigin(b)];
  };
  const touchDown = (event: ReactPointerEvent<HTMLDivElement>) => {
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
      fingers.pinch = { from: zoom, fromCamera: camera, start: twoFingers(), last: zoom };
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
  /** Two fingers pinch (and pan sideways), twist to turn the sky and drag up or down to tilt it, all at once. */
  const twoFingerMove = () => {
    const pinch = touch.current.pinch!;
    const now = twoFingers();
    // The fingers' rise or fall tilts rather than pans: for the zoom, they are as high as they started.
    const risen = (now[0].y + now[1].y - pinch.start[0].y - pinch.start[1].y) / 2;
    const level: Fingers = [{ x: now[0].x, y: now[0].y - risen }, { x: now[1].x, y: now[1].y - risen }];
    setCamera(twistCamera(pinch.fromCamera, pinch.start as CameraFingers, now as CameraFingers));
    setAsked((pinch.last = pinchZoom(pinch.from, pinch.start, level, extent)));
  };
  const endTurn = () => {
    if (!turning.current) return false;
    turning.current = null;
    dragged.current = true;
    setDragging(false);
    return true;
  };

  // What lies in the sun's plane, drawn beneath the spheres: the rings, whoever is picked out's own orbit, the
  // lines to the people they share group chats with, and the comet trails; and, above, the text.
  const focusPerson = focusId === null ? null : model.people.find((p) => p.id === focusId) ?? null;
  const ellipse = (r: number) => ringAxes(camera, r * k);
  const ground = (
    <g transform={`translate(${sun.x} ${sun.y})`}>
      <g className="orbits__rings">
        {rings(count).map((ring) => {
          const { rx, ry } = ellipse(orbitRadius(ring.rank, inner, outer, count, together.length));
          return <ellipse key={ring.label} rx={rx} ry={ry} style={{ stroke: ringColours(ring.rank).line }} />;
        })}
        {focusPerson && !aspiring.has(focusPerson.id) && frames.get(focusPerson.id)!.opacity > 0 && (() => {
          const { rx, ry } = ellipse(frames.get(focusPerson.id)!.r);
          return <ellipse className="orbits__own-ring" rx={rx} ry={ry} />;
        })()}
      </g>
      <g className="orbits__links">
        {focusLinks.map((link) => {
          const other = link.source === focusPerson!.id ? link.target : link.source;
          if (!frames.has(other) || frames.get(other)!.opacity === 0) return null;
          const a = place(focusPerson!.id);
          const b = place(other);
          return <line key={other} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={Math.min(2.2, 0.5 + link.weight * 2.5)} />;
        })}
      </g>
      <g className="orbits__trails">
        {drawn.map((person) => {
          const f = frames.get(person.id)!;
          if (f.opacity <= 0.01 || f.silent) return null;
          const from = trailFrom.get(person.id);
          if (from == null) return null;
          const lit = person.id === focusId;
          const size = sized(person.id);
          const minShift = lit ? size + 4 : Math.max(size + 4, (outer - inner) * k * TRAIL_SHOWN);
          const trail = displacementTrail({ angle: f.angle, r: f.r * k }, from * k, { width: size * 1.15, minShift });
          if (!trail) return null;
          // The head rises to the person's height; the tail lies in the plane.
          const h = heightNow(person.id);
          const [head, tail, side] = trail.outline;
          const q = (p: [number, number], at: number) => drawnAt(camera, p[0] / k, p[1] / k, at, k);
          const points = [q(head, h), q(tail, 0), q(side, h)];
          const { x, y } = place(person.id);
          const t = q(trail.tail, 0);
          const id = `orbits-3d-trail-${person.id}`;
          const color = from > f.r ? COLORS.warm : COLORS.cool;
          return (
            <g key={person.id} opacity={f.opacity * arrived(person.id) * (lit ? 0.95 : 0.32 * strength(person.id))}>
              <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={x} y1={y} x2={t.x} y2={t.y}>
                <stop offset="0" stopColor={color} stopOpacity="0.9" />
                <stop offset="1" stopColor={color} stopOpacity="0" />
              </linearGradient>
              <path d={`M${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L")}Z`} fill={`url(#${id})`} />
            </g>
          );
        })}
      </g>
      {/* Aspiring friends, out in the plane: thought bubbles (Bubble), as on Orbits 2D. */}
      <g>
        {drawn.map((person) => {
          const f = frames.get(person.id)!;
          if (!aspiring.has(person.id) || f.opacity <= 0.01) return null;
          const { x, y } = place(person.id);
          return <Bubble key={person.id} person={person} x={x} y={y} r={sized(person.id)} colour={person.id === focusId ? COLORS.star : glowColours.get(person.id)!} opacity={f.opacity * strength(person.id)} />;
        })}
      </g>
    </g>
  );
  const sq = squash(camera);
  const text = (
    <g transform={`translate(${sun.x} ${sun.y})`}>
      {!photoLoaded && <text className="orbits__you" y={4.5} textAnchor="middle">you</text>}
      <g className="orbits__rings">
        {rings(count).map((ring) => (
          <text key={ring.label} y={-orbitRadius(ring.rank, inner, outer, count, together.length) * k * sq + 3.5} textAnchor="middle" style={{ fill: ringColours(ring.rank).label }}>{ring.label}</text>
        ))}
      </g>
      {/* Orbits' flat names, from straight above; they fade out as the names move into the scene (inScene). */}
      {inScene < 1 && (
        <g>
          {labels.map((label) => {
            const { x, y } = place(label.id);
            const shine = glowShown(label.id, glowing) ? frames.get(label.id)!.glow : 0;
            const { style, pulsing } = nameStyle(glowColours.get(label.id)!, shine, reachGlow, glow.pulse);
            return (
              <text
                key={label.id}
                className={`orbits__name${label.scale < 1 ? " orbits__name--minor" : ""}${label.id === focusId ? " orbits__name--focus" : ""}${pulsing ? " orbits__name--pulse" : ""}`}
                x={x + label.dx}
                y={y + label.dy}
                textAnchor={label.anchor}
                style={style}
                opacity={labelOpacity(label) * (1 - inScene)}
              >
                {nameOf(model.people, label.id, names.mapLabel)}
              </text>
            );
          })}
        </g>
      )}
    </g>
  );

  const style = { width, height };
  const atHome = camera.bearing === HOME_VIEW.bearing && camera.tilt === HOME_VIEW.tilt;
  return (
    <>
      <div
        ref={wrapRef}
        className="orbits-3d"
        style={{ ...style, cursor: dragging ? "grabbing" : hoverId !== null ? "pointer" : k > 1 ? "grab" : undefined }}
        onPointerDown={(event) => {
          dragged.current = false;
          touch.current.used = event.pointerType === "touch";
          if (event.pointerType === "touch") return touchDown(event);
          if (event.button === 1 || event.button === 2 || event.ctrlKey) {
            // The middle button would scroll the page; Ctrl with the left is the right button on a Mac, and opens a menu.
            event.preventDefault();
            stopGlide();
            finding.current = null;
            if (hoverId !== null) unhover();
            turning.current = { x: event.clientX, y: event.clientY, from: camera };
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setDragging(true);
            return;
          }
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
              if (fingers.fingers.size === 2) twoFingerMove();
              return;
            }
          }
          const turn = turning.current;
          if (turn) {
            setCamera(turnCamera(turn.from, event.clientX - turn.x, event.clientY - turn.y));
            return;
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
            setAsked(panBy(pan.from, dx, dy, extent));
            return;
          }
          if (event.pointerType === "touch") return;
          const person = pick(event);
          if (onSun !== (!person && overSun(event))) setOnSun(!onSun);
          if (person) card(person, event);
          else if (hoverId !== null) unhover();
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
          if (endTurn()) return;
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
          endTurn();
          drag.current = null;
          setDragging(false);
        }}
        onPointerLeave={() => {
          if (!drag.current && !turning.current) unhover();
          setOnSun(false);
        }}
        onContextMenu={(event) => event.preventDefault()}
        onClick={(event) => {
          if (dragged.current) return;
          const person = touch.current.used ? pick(event, TOUCH_REACH) : pick(event);
          if (person) open(person);
          // A finger has no hover: a tap on the sun shows its buttons, and a tap anywhere else hides them.
          if (touch.current.used) setOnSun(!person && overSun(event) && !onSun);
        }}
      >
        <svg className="orbits-3d__ground" width={width} height={height} aria-hidden>{ground}</svg>
        <canvas ref={canvasRef} className="orbits-3d__sky" style={style} role="img" aria-label={`A solar system of ${number(count)} people round you`} />
        <svg className="orbits-3d__text" width={width} height={height} aria-hidden>{text}</svg>
        {noGl && <p className="orbits-3d__status">Orbits needs WebGL 2, which this browser does not offer.</p>}
      </div>
      <SunControls x={sun.x} y={sun.y} inner={inner} photo={me.photo} shown={onSun} onPhoto={me.setPhoto} />
      <Compass
        camera={camera}
        home={atHome}
        onReset={resetCamera}
        homeTitle="Straight down, north up: Orbits as it is. Drag with the middle or right button, or with Ctrl held, to turn and tilt the sky into a solar system (two fingers twist or drag up and down on a touch screen)"
        backTo="straight down, north up"
      />
    </>
  );
}
