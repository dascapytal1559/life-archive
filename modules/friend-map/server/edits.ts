// Edits to many people at once, for an agent working from a chat with the
// captain (`npm run archive -- edit`): the people are chosen with the Query
// language (query.ts) or SQL (sqlQuery.ts), over everyone, archived people too, or by number, and
// one edit is made to each of them: a tag given or taken ("archive" and "keep"
// too), a location set or cleared, reaching out switched, or, for one
// person, their name or aliases set.
//
// planEdit is the dry run: who would change (each with before and after) and
// who is that way already, and the tags it would add or (taking one from the
// last people who have it) delete. applyEdit makes the edit to those who would change,
// through People as the app's edits are; the CLI runs it inside one changeset
// (changes.ts), so the whole edit is undone as one.

import { type Db, InvalidInputError, NotFoundError, type PersonSummary } from "../../../sdk/server.ts";
import type { People } from "./people.ts";
import { normalizeAliases, normalizeLocation, normalizeName } from "./personFields.ts";
import { matchQuerySync } from "./sqlQuery.ts";
import type { ArchiveStructure } from "./structure.ts";
import { deletesWhenEmpty, storableTag } from "./tags.ts";

/** One edit, to be made to each person chosen. */
export type EditAction =
  | { kind: "tag" | "untag"; tags: string[] }
  | { kind: "location"; value: string | null }
  | { kind: "reach-out"; value: boolean }
  | { kind: "name"; name: string }
  | { kind: "aliases"; aliases: string[] };

/** Who an edit is for: everyone a query (or SQL) matches, archived people too, or these people by number. */
export type Selection = { query: string } | { people: number[] };

/** What an edit would do. */
export interface EditPlan {
  /** The edit in a few words, as a changeset names it ("tag commercial", "clear location"). */
  action: string;
  /** How many people the selection chose. */
  selected: number;
  /** Those it would change, with the value before and after. */
  change: Array<{ id: number; name: string; before: string; after: string }>;
  /** Those who are that way already, with the value. */
  already: Array<{ id: number; name: string; value: string }>;
  /** Tags it would add to the tag list, as nobody has made them yet, or a location nobody is at yet. */
  adds: string[];
  /** Tags it would delete, as it takes them from the last people who have them (tags.ts). */
  deletes: string[];
}

/** The verbs `edit` takes, and what each needs, for the CLI's help and errors. */
export const EDIT_VERBS = [
  "tag <tag ...>", "untag <tag ...>", "location <value ...>", "clear-location",
  "reach-out", "no-reach-out", "name <name ...>", "aliases <alias> [alias ...]", "clear-aliases",
] as const;

/** An edit from the CLI's words: a verb, then what it takes. */
export function parseEditAction(verb: string | undefined, args: string[]): EditAction {
  const words = () => {
    const text = args.join(" ").trim();
    if (!text) throw new InvalidInputError(`${verb} needs a value`);
    return text;
  };
  const none = () => {
    if (args.length > 0) throw new InvalidInputError(`${verb} takes nothing more, not "${args.join(" ")}"`);
  };
  switch (verb) {
    case "tag":
    case "untag":
      if (args.length === 0) throw new InvalidInputError(`${verb} needs a tag`);
      return { kind: verb, tags: [...new Set(args.map(storableTag))] };
    case "location":
      return { kind: verb, value: normalizeLocation(words()) };
    case "clear-location":
      none();
      return { kind: "location", value: null };
    case "met":
    case "lives":
    case "clear-met":
    case "clear-lives":
      throw new InvalidInputError(`${verb} is gone: Met and Lives became one Location (${verb.startsWith("clear-") ? "clear-location" : "location <value ...>"})`);
    case "reach-out":
    case "no-reach-out":
      none();
      return { kind: "reach-out", value: verb === "reach-out" };
    case "name":
      return { kind: "name", name: normalizeName(words()) };
    case "aliases":
      if (args.length === 0) throw new InvalidInputError("aliases needs at least one (clear-aliases takes them all away)");
      return { kind: "aliases", aliases: normalizeAliases(args) };
    case "clear-aliases":
      none();
      return { kind: "aliases", aliases: [] };
    default:
      throw new InvalidInputError(`edit what? ${EDIT_VERBS.join(" | ")}`);
  }
}

/** The edit in a few words. */
export function describeEdit(action: EditAction): string {
  switch (action.kind) {
    case "tag":
    case "untag":
      return `${action.kind} ${action.tags.join(" ")}`;
    case "location":
      return action.value === null ? "clear location" : `location ${action.value}`;
    case "reach-out":
      return action.value ? "reach out" : "no reach out";
    case "name":
      return `name ${action.name}`;
    case "aliases":
      return action.aliases.length === 0 ? "clear aliases" : `aliases ${action.aliases.join(", ")}`;
  }
}

