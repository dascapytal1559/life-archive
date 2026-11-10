// Your settings: data/settings.json, optional, every key optional.
//
//   { "trendMonths": 12, "closenessHalfLifeDays": 90,
//     "catchUpHourWorth": 50, "callMinimumMinutes": 5, "messageReciprocity": 1,
//     "groupSharedPart": 0.5, "tripFullHours": 8 }
//
// trendMonths: how many months back each friend's trend looks (the chart in
// their panel, the label on the hover card, and the comet trail on Orbits).
// closenessHalfLifeDays: how fast a message's weight in the closeness score
// fades, which sets how far from the sun everyone sits on Orbits (see
// src/demos/closeness.ts): a message this many days old counts half.
// catchUpHourWorth: how many direct messages an hour of a catch-up
// (src/catchUps.ts) counts as in the closeness score, on its date, each
// person at it taking their share (groupShare); it then fades by the same half-life. An hour of answered
// calls with someone (the phone's call history) counts the same.
// callMinimumMinutes: how long the answered calls with someone on one day must
// add up to, in minutes, to count at all, so a voicemail counts nothing.
// messageReciprocity: from 0 to 1, how much a month's direct messages with
// someone count by how evenly the two of you wrote (directWeight in
// src/demos/closeness.ts): 0 counts every message 1, 1 counts the month as
// 2 × √(yours × theirs), so a one-way month counts nothing.
// groupSharedPart: from 0 to 1, how much of a hangout or a logged call with
// several people each of them shares whole, the rest split equally among them
// (groupShare in src/catchUps.ts): each takes s + (1 − s) ÷ n of its time, so
// 0 splits it equally (1/n each) and 0.5 gives 2 people 75% each, 4 people
// 63%, 25 people 52%. Group chats keep their own rule.
// tripFullHours: how many hours of a trip (a hangout over several days) count
// whole; past them its time together counts as F × √(hours ÷ F)
// (tripCountedHours in src/catchUps.ts), so a ten-day trip counts about
// three times a long day out, not ten. A hangout on one date counts whole.
// Anything missing or wrong falls back to its default, with a problem naming
// it. The server reads the file (server/settings.ts, GET /api/settings), the
// page loads it through archiveApi.settings (archiveHttp.ts), and
// `npm run check-settings` reports its problems.

import type { ClosenessSettings } from "./archive.ts";

export type { ClosenessSettings };

export interface Settings extends ClosenessSettings {
  trendMonths: number;
}

/** Of `settings`, just those the closeness score is worked out with (the Table asks for its scores with these). */
export function closenessSettings(settings: ClosenessSettings): ClosenessSettings {
  const { closenessHalfLifeDays, catchUpHourWorth, callMinimumMinutes, messageReciprocity, groupSharedPart, tripFullHours } = settings;
  return { closenessHalfLifeDays, catchUpHourWorth, callMinimumMinutes, messageReciprocity, groupSharedPart, tripFullHours };
}

/**
 * An hour of a catch-up, or of answered calls, counts as 50 direct messages (about one solid day of texting), a
 * day's calls under 5 minutes count nothing, direct messages count fully by their balance, half of a hangout or call
 * with several people is shared by all of them, and a trip's first 8 hours count whole, the rest by their square root:
 * docs/settings.md's "How closeness is scored" says why.
 */
export const DEFAULT_SETTINGS: Settings = {
  trendMonths: 12,
  closenessHalfLifeDays: 90,
  catchUpHourWorth: 50,
  callMinimumMinutes: 5,
  messageReciprocity: 1,
  groupSharedPart: 0.5,
  tripFullHours: 8,
};

/** Each setting's allowed range, whether it takes only whole numbers, and the unit its problems name. */
export const SETTING_RANGES: Record<keyof Settings, { min: number; max: number; unit: string; whole: boolean }> = {
  // A fitted line needs at least three months; twenty years is plenty.
  trendMonths: { min: 3, max: 240, unit: "months", whole: true },
  // A week to ten years: shorter would forget a friend within a month, longer never let anyone drift.
  closenessHalfLifeDays: { min: 7, max: 3650, unit: "days", whole: true },
  // From nothing (catch-ups and calls then count for nothing) to a thousand messages an hour.
  catchUpHourWorth: { min: 0, max: 1000, unit: "messages", whole: true },
  // Up to two hours; 0 lets any answered call count, even a voicemail.
  callMinimumMinutes: { min: 0, max: 120, unit: "minutes", whole: true },
  // 0 is the plain count, 1 the balanced score; anything between blends the two.
  messageReciprocity: { min: 0, max: 1, unit: "", whole: false },
  // 0 splits a group's time equally (1/n each), 1 gives everyone at it all of it.
  groupSharedPart: { min: 0, max: 1, unit: "", whole: false },
  // An hour to a whole year of days (DAYS_MOST × 24 in src/catchUps.ts), which counts every trip whole.
  tripFullHours: { min: 1, max: 8784, unit: "hours", whole: false },
};

/** Whether `value` may be setting `name`: a number in its range, whole unless it takes fractions. */
export function settingAllowed(name: keyof Settings, value: unknown): value is number {
  const { min, max, whole } = SETTING_RANGES[name];
  return typeof value === "number" && Number.isFinite(value) && (!whole || Number.isInteger(value)) && value >= min && value <= max;
}

/** What setting `name` must be, for its problems: "a whole number of days from 7 to 3650", "a number from 0 to 1". */
export function settingRule(name: keyof Settings): string {
  const { min, max, unit, whole } = SETTING_RANGES[name];
  return `${whole ? "a whole number" : "a number"}${unit ? ` of ${unit}` : ""} from ${min} to ${max}`;
}

const KEYS = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>;

export interface SettingsReport {
  settings: Settings;
  /** What was wrong in the file, one line each; the defaults were used instead. */
  problems: string[];
}

/** The settings in a parsed settings.json (undefined when there is none), defaults filling any gap. */
export function parseSettings(input: unknown): SettingsReport {
  const settings = { ...DEFAULT_SETTINGS };
  const problems: string[] = [];
  if (input === undefined) return { settings, problems };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { settings, problems: [`must be a JSON object, such as ${JSON.stringify(DEFAULT_SETTINGS)}`] };
  }
  for (const [key, value] of Object.entries(input)) {
    if (!(KEYS as string[]).includes(key)) {
      problems.push(`${key} is not a setting; the settings are ${KEYS.slice(0, -1).join(", ")} and ${KEYS.at(-1)}`);
      continue;
    }
    const name = key as keyof Settings;
    if (settingAllowed(name, value)) settings[name] = value;
    else problems.push(`${name} must be ${settingRule(name)}; using ${DEFAULT_SETTINGS[name]}`);
  }
  return { settings, problems };
}
