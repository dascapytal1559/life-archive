// The Spider web view's boot (Orbits.tsx with the web look): a flicker, then a
// scan line from the top of the stage to the bottom that materialises the web
// and brings in each person as it reaches them. It plays when the Spider web opens
// and again whenever you re-query (useTween's replay, orbitsSky.ts).
// This file is the timing alone, pure, so it can be tested: when each person
// appears (appearAt), the boot's choreography for useTween (webBoot), and the
// easings the drawing (webLook.ts) shares with it.

import { easeCubicOut } from "d3";
import type { Choreography, Entrance } from "./orbitsSky.ts";

// Easings, named here so the drawing and a test speak of the same curve.

/** A line's run from the spider's mouth (the hover beam, the hold): fast out, settling as it lands. */
export const travelEase = easeCubicOut;

/** A back-ease: overshoots a little past 1 before settling, for a snap that lands. */
export function easeOutBack(p: number, overshoot = 1.7): number {
  const q = p - 1;
  return 1 + (overshoot + 1) * q * q * q + overshoot * q * q;
}

/** An expo ease-out: nearly all of the move in the first part, for a whip or a recoil. */
export function easeOutExpo(p: number): number {
  return p >= 1 ? 1 : 1 - Math.pow(2, -10 * p);
}

/** When the scan line starts, after the flicker, and how long it takes to run down the stage; BOOT_MS the whole boot. */
export const SCAN = { from: 250, length: 900 };
export const BOOT_MS = 1900;
/** How long each person takes to lock in once the scan reaches them, in ms. */
const LOCK_MS = 280;

/**
 * When a person at `spot` (relative to the sun, unzoomed) appears as the Spider web
 * boots, and how long that takes: when the scan line, running down the stage
 * (`cy` the sun's height on it, `height` its height), reaches their height.
 * Without a stage (a test, or Orbits 3D's entrance), by their height within
 * `reach` of the sun.
 */
export function appearAt(spot: { angle: number; r: number }, stage: { cy?: number; height?: number }, reach: number): { delay: number; length: number } {
  const y = Math.sin(spot.angle) * spot.r;
  const share = stage.cy !== undefined && stage.height ? (stage.cy + y) / stage.height : (y + reach) / (2 * reach);
  return { delay: SCAN.from + SCAN.length * Math.min(1, Math.max(0, share)), length: LOCK_MS };
}

/** When the boot began, for the web layer to draw it from (null before, or under reduced motion). */
export interface WebMotion {
  bootStart: number | null;
}

/**
 * The Spider web's choreography for useTween: people condense in place as the scan
 * reaches them (appearAt), each move after that as on Orbits, and the boot's
 * start goes into `motion`, which the web layer draws the scan from.
 */
export function webBoot(motion: { current: WebMotion }): Choreography {
  return {
    entranceFrom: (t) => ({ ...t, size: t.size * 0.3, opacity: 0, glow: 0 }),
    entrance: (t, stage: Entrance) => ({ ...appearAt({ angle: t.angle, r: t.r }, stage, stage.outer + 11), ease: (p) => easeOutBack(p, 1.2) }),
    began(now) {
      motion.current.bootStart = now;
    },
  };
}
