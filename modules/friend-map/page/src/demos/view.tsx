// The kit every demo view is built from: what a view is (Demo, ViewProps),
// loading the data, the hover card's contents, labels, and the legend.
//
// A view is a component that draws `model` into a `width` x `height` stage
// (leaving `inset` pixels at the top for the page header), calls `hover`
// with a Tip while the pointer is over a person (null when it leaves), and
// `open` when a person is clicked; the page draws the hover card and opens
// the person panel. See Placeholder.tsx for the smallest working view.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { PersonLocation } from "../archive.ts";
import { appApi } from "../appApi.ts";
import { archiveApi } from "../archiveApi.ts";
import { Identicon } from "../Identicon.tsx";
import { useNames } from "../names.ts";
import { Name, TagChips } from "../PersonParts.tsx";
import { useArchive } from "../useArchive.ts";
import { buildModel, durationLabel, type DemoModel, type DemoPerson, type Standing } from "./model.ts";
import { revealsArchived, type HideChoices } from "./hideChoices.ts";
import { locale } from "../time.ts";

export interface Demo {
  /** The route: /demos/<slug>. */
  slug: string;
  title: string;
  /** What it encodes, in one line, shown under the view; the main views leave it out (Methodology explains them). */
  line?: string;
  /**
   * The docked person panel opens over it, rather than narrowing it: it keeps its size, slid aside so what the panel
   * leaves of it is centred, and is never drawn again for the panel (Demos.tsx). Every other live view narrows.
   */
  keepsSize?: boolean;
  View: ComponentType<ViewProps>;
}

export interface ViewProps {
  model: DemoModel;
  width: number;
  height: number;
  /** Height of the page header drawn over the top of the stage. */
  inset: number;
  /**
   * How much of `width` is in view across, centred: all of it, but for the docked person panel over a view that keeps
   * its size (Demo.keepsSize). The views that narrow leave it.
   */
  seen?: number;
  hover: (tip: Tip | null) => void;
  open: (person: DemoPerson) => void;
  /** Closes the panel, letting go of whoever is held: the Spider web calls it on a click on empty map. The frozen views leave it. */
  close?: () => void;
  /**
   * Whose panel is open: the main view keeps them picked out on the map, with
   * the people they share group chats with, until it closes. The frozen views leave it.
   */
  held?: number | null;
  /**
   * The group chat open in the held person's panel, if any: the main view then
   * links them only to its members. The frozen views leave it.
   */
  heldGroup?: number | null;
  /**
   * Someone picked in the find box, with a count that goes up with every pick
   * (so picking the same person again counts): the main view brings them into
   * view. The frozen views leave it.
   */
  find?: Find | null;
  /**
   * How many times you have re-queried in the Query bar (a new query, ×, or Hide changing; never the query
   * run again as people or messages change): the Spider web replays its scan as it goes up. The frozen views leave it.
   */
  requery?: number;
}

/** A pick in the main view's find box (FindBox.tsx). */
export interface Find {
  id: number;
  count: number;
}

/**
 * The hover card: where the pointer is (client coordinates), whose card, and label/value rows; `touch` when a finger held
 * on them shows it; `dot` (the Spider web) when the card belongs beside the person's dot instead, `x` and `y` then the dot's
 * centre, `r` its radius, and `hub` where the spider sits, whose beam to them the card keeps off.
 */
export interface Tip {
  x: number;
  y: number;
  touch?: boolean;
  dot?: { r: number; hub: { x: number; y: number } };
  person: DemoPerson;
  rows: Array<[string, string]>;
}

/**
 * The relationships report as a DemoModel, reloaded whenever the archive
 * changes (a tag added in the person panel, say), with the look-back window
 * and how closeness is scored (the half-life and what catch-ups count as) from data/settings.json. Archived people are left out, and, given `filters`, everyone
 * the query that ran (`query`) leaves out (`only`, the ids it matches, or null for no query; the model waits while it
 * is undefined, until the query has run), then everyone `hide` leaves out (see hideChoices.ts). Only while `hide`
 * shows archived people are they loaded, and only those the query matches.
 * `settingsProblems` says what is wrong in the settings file, if anything.
 */
