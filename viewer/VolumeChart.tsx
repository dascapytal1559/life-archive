// The volume over time above the table: a bar for each bucket of the rows the filters leave, counted as the measure
// says (calls, or minutes on them; messages, or characters in them), whole or split by one filter's values into
// stacked parts, each value its own colour (the first eight; the rest are Other) and named in the key above. It follows
// the filters, and drives them back: dragging across bars narrows the table to their time, a tap or click on one bar to
// its bucket, and a double-click (or the range's ✕ in the filter bar) clears it.

import { scaleLinear } from "d3-scale";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { bucketText, measureText, shortCount } from "./format.ts";
import { bucketAt, rangeOf } from "./viewState.ts";
import { GRAINS, type Bucket, type FilterSpec, type Grain, type MeasureSpec, type Series, type VolumeAnswer } from "./wire.ts";
import { LOCALE } from "../src/time.ts";

/** How many parts get colours of their own (viewer.css's --series-1 to 8); the rest are added up as Other. */
export const SERIES_COLOURS = 8;

const MARGIN = { top: 8, right: 4, bottom: 20, left: 44 };

interface Props {
  volume: VolumeAnswer | null;
  measures: readonly MeasureSpec[];
  measure: string;
  /** The grain asked for, null for the finest that fits. */
  grain: Grain | null;
  noun: string;
  /** The filters the bars can be split by, and the one they are (null: whole). */
  splits: readonly FilterSpec[];
  split: string | null;
  onMeasure: (measure: string) => void;
  onGrain: (grain: Grain | null) => void;
  onSplit: (split: string | null) => void;
  onRange: (range: { from: number; to: number } | null) => void;
}

