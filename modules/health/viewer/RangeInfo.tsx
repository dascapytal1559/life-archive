// How a test's range was built, opened from a result's grade on the Health page. First the range the latest result
// was judged by as the page's three bands (in range, then mildly out and out each side), each with its bounds, the
// grades in it, its source and that source's stars and why, the result's own band marked. Then how the line was built from its authority (what the source publishes, what was
// taken and how, the band among all the table holds for the test, what it does not cover), a side's line another source
// sets, with that source's own account and stars, how each side past the line
// is graded (or that nothing grades it), and every source with its link. Every word of it comes from the answer (../server/rangeAccounts.ts and
// ranges.ts); this only lays it out.
// A modal <dialog>: the rest of the page is inert while it is open (so focus stays in it), Escape or the close button
// or a click outside closes it, and focus goes back to the grade that opened it.

import { useEffect, useRef } from "react";
import { rungFor, type AuthorityBand, type HealthAnswer, type HealthSource, type HealthTest, type RangeKind } from "../wire.ts";
import { dayText, decimalsOf, GRADE_WORDS, limitsText, shownRungs, starsText, valueText, type ShownRung } from "./format.ts";

export const KIND_WORDS: Record<RangeKind, { title: string; meaning: string }> = {
  "reference-interval": { title: "Population reference interval", meaning: "where healthy adults' results fall; not a level of risk" },
  "decision-limit": { title: "Decision limit", meaning: "a cut-off a guideline (or the test's maker) sets by risk or diagnosis; healthy people can sit outside it" },
  "lab-interval": { title: "A lab's printed interval, chosen once", meaning: "no guideline or harmonised interval covers this test" },
  words: { title: "Read by its words", meaning: "a screen's result in words, not a number" },
  grading: { title: "Grades past a line", meaning: "how far past a limit a result is, by a source that grades it" },
  "own-rule": { title: "The dashboard's own rule", meaning: "no authority grades this; a rule of thumb, to judge for yourself" },
};

/** The band of `bands` for a person of `sex` aged `age`, or null when none covers them (as ranges.ts's bandFor). */
export function bandOf(bands: readonly AuthorityBand[], sex: "male" | "female", age: number): AuthorityBand | null {
  return bands.find((b) => (b.sex === null || b.sex === sex) && (b.ages === null || (age >= b.ages[0] && (b.ages[1] === null || age < b.ages[1])))) ?? null;
}

/** Who a band is for: "Men, 50 to 69", "Everyone, 18 and over". */
export function bandWho(band: AuthorityBand): string {
  const who = band.sex === "male" ? "Men" : band.sex === "female" ? "Women" : "Everyone";
  if (band.ages === null) return who;
  const [from, to] = band.ages;
  return `${who}, ${to === null ? `${from} and over` : `${from} to ${to - 1}`}`;
}

export function RangeInfo({ test, answer, onClose }: { test: HealthTest; answer: HealthAnswer; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => opener?.focus();
  }, []);

  const source = test.authority ? answer.sources.find((s) => s.key === test.authority!.source) : undefined;
  return (
    <dialog
      ref={dialog}
      className="range-info"
      aria-labelledby="range-info-title"
      onClose={onClose}
      // A click on the dialog itself, not its content, is a click on the backdrop around it.
      onClick={(event) => event.target === dialog.current && dialog.current.close()}
    >
      <div className="range-info__body">
        <header className="range-info__head">
          <div>
            <div className="range-info__eyebrow">How this range and its grades were built</div>
            <h2 id="range-info-title">{test.name}</h2>
          </div>
          <button type="button" className="range-info__close" aria-label="Close" onClick={() => dialog.current?.close()}>
            ×
          </button>
        </header>
        {test.authority && source ? <Account test={test} source={source} answer={answer} /> : <NotJudged test={test} />}
      </div>
    </dialog>
  );
}

