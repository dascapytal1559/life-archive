// The person panel's colours on the map views (Demos.tsx sets them on the
// page as --panel-glow and --panel-beam; demos.css makes the dark card from
// them), so the card belongs with the view it docks beside. On the Spider web
// they are its strands and its rings, in Amber or worked out from a custom
// colour as the rest of the web is (webTheme.ts); on Orbits, the sun in its
// theme colour (orbitsTheme.ts) and the teal Orbits draws the other person
// in; every other view keeps the sun's orange and that teal, the
// stylesheet's own (--me and --them in demos.css).

import type { CSSProperties } from "react";
import { COLORS } from "./palette.ts";
import { themeSun, useOrbitsTheme } from "./orbitsTheme.ts";
import { useWebColour, type WebColour } from "./webColour.ts";
import { webTheme } from "./webTheme.ts";

/** The two colours the card is made from: the glow (its lines, labels and accents) and the beam (its second colour, the badges'). */
export interface PanelGlow {
  "--panel-glow": string;
  "--panel-beam": string;
}

/** The panel's colours on the view at `slug`, given the Spider web's colour and Orbits' theme colour; null on the views that keep the stylesheet's. */
export function panelGlow(slug: string, web: WebColour, orbits: string): PanelGlow | null {
  if (slug === "web") {
    const { strand, rings } = webTheme(web).ink;
    return { "--panel-glow": strand, "--panel-beam": rings };
  }
  if (slug === "orbits") return { "--panel-glow": themeSun(orbits), "--panel-beam": COLORS.them };
  return null;
}

/** The panel's colours on the view at `slug`, as a style for the page, following the colours as they are chosen. */
export function usePanelGlow(slug: string): CSSProperties | undefined {
  const web = useWebColour();
  const orbits = useOrbitsTheme();
  return (panelGlow(slug, web, orbits) as CSSProperties | null) ?? undefined;
}
