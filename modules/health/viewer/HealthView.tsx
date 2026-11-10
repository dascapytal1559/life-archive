// The Health tab: every health result the archive keeps, judged by one authority on range and graded by how far past
// its line, ordered so what needs looking at is at the top (out, far out first, then mildly out, then at the edge) and
// the healthy sink to the bottom, with what is under treatment and what nothing judges after them. No summary: the
// order is the summary. Three colours: green in range, yellow mildly out, red out (format.ts's shownStatus), and only
// where an authority sets them. Beside each result, its grade, which opens how it was judged and each source's stars.
// Every number is a chart over the same days (Charts.tsx). The highest heart rate recorded and the physical
// assessment, each number labelled by where it came from, sit below the results, or above them on Physical; the
// workouts themselves are the Fitness page's (the exercise module's), which a line there links to. The page's tab (tabs.ts) shows a
// slice of it: its own results, ordered and counted the same way, and the physical assessment where the tab has it.
// The results group by status (the default) or by category (grouping.ts), the choice kept in the address's query; by
// category, each section is a category in its colour and its cards drop the category chip the heading already says;
// its heading folds it (remembered on this device), a folded one still showing its count and how many are out.
// How results are judged and the sources sit on their own tab, Sources, with the sample-quality results; the records
// that are no lab result (immunisations, medicines, Medicare's claims) on theirs, Records (Records.tsx); the other tabs
// end with a line pointing to both.
// A result's grade opens how its range and grades were built (RangeInfo.tsx); its places open what each printed.
// Everything comes judged from the server (../server/judge.ts); this only draws it.
// The console (HealthSection.tsx) shows it under its Health Record aspect: it gives the tabs'
// addresses there (`tabPath`) and draws its own blocks above the results from the one answer (`above`).

import { useEffect, useId, useState, type MouseEvent, type ReactNode } from "react";
import { ageOn, HEALTH_API, type HealthAnswer, type HealthSource, type HealthTest, type PhysicalAnswer, type Provenance, type Status } from "../wire.ts";
import { ScreenChart, TrendChart } from "./Charts.tsx";
import { otherLines, RangeInfo } from "./RangeInfo.tsx";
import { Records } from "./Records.tsx";
import { categoryKeys, COLLAPSED_KEY, collapsedOf, foldedHint, GROUP_BYS, groupByOf, groupBySearch, groupTests, toggled, type GroupBy } from "./grouping.ts";
import { HEALTH_TABS, type HealthTab } from "./tabs.ts";
import { dayText, decimalsOf, limitsText, monthText, placesText, screenWord, shownStatus, starsText, STATUS_WORDS, valueText } from "./format.ts";

const SOURCES_TAB = HEALTH_TABS.find((t) => t.sources)!;
const RECORDS_TAB = HEALTH_TABS.find((t) => t.records)!;

/** Opens `tab` in place, at the address `path` gives it, as its own tab does, keeping the address's query (the grouping). */
const openTab = (tab: HealthTab, path: (tab: HealthTab) => string) => openPath(path(tab), location.search);

/** Opens `address` in place (another view of the console), as a link in the console does; a modified click as the browser would. */
const openPath = (address: string, search = "") => (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  history.pushState(null, "", address + search);
  dispatchEvent(new PopStateEvent("popstate"));
  scrollTo(0, 0);
};

