// What a group chat is called in a person's panel. A group with a title goes
// by it. An untitled one, as iMessage groups often are, goes by the first few
// people in it, each as the Name format choice labels them ("Ada, Bo and 3 more"), so
// it follows that choice as every other name does. One with no name at all, a
// blank title (as an untitled iMessage group imports) or nobody to name it by,
// is "-". While names are hidden (No name except…: its title or its members
// may name anyone), a group has no name (empty, drawn as the shape a hidden
// name is).

import type { GroupPerson } from "./archive.ts";
import { locale } from "./time.ts";

/** How many people an untitled group is named by: the first of its members, most messages there first. */
export const NAMED_BY = 3;

/** What a group with no name at all is called. */
export const UNNAMED_GROUP = "-";

export function groupName(
  group: { title: string | null; people: number; namedBy: readonly GroupPerson[] },
  // The Name format choice's (src/names.ts), described here so this file needs only the contract.
  names: { hidden: boolean; label: (person: GroupPerson) => { primary: string } },
): string {
  if (names.hidden) return "";
  if (group.title !== null) return group.title.trim() === "" ? UNNAMED_GROUP : group.title;
  if (group.namedBy.length === 0) return UNNAMED_GROUP;
  const labels = group.namedBy.map((person) => names.label(person).primary);
  // Everyone in it but you, less those named.
  const others = group.people - 1 - labels.length;
  if (others > 0) return `${labels.join(", ")} and ${others.toLocaleString(locale())} more`;
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}
