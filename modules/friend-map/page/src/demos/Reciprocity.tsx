// Reciprocity, at /demos/reciprocity: who carries each friendship. Everyone
// with a one-to-one chat sits on a beam from "you carry it" (left) to "they
// carry it" (right), placed by how lopsided it is, as a ratio on a log scale
// so twice as much either way is the same distance from even. Each circle is
// split by who writes the one-to-one messages, and ringed by who reaches out
// first after a quiet fortnight (the openings counts). The beam can weigh
// messages, reach-outs, or both. People met only in group chats have nothing
// one-to-one to weigh, so they wait in a row beneath it.

import { max, scaleSqrt } from "d3";
import { useEffect, useMemo, useState } from "react";
import { standing, type DemoModel, type DemoPerson } from "./model.ts";
import { COLORS } from "./palette.ts";
import "./reciprocity.css";
import { basicRows, lastSpoke, Legend, number, tipAt, type Demo, type Tip, type ViewProps } from "./view.tsx";

export type Weigh = "both" | "messages" | "openings";

const WEIGHS: Array<[Weigh, string]> = [
  ["both", "Both"],
  ["messages", "Messages"],
  ["openings", "Reaching out"],
];

/**
 * How much more you carry it than they do, as log2 of the ratio:
 * 1 is twice as much from you, -1 twice as much from them, 0 even. Counts are
 * pulled toward even (two messages and one reach-out each way) so a handful
 * of messages can't read as wildly lopsided. Null with no one-to-one chat.
 */
export function carry(person: Pick<DemoPerson, "directFromMe" | "directFromThem" | "openingsByMe" | "openingsByThem">, weigh: Weigh): number | null {
  if (person.directFromMe + person.directFromThem === 0) return null;
  const messages = Math.log2((person.directFromMe + 2) / (person.directFromThem + 2));
  const openings = Math.log2((person.openingsByMe + 1) / (person.openingsByThem + 1));
  return weigh === "messages" ? messages : weigh === "openings" ? openings : (messages + openings) / 2;
}

/**
 * Where to cut a circle with a vertical line so that `share` of its area is
 * left of the line: the line's offset from the centre, as a fraction of the
 * radius (-1 for none, 1 for all of it).
 */
