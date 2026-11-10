// The Fitness page's Bryan Johnson tab (/life-archive/dev/fitness/bryan-johnson): his five pillars of exercise (his
// "Everyone Is Wrong About Exercise"), each a bar chart of its weeks, so each pillar's progress reads at a glance. It
// was the Don't Die page, a spider graph of the week beside Fitness, until the captain folded it in ("the spider graph
// doesn't really show progression really well, whereas each pillar as bar chart is gonna show evolution really well");
// the Don't Die page's address opens this tab.
//
//   At the top, the captain's own picture of the five pillars as standing stones under the night sky, a banner framed
//     like the cards below it ("make sure it's like aesthetically framed ... simple yet elegant").
//   Five cards, in the captain's order (pillars.ts): Strength Training, Low Intensity Cardio, High Intensity Cardio,
//     Mobility & Flexibility, Balance. Each says this week's value against its weekly target beside its bars, and no
//     more ("if we just fold the descriptions out from each of the five pillars then the height should just work out"):
//     a bar a Monday-to-Sunday week, this week at the left and older weeks to its right ("start the latest day on the
//     left"), back to the first week anything was counted, under a dashed line at the target. This week, still in
//     progress, is hatched; a week met is stronger than one short; a week with nothing reported has no bar. The charts
//     are the Fitness page's own (WeekChart.tsx, Zone2.tsx's look); a history too long for the width scrolls, opened at
//     this week.
//   Balance counts balance work, of which nothing is logged yet, so its chart is empty; planks never stand in for it
//     ("don't count plank as balance. I just haven't done any balance").
//
// Everything comes from two reads: the activities (GET /life-archive/api/m/exercise/activities, as Activities has
// them) and the pillars' targets and ritual days (GET /life-archive/api/m/exercise/pillars); pillars.ts works out the rest.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { View } from "../../../sdk/viewer.ts";
import { ACTIVITIES_API, FITNESS_ASPECT, PILLARS_API, type ExerciseAnswer, type PillarsAnswer } from "../wire.ts";
import { dayText } from "./format.ts";
import { noValueText, PILLARS, pillarWeeks, readingText, reportedOf, targetOf, targetsOf, unitText, valueOf, weekName, type Pillar, type PillarWeek, type Targets } from "./pillars.ts";
import stones960 from "./pillars-stones-960.webp";
import stones1440 from "./pillars-stones-1440.webp";
import { WeekChart } from "./WeekChart.tsx";
import "./pillars.css";

/** The tab's name, firstmate's reading of "fold Don't Die into Bryan Johnson as a tab inside fitness". */
export const BRYAN_JOHNSON_TAB = "Bryan Johnson";

/** The video the pillars are from. */
export const PILLARS_VIDEO = "https://www.youtube.com/watch?v=JNuORofHhrk";

/** The banner's words for a screen reader: what the picture shows (its own carving misspells one stone, left as made). */
const STONES_ALT =
  "Five carved standing stones under a starry night sky, one for each pillar: Strength, Low Intensity Cardio, High Intensity Cardio, Mobility & Flexibility, and Balance.";

export function pillarsViews(): View[] {
  return [
    {
      key: "exercise-pillars",
      label: BRYAN_JOHNSON_TAB,
      aspects: [FITNESS_ASPECT],
      section: "bryan-johnson",
      // The Don't Die page's address, before it was this tab.
      formerAspects: ["dont-die"],
      blurb: "Bryan Johnson's five pillars of exercise, each a bar chart of its weeks against its weekly target.",
      component: () => <BryanJohnson />,
    },
  ];
}

/** What the tab has read: both answers, or why it has not. */
type Read = { state: "loading" } | { state: "failed"; why: string } | { state: "ok"; activities: ExerciseAnswer; pillars: PillarsAnswer };

async function ask<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, credentials: "same-origin" });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

function BryanJohnson() {
  const [read, setRead] = useState<Read>({ state: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    Promise.all([ask<ExerciseAnswer>(ACTIVITIES_API, abort.signal), ask<PillarsAnswer>(PILLARS_API, abort.signal)])
      .then(([activities, pillars]) => setRead({ state: "ok", activities, pillars }))
      .catch((error: Error) => abort.signal.aborted || setRead({ state: "failed", why: error.message }));
    return () => abort.abort();
  }, []);
  return (
    <div className="ex pl">
      <Stones />
      {read.state === "loading" && <p className="ex__message">Loading…</p>}
      {read.state === "failed" && <p className="ex__message">The pillars are unavailable: {read.why}</p>}
      {read.state === "ok" && <Pillars activities={read.activities} pillars={read.pillars} />}
    </div>
  );
}

