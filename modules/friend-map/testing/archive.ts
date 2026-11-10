// A life archive on a folder of a test's own with friend map loaded as the server loads it (sdk/testing.ts's
// testingLifeArchive): the friend map (friendMap.ts: its database, people, change log, structure, content, sends),
// and beside it what a test reaches of the core: the host (the module's connectors in it), the calendar and its file,
// the trail, the core's database, the imports as the CLI makes them, the live connectors, and the viewer's reads.
// Never the real archive: a test names a temporary folder.

import type { Reads } from "../../../sdk/server.ts";
import { testingLifeArchive } from "../../../sdk/testing.ts";
import friendMapModule from "../module.ts";
import { friendMapOver, type FriendMap } from "../server/friendMap.ts";

/** The friend map a test opened, with the core's parts it reaches beside it. */
export type TestArchive = FriendMap & Awaited<ReturnType<typeof extras>>;

async function extras(dataDir: string) {
  const life = await testingLifeArchive(dataDir, friendMapModule);
  const { archive } = life;
  return {
    life,
    /** The core: its host, calendar, trail and database. */
    core: archive,
    host: archive.host,
    calendar: archive.calendar,
    calendarDb: archive.calendarDb,
    coreDb: archive.coreDb,
    events: archive.events,
    contentLog: archive.contentLog,
    importHistory: (...args: Parameters<typeof archive.importHistory>) => archive.importHistory(...args),
    startLive: (log?: (line: string) => void, { rulesEveryMs, ...lock }: { rulesEveryMs?: number; checkEveryMs?: number; heartbeatEveryMs?: number; staleAfterMs?: number } = {}) => {
      if (rulesEveryMs !== undefined) friendMapOver(life.module.db!).rulesEveryMs = rulesEveryMs;
      archive.startLive(log, lock);
    },
    stopLive: () => archive.stopLive(),
    reads: (): Reads => life.reads(),
    close: () => {
      friendMapOver(life.module.db!).close();
      life.close();
    },
  };
}

/** A life archive in `dataDir` (a folder of the test's own) with friend map loaded: its friend map, with the core's parts beside it. */
export async function openTestArchive(dataDir: string): Promise<TestArchive> {
  const more = await extras(dataDir);
  const friendMap = friendMapOver(more.life.module.db!);
  // The friend map's own members, its methods bound to it, under the core's parts.
  return new Proxy(more, {
    get: (target, key) => {
      if (key in target) return target[key as keyof typeof target];
      const value = (friendMap as unknown as Record<PropertyKey, unknown>)[key];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(friendMap) : value;
    },
    set: (_target, key, value) => Reflect.set(friendMap, key, value),
    has: (target, key) => key in target || key in friendMap,
  }) as unknown as TestArchive;
}