export function HealthView({
  tab,
  tabPath,
  exercisePath,
  above,
}: {
  tab: HealthTab;
  /** The address of each tab (the console's). */
  tabPath: (tab: HealthTab) => string;
  /** The Fitness page's address, which every workout is on, and a peak's activity's under it. */
  exercisePath: string;
  /** Drawn above the results from the answer, once it has come (the console's blocks). */
  above: (answer: HealthAnswer) => ReactNode;
}) {
  const [answer, setAnswer] = useState<HealthAnswer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>(() => groupByOf(location.search));

  // Back and forward restore the grouping the address held.
  useEffect(() => {
    const back = () => setGroupBy(groupByOf(location.search));
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);

  const chooseGroupBy = (by: GroupBy) => {
    history.replaceState(history.state, "", location.pathname + groupBySearch(location.search, by) + location.hash);
    setGroupBy(by);
  };

  useEffect(() => {
    const abort = new AbortController();
    fetch(HEALTH_API, { signal: abort.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as HealthAnswer & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        setAnswer(body);
      })
      .catch((error: Error) => abort.signal.aborted || setFailed(error.message));
    return () => abort.abort();
  }, []);

  useEffect(() => {
    document.title = `${tab.key ? `${tab.label} · ` : ""}Health · Life archive`;
  }, [tab]);

  if (failed) return <p className="viewer__message">The health results are unavailable: {failed}</p>;
  if (!answer) return <p className="viewer__message">Loading…</p>;
  return (
    <>
      {above(answer)}
      <Health answer={answer} tab={tab} groupBy={groupBy} onGroupBy={chooseGroupBy} tabPath={tabPath} exercisePath={exercisePath} />
    </>
  );
}

function Health({
  answer,
  tab,
  groupBy,
  onGroupBy,
  tabPath,
  exercisePath,
}: {
  answer: HealthAnswer;
  tab: HealthTab;
  groupBy: GroupBy;
  onGroupBy: (by: GroupBy) => void;
  tabPath: (tab: HealthTab) => string;
  /** The Fitness page's address, which every workout is on, and a peak's activity's under it. */
  exercisePath: string;
}) {
  const sources = new Map(answer.sources.map((s) => [s.key, s]));
  // The server's order (status, then margin, then name) holds within any slice of it.
  const shown = answer.tests.filter(tab.holds);
  const [info, setInfo] = useState<HealthTest | null>(null);
  const groups = groupTests(shown, groupBy, answer.systems);
  const categories = categoryKeys(answer.systems);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return collapsedOf(localStorage.getItem(COLLAPSED_KEY));
    } catch {
      return new Set<string>();
    }
  });
  const toggle = (key: string) =>
    setCollapsed((was) => {
      const next = toggled(was, key);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Not remembered; the page still folds.
      }
      return next;
    });
  const unread = answer.unread.length > 0 && (
    <p className="health__warn">
      Not read yet: {answer.unread.join(", ")}. Transcribe {answer.unread.length === 1 ? "it" : "them"} in the health records' by-hand.json.
    </p>
  );
  if (tab.records) {
    return (
      <div className="health">
        {unread}
        <Records records={answer.records} today={answer.today} />
      </div>
    );
  }
  return (
    <div className="health">
      <div className="health__top">
        <p className="health__who">
          Judged for a {answer.sex === "male" ? "man" : "woman"} born {dayText(answer.born)}, by the band for the age on each day a sample was taken.
          {tab.fitness === "last" && (
            <>
              {" "}
              <a href="#fitness">Heart rate and the physical assessment ↓</a>
            </>
          )}
        </p>
        {shown.length > 0 && (
          <div className="health__group-by" role="radiogroup" aria-label="Group by">
            <span>Group by</span>
            {GROUP_BYS.map((option) => (
              <button key={option.key} type="button" role="radio" aria-checked={option.key === groupBy} onClick={() => onGroupBy(option.key)}>
                {option.label}
              </button>
            ))}
          </div>
        )}
        {shown.length === 0 && <p className="health__none">No {tab.label.toLowerCase()} results yet.</p>}
        {unread}
      </div>
      {tab.fitness === "first" && <Fitness answer={answer} exercisePath={exercisePath} />}
      {groups.map((group) => {
        const folds = groupBy === "category";
        const folded = folds && collapsed.has(group.key);
        const hint = folded ? foldedHint(group.tests) : null;
        const heading = (
          <>
            {group.status === null && <i className="cat__dot" />}
            {group.title} <span>{group.tests.length}</span>
            {hint && <em className={`health__hint health__hint--${hint.status}`}>{hint.text}</em>}
          </>
        );
        return (
          <section
            key={group.key}
            className={`health__group${group.status ? ` health__group--${group.status}` : ""}${group.category ? ` cat cat--${group.category}` : ""}`}
          >
            <h2>
              {folds ? (
                <button type="button" className="health__fold" aria-expanded={!folded} onClick={() => toggle(group.key)}>
                  <i className="health__chevron" aria-hidden="true" />
                  {heading}
                </button>
              ) : (
                heading
              )}
            </h2>
            {!folded && group.tests.map((test) => (
              <TestCard
                key={test.key}
                test={test}
                category={groupBy === "category" ? null : (categories.get(test.system) ?? "")}
                span={answer.span}
                sources={sources}
                onInfo={setInfo}
              />
            ))}
          </section>
        );
      })}
      {tab.fitness === "last" && <Fitness answer={answer} exercisePath={exercisePath} />}
      {!tab.sources && (
        <p className="health__pointer">
          How results are judged and the sources: <a href={tabPath(SOURCES_TAB)} onClick={openTab(SOURCES_TAB, tabPath)}>Sources</a>. Immunisations, medicines and
          Medicare's claims: <a href={tabPath(RECORDS_TAB)} onClick={openTab(RECORDS_TAB, tabPath)}>Records</a>.
        </p>
      )}
      {tab.sources && (
        <footer className="health__sources">
          <h2>The authority on range</h2>
          <p>
            One table holds the range of every test (version {answer.rangesVersion}, modules/health/server/ranges.ts). Each result is judged by the band for the age on the day it
            was taken; the range a lab printed is kept beside it as evidence and never colours or orders anything. Past the line, a result is graded mildly out, out or far
            out by the line's own source where it grades, else by a second named source; where neither grades, past the line is out, nothing finer. Where the line's source
            sets no limit on one side and another trusted source does, that side's line is the other source's, named beside it with its own stars. The page shows three
            colours: green in range, yellow mildly out, red out (out and far out together, far out listed first), and only what an authority sets. Each chart draws only the
            bands its results reach: it ends at a limit no result goes past, labelled there, else at the end of the band the farthest result falls in. "At the edge",
            still green, is within 5% of the interval's width (or of its one limit) inside a limit.
          </p>
          <p>
            Each source's stars say how far to lean on it:{" "}
            {([3, 2, 1, 0] as const).filter((n) => n > 0 || answer.sources.some((s) => s.stars === 0)).map((n) => (
              <span key={n} className="health__rubric">
                <span className="stars">{starsText(n)}</span> {answer.stars[n]}{" "}
              </span>
            ))}
          </p>
          <ul>
            {answer.sources.map((source) => (
              <li key={source.key}>
                <b>{source.name}</b> <span className="stars" title={source.starsWhy}>{starsText(source.stars)}</span>. {source.citation}
              </li>
            ))}
          </ul>
          {answer.importedAt && <p>The health exports (Everlab's and My Health Record's) were last read on {dayText(answer.importedAt.slice(0, 10))}.</p>}
        </footer>
      )}
      {info && <RangeInfo test={info} answer={answer} onClose={() => setInfo(null)} />}
    </div>
  );
}

