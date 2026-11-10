// Fitness in the console, the module's page (../viewer.tsx declares it; Exercise until the captain renamed it): every
// workout the archive has, laid out as the training logs people know do it (a feed of activities newest first, a weekly
// summary beside it, and a page for each activity), in the console's own look.
// Its view, Activities, is the aspect's address; an activity's page is the same view with ?activity=<id> in the
// address, so a reload, a link or the back button opens it again. Its second tab, Habits, is the rituals module's
// (modules/rituals/viewer/HabitViews.tsx).
//
//   The feed: a card an activity, its sport, when, its name, distance, moving time, pace (speed on a bike) and
//     average heart rate, its time in zones as one line of colours, and its route's thumbnail where it has one; each
//     opens its page.
//   The zone 2 target (Zone2.tsx), first: this week's minutes in zone 2 against the archive's weekly target
//     (data/exercise.json), and the recent weeks' against it.
//   The summaries, one column beside the feed (its right third): this week's distance, moving time and activities and
//     all activities as KPIs two by two, and under them every sport by its own measure (cycling and walking by time,
//     running by distance, each gym type by its load). On a narrow screen the column comes first, above the feed.
//   A workout logged in Rituals is a copy of the activity it is, or a card of its own, known by its day alone, its log
//     (gym sets a line an exercise) on its card and page.
//   An activity's page: its numbers, its route large, its splits a kilometre at a time, its heart rate over time and
//     its time in each heart-rate zone (by exercise.json's zones, else Polar's, and it says whose), where it came from, and its Delete (DeleteActivity.tsx): every
//     copy of it gone for good, after one confirmation, and the page back at the feed.
//
// Heart rate is shown only where the captain trusts it (a chest strap's, by his rule for each source); an activity
// without says why. A route is drawn on the map of its area kept on this Mac (../server/maps/), read from this server
// alone, never from a tile server, which would be told where he went (server/privacy/policy.ts); outside every
// map downloaded, over none, saying so. Everything comes from GET /life-archive/api/m/exercise/activities (../wire.ts).

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Card, Facts, Icon, Kpi, Kpis, LOCALE, type IconName, type View } from "../../../sdk/viewer.ts";
import {
  ACTIVITIES_API, FITNESS_ASPECT, fitnessPath, RITUALS_SOURCE, type ActivityDeleted, type ActivityDetail, type ActivitySummary, type ExerciseAnswer, type Family, type RitualsLog,
  type Zone2, type ZoneSettings,
} from "../wire.ts";
import { DeleteActivity } from "./DeleteActivity.tsx";
import { HeartRateChart, SplitsTable, ZoneBars, ZoneLine } from "./Drawings.tsx";
import { NO_MAP, regionName, RouteMapLarge, RouteThumb } from "./RouteMap.tsx";
import { GymPanel } from "./Gym.tsx";
import { Playback } from "./playback/Playback.tsx";
import { Zone2Panel } from "./Zone2.tsx";
import { distanceText, durationText, logLines, minutesText, speedLabel, speedText, sportTotals, sportTotalsNote, sportTotalsText, startText, weekLabel, weeksTo, zonesByText } from "./format.ts";
import "./exercise.css";

/** How many weeks the weekly charts (zone 2, gym) show. */
export const WEEKS_SHOWN = 12;

export function exerciseViews(): View[] {
  return [
    {
      key: "exercise-activities",
      label: "Activities",
      aspects: [FITNESS_ASPECT],
      section: "activities",
      blurb: "Every workout, newest first, with the week's zone 2 against its target and the week's totals; each opens its route, heart rate, splits and Rituals log.",
      component: () => <Exercise />,
    },
  ];
}

/** Each family's icon. */
const SPORT_ICONS: Record<Family, IconName> = { run: "workout", walk: "walk", ride: "ride", swim: "swim", other: "exercise" };

const activityOf = (search: string) => new URLSearchParams(search).get("activity");
const playOf = (search: string) => new URLSearchParams(search).get("play") === "1";

