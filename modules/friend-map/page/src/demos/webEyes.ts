// The spider's eyes (webSpider.ts draws them): a life of their own. They
// blink, double blink, glance aside and scan slowly at random moments, never
// on a loop, and they follow whoever is looked at, brightening.
// Under reduced motion they are open, steady and bright. Pure, so it can be
// tested.

import { easeCubicIn, easeCubicOut } from "d3";
import { lerp, type XY } from "./webDraw.ts";

/** The eyes at one moment: how open (1 open, 0 shut), where they look (-1 to 1 each way), and how bright. */
export interface Eyes {
  open: number;
  gaze: XY;
  glow: number;
}

export type EyeKind = "blink" | "double" | "glance" | "scan";

export interface EyeAct {
  kind: EyeKind;
  start: number;
  length: number;
  /** Where a glance looks. */
  dir: XY;
}

/** What the eyes are doing, and when they next do something. */
export interface EyeState {
  act: EyeAct | null;
  next: number;
}

export function newEyeState(now: number): EyeState {
  return { act: null, next: now + 1200 };
}

/** The next thing the eyes do, chosen at random: mostly a blink, sometimes a double blink, a glance aside, or a slow scan. */
export function pickEyeAct(now: number, random: () => number): EyeAct {
  const roll = random();
  const angle = random() * Math.PI * 2;
  const reach = 0.6 + random() * 0.4;
  const dir = { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach * 0.6 };
  if (roll < 0.5) return { kind: "blink", start: now, length: 150, dir };
  if (roll < 0.62) return { kind: "double", start: now, length: 380, dir };
  if (roll < 0.88) return { kind: "glance", start: now, length: 700 + random() * 500, dir };
  return { kind: "scan", start: now, length: 1800, dir };
}

/** How long, after one act, until the next: a second and a half to nearly six. */
export function restAfter(now: number, random: () => number): number {
  return now + 1400 + random() * 4200;
}

/**
 * The eyes at `now`: the act under way (started when its time came, `state`
 * kept between frames) over their rest, following `look` (where the hovered
 * person is, as the eyes see it, or null), brighter while they do.
 * Under reduced motion they are open, steady and bright.
 */
export function eyesAt(state: EyeState, now: number, random: () => number, options: { reduced: boolean; look: XY | null }): Eyes {
  const { reduced, look } = options;
  const base: XY = look ? { x: look.x * 0.6, y: look.y * 0.6 } : { x: 0, y: 0 };
  if (reduced) return { open: 1, gaze: base, glow: 1 };
  if (state.act && now >= state.act.start + state.act.length) {
    state.act = null;
    state.next = restAfter(now, random);
  }
  if (!state.act && now >= state.next) state.act = pickEyeAct(now, random);
  let open = 1;
  let gaze = base;
  const glow = 1 + 0.08 * Math.sin(now / 700) + (look ? 0.25 : 0);
  const act = state.act;
  if (act) {
    const p = Math.min(1, Math.max(0, (now - act.start) / act.length));
    if (act.kind === "blink") open = 1 - Math.sin(Math.PI * p);
    else if (act.kind === "double") open = 1 - Math.abs(Math.sin(2 * Math.PI * p));
    else if (act.kind === "glance") {
      const g = p < 0.25 ? easeCubicOut(p / 0.25) : p > 0.75 ? 1 - easeCubicIn((p - 0.75) / 0.25) : 1;
      gaze = { x: lerp(base.x, act.dir.x, g), y: lerp(base.y, act.dir.y, g) };
    } else gaze = { x: Math.sin(2 * Math.PI * p) * 0.9, y: base.y };
  }
  return { open, gaze, glow };
}
