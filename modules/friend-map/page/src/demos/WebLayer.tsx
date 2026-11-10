// The canvases round Orbits' SVG on the Spider web view: one under it, with the
// ground, the web, the halos, the spider and its threads, and one over it,
// with the beam and reticle of whoever is looked at, hovered or selected,
// above everything (webLook.ts draws both, every animation frame,
// from the latest scene Orbits gave it and from what is in motion: the
// throws and the boot, webChoreography.ts; what of the web holds still it
// draws once for each scene, on a third canvas kept off the page, and copies
// in). The SVG goes between them, as
// this component's child. Canvas 2D, not SVG, so a thousand strands and a few
// dozen moving threads cost one path stroke each a frame, with nothing in the
// DOM to re-lay-out: the SVG keeps the people, their identicons, names and
// everything the pointer touches, exactly as Orbits draws them. Under reduced
// motion both are drawn once per change, still, with no loop. The spider
// faces a way chosen once when the Spider web loads (startHeading: at random, unless
// the address says), so it starts there in motion and stays there when still.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { presetOf } from "./webColour.ts";
import { drawWeb, drawWebOver, newLookState, newStillWeb, startHeading, type LookState, type WebMotion, type WebScene } from "./webLook.ts";

/** The most pixels per CSS pixel the canvases are drawn at: sharp on a Retina screen, no more work than that. */
const MAX_DPR = 2;

export function WebLayer({ scene, motion, children }: { scene: WebScene; motion: { current: WebMotion }; children: ReactNode }) {
  const under = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const latest = useRef(scene);
  latest.current = scene;
  const { width, height, colour, reduced } = scene;
  const [heading] = useState(() => startHeading(globalThis.location?.search ?? "", Math.random));
  // What of the web holds still, drawn once for each scene and kept between frames (webLook.ts).
  const [still] = useState(newStillWeb);

  // Still: drawn once for each change.
  useEffect(() => {
    if (!reduced || !under.current || !over.current) return;
    draw(under.current, over.current, latest.current, motion.current, performance.now(), newLookState(heading, still));
  });

  // In motion: a loop while the page is visible.
  useEffect(() => {
    if (reduced || !under.current || !over.current) return;
    const [a, b] = [under.current, over.current];
    const state = newLookState(heading, still);
    let raf = 0;
    const tick = (now: number) => {
      draw(a, b, latest.current, motion.current, now, state);
      raf = requestAnimationFrame(tick);
    };
    const visibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(tick);
    };
    document.addEventListener("visibilitychange", visibility);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [reduced, motion, heading, still]);

  return (
    <>
      <canvas ref={under} className={`orbits-web orbits-web--under orbits-web--${presetOf(colour)}`} style={{ width, height }} aria-hidden />
      {children}
      <canvas ref={over} className={`orbits-web orbits-web--over orbits-web--${presetOf(colour)}`} style={{ width, height }} aria-hidden />
    </>
  );
}

function fit(canvas: HTMLCanvasElement, scene: WebScene, dpr: number): CanvasRenderingContext2D | null {
  const w = Math.round(scene.width * dpr);
  const h = Math.round(scene.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function draw(under: HTMLCanvasElement, over: HTMLCanvasElement, scene: WebScene, motion: WebMotion, now: number, state: LookState): void {
  const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
  const a = fit(under, scene, dpr);
  const b = fit(over, scene, dpr);
  if (!a || !b) return;
  drawWeb(a, scene, motion, now, state, dpr);
  drawWebOver(b, scene, now, state);
}
