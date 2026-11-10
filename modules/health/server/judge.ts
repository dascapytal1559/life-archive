// Judging the results by the one authority (ranges.ts) and ordering them for the page: each result by the band for
// the person's age on the day it was collected, each test by its latest result, the questionable first. Also the
// authority's bands over time for each chart (they change only where an age band ends), the physical assessment by
// where each number came from, and the highest heart rate a trusted recording holds. Everything the page shows is
// worked out here; the page only draws it (viewer/).

import { SYSTEMS, testOf, type TestDef } from "./catalogue.ts";
import { immunisationRecord, protectionOf } from "./immunisations.ts";
import { accountsWith, rangesWith, sourcesWith, type LabInterval } from "./labIntervals.ts";
import { bandFor, gradingFor, lineSource, PERCENT_RULE, RANGES_VERSION, STARS, type Authority, type Band, type Judged, type Sex, type SourceKey, type Start, type Step } from "./ranges.ts";
import { TEST_ACCOUNTS } from "./rangeAccounts.ts";
import { byHandReadings, onlyTranscribed, sameResultOnce, type ByHand, type Imported, type Provenance, type Reading } from "./store.ts";
import {
  ageOn, rungFor, STATUS_ORDER, type AuthorityBand, type BandSpan, type HealthAnswer, type HealthPoint, type HealthRecords, type HealthTest, type Limits, type PhysicalAnswer,
  type PhysicalNumber, type Rung, type Status,
} from "../wire.ts";

/** A result within this share of its interval's width (or of its one limit) from a limit is at the edge. */
export const EDGE = 0.05;

/** The order the physical assessment's numbers are grouped in. */
export const PROVENANCE: readonly Provenance[] = ["measured", "everlab-test", "wearable", "everlab-score"];

/** A band as the page's information modal shows it: its sex and ages, and its limits. */
function authorityBand(band: Band): AuthorityBand {
  return { sex: band.sex ?? null, ages: band.ages ?? null, ...limitsOf(band) };
}

/** A band's limits as the page reads them. */
export function limitsOf(band: Band): Limits {
  return { low: band.low ?? null, high: band.high ?? null, lowOpen: band.lowOpen ?? false, highOpen: band.highOpen ?? false };
}

/**
 * Where `value` stands in `limits`: out of it, at its edge (within EDGE of a limit), or in it; and its margin, how far
 * inside (positive) or outside (negative) the nearer limit it is, as a share of the interval's width, or of the one
 * limit's size when it has one limit. A value on an open limit is out, with a margin of 0.
 */
export function standing(value: number, limits: Limits): { status: Status; margin: number } {
  const { low, high } = limits;
  const scale = low !== null && high !== null ? high - low : Math.abs((low ?? high)!) || 1;
  const margins: number[] = [];
  if (low !== null) margins.push((value - low) / scale);
  if (high !== null) margins.push((high - value) / scale);
  const margin = Math.min(...margins);
  const below = low !== null && (value < low || (limits.lowOpen && value === low));
  const above = high !== null && (value > high || (limits.highOpen && value === high));
  if (below || above) return { status: "out", margin };
  // A hair of rounding is not a margin: 1.05 against a limit of 1.0 is 5% inside it, however the sum comes out.
  return { status: margin <= EDGE + 1e-9 ? "edge" : "in", margin };
}

/** Where a grade starts, for a band whose line on that side is `line` and whose width (or one limit's size) is `width`. */
function startOf(start: Start, line: number, width: number, side: "above" | "below"): number {
  const out = side === "above" ? 1 : -1;
  if ("value" in start) return start.value;
  if ("times" in start) return line * start.times;
  if ("past" in start) return line + out * start.past;
  return line + out * start.share * width;
}

/** A hair of rounding is not a difference: 1.1 × 3 is 3.3 however the sum comes out. */
const round = (n: number) => Number(n.toPrecision(12));

/**
 * The rungs of `band`: in range, then past each limit the grades of its side's grading (gradingFor: a source's), nearest
 * first; a side no source grades is one rung, out, by that side's line's source (lineSource), from the line on. The line never moves: a
 * grade whose start falls inside the range starts at the line instead, leaving any grade before it empty, and an empty
 * grade is dropped. A quantity that cannot go below 0 (its lower limit is above 0) has no rung below 0. `percentRule`
 * grades the ungraded sides by the dashboard's own rule instead (off: PERCENT_RULE).
 */