function Exercise() {
  const [answer, setAnswer] = useState<ExerciseAnswer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(() => activityOf(location.search));
  /** The last activity deleted, said above the feed. */
  const [gone, setGone] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const back = () => setOpen(activityOf(location.search));
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    fetch(ACTIVITIES_API, { signal: abort.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as ExerciseAnswer & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        setAnswer(body);
      })
      .catch((error: Error) => abort.signal.aborted || setFailed(error.message));
    return () => abort.abort();
  }, []);

  useEffect(() => {
    const shown = open && answer?.activities.find((a) => a.id === open);
    document.title = `${shown ? `${shown.title} · ` : ""}Fitness · Life archive`;
  }, [open, answer]);

  /** Opens an activity's page (or the feed) in place, the surface back at its top; a modified click as the browser would. */
  const go = (activity: string | null) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    history.pushState(null, "", fitnessPath(activity ?? undefined));
    setOpen(activity);
    setGone(null);
    top.current?.closest(".console__scroll")?.scrollTo(0, 0);
  };

  /** An activity deleted: gone from the feed, and the feed shown in its page's place (its address no longer opens). */
  const deleted = (title: string) => (done: ActivityDeleted) => {
    setAnswer((known) => known && { ...known, activities: known.activities.filter((a) => a.id !== done.id) });
    history.replaceState(null, "", fitnessPath());
    setOpen(null);
    setGone(`Deleted ${title}: ${done.copies === 1 ? "its copy" : `its ${done.copies} copies`} and ${done.files === 1 ? "1 file" : `${done.files} files`}, for good.`);
    top.current?.closest(".console__scroll")?.scrollTo(0, 0);
  };

  if (failed) return <p className="ex__message">The activities are unavailable: {failed}</p>;
  if (!answer) return <p className="ex__message">Loading…</p>;
  return (
    <div className="ex" ref={top}>
      {open ? (
        <ActivityPage id={open} summary={answer.activities.find((a) => a.id === open) ?? null} today={answer.today} zones={answer.zones} back={go(null)} onDeleted={deleted} />
      ) : (
        <>
          {gone && (
            <p className="ex-delete__done" role="status">
              {gone}
            </p>
          )}
          <Feed answer={answer} open={go} />
        </>
      )}
    </div>
  );
}

function Feed({ answer, open }: { answer: ExerciseAnswer; open: (id: string) => (event: MouseEvent) => void }) {
  const { activities, today } = answer;
  const weeks = useMemo(() => weeksTo(activities, today, WEEKS_SHOWN), [activities, today]);
  const [lastWeek, week] = weeks.slice(-2);
  const total = activities.reduce((n, a) => n + (a.distanceM ?? 0), 0);
  return (
    <>
      <div className="ex-weekly">
        <Zone2Panel weeks={weeks} target={answer.zone2Target} zones={answer.zones} />
        <GymPanel weeks={weeks} />
      </div>
      <div className="ex__layout">
        {/* The summaries first, as a phone shows them; on a wide screen the stylesheet puts them at the right. */}
        <aside className="ex__side" aria-label="Summaries">
          <Kpis label="This week">
            <Kpi label="This week" value={distanceText(week.distanceM).replace(" km", "")} unit="km" tone="accent" note={`from Monday ${weekLabel(week.from)} · last week ${distanceText(lastWeek.distanceM)}`} />
            <Kpi label="Moving time" value={durationText(week.movingS)} note="this week" />
            <Kpi label="Activities" value={week.count} note="this week" />
            <Kpi label="All activities" value={activities.length.toLocaleString(LOCALE)} note={`${distanceText(total)} in all`} />
          </Kpis>
          <Card title="By sport" aside={`${activities.length} in all`}>
            <Facts facts={bySport(activities)} />
          </Card>
        </aside>
        <section className="ex__feed" aria-label="Activities, newest first">
          {activities.length === 0 && <p className="ex__message">No workouts in the archive yet.</p>}
          {activities.map((activity) => (
            <ActivityCard key={activity.id} activity={activity} today={today} open={open(activity.id)} />
          ))}
        </section>
      </div>
    </>
  );
}

/** Each sport's sessions and its own measure, most sessions first (sportTotals); hovering one says what it measures. */
function bySport(activities: readonly ActivitySummary[]): Array<{ key: string; value: ReactNode }> {
  return sportTotals(activities).map((row) => ({
    key: row.sport,
    value: (
      <span className={row.leftOut > 0 ? "ex-by-sport ex-by-sport--partial" : "ex-by-sport"} title={sportTotalsNote(row)}>
        {sportTotalsText(row)}
      </span>
    ),
  }));
}

