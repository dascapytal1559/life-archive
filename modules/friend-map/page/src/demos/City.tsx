// City, at /city: Orbits' closeness as a cyberspace city at night after rain,
// in the manner of Tron: Ares. Your tower stands in the middle, a monumental
// form with a core of cyan light; whoever you live with has a lit floor in
// it; everyone else is a building of dark stepped forms round it, edged in
// thin cyan light, nearer the tower the closer they are, by closeness rank on
// the scale Orbits uses, with ring roads (avenues) round the closest 10, 25,
// 50 and so on and four boulevards running out from the tower. A building's
// height is their closeness score, its footprint how much you have talked,
// both tapering away past the closest few hundred to the lights of the far
// outskirts, and the light along its edges is brightest for the closest and
// fainter tier by tier as on Orbits. The ground is wet: it mirrors the light,
// and mist drifts through the streets. Names stand over the roofs once a roof
// is big enough on the screen to carry one, of as many of the closest as the
// City's Show top names says (topNames.ts). A beam of light rises over
// everyone you should reach out to, and light runs along the roads to the
// tower from everyone you have talked with this week. Hovering a building
// shows their card, clicking opens their panel, and whoever's panel is open
// stays picked out with arcs of light to the people they share group chats
// with. It zooms and pans as Orbits does (the wheel or a pinch, a drag, the
// + − 0 keys), and the camera turns and tilts like Google Maps' (cityCamera.ts:
// a drag with the middle or right button or with Ctrl held, two fingers
// twisted or dragged up and down, and a compass to put it back); left alone,
// it drifts slowly round the city. The geometry is in cityLayout.ts, the
// camera and the forms in cityScene.ts, the drawing in cityGl.ts (WebGL 2).

import { easeCubicInOut, easeCubicOut } from "d3";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { livesTogether } from "../archive.ts";
import { useNames } from "../names.ts";
import { twistCamera, turnCamera, type Camera } from "./cityCamera.ts";
import { CityGl, CYAN, KIND, Lines, NoWebGl, WHITE_CYAN, type Building, type FloorLight, type Label } from "./cityGl.ts";
import { layoutCity, taper, TAPER_KNEE, traffic, type Plot } from "./cityLayout.ts";
import {
  avenueLabels, avenuesFor, clampRig, declutter, driftSpeed, easeRig, floorAt, formOf, groundAt, TOWER_SCALE, homeCamera, homeDistance, homeRig, INNER, introRig,
  matricesOf, nameReadable, nearestFoot, nextScale, OUTER, panRig, pickAlong, pixelsPerUnit, plazaRing, project, qualityFor, rayAt, reachOf, rigBetween, rigsClose,
  rigShowing, routeOf, stretchOf, TILT_MOST, towerForms, TRAFFIC_SPEED, TRAFFIC_TAIL, zoomRig, type Form, type NameBox, type Rig, type Vec3, type View, type XY,
} from "./cityScene.ts";
import { scoreLabel } from "./closeness.ts";
import { Compass } from "./Compass.tsx";
import { Curve } from "./Curve.tsx";
import { standing, trendAt, type DemoPerson } from "./model.ts";
import { focusLinksOf, focusOf, heldOnly, PHONE } from "./Orbits.tsx";
import { NameAtlas, nameKey, type NameLook, type NameSlot } from "./orbits3dNames.ts";
import { BACKGROUND, personOpacity, TIER_FLOOR, TIERS } from "./orbitsLayout.ts";
import { nameStrengthOf, useNameFade } from "./nameFade.ts";
import { wheelFactor, ZOOM_STEP } from "./orbitsZoom.ts";
import { glowLook, glowShown, glowsOf, useReachGlow } from "./reachGlow.ts";
import { ringShare } from "./ringColours.ts";
import { trendSummary, windowLabel } from "./trend.ts";
import { ALL, amongTop, useTopNames } from "./topNames.ts";
import { basicRows, fieldRows, Legend, number, Swatch, tipAt, type Demo, type ViewProps } from "./view.tsx";
import "./city.css";

/** Light runs along the roads from everyone you have talked with in the last this many days. */
export const TRAFFIC_DAYS = 7;
/** The most roads with light on them: the most recent. */
const TRAFFIC_MOST = 80;
/** A beacon's pulse, in seconds. */
const BEACON_S = 2.4;
/** How long a building takes to rise out of the ground when the city first appears, and how much later the furthest starts, in seconds. */
const RISE_S = 1.1;
const RISE_STAGGER_S = 0.9;
/** How long the opening push in takes, in seconds. */
const INTRO_S = 3.4;
/** How quickly the camera follows: the wheel and the keys, a drag, and a glide (the compass, 0, the find box), as time constants in seconds. */
const FOLLOW = { wheel: 0.085, drag: 0.03, glide: 0.16 } as const;
/** How far in from the edges, in pixels, someone found with the find box counts as in view. */
const FIND_MARGIN = 60;
/** How far, in pixels, a mouse or a finger moves before a press is a drag. */
const DRAG_START = { mouse: 3, touch: 10 };
/** How long a finger held on someone takes to show their card, in ms. */
const HOLD_MS = 400;
/** How near, in pixels, the pointer (or a finger, further) must come to a small building's foot to pick it. */
const REACH = { mouse: 12, touch: 24 };
/** The type of the names, the tower's "you" and the avenue labels. */
const SIGN_FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
/** The names' colours: a pale cyan, white for whoever is picked out, the avenues' dimmer, and the glow of someone to reach out to. */
const SIGN = { name: "#cdf3ff", picked: "#ffffff", avenue: "#5fc4d8", you: "#bdf4ff", glow: "#4de3ff" } as const;

