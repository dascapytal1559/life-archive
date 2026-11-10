// The Fitness page's drawings: an activity's route as a line (its shape and size, north up, a scale bar on the large
// one; RouteMap.tsx lays it on a map where one is kept), its heart rate over time, its time in each heart-rate zone and
// its splits. Each is plain SVG or DOM in the console's tokens (exercise.css), drawn at the width it is given.

import { useId, useRef, useState, type PointerEvent } from "react";
import type { Family, Shape, Split, Zone } from "../wire.ts";
import { clockText, scaleLength, scaleText, speedText, speedWay } from "./format.ts";
import { routeBox } from "./place.ts";

/** How much wider than tall the feed's thumbnail's box is; the page's is square. */
export const THUMB_WIDE = 2.2;

/** The route, fitted to its box with a margin, north up; start a filled dot, finish a ringed one; a scale bar on the large. */
export function RouteShape({ shape, large = false, label }: { shape: Shape; large?: boolean; label: string }) {
  // Wider than tall in the feed's thumbnail, square on the page: the box widens to fill it.
  const { x, y, width, height, side, pad } = routeBox(shape, large ? 1 : THUMB_WIDE);
  const [x0, y0, box] = [x + (width - height) / 2, y, height];
  const view = `${x} ${y} ${width} ${height}`;
  const points = shape.points.map(([x, y]) => `${x},${shape.height - y}`).join(" ");
  const [first, last] = [shape.points[0], shape.points.at(-1)!];
  const dot = side * (large ? 0.016 : 0.028);
  const bar = scaleLength(shape.width || side);
  return (
    <svg className={`route${large ? " route--large" : ""}`} viewBox={view} preserveAspectRatio="xMidYMid meet" role="img" aria-label={label}>
      <polyline className="route__halo" points={points} vectorEffect="non-scaling-stroke" />
      <polyline className="route__line" points={points} vectorEffect="non-scaling-stroke" />
      <circle className="route__start" cx={first[0]} cy={shape.height - first[1]} r={dot} />
      <circle className="route__end" cx={last[0]} cy={shape.height - last[1]} r={dot} strokeWidth={dot * 0.6} />
      {large && (
        <g className="route__scale" transform={`translate(${x0 + pad * 0.5} ${y0 + box - pad * 0.45})`}>
          <line x1={0} x2={bar} y1={0} y2={0} vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={0} y1={-side * 0.012} y2={side * 0.012} vectorEffect="non-scaling-stroke" />
          <line x1={bar} x2={bar} y1={-side * 0.012} y2={side * 0.012} vectorEffect="non-scaling-stroke" />
          <text x={bar + side * 0.02} y={side * 0.012} fontSize={side * 0.034}>
            {scaleText(bar)}
          </text>
        </g>
      )}
    </svg>
  );
}

