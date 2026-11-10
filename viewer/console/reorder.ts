// Dragging the rail's aspects into an order (order.ts keeps it; Console.tsx draws the rail). Hand-rolled on pointer
// events rather than a library: the rail is one short vertical list, and what makes it feel right (the lifted block
// on the pointer, the others sliding aside, the settle into place) is a few dozen lines on transforms, where a library
// would bring its own model of sensors and collisions for a list of seven.
//
// A press on an aspect is a click until the pointer moves 4 px; past that the aspect lifts and follows the pointer, written straight to its transform each frame (no React render while it
// moves), the others slide out of its way, a slot shows where it would land, and the rail scrolls by itself near its
// ends. Letting go puts it there (and the click that follows is swallowed); Esc or a lost pointer puts it back. The
// commit is FLIP: every block measured where it is drawn, the order changed in one render, each block drawn back where
// it was and let slide home. Keyboard: Option (Alt) with ↑ or ↓ moves the focused aspect a place, said aloud. Mouse,
// pen and keyboard only, on a desk: a touch scrolls, and on a phone nothing moves (by the captain's word).

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { layoutAfter, move, movedWords, slotOf, type Block } from "./order.ts";

/** How far a press moves before it is a drag, in px. */
const THRESHOLD = 4;
/** How long the others take to slide aside, and a drop or a key's move to settle, in ms. */
const SLIDE = 180;
const SETTLE = 220;
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
/** How near the rail's top or bottom the pointer scrolls it, and how fast at the very edge, in px a frame. */
const EDGE = 40;
const SPEED = 14;
/** How far past the first or last aspect a block may be dragged, in px. */
const OVERSHOOT = 12;

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Drag {
  key: string;
  from: number;
  to: number;
  pointer: number;
  /** The pointer's height as the press began, on the screen and in the rail. */
  startY: number;
  startAt: number;
  y: number;
  lifted: boolean;
  /** Let go or put back, its press not yet over. */
  settled: boolean;
  handle: HTMLElement;
  blocks: HTMLElement[];
  measured: Block[];
  frame: number;
}

export interface Reorder {
  /** The rail, which holds the blocks (each `[data-aspect]`) and the slot. */
  rail: RefObject<HTMLElement | null>;
  slot: RefObject<HTMLDivElement | null>;
  /** Spread on an aspect's link: the press that may become a drag, and Option+↑↓. */
  handle: (key: string) => {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    draggable: false;
  };
  /** Puts the keys in `next` order with the blocks sliding there (the default order's button). */
  reorder: (next: readonly string[], words: string) => void;
}

/**
 * The rail's drag and keys over the aspects `keys` (in the rail's order, `label` naming each), calling `commit` with a
 * new order. Off (`enabled` false) nothing moves.
 */
export function useReorder({ keys, label, commit, announce, enabled }: {
  keys: readonly string[];
  label: (key: string) => string;
  commit: (next: string[]) => void;
  announce: (words: string) => void;
  enabled: boolean;
}): Reorder {
  const rail = useRef<HTMLElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  // The latest of what the handlers read, so the handlers are made once and stay the same across renders.
  const now = useRef({ keys, label, commit, announce, enabled });
  now.current = { keys, label, commit, announce, enabled };
  const [{ handle, reorder, end }] = useState(() => controller(rail, slot, now));

  // A drag never outlives the rail, nor its being turned off (the window narrowed to a phone's mid-drag).
  useEffect(() => {
    if (!enabled) end(false);
  }, [enabled, end]);
  useEffect(() => () => end(false), [end]);

  return { rail, slot, handle, reorder };
}

type Now = RefObject<{
  keys: readonly string[];
  label: (key: string) => string;
  commit: (next: string[]) => void;
  announce: (words: string) => void;
  enabled: boolean;
}>;

