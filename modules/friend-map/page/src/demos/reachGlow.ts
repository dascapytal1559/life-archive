// How strongly everyone you should reach out to glows: a slider, Reach-out
// glow, in the settings in the menu (viewSettings.ts) of every view that
// glows (Orbits, Orbits 3D, Circles, the Spider web and the City), one
// setting for them all. 0, the usual look, until it is moved; up to 1, a glow
// that reaches about twice as far and is plainly brighter, drawn on someone
// lifted toward full strength however far out they are, and past halfway
// breathes gently (never with reduced motion). Saved on friend-map's server in
// the real app and the demo's default (savedStore.ts), as the Spider web's
// settings are, not in the address. glowLook is what each view draws from it.
// No name except… (names.ts), the map shown to someone, draws no reach-out
// glow at all, whatever the setting (glowsOf).

import { demoMode } from "../demoMode.ts";
import { useStore } from "../keptSetting.ts";
import { NOBODY, useNameStyle } from "../names.ts";
import { savedSetting } from "../savedStore.ts";

/** Where the setting is kept. */
export const REACH_GLOW_KEY = "friend-map.reach-glow";
/** The glow until one is chosen: the usual look. */
export const DEFAULT_REACH_GLOW = 0;

/** A reach-out glow as a number from 0 to 1; anything else is `fallback`. */
export function reachGlowOf(value: unknown, fallback: number = DEFAULT_REACH_GLOW): number {
  const n = typeof value === "string" && value !== "" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

/** An app's reach-out glow, 0 to 1 (the demo's, `demo`, or the real one's). */
export function makeReachGlowStore(demo: boolean) {
  return savedSetting(REACH_GLOW_KEY, demo, DEFAULT_REACH_GLOW, (kept, fallback) => reachGlowOf(kept ?? undefined, fallback));
}

/** This page's: the demo's in the demo, the real app's everywhere else. */
export const reachGlowStore = makeReachGlowStore(demoMode);

/** The setting as the views draw it: as set, but the usual look while No name except… is on, so nobody to reach out to is lifted either (glowsOf). */
export function useReachGlow(): number {
  const boost = useStore(reachGlowStore);
  return useNameStyle() === "except" ? DEFAULT_REACH_GLOW : boost;
}

/** The slider's label for a glow: Usual at 0, else how far toward the strongest. */
export function reachGlowLabel(boost: number): string {
  return boost <= 0 ? "Usual" : `+${Math.round(boost * 100)}%`;
}

/** What the glow round a marker is at a setting. */
export interface GlowLook {
  /** How much farther than usual it reaches past the marker: 1, up to 2.2 at the strongest. */
  reach: number;
  /** Orbits' gradient's opacity at its core and halfway out: 0.75 and 0.22 as usual, up to 1 and 0.5. */
  core: number;
  mid: number;
  /** How much brighter its core is than usual, for a glow whose gradient is fixed (Orbits 3D's): 1, up to a third more, to full. */
  gain: number;
  /** How much brighter than usual it is drawn where there is no gradient to change (the Spider web's halo, the City's beams): 1, up to 1.6. */
  bright: number;
  /** How much it breathes: none up to halfway, then up to 1 at the strongest. */
  pulse: number;
  /**
   * How far the least strength someone to reach out to is drawn at, marker, name and glow alike, is lifted from the
   * faintest tier's toward full (personOpacity in orbitsLayout.ts): none as usual, up to three quarters, so a glow
   * far out is not dimmed with its tier.
   */
  lift: number;
}

/** The glow at the setting `boost` (0, the usual look, to 1). */
export function glowLook(boost: number): GlowLook {
  const b = reachGlowOf(boost, 0);
  const core = 0.75 + 0.25 * b;
  return {
    reach: 1 + 1.2 * b,
    core,
    mid: 0.22 + 0.28 * b,
    gain: core / 0.75,
    bright: 1 + 0.6 * b,
    pulse: Math.max(0, (b - 0.5) / 0.5),
    lift: 0.75 * b,
  };
}

/**
 * Whose reach-out glows are drawn: everyone's (null), but while someone is held (`holding`, heldOnly's in Orbits.tsx:
 * they and whoever shares group chats with them) only theirs, so the glows left are the hold's own; everyone else's
 * comes back once they are let go, and someone only under the pointer leaves every glow. While No name except… keeps
 * names off the page (`hidden`), nobody's, held or not, so a map shown to someone never says whom you should reach out
 * to (the user's asks).
 */
export function glowsOf(holding: ReadonlySet<number> | null, hidden: boolean): ReadonlySet<number> | null {
  return hidden ? NOBODY : holding;
}

/** Whether `id`'s reach-out glow is drawn, among those glowsOf gives (`glowing`). */
export function glowShown(id: number, glowing: ReadonlySet<number> | null): boolean {
  return glowing === null || glowing.has(id);
}

/** How long one breath of a pulsing glow takes, in and out, in ms. */
export const PULSE_MS = 2400;

/** A pulsing glow's swell at `now` (ms), 0 to 1 and back, every PULSE_MS: for the views drawn on a canvas each frame. */
export function pulseAt(now: number): number {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * now) / PULSE_MS);
}

/** How much more a pulsing glow is at the top of a breath, at the strongest: a marker's glow reaches 12% farther, a name's halo is 30% stronger. */
export const SWELL = { reach: 0.12, halo: 0.3 } as const;
