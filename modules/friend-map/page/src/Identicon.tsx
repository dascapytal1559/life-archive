// A person's identicon (src/identicon.ts), drawn as a small SVG: a square of
// its background, then one path for each of the other two colours, in the hue
// you picked for them if they did (null: the seed's own).

import { identicon, IDENTICON_SIZE, MAIN, SPOT } from "./identicon.ts";

export function Identicon({ seed, hue, size = 24, className }: { seed: string; hue: number | null; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `identicon ${className}` : "identicon"}
      width={size}
      height={size}
      viewBox={`0 0 ${IDENTICON_SIZE} ${IDENTICON_SIZE}`}
      shapeRendering="crispEdges"
      aria-hidden
    >
      <IdenticonCells seed={seed} hue={hue} />
    </svg>
  );
}

/** The picture itself, IDENTICON_SIZE units square, for an SVG of its own or a pattern (Orbits fills its markers with one). */
export function IdenticonCells({ seed, hue }: { seed: string; hue: number | null }) {
  const { cells, background, main, spot } = identicon(seed, hue);
  const path = (kind: number) =>
    cells.flatMap((row, y) => row.map((cell, x) => (cell === kind ? `M${x} ${y}h1v1h-1z` : ""))).join("");
  return (
    <>
      <rect width={IDENTICON_SIZE} height={IDENTICON_SIZE} fill={background} />
      <path d={path(MAIN)} fill={main} />
      <path d={path(SPOT)} fill={spot} />
    </>
  );
}
