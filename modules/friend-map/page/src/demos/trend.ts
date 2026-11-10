import { locale } from "../time.ts";
// Whether a friendship is getting closer or drifting apart over the look-back
// window (trendMonths in data/settings.json, 12 by default): a straight line
// fitted through how much you talked each month, and a plain label from it.
// Pure functions, no DOM.
//
// The rule, in one sentence: fit a least-squares line through the window's
// monthly message counts; if the line rises by at least half the window's
// average month from its first month to its last, you are getting closer; if
// it falls by that much, drifting apart; otherwise steady. With fewer messages
// than months in the window (under one a month), there is too little to tell.
//
// "How much you talked" is the model's series: direct messages both ways plus
// what they sent in group chats. The month in progress is left out, since a
// few days in, any friendship would look like it is fading; so is a month
// before anyone's first message, which counts as none.

/** The fitted line must change by this share of the average month to count. */
export const TREND_THRESHOLD = 0.5;

export type TrendKind = "closer" | "apart" | "steady" | "quiet";

export interface Trend {
  kind: TrendKind;
  /** The window, as indexes into the series (and model.months), first to last inclusive; `from` may be below 0. */
  from: number;
  to: number;
  /** Messages each month of the window, oldest first. */
  counts: number[];
  total: number;
  /** The average month. */
  mean: number;
  /** The fitted line's value at the first month of the window and at the last. */
  start: number;
  end: number;
  /** (end - start) / mean: how far the line moves over the window, as a share of the average month; 0 with no messages. */
  change: number;
}

/**
 * The trend over the `months` months ending with month `to` (an index into
 * `series`). See trendEnd for which month that is.
 */
export function trendOf(series: number[], to: number, months: number): Trend {
  const from = to - months + 1;
  const counts = Array.from({ length: months }, (_, i) => series[from + i] ?? 0);
  const total = counts.reduce((a, b) => a + b, 0);
  const mean = total / months;
  // Least squares with x centred on the middle month: slope = Σ x·y / Σ x².
  const middle = (months - 1) / 2;
  let xy = 0;
  let xx = 0;
  counts.forEach((y, i) => {
    xy += (i - middle) * y;
    xx += (i - middle) ** 2;
  });
  const slope = xx === 0 ? 0 : xy / xx;
  const start = mean - slope * middle;
  const end = mean + slope * middle;
  const change = mean === 0 ? 0 : (end - start) / mean;
  const kind: TrendKind =
    total < months ? "quiet" : change >= TREND_THRESHOLD ? "closer" : change <= -TREND_THRESHOLD ? "apart" : "steady";
  return { kind, from, to, counts, total, mean, start, end, change };
}

/**
 * The last month a trend as of month `at` counts: `at` itself for a month in
 * the past, and the one before for the last month, which is still in progress.
 */
export function trendEnd(at: number, monthCount: number): number {
  return at >= monthCount - 1 ? monthCount - 2 : at;
}

export const TREND_WORDS: Record<TrendKind, string> = {
  closer: "getting closer",
  apart: "drifting apart",
  steady: "steady",
  quiet: "too quiet to tell",
};

/** "getting closer: 8 → 21 a month" (the fitted line's two ends), or "too quiet to tell: 5 messages". */
export function trendSummary(trend: Trend): string {
  return `${TREND_WORDS[trend.kind]}: ${trendDetail(trend)}`;
}

/** The numbers behind the label: "8 → 21 a month", or "5 messages" when too quiet to tell. */
export function trendDetail(trend: Trend): string {
  if (trend.kind === "quiet") return trend.total === 1 ? "1 message" : `${trend.total} messages`;
  return `${perMonth(trend.start)} → ${perMonth(trend.end)} a month`;
}

/** "12 months", "2 years", "18 months". */
export function windowLabel(months: number): string {
  return months % 12 === 0 && months >= 24 ? `${months / 12} years` : `${months} months`;
}

function perMonth(n: number): string {
  const value = Math.max(0, n);
  return value < 10 ? String(Math.round(value * 10) / 10) : Math.round(value).toLocaleString(locale());
}
