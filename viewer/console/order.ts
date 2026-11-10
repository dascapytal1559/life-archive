// The rail's order: the captain may drag the aspects into an order of his own (Console.tsx, reorder.ts).
// It is kept on this device alone (ORDER_KEY in localStorage, as the look is): the archive has no place
// for the console's preferences on the server, and an order is a matter of one screen's habits. Only the aspects move;
// an aspect's views keep the registry's order under it. What is kept is the aspects' keys; an aspect the console has
// since dropped is forgotten, one renamed is found by its former key, and one added since sits where the registry puts
// it, after the aspect it follows there.
// The phone's list of pages shows the same order but do not change it (by the captain's word).
// Below the order, the arithmetic of a drag: where each aspect sits once the dragged one is let go at a slot.

import type { Aspect } from "./registry.ts";

/** Where the order is kept on this device. */
export const ORDER_KEY = "life-archive.console.order";

/** The keys an order kept on this device names, in its order; none for nothing kept or anything unreadable. */
export function storedKeys(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const keys: unknown = JSON.parse(stored);
    return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The aspects in the order `keys` names: each it names that the console has (by its key or a former one), once, in that order, and each it does not
 * name placed after the aspect it follows in the registry (first, if it is the registry's first).
 */
export function orderAspects(keys: readonly string[], aspects: readonly Aspect[]): Aspect[] {
  const known = new Map(aspects.flatMap((aspect) => [aspect.key, ...(aspect.formerKeys ?? [])].map((key) => [key, aspect] as const)));
  const ordered: Aspect[] = [];
  for (const key of keys) {
    const aspect = known.get(key);
    if (aspect && !ordered.includes(aspect)) ordered.push(aspect);
  }
  aspects.forEach((aspect, at) => {
    if (ordered.includes(aspect)) return;
    const after = at === 0 ? -1 : ordered.indexOf(aspects[at - 1]);
    ordered.splice(after + 1, 0, aspect);
  });
  return ordered;
}

/** Whether `ordered` is the registry's own order. */
export const isDefaultOrder = (ordered: readonly Aspect[], aspects: readonly Aspect[]) =>
  ordered.length === aspects.length && ordered.every((aspect, at) => aspect.key === aspects[at].key);

/** What to keep for an order: its keys, or nothing (null) for the registry's own, so a new default reaches him. */
export const orderToStore = (ordered: readonly Aspect[], aspects: readonly Aspect[]): string | null =>
  isDefaultOrder(ordered, aspects) ? null : JSON.stringify(ordered.map((aspect) => aspect.key));

/** `items` with the one at `from` moved to `to` (both clamped to the list). */
export function move<T>(items: readonly T[], from: number, to: number): T[] {
  const last = items.length - 1;
  const [a, b] = [Math.min(Math.max(from, 0), last), Math.min(Math.max(to, 0), last)];
  const next = [...items];
  const [item] = next.splice(a, 1);
  next.splice(b, 0, item);
  return next;
}

/** An aspect's block in the rail as a drag starts: its top (in the rail's own coordinates) and its height. */
export interface Block {
  top: number;
  height: number;
}

/**
 * The slot the dragged block would land in, its middle at `middle`: as many places down as there are other blocks
 * whose middles it has passed. The others keep their places as the drag began.
 */
export function slotOf(blocks: readonly Block[], from: number, middle: number): number {
  let slot = 0;
  blocks.forEach((block, at) => {
    if (at !== from && block.top + block.height / 2 < middle) slot += 1;
  });
  return slot;
}

/**
 * Where each block's top would be with the block at `from` moved to `to`: the blocks laid out again from the first
 * one's top, one after another, with the gap between them as it was.
 */
export function layoutAfter(blocks: readonly Block[], from: number, to: number): number[] {
  if (blocks.length === 0) return [];
  const gap = blocks.length > 1 ? blocks[1].top - (blocks[0].top + blocks[0].height) : 0;
  const order = move(blocks.map((_, at) => at), from, to);
  const tops: number[] = new Array(blocks.length);
  let y = blocks[0].top;
  for (const at of order) {
    tops[at] = y;
    y += blocks[at].height + gap;
  }
  return tops;
}

/** What a screen reader hears as an aspect moves (or would, past an end). */
export function movedWords(label: string, to: number, count: number, moved = true): string {
  const place = `${to + 1} of ${count}`;
  if (moved) return `${label} moved to ${place}.`;
  return to === 0 ? `${label} is already first.` : `${label} is already last.`;
}
