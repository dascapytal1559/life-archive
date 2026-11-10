// Hiding a few of a layer's marks without drawing the layer again. Orbits and
// the Spider web draw everyone's marks once, in a layer of their own, and
// whoever is picked out again over it (Orbits.tsx); their own marks in the
// layer beneath are hidden meanwhile, so nothing of them shows twice. Each mark
// there is tagged with whose it is (data-p), and a pick hides and shows only
// those of the people it changes.

import { useLayoutEffect, useRef, type RefObject } from "react";

/** A mark: an element of the layer, an SVG one on the map. */
type Mark = HTMLElement | SVGElement;

/** The marks under `root`, by whose they are (their data-p). */
export function marksOf(root: ParentNode): Map<number, Mark[]> {
  const marks = new Map<number, Mark[]>();
  for (const mark of root.querySelectorAll<Mark>("[data-p]")) {
    const id = Number(mark.dataset.p);
    const theirs = marks.get(id);
    if (theirs) theirs.push(mark);
    else marks.set(id, [mark]);
  }
  return marks;
}

/**
 * Hides the marks of everyone in `next` and shows again those of everyone in
 * `before` who is not: only theirs are touched, and with `all`, after the
 * layer is drawn again (its marks perhaps new), everyone's in either. Hidden
 * by visibility, which moves nothing, so nothing is laid out again for it.
 */
export function swapHidden(marks: ReadonlyMap<number, readonly Mark[]>, before: ReadonlySet<number>, next: ReadonlySet<number>, all = false): void {
  const touched = new Set([...before, ...next]);
  for (const id of touched) {
    if (!all && before.has(id) === next.has(id)) continue;
    for (const mark of marks.get(id) ?? []) mark.style.visibility = next.has(id) ? "hidden" : "";
  }
}

/**
 * Keeps the marks of everyone in `hidden` hidden in the layer at `root`,
 * before the browser paints: `drawing` is what the layer holds, and a new one
 * means its marks are found again.
 */
export function useHiddenMarks(root: RefObject<Element | null>, hidden: ReadonlySet<number>, drawing: unknown): void {
  const kept = useRef<{ drawing: unknown; marks: Map<number, Mark[]>; hidden: ReadonlySet<number> }>({ drawing: undefined, marks: new Map(), hidden: new Set() });
  useLayoutEffect(() => {
    const layer = root.current;
    if (!layer) return;
    const was = kept.current;
    const redrawn = was.drawing !== drawing;
    if (redrawn) kept.current = { ...was, drawing, marks: marksOf(layer) };
    swapHidden(kept.current.marks, was.hidden, hidden, redrawn);
    kept.current.hidden = hidden;
  }, [root, hidden, drawing]);
}