/** Heart rate over time: a line with its average dashed across, the scale at the left, and the reading under the pointer. */
export function HeartRateChart({ series, average }: { series: ReadonlyArray<[number, number]>; average: number }) {
  const [at, setAt] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const gradient = useId();
  const end = series.at(-1)![0] || 1;
  const values = series.map(([, v]) => v);
  const low = Math.floor((Math.min(...values) - 5) / 10) * 10;
  const high = Math.ceil((Math.max(...values) + 5) / 10) * 10;
  const [W, H] = [1000, 220];
  const x = (t: number) => (t / end) * W;
  const y = (v: number) => H - ((v - low) / (high - low)) * H;
  const line = series.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const ticks = [low, Math.round((low + high) / 2 / 10) * 10, high];
  const move = (event: PointerEvent) => {
    const rect = box.current!.getBoundingClientRect();
    const t = ((event.clientX - rect.left) / rect.width) * end;
    let near = 0;
    for (let i = 1; i < series.length; i++) if (Math.abs(series[i][0] - t) < Math.abs(series[near][0] - t)) near = i;
    setAt(near);
  };
  const point = at === null ? null : series[at];
  return (
    <div className="hr-chart">
      <div className="hr-chart__axis" aria-hidden="true">
        {ticks.toReversed().map((tick) => (
          <span key={tick}>{tick}</span>
        ))}
      </div>
      <div ref={box} className="hr-chart__plot" onPointerMove={move} onPointerLeave={() => setAt(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Heart rate over ${clockText(end)}: average ${average} bpm, from ${Math.min(...values)} to ${Math.max(...values)} bpm`}>
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" className="hr-chart__fill-top" />
              <stop offset="1" className="hr-chart__fill-bottom" />
            </linearGradient>
          </defs>
          {ticks.map((tick) => (
            <line key={tick} className="hr-chart__grid" x1={0} x2={W} y1={y(tick)} y2={y(tick)} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#${gradient})`} />
          <path className="hr-chart__line" d={line} vectorEffect="non-scaling-stroke" />
          <line className="hr-chart__average" x1={0} x2={W} y1={y(average)} y2={y(average)} vectorEffect="non-scaling-stroke" />
          {point && <line className="hr-chart__cursor" x1={x(point[0])} x2={x(point[0])} y1={0} y2={H} vectorEffect="non-scaling-stroke" />}
        </svg>
        {point && (
          <div className="hr-chart__readout" style={{ left: `${(point[0] / end) * 100}%` }}>
            <b>{point[1]} bpm</b> {clockText(point[0])}
          </div>
        )}
        <div className="hr-chart__times" aria-hidden="true">
          <span>0:00</span>
          <span>{clockText(end / 2)}</span>
          <span>{clockText(end)}</span>
        </div>
      </div>
    </div>
  );
}

/** Polar's names for its five heart-rate zones. */
const ZONE_NAMES = ["Very light", "Light", "Moderate", "Hard", "Maximum"];

/** Time in each zone, the hardest at the top: a bar as long as its share, its bpm from its lower limit to the next's. */
export function ZoneBars({ zones }: { zones: readonly Zone[] }) {
  const sorted = [...zones].sort((a, b) => a.zone - b.zone);
  const most = Math.max(1, ...sorted.map((z) => z.share));
  return (
    <ul className="zones">
      {sorted.toReversed().map((zone) => {
        const next = sorted.find((z) => z.zone === zone.zone + 1);
        // Zone 1 of the archive's own count has no lower limit: everything under zone 2.
        const bpm = zone.from === null ? (next?.from != null ? `<${next.from} bpm` : "") : next?.from != null ? `${zone.from}–${next.from - 1} bpm` : `${zone.from}+ bpm`;
        return (
          <li key={zone.zone} className={`zones__row zone--${zone.zone}`}>
            <span className="zones__name">
              <b>Z{zone.zone}</b> {ZONE_NAMES[zone.zone - 1] ?? ""}
            </span>
            <span className="zones__bpm">{bpm}</span>
            <span className="zones__track">
              <i style={{ width: `${(zone.share / most) * 100}%` }} />
            </span>
            <span className="zones__share">{zone.share}%</span>
            <span className="zones__time">{zone.time ?? ""}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Time in zones as one line: zones 1 to 5 in order, each as wide as its share of the time, in the zones' colours (zone 2
 * blue), so what a workout aimed at reads at a glance; each zone's share, time and lower limit on hover.
 */
export function ZoneLine({ zones }: { zones: readonly Zone[] }) {
  const sorted = [...zones].sort((a, b) => a.zone - b.zone).filter((z) => z.share > 0);
  const words = sorted.map((z) => `Z${z.zone} ${ZONE_NAMES[z.zone - 1] ?? ""}: ${z.share}%${z.time ? ` (${z.time})` : ""}${z.from !== null ? `, from ${z.from} bpm` : ""}`);
  return (
    <div className="zone-line" role="img" aria-label={`Time in zones: ${words.join("; ")}`}>
      {sorted.map((z, i) => (
        <i key={z.zone} className={`zone--${z.zone}`} style={{ flexGrow: z.share }} title={words[i]} />
      ))}
    </div>
  );
}

/**
 * Each kilometre: its pace (or speed) with a bar as long as how fast it was against the others (the slowest a third of
 * the fastest's, so the differences show), and its heart rate.
 */
export function SplitsTable({ splits, family }: { splits: readonly Split[]; family: Family }) {
  const way = speedWay(family);
  const speeds = splits.map((s) => (s.seconds > 0 ? s.distanceM / s.seconds : 0));
  const fastest = Math.max(...speeds, 0.0001);
  const slowest = Math.min(...speeds.filter((v) => v > 0), fastest);
  const width = (v: number) => (fastest === slowest ? 100 : 33 + (67 * (v - slowest)) / (fastest - slowest));
  const withHr = splits.some((s) => s.heartRate !== null);
  return (
    <div className="splits" role="table" aria-label="Splits">
      <div className="splits__row splits__row--head" role="row">
        <span role="columnheader">Km</span>
        <span role="columnheader">{way === "speed" ? "km/h" : way === "pace" ? "/km" : "/100m"}</span>
        <span role="columnheader" aria-hidden="true" />
        <span role="columnheader">{withHr ? "HR" : ""}</span>
      </div>
      {splits.map((split, i) => (
        <div key={i} className="splits__row" role="row">
          <span role="cell">{split.distanceM >= 995 ? i + 1 : (split.distanceM / 1000).toFixed(2)}</span>
          <span role="cell">{speedText(family, split.seconds, split.distanceM).replace(/ (\/km|\/100m|km\/h)$/, "")}</span>
          <span role="cell" className="splits__track">
            <i style={{ width: `${speeds[i] > 0 ? width(speeds[i]) : 4}%` }} />
          </span>
          <span role="cell">{split.heartRate ?? ""}</span>
        </div>
      ))}
    </div>
  );
}