export function rungsOf(authority: Judged, band: Band, percentRule = PERCENT_RULE): Rung[] {
  const limits = limitsOf(band);
  const rungs: Rung[] = [{ grade: "in", side: "in", ...limits, source: authority.source, label: null }];
  const width = limits.low !== null && limits.high !== null ? limits.high - limits.low : Math.abs((limits.low ?? limits.high)!) || 1;
  for (const side of ["above", "below"] as const) {
    const line = side === "above" ? limits.high : limits.low;
    if (line === null) continue;
    const grading: { source: SourceKey; steps: Step[] } = gradingFor(authority, side, percentRule) ?? { source: lineSource(authority, side), steps: [{ grade: "out", label: "No authority grades further past the line" }] };
    // Each grade's start, and whether the start itself is left to the grade before (open). The first grade starts at
    // the line, which is in range unless the line is open; so does any grade whose start falls inside the range.
    const lineOpen = side === "above" ? limits.highOpen : limits.lowOpen;
    const further = (a: number, b: number) => (side === "above" ? a > b : a < b);
    const starts = grading.steps.map((step, i) => {
      const at = i === 0 || !step.start ? line : round(startOf(step.start, line, width, side));
      return further(at, line) ? { step, at, open: step.open ?? false } : { step, at: line, open: !lineOpen };
    });
    // A grade is empty when the next starts where it does.
    const steps = starts.filter((s, i) => {
      const next = starts[i + 1];
      return !next || further(next.at, s.at) || (next.at === s.at && next.open && !s.open);
    });
    const floor = limits.low !== null && limits.low > 0 ? 0 : null;
    for (let i = 0; i < steps.length; i++) {
      const { step, at: start, open } = steps[i];
      const next = steps[i + 1];
      let rung: Rung =
        side === "above"
          ? { grade: step.grade, side, low: start, lowOpen: open, high: next?.at ?? null, highOpen: next ? !next.open : false, source: grading.source, label: step.label }
          : { grade: step.grade, side, high: start, highOpen: open, low: next?.at ?? null, lowOpen: next ? !next.open : false, source: grading.source, label: step.label };
      if (side === "below" && floor !== null) {
        if (rung.high! <= floor) break;
        if (rung.low !== null && rung.low < floor) rung = { ...rung, low: floor, lowOpen: false };
      }
      rungs.push(rung);
    }
  }
  return rungs;
}

/**
 * The values a test's chart runs over, fixed for its results: on each side of each band's range, nothing past a limit
 * no result goes past (the chart ends at the limit), else the rungs out to the one the farthest result falls in, to
 * that rung's end; a rung with no end, and a side of the range no limit bounds, ends where the farthest result sits
 * mid-way between the rung's start (or the limit) and the edge (openEdge). A side no limit bounds with no result on it
 * is green as tall as the out side drawn opposite, so the limit sits mid-chart. A quantity whose range is above 0 is
 * never drawn below 0. Across bands, the widest; a band with no result adds only its limits. It is only where the chart ends: no limit, band or grade. `points` are the
 * test's results; the scale changes only when one arrives. Null with no band.
 */
export function scaleOf(spans: readonly BandSpan[], points: readonly Pick<HealthPoint, "date" | "value">[] = []): [number, number] | null {
  if (spans.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [i, span] of spans.entries()) {
    const last = i === spans.length - 1;
    const values = points.filter((p) => p.value !== null && p.date >= span.from && (last || p.date < span.to)).map((p) => p.value!);
    let below = edgeOf(span, values, "below");
    let above = edgeOf(span, values, "above");
    // An open in-range side no result reaches still shows where in range is: as tall as the out side drawn opposite,
    // so the limit sits mid-chart (LDL 3.4: yellow 3.0 to 4.14, green 1.86 to 3.0).
    if (span.low === null && span.high !== null && below === span.high) below = Math.max(span.high > 0 ? 0 : -Infinity, round(2 * span.high - above));
    if (span.high === null && span.low !== null && above === span.low) above = round(2 * span.low - below);
    lo = Math.min(lo, below);
    hi = Math.max(hi, above);
  }
  // Only a lone result on the one limit leaves the chart no height: room either side of it.
  if (lo === hi) [lo, hi] = [lo - (Math.abs(lo) * 0.1 || 1), hi + (Math.abs(hi) * 0.1 || 1)];
  return [round(lo), round(hi)];
}

