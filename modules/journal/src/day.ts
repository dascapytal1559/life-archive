// The journal's day, which both its jobs file by (jobs/voice-journal/, jobs/grok-calls/): a day runs from 06:00 to
// 06:00 the next morning in the archive's zone, so a recording or a call after midnight belongs to the evening before,
// as rituals' days do (modules/rituals/HANDOFF.md's journal contract).

import { addDays } from "../../../sdk/server.ts";

/** The hour before which a recording belongs to the day before: one made at 01:44 is the night of the day it began. */
export const DAY_STARTS_AT_HOUR = 6;

/** DAY_STARTS_AT_HOUR as a wall clock, "06:00", for the words a record says. */
export const DAY_STARTS_AT = `${String(DAY_STARTS_AT_HOUR).padStart(2, "0")}:00`;

/** The journal day of a local calendar day (YYYY-MM-DD) and hour: the day itself, or the day before when before 06:00. */
export function journalDay(day: string, hour: number): string {
  return hour < DAY_STARTS_AT_HOUR ? addDays(day, -1) : day;
}