export function useDemoModel(
  filters: { hide: HideChoices; query: string; only: ReadonlySet<number> | null | undefined } | null = null,
): { model: DemoModel | null; status: string | null; settingsProblems: string[] } {
  // Never before the query has run: under the map's gate, that is when it is known not to show too many.
  const reveal = filters && filters.only !== undefined ? revealsArchived(filters.hide) : false;
  // The query matters to the report only while archived people are shown.
  const q = reveal ? filters?.query ?? "" : "";
  // New messages change the counts, so the map follows them too (the report holds only who is on the map).
  const report = useArchive(() => Promise.all([archiveApi.relationships(q, reveal), appApi.settings(), archiveApi.tags()]), [q, reveal], { messages: true });
  const [relationships, settings, tags] = report.data ?? [];
  const hide = filters?.hide ?? null;
  const only = filters ? filters.only : null;
  const model = useMemo(
    () => (relationships && settings && only !== undefined
      ? buildModel(relationships, {
        hide,
        only,
        settings: settings.settings,
        tags: tags?.map((tag) => tag.name),
      })
      : null),
    [relationships, settings, tags, hide, only],
  );
  const status = model
    ? null
    : report.unavailable
      ? "The message archive is not running, so there is nobody to draw."
      : (report.error ?? "Loading…");
  return { model, status, settingsProblems: settings?.problems ?? [] };
}

/** A Tip for `person` at the pointer of `event`. */
export function tipAt(event: { clientX: number; clientY: number; pointerType?: string }, person: DemoPerson, rows: Tip["rows"]): Tip {
  return { x: event.clientX, y: event.clientY, person, rows, ...(event.pointerType === "touch" && { touch: true }) };
}

/** The hover card's width as drawn (.demo-tip: 250 pixels, its padding and its border), and how far it keeps from the window's edges. */
const TIP_WIDTH = 280;
const TIP_EDGE = 8;
/** On the Spider web, how far the card keeps from the edge of its person's dot, and from the spider's beam. */
const DOT_GAP = 20;
const BEAM_GAP = 8;

/**
 * Where the hover card goes, `card` its size as drawn (its usual width and its rows' estimate of its height until it has
 * been): beside the pointer, flipped to its left near the right edge, and never past either edge (a phone's window is
 * barely wider than the card). For a finger, centred above it, where the hand does not cover it, or below it when there
 * is no room above. With `dot` (the Spider web), in one place for each person whatever the pointer does: see besideDot.
 */
export function tipPlace(
  tip: Tip,
  bounds: { width: number; height: number },
  card = { width: TIP_WIDTH, height: 60 + 22 * tip.rows.length },
): { left: number; top: number } {
  const { width, height: tall } = card;
  const within = (left: number) => Math.max(TIP_EDGE, Math.min(left, bounds.width - width - TIP_EDGE));
  if (tip.dot && !tip.touch) return besideDot(tip, tip.dot, card, bounds);
  if (tip.touch) {
    const above = tip.y - 48 - tall;
    return { left: within(tip.x - width / 2), top: above >= TIP_EDGE ? above : Math.min(tip.y + 48, bounds.height - tall) };
  }
  const left = tip.x > bounds.width - width - 40 ? tip.x - width - 18 : tip.x + 18;
  return { left: within(left), top: Math.max(TIP_EDGE, Math.min(tip.y + 14, bounds.height - tall)) };
}

type XY = { x: number; y: number };
type Box = { left: number; top: number; width: number; height: number };

