// A small chart of one function for Methodology: a line (or two) over labelled
// axes, with a few points on it marked and named, drawn as inline SVG in the
// panel's own colours. Each part draws its curve from the settings now, so it
// moves when they change.

/** One axis: its range, a few labelled values along it, and what it measures. */
export interface Axis {
  min: number;
  max: number;
  ticks: Array<[number, string]>;
  title: string;
}

/**
 * A function to draw over the x axis; a reference line is dashed and faint. `breaks` are where it jumps.
 * `to` ends it short of the axis's end (where it leaves the top, say), its label there rather than at the right.
 */
export interface Line {
  f: (x: number) => number;
  reference?: boolean;
  label?: string;
  breaks?: number[];
  to?: number;
}

/** A point named on the curve, its label above it (or `below`), set off to the right (start), left (end) or centred. */
export interface Mark {
  x: number;
  y: number;
  label: string;
  anchor?: "start" | "middle" | "end";
  below?: boolean;
}

const WIDTH = 360;
const HEIGHT = 180;
const PAD = { left: 40, right: 14, top: 20, bottom: 34 };
const SAMPLES = 120;

/** The points to draw `line` through over `x`: evenly spaced, and either side of each jump. */
export function curvePoints(line: Line, x: Pick<Axis, "min" | "max">): Array<[number, number]> {
  const end = Math.min(line.to ?? x.max, x.max);
  const xs = Array.from({ length: SAMPLES + 1 }, (_, i) => x.min + ((x.max - x.min) * i) / SAMPLES).filter((at) => at < end);
  xs.push(end);
  for (const at of line.breaks ?? []) if (at > x.min && at <= end) xs.push(at - (x.max - x.min) * 1e-6, at);
  return xs.sort((a, b) => a - b).map((at) => [at, line.f(at)]);
}

export function Curve({ label, x, y, lines, marks }: { label: string; x: Axis; y: Axis; lines: Line[]; marks: Mark[] }) {
  const right = WIDTH - PAD.right;
  const bottom = HEIGHT - PAD.bottom;
  const px = (v: number) => PAD.left + ((v - x.min) / (x.max - x.min || 1)) * (right - PAD.left);
  const py = (v: number) => bottom - ((Math.min(Math.max(v, y.min), y.max) - y.min) / (y.max - y.min || 1)) * (bottom - PAD.top);
  const path = (line: Line) => curvePoints(line, x).map(([a, b], i) => `${i ? "L" : "M"}${px(a).toFixed(1)},${py(b).toFixed(1)}`).join("");
  return (
    <svg className="method__curve" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label}>
      {y.ticks.map(([v, text]) => (
        <g key={`y${v}`}>
          <line className="method__curve-grid" x1={PAD.left} x2={right} y1={py(v)} y2={py(v)} />
          <text className="method__curve-tick" x={PAD.left - 6} y={py(v)} textAnchor="end" dominantBaseline="middle">{text}</text>
        </g>
      ))}
      {x.ticks.map(([v, text], i) => (
        <text
          key={`x${v}`}
          className="method__curve-tick"
          x={px(v)}
          y={bottom + 13}
          textAnchor={i === 0 && v === x.min ? "start" : i === x.ticks.length - 1 && v === x.max ? "end" : "middle"}
        >
          {text}
        </text>
      ))}
      <line className="method__curve-axis" x1={PAD.left} x2={right} y1={bottom} y2={bottom} />
      <text className="method__curve-title" x={(PAD.left + right) / 2} y={HEIGHT - 3} textAnchor="middle">{x.title}</text>
      <text className="method__curve-title" x={0} y={0} transform={`translate(11 ${(PAD.top + bottom) / 2}) rotate(-90)`} textAnchor="middle">{y.title}</text>
      {lines.map((line, i) => (
        <g key={i}>
          <path className={line.reference ? "method__curve-line method__curve-line--reference" : "method__curve-line"} d={path(line)} />
          {line.label && (line.to === undefined || line.to >= x.max ? (
            <text className="method__curve-tick" x={right} y={py(line.f(x.max)) - 5} textAnchor="end">{line.label}</text>
          ) : (
            <text className="method__curve-tick" x={px(line.to) + 5} y={py(line.f(line.to)) + 4} dominantBaseline="hanging">{line.label}</text>
          ))}
        </g>
      ))}
      {marks.map((mark) => (
        <g key={mark.label} className="method__curve-mark">
          <circle cx={px(mark.x)} cy={py(mark.y)} r={3.5} />
          <text
            x={px(mark.x) + (mark.anchor === "start" ? 6 : mark.anchor === "end" ? -6 : 0)}
            y={py(mark.y) + (mark.below ? 16 : -8)}
            textAnchor={mark.anchor ?? "middle"}
          >
            {mark.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