/** The dry run: who the edit would change, and who is that way already. Changes nothing. */
export function planEdit({ db, structure, people }: { db: Db; structure: ArchiveStructure; people: People }, selection: Selection, action: EditAction): EditPlan {
  const everyone = structure.listPeople().people;
  const chosen = choose(db, structure, everyone, selection);
  if ((action.kind === "name" || action.kind === "aliases") && chosen.length !== 1) {
    throw new InvalidInputError(`${action.kind === "name" ? "a name is" : "aliases are"} for one person at a time; this chooses ${chosen.length}`);
  }
  const tagList = people.tags.list();
  const order = tagList.map((tag) => tag.name);
  const inOrder = (tags: Iterable<string>) => {
    const set = new Set(tags);
    return [...order.filter((tag) => set.delete(tag)), ...set];
  };
  // A location someone is at but for case is that one, in its spelling (as People.setLocation writes it).
  const asStored = (value: string) => people.locations.spelled(value);

  const plan: EditPlan = { action: describeEdit(action), selected: chosen.length, change: [], already: [], adds: [], deletes: [] };
  if (action.kind === "tag") plan.adds = action.tags.filter((tag) => !order.includes(tag)).map((tag) => `the tag "${tag}"`);
  if (action.kind === "location" && action.value !== null && people.locations.holders(action.value).size === 0) {
    plan.adds = [`the location "${action.value}"`];
  }
  for (const person of chosen) {
    const { before, after } = beforeAfter(person, action, inOrder, asStored);
    if (before === after) plan.already.push({ id: person.id, name: person.name, value: before });
    else plan.change.push({ id: person.id, name: person.name, before, after });
  }
  if (action.kind === "untag") {
    const changing = new Set(plan.change.map((p) => p.id));
    plan.deletes = tagList
      .filter((tag) => action.tags.includes(tag.name) && tag.count > 0 && deletesWhenEmpty(tag))
      .filter((tag) => [...people.tags.holdersOf(tag.name)].every((id) => changing.has(id)))
      .map((tag) => `the tag "${tag.name}"`);
  }
  return plan;
}

/** Makes the edit to each person in `ids` (the plan's change), through People. */
export function applyEdit(people: People, action: EditAction, ids: readonly number[]): void {
  for (const id of ids) {
    switch (action.kind) {
      case "tag":
        people.addTags(id, action.tags);
        break;
      case "untag":
        people.removeTags(id, action.tags);
        break;
      case "location":
        people.setLocation(id, action.value);
        break;
      case "reach-out":
        people.setShouldReachOut(id, action.value);
        break;
      case "name":
        people.setName(id, action.name);
        break;
      case "aliases":
        people.setAliases(id, action.aliases);
        break;
    }
  }
}

function choose(db: Db, structure: ArchiveStructure, everyone: PersonSummary[], selection: Selection): PersonSummary[] {
  if ("query" in selection) {
    if (!selection.query.trim()) throw new InvalidInputError("an empty query chooses everyone; say who, or name them with --people");
    const ids = new Set(matchQuerySync(db, selection.query, structure.queryable()));
    return everyone.filter((person) => ids.has(person.id));
  }
  if (selection.people.length === 0) throw new InvalidInputError("name at least one person");
  const byId = new Map(everyone.map((person) => [person.id, person]));
  return [...new Set(selection.people)].map((id) => {
    const person = byId.get(id);
    if (!person) throw new NotFoundError(structure.getPerson(id) ? `person ${id} is you` : `no person ${id}`);
    return person;
  });
}

/** One person's value for what the edit changes, as it is and as the edit would leave it. */
function beforeAfter(
  person: PersonSummary,
  action: EditAction,
  inOrder: (tags: Iterable<string>) => string[],
  asStored: (value: string) => string,
): { before: string; after: string } {
  switch (action.kind) {
    case "tag":
      return { before: person.tags.join(", "), after: inOrder([...person.tags, ...action.tags]).join(", ") };
    case "untag":
      return { before: person.tags.join(", "), after: person.tags.filter((tag) => !action.tags.includes(tag)).join(", ") };
    case "location": {
      const now = person.location ?? "";
      const next = action.value === null ? "" : asStored(action.value);
      // Only the case differing is no change (as People.setLocation sees it).
      return { before: now, after: now.toLowerCase() === next.toLowerCase() ? now : next };
    }
    case "reach-out":
      return { before: person.shouldReachOut ? "yes" : "no", after: action.value ? "yes" : "no" };
    case "name":
      return { before: person.name, after: action.name };
    case "aliases":
      return { before: person.aliases.join(", "), after: action.aliases.join(", ") };
  }
}
