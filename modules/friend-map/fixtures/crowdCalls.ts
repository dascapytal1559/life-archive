// Calls for the made-up crowd (crowd.ts), so the viewer's Calls tab and its chart have something to show: Messenger
// call records in the crowd's one-to-one chats, about one for every thirty messages that month, most answered, some
// missed and a few of no known length; and the phone's call history with the close friends, each on a number set
// aside for fiction (the ACMA's list for creative works), joined to them as the captain would join it. Seeded apart
// from the crowd, so the crowd itself is as it was.
//
//   npm run testing-data -- /tmp/life-archive-crowd --crowd

import { type ArchiveEvent, CROWD_SELF } from "../../../sdk/server.ts";
import type { Crowd } from "./crowd.ts";

/** Mobile numbers the ACMA sets aside for fiction, one for each close friend who gets phone calls. */
const FICTION_NUMBERS = ["+61491570006", "+61491570156", "+61491570157", "+61491570158", "+61491570159", "+61491570110", "+61491570313"];

export interface CrowdCalls {
  /** Messenger call records, for the crowd's own import. */
  messenger: ArchiveEvent[];
  /** The phone's call history: an account for each number, and its calls. */
  phone: ArchiveEvent[];
  /** Which numbers are whose, to join (samplePeople.ts): each close friend's Messenger account and their number. */
  people: Array<{ name: string; accounts: Array<{ platform: string; key: string }> }>;
}

export function crowdCalls(crowd: Crowd): CrowdCalls {
  const random = mulberry32(20261012);
  const messenger: ArchiveEvent[] = [];
  let id = 0;
  // Each one-to-one chat's messages by month, to set how often they call.
  const chats = new Map<string, number[]>();
  const direct = new Set(crowd.events.flatMap((e) => (e.kind === "conversation" && e.type === "direct" && !e.marketplace ? [e.id] : [])));
  for (const event of crowd.events) {
    if (event.kind === "message" && direct.has(event.conversation)) (chats.get(event.conversation) ?? chats.set(event.conversation, []).get(event.conversation)!).push(event.sentAt);
  }
  for (const [conversation, times] of chats) {
    const name = conversation.slice("direct:".length);
    if (name.startsWith("unknown-")) continue;
    for (const at of times) {
      if (random() > 1 / 30) continue;
      const fromSelf = random() < 0.5;
      const roll = random();
      // Most answered, from a minute to over an hour; one in seven missed; one in twenty-five no known length.
      const callSeconds = roll < 1 / 7 ? 0 : roll < 1 / 7 + 1 / 25 ? undefined : Math.round(60 + 4800 * random() ** 2.2);
      messenger.push({
        kind: "message", id: `crowd-call-${id++}`, idKind: "platform", conversation, sender: fromSelf ? CROWD_SELF : name, isFromSelf: fromSelf,
        sentAt: Math.min(at + 3_600_000, Date.now() - 60_000), type: "call", ...(callSeconds === undefined ? {} : { callSeconds }), raw: {},
      });
    }
  }

  // The close friends, by name, are the crowd's people tagged with nothing who have the most messages.
  const close = crowd.people.filter((p) => !p.tags?.length).map((p) => p.name).slice(0, FICTION_NUMBERS.length);
  const phone: ArchiveEvent[] = [];
  const people: CrowdCalls["people"] = [];
  close.forEach((name, i) => {
    const number = FICTION_NUMBERS[i];
    phone.push({ kind: "account", key: number, keyKind: "id", displayName: number, handle: number });
    people.push({ name, accounts: [{ platform: "messenger", key: name }, { platform: "phone", key: number }] });
    const times = chats.get(`direct:${name}`) ?? [];
    times.forEach((at, k) => {
      if (random() > 1 / 45) return;
      const outgoing = random() < 0.55;
      const answered = random() > 0.2;
      const facetime = random() < 0.25;
      phone.push({
        kind: "call", id: `crowd-phone-${i}-${k}`, with: number, at: at - 5_400_000, durationSeconds: answered ? Math.round(30 + 3600 * random() ** 2) : 0,
        direction: outgoing ? "outgoing" : "incoming", answered, service: facetime ? (random() < 0.5 ? "facetime-audio" : "facetime-video") : "phone", raw: {},
      });
    });
  });
  return { messenger, phone, people };
}

/** A small seeded random number generator (as crowd.ts's), so the calls are the same every time. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