/** Whether an activity is a workout logged in Rituals alone: no copy recorded it. */
const loggedOnly = (activity: ActivitySummary) => activity.source === RITUALS_SOURCE;

/** An activity's minutes in zone 2 in words, and what says so. */
function zone2Text(zone2: Zone2): string {
  return `${minutesText(zone2.minutes)}${zone2.from === "rituals" ? ", as logged in Rituals" : ""}`;
}

/** A Rituals log's words, an exercise a line with its sets; `compact` shows its first lines alone, for a card. */
function LogLines({ log, compact = false }: { log: RitualsLog; compact?: boolean }) {
  const lines = logLines(log.details);
  if (lines.length === 0) return compact ? null : <p className="ex__message">No details logged.</p>;
  const shown = compact ? lines.slice(0, 3) : lines;
  return (
    <ul className={`ex-log${compact ? " ex-log--compact" : ""}`}>
      {shown.map((line, i) => (
        <li key={i}>
          {line.name !== null ? (
            <>
              <span className="ex-log__name">{line.name}</span>
              {line.sets.map((set, j) => (
                <span key={j} className="ex-log__set">
                  {set}
                </span>
              ))}
            </>
          ) : (
            <span className="ex-log__text">{line.text}</span>
          )}
        </li>
      ))}
      {compact && lines.length > shown.length && <li className="ex-log__more">and {lines.length - shown.length} more</li>}
    </ul>
  );
}

/** The stats a card and a page lead with: distance, pace or speed, moving time, and trusted average heart rate. */
function headline(activity: ActivitySummary): Array<{ label: string; value: string }> {
  return [
    { label: "Distance", value: distanceText(activity.distanceM) },
    { label: speedLabel(activity.family), value: speedText(activity.family, activity.movingS, activity.distanceM) },
    { label: "Time", value: durationText(activity.movingS) },
    { label: "Avg HR", value: activity.heartRate ? `${activity.heartRate.average} bpm` : "—" },
  ];
}