function controller(rail: RefObject<HTMLElement | null>, slot: RefObject<HTMLDivElement | null>, now: Now) {
  let drag: Drag | null = null;
  // The latest settle (a drop, a key's move, a put-back): an older one finishing leaves the newer's slides alone; and
  // a press while one is under way is no drag, its blocks still in flight.
  let generation = 0;
  let settlingUntil = 0;
  const settling = (ms: number) => {
    settlingUntil = performance.now() + ms;
    return ++generation;
  };

  const blocksOf = () => [...(rail.current?.querySelectorAll<HTMLElement>(":scope > [data-aspect]") ?? [])];
  const railY = (clientY: number) => {
    const box = rail.current!;
    return clientY - box.getBoundingClientRect().top - box.clientTop + box.scrollTop;
  };

  /** Changes the order to `next` in one render, every block sliding from where it was drawn to its new place. */
  const flip = (next: string[], settle?: { key: string; then: () => void }) => {
    const before = new Map(blocksOf().map((block) => [block.dataset.aspect, block.getBoundingClientRect().top]));
    flushSync(() => now.current.commit(next));
    const mine = settling(SETTLE + 80);
    const blocks = blocksOf();
    for (const block of blocks) {
      block.style.transition = "none";
      block.style.transform = "";
    }
    const moved = blocks.flatMap((block) => {
      const delta = (before.get(block.dataset.aspect) ?? 0) - block.getBoundingClientRect().top;
      if (Math.abs(delta) < 0.5) return [];
      block.style.transform = `translate3d(0, ${delta}px, 0)`;
      return [block];
    });
    const done = () => {
      if (mine === generation) for (const block of blocks) block.style.transition = "";
      settle?.then();
    };
    if (moved.length === 0 || calm()) {
      for (const block of moved) block.style.transform = "";
      return done();
    }
    void rail.current?.offsetHeight;
    for (const block of moved) {
      block.style.transition = `transform ${SETTLE}ms ${EASE}`;
      block.style.transform = "";
    }
    const last = blocks.find((block) => block.dataset.aspect === settle?.key) ?? moved[0];
    let finished = false;
    const finish = (event?: TransitionEvent) => {
      // Its own transform's end, not one of its rows' colours bubbling up.
      if (finished || (event && (event.target !== last || event.propertyName !== "transform"))) return;
      finished = true;
      last.removeEventListener("transitionend", finish);
      done();
    };
    last.addEventListener("transitionend", finish);
    setTimeout(finish, SETTLE + 80);
  };

  /**
   * Lays the others out around the dragged block's slot, and the slot under it: gone at once from where it was and
   * faded in where it is once the others have mostly made way, so it never sweeps across them.
   */
  const place = (d: Drag) => {
    const tops = layoutAfter(d.measured, d.from, d.to);
    d.blocks.forEach((block, at) => {
      if (at !== d.from) block.style.transform = `translate3d(0, ${tops[at] - d.measured[at].top}px, 0)`;
    });
    const box = slot.current;
    if (!box) return;
    box.style.transition = "none";
    box.style.opacity = "0";
    box.style.transform = `translate3d(0, ${tops[d.from]}px, 0)`;
    void box.offsetHeight;
    box.style.transition = calm() ? "none" : `opacity 140ms ease ${SLIDE * 0.6}ms`;
    box.style.opacity = "";
  };

  /** Each frame of a drag: the rail scrolled near its ends, the block on the pointer, the slot it is over. */
  const frame = () => {
    const d = drag;
    const box = rail.current;
    if (!d || !box) return;
    const bounds = box.getBoundingClientRect();
    const edge = d.y < bounds.top + EDGE ? -(bounds.top + EDGE - d.y) : d.y > bounds.bottom - EDGE ? d.y - (bounds.bottom - EDGE) : 0;
    if (edge) box.scrollTop += Math.sign(edge) * Math.min(SPEED, Math.ceil((Math.abs(edge) / EDGE) * SPEED));
    const first = d.measured[0];
    const last = d.measured[d.measured.length - 1];
    const own = d.measured[d.from];
    const dy = Math.min(Math.max(railY(d.y) - d.startAt, first.top - own.top - OVERSHOOT), last.top + last.height - own.top - own.height + OVERSHOOT);
    d.blocks[d.from].style.transform = `translate3d(0, ${dy}px, 0)`;
    const to = slotOf(d.measured, d.from, own.top + dy + own.height / 2);
    if (to !== d.to) {
      d.to = to;
      place(d);
    }
    d.frame = requestAnimationFrame(frame);
  };

  const lift = (d: Drag) => {
    const box = rail.current!;
    d.lifted = true;
    d.blocks = blocksOf();
    d.measured = d.blocks.map((block) => ({ top: block.offsetTop, height: block.offsetHeight }));
    d.handle.setPointerCapture(d.pointer);
    box.dataset.dragging = "";
    const own = d.blocks[d.from];
    own.dataset.lifted = "";
    const slide = calm() ? "none" : `transform ${SLIDE}ms ${EASE}`;
    d.blocks.forEach((block, at) => (block.style.transition = at === d.from ? "box-shadow 0.15s ease" : slide));
    if (slot.current) {
      slot.current.style.left = `${own.offsetLeft}px`;
      slot.current.style.width = `${own.offsetWidth}px`;
      slot.current.style.height = `${own.offsetHeight}px`;
      slot.current.dataset.shown = "";
    }
    place(d);
    d.frame = requestAnimationFrame(frame);
  };

  /**
   * Lets go of a lifted block at its slot, or (`keep` false) puts it back where it was. The press itself goes on until
   * its pointerup (Esc puts it back while the button is still down), and its click is swallowed then (end).
   */
  const settle = (d: Drag, keep: boolean) => {
    if (!d.lifted || d.settled) return;
    d.settled = true;
    cancelAnimationFrame(d.frame);
    if (d.handle.hasPointerCapture(d.pointer)) d.handle.releasePointerCapture(d.pointer);
    const box = rail.current;
    if (box) delete box.dataset.dragging;
    if (slot.current) {
      slot.current.style.transition = "opacity 0.12s ease";
      delete slot.current.dataset.shown;
    }
    const own = d.blocks[d.from];
    const unlift = () => delete own.dataset.lifted;
    if (keep && d.to !== d.from) {
      const next = move(now.current.keys, d.from, d.to);
      flip(next, { key: d.key, then: unlift });
      now.current.announce(movedWords(now.current.label(d.key), d.to, next.length));
      return;
    }
    // Back (or let go where it began): every block slides home.
    const slide = calm() ? "none" : `transform ${SETTLE}ms ${EASE}, box-shadow 0.15s ease`;
    for (const block of d.blocks) {
      block.style.transition = slide;
      block.style.transform = "";
    }
    const mine = settling(slide === "none" ? 0 : SETTLE);
    setTimeout(() => {
      unlift();
      if (mine === generation) for (const block of d.blocks) block.style.transition = "";
    }, slide === "none" ? 0 : SETTLE);
    if (!keep) now.current.announce(`${now.current.label(d.key)} put back.`);
  };

  /** Ends a press: settled as `keep` says if it was not yet, and the click after a drag's pointerup swallowed. */
  const end = (keep: boolean) => {
    const d = drag;
    if (!d) return;
    drag = null;
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", onUp);
    removeEventListener("pointercancel", onCancel);
    removeEventListener("keydown", onKey, true);
    if (!d.lifted) return;
    settle(d, keep);
    // A drag's pointerup is followed by a click on the link; it is no click.
    const swallow = (event: Event) => (event.preventDefault(), event.stopPropagation());
    addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener("click", swallow, { capture: true }), 0);
  };

  const onMove = (event: globalThis.PointerEvent) => {
    const d = drag;
    if (!d || event.pointerId !== d.pointer || d.settled) return;
    d.y = event.clientY;
    if (!d.lifted && Math.abs(event.clientY - d.startY) >= THRESHOLD) lift(d);
    if (d.lifted) event.preventDefault();
  };
  const onUp = (event: globalThis.PointerEvent) => event.pointerId === drag?.pointer && end(true);
  const onCancel = (event: globalThis.PointerEvent) => event.pointerId === drag?.pointer && end(false);
  const onKey = (event: globalThis.KeyboardEvent) => {
    if (event.key !== "Escape" || !drag?.lifted || drag.settled) return;
    event.preventDefault();
    event.stopPropagation();
    settle(drag, false);
  };

  const handle = (key: string) => ({
    draggable: false as const,
    onDragStart: (event: DragEvent<HTMLElement>) => event.preventDefault(),
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      const { keys, enabled } = now.current;
      if (!enabled || drag || event.pointerType === "touch" || event.button !== 0 || performance.now() < settlingUntil) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const from = keys.indexOf(key);
      if (from === -1 || !rail.current) return;
      drag = {
        key, from, to: from, pointer: event.pointerId, startY: event.clientY, startAt: railY(event.clientY), y: event.clientY,
        lifted: false, settled: false, handle: event.currentTarget, blocks: [], measured: [], frame: 0,
      };
      addEventListener("pointermove", onMove, { passive: false });
      addEventListener("pointerup", onUp);
      addEventListener("pointercancel", onCancel);
      addEventListener("keydown", onKey, true);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const { keys, enabled, label, announce } = now.current;
      if (!enabled || !event.altKey || event.metaKey || event.ctrlKey || drag) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const from = keys.indexOf(key);
      const to = from + (event.key === "ArrowUp" ? -1 : 1);
      if (to < 0 || to >= keys.length) return announce(movedWords(label(key), from, keys.length, false));
      flip(move(keys, from, to), { key, then: () => {} });
      // Moving a link in the page drops its focus; it keeps it here.
      rail.current?.querySelector<HTMLElement>(`[data-aspect="${key}"] [data-nav]`)?.focus({ preventScroll: true });
      announce(movedWords(label(key), to, keys.length));
    },
  });

  const reorder = (next: readonly string[], words: string) => {
    flip([...next]);
    now.current.announce(words);
  };

  return { handle, reorder, end };
}