/**
 * The Spider web's card for a person whose dot is at `at`: straight out from the spider, its nearest edge or corner DOT_GAP
 * from the dot's edge, so it covers neither the dot nor the beam running in to it. Where that would leave the window,
 * turned round the dot a step at a time, either way, to the nearest place inside the window that still keeps that far
 * from the dot and BEAM_GAP from the beam. In a corner, where the beam comes in across the only room there is, further
 * out the same way; and with nowhere like that at all (a window hardly bigger than the card), straight out, inside the
 * window.
 */
function besideDot(at: XY, dot: NonNullable<Tip["dot"]>, card: { width: number; height: number }, bounds: { width: number; height: number }): { left: number; top: number } {
  const out = at.x === dot.hub.x && at.y === dot.hub.y ? 0 : Math.atan2(at.y - dot.hub.y, at.x - dot.hub.x);
  const inside = (box: Box) =>
    box.left >= TIP_EDGE && box.top >= TIP_EDGE && box.left + box.width <= bounds.width - TIP_EDGE && box.top + box.height <= bounds.height - TIP_EDGE;
  const STEP = Math.PI / 36;
  for (const gap of [1, 2, 3, 4, 6, 8, 12, 16].map((n) => n * DOT_GAP)) {
    for (let i = 0; i <= 36; i++) {
      for (const turn of i === 0 ? [0] : [i * STEP, -i * STEP]) {
        const box = cardOff(at, out + turn, dot.r + gap, card);
        if (inside(box) && !crosses(box, BEAM_GAP, dot.hub, at)) return { left: box.left, top: box.top };
      }
    }
  }
  const box = cardOff(at, out, dot.r + DOT_GAP, card);
  return {
    left: Math.max(TIP_EDGE, Math.min(box.left, bounds.width - card.width - TIP_EDGE)),
    top: Math.max(TIP_EDGE, Math.min(box.top, bounds.height - card.height - TIP_EDGE)),
  };
}

/** A card centred on the line from `at` at angle `angle`, as close to `at` as keeps every point of it `gap` away. */
function cardOff(at: XY, angle: number, gap: number, card: { width: number; height: number }): Box {
  const [a, b] = [Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle))];
  const [w, h] = [card.width / 2, card.height / 2];
  // How far out the card's centre goes: until a side is `gap` away, or, where the line leaves through a corner, until
  // that corner is (the larger root of (s·a − w)² + (s·b − h)² = gap²).
  const side = Math.min(a > 0 ? (w + gap) / a : Infinity, b > 0 ? (h + gap) / b : Infinity);
  const along = a * w + b * h;
  const far = side * a > w + 1e-9 && side * b > h + 1e-9 ? along + Math.sqrt(Math.max(0, along * along - (w * w + h * h - gap * gap))) : side;
  return { left: at.x + Math.cos(angle) * far - w, top: at.y + Math.sin(angle) * far - h, width: card.width, height: card.height };
}