/** The five stones, framed as a banner: the whole picture on a phone, a band through the carvings on a wider screen. */
function Stones() {
  return (
    <figure className="pl-stones">
      <img
        src={stones1440}
        srcSet={`${stones960} 960w, ${stones1440} 1440w`}
        sizes="(max-width: 1100px) 100vw, 1100px"
        width={1440}
        height={816}
        alt={STONES_ALT}
        decoding="async"
      />
    </figure>
  );
}

function Pillars({ activities, pillars }: { activities: ExerciseAnswer; pillars: PillarsAnswer }) {
  const weeks = useMemo(() => pillarWeeks(activities.activities, pillars.habits, activities.today), [activities, pillars]);
  const targets = useMemo(() => targetsOf(pillars.targets), [pillars]);
  return (
    <>
      <header className="pl-head">
        <p className="pl-head__credit">
          Bryan Johnson's five pillars of exercise, from his{" "}
          <a href={PILLARS_VIDEO} target="_blank" rel="noopener noreferrer">
            Everyone Is Wrong About Exercise ↗
          </a>
          : a bar a week, this week (still in progress, hatched) at the left, back to {dayText(weeks[0].from)}; the dashed line the weekly target.
        </p>
      </header>
      {PILLARS.map((pillar) => (
        <PillarCard key={pillar.key} pillar={pillar} weeks={weeks} targets={targets} />
      ))}
    </>
  );
}

/** A value as its card says it: minutes and days whole. */
const shown = (n: number) => Math.round(n);

function PillarCard({ pillar, weeks, targets }: { pillar: Pillar; weeks: readonly PillarWeek[]; targets: Targets }) {
  const { key, name, unit } = pillar;
  const week = weeks[weeks.length - 1];
  const value = valueOf(week, key);
  const target = targetOf(targets, key);
  const values = weeks.map((w) => valueOf(w, key));
  const most = Math.max(target ?? 0, ...values.map((v) => v ?? 0), 1);
  const unmeasured = values.every((v) => v === null);
  const describe = (w: PillarWeek) => {
    const { value: v, of } = readingText(w, key, targets);
    const out = reportedOf(w, key);
    const reported = v !== null && out !== null && out < 7 ? ` (${out} reported)` : "";
    return `${weekName(w)} · ${v === null ? of : `${v} ${of}`}${reported}${w.current ? " · in progress" : ""}`;
  };
  return (
    <section className="z2 pl-card" data-pillar={key} aria-label={name}>
      <div className="z2__now">
        <h3 className="pl-card__name">{name}</h3>
        <div>
          <div className="z2__value">
            {value === null ? "–" : shown(value)}
            <small>{value === null ? ` ${noValueText(key)}` : ` ${target !== null ? `of ${target} ` : ""}${unitText(unit, target ?? value)}`}</small>
          </div>
          <div className="pl-card__when">This week, so far</div>
        </div>
      </div>
      <div className="pl-card__scroll" style={{ "--weeks": weeks.length } as CSSProperties}>
        <WeekChart
          weeks={weeks}
          newestFirst
          label={target !== null ? `Each week, against ${target} ${unitText(unit, target)}` : "Each week"}
          chartClass="pl__chart"
          summary={`${name} each week, the last ${weeks.length}, newest first: ${weeks.map(describe).reverse().join("; ")}.`}
          describe={describe}
          overlay={
            unmeasured ? (
              <span className="pl__empty">{key === "bal" ? "No balance logged yet." : "Nothing reported yet."}</span>
            ) : (
              target !== null && <span className="z2__goal" style={{ bottom: `${(target / most) * 100}%` }} aria-hidden="true" />
            )
          }
          column={(w, i) => {
            const v = values[i];
            if (v === null) return null;
            const met = target !== null && v >= target;
            return <i className={`pl__bar${met ? " pl__bar--met" : ""}${w.current ? " pl__bar--now" : ""}`} style={{ height: `${Math.max(v > 0 ? 2 : 0, (v / most) * 100)}%` }} />;
          }}
        />
      </div>
    </section>
  );
}
