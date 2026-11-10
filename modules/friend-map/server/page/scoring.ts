// friend-map's own scoring over the archive's facts: the Table's closeness and the person panel's activity chart (its
// server's methodology.ts before it was a module). The archive gives the facts (its score report and the Table's
// rows, structure.ts) and the page's own code works out the scores (its src/demos/closeness.ts and src/activity.ts, as
// the map views do in the page), so the archive keeps no copy of the scoring. Three routes under /api/archive:
//
//   GET  /api/archive/contract                   -> Contract: the archive's handshake, with friend-map's own `scores`
//        added to its capabilities
//   GET  /api/archive/table?closenessHalfLifeDays=&catchUpHourWorth=&callMinimumMinutes=&messageReciprocity=&groupSharedPart=&tripFullHours=
//                                                -> PeopleTable: everyone, archived people too, one light row each
//        for the Table view, with closeness scored with those settings (the default for any left out)
//   GET  /api/archive/people/:id/activity?<settings> -> PersonActivity: their messages, calls and hangouts each month,
//        all time, and what each counted for in closeness points with the closeness settings named (as /table takes
//        them), for the chart in their panel; 404 for no such person
//
// A setting that is not one, or out of its range, is a 400.

import { personActivity } from "../../page/src/activity.ts";
import type { Contract, PeopleTable, PersonActivity, ScoreReport, TableRow } from "../../page/src/archive.ts";
import { OWN_CAPABILITY, takeContract } from "../../page/src/contract/handshake.ts";
import { closenessNow } from "../../page/src/demos/closeness.ts";
import { closenessSettings, DEFAULT_SETTINGS, settingAllowed, settingRule, type ClosenessSettings } from "../../page/src/settings.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Effect, InvalidInputError, NotFoundError, sendJson } from "../../../../sdk/server.ts";
import type { FriendMap } from "../friendMap.ts";
import { archiveContract } from "../http.ts";

/** The Table: each row with its closeness score as of `now`, worked out from `report` with `settings`; 0 for nothing between you. */
export function scoredTable(report: ScoreReport, rows: TableRow[], settings: ClosenessSettings, now: number): PeopleTable {
  const closeness = closenessNow({ ...report, generatedAt: now }, settings);
  return { generatedAt: now, settings, people: rows.map((row) => ({ ...row, closeness: closeness.get(row.id) ?? 0 })) };
}

/** Person `id`'s activity as of `now` (personActivity), from `report` with `settings`. */
export function scoredActivity(report: ScoreReport, id: number, settings: ClosenessSettings, now: number): PersonActivity {
  return personActivity({ ...report, generatedAt: now }, id, settings);
}

/** `contract` with friend-map's own capability added: it scores the Table and the Events chart itself. */
export function withOwn(contract: Contract): Contract {
  return contract.capabilities.includes(OWN_CAPABILITY) ? contract : { ...contract, capabilities: [...contract.capabilities, OWN_CAPABILITY] };
}

/**
 * Answers /contract (the archive's handshake, with friend-map's own capability added), /table and
 * /people/:id/activity from the archive in this process (its score report and the Table's rows, structure.ts): true
 * when it answered; every other /api/archive path is the contract's own (../http.ts). `path` is from /api/archive on.
 */
export const scoring = (archive: FriendMap, path: string, url: URL, req: IncomingMessage, res: ServerResponse, { now = Date.now }: { now?: () => number } = {}) =>
  Effect.gen(function* () {
    if ((req.method ?? "GET") !== "GET") return false;
    // Scores count days in the archive's zone, as the page does from the handshake: the page's own code runs here too.
    takeContract(archiveContract());
    let match: RegExpExecArray | null;
    if (path === "/contract") {
      sendJson(res, 200, withOwn(archiveContract()));
      return true;
    }
    if (path === "/table") {
      const settings = yield* settingsParams(url);
      sendJson(res, 200, scoredTable(archive.structure.scoreReport(), archive.structure.tableRows(), settings, now()));
      return true;
    }
    if ((match = /^\/people\/(\d+)\/activity$/.exec(path))) {
      const settings = yield* settingsParams(url);
      const id = Number(match[1]);
      if (!archive.structure.getPerson(id)) return yield* new NotFoundError(`no person ${id}`);
      sendJson(res, 200, scoredActivity(archive.structure.scoreReport(), id, settings, now()));
      return true;
    }
    return false;
  });

/** The closeness settings a request names in its query (the default for any left out); 400 for anything else. */
const settingsParams = (url: URL): Effect.Effect<ClosenessSettings, InvalidInputError> =>
  Effect.try({ try: () => readSettingsParams(url), catch: (error) => new InvalidInputError((error as Error).message) });

function readSettingsParams(url: URL): ClosenessSettings {
  const settings = closenessSettings(DEFAULT_SETTINGS);
  for (const [key, value] of url.searchParams) {
    if (!(key in settings)) throw new Error(`${key} is not a closeness setting; they are ${Object.keys(settings).join(", ")}`);
    const name = key as keyof typeof settings;
    // As the page writes a number (String(n)): digits, maybe a point and an exponent.
    const number = /^[\d.e+-]+$/i.test(value) ? Number(value) : NaN;
    if (!settingAllowed(name, number)) throw new Error(`${key} must be ${settingRule(name)}`);
    settings[name] = number;
  }
  return settings;
}
