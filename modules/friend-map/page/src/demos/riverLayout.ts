// The river's geometry, as pure functions: each person's monthly messages
// smoothed into a flowing stream, stacked around a level centre line with
// friend groups as channels (the biggest group in the middle, each group's
// biggest person at its core), a pointer hit test, and where the names fit
// inside their own streams. River.tsx draws what these return.

export interface StreamInput {
  id: number;
  /** Messages per month. */
  series: number[];
  /** Friend group; -1 for none. */
  community: number;
}

export interface Stream {
  id: number;
  community: number;
  /** 0 for the person with the most messages overall. */
  rank: number;
  /** Top and bottom edge at each sample, in pixels from the centre line (y grows downwards). */
  y0: number[];
  y1: number[];
}

export interface RiverLayout {
  /** Samples per month; sample s sits at month s / perMonth. */
  perMonth: number;
  samples: number;
  /** Streams top to bottom. */
  streams: Stream[];
  /** Pixels per message a month: a stream this many pixels wide is one message that month. */
  scale: number;
}

export interface RiverOptions {
  /** The tallest the river may get, in pixels. */
  height: number;
  /** Space between friend groups where both are flowing, in pixels. */
  gap?: number;
  perMonth?: number;
}

/**
 * Sample a monthly series as a uniform cubic B-spline through `perMonth`
 * points per month. Every sample is a weighted average of neighbouring months,
 * so the curve never dips below zero or overshoots a peak, and a stream tapers
 * in and out instead of starting square.
 */
export function smooth(values: number[], perMonth: number): number[] {
  const n = values.length;
  if (n === 0) return [];
  const at = (i: number) => values[Math.max(0, Math.min(n - 1, i))];
  const out: number[] = [];
  for (let s = 0; s <= (n - 1) * perMonth; s++) {
    const i = Math.floor(s / perMonth);
    const u = s / perMonth - i;
    const u2 = u * u;
    const u3 = u2 * u;
    out.push(
      ((1 - u) ** 3 * at(i - 1) + (3 * u3 - 6 * u2 + 4) * at(i) + (-3 * u3 + 3 * u2 + 3 * u + 1) * at(i + 1) + u3 * at(i + 2)) / 6,
    );
  }
  return out;
}

/** `items` ordered so the first sits in the middle and the rest alternate outwards: [.., 3, 1, 0, 2, 4, ..]. */
export function insideOut<T>(items: T[]): T[] {
  const above: T[] = [];
  const below: T[] = [];
  items.forEach((item, i) => (i % 2 === 1 ? above : below).push(item));
  return [...above.reverse(), ...below];
}

/**
 * Stack everyone into one river. Friend groups are ordered by volume, inside
 * out, with people in no group on the outside; within a group the biggest
 * person is at the centre so each channel has a bright core and quiet edges.
 * People with no messages are left out.
 */
export function layoutRiver(inputs: StreamInput[], { height, gap = 5, perMonth = 6 }: RiverOptions): RiverLayout {
  const people = inputs
    .map((p) => ({ ...p, total: p.series.reduce((a, b) => a + b, 0), smoothed: smooth(p.series, perMonth) }))
    .filter((p) => p.total > 0)
    .sort((a, b) => b.total - a.total || a.id - b.id);
  const rank = new Map(people.map((p, i) => [p.id, i]));
  const samples = people[0]?.smoothed.length ?? 0;

  const groups = new Map<number, typeof people>();
  for (const p of people) (groups.get(p.community) ?? groups.set(p.community, []).get(p.community)!).push(p);
  const volume = (members: typeof people) => members.reduce((a, p) => a + p.total, 0);
  const inGroups = [...groups].filter(([c]) => c >= 0).sort((a, b) => volume(b[1]) - volume(a[1]) || a[0] - b[0]);
  const ordered = insideOut(inGroups.map(([, members]) => insideOut(members)));
  const loners = groups.get(-1);
  if (loners) {
    // The ungrouped alternate between the two banks, biggest nearest the water.
    ordered.unshift(loners.filter((_, i) => i % 2 === 0).reverse());
    ordered.push(loners.filter((_, i) => i % 2 === 1));
  }
  const channels = ordered.filter((members) => members.length > 0);

  // A gap opens between two channels only while both are flowing, easing in with their volume.
  const peak = Math.max(0, ...Array.from({ length: samples }, (_, s) => people.reduce((a, p) => a + p.smoothed[s], 0)));
  const full = Math.max(peak * 0.02, 1e-9);
  const flow = channels.map((members) => Array.from({ length: samples }, (_, s) => Math.min(1, members.reduce((a, p) => a + p.smoothed[s], 0) / full)));
  const gaps = Array.from({ length: samples }, (_, s) => flow.slice(1).map((f, c) => gap * Math.min(f[s], flow[c][s])));

  // The scale that makes the tallest moment, gaps included, exactly `height`.
  let scale = Infinity;
  for (let s = 0; s < samples; s++) {
    const total = people.reduce((a, p) => a + p.smoothed[s], 0);
    const spacing = gaps[s].reduce((a, b) => a + b, 0);
    if (total > 0) scale = Math.min(scale, Math.max(0, height - spacing) / total);
  }
  if (!Number.isFinite(scale)) scale = 0;

  const streams: Stream[] = channels.flat().map((p) => ({ id: p.id, community: p.community, rank: rank.get(p.id)!, y0: [], y1: [] }));
  for (let s = 0; s < samples; s++) {
    const total = people.reduce((a, p) => a + p.smoothed[s], 0) * scale + gaps[s].reduce((a, b) => a + b, 0);
    let y = -total / 2;
    let i = 0;
    channels.forEach((members, c) => {
      if (c > 0) y += gaps[s][c - 1];
      for (const p of members) {
        const stream = streams[i++];
        stream.y0.push(y);
        y += p.smoothed[s] * scale;
        stream.y1.push(y);
      }
    });
  }
  return { perMonth, samples, streams, scale };
}