function TestCard({
  test,
  category,
  span,
  sources,
  onInfo,
}: {
  test: HealthTest;
  /** The key of its category's colour ("" for a category with none), or null to leave its chip out. */
  category: string | null;
  span: HealthAnswer["span"];
  sources: Map<string, HealthSource>;
  onInfo: (test: HealthTest) => void;
}) {
  const latest = test.points.at(-1)!;
  const dp = decimalsOf(test);
  const nameOf = (key: string) => sources.get(key)?.name ?? key;
  // A side's line another source sets is named with it: "ANZ vitamin D position statement; upper limit IOM 2011 vitamin D report".
  const sourceName = test.authority
    ? [nameOf(test.authority.source), ...otherLines(test).map((line) => `${line.side === "above" ? "upper" : "lower"} limit ${nameOf(line.source)}`)].join("; ")
    : null;
  const bandTexts = [...new Set(test.points.filter((p) => p.limits).map((p) => limitsText(p.limits!, dp, test.unit)))];
  const grader = latest.by && test.authority && latest.by !== test.authority.source ? sources.get(latest.by) : undefined;
  const chart = test.kind === "number";
  const words = test.kind === "words";
  const status = screenWord(test, test.status) ?? STATUS_WORDS[test.status];
  // One row: the description in half the grid, the graph (a chart, or a screen's results over time) in the other; a
  // result with no graph is its description alone.
  return (
    <article className={`test${chart || words ? "" : " test--text"}`}>
      <div className="test__text">
        <header className="test__head">
          <div className="test__name">
            {test.name}
            {test.unit && <span className="test__unit">{test.unit}</span>}
          </div>
          <button type="button" className="test__grade" aria-label={`${status}: how this is judged`} onClick={() => onInfo(test)}>
            <span className={`pill pill--${shownStatus(test.status)}`}>{status}</span>
          </button>
        </header>
        <div className="test__latest">
          <b>{valueText(latest, dp)}</b>
          {latest.value !== null && test.unit && <span> {test.unit}</span>} · {dayText(latest.date)}, age {latest.age}
          {latest.note && <span className="test__note"> · {latest.note}</span>}
          {category !== null && (
            <span className={`test__system cat${category ? ` cat--${category}` : ""}`}>
              <i className="cat__dot" />
              {test.system}
            </span>
          )}
        </div>
        <p className="test__range">
          {test.screen ? (
            <>{test.screen.line}.</>
          ) : test.authority ? (
            <>
              Judged by {bandTexts.length > 0 ? bandTexts.join(", then ") : "its result in words"} ({sourceName}).
              {grader && (grader.stars === 0 ? " Graded past it by the dashboard's own rule: no authority grades it." : ` Graded past it by ${grader.name}.`)}
              {test.authority.note ? ` ${test.authority.note}` : ""}
            </>
          ) : (
            <>Not judged: {test.noAuthority}</>
          )}
          {test.treatment && <> Under treatment: {test.treatment}.</>}
        </p>
        <Collapse label={placesText(test)}>
          <ul className="test__evidence">
            {test.points.map((p) => (
              <li key={p.date + p.sources[0]}>
                {dayText(p.date)}, {p.lab}: {p.printed} {p.value !== null ? `${p.qualifier ?? ""}${p.value}` : p.text}
                {p.unit ? ` ${p.unit}` : ""}
                {p.labRange ? `, lab's range ${p.labRange}` : ""}
                {p.alsoAs.length > 0 ? `; also printed as ${p.alsoAs.join(", ")}` : ""}
                <span className="test__source"> ({p.sources.join("; ")})</span>
              </li>
            ))}
          </ul>
        </Collapse>
      </div>
      {(chart || words) && (
        <div className="test__graph">
          {chart && <TrendChart test={test} span={span} />}
          {words && <ScreenChart test={test} span={span} />}
        </div>
      )}
    </article>
  );
}