/** Whether the segment from `a` to `b` passes within `pad` of `box` (the box grown by `pad`, clipped against: Liang–Barsky). */
function crosses(box: Box, pad: number, a: XY, b: XY): boolean {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  let [t0, t1] = [0, 1];
  for (const [p, q] of [
    [-dx, a.x - (box.left - pad)],
    [dx, box.left + box.width + pad - a.x],
    [-dy, a.y - (box.top - pad)],
    [dy, box.top + box.height + pad - a.y],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/**
 * The hover card: a Tip drawn where tipPlace puts it, inside the window (the page draws it over the view).
 * With `identicon` (Orbits; the frozen views are not extended), the person's identicon beside their name.
 */
export function HoverCard({ tip, bounds, identicon = false }: { tip: Tip; bounds: { width: number; height: number }; identicon?: boolean }) {
  // Placed by an estimate of its size until it is drawn, then by its size as drawn, before it is first painted. Its size
  // is told by a ResizeObserver, once the browser has laid the page out and only when it changes, so a hover never makes
  // the browser lay out what the hover changed ahead of the frame, as reading the card's size would; the card is moved
  // in that same frame (flushSync), before it is painted.
  const ref = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState<{ width: number; height: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize?.[0];
      const width = Math.round(box ? box.inlineSize : card.offsetWidth);
      const height = Math.round(box ? box.blockSize : card.offsetHeight);
      if (!width) return;
      flushSync(() => setDrawn((was) => (was?.width === width && was.height === height ? was : { width, height })));
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, []);
  const { left, top } = tipPlace(tip, bounds, drawn);
  const { primary, secondary } = useNames().label(tip.person);
  return (
    <div ref={ref} className="demo-tip" style={{ left, top }}>
      <div className="demo-tip__who">
        {identicon && <Identicon seed={tip.person.identiconSeed} hue={tip.person.identiconHue} size={30} />}
        <div>
          <strong><Name text={primary} /></strong>
          {secondary && <span className="person-label__full muted">{secondary}</span>}
        </div>
      </div>
      <TagChips tags={tip.person.tags} />
      <dl>
        {tip.rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <span className="demo-tip__hint">{tip.touch ? "Let go to close; tap to open" : "Click to open"}</span>
    </div>
  );
}

export const number = (n: number) => n.toLocaleString(locale());

/** The rows most views show: volume, who wrote the one-to-one messages, and when they last talked. */
export function basicRows(person: DemoPerson, at: Standing): Tip["rows"] {
  return [
    ["Messages", number(at.total)],
    ["One-to-one", person.direct ? `${number(person.directFromMe)} you · ${number(person.directFromThem)} them` : "none"],
    ["Their group messages", number(person.groupFromThem)],
    ["Last spoke", lastSpoke(at.daysSince)],
  ];
}

/** An aspiring friend's hover card says what they are: the usual rows would be zeros. */
export function aspiringRows(person: PersonLocation): Tip["rows"] {
  return [["Aspiring friend", "someone you would like to know"], ...fieldRows(person)];
}

/** Where they are, as far as you last knew, only when said (the hover card's rows). */
export function fieldRows(person: PersonLocation): Tip["rows"] {
  return person.location ? [["Location", person.location]] : [];
}

export function lastSpoke(days: number | null): string {
  if (days === null) return "not yet";
  return days < 1 ? "today" : `${durationLabel(days)} ago`;
}

/** "warming: 12 → 30", "fading: 40 → 5", "steady": the three months before against the last three. */
export function trendLabel(at: Standing): string {
  const change = `${number(at.before)} → ${number(at.recent)}`;
  if (Math.abs(at.trend) < 0.1) return at.recent + at.before === 0 ? "quiet" : `steady: ${change}`;
  return `${at.trend > 0 ? "warming" : "fading"}: ${change}`;
}

/** The ids of the `count` items with the highest `value` (above 0): the people worth naming on a view. */
export function topIds<T extends { id: number }>(items: T[], value: (item: T) => number, count: number): Set<number> {
  return new Set([...items].sort((a, b) => value(b) - value(a)).slice(0, count).filter((i) => value(i) > 0).map((i) => i.id));
}

/**
 * A ref for an element and its current size, following resizes. With
 * `border`, the size takes in the element's padding and border. (The map's
 * stage has its own, useMapSize in mapSize.ts.)
 */
export function useSize<T extends HTMLElement>({ border = false } = {}): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = border ? entry.borderBoxSize[0] : null;
      const width = Math.round(box ? box.inlineSize : entry.contentRect.width);
      const height = Math.round(box ? box.blockSize : entry.contentRect.height);
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [border]);
  return [ref, size];
}

/** The key to a view, in the bottom-right corner: one row per child. */
export function Legend({ children }: { children: ReactNode }) {
  return <div className="demo-legend">{children}</div>;
}

export function Swatch({ color, ring = false, glow = false }: { color: string; ring?: boolean; glow?: boolean }) {
  return (
    <span
      className="demo-swatch"
      style={ring ? { border: `2px solid ${color}` } : glow ? { background: color, boxShadow: `0 0 8px 3px ${color}` } : { background: color }}
    />
  );
}