/** The camera, kept while the page is open, so switching views and back keeps it: turned, tilted, where it looks and how far in (as a zoom). */
export const keptRig: { current: { bearing: number; tilt: number; x: number; y: number; k: number } | null } = { current: null };

/**
 * Whose roof may carry their name (`rank` their closeness rank, 0 for none yet): the closest `named` (the City's Top
 * names, topNames.ts), everyone to reach out to, and everyone who shares group chats with whoever is held
 * (`heldLinks`); with All, everyone.
 */
export function roofNamed(id: number, rank: number, { named, reachOut, heldLinks }: { named: number; reachOut: ReadonlySet<number>; heldLinks: ReadonlySet<number> }): boolean {
  return named === ALL || amongTop(rank, named) || reachOut.has(id) || heldLinks.has(id);
}

/** A name to place each frame: where it stands, its slot in the atlas, how strongly, and whether its building's size decides it (`foot`, its half side). */
interface Sign {
  key: string;
  at: (rise: (id: number) => number, eye: Vec3) => Vec3;
  foot: number | null;
  strength: number;
  always: boolean;
  bias: number;
  /** Whether the text stands above its spot (a roof, the spire) or is centred on it (a floor, an avenue). */
  above: boolean;
  /** Which names win where two would meet: the lowest first (the avenues, then the closest); `always` ones before all. */
  rank: number;
}