export function splitAt(share: number): number {
  if (share <= 0) return -1;
  if (share >= 1) return 1;
  // The area left of x = t (in radii) over the whole, which rises from 0 to 1 as t goes from -1 to 1.
  const left = (t: number) => 1 - (Math.acos(t) - t * Math.sqrt(1 - t * t)) / Math.PI;
  let [low, high] = [-1, 1];
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (left(mid) < share) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * A beeswarm: circles keep their `x` and each takes the `y` nearest 0 where
 * it overlaps nothing placed before it, biggest first so the heavy
 * friendships sit on the beam. Returns each item's y, in input order.
 */
export function swarm(items: Array<{ x: number; r: number }>, gap = 1.5): number[] {
  const order = items.map((_, i) => i).sort((a, b) => items[b].r - items[a].r || items[a].x - items[b].x);
  const y = new Array<number>(items.length).fill(0);
  const placed: number[] = [];
  for (const i of order) {
    const { x, r } = items[i];
    const blocked: Array<[number, number]> = [];
    for (const j of placed) {
      const reach = r + items[j].r + gap;
      const dx = Math.abs(items[j].x - x);
      if (dx >= reach) continue;
      const dy = Math.sqrt(reach * reach - dx * dx);
      blocked.push([y[j] - dy, y[j] + dy]);
    }
    const free = (c: number) => blocked.every(([a, b]) => c <= a + 1e-9 || c >= b - 1e-9);
    const candidates = [0, ...blocked.flat()].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
    y[i] = candidates.find(free) ?? 0;
    placed.push(i);
  }
  return y;
}

/**
 * The swarm at the given radii, shrunk step by step until it fits within
 * `room` of the beam on either side (never below a third of the size, so a
 * crowd too big for the window spills instead of vanishing). `outer` is how
 * far a circle's marks reach beyond its radius. Returns the radii used and
 * each y.
 */
export function fitSwarm(xs: number[], radii: number[], room: number, outer: (r: number) => number = (r) => r): { rs: number[]; ys: number[] } {
  for (let scale = 1; ; scale *= 0.92) {
    const rs = radii.map((r) => r * scale);
    const ys = swarm(xs.map((x, i) => ({ x, r: outer(rs[i]) })));
    const reach = Math.max(0, ...ys.map((y, i) => Math.abs(y) + outer(rs[i])));
    if (reach <= room || scale < 0.34) return { rs, ys };
  }
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Label {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  /** The font size for a name set inside its circle; null for one set beside it. */
  inside: number | null;
}

export interface Circle {
  x: number;
  y: number;
  r: number;
}

/**
 * Name labels for the people worth naming, in priority order: inside the
 * circle, on two lines, when it has an `inside` font size (see insideSize),
 * otherwise below,
 * above, right or left of it, whichever first clears every circle, every
 * label already placed and the `bounds`; a name with no room is left for the
 * hover card. Returns the text anchor point per id, and whether it is inside.
 */
export function placeLabels(
  wanted: Array<{ id: number; circle: Circle; width: number; inside?: number | null }>,
  circles: Circle[],
  bounds: Box,
  height = 13,
): Map<number, Label> {
  const placed: Box[] = [];
  const result = new Map<number, Label>();
  const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const hitsCircle = (box: Box, c: Circle) => {
    const nx = Math.max(box.x, Math.min(c.x, box.x + box.width));
    const ny = Math.max(box.y, Math.min(c.y, box.y + box.height));
    return (nx - c.x) ** 2 + (ny - c.y) ** 2 < c.r * c.r;
  };
  const within = (box: Box) =>
    box.x >= bounds.x && box.y >= bounds.y && box.x + box.width <= bounds.x + bounds.width && box.y + box.height <= bounds.y + bounds.height;
  for (const { id, circle: c, width, inside } of wanted) {
    if (inside) {
      result.set(id, { x: c.x, y: c.y - 1, anchor: "middle", inside });
      continue;
    }
    const spots = [
      { box: { x: c.x - width / 2, y: c.y + c.r + 2, width, height }, x: c.x, y: c.y + c.r + 2 + height - 3, anchor: "middle" as const },
      { box: { x: c.x - width / 2, y: c.y - c.r - 2 - height, width, height }, x: c.x, y: c.y - c.r - 5, anchor: "middle" as const },
      { box: { x: c.x + c.r + 4, y: c.y - height / 2, width, height }, x: c.x + c.r + 4, y: c.y + height / 2 - 3, anchor: "start" as const },
      { box: { x: c.x - c.r - 4 - width, y: c.y - height / 2, width, height }, x: c.x - c.r - 4, y: c.y + height / 2 - 3, anchor: "end" as const },
    ];
    const spot = spots.find(({ box }) => within(box) && !placed.some((p) => overlaps(p, box)) && !circles.some((other) => hitsCircle(box, other)));
    if (!spot) continue;
    placed.push(spot.box);
    result.set(id, { x: spot.x, y: spot.y, anchor: spot.anchor, inside: null });
  }
  return result;
}

/** Circles of radius `r[i]` in rows of at most `width`, left to right, each row centred on 0; x and y per item. */
export function rows(r: number[], width: number, gap = 5, rowGap = 8): Array<{ x: number; y: number }> {
  const lines: number[][] = [[]];
  let used = 0;
  r.forEach((radius, i) => {
    const need = 2 * radius + (lines.at(-1)!.length ? gap : 0);
    if (used + need > width && lines.at(-1)!.length) {
      lines.push([]);
      used = 0;
    }
    used += 2 * radius + (lines.at(-1)!.length ? gap : 0);
    lines.at(-1)!.push(i);
  });
  const out = new Array<{ x: number; y: number }>(r.length);
  let y = 0;
  for (const line of lines) {
    const tallest = Math.max(...line.map((i) => r[i]));
    const span = line.reduce((sum, i, k) => sum + 2 * r[i] + (k ? gap : 0), 0);
    let x = -span / 2;
    for (const i of line) {
      out[i] = { x: x + r[i], y: y + tallest };
      x += 2 * r[i] + gap;
    }
    y += 2 * tallest + rowGap;
  }
  return out;
}

/** Your share of all one-to-one messages and of all reach-outs, across everyone shown. */
export function overall(people: DemoPerson[]): { messages: number | null; openings: number | null } {
  const sum = (f: (p: DemoPerson) => number) => people.reduce((total, p) => total + f(p), 0);
  const me = sum((p) => p.directFromMe);
  const direct = me + sum((p) => p.directFromThem);
  const opened = sum((p) => p.openingsByMe);
  const openings = opened + sum((p) => p.openingsByThem);
  return { messages: direct ? me / direct : null, openings: openings ? opened / openings : null };
}

/** "2×", "4×", "1.5×" for a log2 ratio; "even" at 0. */
export function ratioLabel(log2: number): string {
  if (Math.abs(log2) < 0.05) return "even";
  const ratio = 2 ** Math.abs(log2);
  return `${ratio >= 3 ? Math.round(ratio) : Math.round(ratio * 10) / 10}×`;
}

/** A name as the two lines it takes inside a circle: the first word, then the rest. */
export function twoLines(name: string): string[] {
  const at = name.indexOf(" ");
  return at < 0 ? [name] : [name.slice(0, at), name.slice(at + 1)];
}

/**
 * The font size that fits `name`, on two lines, inside a circle of radius
 * `r`: up to 12.5px, and null when it would need to be smaller than 9px or
 * the circle is too small for a name inside it to look anything but cramped.
 */
export function insideSize(name: string, r: number): number | null {
  if (r < 26) return null;
  const longest = Math.max(...twoLines(name).map((line) => line.length));
  // A serif at weight 600 averages a little over half an em per character; the text may span 1.7 radii.
  const size = Math.min(12.5, (1.7 * r) / (longest * 0.54), r / 2.2);
  return size >= 9 ? Math.floor(size * 10) / 10 : null;
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
/** How far from even (in log2) still counts as about even: about 1.4 to 1 either way. */
const EVEN = 0.5;
/** Names are set at 11.5px; this is a little over their average character width. */
const CHAR = 6.4;

interface Placed {
  person: DemoPerson;
  x: number;
  y: number;
  r: number;
  carry: number;
}

function Reciprocity({ model, width, height, inset, hover, open }: ViewProps) {
  const [weigh, setWeigh] = useState<Weigh>("both");
  const [focus, setFocus] = useState<number | null>(null);
  // Everyone starts on the fulcrum and slides out to where they sit.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setSettled(true)));
    return () => cancelAnimationFrame(frame);
  }, []);

  const layout = useMemo(() => {
    const direct = model.people.filter((p) => p.direct > 0);
    const groupOnly = model.people.filter((p) => p.direct === 0).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const cx = width / 2;
    const band = { top: inset + 96, bottom: height - 262 };
    const axisY = (band.top + band.bottom) / 2;
    const biggest = Math.max(16, Math.min(46, (band.bottom - band.top) / 11, width / 30));
    const radius = scaleSqrt().domain([0, max(direct, (p) => p.direct) || 1]).range([2.5, biggest]);
    const carries = direct.map((p) => carry(p, weigh)!);
    // Symmetric about even, wide enough for the most lopsided and never narrower than 4× either way.
    const extent = Math.max(2, max(carries, Math.abs) ?? 0) * 1.04;
    const half = width / 2 - Math.max(150, width * 0.1) - ringFor(biggest).outer;
    const toX = (c: number) => cx - (c / extent) * half;
    const { rs, ys } = fitSwarm(
      carries.map(toX),
      direct.map((p) => radius(p.direct)),
      (band.bottom - band.top) / 2,
      (r) => ringFor(r).outer,
    );
    const placed: Placed[] = direct.map((person, i) => ({ person, x: toX(carries[i]), y: axisY + ys[i], r: rs[i], carry: carries[i] }));

    const small = scaleSqrt().domain([0, max(groupOnly, (p) => p.total) || 1]).range([2, 6.5]);
    const strip = rows(groupOnly.map((p) => small(p.total)), Math.min(width - 120, 980));
    const stripY = band.bottom + 104;
    const waiting = groupOnly.map((person, i) => ({ person, x: cx + strip[i].x, y: stripY + strip[i].y, r: small(person.total) }));

    const circles = placed.map(({ x, y, r }) => ({ x, y, r: ringFor(r).outer }));
    const byVolume = [...placed].sort((a, b) => b.person.direct - a.person.direct);
    const lopsided = byVolume.slice(0, 40).sort((a, b) => Math.abs(b.carry) - Math.abs(a.carry));
    const wanted = [...byVolume.slice(0, 16), ...lopsided.slice(0, 6)]
      .filter((p, i, all) => all.findIndex((q) => q.person.id === p.person.id) === i)
      .map(({ person, x, y, r }) => ({
        id: person.id,
        circle: { x, y, r: ringFor(r).outer },
        width: person.name.length * CHAR,
        inside: insideSize(person.name, r),
      }));
    const labels = placeLabels(wanted, circles, { x: 12, y: band.top - 20, width: width - 24, height: band.bottom - band.top + 26 });

    const ticks = [-3, -2, -1, 0, 1, 2, 3].filter((t) => Math.abs(t) <= extent);
    const sides = {
      me: placed.filter((p) => p.carry > EVEN).length,
      even: placed.filter((p) => Math.abs(p.carry) <= EVEN).length,
      them: placed.filter((p) => p.carry < -EVEN).length,
    };
    const endX = half + ringFor(biggest).outer + 14;
    return { placed, waiting, labels, ticks, toX, cx, axisY, band, half, endX, stripY, sides };
  }, [model, width, height, inset, weigh]);

  const totals = useMemo(() => overall(model.people), [model]);
  const now = model.months.length - 1;
  const { placed, waiting, labels, ticks, toX, cx, axisY, band, half, endX, stripY, sides } = layout;

  const enter = (event: React.MouseEvent, person: DemoPerson) => {
    setFocus(person.id);
    hover(tipAt(event, person, person.direct ? reciprocityRows(person, model) : basicRows(person, standing(person, now, model))));
  };
  const leave = () => {
    setFocus(null);
    hover(null);
  };
  const focused = placed.find((p) => p.person.id === focus);

  return (
    <div className={`recip${focus !== null ? " recip--focus" : ""}`}>
      <svg width={width} height={height}>
        <defs>
          <linearGradient id="recip-beam" x1="0" x2="1">
            <stop offset="0" stopColor={COLORS.me} stopOpacity="0.75" />
            <stop offset="0.5" stopColor={COLORS.dim} stopOpacity="0.35" />
            <stop offset="1" stopColor={COLORS.them} stopOpacity="0.75" />
          </linearGradient>
          <radialGradient id="recip-glow-me">
            <stop offset="0" stopColor={COLORS.me} stopOpacity="0.09" />
            <stop offset="1" stopColor={COLORS.me} stopOpacity="0" />
          </radialGradient>
          <radialGradient id="recip-glow-them">
            <stop offset="0" stopColor={COLORS.them} stopOpacity="0.08" />
            <stop offset="1" stopColor={COLORS.them} stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx={cx - half * 0.75} cy={axisY} rx={half * 0.8} ry={(band.bottom - band.top) * 0.6} fill="url(#recip-glow-me)" />
        <ellipse cx={cx + half * 0.75} cy={axisY} rx={half * 0.8} ry={(band.bottom - band.top) * 0.6} fill="url(#recip-glow-them)" />

        {ticks.map((t) => (
          <g key={t} className={`recip-tick${t === 0 ? " recip-tick--even" : ""}`} style={{ transform: `translateX(${toX(t)}px)` }}>
            <line y1={band.top - 6} y2={band.bottom + 6} />
            <text y={band.bottom + 20} textAnchor="middle">{ratioLabel(t)}</text>
          </g>
        ))}
        <line className="recip-beam" x1={toX(0) - half} x2={toX(0) + half} y1={axisY} y2={axisY} stroke="url(#recip-beam)" />
        <path className="recip-fulcrum" d={`M${cx},${band.bottom + 28} l-7,11 h14 z`} />

        <text className="recip-end recip-end--me" x={cx - endX} y={axisY - 6} textAnchor="end">you carry it</text>
        <text className="recip-count" x={cx - endX} y={axisY + 14} textAnchor="end">{sides.me} {sides.me === 1 ? "person" : "people"} ←</text>
        <text className="recip-end recip-end--them" x={cx + endX} y={axisY - 6}>they carry it</text>
        <text className="recip-count" x={cx + endX} y={axisY + 14}>→ {sides.them} {sides.them === 1 ? "person" : "people"}</text>
        <text className="recip-count" x={cx} y={band.bottom + 56} textAnchor="middle">{sides.even} about even</text>

        {focused && (
          <g className="recip-guide">
            <line x1={focused.x} x2={focused.x} y1={focused.y} y2={band.bottom + 6} />
            <text x={focused.x} y={band.top - 12} textAnchor="middle">
              {focused.carry > 0.05 ? `you ${ratioLabel(focused.carry)}` : focused.carry < -0.05 ? `them ${ratioLabel(focused.carry)}` : "even"}
            </text>
          </g>
        )}

        {placed.map(({ person, x, y, r }) => (
          <g
            key={person.id}
            className={`demo-person recip-person${focus === person.id ? " is-focus" : ""}`}
            style={{ transform: settled ? `translate(${x}px, ${y}px)` : `translate(${cx}px, ${axisY}px) scale(0.2)` }}
            onMouseMove={(event) => enter(event, person)}
            onMouseLeave={leave}
            onClick={() => open(person)}
          >
            <SplitCircle person={person} r={r} />
          </g>
        ))}

        <text className="recip-strip-title" x={cx} y={stripY - 12} textAnchor="middle">
          Only in group chats · nothing one-to-one to weigh
        </text>
        {waiting.map(({ person, x, y, r }) => (
          <circle
            key={person.id}
            className={`demo-person recip-waiting${focus === person.id ? " is-focus" : ""}`}
            cx={x}
            cy={y}
            r={r}
            onMouseMove={(event) => enter(event, person)}
            onMouseLeave={leave}
            onClick={() => open(person)}
          />
        ))}

        {placed.map(({ person }) => {
          const label = labels.get(person.id);
          return label ? (
            <text
              key={person.id}
              className={`demo-label recip-label${label.inside !== null ? " recip-label--inside" : ""}${focus === person.id ? " is-focus" : ""}`}
              style={label.inside !== null ? { fontSize: label.inside } : undefined}
              x={label.x}
              y={label.y}
              textAnchor={label.anchor}
            >
              {label.inside !== null
                ? twoLines(person.name).map((line, i, all) => (
                    <tspan key={i} x={label.x} dy={i === 0 ? `${-(all.length - 1) * 0.55 + 0.35}em` : "1.1em"}>{line}</tspan>
                  ))
                : person.name}
            </text>
          ) : null;
        })}
      </svg>

      <div className="recip-top" style={{ top: inset + 10 }}>
        <div className="recip-weigh" role="radiogroup" aria-label="Weigh by">
          {WEIGHS.map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={weigh === value} onClick={() => setWeigh(value)}>
              {label}
            </button>
          ))}
        </div>
        <p>
          {totals.messages !== null && <>Across everyone you write <b className="recip-me">{percent(totals.messages)}</b> of the one-to-one messages</>}
          {totals.messages !== null && totals.openings !== null && <> and </>}
          {totals.openings !== null && <>make <b className="recip-me">{percent(totals.openings)}</b> of the reach-outs after a quiet fortnight</>}
          {(totals.messages !== null || totals.openings !== null) && "."}
        </p>
      </div>

      <Legend>
        <div className="recip-key">
          <svg width="30" height="30" viewBox="-15 -15 30 30" aria-hidden>
            <SplitCircle person={{ directFromMe: 2, directFromThem: 1, openingsByMe: 1, openingsByThem: 3 }} r={10} />
          </svg>
          <span>
            Fill: who writes, <b className="recip-me">you</b> from the left, <b className="recip-them">them</b> from the right
            <br />
            Ring: who reaches out first after 14 quiet days
          </span>
        </div>
        <div>Size: one-to-one messages · place: who carries it</div>
        <div className="recip-key">
          <span className="demo-swatch recip-key-hollow" /> Only in group chats
        </div>
      </Legend>
    </div>
  );
}