/** Where `span`'s chart ends on `side`, for its results `values` (scaleOf). */
function edgeOf(span: BandSpan, values: readonly number[], side: "above" | "below"): number {
  const line = side === "above" ? span.high : span.low;
  if (line === null) {
    // A side of the range no limit bounds: in range all the way, drawn as far as its results go.
    const limit = (side === "above" ? span.low : span.high)!;
    const edge = openEdge(limit, values, side) ?? limit;
    return side === "below" && limit > 0 ? Math.max(0, edge) : edge;
  }
  const past = values.filter((v) => rungFor(v, span.rungs)?.side === side);
  if (past.length === 0) return line;
  const farthest = side === "above" ? Math.max(...past) : Math.min(...past);
  const rung = rungFor(farthest, span.rungs)!;
  const [start, end] = side === "above" ? [rung.low!, rung.high] : [rung.high!, rung.low];
  return end ?? openEdge(start, [farthest], side) ?? start;
}

/**
 * The chart's edge past `limit` on `side` where nothing bounds it, so that the farthest of `values` past the limit
 * that way sits mid-way between the limit and the edge: limit + 2 × (farthest − limit). Vitamin D's old open side:
 * limit 50, result 65, edge 80. Null when no value is past the limit that way.
 */
export function openEdge(limit: number, values: readonly number[], side: "above" | "below"): number | null {
  const past = values.filter((v) => (side === "above" ? v > limit : v < limit));
  if (past.length === 0) return null;
  const farthest = side === "above" ? Math.max(...past) : Math.min(...past);
  return round(limit + 2 * (farthest - limit));
}

/** The authority's bands over [from, to) for a person born `born` of `sex`: a span for each stretch an age band covers, alike stretches joined. */
export function bandSpans(authority: Authority, sex: Sex, born: string, from: string, to: string): BandSpan[] {
  if ("none" in authority || authority.bands.length === 0) return [];
  const spans: BandSpan[] = [];
  let start = from;
  while (start < to) {
    const age = ageOn(born, start);
    const nextBirthday = `${Number(born.slice(0, 4)) + age + 1}${born.slice(4)}`;
    const end = nextBirthday < to ? nextBirthday : to;
    const band = bandFor(authority, sex, age);
    if (band) {
      const limits = limitsOf(band);
      const last = spans.at(-1);
      if (last && last.to === start && sameLimits(last, limits)) last.to = end;
      else spans.push({ from: start, to: end, ...limits, rungs: rungsOf(authority, band) });
    }
    start = end;
  }
  return spans;
}

function sameLimits(a: Limits, b: Limits): boolean {
  return a.low === b.low && a.high === b.high && a.lowOpen === b.lowOpen && a.highOpen === b.highOpen;
}

/** The side of `limits` whose limit `value` is nearer. */
function nearerSide(value: number, { low, high }: Limits): "above" | "below" {
  if (low === null) return "above";
  if (high === null) return "below";
  return high - value < value - low ? "above" : "below";
}

/** A reading judged: by its words, or by the band for the person's age that day. */
export function judge(reading: Reading, test: TestDef | undefined, authority: Authority | undefined, person: ByHand["person"]): HealthPoint {
  const age = ageOn(person.born, reading.date);
  const band = authority ? bandFor(authority, person.sex, age) : null;
  const limits = band ? limitsOf(band) : null;
  let status: Status = "unjudged";
  let by: string | null = null;
  if (reading.value !== null && band && limits && (limits.low !== null || limits.high !== null)) {
    const judged = authority as Judged;
    status = standing(reading.value, limits).status;
    // At the edge, by the source of the line it is near; in range, by the range's own source.
    by = status === "edge" ? lineSource(judged, nearerSide(reading.value, limits)) : judged.source;
    if (status === "out") {
      // Past the line: graded by the rung it falls in.
      const rung = rungFor(reading.value, rungsOf(judged, band));
      if (rung && rung.grade !== "in") {
        status = rung.grade;
        by = rung.source;
      }
    }
  } else if (reading.text !== null && test?.words) {
    const words = reading.text.trim().toLowerCase();
    if (test.words.expected.some((w) => w.toLowerCase() === words)) status = "in";
    else if (test.words.unexpected.some((w) => w.toLowerCase() === words)) status = "out";
    if (status !== "unjudged" && authority && !("none" in authority)) by = authority.source;
  }
  return {
    date: reading.date,
    age,
    value: reading.value,
    qualifier: reading.qualifier,
    text: reading.text,
    unit: reading.unit,
    printed: reading.printed,
    status,
    limits,
    by,
    labRange: reading.labRange,
    lab: reading.lab,
    sources: reading.sources,
    alsoAs: reading.alsoAs,
    note: reading.note,
  };
}

