// A test's results drawn against the authority's range: the value up the side and time along the bottom, every chart
// over the same span of days (the earliest result of any test to today, marked by a line, unlabelled) and at the same width, so a date sits
// at the same place down the page and on every tab; a test done once is one dot on it. The latest result's dot is a step
// bigger than the rest (dots.ts), and a line joins the results with an arrowhead on each step, forward in time. Behind the results, the range's
// rungs for each stretch of time a band holds (it changes only where an age band ends) as three bands: in range green,
// mildly out yellow, out red (out and far out one band), only where an authority sets them: a range with one limit
// draws in range from its line to the chart's edge on the side it does not bound, with nothing out there. On a scale fixed for the test (../wire.ts's scale),
// which ends at a limit no result goes past, so only the bands the results reach are drawn; the edge carries only the
// ordinary ticks. Never stretched to fit a result; a result past the scale sits on its edge, hollow. No authority: the results alone, on a scale fitted to them.
// A chart is drawn at the width it is given on the page, not scaled, so its labels stay their size at half a page or
// on a phone; where there is no room, it labels fewer years and fewer points (always the latest).

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { BandSpan, HealthTest, Rung } from "../wire.ts";
import { arrowHeads, dotRadius } from "./dots.ts";
import { dayMs, dayText, decimalsOf, numberText, screenWord, shownRungs, shownStatus, valueText } from "./format.ts";

const H = 150;
const LEFT = 44;
const RIGHT = 14;
const TOP = 20;
const BOTTOM = 24;

