// A theme colour chosen in a view's settings (viewSettings.ts): one #rrggbb,
// and the little colour work its themes are made from (orbitsTheme.ts,
// webTheme.ts), in OKLCH, so a hue turned keeps how light and how strong it
// looks.

import { oklab, oklchHex } from "../identicon.ts";

/** A colour as #rrggbb, lower case. */
export type Hex = `#${string}`;

/** A colour written as rrggbb or #rrggbb, either case, as #rrggbb; null for anything else. */
export function hexIn(value: unknown): Hex | null {
  if (typeof value !== "string") return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? `#${match[1].toLowerCase()}` : null;
}

/** A colour in OKLCH: lightness 0 to 1, chroma, and hue in degrees, 0 to 360. */
export function oklch(hex: string): [number, number, number] {
  const [l, a, b] = oklab(hex);
  return [l, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

/** How far apart two hues are round the wheel, 0 to 180 degrees. */
export function hueGap(one: number, two: number): number {
  const d = Math.abs(one - two) % 360;
  return d > 180 ? 360 - d : d;
}

/** The colour with its hue turned by `degrees`, as light and as strong as it was (as far as sRGB allows). */
export function turned(hex: string, degrees: number): string {
  const [l, c, h] = oklch(hex);
  return oklchHex(l, c, h + degrees);
}
