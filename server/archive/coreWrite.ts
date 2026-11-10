// The core's own connectors' imports (llm-sessions, grok-bot): their checked events applied to the core's database
// (coreDb.ts) through the event index's writer (events.ts's EventWriter), inside the host's transaction of it
// (connectors/host.ts's ledgers), and the events they added or changed pushed into the calendar once it has committed.
// A chat's events are the friend map module's and a workout's the exercise module's: a connector of the core's that
// wrote one is refused, and its import with it, as any malformed event is.

import type { ConnectorLedger } from "../connectors/host.ts";
import { emptyCounts } from "../connectors/counts.ts";
import { EventOrderError, EventWriter } from "./events.ts";
import type { Db } from "./db.ts";

/** The core's ledger over its database `db`: what each import added or changed of the index, by event id, told to `afterApply` once committed. */
export function coreLedger(db: Db, afterApply?: (events: readonly number[]) => void): ConnectorLedger {
  return {
    db,
    apply: (events, source) => {
      const counts = emptyCounts();
      const writer = new EventWriter(db, source.platform, source.id, counts.events, source.folder);
      for (const event of events) {
        switch (event.kind) {
          case "device": writer.device(event); break;
          case "llm-session": writer.llmSession(event); break;
          case "llm-turn": writer.llmTurn(event); break;
          case "tally": counts.tallies[event.name] = (counts.tallies[event.name] ?? 0) + event.count; break;
          case "progress": break;
          default: throw new EventOrderError(`a ${event.kind} event is not the core's: no connector of the core's writes one`);
        }
      }
      const touched = [...writer.touched];
      return { counts, afterCommit: () => afterApply?.(touched) };
    },
  };
}
