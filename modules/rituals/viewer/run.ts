// The arithmetic of Daily rituals' whole run (RunRows.tsx draws it), take D of the layout takes the captain liked ("I
// really like the option D where I can see everything at a glance and I also like the idea of having today as a carve
// out"): today in a column of its own at the left, then every day before it, newest at the left (yesterday, beside
// today) and oldest at the right, squeezed to fit the card's width as thin ticks, with no scrollbar. Each habit is named
// at its newest end, the left, so a habit that began lately has its ticks and its name beside today and the days before
// it began, empty, at the right ("New entries should start from the left, not from the right").
//
// A run does not fit for ever: a day is never narrower than MIN_DAY_PX. When the whole run would be (a phone, or many
// months), the run shows the most recent days that fit, and the card says from which date.
//
// Today is never counted ("Let's also not count today. So this should stay uncounted until 6 a.m."): a row's count is
// over the closed days shown, and today joins it when rituals' 06:00 cutoff closes the day and it becomes one of them.
//
// A closed day with no answer is a not done ("On daily rituals no answer is considered not done"): drawn as the red
// mark and counted, so only a day it was not asked (a grey dot) or before the row began is left out of the count.

import { DONE_MARKS, isMonday, tickOf, type DotRow, type Mark, type Slot } from "./dots.ts";

/** The narrowest a day may be, in px. */
export const MIN_DAY_PX = 3;

/** The room a date on the axis needs, in px ("21 Sept" in 10 px mono is about 48, and a gap before the next). */
export const LABEL_PX = 56;

/** The days shown, newest first, and whether earlier ones were left out for want of room. */
export interface Fit {
  readonly days: readonly Slot[];
  readonly cropped: boolean;
}

/**
 * The most recent of `history` (oldest first, ending yesterday) that fit `width` px at `min` px a day or wider, turned
 * round to run newest first; all of it before the width is known (0).
 */
export function fitDays(history: readonly Slot[], width: number, min = MIN_DAY_PX): Fit {
  const room = Math.max(1, Math.floor(width / min));
  const cropped = width > 0 && room < history.length;
  return { days: (cropped ? history.slice(-room) : history).toReversed(), cropped };
}

/** A date on the axis: the day it stands at, by its place among the days shown, which edge of it the date is held to, and its words. */
export interface AxisLabel {
  readonly at: number;
  readonly edge: "start" | "end";
  readonly text: string;
}

/**
 * The axis's dates, `dayPx` a day, for days running newest first: the newest day shown always, its date running right
 * from its left edge, then each Monday with room for its words after the last date named, its date running left from
 * the Monday's right edge, which is where its week begins (and where the seam is), over that week.
 */
export function axisLabels(days: readonly Slot[], dayPx: number, labelPx = LABEL_PX): AxisLabel[] {
  const labels: AxisLabel[] = [];
  let taken = 0;
  days.forEach((slot, at) => {
    if (at === 0) {
      labels.push({ at, edge: "start", text: tickOf(slot.key) });
      taken = labelPx;
      return;
    }
    const end = (at + 1) * dayPx;
    if (isMonday(slot.key) && end - labelPx >= taken) {
      labels.push({ at, edge: "end", text: tickOf(slot.key) });
      taken = end;
    }
  });
  return labels;
}

/** What a closed day with no answer says in its tooltip: it is a not done. */
export const NO_ANSWER_WORDS = "Not done (no answer)";

/**
 * A day of a row on the run: its mark, a grey dot for a day it was not asked, nothing before the row began. A closed day
 * the row applied on with no answer is a not done ("On daily rituals no answer is considered not done"), the same red
 * mark. Only for the closed days: today's mark is its dot, still going or not asked, never an unanswered not done.
 */
export type RunMark = Mark | "not_asked" | "before";

export function runMark(row: DotRow, day: string): RunMark {
  const dot = row.dots.get(day);
  if (dot) return dot.mark;
  if (row.notAsked.has(day)) return "not_asked";
  return day < row.since ? "before" : "not_done";
}

/** What a closed day says in its tooltip after its date: rituals' words for it, "Not asked", or that no answer is a not done. */
export const runWords = (row: DotRow, day: string): string => row.dots.get(day)?.words ?? (row.notAsked.has(day) ? "Not asked" : NO_ANSWER_WORDS);

/** A row's counts over the closed days shown, no answer counting as not done and not asked not counting: never today, which joins them once its day has closed. */
export function runCount(row: DotRow, days: readonly Slot[]): { done: number; counted: number } {
  const marks = days.map((slot) => runMark(row, slot.key));
  // A wind-down ticked late, or with no time, is still done: its colour says when, its count that it was.
  const done = marks.filter((mark) => DONE_MARKS.has(mark as Mark)).length;
  return { done, counted: done + marks.filter((mark) => mark === "not_done").length };
}
