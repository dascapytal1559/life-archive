// Untouched people: those you have never changed by hand, as the
// archive decides it (People.untouched in server/archive/people.ts, sent as
// `untouched` on each person). The people views (People, the Table, a group
// chat's members) draw them muted, so they stand apart from
// people you have named, tagged or otherwise looked after; Orbits does not. A
// group chat's "Archive untouched" archives them in one go.

import type { GroupMember } from "./archive.ts";

/** What hovering an untouched person says, wherever they are drawn muted. */
export const UNTOUCHED_HINT = "Untouched: you have never changed them (no name, alias, tag, location, note, merge or Not them of yours)";

/** What "Archive untouched" in a group chat would do: whom it archives, and how many it leaves as they are. */
export interface UntouchedPlan {
  /** The untouched members not archived yet, by id: whom it archives. */
  archive: number[];
  /** Members you have changed, never archived by it. */
  skipped: number;
  /** Members archived already, by you or the rules. */
  archivedAlready: number;
}

export function untouchedPlan(members: readonly GroupMember[]): UntouchedPlan {
  const archive = members.filter((m) => m.untouched && !m.archived).map((m) => m.id);
  const archivedAlready = members.filter((m) => m.archived).length;
  return { archive, skipped: members.length - archive.length - archivedAlready, archivedAlready };
}
