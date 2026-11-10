// Health in the console: the Health page's view (HealthView.tsx), wrapped, with the console's blocks above
// it. Each of Health's own tabs (tabs.ts) is one view under the Health Record aspect (the module's viewer.tsx), so a tab added there is a tab
// here; the first, All, is the aspect's address itself. Above the results the console's blocks say what the tab shows:
// a KPI a status (out, mildly out, at the edge, in range, and under treatment or not judged when any), a chart of the
// results taken each year and the person judged for; above Records, how many of each record and when the last came;
// above Sources, the sources by their stars. The view itself is the same code as the old page's, re-coloured by the
// console's tokens (the core's console.css), so the immunisations' protection bars, the charts and the range modal are those.

import { HealthView } from "./HealthView.tsx";
import { dayText, shownStatus, SHOWN_ORDER, STATUS_WORDS, type Shown } from "./format.ts";
import { HEALTH_TABS, type HealthTab } from "./tabs.ts";
import type { HealthAnswer, HealthRecords } from "../wire.ts";
import { BarChart, Card, consolePath, Facts, Kpi, Kpis, LOCALE, type Bar, type View } from "../../../sdk/viewer.ts";

/** The Health Record aspect's key in the registry. */
export const HEALTH_ASPECT = "health-record";
/** The Fitness page's aspect key: the exercise module's page, which every workout is on, linked by its key alone. */
const FITNESS_ASPECT = "fitness";

const BLURBS: Record<string, string> = {
  "": "Every result, what needs looking at first; the physical assessment after them.",
  physical: "The body scan, blood pressure, the highest heart rate recorded and the physical assessment.",
  cholesterol: "The lipids.",
  allergies: "The specific IgE results, under treatment where a treatment answers them.",
  records: "Immunisations and what they protect against, medicines, and Medicare's claims.",
  sources: "How results are judged, each source and its stars, and the sample's quality.",
};

/** The address of a Health tab in the console: All is the aspect's own. */
export const healthPath = (tab: HealthTab): string => consolePath(HEALTH_ASPECT, tab.key || undefined);

/** The Health views: one for each of Health's own tabs, in their order. */
export function healthViews(): View[] {
  return HEALTH_TABS.map((tab) => ({
    key: `health-${tab.key || "all"}`,
    label: tab.label,
    aspects: [HEALTH_ASPECT],
    section: tab.key || "all",
    blurb: BLURBS[tab.key] ?? "",
    component: () => <HealthSection tab={tab} />,
  }));
}

export function HealthSection({ tab }: { tab: HealthTab }) {
  return <HealthView tab={tab} tabPath={healthPath} exercisePath={consolePath(FITNESS_ASPECT)} above={(answer) => <HealthBlocks answer={answer} tab={tab} />} />;
}

/** The console's blocks above a Health tab, from the one answer the view fetched. */
export function HealthBlocks({ answer, tab }: { answer: HealthAnswer; tab: HealthTab }) {
  if (tab.records) return <RecordsBlocks records={answer.records} span={answer.span} />;
  if (tab.sources) return <SourcesBlocks answer={answer} />;
  const shown = answer.tests.filter(tab.holds);
  const counts = SHOWN_ORDER.map((status) => [status, shown.filter((test) => shownStatus(test.status) === status).length] as const);
  const always: ReadonlySet<Shown> = new Set(["out", "mild", "edge", "in"]);
  const kpis = counts.filter(([status, n]) => always.has(status) || n > 0);
  const results = shown.flatMap((test) => test.points.map((point) => point.date));
  const latest = results.toSorted().at(-1);
  return (
    <>
      <Kpis label="Results by status">
        {kpis.map(([status, n]) => (
          <Kpi key={status} label={STATUS_WORDS[status]} value={n.toLocaleString(LOCALE)} tone={status} note={NOTES[status](n, shown.length)} />
        ))}
      </Kpis>
      <div className="two">
        <Card title="Results taken" aside={`${plural(shown.length, "test")} · ${plural(results.length, "result")}`}>
          <BarChart bars={byYear(results, answer.span)} label="Results taken each year" />
        </Card>
        <Card title="Judged for" aside={`ranges ${answer.rangesVersion}`}>
          <Facts
            facts={[
              { key: "Who", value: `A ${answer.sex === "male" ? "man" : "woman"} born ${dayText(answer.born)}` },
              { key: "By", value: "The band for the age that day" },
              { key: "Latest result", value: latest ? dayText(latest) : "—" },
              { key: "Exports last read", value: answer.importedAt ? dayText(answer.importedAt.slice(0, 10)) : "never" },
            ]}
          />
        </Card>
      </div>
    </>
  );
}