/**
 * A toggle and what it opens, sliding open and shut (its height and opacity; at once under reduced motion). Shut, what
 * it holds stays laid out but hidden from the keyboard and screen readers.
 */
function Collapse({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={`collapse${open ? " collapse--open" : ""}`}>
      <button type="button" className="collapse__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3 2l4 3-4 3" />
        </svg>
        {label}
      </button>
      <div id={id} className="collapse__panel" inert={!open}>
        <div className="collapse__inner">{children}</div>
      </div>
    </div>
  );
}

const PROVENANCE: Record<Provenance, { title: string; explain: (physical: PhysicalAnswer) => ReactNode }> = {
  measured: { title: "Measured at the visit", explain: (p) => `Taken at the assessment on ${dayText(p.date)}.` },
  "everlab-test": {
    title: "Everlab's test output",
    explain: (p) => `Dated ${monthText(p.date)} in the report.${p.unexplained ? ` ${p.unexplained}` : ""}`,
  },
  wearable: {
    title: "From a wearable, as of printing",
    explain: (p) => `Synced from a wearable and shown as of the day the report was printed (${dayText(p.printed)}), not the visit.`,
  },
  "everlab-score": { title: "Everlab's own scores", explain: () => "Everlab's scoring, by its own optimised ranges, not this page's authority." },
};

