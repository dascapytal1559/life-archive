// The size the map views are drawn at (Demos.tsx), and the size of the map
// they are seen in. On a view that keeps its size (Orbits, Circles and the
// Spider web: Demo.keepsSize), the stage stays the window's size while the
// docked person panel opens over it, so the drawing never changes size for the
// panel; on the other live views the map's stage narrows
// while the docked person panel slides in and widens while it slides out, on
// the panel's own transition (--dock-move in demos.css). Drawing the map again
// every frame of that would cost a redraw a frame, so the drawing changes size
// at most once a slide and meanwhile, centred in the stage (orbits.css), slides
// with the map's centre. It is never narrower than the stage, which would leave
// bare strips beside it: it grows at once, to where the stage's slide ends (its
// room, an unseen box on no transition), on the frame the slide starts, and
// shrinks only once the stage has held still past the slide. Until then its
// overflow is under the panel or past the window's edge.

import { startTransition, useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

export type Size = { width: number; height: number };

/** The smallest size that covers both. */
export function cover(a: Size, b: Size): Size {
  return { width: Math.max(a.width, b.width), height: Math.max(a.height, b.height) };
}

/**
 * Follows the stage's and its room's sizes as they are observed, and calls `draw` whenever the size to draw the map
 * at changes: with `now` when it must land before this frame is painted (the first size, and growing), otherwise
 * once the stage has held still for `settleMs`.
 */
export function mapSizer(settleMs: number, draw: (size: Size, now: boolean) => void) {
  let drawn: Size | null = null;
  let room: Size | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const take = (size: Size, now: boolean) => {
    if (drawn && size.width === drawn.width && size.height === drawn.height) return;
    drawn = size;
    draw(size, now);
  };
  return {
    /** Where the stage is headed: taken at once where it is bigger than the drawing. */
    room(size: Size) {
      room = size;
      if (drawn) take(cover(drawn, size), true);
    },
    /** The stage's own size, partway through a slide or at its end. */
    stage(size: Size) {
      clearTimeout(timer);
      // The room as it is when taken: the panel may have turned back meanwhile.
      if (!drawn) take(room ? cover(size, room) : size, true);
      else timer = setTimeout(() => take(room ? cover(size, room) : size, false), settleMs);
    },
    stop() {
      clearTimeout(timer);
    },
  };
}

/**
 * Refs for the map's stage and its room, the size to draw the map at (mapSizer), and the room's: the map as it is
 * seen, beside the docked panel or not. Growing lands on the frame the room grows (a ResizeObserver's callback runs
 * before that frame is painted); shrinking as a transition, so whatever the panel has just loaded draws ahead of the
 * redraw.
 */
export function useMapSize<T extends HTMLElement>(settleMs: number): [RefObject<T | null>, RefObject<T | null>, Size, Size] {
  const stageRef = useRef<T>(null);
  const roomRef = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [seen, setSeen] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const [stage, room] = [stageRef.current, roomRef.current];
    if (!stage || !room) return;
    const sizer = mapSizer(settleMs, (next, now) => (now ? flushSync : startTransition)(() => setSize(next)));
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const at = { width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) };
        if (entry.target === room) {
          sizer.room(at);
          setSeen((was) => (was.width === at.width && was.height === at.height ? was : at));
        } else sizer.stage(at);
      }
    });
    observer.observe(room);
    observer.observe(stage);
    return () => {
      observer.disconnect();
      sizer.stop();
    };
  }, [settleMs]);
  return [stageRef, roomRef, size, seen];
}