export function VolumeChart({ volume, measures, measure, grain, noun, splits, split, onMeasure, onGrain, onSplit, onRange }: Props) {
  const plot = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDragState] = useState<{ from: number; to: number } | null>(null);
  // The drag as the pointer's events last left it, which a render may not have caught up with.
  const dragging = useRef<{ from: number; to: number } | null>(null);
  const setDrag = (next: { from: number; to: number } | null) => {
    dragging.current = next;
    setDragState(next);
  };

  useLayoutEffect(() => {
    const element = plot.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A new answer is new bars: what the pointer was over no longer is.
  useEffect(() => {
    setHover(null);
    setDrag(null);
  }, [volume]);

  const spec = measures.find((m) => m.key === measure) ?? measures[0];
  const buckets = volume?.buckets ?? [];
  const innerWidth = Math.max(0, size.width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, size.height - MARGIN.top - MARGIN.bottom);
  const most = Math.max(0, ...buckets.map((b) => b.value));
  const y = scaleLinear().domain([0, most || 1]).nice().range([innerHeight, 0]);
  // A count's ticks are whole numbers: a chart whose tallest bar is 2 is not marked 0.5 and 1.5 (written 1 and 2).
  const ticks = y.ticks(3).filter((tick) => spec.unit === "minutes" || Number.isInteger(tick));
  const step = buckets.length > 0 ? innerWidth / buckets.length : 0;
  const gap = step > 5 ? 1 : 0;
  const shownGrain = volume?.grain ?? "month";

  const indexOf = (event: ReactPointerEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    return bucketAt(event.clientX - box.left, box.width, buckets.length);
  };
  const onPointerDown = (event: ReactPointerEvent) => {
    if (buckets.length === 0 || event.button !== 0) return;
    // So a drag that leaves the chart still ends on it.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer knows: the drag works without it.
    }
    const at = indexOf(event);
    setDrag({ from: at, to: at });
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    if (buckets.length === 0) return;
    const at = indexOf(event);
    setHover(at);
    if (dragging.current) setDrag({ ...dragging.current, to: at });
  };
  const onPointerUp = () => {
    const done = dragging.current;
    if (!done || !volume) return;
    setDrag(null);
    onRange(rangeOf(buckets, volume.end, done.from, done.to));
  };

  const shown = hover !== null ? buckets[hover] : null;
  const keyed = keyOf(volume?.series ?? []);
  const chosen = drag ? { first: Math.min(drag.from, drag.to), last: Math.max(drag.from, drag.to) } : null;

  return (
    <section className="chart" aria-label={`${spec.label} over time`}>
      <div className="chart__bar">
        <div className="chart__readout" aria-live="polite">
          {shown ? (
            <>
              <span className="chart__value">{readout(shown.value, spec, noun)}</span>{" "}
              <span className="chart__dim">{bucketText(shown.day, shown.start, shownGrain)}</span>
            </>
          ) : volume ? (
            <>
              <span className="chart__value">{readout(volume.total, spec, noun)}</span>{" "}
              <span className="chart__dim">by {shownGrain}</span>
            </>
          ) : (
            <span className="chart__dim">Loading…</span>
          )}
        </div>
        <div className="chart__controls">
          <div className="segmented" role="radiogroup" aria-label="Count">
            {measures.map((m) => (
              <button key={m.key} type="button" role="radio" aria-checked={m.key === measure} onClick={() => onMeasure(m.key)}>
                {m.label}
              </button>
            ))}
          </div>
          {splits.length > 0 && (
            <select className="select" name="split" aria-label="Split by" value={split ?? ""} onChange={(e) => onSplit(e.target.value || null)}>
              <option value="">Not split</option>
              {splits.map((s) => (
                <option key={s.key} value={s.key}>
                  Split: {s.label}
                </option>
              ))}
            </select>
          )}
          <select className="select" name="grain" aria-label="Bars by" value={grain ?? "auto"} onChange={(e) => onGrain(e.target.value === "auto" ? null : (e.target.value as Grain))}>
            <option value="auto">Auto</option>
            {GRAINS.map((g) => (
              <option key={g} value={g}>
                By {g}
              </option>
            ))}
          </select>
        </div>
      </div>
      {keyed.length > 0 && (
        <ul className="chart__key" aria-label="Key">
          {keyed.map((part) => (
            <li key={part.value}>
              <span className={`chart__swatch chart__part--${part.colour}`} aria-hidden="true" />
              {part.label}
              <span className="chart__dim"> {measureText(sumOf(part.indices, shown ?? volume!), spec)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="chart__plot" ref={plot}>
        {size.width > 0 && (
          <svg width={size.width} height={size.height} role="img" aria-label={`${spec.label} by ${shownGrain}`}>
            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
              {ticks.map((tick) => (
                <g key={tick} transform={`translate(0,${y(tick)})`}>
                  <line className="chart__grid" x1={0} x2={innerWidth} />
                  <text className="chart__tick" x={-6} dy="0.32em" textAnchor="end">
                    {axisText(tick, spec)}
                  </text>
                </g>
              ))}
              {buckets.map((bucket, i) => {
                const top = y(bucket.value);
                const inDrag = chosen !== null && i >= chosen.first && i <= chosen.last;
                const className = `chart__bucket${inDrag ? " chart__bucket--chosen" : ""}${i === hover ? " chart__bucket--hover" : ""}`;
                const width = Math.max(1, step - gap);
                if (!bucket.parts || keyed.length === 0) {
                  return <rect key={bucket.start} className={className} x={i * step} y={top} width={width} height={Math.max(bucket.value > 0 ? 1 : 0, innerHeight - top)} />;
                }
                // The parts stacked from the axis up, in the key's order, a hairline of the night between them.
                let below = 0;
                return (
                  <g key={bucket.start} className={className}>
                    {keyed.map((part) => {
                      const value = part.indices.reduce((sum, index) => sum + bucket.parts![index], 0);
                      if (value <= 0) return null;
                      const from = y(below);
                      below += value;
                      const to = y(below);
                      const height = Math.max(1, from - to - (from - to > 3 ? 1 : 0));
                      return <rect key={part.value} className={`chart__part chart__part--${part.colour}`} x={i * step} y={from - height} width={width} height={height} />;
                    })}
                  </g>
                );
              })}
              {chosen && (
                <rect className="chart__drag" x={chosen.first * step} y={0} width={(chosen.last - chosen.first + 1) * step} height={innerHeight} />
              )}
              {axisLabels(buckets, shownGrain, step).map((label) => (
                <text key={label.at} className="chart__tick" x={label.at * step} y={innerHeight + 14}>
                  {label.text}
                </text>
              ))}
              <line className="chart__axis" x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} />
              <rect
                className="chart__touch"
                width={innerWidth}
                height={innerHeight + MARGIN.bottom}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => setDrag(null)}
                onPointerLeave={() => setHover(null)}
                onDoubleClick={() => onRange(null)}
              />
            </g>
          </svg>
        )}
        {volume && buckets.length === 0 && <p className="chart__empty">No {noun} here</p>}
      </div>
    </section>
  );
}

/** "2,681 calls", "312 h on calls", or "85,363,244 characters". */
function readout(value: number, measure: MeasureSpec, noun: string): string {
  if (measure.unit === "characters") return `${measureText(value, measure)} characters`;
  return measure.unit === "minutes" ? `${measureText(value, measure)} on ${noun}` : `${measureText(value, measure)} ${noun}`;
}

/** A part of the key: one series with a colour of its own, or Other (the series past the colours, added up). */
interface KeyPart {
  value: string;
  label: string;
  /** 1 to 8, or "other". */
  colour: number | "other";
  /** Its series' places in VolumeAnswer.series, and so in each bucket's parts. */
  indices: number[];
}

/** The key: each series with a colour slot of its own, in order, then Other for the rest. */
export function keyOf(series: readonly Series[]): KeyPart[] {
  const own = series.flatMap((s, index) => (s.slot < SERIES_COLOURS ? [{ value: s.value, label: s.label, colour: s.slot + 1, indices: [index] }] : []));
  const rest = series.flatMap((s, index) => (s.slot < SERIES_COLOURS ? [] : [index]));
  return rest.length === 0 ? own : [...own, { value: "\u0000other", label: rest.length === 1 ? series[rest[0]].label : "Other", colour: "other", indices: rest }];
}

/** A key part's value in one bucket, or (given the whole answer) over every bucket, as the answer totals it. */
function sumOf(indices: readonly number[], of: Bucket | VolumeAnswer): number {
  if ("buckets" in of && of.seriesTotals) return indices.reduce((sum, index) => sum + (of.seriesTotals![index] ?? 0), 0);
  const buckets = "buckets" in of ? of.buckets : [of];
  return buckets.reduce((sum, bucket) => sum + indices.reduce((part, index) => part + (bucket.parts?.[index] ?? 0), 0), 0);
}

/** A value on the chart's axis: a count (short once big), or minutes as hours once there are many. */
function axisText(value: number, measure: MeasureSpec): string {
  if (measure.unit !== "minutes") return shortCount(value);
  return value >= 120 ? `${Math.round(value / 60).toLocaleString(LOCALE)} h` : `${value} min`;
}

const MONTH = new Intl.DateTimeFormat(LOCALE, { month: "short", timeZone: "UTC" });

/**
 * Where the time axis is labelled: where a month begins (for days and weeks, the year where it changes) or a year,
 * each label at least 52 pixels from the one before.
 */
export function axisLabels(buckets: readonly Bucket[], grain: Grain, step: number): Array<{ at: number; text: string }> {
  const labels: Array<{ at: number; text: string }> = [];
  let lastKey = "";
  let lastAt = -Infinity;
  buckets.forEach((bucket, i) => {
    const byMonth = grain === "day" || grain === "week";
    const key = byMonth ? bucket.day.slice(0, 7) : bucket.day.slice(0, 4);
    if (key === lastKey) return;
    lastKey = key;
    if ((i - lastAt) * step < 52) return;
    lastAt = i;
    const month = MONTH.format(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1));
    labels.push({ at: i, text: !byMonth ? key : key.endsWith("-01") || labels.length === 0 ? `${month} ${key.slice(0, 4)}` : month });
  });
  return labels;
}
