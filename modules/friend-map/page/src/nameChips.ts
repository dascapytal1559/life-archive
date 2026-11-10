// A person's names as one list, in order: the person panel's chips (NameChips.tsx). The first is their name, which
// labels them everywhere (names.ts); the rest are their aliases, as the archive keeps them (person.name, then
// person.aliases_json). Each change here gives the list after it, or the same list when it changes nothing, so the
// panel saves only a real change, as one changeset (PUT /api/archive/people/:id/names).

/** Every name someone goes by, in order: their name, then their aliases. */
export function namesOf(person: { name: string; aliases: readonly string[] }): string[] {
  return [person.name, ...person.aliases.filter((alias) => alias !== person.name)];
}

/** A name as the archive writes one: trimmed and single-spaced ("" for nothing). */
export function cleanName(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** How a name box ends: Enter, leaving it, or Esc. */
export type DraftEnd = "enter" | "leave" | "escape";

/** What a name box gives as it ends: what was typed, or null (no change) on Esc or with nothing typed. */
export function draftResult(text: string, end: DraftEnd): string | null {
  return end === "escape" || !cleanName(text) ? null : text;
}

/** The names with `text` added at the end; the same list when it is empty or one of them already. */
export function addName(names: readonly string[], text: string): readonly string[] {
  const name = cleanName(text);
  return !name || names.includes(name) ? names : [...names, name];
}

/** The names without the one at `index`; the same list for the last name, which nobody is left without. */
export function removeName(names: readonly string[], index: number): readonly string[] {
  return names.length <= 1 || index < 0 || index >= names.length ? names : names.filter((_, i) => i !== index);
}

/**
 * The name at `index` written as `text`, in its place; the same list when `text` is empty. Written as another of their
 * names, the two are one, kept where the first of them is.
 */
export function renameName(names: readonly string[], index: number, text: string): readonly string[] {
  const name = cleanName(text);
  if (!name || names[index] === undefined || names[index] === name) return names;
  return [...new Set(names.map((n, i) => (i === index ? name : n)))];
}

/** The names with the one at `from` moved to `to` (its place among the others; 0 first, which makes it their name). */
export function moveName(names: readonly string[], from: number, to: number): readonly string[] {
  if (names[from] === undefined) return names;
  const rest = names.filter((_, i) => i !== from);
  const at = Math.max(0, Math.min(rest.length, to));
  if (at === from) return names;
  return [...rest.slice(0, at), names[from], ...rest.slice(at)];
}

/** What a change to someone's names did, as its chip says it; null when nothing changed. */
export type NameChange =
  | { done: "added"; name: string }
  | { done: "removed"; name: string }
  | { done: "renamed"; from: string; to: string }
  /** Another name first: their name, and label, now. */
  | { done: "first"; name: string }
  | { done: "reordered" };

export function nameChange(before: readonly string[], after: readonly string[]): NameChange | null {
  if (before.length === after.length && before.every((name, i) => name === after[i])) return null;
  const added = after.filter((name) => !before.includes(name));
  const removed = before.filter((name) => !after.includes(name));
  if (added.length === 1 && removed.length === 1) return { done: "renamed", from: removed[0], to: added[0] };
  if (added.length === 1 && removed.length === 0) return { done: "added", name: added[0] };
  if (removed.length === 1 && added.length === 0) return { done: "removed", name: removed[0] };
  if (added.length === 0 && removed.length === 0 && after[0] !== before[0]) return { done: "first", name: after[0] };
  return { done: "reordered" };
}

/**
 * Where a chip dragged to (x, y) goes among the others, by where it is over them in reading order: after every chip
 * whose row is above it, and after each on its row whose middle it has passed. `others` are their boxes, in order.
 */
export function dropIndex(others: readonly { left: number; right: number; top: number; bottom: number }[], x: number, y: number): number {
  return others.filter((box) => y > box.bottom || (y >= box.top && x > (box.left + box.right) / 2)).length;
}