/** The page's answer for the results in `imported` and `byHand`, with the labs' intervals `labs` (labIntervals.ts), on the local `today`. */
export function healthAnswer({ byHand, imported, labs, today, peak, exercise }: {
  byHand: ByHand;
  imported: Imported | null;
  /** The labs' printed intervals the archive's owner chose for the tests no guideline covers (health/lab-intervals.json). */
  labs: readonly LabInterval[];
  today: string;
  /** The highest heart rate a trusted recording holds (the Exercise service's, from the exercise module), or null. */
  peak: Omit<NonNullable<HealthAnswer["peak"]>, "age"> | null;
  /** Whether the exercise module is there to answer (the Exercise service), so the page may link its Fitness page. */
  exercise: boolean;
}): HealthAnswer {
  const { person } = byHand;
  const [ranges, sources, accounts] = [rangesWith(labs), sourcesWith(labs), accountsWith(labs)];
  const readings = sameResultOnce([...(imported?.readings ?? []), ...byHandReadings(byHand)]);
  // One span of days for every chart, on every tab: from the year of the earliest result of any kind, to today.
  const span = { from: `${(readings[0]?.date ?? today).slice(0, 4)}-01-01`, to: today };
  const byTest = new Map<string, Reading[]>();
  for (const reading of readings) byTest.set(reading.test, [...(byTest.get(reading.test) ?? []), reading]);

  const tests: HealthTest[] = [...byTest].map(([key, own]) => {
    const test = testOf(key);
    const authority = ranges[key] as Authority | undefined;
    const points = own.map((reading) => judge(reading, test, authority, person));
    const latest = points.at(-1)!;
    let status = latest.status;
    let margin = latest.value !== null && latest.limits && status !== "unjudged" ? standing(latest.value, latest.limits).margin : null;
    // A treatment answers a result it would otherwise put near the top; a result in range stays in range.
    const answers = test ? byHand.treatments.find((t) => t.system === test.system) : undefined;
    const treatment = answers && ["far", "out", "mild", "edge"].includes(status) ? answers : undefined;
    if (treatment) {
      status = "treated";
      margin = null;
    }
    const kind = points.some((p) => p.value !== null) ? "number" : "words";
    const judged = authority && !("none" in authority) && kind === "number" ? authority : null;
    const bands = judged ? bandSpans(judged, person.sex, person.born, span.from, span.to) : [];
    const band = judged ? bandFor(judged, person.sex, latest.age) : null;
    return {
      key,
      name: test?.name ?? own[0].printed,
      unit: test?.unit ?? own[0].unit,
      system: test ? SYSTEMS[test.system] : "Other",
      kind,
      status,
      margin,
      points,
      bands,
      rungs: judged && band ? rungsOf(judged, band) : [],
      scale: judged ? scaleOf(bands, points) : null,
      authority:
        authority && !("none" in authority)
          ? {
              source: authority.source,
              note: authority.note ?? null,
              specifics: TEST_ACCOUNTS[key] ?? null,
              bands: authority.bands.map(authorityBand),
              lines: (["above", "below"] as const)
                .filter((side) => authority.bands.some((band) => (side === "above" ? band.high : band.low) !== undefined))
                .map((side) => ({ side, source: lineSource(authority, side) })),
              gradings: (["above", "below"] as const)
                .filter((side) => authority.bands.some((band) => (side === "above" ? band.high : band.low) !== undefined))
                .map((side) => {
                  const grading = gradingFor(authority, side);
                  return { side, source: grading?.source ?? null, note: grading?.note ?? null };
                }),
            }
          : null,
      screen: kind === "words" && test?.words ? { shown: test.words.shown, line: test.words.line } : null,
      noAuthority: !test ? "This test is not in the archive's test table yet, so nothing judges it." : authority && "none" in authority ? authority.none : authority ? null : "No authority is set for this test.",
      treatment: treatment ? `${treatment.what}, since ${monthText(treatment.since)}` : null,
    } satisfies HealthTest;
  });
  tests.sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      (a.margin ?? Infinity) - (b.margin ?? Infinity) ||
      a.name.localeCompare(b.name) ||
      a.key.localeCompare(b.key),
  );

  const used = new Set(
    tests.flatMap((t) => [t.authority?.source, ...(t.authority?.lines.map((l) => l.source) ?? []), ...(t.authority?.gradings.map((g) => g.source ?? undefined) ?? []), ...t.rungs.map((r) => r.source), ...t.bands.flatMap((b) => b.rungs.map((r) => r.source))]).filter((s): s is string => s !== undefined),
  );
  return {
    born: person.born,
    sex: person.sex,
    today,
    span,
    tests,
    systems: Object.entries(SYSTEMS).map(([key, name]) => ({ key, name })),
    sources: Object.entries(sources)
      .filter(([key]) => used.has(key))
      .map(([key, source]) => ({ key, ...source, links: source.links ?? [], ...accounts[key] })),
    stars: STARS,
    rangesVersion: RANGES_VERSION,
    physical: physicalAnswer(byHand, tests),
    peak: peak ? { bpm: peak.bpm, date: peak.date, age: ageOn(person.born, peak.date), sensor: peak.sensor, recorder: peak.recorder, source: peak.source, activity: peak.activity } : null,
    exercise,
    records: recordsOf(byHand, today),
    unread: imported?.files.filter((f) => f.read === "unread").map((f) => f.path) ?? [],
    importedAt: imported?.importedAt ?? null,
  };
}

