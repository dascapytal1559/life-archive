// What the Table's Changes list (ChangesPanel.tsx) shows of each changeset in
// the change log (GET /api/archive/changes): no React here, so it is tested alone.
// It follows the name choice: while names are hidden (No name except…), the people are
// labelled as everywhere else, and nothing that can name someone shows (the
// user's words, a name or aliases edit's value, names, aliases, notes,
// draft openers and accounts before and after, and who was said to be different).

import type { ChangesetInfo, FieldChange } from "../archive.ts";
import { namesFor, type Names } from "../names.ts";
import { relativeDay, zonedFormat } from "../time.ts";

/** A changeset as one entry of the list. */
export interface ChangeEntry {
  id: number;
  /** What was done ("edit tag commercial", "person tags"). */
  action: string;
  /** "#12 · today 14:03 · from the CLI". */
  meta: string;
  /** Your words, when an agent passed them. */
  words: string | null;
  /** The people it touched that the listing has, to open; `more` is how many it leaves out. */
  people: Array<{ id: number; name: string }>;
  more: number;
  other: string[];
  /** "undone by #13", "undoes #11", or nothing. */
  state: string | null;
  /** Whether Undo is offered: not once it has been undone. */
  canUndo: boolean;
}

const clock = zonedFormat({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function changeEntry(change: ChangesetInfo, names: Names = namesFor("full"), now = Date.now()): ChangeEntry {
  return {
    id: change.id,
    action: names.hidden ? change.action.replace(/^(edit (?:name|aliases)) .*$/s, "$1") : change.action,
    meta: `#${change.id} · ${relativeDay(change.at, now)} ${clock.format(change.at)} · ${change.surface === "cli" ? "from the CLI" : "in the app"}`,
    words: names.hidden ? null : change.description,
    people: change.people.map((person) => ({ id: person.id, name: personName(person, names) })),
    more: change.peopleCount - change.people.length,
    other: names.hidden ? change.other.map(namelessOther) : change.other,
    state: change.undoneBy !== null ? `undone by #${change.undoneBy}` : change.undoes !== null ? `undoes #${change.undoes}` : null,
    canUndo: change.undoneBy === null,
  };
}

/** A person the change log names, as the name choice labels them (the log has their name alone). */
export function personName(person: { id: number; name: string }, names: Names): string {
  return names.label({ ...person, aliases: [] }).primary;
}

/** What else a changeset did, without who was said to be different (the rest names tags and values only). */
function namelessOther(line: string): string {
  if (line.startsWith("said ") && line.endsWith(" are different people")) return "said two people are different";
  if (line.startsWith("took back that ")) return "took back that two people are different";
  return line;
}

/** What a person has that can name them, whose before and after the name choice hides. */
const NAMING: ReadonlySet<string> = new Set(["name", "aliases", "note", "draft opener", "accounts"]);

/**
 * One thing that changed about a person: "tags: friend → friend, commercial",
 * "(none)" for nothing; with names hidden, only that it changed for what can name them.
 */
export function changeLine({ what, before, after }: FieldChange, names: Names = namesFor("full")): string {
  if (names.hidden && NAMING.has(what)) return `${what}: changed`;
  return `${what}: ${before || "(none)"} → ${after || "(none)"}`;
}
