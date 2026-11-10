// The Events calendar's day: when it begins by the archive's clock, and which day an instant is in. One rule for the
// page (viewer/console/calendar/) and the server (server/calendar/, whose day summaries are keyed by it), so a day's
// messages, faces and rituals are the same day everywhere.

import { dayKeyAt, dayStartAt } from "./time.ts";

/**
 * When the Events calendar's days begin by the archive's clock, its one setting for them: 06:00, so a late evening and
 * the small hours after it stay one day rather than splitting at midnight, as the rituals' days already run. From midnight to 05:59 is still the day before, in every view, its summaries, totals
 * and people, its week (Monday 06:00 to the next) and month, and Today itself; the small hours come last in a day's
 * list, after its evening, at their own clock times.
 */
export const EVENTS_DAY_BEGINS = "06:00";

/** The Events calendar's day an instant is in: before EVENTS_DAY_BEGINS it is still the day before's, Today too. */
export const calendarDayOf = (ms: number): string => dayKeyAt(ms, EVENTS_DAY_BEGINS);

/** When an Events calendar day begins: at EVENTS_DAY_BEGINS on its date, running to that time the next morning. */
export const calendarDayStart = (day: string): number => dayStartAt(day, EVENTS_DAY_BEGINS);
