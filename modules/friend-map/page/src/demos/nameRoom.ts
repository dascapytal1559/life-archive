// What a name fitted round the sun must stay clear of (fitNames in
// orbitsLayout.ts): the names placed so far and the marks kept clear (the ring
// labels), held in square cells, so asking whether a spot is free looks only
// at what is near it, however many hundreds are on the map. Pure geometry, no
// DOM.

import type { Box } from "./orbitsLayout.ts";

/** The cells' width, in pixels: a little over a name's height, a few to a name's width. */
const CELL = 32;

/** Items bucketed by the square cells their boxes reach into. */
class Cells<T> {
  private cells = new Map<number, T[]>();

  /** Visits the key of every cell `box` reaches into, until `visit` says stop. */
  private span(box: Box, visit: (key: number) => boolean | void): boolean {
    const [i0, i1, j0, j1] = [Math.floor(box.left / CELL), Math.floor(box.right / CELL), Math.floor(box.top / CELL), Math.floor(box.bottom / CELL)];
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) if (visit((i + 32_768) * 65_536 + (j + 32_768)) === true) return true;
    }
    return false;
  }

  add(item: T, box: Box): void {
    this.span(box, (key) => {
      const list = this.cells.get(key);
      if (list) list.push(item);
      else this.cells.set(key, [item]);
    });
  }

  remove(item: T, box: Box): void {
    this.span(box, (key) => {
      const list = this.cells.get(key);
      const at = list?.indexOf(item) ?? -1;
      if (at >= 0) list!.splice(at, 1);
    });
  }

  /** Whether any item in a cell `box` reaches into passes `test`: a superset of those whose own boxes meet it. */
  some(box: Box, test: (item: T) => boolean): boolean {
    return this.span(box, (key) => this.cells.get(key)?.some(test));
  }
}

/** The boxes taken so far: `free` says whether a name may go somewhere, `blockers` what is in its way, and `take` places it. */
export class NameRoom {
  private boxes = new Cells<Box>();

  /** Whether `box` covers nothing taken. */
  free(box: Box): boolean {
    return !this.boxes.some(box, (t) => boxesMeet(t, box));
  }

  /** Everything taken that `box` covers: none where it is free. */
  blockers(box: Box): Box[] {
    const found = new Set<Box>();
    this.boxes.some(box, (t) => {
      if (boxesMeet(t, box)) found.add(t);
      return false;
    });
    return [...found];
  }

  take(box: Box): void {
    this.boxes.add(box, box);
  }
}

/** Whether two boxes overlap. */
export function boxesMeet(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
