// How the Health tab writes what it shows: days as "10 Mar 2026", values with the test's own decimals, intervals as
// "3.5–5.2" or "5.5 or under", each status and grade in words and in one of three colours, a test's rungs as the
// three bands it draws (none on a side no limit bounds), the places that reported it, and a source's stars.

import { STATUS_ORDER, type Grade, type HealthPoint, type HealthTest, type Limits, type Rung, type Stars, type Status } from "../wire.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03-10" as "10 Mar 2026". */
export function dayText(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "2026-03-10" as "Mar 2026". */
export function monthText(day: string): string {
  const [y, m] = day.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** A day as ms (UTC midnight): for placing it on a chart. */
export function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function decimals(n: number): number {
  return (String(n).split(".")[1] ?? "").length;
}

/**
 * The decimals a test's values are written with: as many as its most precise value or limit, or as the labs print its
 * range ("<4.0"), since a value read as a number loses the zeros the lab printed (4.0 is read as 4).
 */
export function decimalsOf(test: HealthTest): number {
  const numbers = test.points.flatMap((p) => [p.value, p.limits?.low ?? null, p.limits?.high ?? null]).filter((n): n is number => n !== null);
  const printed = test.points.flatMap((p) => (p.labRange ?? "").match(/\d+(?:\.\d+)?/g) ?? []).map((n) => (n.split(".")[1] ?? "").length);
  return Math.min(3, Math.max(0, ...numbers.map(decimals), ...printed));
}

/** A number with `dp` decimals, a true minus sign for a negative. */
export function numberText(n: number, dp: number): string {
  return n.toFixed(dp).replace(/^-/, "−");
}

/** A point's result: "5.3", ">90", or its words. */
export function valueText(point: HealthPoint, dp: number): string {
  if (point.value === null) return point.text ?? "—";
  return `${point.qualifier ?? ""}${numberText(point.value, dp)}`;
}

/** An interval in words, with its unit: "3.5–5.2 mmol/L", "5.5 mmol/L or under", "under 75 nmol/L", "over −2.0". */
export function limitsText(limits: Limits, dp: number, unit: string | null = null): string {
  const { low, high, lowOpen, highOpen } = limits;
  const n = (x: number) => numberText(x, Math.max(dp, decimals(x)));
  const u = unit ? ` ${unit}` : "";
  if (low !== null && high !== null) {
    if (!lowOpen && !highOpen) return `${n(low)}–${n(high)}${u}`;
    return `${lowOpen ? "over " : ""}${n(low)} to ${highOpen ? "under " : ""}${n(high)}${u}`;
  }
  if (high !== null) return highOpen ? `under ${n(high)}${u}` : `${n(high)}${u} or under`;
  if (low !== null) return lowOpen ? `over ${n(low)}${u}` : `${n(low)}${u} or more`;
  return "any";
}

/**
 * The page shows three colours, not the server's four grades: green in range (at the edge too), yellow mildly out,
 * red out. Out and far out are one red: the grading under them is unchanged, and far out still sorts first.
 */
export type Shown = Exclude<Status, "far">;
export type ShownGrade = Exclude<Grade, "far">;

export function shownStatus(status: Status): Shown {
  return status === "far" ? "out" : status;
}

export function shownGrade(grade: Grade): ShownGrade {
  return grade === "far" ? "out" : grade;
}

/** The page's groups, in the server's order with far out folded into out. */
export const SHOWN_ORDER: readonly Shown[] = STATUS_ORDER.filter((s): s is Shown => s !== "far");

/** One band of a test's range as the page draws it: its rungs of one colour on one side, merged, with each rung kept. */
export interface ShownRung extends Omit<Rung, "grade"> {
  grade: ShownGrade;
  parts: Rung[];
}

/** A test's rungs as the page's bands: each side's out and far out rungs one red band, from the nearest to the farthest. */
export function shownRungs(rungs: readonly Rung[]): ShownRung[] {
  const out: ShownRung[] = [];
  for (const rung of rungs) {
    const grade = shownGrade(rung.grade);
    const last = out.at(-1);
    if (!last || last.grade !== grade || last.side !== rung.side) {
      out.push({ ...rung, grade, parts: [rung] });
      continue;
    }
    // The next rung out on the same side: it extends the band away from the line.
    last.parts.push(rung);
    if (rung.side === "above") Object.assign(last, { high: rung.high, highOpen: rung.highOpen });
    else Object.assign(last, { low: rung.low, lowOpen: rung.lowOpen });
  }
  return out;
}

/**
 * The places that reported a test, in the order they first did, each once: "Sample Pathology, Sample Lab". A place's name is the lab's as the data gives it, up to any comma ("Everlab, measured at …" is Everlab),
 * so the list's commas only part places.
 */
export function placesText(test: HealthTest): string {
  return [...new Set(test.points.map((p) => p.lab.split(",")[0].trim()))].join(", ");
}

export const STATUS_WORDS: Record<Status, string> = {
  far: "Out",
  out: "Out",
  mild: "Mildly out",
  edge: "At the edge",
  in: "In range",
  treated: "Under treatment",
  unjudged: "Not judged",
};

export const GRADE_WORDS: Record<Grade, string> = {
  in: "In range",
  mild: "Mildly out",
  out: "Out",
  far: "Out",
};

/** A source's stars as a mark: "★★☆"; none, "☆☆☆". */
export function starsText(stars: Stars): string {
  return "★".repeat(stars) + "☆".repeat(3 - stars);
}

/** A screen's word for a result of its status: its expected word ("Clear", "Immune") in range, "Positive" out; null
 * for a test of numbers, or a result no rule reads. */
export function screenWord(test: Pick<HealthTest, "screen">, status: Status): string | null {
  if (!test.screen) return null;
  if (status === "in") return test.screen.shown;
  if (status === "out" || status === "far") return "Positive";
  return null;
}
