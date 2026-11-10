// How the Records tab writes what the immunisations protect against (Protection.tsx): a disease with its everyday name,
// how far through its interval today is, and how long is left or since it ended, in words.

import type { DiseaseName, ProtectionSpan } from "../wire.ts";
import { dayMs, dayText } from "./format.ts";

/** "Pertussis (whooping cough)", or the name alone where there is no everyday one. */
export function diseaseText({ name, everyday }: DiseaseName): string {
  return everyday ? `${name} (${everyday})` : name;
}

/** How far `today` is from `from` to `until`, from 0 (the dose's day) to 1 (its end or after). */
export function elapsed(from: string, until: string, today: string): number {
  const whole = dayMs(until) - dayMs(from);
  return whole <= 0 ? 1 : Math.min(1, Math.max(0, (dayMs(today) - dayMs(from)) / whole));
}

/** The whole months from `from` to `to` (a later day), counting a month only once its day is reached. */
function wholeMonths(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
}

/** The time between two days, either order, as "3 years 2 months", "5 months" or "12 days". */
export function durationText(a: string, b: string): string {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const months = wholeMonths(from, to);
  if (months < 1) {
    const days = Math.round((dayMs(to) - dayMs(from)) / 86_400_000);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  const [y, m] = [Math.floor(months / 12), months % 12];
  return [y && `${y} year${y === 1 ? "" : "s"}`, m && `${m} month${m === 1 ? "" : "s"}`].filter(Boolean).join(" ");
}

/** What a span's bar says beside it, on `today`. */
export function spanText(span: ProtectionSpan, today: string, known: boolean): string {
  if (span === null) return known ? "No set interval" : "Interval not known";
  if (span.kind === "lasting") return span.label === "lifelong" ? "Lifelong" : "No booster set";
  const ended = span.until <= today;
  if (span.kind === "course") {
    return `Course incomplete: ${span.doses} of ${span.of} doses; the next ${ended ? "was due" : "is due"} from ${dayText(span.until)}`;
  }
  return ended ? `Interval of ${span.interval} ended ${durationText(span.until, today)} ago` : `${durationText(today, span.until)} left of ${span.interval}`;
}
