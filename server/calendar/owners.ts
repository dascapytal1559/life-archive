// The hooks the Events page's tables and calendar ask the owner of a row through, having read everything else from the
// calendar alone (db.ts): the names of the people a row names (`labelPeople`, by the owning module's own ids), what
// else a row's drawer says and where it leads (`detail`), and, optionally, which of its people its own views hide
// (`hiddenPeople`, which the calendar's lists of people leave out until asked). A module declares them in its module.ts (sdk/server.ts's
// `events`; friend map answers for the calls, hangouts and whom he messaged, the exercise module for the workouts, the
// rituals module for the habits done); the core answers for its own here (coreOwners): the conversations with agents.
//
// What the core's owner reads, it reads on the viewer's own read-only connection to the core's database: a session's
// file and device, never a word of content.

import type { DatabaseSync } from "node:sqlite";
import type { DetailField, ViewLink } from "../../viewer/wire.ts";
import { coreOwner } from "./eventIndex.ts";
import { CORE } from "./rows.ts";

/** What else a row's drawer says, the other tabs narrowed to it, and the id the content routes take when content stands behind it. */
export interface OwnerDetail {
  more: DetailField[];
  views: ViewLink[];
  /** For a row with content behind it (an LLM event), the id the viewer's content routes take: the owner's own. */
  content?: number;
}

/** A module's answers for the rows it pushed. */
export interface EventOwner {
  /** The names of the people its rows name, by its own ids; one it does not know is left out, and called by its number. */
  labelPeople(ids: readonly number[]): Record<number, string>;
  /** A row's drawer, by its kind and the source's own id; null for a row it has nothing to add to, or no longer has. */
  detail(kind: string, origin: string, nativeId: string): OwnerDetail | null;
  /**
   * Of the people `ids` (its own ids), those its own views hide unless asked (friend map's: archived, or tagged with a
   * tag its Hide starts on), whom the Events calendar's lists of people leave out until its switch shows them; none
   * when left out.
   */
  hiddenPeople?(ids: readonly number[]): number[];
}

/** The owners, by module id. */
export type Owners = ReadonlyMap<string, EventOwner>;

/** The owner of a module nobody answers for: nobody named, nothing added. */
export const NO_OWNER: EventOwner = { labelPeople: () => ({}), detail: () => null };

export const ownerOf = (owners: Owners, module: string): EventOwner => owners.get(module) ?? NO_OWNER;

/** The core's own owner, reading the core's database on `core` (the viewer's connection): the conversations with agents. */
export function coreOwners(core: DatabaseSync): Map<string, EventOwner> {
  return new Map([[CORE, coreOwner(core)]]);
}