function Fitness({ answer, exercisePath }: { answer: HealthAnswer; exercisePath: string }) {
  const { peak, physical } = answer;
  const peakPath = peak ? `${exercisePath}?${new URLSearchParams({ activity: peak.activity })}` : exercisePath;
  const zone5 = physical?.zones.find((z) => z.zone === 5);
  const ageNow = ageOn(answer.born, answer.today);
  return (
    <section className="health__group fitness" id="fitness">
      <h2>Heart rate and the physical assessment</h2>
      <div className="fitness__card">
        <h3>Highest heart rate recorded</h3>
        {peak ? (
          <>
            <div className="fitness__big">
              {peak.bpm} <small>bpm</small>
            </div>
            <p className="fitness__source">
              <span className="tag tag--measured">Measured</span> {heartRateDevice(peak)}, on{" "}
              <a href={peakPath} onClick={openPath(peakPath)}>
                {dayText(peak.date)}
              </a>
              , age {peak.age}. From {peak.source}.
            </p>
            <p>A recorded peak is a floor for the true maximum heart rate, not the maximum itself: the true maximum is at least this high.</p>
            {zone5 && (
              <p>
                Everlab's zone 5 heart rate, {zone5.bpm} bpm, sits {peak.bpm - zone5.bpm} bpm below the highest recorded.
              </p>
            )}
          </>
        ) : (
          <p>No trusted recording holds a peak yet. A chest strap's recording counts; a watch's heart rate during a run does not.</p>
        )}
        <p className="fitness__estimate">
          Not in any report: an age formula's estimate only, 208 − 0.7 × age (Tanaka) ={" "}
          {Math.round(208 - 0.7 * ageNow)} bpm at {ageNow}. The physical assessment gives no maximum heart rate.
        </p>
        {answer.exercise && (
          <p className="fitness__exercise">
            Every workout, with its route, heart rate and splits, is on <a href={exercisePath} onClick={openPath(exercisePath)}>Fitness</a>.
          </p>
        )}
      </div>
      {physical && (
        <div className="fitness__card">
          <h3>
            Physical assessment, {dayText(physical.date)} <span>(printed {dayText(physical.printed)})</span>
          </h3>
          {physical.groups.map((group) => (
            <div key={group.from} className="provenance">
              <h4>
                <span className={`tag tag--${group.from}`}>{PROVENANCE[group.from].title}</span>
              </h4>
              <p className="provenance__explain">{PROVENANCE[group.from].explain(physical)}</p>
              <ul className="provenance__numbers">
                {group.numbers.map((n) => (
                  <li key={n.label}>
                    <span>{n.label}</span>
                    <b>
                      {n.value ?? n.text}
                      {n.unit ? ` ${n.unit}` : ""}
                    </b>
                    {n.everlab && <span className="provenance__everlab">Everlab: {n.everlab}</span>}
                    {n.status && <span className={`pill pill--${shownStatus(n.status)}`}>{STATUS_WORDS[n.status as Status]}</span>}
                    {n.page !== null && <span className="provenance__page">p{n.page}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="provenance">
            <h4>
              <span className="tag tag--missing">Not in the report</span>
            </h4>
            <p className="provenance__explain">
              Maximum heart rate: the report gives none, so no figure on this page is the report's. Not in the printout either:{" "}
              {physical.missing.join(", ")}.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

/** Whose heart rate a recording is: its sensor as the captain names it, and what recorded it. */
function heartRateDevice({ sensor, recorder }: { sensor: string | null; recorder: string | null }): string {
  return `${sensor ? `${sensor} chest strap` : "Chest strap"}${recorder ? `, recorded in ${recorder}` : ""}`;
}