export function CityMap({ model, width, height, inset: top, hover, open, held = null, heldGroup = null, find = null }: ViewProps) {
  const at = model.months.length - 1;
  const names = useNames();
  // How many of the closest have their names over their roofs: the City's own Show top names (topNames.ts).
  const named = useTopNames("city");
  const phone = useMedia(PHONE);
  const reduced = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, []);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const count = model.people.length;
  const view: View = useMemo(() => ({ width, height, top }), [width, height, top]);

  const residents = useMemo(
    () => model.people.map((p) => ({ id: p.id, name: p.name, rank: p.rank[at] ?? 0, closeness: p.closeness[at] ?? 0, total: p.total, together: livesTogether(p) })),
    [model.people, at],
  );
  // The city is laid out at one size on every screen; the camera frames it.
  const layout = useMemo(() => layoutCity(residents, { inner: INNER, outer: OUTER }), [residents]);
  const forms = useMemo(() => new Map([...layout.plots.values()].map((plot) => [plot.id, formOf(plot)])), [layout]);
  const tower = useMemo(() => towerForms(layout), [layout]);
  const byId = useMemo(() => new Map(model.people.map((p) => [p.id, p])), [model.people]);
  const standings = useMemo(() => new Map(model.people.map((p) => [p.id, standing(p, at, model)])), [model, at]);
  const reachOut = useMemo(() => new Set(model.people.filter((p) => p.shouldReachOut).map((p) => p.id)), [model.people]);
  // How strongly their beacons shine (reachGlow.ts), as the other views' glows: their beam taller and brighter, their ring wider.
  const reachGlow = useReachGlow();
  const glow = useMemo(() => glowLook(reachGlow), [reachGlow]);
  const streams = useMemo(
    () => traffic(model.people.map((p) => ({ id: p.id, daysSince: standings.get(p.id)!.daysSince })), TRAFFIC_DAYS)
      .sort((a, b) => (standings.get(a.id)!.daysSince ?? 0) - (standings.get(b.id)!.daysSince ?? 0) || a.id - b.id)
      .slice(0, TRAFFIC_MOST),
    [model.people, standings],
  );
  const routes = useMemo(
    () => new Map(streams.flatMap((s) => (layout.plots.has(s.id) ? [[s.id, routeOf(layout.plots.get(s.id)!, layout, s.phase)] as const] : []))),
    [streams, layout],
  );

  // Who is picked out: whoever's panel is open, else the person under the pointer; their group-chat links.
  const focusId = focusOf(hoverId, held, (id) => layout.plots.has(id) || layout.together.includes(id));
  const focusLinks = useMemo(() => focusLinksOf(model, focusId, held, heldGroup), [model, focusId, held, heldGroup]);
  const linked = useMemo(() => new Set(focusLinks.map((l) => (l.source === focusId ? l.target : l.source))), [focusLinks, focusId]);
  // While someone is held, only they and their links have beams, and nobody under No name except… (glowsOf), as the
  // other views glow.
  const glowing = useMemo(() => glowsOf(heldOnly(held, focusId, linked), names.hidden), [held, focusId, linked, names.hidden]);
  const strength = (id: number, rank: number) =>
    focusId === null ? personOpacity(rank > 0 ? rank : null, reachOut.has(id), { lift: glow.lift }) : id === focusId ? 1 : linked.has(id) ? 0.7 : BACKGROUND;
  // How strongly a name is drawn: by how names fade (nameFade.ts), as its building until the Names settings are moved.
  const fade = useNameFade();
  const nameStrength = (id: number, rank: number) => nameStrengthOf(id, rank > 0 ? rank : null, focusId, linked, fade);
  const rankOf = (id: number) => byId.get(id)?.rank[at] ?? 0;

  // The camera: where it is drawn from (`shown`), where it is heading (`goal`), and how quickly it follows.
  const home = useMemo(() => homeDistance(layout, view), [layout, view]);
  const reach = useMemo(() => reachOf(layout), [layout]);
  const cam = useRef<{ shown: Rig; goal: Rig; follow: number; input: number; intro: { start: number; from: Rig; to: Rig } | null } | null>(null);
  if (cam.current === null) {
    const kept = keptRig.current;
    const start = kept ? clampRig({ ...kept, distance: home / kept.k }, home, reach) : homeRig(home, view);
    // The first time the City opens on a page, the camera pushes in from further out as the city rises.
    const intro = !kept && !reduced ? { start: 0, from: introRig(start), to: start } : null;
    cam.current = { shown: intro ? intro.from : start, goal: start, follow: 0, input: 0, intro };
  }
  // The compass reads the camera, kept a little behind it as it drifts.
  const [compass, setCompass] = useState<Camera>(() => ({ bearing: cam.current!.shown.bearing, tilt: cam.current!.shown.tilt }));

  // The city rises out of the ground when it first appears: 0 to 1 per building, the nearest first.
  const riseStart = useRef(0);
  const risen = useRef(reduced);
  const delayOf = (plot: Plot) => (RISE_STAGGER_S * Math.max(0, plot.r - INNER)) / Math.max(1, OUTER - INNER);
  const riseOf = (id: number, seconds: number): number => {
    if (risen.current) return 1;
    const plot = layout.plots.get(id);
    if (!plot) return 1;
    return easeCubicOut(Math.min(1, Math.max(0, (seconds - delayOf(plot)) / RISE_S)));
  };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<CityGl | null>(null);
  const [failed, setFailed] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const atlas = useRef(new NameAtlas());
  const signs = useRef<{ list: Sign[]; slots: Map<string, NameSlot> }>({ list: [], slots: new Map() });
  const lines = useRef(new Lines());
  const quality = useMemo(() => qualityFor(phone, window.devicePixelRatio || 1), [phone]);

  // Drawing: a frame whenever anything moves (always, but with reduced motion only when something changed).
  const loop = useRef<{ raf: number; last: number; frames: number[]; scaleAt: number; compassAt: number }>({ raf: 0, last: 0, frames: [], scaleAt: 0, compassAt: 0 });
  const tick = useRef<(now: number) => void>(() => {});
  const invalidate = () => {
    if (loop.current.raf === 0) loop.current.raf = requestAnimationFrame((now) => tick.current(now));
  };

  // The renderer, made once (and again if the GPU drops it), sized to the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let gl: CityGl;
    try {
      gl = new CityGl(canvas, quality);
    } catch (error) {
      if (error instanceof NoWebGl) setFailed(true);
      else throw error;
      return;
    }
    glRef.current = gl;
    const lost = (event: Event) => {
      event.preventDefault();
      glRef.current = null;
    };
    const restored = () => setEpoch((e) => e + 1);
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    return () => {
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      gl.dispose();
      glRef.current = null;
    };
  }, [quality, epoch]);

  // What the city is made of: everyone's building and your tower, and the roads.
  const order = useMemo(() => [...layout.plots.keys()], [layout]);
  useEffect(() => {
    const gl = glRef.current;
    if (!gl) return;
    const buildings: Building[] = order.map((id) => ({ form: forms.get(id)!, kind: KIND.building, delay: delayOf(layout.plots.get(id)!) }));
    buildings.push({ form: tower.podium, kind: KIND.podium, delay: 0 }, { form: tower.shaft, kind: KIND.shaft, delay: 0 });
    gl.setBuildings(buildings);
    gl.setGround({ avenues: layout.avenues.map((a) => ({ r: a.r, glow: 1.5 - 0.8 * ringShare(a.rank) })), plaza: plazaRing() });
    invalidate();
  }, [layout, forms, tower, order, quality, epoch]);

  // How each building is lit: by its tier, dimmed for whoever is not picked out.
  useEffect(() => {
    const gl = glRef.current;
    if (!gl) return;
    const lights = order.map((id) => {
      const plot = layout.plots.get(id)!;
      return { strength: strength(id, plot.rank), picked: id === focusId, silent: plot.silent };
    });
    lights.push({ strength: 1, picked: false, silent: false }, { strength: 1, picked: false, silent: false });
    gl.setLights(lights);
    invalidate();
  }, [layout, order, focusId, linked, reachOut, glow, quality, epoch]);

  // The names: who is named, how each is drawn into the atlas, and where each stands.
  useEffect(() => {
    const gl = glRef.current;
    if (!gl) return;
    const unnamed = names.style === "hide";
    const label = (id: number) => (unnamed ? "" : names.mapLabel(byId.get(id)!).primary);
    const heldLinks: ReadonlySet<number> = held !== null && focusId === held ? linked : new Set();
    const looks: NameLook[] = [];
    const list: Sign[] = [];
    const look = (text: string, colour: string, bold: boolean, scale = 1, lit = false): string => {
      const l: NameLook = { text, colour, scale, bold, glow: lit ? SIGN.glow : null, boost: lit ? reachGlow : 0 };
      looks.push(l);
      return nameKey(l);
    };
    for (const id of order) {
      const plot = layout.plots.get(id)!;
      const form = forms.get(id)!;
      const text = label(id);
      const picked = id === focusId;
      const str = nameStrength(id, plot.rank);
      if (!text || (phone && !picked) || (!picked && (str <= 0 || !roofNamed(id, plot.rank, { named, reachOut, heldLinks })))) continue;
      list.push({
        key: look(text, picked ? SIGN.picked : SIGN.name, picked, 1, reachOut.has(id) && glowShown(id, glowing)),
        at: (rise) => [form.x, form.h * rise(id) + 1.5, form.z],
        foot: picked ? null : form.half,
        strength: picked ? 1 : str,
        always: picked,
        bias: form.half * 1.6 + 2,
        above: true,
        rank: plot.rank > 0 ? plot.rank : Infinity,
      });
    }
    // Each floor's name beside the tower, on the side the camera sees, at the floor's middle.
    const beside = tower.shaft.half * 1.5;
    for (const floor of unnamed ? [] : layout.tower.floors) {
      const text = label(floor.id);
      const picked = floor.id === focusId;
      if (!text || (phone && !picked)) continue;
      const mid = ((floor.bottom + floor.top) / 2) * TOWER_SCALE;
      list.push({
        key: look(text, picked ? SIGN.picked : SIGN.name, picked, 1, reachOut.has(floor.id) && glowShown(floor.id, glowing)),
        at: (_rise, eye) => {
          const d = Math.hypot(eye[0], eye[2]) || 1;
          return [(eye[0] / d) * beside, mid, (eye[2] / d) * beside];
        },
        foot: null,
        strength: picked ? 1 : nameStrength(floor.id, rankOf(floor.id)),
        always: picked,
        bias: 4,
        above: false,
        rank: rankOf(floor.id) || Infinity,
      });
    }
    // "you" over the spire, and the avenues' names where they cross the south boulevard.
    list.push({ key: look("you", SIGN.you, true), at: () => [0, tower.shaft.h + 4, 0], foot: null, strength: 1, always: true, bias: 0, above: true, rank: 0 });
    for (const a of avenueLabels(layout)) {
      list.push({ key: look(a.label, SIGN.avenue, false, 0.8), at: () => [a.at[0], 0.6, a.at[2]], foot: null, strength: 0.85, always: false, bias: 3, above: false, rank: 0 });
    }
    // The most important first, for decluttering: "you" and whoever is picked out, then the avenues, then the closest.
    list.sort((a, b) => Number(b.always) - Number(a.always) || a.rank - b.rank);
    const built = atlas.current.build(looks, Math.min(window.devicePixelRatio || 1, quality.pixelRatio), SIGN_FONT);
    gl.setAtlas(built.canvas);
    signs.current = { list, slots: built.slots };
    invalidate();
  }, [layout, order, forms, tower, names, named, phone, focusId, linked, held, reachOut, fade, glow, reachGlow, glowing, quality, epoch]);

  const live = useRef({ layout, forms, streams, routes, focusId, focusLinks, glowing, reachOut, glow, view, home, hoverId, strength, rankOf, riseOf });
  live.current = { layout, forms, streams, routes, focusId, focusLinks, glowing, reachOut, glow, view, home, hoverId, strength, rankOf, riseOf };
  const dragging = useRef(false);
  tick.current = (now: number) => {
    const state = loop.current;
    state.raf = 0;
    const gl = glRef.current;
    const c = cam.current!;
    if (!gl) return;
    if (riseStart.current === 0) riseStart.current = now;
    const dt = state.last === 0 ? 1 / 60 : Math.min(0.1, (now - state.last) / 1000);
    state.last = now;
    const L = live.current;
    const seconds = (now - riseStart.current) / 1000;
    const clock = reduced ? 0 : seconds;
    if (!risen.current && seconds > RISE_S + RISE_STAGGER_S + 0.1) risen.current = true;

    // The camera: the opening push in, else following its goal; left alone (and nobody under the pointer), drifting round.
    if (c.intro) {
      if (c.intro.start === 0) c.intro.start = now;
      const p = Math.min(1, (now - c.intro.start) / (INTRO_S * 1000));
      c.shown = rigBetween(c.intro.from, c.intro.to, easeCubicInOut(p));
      c.goal = c.shown;
      c.input = now;
      if (p >= 1) c.intro = null;
    } else {
      const spin = reduced || L.hoverId !== null || dragging.current ? 0 : driftSpeed(now - c.input);
      if (spin > 0) {
        c.goal = { ...c.goal, bearing: c.goal.bearing + spin * dt };
        c.follow = FOLLOW.drag;
      }
      c.shown = easeRig(c.shown, c.goal, dt, reduced ? 0 : c.follow);
    }
    const rig = c.shown;
    if (now - state.compassAt > 120 || rigsClose(rig, c.goal)) {
      state.compassAt = now;
      setCompass((old) => (Math.abs(old.bearing - rig.bearing) > 0.002 || Math.abs(old.tilt - rig.tilt) > 0.002 ? { bearing: rig.bearing, tilt: rig.tilt } : old));
      keptRig.current = { bearing: rig.bearing, tilt: rig.tilt, x: rig.x, y: rig.y, k: L.home / rig.distance };
    }

    const m = matricesOf(rig, L.view);
    const eye = m.eye;
    const rise = (id: number) => L.riseOf(id, seconds);
    const out = lines.current;
    out.clear();
    const lift = 0.3;
    const roofOf = (id: number): Vec3 | null => {
      const form = L.forms.get(id);
      if (form) return [form.x, form.h * rise(id) + 0.5, form.z];
      const floor = L.layout.tower.floors.find((f) => f.id === id);
      return floor ? [0, ((floor.bottom + floor.top) / 2) * TOWER_SCALE, 0] : null;
    };

    // Light along the roads to the tower from everyone talked with this week.
    for (const stream of L.streams) {
      const route = L.routes.get(stream.id);
      const plot = L.layout.plots.get(stream.id);
      if (!route || !plot) continue;
      const str = L.strength(stream.id, plot.rank);
      if (L.focusId !== null && str <= BACKGROUND) continue;
      const loopLength = route.length + TRAFFIC_TAIL;
      const head = (((clock * TRAFFIC_SPEED) / loopLength + stream.phase) % 1) * loopLength;
      const pts = stretchOf(route, head - TRAFFIC_TAIL, head);
      if (pts.length < 2) continue;
      const tip = pts[pts.length - 1];
      const along = (s: XY) => (1 - Math.min(1, Math.hypot(s.x - tip.x, s.y - tip.y) / TRAFFIC_TAIL)) ** 2;
      const bright = 1.1 + 2.2 * str;
      for (let i = 1; i < pts.length; i++) out.add([pts[i - 1].x, lift, pts[i - 1].y], [pts[i].x, lift, pts[i].y], CYAN.map((v) => v * bright), along(pts[i - 1]), along(pts[i]), 1.7);
      if (head <= route.length) {
        const before = pts[pts.length - 2];
        out.add([before.x, lift, before.y], [tip.x, lift, tip.y], WHITE_CYAN.map((v) => v * (2 + 3 * str)), 0, 1, 3);
      }
    }

    // Arcs of light from whoever is picked out to the people they share group chats with.
    const from = L.focusId === null ? null : roofOf(L.focusId);
    if (from) {
      for (const link of L.focusLinks) {
        const to = roofOf(link.source === L.focusId ? link.target : link.source);
        if (!to) continue;
        const span = Math.hypot(to[0] - from[0], to[2] - from[2]);
        const apex = Math.max(from[1], to[1]) + 8 + span * 0.18;
        const mid: Vec3 = [(from[0] + to[0]) / 2, 2 * apex - (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
        const point = (s: number): Vec3 => {
          const u = 1 - s;
          return [0, 1, 2].map((k) => u * u * from[k] + 2 * u * s * mid[k] + s * s * to[k]) as Vec3;
        };
        const flow = (s: number) => (reduced ? 1 : 0.65 + 0.35 * Math.sin(s * 14 - clock * 3.2));
        const strong = 0.3 + 2 * Math.min(1, link.weight * 2);
        const steps = 24;
        for (let i = 0; i < steps; i++) out.add(point(i / steps), point((i + 1) / steps), WHITE_CYAN.map((v) => v * strong), flow(i / steps), flow((i + 1) / steps), 1.2);
      }
    }

    // A beam of light over everyone to reach out to, and a ring spreading on the roof; a floor of the tower pulses whole.
    const floors: FloorLight[] = L.layout.tower.floors.map((f) => ({
      bottom: f.bottom * TOWER_SCALE, top: f.top * TOWER_SCALE, strength: L.strength(f.id, L.rankOf(f.id) || 1), picked: f.id === L.focusId, glow: 0,
    }));
    const breathe = 1 + 0.3 * L.glow.pulse * (reduced ? 0 : Math.sin((clock / 2.4) * 2 * Math.PI));
    for (const id of L.reachOut) {
      if (!glowShown(id, L.glowing)) continue;
      const phase = ((id * 0.7548776662) % 1 + 1) % 1;
      const p = reduced ? 0.5 : (((clock / BEACON_S + phase) % 1) + 1) % 1;
      const form = L.forms.get(id);
      if (!form) {
        const i = L.layout.tower.floors.findIndex((f) => f.id === id);
        if (i >= 0) floors[i].glow = (0.5 + 0.5 * Math.sin(p * 2 * Math.PI)) * L.glow.bright;
        continue;
      }
      const str = L.strength(id, L.layout.plots.get(id)!.rank);
      if (L.focusId !== null && str <= BACKGROUND) continue;
      const roof = form.h * rise(id);
      const beam = (34 + 46 * L.glow.reach) * Math.max(0.6, Math.sqrt(form.half / 6));
      const b = L.glow.bright * str * breathe;
      out.add([form.x, roof + 0.5, form.z], [form.x, roof + beam, form.z], WHITE_CYAN.map((v) => v * 3.2 * b), 1, 0, 1.6);
      out.add([form.x, roof + 0.5, form.z], [form.x, roof + beam * 0.7, form.z], CYAN.map((v) => v * 0.55 * b), 1, 0, 8);
      const ring = form.half * form.scales[form.scales.length - 1] * 1.1 + (3 + 10 * L.glow.reach) * p;
      for (let i = 0; i < 28; i++) {
        const [a0, a1] = [(i / 28) * 2 * Math.PI, ((i + 1) / 28) * 2 * Math.PI];
        out.add([form.x + Math.cos(a0) * ring, roof + 0.6, form.z + Math.sin(a0) * ring], [form.x + Math.cos(a1) * ring, roof + 0.6, form.z + Math.sin(a1) * ring], CYAN.map((v) => v * 2.4 * b), 1 - p, 1 - p, 1.3);
      }
    }

    // The names: each where its building stands, as strong as its fade and its building's size on the screen allow, and
    // none over another (declutter: whoever is picked out and the closest keep theirs).
    const placed: Array<{ label: Label; box: NameBox }> = [];
    for (const sign of signs.current.list) {
      const slot = signs.current.slots.get(sign.key);
      if (!slot) continue;
      const spot = sign.at(rise, eye);
      const s = project(rig, L.view, spot);
      if (s.depth <= 0) continue;
      const alpha = sign.strength * (sign.foot === null ? 1 : nameReadable(2 * sign.foot * pixelsPerUnit(L.view, s.depth), 2 * slot.wide));
      if (alpha <= 0.01) continue;
      const dy = sign.above ? -(slot.tall + 2) : 0;
      placed.push({
        label: { at: spot, uv: slot.uv, wide: slot.wide, tall: slot.tall, dx: 0, dy, alpha, always: sign.always, bias: sign.bias },
        box: { x: s.x, y: s.y + dy, wide: slot.wide * 0.9, tall: slot.tall * 0.75 },
      });
    }
    const shown = declutter(placed.map((p) => p.box));
    const labels = placed.filter((_, i) => shown[i]).map((p) => p.label);

    const clip = { near: m.projection[14] / (m.projection[10] - 1), far: m.projection[14] / (m.projection[10] + 1) };
    gl.draw({
      view: m.view, projection: m.projection, eye, near: clip.near, far: clip.far, time: seconds, clock, rise: risen.current ? 0 : RISE_S,
      floors, lines: out, labels, still: rigsClose(rig, c.goal) && (reduced || driftSpeed(now - c.input) === 0), focus: rig.distance,
    });

    // The frame timer: fewer pixels where frames run slow, more again when there is room.
    if (!reduced) {
      state.frames.push(dt * 1000);
      if (state.frames.length > 90) state.frames.shift();
      if (now - state.scaleAt > 2000 && state.frames.length >= 60) {
        state.scaleAt = now;
        gl.setScale(nextScale(gl.scale, state.frames.reduce((s, f) => s + f, 0) / state.frames.length));
      }
    }
    if (!reduced || !risen.current || !rigsClose(c.shown, c.goal) || c.intro !== null) invalidate();
  };

  useEffect(() => {
    const gl = glRef.current;
    if (!gl) return;
    gl.resize(width, height, window.devicePixelRatio || 1);
    const c = cam.current!;
    c.shown = clampRig(c.shown, home, reach);
    c.goal = clampRig(c.goal, home, reach);
    invalidate();
  }, [width, height, home, reach, quality, epoch]);
  useEffect(() => () => {
    cancelAnimationFrame(loop.current.raf);
    loop.current.raf = 0;
  }, []);

  /** Moves the camera's goal, as the user asked, and how quickly it follows; drifting and the opening push stop. */
  const steer = (goal: Rig, follow: number) => {
    const c = cam.current!;
    c.intro = null;
    c.goal = clampRig(goal, home, reach);
    c.follow = follow;
    c.input = performance.now();
    invalidate();
  };
  /** The camera as drawn now, from which everything under the pointer is worked out. */
  const shown = () => cam.current!.shown;
  const local = (event: { clientX: number; clientY: number }): XY => {
    const box = wrapRef.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  // Picking: the building under the pointer, the front one where they overlap, or a floor of the tower; else the
  // nearest building's foot within `near` pixels, so the smallest are easy to catch.
  const pick = (event: { clientX: number; clientY: number }, near = REACH.mouse): DemoPerson | null => {
    const p = local(event);
    const rig = shown();
    const seconds = (performance.now() - riseStart.current) / 1000;
    const all: Form[] = [...forms.values(), tower.podium, tower.shaft];
    const hit = pickAlong(rayAt(rig, view, p.x, p.y), all, (form) => (form.id < 0 ? 1 : riseOf(form.id, seconds)));
    if (hit) {
      if (hit.id >= 0) return byId.get(hit.id) ?? null;
      const floor = hit.id === tower.shaft.id ? floorAt(layout, hit.at[1]) : null;
      return floor === null ? null : byId.get(floor) ?? null;
    }
    const id = nearestFoot(rig, view, forms.values(), p.x, p.y, near);
    return id === null ? null : byId.get(id) ?? null;
  };
  const card = (person: DemoPerson, event: { clientX: number; clientY: number; pointerType?: string }) => {
    if (hoverId !== person.id) setHoverId(person.id);
    const s = standings.get(person.id)!;
    const rank = person.rank[at];
    hover(tipAt(event, person, [
      ["Closeness", rank === 0 ? "none yet" : `#${number(rank)} of ${number(count)} (score ${scoreLabel(person.closeness[at])})`],
      ...fieldRows(person),
      ...basicRows(person, s),
      [windowLabel(model.settings.trendMonths), trendSummary(trendAt(person, at, model))],
    ]));
  };
  const unhover = () => {
    setHoverId(null);
    hover(null);
  };

  // Zooming and panning, as Orbits: the wheel or a trackpad pinch about the pointer, a drag of empty ground, + − 0
  // about the middle; on a touch screen two fingers pinch, one drags, a tap opens someone and a finger held on them
  // shows their card. Turning and tilting: a drag with the middle or right button or with Ctrl held, two fingers
  // twisted or dragged up and down; the compass puts the camera back.
  const zoomAbout = (factor: number, spot: XY | null) => {
    const goal = cam.current!.goal;
    const clamped = clampRig({ ...goal, distance: goal.distance / factor }, home, reach);
    const anchor = (spot && groundAt(goal, view, spot.x, spot.y)) ?? { x: goal.x, y: goal.y };
    steer(zoomRig(goal, goal.distance / clamped.distance, anchor), FOLLOW.wheel);
  };
  const ctl = useRef({ zoomAbout, home: () => {}, unhover, hovering: false });
  ctl.current = { zoomAbout, home: () => steer({ ...cam.current!.goal, x: 0, y: 0, distance: home }, FOLLOW.glide), unhover, hovering: hoverId !== null };
  const resetCamera = () => steer({ ...cam.current!.goal, ...homeCamera(view) }, FOLLOW.glide);

  // Someone picked in the find box is brought into view, close enough for their building to read.
  useEffect(() => {
    if (!find) return;
    const form = forms.get(find.id);
    const spot: Vec3 | null = form ? [form.x, form.h / 2, form.z] : layout.tower.floors.some((f) => f.id === find.id) ? [0, tower.shaft.h / 2, 0] : null;
    if (!spot) return;
    const wanted = form ? Math.max(form.h * 3.2, form.half * 26, home / 9) : home / 2;
    const c = cam.current!;
    const goal = rigShowing(c.goal, view, spot, wanted, FIND_MARGIN);
    if (goal !== c.goal) steer(goal, FOLLOW.glide);
  }, [find, layout, view]);

  const touch = useRef<{
    fingers: Map<number, { clientX: number; clientY: number }>;
    pinch: { from: Rig; start: [XY, XY] } | null;
    peek: ReturnType<typeof setTimeout> | undefined;
    peeking: boolean;
    used: boolean;
  }>({ fingers: new Map(), pinch: null, peek: undefined, peeking: false, used: false });

  useEffect(() => {
    const el = wrapRef.current!;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (ctl.current.hovering) ctl.current.unhover();
      ctl.current.zoomAbout(wheelFactor(event), local(event));
    };
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    let pinched = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      pinched = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (touch.current.fingers.size > 0) return;
      const gesture = event as Gesture;
      ctl.current.zoomAbout(gesture.scale / pinched, local(gesture));
      pinched = gesture.scale;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]")) return;
      if (event.key === "+" || event.key === "=") ctl.current.zoomAbout(ZOOM_STEP, null);
      else if (event.key === "-" || event.key === "_") ctl.current.zoomAbout(1 / ZOOM_STEP, null);
      else if (event.key === "0") ctl.current.home();
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
      clearTimeout(touch.current.peek);
    };
  }, []);

  const drag = useRef<{ x: number; y: number; from: Rig; ground: XY | null; moved: boolean } | null>(null);
  const turning = useRef<{ x: number; y: number; from: Rig } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const dragged = useRef(false);
  const twoFingers = (): [XY, XY] => {
    const [a, b] = [...touch.current.fingers.values()];
    return [local(a), local(b)];
  };
  const startDrag = (event: { clientX: number; clientY: number }, moved = false) => {
    const p = local(event);
    const from = shown();
    drag.current = { x: event.clientX, y: event.clientY, from, ground: groundAt(from, view, p.x, p.y), moved };
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
      if (hoverId !== null) unhover();
      fingers.pinch = { from: shown(), start: twoFingers() };
      dragging.current = true;
      return;
    }
    fingers.peeking = false;
    startDrag(event);
    const person = pick(event, REACH.touch);
    if (!person) return;
    const where = { clientX: event.clientX, clientY: event.clientY, pointerType: "touch" };
    fingers.peek = setTimeout(() => {
      fingers.peeking = true;
      card(person, where);
    }, HOLD_MS);
  };
  /** Two fingers pinch (and pan), twist to turn the city and drag up or down to tilt it, all at once. */
  const twoFingerMove = () => {
    const { from, start } = touch.current.pinch!;
    const now = twoFingers();
    const turned: Rig = { ...from, ...twistCamera(from, start, now, TILT_MOST) };
    // The fingers' rise or fall tilts rather than pans: for the pan, they are as high as they started.
    const risenBy = (now[0].y + now[1].y - start[0].y - start[1].y) / 2;
    const mid = (f: [XY, XY], dy = 0): XY => ({ x: (f[0].x + f[1].x) / 2, y: (f[0].y + f[1].y) / 2 - dy });
    const anchor = groundAt(turned, view, mid(start).x, mid(start).y);
    if (!anchor) return;
    const factor = Math.hypot(now[1].x - now[0].x, now[1].y - now[0].y) / Math.max(1, Math.hypot(start[1].x - start[0].x, start[1].y - start[0].y));
    const zoomed = zoomRig(turned, factor, anchor);
    const level = mid(now, risenBy);
    const there = groundAt(zoomed, view, level.x, level.y);
    steer(there ? panRig(zoomed, anchor, there) : zoomed, FOLLOW.drag);
  };
  const endTurn = () => {
    if (!turning.current) return false;
    turning.current = null;
    dragged.current = true;
    dragging.current = false;
    setGrabbing(false);
    return true;
  };

  const style = { width, height };
  const homeTurn = homeCamera(view);
  const atHome = Math.abs(compass.bearing - homeTurn.bearing) < 1e-3 && Math.abs(compass.tilt - homeTurn.tilt) < 1e-3;
  return (
    <>
      <div
        ref={wrapRef}
        className="city"
        style={{ ...style, cursor: grabbing ? "grabbing" : hoverId !== null ? "pointer" : "grab" }}
        onPointerDown={(event) => {
          dragged.current = false;
          touch.current.used = event.pointerType === "touch";
          if (event.pointerType === "touch") return touchDown(event);
          if (event.button === 1 || event.button === 2 || event.ctrlKey) {
            // The middle button would scroll the page; Ctrl with the left is the right button on a Mac, and opens a menu.
            event.preventDefault();
            if (hoverId !== null) unhover();
            turning.current = { x: event.clientX, y: event.clientY, from: shown() };
            dragging.current = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setGrabbing(true);
            return;
          }
          if (event.button !== 0 || pick(event)) return;
          startDrag(event);
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
            steer({ ...turn.from, ...turnCamera(turn.from, event.clientX - turn.x, event.clientY - turn.y, TILT_MOST) }, FOLLOW.drag);
            return;
          }
          const pan = drag.current;
          if (pan) {
            const [dx, dy] = [event.clientX - pan.x, event.clientY - pan.y];
            if (!pan.moved && Math.hypot(dx, dy) < DRAG_START[event.pointerType === "touch" ? "touch" : "mouse"]) return;
            if (!pan.moved) {
              pan.moved = true;
              dragging.current = true;
              clearTimeout(fingers.peek);
              setGrabbing(true);
              if (hoverId !== null) unhover();
            }
            const p = local(event);
            const there = groundAt(pan.from, view, p.x, p.y);
            if (pan.ground && there) steer(panRig(pan.from, pan.ground, there), FOLLOW.drag);
            return;
          }
          if (event.pointerType === "touch") return;
          const person = pick(event);
          if (person) card(person, event);
          else if (hoverId !== null) unhover();
        }}
        onPointerUp={(event) => {
          const fingers = touch.current;
          if (event.pointerType === "touch") {
            fingers.fingers.delete(event.pointerId);
            clearTimeout(fingers.peek);
            if (fingers.pinch) {
              const [rest] = fingers.fingers.values();
              fingers.pinch = null;
              dragged.current = true;
              dragging.current = rest !== undefined;
              if (rest) startDrag(rest, true);
              else drag.current = null;
              return;
            }
            if (fingers.peeking) {
              fingers.peeking = false;
              dragged.current = true;
              drag.current = null;
              dragging.current = false;
              setGrabbing(false);
              unhover();
              return;
            }
          }
          if (endTurn()) return;
          dragged.current = drag.current?.moved ?? false;
          drag.current = null;
          dragging.current = false;
          setGrabbing(false);
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
          dragging.current = false;
          setGrabbing(false);
        }}
        onPointerLeave={() => {
          if (!drag.current && !turning.current) unhover();
        }}
        onContextMenu={(event) => event.preventDefault()}
        onClick={(event) => {
          if (dragged.current) return;
          const person = touch.current.used ? pick(event, REACH.touch) : pick(event);
          if (person) open(person);
        }}
      >
        <canvas ref={canvasRef} className="city__scene" style={style} role="img" aria-label={`A city of ${number(count)} people round you`} />
        {failed && <p className="city__unavailable">The City needs WebGL 2, which this browser does not offer.</p>}
      </div>
      <Compass
        camera={compass}
        home={atHome}
        onReset={resetCamera}
        homeTitle="North up, looking up the south boulevard. Drag with the middle or right button, or with Ctrl held, to turn and tilt the city (two fingers twist or drag up and down on a touch screen)"
        backTo="north up and the usual tilt"
      />
    </>
  );
}