/** The range's bands, each with its source and stars, the latest result's marked; then each source's stars, why. */
function Rungs({ test, answer, sources }: { test: HealthTest; answer: HealthAnswer; sources: Map<string, HealthSource> }) {
  const latest = test.points.at(-1)!;
  const dp = decimalsOf(test);
  const bands = shownRungs(test.rungs);
  // Out above at the top, down through in range, to out below.
  const ordered = [...bands.filter((r) => r.side === "above").reverse(), ...bands.filter((r) => r.side === "in"), ...bands.filter((r) => r.side === "below")].filter(
    (band) => !restatesLine(band, bands, test.authority?.source),
  );
  const ownRung = latest.value !== null ? rungFor(latest.value, test.rungs) : null;
  const own = ordered.find((band) => ownRung !== null && band.parts.includes(ownRung));
  const lines = otherLines(test);
  const used = [...new Set([...test.rungs.map((r) => r.source), ...lines.map((l) => l.source)])].map((key) => sources.get(key)).filter((s): s is HealthSource => s !== undefined);
  const sourceCell = (key: string) => {
    const source = sources.get(key);
    return (
      <>
        {source?.name ?? key}{" "}
        <span className="stars" title={source?.starsWhy}>
          {source && source.stars > 0 ? starsText(source.stars) : "no stars"}
        </span>
      </>
    );
  };
  return (
    <section>
      <h3>Every band, and how far to lean on it</h3>
      <table className="range-info__bands range-info__rungs">
        <thead>
          <tr>
            <th>Grade</th>
            <th>Range</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((rung, i) => {
            const source = sources.get(rung.source);
            return (
              <tr key={i} className={rung === own ? "range-info__applied" : undefined}>
                <td>
                  <i className={`dot-key dot-key--${rung.grade}`} /> {GRADE_WORDS[rung.grade]}
                  {rung === own && <span className="range-info__here"> · latest result</span>}
                </td>
                <td>
                  {limitsText(rung, dp, test.unit)}
                  {rung.parts.length > 1
                    ? rung.parts.map((part, j) => (
                        <div key={j} className="range-info__label">
                          {limitsText(part, dp, test.unit)}
                          {part.label && `: ${part.label}`}
                        </div>
                      ))
                    : rung.label && <div className="range-info__label">{rung.label}</div>}
                </td>
                <td>
                  {rung.side === "in" && lines.length > 0
                    ? test.authority!.lines.map((line) => (
                        <div key={line.side}>
                          {line.side === "above" ? "Upper limit" : "Lower limit"}: {sourceCell(line.source)}
                        </div>
                      ))
                    : sourceCell(rung.source)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ul className="range-info__stars">
        {used.map((source) => (
          <li key={source.key}>
            <span className="stars">{source.stars > 0 ? starsText(source.stars) : "No stars"}</span> <b>{source.name}:</b> {source.starsWhy}
          </li>
        ))}
      </ul>
      <div className="range-info__fine range-info__key">
        <h4>Stars</h4>
        <ul>
          {([3, 2, 1, 0] as const).filter((n) => n > 0 || used.some((s) => s.stars === 0)).map((n) => (
            <li key={n}>
              <span className="stars">{n > 0 ? starsText(n) : "none"}</span> {answer.stars[n].replace(/\.$/, "")}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Account({ test, source, answer }: { test: HealthTest; source: HealthSource; answer: HealthAnswer }) {
  const authority = test.authority!;
  const kind = KIND_WORDS[source.kind];
  const latest = test.points.at(-1)!;
  const dp = decimalsOf(test);
  const applied = bandOf(authority.bands, answer.sex, latest.age);
  const person = answer.sex === "male" ? "man" : "woman";
  const bandsUsed = new Set(test.points.map((p) => bandOf(authority.bands, answer.sex, p.age)));
  const sources = new Map(answer.sources.map((s) => [s.key, s]));
  const graders = authority.gradings.filter((g): g is typeof g & { source: string } => g.source !== null && g.source !== authority.source);
  const lines = otherLines(test);
  const allSources = [source, ...[...new Set([...lines.map((l) => l.source), ...graders.map((g) => g.source)])].map((key) => sources.get(key)).filter((s): s is HealthSource => s !== undefined)];
  // Each grading source once, with the sides it grades; the sides nothing grades, together.
  const ungraded = authority.gradings.filter((g) => g.source === null);
  const gradings = [...new Set(authority.gradings.flatMap((g) => (g.source === null ? [] : [g.source])))].map((key) => ({
    source: key,
    sides: authority.gradings.filter((g) => g.source === key),
  }));
  const sideWords = (sides: readonly { side: "above" | "below" }[]) =>
    sides.length > 1 ? "Above and below the line" : sides[0].side === "above" ? "Above the line" : "Below the line";
  return (
    <>
      <p className="range-info__kind">
        <span className={`range-kind range-kind--${source.kind}`}>{kind.title}</span> {source.name}: {kind.meaning}.
      </p>
      {test.rungs.length > 0 && <Rungs test={test} answer={answer} sources={sources} />}
      <section>
        <h3>The line: what the source publishes</h3>
        <p>{source.publishes}</p>
      </section>
      <section>
        <h3>What was taken, and how</h3>
        <p>{source.taken}</p>
        {authority.specifics && <p>{authority.specifics}</p>}
        {authority.note && <p>{authority.note}</p>}
      </section>
      {lines.map((line) => {
        const by = sources.get(line.source);
        if (!by) return null;
        return (
          <section key={line.side}>
            <h3>
              The {line.side === "above" ? "upper" : "lower"} limit, from another source: {by.name} <span className="stars">{starsText(by.stars)}</span>
            </h3>
            <p>{by.publishes}</p>
            <p>{by.taken}</p>
            <p>{by.uncovered}</p>
            <p className="range-info__fine">Stars: {by.starsWhy}</p>
          </section>
        );
      })}
      {authority.bands.length > 0 && (
        <section>
          <h3>The band this result was judged by</h3>
          <p>
            The latest result, <b>{valueText(latest, dp)}{latest.value !== null && test.unit ? ` ${test.unit}` : ""}</b> on {dayText(latest.date)}, is judged by the band
            for a {person} aged {latest.age} on the day it was collected
            {applied ? (
              <>
                : <b>{limitsText(applied, dp, test.unit)}</b>.
              </>
            ) : (
              <>. No band covers that age, so it is not judged.</>
            )}
            {bandsUsed.size > 1 && " Earlier results were each judged by the band for their own day, and the chart's rungs step where a band ends."}
          </p>
          <table className="range-info__bands">
            <thead>
              <tr>
                <th>For</th>
                <th>Range</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {authority.bands.map((band, i) => (
                <tr key={i} className={band === applied ? "range-info__applied" : undefined}>
                  <td>{bandWho(band)}</td>
                  <td>{limitsText(band, dp, test.unit)}</td>
                  <td>{band === applied ? "applied" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <section>
        <h3>What it does not cover</h3>
        <p>{source.uncovered}</p>
      </section>
      {authority.gradings.length > 0 && (
        <section>
          <h3>The grades past the line</h3>
          {gradings.map((grading) => {
            const by = sources.get(grading.source);
            if (!by) return null;
            return (
              <div key={grading.source} className="range-info__grading">
                <p>
                  <b>
                    {sideWords(grading.sides)}: {by.name}
                  </b>{" "}
                  <span className="stars">{by.stars > 0 ? starsText(by.stars) : "no stars"}</span>.{" "}
                  {by.key === source.key ? "The line's own source grades past it, as it publishes (above)." : by.taken}
                </p>
                {grading.sides.map((side) => side.note && <p key={side.side}>{side.note}</p>)}
              </div>
            );
          })}
          {ungraded.length > 0 && (
            <div className="range-info__grading">
              <p>
                <b>{sideWords(ungraded)}: no grades.</b> No authority grades past the line {ungraded.length > 1 ? "on either side" : "here"}, so a result past it is out,
                nothing finer.
              </p>
            </div>
          )}
        </section>
      )}
      <section className="range-info__source">
        <h3>{allSources.length > 1 ? "The sources" : "The source"}</h3>
        {allSources.map((s) => (
          <div key={s.key} className="range-info__cite">
            <p>
              {allSources.length > 1 && <b>{s.name}. </b>}
              {s.citation}
            </p>
            {s.url ? (
              <a className="range-info__link" href={s.url} target="_blank" rel="noreferrer">
                Open {allSources.length > 1 ? s.name : "the official source"} ↗
              </a>
            ) : (
              <p className="range-info__fine">{s.stars === 0 ? "No authority: nothing to link to." : "No link is kept for this source; its citation above names where it is published."}</p>
            )}
            {s.links.map((link) => (
              <a key={link.url} className="range-info__link" href={link.url} target="_blank" rel="noreferrer">
                {link.label} ↗
              </a>
            ))}
            <p className="range-info__fine">This account's wording: {s.wordingFrom}</p>
          </div>
        ))}
        <p className="range-info__fine">Ranges version {answer.rangesVersion}.</p>
      </section>
    </>
  );
}

/** Whether `band` only restates the far side of the in-range row: the one band past a line, from the line's own source,
 * with no bound or grade of its own (transferrin's "out: over 3.2"). The in-range row says it all, so the table leaves it out. */
export function restatesLine(band: ShownRung, bands: readonly ShownRung[], authority: string | undefined): boolean {
  if (band.side === "in" || band.source !== authority || band.parts.length > 1) return false;
  if (bands.filter((b) => b.side === band.side).length > 1) return false;
  return band.side === "above" ? band.high === null : band.low === null;
}

/** The sides of a test's range whose line another source sets than the test's own (vitamin D's upper limit). */
export function otherLines(test: HealthTest): { side: "above" | "below"; source: string }[] {
  return test.authority?.lines.filter((line) => line.source !== test.authority!.source) ?? [];
}

function NotJudged({ test }: { test: HealthTest }) {
  return (
    <>
      <p className="range-info__kind">
        <span className="range-kind range-kind--none">Not judged</span> No authority gives this test a range, so it is never coloured or ordered by one.
      </p>
      <section>
        <h3>Why</h3>
        <p>{test.noAuthority}</p>
      </section>
    </>
  );
}
