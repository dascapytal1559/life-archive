// A person's name as People and the page show it, by their id, for a line that names them (the trail of content reads).

import type { DatabaseSync } from "node:sqlite";
import { People } from "./people.ts";
import { ArchiveStructure } from "./structure.ts";

/** Person `id`'s name; null when there is no such person (a merge deletes the person merged away). */
export const personName = (db: DatabaseSync, id: number): string | null => new ArchiveStructure(db, new People(db)).getPerson(id)?.name ?? null;