/**
 * A circle filled in your colour from the left and theirs from the
 * right in proportion to who writes the one-to-one messages, inside a ring
 * split the same way by who reaches out first after a quiet spell.
 */
function SplitCircle({
  person,
  r,
}: {
  person: Pick<DemoPerson, "directFromMe" | "directFromThem" | "openingsByMe" | "openingsByThem">;
  r: number;
}) {
  const direct = person.directFromMe + person.directFromThem;
  const t = splitAt(direct ? person.directFromMe / direct : 0.5) * r;
  const h = Math.sqrt(Math.max(0, r * r - t * t));
  const opened = person.openingsByMe + person.openingsByThem;
  const { ring, width: ringWidth } = ringFor(r);
  return (
    <>
      <circle r={r + 0.4} className="recip-halo" />
      <circle r={r} fill={COLORS.them} />
      {t >= r ? (
        <circle r={r} fill={COLORS.me} />
      ) : t > -r ? (
        <path d={`M${t},${-h} A${r},${r} 0 ${t > 0 ? 1 : 0} 0 ${t},${h} Z`} fill={COLORS.me} />
      ) : null}
      {opened > 0 ? (
        <RingArcs r={ring} width={ringWidth} share={person.openingsByMe / opened} />
      ) : (
        <circle r={ring} fill="none" stroke={COLORS.dim} strokeOpacity={0.3} strokeWidth={ringWidth * 0.7} strokeDasharray="1.5 2.5" />
      )}
    </>
  );
}

