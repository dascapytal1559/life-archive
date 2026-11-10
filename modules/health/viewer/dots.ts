// How big each result's dot is on the Health charts, and the arrows on the line joining them.
// Every dot is one size but the chart's latest result, a step bigger so it stands out beside a near one.

/** The chart's latest result's radius, in pixels. */
export const LATEST_RADIUS = 6;
/** Every other result's radius, in pixels. */
export const PAST_RADIUS = 4.5;

/** A dot's radius: the chart's latest result is the larger. */
export const dotRadius = (latest: boolean): number => (latest ? LATEST_RADIUS : PAST_RADIUS);

/** An arrowhead's length along the line and its width across, in pixels. */
export const ARROW_LENGTH = 9;
export const ARROW_WIDTH = 8;

/**
 * The arrowheads on a line joining dots (left to right, each with its radius): one per segment, pointing forward in
 * time, centred in the part of the segment the two dots leave showing, so no dot hides it whatever its size. A segment
 * with no room for one (the dots nearly touch) has none. Each is a triangle's three corners, tip first.
 */
export function arrowHeads(dots: readonly { x: number; y: number; r: number }[]): [number, number][][] {
  const heads: [number, number][][] = [];
  for (let i = 1; i < dots.length; i++) {
    const a = dots[i - 1];
    const b = dots[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const shown = length - a.r - b.r;
    if (shown < ARROW_LENGTH + 4) continue;
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    // The middle of the showing part, the head's tip half its length ahead of it.
    const mid = a.r + shown / 2;
    const tip = mid + ARROW_LENGTH / 2;
    const base = mid - ARROW_LENGTH / 2;
    const half = ARROW_WIDTH / 2;
    heads.push([
      [a.x + ux * tip, a.y + uy * tip],
      [a.x + ux * base - uy * half, a.y + uy * base + ux * half],
      [a.x + ux * base + uy * half, a.y + uy * base - ux * half],
    ]);
  }
  return heads;
}
