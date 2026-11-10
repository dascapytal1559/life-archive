// Made-up people for testing data folders and tests: each named, with aliases
// and tags, and linked to the accounts it lists, as the captain would through
// the People panel or `npm run archive -- person ...`.

import type { FriendMap } from "../server/friendMap.ts";

export interface SamplePerson {
  name: string;
  aliases?: string[];
  tags?: string[];
  /** Accounts by platform and key (a Messenger name, say); the person is theirs. */
  accounts?: Array<{ platform: string; key: string }>;
}

/**
 * Adds each sample person: the person its first account belongs to, else
 * anyone with exactly its name, else a new person; then names, aliases and
 * tags them, and links its other accounts. Run after the imports.
 */
export function addSamplePeople(archive: Pick<FriendMap, "db" | "people" | "structure">, samples: SamplePerson[]): void {
  const { db, people, structure } = archive;
  const accountId = (platform: string, key: string) =>
    (db.prepare("SELECT id, person_id FROM import_person WHERE platform = ? AND key = ?").get(platform, key) as
      { id: number; person_id: number } | undefined);
  for (const sample of samples) {
    const accounts = (sample.accounts ?? []).flatMap((a) => accountId(a.platform, a.key) ?? []);
    let personId = accounts[0]?.person_id
      ?? structure.listPeople().people.find((p) => p.name === sample.name)?.id
      ?? people.create(sample.name);
    for (const account of accounts.slice(1)) people.link(account.id, personId);
    personId = people.setName(personId, sample.name);
    if (sample.aliases?.length) people.setAliases(personId, sample.aliases);
    if (sample.tags?.length) people.setTags(personId, sample.tags);
  }
}