/** Whether the window meets the media `query`, kept up to date as it changes. */
function useMedia(query: string): boolean {
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

/** The taper's curve (cityLayout.ts' taper): size against closeness rank, on a log scale of rank, with 250 and 500 marked. */
export function TaperCurve({ count }: { count: number }) {
  const lg = Math.log10;
  const most = Math.max(2000, count);
  const pct = (rank: number) => `${Math.round(taper(rank, most) * 100)}%`;
  return (
    <Curve
      label={`How much smaller a building is the further out it stands: full size for the closest few hundred, half at rank ${number(TAPER_KNEE)}, a light past a thousand`}
      x={{ min: 0, max: lg(most), ticks: [[0, "1"], [1, "10"], [2, "100"], [3, "1,000"]], title: "closeness rank" }}
      y={{ min: 0, max: 1, ticks: [[0, "light"], [0.5, "half"], [1, "full"]], title: "size" }}
      lines={[{ f: (x) => taper(10 ** x, most) }]}
      marks={[
        { x: lg(250), y: taper(250, most), label: `250: ${pct(250)}`, anchor: "end" },
        { x: lg(500), y: taper(500, most), label: `500: ${pct(500)}`, anchor: "start" },
      ]}
    />
  );
}

/** The light's colour in the legend's keys: the City's one cyan. */
const KEY = "#4de3ff";

/** The key, closed to a "Legend" button in the bottom-right corner until opened: what distance, height, brightness, footprint, the taper, the beams, the light on the roads and the camera mean. */
export function CityLegend({ avenues, count }: { avenues: string[]; count: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="city-legend">
      <button type="button" className="city-legend__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide legend" : "Legend"}
      </button>
      {open && <Legend>
        <div><span className="city-key"><Swatch color={KEY} glow /></span> The tower with the core of light: you; a lit floor each for whoever you live with</div>
        <div><span className="city-key city-key--avenue" aria-hidden /> Nearer the tower: closer, by closeness rank; the avenues ring the {avenues.length > 0 ? avenues.join(", ") : "closest few"}</div>
        <div>
          <svg className="city-key" width="30" height="16" aria-hidden>
            {[[4, 4], [13, 8], [22, 13]].map(([x, h]) => <rect key={x} x={x} y={15 - h} width="6" height={h} fill="none" stroke={KEY} strokeWidth="1" />)}
          </svg>
          Taller: a higher closeness score
        </div>
        <div>
          <svg className="city-key" width="30" height="12" aria-hidden>
            {[TIERS[0].opacity, TIERS[2].opacity, TIER_FLOOR].map((o, i) => <rect key={i} x={3 + 9 * i} y="2" width="7" height="8" fill="none" stroke={KEY} strokeWidth="1" opacity={o} />)}
          </svg>
          Brighter edges: closer; the outskirts' low slabs have no closeness yet
        </div>
        <div>
          <svg className="city-key" width="30" height="12" aria-hidden>
            {[[2, 5], [10, 7], [20, 9]].map(([x, w]) => <rect key={x} x={x} y="2" width={w} height="8" fill="none" stroke={KEY} strokeWidth="1" />)}
          </svg>
          Wider at the foot: more messages
        </div>
        <div>
          <svg className="city-key" width="30" height="12" aria-hidden>
            {[[2, 9, 9], [14, 5, 5], [22, 2, 2]].map(([x, w, h]) => <rect key={x} x={x} y={11 - h} width={w} height={h} fill="none" stroke={KEY} strokeWidth="1" />)}
          </svg>
          Smaller the further out, past the closest few hundred, to lights at the edge:
        </div>
        <div className="city-legend__curve"><TaperCurve count={count} /></div>
        <div><span className="city-key city-key--beam" aria-hidden /> A beam of light over the roof: should reach out</div>
        <div><span className="city-key city-key--light" aria-hidden /> Light running along the roads to the tower: talked in the last {TRAFFIC_DAYS} days</div>
        <div><span className="city-key city-key--line" aria-hidden /> Hover, or open a panel: arcs to the people they share group chats with</div>
        <div><span className="city-key city-key--turn" aria-hidden /> Drag with the middle or right button, or with Ctrl: turn and tilt; the compass puts it back; left alone, the camera drifts round</div>
      </Legend>}
    </div>
  );
}

function City(props: ViewProps) {
  const together = props.model.people.filter(livesTogether).length;
  const labels = avenuesFor(props.model.people.length, together).map((a) => a.label.replace("top ", ""));
  return (
    <>
      <CityMap {...props} />
      <CityLegend avenues={labels} count={props.model.people.length} />
    </>
  );
}

export const city: Demo = {
  slug: "city",
  title: "City",
  View: City,
};
