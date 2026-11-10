// The Spider web's colours (webColour.ts): the canvas's inks (webLook.ts, and the
// spider's, webSpider.ts, made from them), Orbits' own SVG marks restyled
// (LookPalette), and the stylesheet's (orbits.css, as custom properties on the
// SVG). Amber is tuned by hand. A custom colour is worked out from its hue
// alone (customTheme): the strands in it, light and strong, the accents a
// little further round the wheel, a partner across the wheel for the rings,
// the sun's glow and the cool trails, and the ground and the spider's dark
// faintly tinted with it. The beam, the eyes and the scan line are the
// Spider web's teal in every colour, a teal custom colour included.

import { oklchHex } from "../identicon.ts";
import type { LookPalette } from "./orbitsTheme.ts";
import { oklch } from "./themeColour.ts";
import type { WebColour } from "./webColour.ts";
import { rgba } from "./webDraw.ts";

/** A colour's inks for the canvas. */
export interface Ink {
  background: string;
  grid: string;
  /** The spokes, the rings, and the accents (brackets, the reticle). */
  strand: string;
  rings: string;
  accent: string;
  /** The threads' beam, the scan line, the spider's eyes. */
  beam: string;
  scan: string;
  eye: string;
  /** The chromatic split's two copies. */
  split: [string, string];
  /** The haze over the ground: at the sun, and at the edges. */
  haze: [string, string];
  /** The dark the spider is made of. */
  dark: string;
}

/** The stylesheet's colours for the Spider web (orbits.css): ring labels and accents, the rings, the held person's links, the friend circles. */
export interface WebCss {
  "--web-accent": string;
  "--web-ring": string;
  "--web-link": string;
  "--web-circle": string;
}

export interface WebTheme {
  ink: Ink;
  palette: LookPalette;
  css: WebCss;
}

/** The Spider web's own teal and amber: the teal is the beam's in every colour. */
export const TEAL = "#39d8ff";
const AMBER = "#ffb347";

const AMBER_THEME: WebTheme = {
  ink: {
    background: "#030812", grid: "rgba(57, 216, 255, 0.07)", strand: AMBER, rings: TEAL, accent: AMBER, beam: TEAL, scan: TEAL, eye: TEAL,
    split: ["#ff3b6b", TEAL], haze: ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0.45)"], dark: "#070c17",
  },
  palette: {
    sun: [[0, TEAL, 0.22], [0.5, TEAL, 0.06], [1, TEAL, 0]],
    body: { lit: "#ffffff", silent: "rgba(57, 216, 255, 0.45)", plain: () => "rgba(255, 179, 71, 0.75)", width: { lit: 1.8, silent: 1, plain: 1 } },
    trail: { warm: AMBER, cool: TEAL },
  },
  css: { "--web-accent": "rgba(255, 179, 71, 0.8)", "--web-ring": "rgba(255, 179, 71, 0.16)", "--web-link": "rgba(57, 216, 255, 0.55)", "--web-circle": "rgba(57, 216, 255, 0.35)" },
};

/** The whole theme worked out from one colour (#rrggbb): see the head of this file. */
export function customTheme(colour: string): WebTheme {
  const [, chroma, hue] = oklch(colour);
  // Strong enough to glow, whatever was picked; a grey stays nearly grey.
  const c = Math.min(0.19, chroma);
  const strand = oklchHex(0.8, c, hue);
  const accent = oklchHex(0.74, Math.max(c, Math.min(0.2, chroma * 1.2)), hue + 35);
  const partner = oklchHex(0.8, Math.max(0.1, Math.min(0.14, c)), hue + 150);
  const background = oklchHex(0.13, 0.03, hue);
  return {
    ink: {
      background, grid: rgba(partner, 0.07), strand, rings: partner, accent, beam: TEAL, scan: TEAL, eye: TEAL,
      split: ["#ff3b6b", partner], haze: ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0.5)"], dark: oklchHex(0.17, 0.035, hue),
    },
    palette: {
      sun: [[0, partner, 0.22], [0.5, partner, 0.06], [1, partner, 0]],
      body: { lit: "#ffffff", silent: rgba(partner, 0.45), plain: () => rgba(strand, 0.75), width: { lit: 1.8, silent: 1, plain: 1 } },
      trail: { warm: strand, cool: partner },
    },
    css: { "--web-accent": rgba(accent, 0.8), "--web-ring": rgba(strand, 0.16), "--web-link": rgba(TEAL, 0.55), "--web-circle": rgba(partner, 0.35) },
  };
}

const custom = new Map<string, WebTheme>();

/** The Spider web's theme in a colour: Amber's, or one worked out from a custom colour. */
export function webTheme(colour: WebColour): WebTheme {
  if (colour === "amber") return AMBER_THEME;
  let theme = custom.get(colour);
  if (!theme) {
    // A colour picker dragged makes a new one every step; keep only the latest few.
    if (custom.size > 32) custom.clear();
    theme = customTheme(colour);
    custom.set(colour, theme);
  }
  return theme;
}