/**
 * The stream under the pointer at sample `s`, `y` pixels from the centre line:
 * the one containing it, or else the nearest within `slack` pixels, so hairline
 * streams can still be picked. Null over open water.
 */
export function streamAt(layout: RiverLayout, s: number, y: number, slack = 4): Stream | null {
  const i = Math.max(0, Math.min(layout.samples - 1, Math.round(s)));
  let best: Stream | null = null;
  let distance = slack;
  for (const stream of layout.streams) {
    const top = stream.y0[i];
    const bottom = stream.y1[i];
    if (bottom - top <= 0) continue;
    if (y >= top && y <= bottom) return stream;
    const d = y < top ? top - y : y - bottom;
    if (d < distance) [best, distance] = [stream, d];
  }
  return best;
}

export interface Label {
  id: number;
  text: string;
  /** Centre of the text, in pixels: x across the stage, y from the centre line. */
  x: number;
  y: number;
  size: number;
}

export interface LabelOptions {
  /** Sample index to stage x. */
  x: (sample: number) => number;
  /** Width of `text` at font size `size`, in pixels. */
  measure: (text: string, size: number) => number;
  /** Font sizes to try, largest first. */
  sizes?: number[];
  /** Keep labels inside this stage x range, as well as within the river's ends. */
  left?: number;
  right?: number;
}

/**
 * Names placed inside their own streams, in priority order: each at the first
 * of its `texts` (a full name, then a short one) and the largest size that fits,
 * at the widest point where the whole line of text sits within the stream's
 * edges and clear of names already placed. Someone whose stream is
 * too thin everywhere gets no label (hover still names them).
 */
export function placeLabels(layout: RiverLayout, wanted: Array<{ id: number; texts: string[] }>, options: LabelOptions): Label[] {
  const { x, measure, sizes = [17, 15, 13, 11.5], left = -Infinity, right = Infinity } = options;
  const byId = new Map(layout.streams.map((s) => [s.id, s]));
  const placed: Label[] = [];
  const boxes: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  const pad = 6;
  const px = Array.from({ length: layout.samples }, (_, s) => x(s));
  for (const { id, texts } of wanted) {
    const stream = byId.get(id);
    if (!stream) continue;
    const order = Array.from({ length: layout.samples }, (_, s) => s).sort(
      (a, b) => stream.y1[b] - stream.y0[b] - (stream.y1[a] - stream.y0[a]) || a - b,
    );
    const tries = texts.flatMap((text) => sizes.map((size) => ({ text, size })));
    found: for (const { text, size } of tries) {
      const width = measure(text, size);
      const half = size * 0.62;
      for (const s of order) {
        if (stream.y1[s] - stream.y0[s] < half * 2) break;
        const cx = px[s];
        if (cx - width / 2 < Math.max(left, px[0]) || cx + width / 2 > Math.min(right, px[px.length - 1])) continue;
        const cy = (stream.y0[s] + stream.y1[s]) / 2;
        let fits = true;
        for (let t = 0; t < layout.samples && fits; t++) {
          if (px[t] < cx - width / 2 - 2 || px[t] > cx + width / 2 + 2) continue;
          fits = stream.y0[t] <= cy - half && stream.y1[t] >= cy + half;
        }
        if (!fits) continue;
        const box = { x0: cx - width / 2 - pad, x1: cx + width / 2 + pad, y0: cy - half - 2, y1: cy + half + 2 };
        if (boxes.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
        boxes.push(box);
        placed.push({ id, text, x: cx, y: cy, size });
        break found;
      }
    }
  }
  return placed;
}

/** A round number of messages whose stream width makes a legible bar: the smallest at least 10 pixels wide. */
export function niceBar(scale: number): { messages: number; px: number } {
  if (!(scale > 0)) return { messages: 0, px: 0 };
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const messages = steps.find((n) => n * scale >= 10) ?? steps[steps.length - 1];
  return { messages, px: messages * scale };
}
