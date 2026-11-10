// Pointing at a dot, or tapping it on a phone, shows its date and what rituals says of it, above it (DotRows.tsx and
// RunRows.tsx share it): a dot is any element with data-dot, its words its aria-label.

import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { tipCentre, type Mark } from "./dots.ts";

/** The dot pointed at: its words, and where it is in the block. */
interface Pointed {
  key: string;
  text: string;
  x: number;
  y: number;
}

/** A mark's class, as the sheets name it. */
export const MARK_CLASS: Record<Mark, string> = { done: "done", not_done: "not-done", open: "open", late: "late", untimed: "untimed", overdue: "overdue" };

export function usePointing() {
  const block = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [pointed, setPointed] = useState<Pointed | null>(null);

  // Over its dot, but whole: the card cuts off whatever passes the block's edges.
  useLayoutEffect(() => {
    if (pointed && tipRef.current && block.current) tipRef.current.style.left = `${tipCentre(pointed.x, tipRef.current.offsetWidth, block.current.clientWidth)}px`;
  }, [pointed]);

  const point = (event: ReactMouseEvent) => {
    const dot = (event.target as HTMLElement).closest<HTMLElement>("[data-dot]");
    if (!dot || !block.current) return;
    const at = dot.getBoundingClientRect();
    const box = block.current.getBoundingClientRect();
    setPointed({ key: dot.dataset.dot!, text: dot.getAttribute("aria-label") ?? "", x: at.left + at.width / 2 - box.left, y: at.top - box.top });
  };

  const tip: ReactNode = pointed && (
    <div className="dots__tip" ref={tipRef} role="status" style={{ top: pointed.y }}>
      {pointed.text}
    </div>
  );

  return {
    block,
    /** The key of the dot pointed at, if any. */
    pointedKey: pointed?.key ?? null,
    /** The handlers for the element holding the dots. */
    handlers: {
      onPointerOver: point,
      onClick: point,
      onPointerLeave: (event: ReactPointerEvent) => event.pointerType === "mouse" && setPointed(null),
    },
    clear: () => setPointed(null),
    tip,
  };
}
