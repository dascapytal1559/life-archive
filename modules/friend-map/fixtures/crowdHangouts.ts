// Hangouts for the made-up crowd (crowd.ts), so the viewer's Hangouts tab and its chart have rows: the captain's time
// in person with the crowd's closest friends, once or twice most weeks, from the crowd's first month to today, with no
// notes. Seeded apart from the crowd, so the crowd is as it was.

import { addDays, dayKey } from "../../../sdk/server.ts";
import type { Crowd } from "./crowd.ts";

export interface CrowdHangout {
  day: string;
  time: string | null;
  hours: number;
  /** Who was at it, by name. */
  names: string[];
  others: number;
}

/** The hangouts, from the crowd's first month to `end`. */
export function crowdHangouts(crowd: Crowd, end = Date.now()): CrowdHangout[] {
  const random = mulberry32(20261013);
  const friends = crowd.people.filter((p) => !p.tags?.length).map((p) => p.name).slice(0, 12);
  const hangouts: CrowdHangout[] = [];
  const last = dayKey(end);
  for (let day = "2024-03-04"; day <= last; day = addDays(day, 7)) {
    for (let k = random() < 0.25 ? 0 : random() < 0.7 ? 1 : 2; k > 0; k--) {
      const on = addDays(day, Math.floor(random() * 7));
      if (on > last) continue;
      const size = random() < 0.7 ? 1 : 2 + Math.floor(random() * 3);
      const names = [...new Set(Array.from({ length: size }, () => friends[Math.floor(random() ** 1.6 * friends.length)]))];
      const hour = 10 + Math.floor(random() * 11);
      hangouts.push({
        day: on,
        time: random() < 0.8 ? `${String(hour).padStart(2, "0")}:${random() < 0.5 ? "00" : "30"}` : null,
        hours: Math.round((0.5 + random() ** 1.5 * 5) * 2) / 2,
        names,
        others: random() < 0.1 ? 5 + Math.floor(random() * 20) : 0,
      });
    }
  }
  return hangouts;
}

/** A small seeded random number generator (as crowd.ts's), so the events are the same every time. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
