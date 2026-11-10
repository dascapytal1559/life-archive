// Who No name except… (names.ts) names: everyone you picked, tagged
// "show-name" (SHOW_NAME_TAG) in the archive, and their connections. Picks are
// kept there, as a tag, rather than in a browser: the same on every device,
// each pick a changeset in the change log (Undo in the Table's Changes takes
// it back), and carried through a merge as any tag is; a person's Tags in
// their panel picks and unpicks them too. A picked person's connections are
// whoever the map links them to (connectionsOf): everyone on the map they
// share a group chat with, as the links drawn from them while held; they are
// named by their name alone, as those picked are, but never tagged, nor listed
// as picked. Both are loaded once for the page (GET /api/archive/people?tag=
// and GET /api/archive/relationships), while that choice is on, and again
// whenever people change; until those picked are in, nobody is named, and
// until the map's links are, only they are. Name format, in the menu, lists those
// picked, and picks and unpicks people (NamesMenu.tsx).

import { useEffect, useSyncExternalStore } from "react";
import { connectedIds, SHOW_NAME_TAG, type PersonSummary, type RelationshipsReport } from "./archive.ts";
import { archiveApi } from "./archiveApi.ts";
import { saveTags } from "./changeChip.ts";
import { nameStyleStore, useNameStyle } from "./names.ts";
import { change } from "./PersonParts.tsx";
import { useArchive } from "./useArchive.ts";

/** Everyone picked, for the menu's Name format to list: null until loaded. */
let picked: readonly PersonSummary[] | null = null;
const listeners = new Set<() => void>();
const pickedStore = {
  get: () => picked,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Everyone No name except… names, as the menu's Name format lists them: null while loading. */
export function usePickedPeople(): readonly PersonSummary[] | null {
  return useSyncExternalStore(pickedStore.subscribe, pickedStore.get, pickedStore.get);
}

/**
 * Loads who is picked into nameStyleStore while No name except… is on, and keeps it in step as people change; each
 * live page of the real app calls it once (`enabled`).
 */
export function useShownNames(enabled: boolean): void {
  const style = useNameStyle();
  const on = enabled && style === "except";
  const listing = useArchive(() => archiveApi.people({ tag: SHOW_NAME_TAG }), [], { enabled: on });
  // The map's report, as it loads it, for who it links to whom.
  const map = useArchive(() => archiveApi.relationships(), [], { enabled: on });
  useEffect(() => {
    if (!on || !listing.data) return;
    picked = listing.data.people;
    for (const listener of listeners) listener();
    const ids = new Set(picked.map((p) => p.id));
    nameStyleStore.setNamed(map.data ? new Set([...ids, ...connectionsOf(ids, map.data)]) : ids);
  }, [on, listing.data, map.data]);
}

/**
 * A picked person's connections, for everyone `picked`: whoever the map links them to, everyone on the map (`people`,
 * so not archived) they share a group chat with, by the members it connects (connectedIds: a group chat someone is
 * unlinked from connects them to nobody), as the map's links (model.ts) go; nobody picked, and nobody for a picked
 * person not on the map, whom it links to nobody.
 */
export function connectionsOf(
  picked: ReadonlySet<number>,
  map: Pick<RelationshipsReport, "groups" | "unlinks"> & { people: ReadonlyArray<{ id: number }> },
): Set<number> {
  const onMap = new Set(map.people.map((p) => p.id));
  const connections = new Set<number>();
  for (const group of map.groups) {
    const members = connectedIds(group, map.unlinks).filter((id) => onMap.has(id));
    if (!members.some((id) => picked.has(id))) continue;
    for (const id of members) if (!picked.has(id)) connections.add(id);
  }
  return connections;
}

/** Their tags with SHOW_NAME_TAG, last, or (`shown` false) without it; every other tag as it was. */
export function withShowName(tags: readonly string[], shown: boolean): string[] {
  const others = tags.filter((tag) => tag !== SHOW_NAME_TAG);
  return shown ? [...others, SHOW_NAME_TAG] : others;
}

/** Picks someone for No name except…, or (`shown` false) unpicks them: one change to their tags, one changeset. */
export function setShowName(person: Pick<PersonSummary, "id" | "tags">, shown: boolean): Promise<PersonSummary | undefined> {
  return change(() => saveTags(person.id, person.tags, withShowName(person.tags, shown)));
}