/**
 * The records that are no lab result, newest first, each marked when only a transcription has it, and what the
 * immunisations protect against on `today` (immunisations.ts).
 */
export function recordsOf(byHand: ByHand, today: string): HealthRecords {
  const newest = <T>(records: readonly T[], day: (record: T) => string) => [...records].sort((a, b) => day(b).localeCompare(day(a)));
  const marked = <T extends { sources: string[] }>(record: T) => ({ ...record, transcribed: onlyTranscribed(record, byHand) });
  return {
    immunisations: newest(byHand.immunisations ?? [], (r) => r.date).map((r) => marked(immunisationRecord(r))),
    protection: protectionOf(byHand.immunisations ?? [], byHand.person.born, today),
    medicines: newest(byHand.medicines ?? [], (r) => r.date).map((r) =>
      marked({ ...r, brand: r.brand ?? null, directions: r.directions ?? null, supply: r.supply ?? null }),
    ),
    services: newest(byHand.medicare?.services ?? [], (r) => r.date).map((r) => marked({ ...r, provider: r.provider ?? null, fee: r.fee ?? null })),
    pbs: newest(byHand.medicare?.pbs ?? [], (r) => r.supplied).map(marked),
    transcriptions: byHand.transcriptions ?? [],
  };
}

/** The physical assessment as the report has it, its numbers grouped by where they came from. */
function physicalAnswer(byHand: ByHand, tests: readonly HealthTest[]): PhysicalAnswer | null {
  const physical = byHand.physical;
  if (!physical) return null;
  const numberOf = (item: (typeof physical.items)[number]): PhysicalNumber => {
    if (item.test) {
      const test = tests.find((t) => t.key === item.test);
      const point = test?.points.find((p) => p.date === physical.date);
      if (!test || !point) throw new Error(`the physical assessment shows ${item.test}, but there is no reading of it on ${physical.date}`);
      return { label: test.name, value: point.value, text: point.text, unit: test.unit, everlab: item.everlab ?? null, page: item.page ?? null, status: point.status };
    }
    return {
      label: item.label ?? "",
      value: item.value ?? null,
      text: item.text ?? null,
      unit: item.unit ?? null,
      everlab: item.everlab ?? null,
      page: item.page ?? null,
      status: null,
    };
  };
  return {
    file: physical.file,
    date: physical.date,
    printed: physical.printed,
    groups: PROVENANCE.map((from) => ({ from, numbers: physical.items.filter((item) => item.from === from).map(numberOf) })).filter((g) => g.numbers.length > 0),
    missing: physical.missing,
    unexplained: physical.unexplained,
    zones: physical.items
      .filter((item): item is typeof item & { zone: number; value: number } => item.zone !== undefined && item.value !== undefined)
      .map((item) => ({ zone: item.zone, bpm: item.value }))
      .sort((a, b) => a.zone - b.zone),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03" or "2026-03-10" as "Mar 2026". */
function monthText(since: string): string {
  const [year, month] = since.split("-");
  return month ? `${MONTHS[Number(month) - 1]} ${year}` : year;
}