function ActivityCard({ activity, today, open }: { activity: ActivitySummary; today: string; open: (event: MouseEvent) => void }) {
  return (
    <article className="ex-card">
      <a className="ex-card__link" href={fitnessPath(activity.id)} onClick={open} aria-label={`${activity.title}, ${startText(activity.start, today)}`} />
      <header className="ex-card__head">
        <span className={`ex-sport ex-sport--${activity.family}`} aria-hidden="true">
          <Icon name={SPORT_ICONS[activity.family]} />
        </span>
        <div>
          <div className="ex-card__when">
            {startText(activity.start, today)}
            {activity.recorder && <> · {activity.recorder}</>}
          </div>
          <h3 className="ex-card__title">{activity.title}</h3>
        </div>
      </header>
      {loggedOnly(activity) ? (
        <>
          {activity.movingS !== null && (
            <dl className="ex-stats">
              <div>
                <dt>Time</dt>
                <dd>{durationText(activity.movingS)}</dd>
              </div>
            </dl>
          )}
          {activity.logged && <LogLines log={activity.logged} compact />}
        </>
      ) : (
        <dl className="ex-stats">
          {headline(activity).map((stat) => (
            <div key={stat.label}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {activity.zones.length > 0 && <ZoneLine zones={activity.zones} />}
      {activity.thumb && (
        <div className="ex-card__route">
          <RouteThumb shape={activity.thumb} place={activity.map} label={`The route${activity.map ? ` on the map of ${regionName(activity.map.region)}` : "'s shape"}, ${distanceText(activity.distanceM)}`} />
        </div>
      )}
      <footer className="ex-card__foot">
        <span className="ex-chip">From {activity.source}</span>
        {activity.alsoIn.length > 0 && <span>also in {activity.alsoIn.join("; ")}</span>}
        {activity.zone2 && activity.zone2.minutes > 0 && <span className="ex-chip ex-chip--z2">Zone 2 · {zone2Text(activity.zone2)}</span>}
        {activity.heartRateNote && <span className="ex-card__note">{activity.heartRateNote}</span>}
      </footer>
    </article>
  );
}

function ActivityPage({ id, summary, today, zones, back, onDeleted }: {
  id: string;
  summary: ActivitySummary | null;
  today: string;
  zones: ZoneSettings;
  back: (event: MouseEvent) => void;
  onDeleted: (title: string) => (done: ActivityDeleted) => void;
}) {
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Its playback, open when the address says &play=1, so Back closes it and a link opens it.
  const [playing, setPlaying] = useState(() => playOf(location.search));
  const pushed = useRef(false);

  useEffect(() => {
    const moved = () => setPlaying(playOf(location.search));
    addEventListener("popstate", moved);
    return () => removeEventListener("popstate", moved);
  }, []);

  const play = () => {
    history.pushState(null, "", `${fitnessPath(id)}&play=1`);
    pushed.current = true;
    setPlaying(true);
  };
  const stopPlaying = () => {
    if (pushed.current) history.back();
    else history.replaceState(null, "", fitnessPath(id));
    pushed.current = false;
    setPlaying(false);
  };

  useEffect(() => {
    const abort = new AbortController();
    setDetail(null);
    setFailed(null);
    fetch(`${ACTIVITIES_API}/${encodeURIComponent(id)}`, { signal: abort.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as ActivityDetail & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        setDetail(body);
      })
      .catch((error: Error) => abort.signal.aborted || setFailed(error.message));
    return () => abort.abort();
  }, [id]);

  const shown = detail ?? summary;
  const backLink = (
    <a className="ex__back" href={fitnessPath()} onClick={back}>
      <Icon name="prev" /> All activities
    </a>
  );
  if (failed) return <>{backLink}<p className="ex__message">This activity is unavailable: {failed}</p></>;
  if (!shown) return <>{backLink}<p className="ex__message">Loading…</p></>;
  const hr = shown.heartRate;
  return (
    <article className="ex-page">
      {backLink}
      <header className="ex-page__head">
        <span className={`ex-sport ex-sport--${shown.family} ex-sport--large`} aria-hidden="true">
          <Icon name={SPORT_ICONS[shown.family]} />
        </span>
        <div>
          <div className="ex-card__when">
            {startText(shown.start, today)} · {shown.sport}
            {shown.recorder && <> · {shown.recorder}</>}
          </div>
          <h2 className="ex-page__title">{shown.title}</h2>
        </div>
      </header>
      <Kpis label="The activity's numbers">
        {loggedOnly(shown) ? (
          <>
            <Kpi label="Time" value={durationText(shown.movingS)} tone="accent" note={shown.movingS === null ? "no duration logged" : "as logged"} />
            <Kpi label="Zone 2" value={shown.zone2 ? Math.round(shown.zone2.minutes) : "—"} unit={shown.zone2 ? "min" : undefined} note={shown.zone2 ? "as logged in Rituals" : "none known"} />
          </>
        ) : (
          <>
            {headline(shown).slice(0, 3).map((stat, i) => (
              <Kpi key={stat.label} label={stat.label === "Time" ? "Moving time" : stat.label} value={stat.value} tone={i === 0 ? "accent" : "text"} />
            ))}
            <Kpi
              label="Elapsed time"
              value={durationText(shown.elapsedS)}
              note={shown.elapsedS !== null && shown.movingS !== null && shown.elapsedS - shown.movingS >= 30 ? `${durationText(shown.elapsedS - shown.movingS)} stopped` : "no stops"}
            />
            <Kpi
              label="Avg heart rate"
              value={hr ? hr.average : "—"}
              unit={hr ? "bpm" : undefined}
              note={hr ? `max ${hr.maximum}${detail?.minHeartRate != null ? ` · lowest ${detail.minHeartRate}` : ""} · ${hr.sensor ?? "chest strap"}` : (shown.heartRateNote ?? undefined)}
            />
          </>
        )}
      </Kpis>
      {!detail ? (
        <p className="ex__message">Loading the route and heart rate…</p>
      ) : (
        <>
          {!loggedOnly(detail) && (
            <>
              <div className="ex-page__grid">
                <Card title="Route" aside={!detail.route ? "none recorded" : detail.map ? `on the map of ${regionName(detail.map.region)}, kept on this Mac` : `its shape, north up · ${NO_MAP.toLowerCase()}`} className="ex-page__route">
                  {detail.route && detail.map && (
                    <button type="button" className="ex-play" onClick={play}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor" /></svg>
                      Play back in 3D
                    </button>
                  )}
                  {detail.route ? (
                    <div className={`ex-page__map${detail.map ? " ex-page__map--live" : ""}`}>
                      <RouteMapLarge
                        shape={detail.route}
                        place={detail.map}
                        label={`The route${detail.map ? ` on the map of ${regionName(detail.map.region)}` : "'s shape"}: ${distanceText(detail.distanceM)}, ${Math.round(detail.route.width)} m east to west and ${Math.round(detail.route.height)} m north to south`}
                      />
                    </div>
                  ) : (
                    <p className="ex__message">This activity has no route: {shown.source === "Polar Flow's share page, by hand" ? "it was transcribed by hand" : "no GPS was recorded"}.</p>
                  )}
                </Card>
                <Card title="Splits" aside={detail.splits.length > 0 ? `${detail.splits.length} · moving time` : "none"}>
                  {detail.splits.length > 0 ? <SplitsTable splits={detail.splits} family={detail.family} /> : <p className="ex__message">No distance over time to split by.</p>}
                </Card>
              </div>
              <div className="ex-page__grid">
                <Card title="Heart rate" aside={hr ? `average ${hr.average} · max ${hr.maximum} bpm` : "not shown"}>
                  {hr && detail.heartRateSeries.length > 1 ? (
                    <HeartRateChart series={detail.heartRateSeries} average={hr.average} />
                  ) : (
                    <p className="ex__message">{hr ? "Only a summary of the heart rate was kept: no samples to chart." : shown.heartRateNote}.</p>
                  )}
                </Card>
                <Card title="Heart-rate zones" aside={detail.zones.length > 0 ? "time in each" : "none"}>
                  {detail.zones.length > 0 ? (
                    <>
                      <ZoneBars zones={detail.zones} />
                      <p className="ex__message">
                        {detail.zonesBy === "archive" ? `Counted from its heart rate, ${zonesByText(detail.zonesBy, zones)}.` : "Polar's own zones: no samples to count from, or no zones set."}
                      </p>
                    </>
                  ) : (
                    <p className="ex__message">{hr ? "The recording keeps no zones." : shown.heartRateNote}.</p>
                  )}
                </Card>
              </div>
            </>
          )}
          {detail.logged && (
            <Card title="Logged in Rituals" aside={detail.logged.title.toLowerCase() === detail.logged.type.toLowerCase() ? detail.logged.title : `${detail.logged.title} · ${detail.logged.type}`}>
              <LogLines log={detail.logged} />
            </Card>
          )}
          <Card title="Where it came from" aside={detail.alsoIn.length > 0 ? `${detail.alsoIn.length + 1} copies` : "one copy"}>
            <Facts
              facts={[
                { key: "Shown from", value: detail.source },
                ...(detail.alsoIn.length > 0 ? [{ key: "Also in", value: detail.alsoIn.join("; ") }] : []),
                ...(loggedOnly(detail) ? [] : [{ key: "Recorded by", value: detail.recorder ?? "not said" }]),
                { key: "Heart rate", value: hr ? `trusted: ${hr.sensor ?? "a chest strap"}` : (detail.heartRateNote ?? "none") },
                {
                  key: "Zone 2",
                  value: !detail.zone2
                    ? detail.logged ? "none counted: the log does not say zone 2 and how long" : "none counted: no zones from a heart rate you trust"
                    : detail.zone2.from === "heart-rate"
                      ? `${zone2Text(detail.zone2)}, from the trusted heart rate (${zonesByText(detail.zonesBy, zones) ?? "its zones"})`
                      : `${zone2Text(detail.zone2)}: no zones from a heart rate you trust, and the log says zone 2`,
                },
                ...(detail.link ? [{ key: "Polar's page", value: <a href={detail.link} target="_blank" rel="noreferrer">open</a> }] : []),
              ]}
            />
          </Card>
          <DeleteActivity activity={detail} onDeleted={onDeleted(detail.title)} />
          {playing && detail.route && detail.map && <Playback id={detail.id} onClose={stopPlaying} />}
        </>
      )}
    </article>
  );
}
