// What `npm run archive -- migrate` says of friend map's archive once it is up to date (sdk/server.ts's ModuleDatabase
// `migrated`): what its migrations made of the rows (db.ts), each read from what the rows hold now, so it is said again
// at every migrate, the same.

import type { DatabaseSync } from "node:sqlite";
import { draftsFromOpeners, locationColumn, locationFold, loggedCallsToAccounts, namesFirstAliasLeads } from "./db.ts";

export function migratedLines(db: DatabaseSync): string[] {
  const lines: string[] = [];
  const fold = locationFold(db);
  if (fold) {
    lines.push(
      `Met and Lives became Location: ${fold.movedFromMet} took their Met place, ${fold.keptFromLives} kept their Lives place ` +
        `(${fold.bothSame + fold.bothDifferent.length} had both: ${fold.bothSame} the same place, ${fold.bothDifferent.length} different, ` +
        `where Lives was kept and Met went); ${fold.withLocation} had a Location after.`,
      ...fold.bothDifferent.map(({ id, name, met, lives }) => `  person ${id} ${name}: Location ${lives} (Met ${met} went)`),
    );
  }
  const drafts = draftsFromOpeners(db);
  if (drafts > 0) lines.push(`Draft openers became drafts: ${drafts} moved.`);
  const calls = loggedCallsToAccounts(db);
  if (calls) lines.push(`Logged calls went on accounts: ${calls.onAccounts} on one, ${calls.onNone} on none (no one account of theirs on its app).`);
  const named = namesFirstAliasLeads(db);
  if (named > 0) lines.push(`Names became one list, the name first: ${named} ${named === 1 ? "person's first alias is" : "people's first aliases are"} now their name, the label they had.`);
  const column = locationColumn(db);
  if (column) {
    lines.push(
      `Location became a column of person: before, ${column.before.people} people had a location, ${column.before.values} different ` +
        `(and ${column.before.unused} nobody had, which went); after, ${column.after.people} people have one, ${column.after.values} different.`,
    );
  }
  return lines;
}