/** Where the reach-out ring sits around a circle of radius `r`, how thick it is, and how far out it reaches. */
function ringFor(r: number): { ring: number; width: number; outer: number } {
  const width = Math.max(1.4, Math.min(3.5, r * 0.09));
  const ring = r + Math.max(2, r * 0.1) + width / 2;
  return { ring, width, outer: ring + width / 2 };
}

/** A ring in your colour for `share` of the way round, centred on the left, and theirs for the rest. */
function RingArcs({ r, width, share }: { r: number; width: number; share: number }) {
  if (share <= 0 || share >= 1) return <circle r={r} fill="none" stroke={share >= 1 ? COLORS.me : COLORS.them} strokeWidth={width} />;
  const half = share * Math.PI;
  const a = { x: -r * Math.cos(half), y: -r * Math.sin(half) };
  const b = { x: a.x, y: -a.y };
  const large = share > 0.5 ? 1 : 0;
  return (
    <>
      <path d={`M${a.x},${a.y} A${r},${r} 0 ${large} 0 ${b.x},${b.y}`} fill="none" stroke={COLORS.me} strokeWidth={width} />
      <path d={`M${a.x},${a.y} A${r},${r} 0 ${1 - large} 1 ${b.x},${b.y}`} fill="none" stroke={COLORS.them} strokeWidth={width} />
    </>
  );
}

function reciprocityRows(person: DemoPerson, model: DemoModel): Tip["rows"] {
  const at = standing(person, model.months.length - 1, model);
  const opened = person.openingsByMe + person.openingsByThem;
  const reactions = person.reactionsFromMe + person.reactionsFromThem;
  return [
    ["One-to-one", `${number(person.directFromMe)} you · ${number(person.directFromThem)} them`],
    ["You write", person.myShare === null ? "none" : percent(person.myShare)],
    ["Reaches out first", opened ? `you ${number(person.openingsByMe)} · them ${number(person.openingsByThem)}` : "never went quiet"],
    ...(reactions ? [["Reactions", `you ${number(person.reactionsFromMe)} · them ${number(person.reactionsFromThem)}`] as [string, string]] : []),
    ["Last spoke", lastSpoke(at.daysSince)],
  ];
}

export const reciprocity: Demo = {
  slug: "reciprocity",
  title: "Reciprocity",
  line: "Everyone on a beam from “you carry it” to “they carry it”: each circle filled by who writes more, ringed by who reaches out first after a quiet fortnight.",
  View: Reciprocity,
};