const NOTES: Record<Shown, (n: number, of: number) => string> = {
  out: (n) => (n > 0 ? "look at these first" : "nothing out"),
  mild: (n) => (n > 0 ? "past the line" : "none"),
  edge: () => "still in range, near a limit",
  in: (n, of) => `of ${plural(of, "test")}`,
  treated: () => "answered by a treatment",
  unjudged: () => "no authority judges them",
};

function RecordsBlocks({ records, span }: { records: HealthRecords; span: HealthAnswer["span"] }) {
  const { protection, immunisations, medicines, services, pbs, transcriptions } = records;
  const dates = [...immunisations.map((r) => r.date), ...medicines.map((r) => r.date), ...services.map((r) => r.date), ...pbs.map((r) => r.supplied)];
  const latest = (days: string[]) => (days.length ? dayText(days.toSorted().at(-1)!) : "—");
  return (
    <>
      <Kpis label="Records">
        <Kpi label="Protected against" value={protection.length} note="diseases the immunisations name" tone="accent" />
        <Kpi label="Immunisations" value={immunisations.length} note={`latest ${latest(immunisations.map((r) => r.date))}`} />
        <Kpi label="Medicines" value={medicines.length} note="prescribed and dispensed" />
        <Kpi label="Medicare services" value={services.length} note="MBS items claimed" />
        <Kpi label="PBS medicines" value={pbs.length} note="supplied under the PBS" />
      </Kpis>
      <div className="two">
        <Card title="Records by year" aside={plural(dates.length, "record")}>
          <BarChart bars={byYear(dates, span)} label="Records each year" />
        </Card>
        <Card title="Where they come from" aside="My Health Record, Medicare">
          <Facts
            facts={[
              { key: "Latest medicine", value: latest(medicines.map((r) => r.date)) },
              { key: "Latest claim", value: latest(services.map((r) => r.date)) },
              { key: "Transcribed by hand", value: transcriptions.length ? plural(transcriptions.length, "file") : "nothing" },
            ]}
          />
        </Card>
      </div>
    </>
  );
}

function SourcesBlocks({ answer }: { answer: HealthAnswer }) {
  const stars = (n: number) => answer.sources.filter((source) => source.stars === n).length;
  return (
    <Kpis label="Sources by stars">
      <Kpi label="Sources" value={answer.sources.length} note="one authority a test" tone="accent" />
      <Kpi label="Three stars" value={stars(3)} note="made for exactly this use" />
      <Kpi label="Two stars" value={stars(2)} note="respected, used beyond its purpose" />
      <Kpi label="One star" value={stars(1)} note="a single lab's printed interval" />
    </Kpis>
  );
}

/** How many of `days` (YYYY-MM-DD) fall in each year of `span`, a bar a year. */
export function byYear(days: readonly string[], span: { from: string; to: string }): Bar[] {
  const first = Number(span.from.slice(0, 4));
  const last = Number(span.to.slice(0, 4));
  const counts = new Map<number, number>();
  for (const day of days) {
    const year = Number(day.slice(0, 4));
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  const bars: Bar[] = [];
  for (let year = first; year <= last; year++) bars.push({ label: String(year), value: counts.get(year) ?? 0 });
  return bars;
}

const plural = (n: number, word: string) => `${n.toLocaleString(LOCALE)} ${word}${n === 1 ? "" : "s"}`;