/** Nice tick values between a and b, about n of them. */
function ticks(a: number, b: number, n: number): number[] {
  const raw = (b - a) / n;
  if (!(raw > 0)) return [a];
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** The value range of a chart with no authority's scale: its results, with room around them. */
function valueDomain(values: number[]): [number, number] {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.25;
  lo = lo >= 0 && lo - pad < 0 ? 0 : lo - pad;
  hi += pad;
  return [lo, hi];
}

/** The rects of one band span's rungs, a band per colour, between x0 and x1, cut to the plotted area. */
function rungRects(rungs: readonly Rung[], x0: number, x1: number, y: (v: number) => number, top: number, bottom: number, key: string) {
  const clamp = (v: number) => Math.max(top, Math.min(bottom, v));
  return shownRungs(rungs).map((rung, i) => {
    const yTop = rung.high === null ? top : clamp(y(rung.high));
    const yBottom = rung.low === null ? bottom : clamp(y(rung.low));
    if (yBottom - yTop <= 0) return null;
    return <rect key={`${key}${i}`} className={`band band--${rung.grade}`} x={x0} y={yTop} width={x1 - x0} height={yBottom - yTop} />;
  });
}

/** The room a year label, or a point's value label, needs along the bottom or between points, in pixels. */
const YEAR_ROOM = 40;
const VALUE_ROOM = 38;
/** The room from a year's label (its middle) to today, the axis's end: half a label, so none runs past it. */
const END_ROOM = YEAR_ROOM / 2;

/** The width `ref`'s element is laid out at, followed as it changes; 0 until it is laid out. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Which of the points at `xs` (left to right) get a value label: the latest always, then each with room from the last labelled. */
export function labelledPoints(xs: readonly number[], room: number): Set<number> {
  const shown = new Set<number>();
  let last = Infinity;
  for (let i = xs.length - 1; i >= 0; i--) {
    if (last - xs[i] >= room) {
      shown.add(i);
      last = xs[i];
    }
  }
  return shown;
}

/** Every `step`th year from the first that leaves each label its room, over a plotted width of `plot` pixels. */
export function yearStep(years: number, plot: number): number {
  return Math.max(1, Math.ceil((years * YEAR_ROOM) / Math.max(plot, 1)));
}

/** The time along the bottom every chart shares: where a day sits, today (the axis's end), and the years labelled. */
function timeAxis(span: { from: string; to: string }, W: number) {
  const t0 = dayMs(span.from);
  const t1 = dayMs(span.to);
  const x = (day: string) => LEFT + ((W - LEFT - RIGHT) * (dayMs(day) - t0)) / (t1 - t0);
  const today = x(span.to);
  const years: number[] = [];
  const firstYear = Number(span.from.slice(0, 4));
  const lastYear = Number(span.to.slice(0, 4));
  const every = yearStep(lastYear - firstYear + 1, W - LEFT - RIGHT);
  // Each year's label, but none running past today, where the axis ends.
  for (let year = firstYear; year <= lastYear; year += every) if (today - x(`${year}-01-01`) >= END_ROOM) years.push(year);
  return { x, today, years };
}

/** The bands of a screen's chart, top to bottom: green alone, or red above green when a result is positive. */
export function screenBands(test: Pick<HealthTest, "screen" | "points">): ("in" | "out")[] {
  return test.points.some((p) => screenWord(test, p.status) === "Positive") ? ["out", "in"] : ["in"];
}

/** A screen over time on the same days as every chart: a green band, a red one above it only when a result is
 * positive, each result a dot in the middle of its band labelled with its word. No values, so no value axis. */
export function ScreenChart({ test, span }: { test: HealthTest; span: { from: string; to: string } }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  return (
    <div ref={ref} className="trend-box">
      {width > 0 && <ScreenSvg test={test} span={span} W={width} />}
    </div>
  );
}

function ScreenSvg({ test, span, W }: { test: HealthTest; span: { from: string; to: string }; W: number }) {
  const { x, today, years } = timeAxis(span, W);
  const bands = screenBands(test);
  const tall = (H - TOP - BOTTOM) / bands.length;
  const middle = (band: "in" | "out") => TOP + tall * (bands.indexOf(band) + 0.5);
  const labelled = labelledPoints(test.points.map((p) => x(p.date)), VALUE_ROOM);
  return (
    <svg className="trend" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${test.name} over time`}>
      {bands.map((band, i) => (
        <rect key={band} className={`band band--${band}`} x={LEFT} y={TOP + tall * i} width={W - LEFT - RIGHT} height={tall} />
      ))}
      {years.map((year) => (
        <text key={year} className="axis" x={x(`${year}-01-01`)} y={H - 6} textAnchor="middle">
          {year}
        </text>
      ))}
      <line className="trend__today" x1={today} x2={today} y1={TOP} y2={H - BOTTOM + 4} />
      {test.points.map((p, i) => {
        const word = screenWord(test, p.status) ?? p.text ?? "";
        const cy = middle(word === "Positive" ? "out" : "in");
        const r = dotRadius(i === test.points.length - 1);
        return (
          <g key={p.date + p.sources[0]}>
            <circle className={`dot dot--${shownStatus(p.status)}`} cx={x(p.date)} cy={cy} r={r}>
              <title>{`${dayText(p.date)}, age ${p.age}: ${p.text}`}</title>
            </circle>
            {labelled.has(i) && (
              <text className="trend__value" x={x(p.date)} y={cy - r - 5} textAnchor={i === test.points.length - 1 && x(p.date) > W - RIGHT - 30 ? "end" : "middle"}>
                {word}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function TrendChart({ test, span }: { test: HealthTest; span: { from: string; to: string } }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  return (
    <div ref={ref} className="trend-box">
      {width > 0 && <TrendSvg test={test} span={span} W={width} />}
    </div>
  );
}

function TrendSvg({ test, span, W }: { test: HealthTest; span: { from: string; to: string }; W: number }) {
  const dp = decimalsOf(test);
  const points = test.points.filter((p) => p.value !== null);
  const [lo, hi] = test.scale ?? valueDomain(points.map((p) => p.value!));
  const { x, today, years } = timeAxis(span, W);
  const y = (v: number) => TOP + (H - TOP - BOTTOM) * (1 - (Math.min(Math.max(v, lo), hi) - lo) / (hi - lo));
  const labelled = labelledPoints(points.map((p) => x(p.date)), VALUE_ROOM);
  const shownTicks = ticks(lo, hi, 3);
  const dots = points.map((p, i) => ({ x: x(p.date), y: y(p.value!), r: dotRadius(i === points.length - 1) }));
  return (
    <svg className="trend" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${test.name} over time`}>
      {test.bands.map((band: BandSpan, i) => rungRects(band.rungs, x(band.from), x(band.to), y, TOP, H - BOTTOM, `b${i}`))}
      {shownTicks.map((v) => (
        <g key={v}>
          <line className="grid" x1={LEFT} x2={W - RIGHT} y1={y(v)} y2={y(v)} />
          <text className="axis" x={LEFT - 6} y={y(v) + 4} textAnchor="end">
            {numberText(v, Math.min(dp, 2))}
          </text>
        </g>
      ))}
      {years.map((year) => (
        <text key={year} className="axis" x={x(`${year}-01-01`)} y={H - 6} textAnchor="middle">
          {year}
        </text>
      ))}
      <line className="trend__today" x1={today} x2={today} y1={TOP} y2={H - BOTTOM + 4} />
      {points.length > 1 && <polyline className="trend__line" points={dots.map((d) => `${d.x},${d.y}`).join(" ")} />}
      {arrowHeads(dots).map((head, i) => (
        <polygon key={i} className="trend__arrow" points={head.map(([hx, hy]) => `${hx},${hy}`).join(" ")} />
      ))}
      {points.map((p, i) => {
        const r = dots[i].r;
        return (
        <g key={p.date}>
          <circle className={`dot dot--${shownStatus(p.status)}${p.value! < lo || p.value! > hi ? " dot--beyond" : ""}`} cx={x(p.date)} cy={y(p.value!)} r={r}>
            <title>{`${dayText(p.date)}, age ${p.age}: ${valueText(p, dp)}`}</title>
          </circle>
          {labelled.has(i) && (
            <text className="trend__value" x={x(p.date)} y={y(p.value!) - r - 5} textAnchor={i === points.length - 1 && x(p.date) > W - RIGHT - 16 ? "end" : "middle"}>
              {valueText(p, dp)}
            </text>
          )}
        </g>
        );
      })}
    </svg>
  );
}
