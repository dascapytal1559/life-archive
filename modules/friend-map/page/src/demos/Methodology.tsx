// Methodology: how the main view works, read-only, opened from the header.
// At a glance it shows how the closeness score adds up (messages plus time
// together, fading with age, ranked into distance from the sun), each piece a
// button that opens its part below. The parts, all closed when the panel
// opens, each say in one line what they are and, opened, show how they work as
// small tables, formulas, worked numbers and, wherever a rule is a function, a
// curve of it (Curve.tsx) rather than paragraphs (closeness.ts, catchUps.ts),
// with the current settings from data/settings.json, so the curves move when
// they change; then the rest of the map, who is shown, the Query bar and the
// settings, and last the Decision history (decisions.ts): what each rule was
// chosen from, kept as it was decided. Nothing here is editable; the settings
// are changed in the file.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isAspiring } from "../aspiring.ts";
import { catchUpWhen, groupShare, hoursLabel, PRIVATE_FROM, PRIVATE_TO, timeLabel, tripCountedHours, tripHours } from "../catchUps.ts";
import { HANGOUT } from "../eventWords.ts";
import { DEFAULT_SETTINGS, type Settings } from "../settings.ts";
import { directWeight, MONTH_DAYS } from "./closeness.ts";
import { Curve } from "./Curve.tsx";
import { DECISIONS, type Decision } from "./decisions.ts";
import type { DemoModel } from "./model.ts";
import type { OrbitOrder } from "./Orbits.tsx";
import { BACKGROUND, rankFraction, rings, TIER_FLOOR, TIERS } from "./orbitsLayout.ts";
import { ALL, DEFAULT_TOP_NAMES } from "./topNames.ts";
import { windowLabel } from "./trend.ts";
import { locale } from "../time.ts";

/** The parts, in the order the panel lists them. */
export const PARTS = ["messages", "time", "fading", "map", "shown", "asking", "settings", "history"] as const;
export type Part = (typeof PARTS)[number];

/**
 * With `demo` (the static demo): the Query bar's box offers examples in place of a model, and the settings are not a file to edit.
 * `order` is the page's: A to Z on Orbits, friend circles on Circles.
 */
export function Methodology({ model, onClose, demo = false, order = "name", named = DEFAULT_TOP_NAMES }: {
  model: DemoModel;
  onClose: () => void;
  demo?: boolean;
  order?: OrbitOrder;
  /** How many of the closest the view names (its Show top names, topNames.ts). */
  named?: number;
}) {
  const { settings } = model;
  const h = settings.closenessHalfLifeDays;
  const r = settings.messageReciprocity;
  const worth = settings.catchUpHourWorth.toLocaleString(locale());
  const s = settings.groupSharedPart;
  const share = (n: number) => groupShare(settings, n);
  // A whole day away, less the private hours each day keeps by default (14 at midnight to 10 am).
  const tripDay = tripHours("2026-01-01", "00:00", { lastDay: "2026-01-02", endTime: "00:00", privateFrom: PRIVATE_FROM, privateTo: PRIVATE_TO });
  const full = settings.tripFullHours;
  const trip = (hours: number) => tripCountedHours(settings, hours) * settings.catchUpHourWorth;
  // Aspiring friends sit outside the orbits, so the rings do not count them.
  const onOrbits = model.people.filter((p) => !isAspiring(p)).length;
  const bands = rings(onOrbits).map((ring) => ring.label.replace("top ", ""));
  const [open, setOpen] = useState<ReadonlySet<Part>>(() => new Set());
  const [shown, setShown] = useState<Part>();
  const toggle = (part: Part, isOpen: boolean) =>
    setOpen((was) => (was.has(part) === isOpen ? was : isOpen ? new Set([...was, part]) : new Set([...was].filter((p) => p !== part))));
  const show = (part: Part) => {
    toggle(part, true);
    setShown(part);
  };
  const parts = useRef(new Map<Part, HTMLElement>());
  useEffect(() => {
    if (!shown) return;
    parts.current.get(shown)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setShown(undefined);
  }, [shown]);
  const part = (id: Part, title: string, summary: ReactNode, children: ReactNode) => (
    <details
      key={id}
      ref={(el) => void (el ? parts.current.set(id, el) : parts.current.delete(id))}
      className={`method__part method__part--${id}`}
      open={open.has(id)}
      onToggle={(e) => toggle(id, e.currentTarget.open)}
    >
      <summary>
        <span className="method__title">{title}</span>
        <span className="method__summary">{summary}</span>
      </summary>
      <div className="method__body">{children}</div>
    </details>
  );

  return (
    <aside className="method" aria-label="Methodology">
      <header className="method__header">
        <h2>Methodology</h2>
        <button type="button" className="method__close" onClick={onClose} aria-label="Close">×</button>
      </header>

      <figure className="method__glance" aria-label="How the closeness score adds up">
        <div className="method__sources">
          <GlanceTile part="messages" show={show} title="Messages">
            {r === 0 ? <><strong>1</strong> a direct message</> : r === 1 ? <><strong>2√(yours × theirs)</strong> a month, direct</> : <>direct, <strong>by their balance</strong></>}
            <br />
            a share of a group one
          </GlanceTile>
          <span className="method__op" aria-hidden>+</span>
          <GlanceTile part="time" show={show} title="Time together" hour>
            <strong>1 hour = {worth}</strong> messages
            <br />
            in person or by call
          </GlanceTile>
        </div>
        <span className="method__op" aria-hidden>×</span>
        <GlanceTile part="fading" show={show} title="Fading">
          counts <strong>half</strong> after {days(h)}
        </GlanceTile>
        <span className="method__op" aria-hidden>=</span>
        <GlanceTile part="map" show={show} title="Closeness" result>
          ranked: the closest next to the sun
        </GlanceTile>
        <figcaption>
          Each message and each hour together adds to someone&apos;s closeness, less the older it is. Open a part for how.
        </figcaption>
      </figure>

      {part("messages", "Messages", r === 0 ? "1 for each direct message, a share of each group one." : "Direct ones by how evenly you both write, a share of each group one.", <>
        <Rows rows={[
          ["Direct", <strong>{r === 0 ? "1" : r === 1 ? "2√(yours × theirs)" : "by balance"}</strong>, r === 0 ? "each message between you, either way" : "a month's messages between you, by how evenly you both wrote: below"],
          ["Group", <strong>a share</strong>, "by how much each of you writes there, below"],
          ["Your side only", <strong>×2</strong>, "Discord keeps only what you sent, so each of yours counts for a reply too; in a group there, everyone is taken to write as much as you"],
          ["The rest", <strong>0</strong>, "others talking among themselves, Marketplace chats, system messages"],
        ]} />
        <h3 className="method__subhead">Direct: balance</h3>
        {r === 1 ? (
          <div className="method__equation" role="math" aria-label="a month's direct messages count two times the square root of yours times theirs">
            a month = 2√(<em>yours</em> × <em>theirs</em>)
          </div>
        ) : (
          <div className="method__equation method__equation--words" role="math" aria-label={`a month's direct messages count ${1 - r} of yours plus theirs, plus ${r} of two times the square root of yours times theirs`}>
            a month = {count(1 - r)} × (<em>yours</em> + <em>theirs</em>) + {count(r)} × 2√(<em>yours</em> × <em>theirs</em>)
          </div>
        )}
        <p className="method__under">
          {r === 0
            ? <>reciprocity is off: every message counts 1, one-way or not</>
            : <>as many as plainly counted when you write as much as each other, less the more lopsided, {r === 1 ? "nothing" : `${percent(1 - r)} of them`} when only one of you writes</>}
        </p>
        <Curve
          label={`What a month of 100 direct messages counts, by your share of them: 100 at an even half, ${count(100 * reciprocal(r, 0.1))} at 10 or 90, ${count(100 * reciprocal(r, 0))} when one side writes them all`}
          x={{ min: 0, max: 100, title: "your share of a month's 100 messages", ticks: [[0, "all theirs"], [50, "even"], [100, "all yours"]] }}
          y={{ min: 0, max: 100, title: "counts as", ticks: [[0, "0"], [50, "50"], [100, "100"]] }}
          lines={[
            ...(r > 0 ? [{ f: () => 100, reference: true, label: "plain count" }] : []),
            { f: (x: number) => 100 * reciprocal(r, x / 100) },
          ]}
          marks={[
            { x: 0, y: 100 * reciprocal(r, 0), label: `100/0: ${count(100 * reciprocal(r, 0))}`, anchor: "start" },
            { x: 50, y: 100, label: "50/50: 100" },
            { x: 90, y: 100 * reciprocal(r, 0.9), label: `10/90: ${count(Math.round(100 * reciprocal(r, 0.9)))}`, anchor: "end" },
          ]}
        />
        <Rows
          example
          caption={<>100 direct messages in a month, theirs / yours, either way round</>}
          rows={BALANCES.map(([theirs, yours]): Row => {
            const counts = <>= <strong>{count(Math.round(directWeight(yours, theirs, r)))}</strong></>;
            return r === 1 ? [`${theirs} / ${yours}`, `2√(${theirs} × ${yours})`, counts] : [`${theirs} / ${yours}`, counts];
          })}
        />
        <p className="method__note">
          Each month on its own, before fading: a friendship gone one-way lately counts less now, and its even years still count as they were.
        </p>
        <Settings settings={settings} keys={["messageReciprocity"]} />
        <h3 className="method__subhead">Group chats</h3>
        <div className="method__equation method__equation--words" role="math" aria-label="a group gives them their messages times your share plus yours times their share, over the others">
          (theirs × <em>your share</em> + yours × <em>their share</em>) ÷ others
        </div>
        <p className="method__under">
          a share is how much of the group&apos;s messages that person wrote, up to then; others is everyone in it but you
        </p>
        <Rows
          example
          caption={<>You and 4 others, 1,000 messages; you write 200 (20%)</>}
          head={["a friend", "writes", "", "gets"]}
          rows={[
            ["chatty", "200 (20%)", "(200 × 20% + 200 × 20%) ÷ 4", <>= <strong>20</strong></>],
            ["quiet", "50 (5%)", "(50 × 20% + 200 × 5%) ÷ 4", <>= <strong>5</strong></>],
            ["silent", "0", "(0 × 20% + 200 × 0%) ÷ 4", <>= <strong>0</strong></>],
          ]}
        />
        <p className="method__note">A group you never write in adds nothing. Counted from who wrote where and when, never from what was said.</p>
      </>)}

      {part("time", "Time together", <>An hour together counts as {worth} messages, in person or by call.</>, <>
        <div className="method__equation method__equation--hour">1 hour together = <em>{worth} messages</em></div>
        <HourCurve settings={settings} />
        <Rows rows={[
          [HANGOUT.Many, <>hours × {worth} × each one&apos;s share with the people there, the others you did not name too (below); added with Add event in their panel</>],
          ["Calls", <>connected time × {worth} an hour, {settings.callMinimumMinutes > 0 ? <>once a day&apos;s add up to {minutes(settings.callMinimumMinutes)}</> : "any length"}, on every app together; phone and FaceTime calls from your phone&apos;s call history, the other apps&apos; calls in one-to-one chats, which count as no message, and the calls you log with Add event, which count as any other call, except that one with several people gives each their share of it, as a {HANGOUT.one} does: an hour with three adds {minutes(Math.round(60 * share(3)))} to each one&apos;s calls that day. A call whose app does not say how long it was (WeChat when it compressed the call&apos;s record, Signal, Messenger&apos;s phone-app export) counts nothing until you give it a length with Add length in the chat</>],
          ["Logged twice", <>a phone or FaceTime call you log with one person that your phone&apos;s call history brings in too counts once: on its day, the calls you logged with them and those from the call history count the longer, never both</>],
          ["Several days", <>a trip away together counts the time from when it started to when it ended, less each day&apos;s private hours ({timeLabel(PRIVATE_FROM)} to {timeLabel(PRIVATE_TO)} unless you say), its first {hoursLabel(full)} whole and the rest less and less (below), each day&apos;s part on its own date, fading from there as a {HANGOUT.one} that day would</>],
        ]} />
        <Rows
          example
          rows={[
            ["2 hours, one friend", <><strong>{count(2 * settings.catchUpHourWorth)}</strong> messages</>],
            ["3 hours, 3 people", <><strong>{count(3 * settings.catchUpHourWorth * share(3))}</strong> messages each</>],
            ["3 hours, a friend and 2 others", <><strong>{count(3 * settings.catchUpHourWorth * share(3))}</strong> messages for the friend</>],
            [`10 whole days away, one friend (${tripDay} hours a day)`, <><strong>{count(Math.round(trip(10 * tripDay)))}</strong> messages, {count(Math.round(trip(10 * tripDay) / 10))} a day</>],
            ["a 30-minute call", <><strong>{count(settings.catchUpHourWorth / 2)}</strong> messages</>],
            ["a 1-hour call with 3 people", 60 * share(3) >= settings.callMinimumMinutes
              ? <><strong>{count(settings.catchUpHourWorth * share(3))}</strong> messages each</>
              : <><strong>0</strong>, {minutes(Math.round(60 * share(3)))} each is too short</>],
            ...(settings.callMinimumMinutes >= 2
              ? [[`a ${settings.callMinimumMinutes - 1}-minute call`, <><strong>0</strong>, too short</>] as Row]
              : []),
          ]}
        />
        <p>
          <em>Why {DEFAULT_SETTINGS.catchUpHourWorth}:</em> about one day of real back-and-forth by text. In your 50 most-messaged
          one-to-one chats over two years, a day with 20 or more messages averages about 49 both ways.
        </p>
        <h3 className="method__subhead">With several people</h3>
        <div className="method__equation method__equation--words" role="math" aria-label={`each one's share of the time with n people is ${count(s)} plus ${count(1 - s)} over n`}>
          each one&apos;s share = {count(s)} + {count(1 - s)} ÷ <em>n</em>
        </div>
        <p className="method__under">
          n is everyone there but you, the others you did not name too: {s === 0 ? "an equal split" : <>{percent(s)} of the time is with everyone at once, the rest split equally</>}
        </p>
        <ShareCurve settings={settings} />
        <Rows
          example
          caption={<>A 3-hour dinner, by how many were there besides you</>}
          head={["people", "each one's share", "each counts"]}
          rows={SHARE_SIZES.map((n): Row => [
            String(n), percent(share(n)), <><strong>{count(Math.round(3 * settings.catchUpHourWorth * share(n) * 100) / 100)}</strong> messages</>,
          ])}
        />
        <p className="method__note">
          {HANGOUT.Many} and the calls you log; group chats keep their own rule, since a message to a group is not heard by all of it.
        </p>
        <h3 className="method__subhead">Trips</h3>
        <div className="method__equation method__equation--words" role="math" aria-label={`a trip's hours count as they are up to ${full}, then as ${count(full)} times the square root of hours over ${count(full)}`}>
          hours counted = <em>hours</em> up to {count(full)}, then {count(full)} × √(<em>hours</em> ÷ {count(full)})
        </div>
        <p className="method__under">
          a long trip still counts for more than a short one, but each hour more adds less, so ten days away is not ten long days out
        </p>
        <TripCurve settings={settings} tripDay={tripDay} />
        <Rows
          example
          caption={<>A trip with one friend, by its time together ({tripDay} hours a whole day)</>}
          head={["trip", "every hour whole", "counts"]}
          rows={TRIP_DAYS.map((days): Row => [
            `${days === 1 ? "1 whole day" : `${days} whole days`}, ${hoursLabel(days * tripDay)}`, count(days * tripDay * settings.catchUpHourWorth), <><strong>{count(Math.round(trip(days * tripDay)))}</strong> messages</>,
          ])}
        />
        <Settings settings={settings} keys={["catchUpHourWorth", "callMinimumMinutes", "groupSharedPart", "tripFullHours"]} />
      </>)}

      {part("fading", "Fading", <>Everything counts half after {days(h)}, a quarter after {days(2 * h)}.</>, <>
        <div className="method__equation" role="math" aria-label={`closeness equals the sum of count times one half to the power of age over ${days(h)}`}>
          closeness = <span className="method__sum">Σ</span> count × ½<sup>(age ÷ {days(h)})</sup>
        </div>
        <p className="method__under">over every month&apos;s direct messages, group message (a share) and hour together ({worth}) between you</p>
        <Curve
          label={`What a message counts, by its age: half after ${days(h)}, a quarter after ${days(2 * h)}`}
          x={{ min: 0, max: 4 * h, title: "how long ago", ticks: [0, 1, 2, 3, 4].map((k) => [k * h, ago(k * h)]) }}
          y={{ min: 0, max: 1, title: "counts", ticks: [[0, "0"], [0.5, "½"], [1, "1"]] }}
          lines={[{ f: (age: number) => 0.5 ** (age / h) }]}
          marks={[
            { x: h, y: 0.5, label: `half after ${days(h)}`, anchor: "start" },
            { x: 2 * h, y: 0.25, label: `a quarter after ${days(2 * h)}`, anchor: "start" },
          ]}
        />
        <table className="method__fade">
          <caption>A message counts, when it is</caption>
          <tbody>
            {FADE_AGES.map(([age, label]) => {
              const weight = 0.5 ** (age / h);
              return (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{fraction(weight)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="method__note">
          Messages are dated at the middle of their month, {HANGOUT.many} and calls at the middle of their day; a trail&apos;s past
          month is scored as of its last day.
        </p>
        <Settings settings={settings} keys={["closenessHalfLifeDays"]} />
      </>)}

      {part("map", "On the map", "The closest next to the sun, the rest outward in order.", <>
        <Rows rows={[
          ["Distance", <>rank by closeness, outward on a log scale{bands.length > 0 && <>; rings at the top {listed(bands)}</>}; the outer belt has none yet</>],
        ]} />
        <RankCurve count={onOrbits} />
        <Rows rows={[
          ["Live together", <>tagged <em>live-together</em>: infinitely close, ranked first whatever their score, in the sun itself, glowing like it</>],
          ["Aspiring", <>tagged <em>aspiring</em>: someone you would like to know, far out at the edge of the page in a dashed thought bubble, big however little you have talked, never ranked, their note for what you would say to them</>],
          ["Strength", <>fainter ring by ring: {TIERS.map((t) => percent(t.opacity)).join(" → ")} → {percent(TIER_FLOOR)}</>],
          ["Size", "all your messages: direct both ways, and theirs in group chats"],
          ["Picture", "their identicon; their name is tinted its colour"],
          ["Glow", "“Should reach out” in their panel: their own colour, name haloed too"],
          ["Trail", <>from where they sat {windowLabel(settings.trendMonths)} ago: warm moved in, cool out</>],
          ["Direction", order === "circles"
            ? "friend circles: people who share group chats sit together, each circle an arc named by a common tag"
            : "A to Z clockwise from the top; the Circles page groups friend circles"],
          ["Names", <>{named === ALL ? "everyone with a closeness score" : `the ${named} closest`} (Show top names in the view&apos;s settings), everyone to reach out to, whoever is picked out (on a phone, only whoever is picked out); more as you zoom; each drawn in place of its person&apos;s icon{order === "circles" ? "" : ", turned a little round its orbit, never nearer the sun or further, so names cover each other as little as can be"}</>],
          ["Picked out", <>under the pointer or panel open: full strength, their group chats&apos; people nearly, the rest {percent(BACKGROUND)}; with a panel open, those people all named, as faint as the faintest name (Names, in the view&apos;s settings)</>],
        ]} />
        <p className="method__note">
          Hover anyone for their score, rank and trail. Direction says nothing about closeness.{" "}
          <em>Name format</em> in the menu sets how the map names people{!demo && <>, or hides every name but those you pick</>}; the h key hides the map&apos;s names.
        </p>
        <Settings settings={settings} keys={["trendMonths"]} />
      </>)}

      {part("shown", "Who is shown", "Whoever the query matches, less anyone with a tag ticked in Hide.", <>
        <div className="method__equation method__equation--words">
          shown = the query&apos;s matches − tags ticked in Hide
        </div>
        <p className="method__under">
          Hide starts with <em>archive</em> and <em>commercial</em> ticked{model.hiddenCount > 0 && <>; now {count(model.hiddenCount)} people are left off</>}
        </p>
        <Rows
          caption={<><em>archive</em>{model.archivedCount > 0 && <> ({count(model.archivedCount)} people)</>} holds anyone</>}
          rows={[
            ["Archived by you", demo ? "in their panel" : "in their panel or Events’ People table"],
            ["Known only by", "a number, email or short code"],
            ["Never chatted", "no two-way direct chat, unless you share a group of twelve or fewer that you wrote in"],
          ]}
        />
        <p className="method__note">
          Scores still count group chats shared with anyone left off; ranks and rings run over who is shown. Untick <em>archive</em> in Hide, at the end of the Query bar,{" "}
          to look again: their panel says why each is archived.
        </p>
      </>)}

      {part("asking", "Asking who to show", "Say who in words; a model writes the query.", <>
        <ol className="method__flow" aria-label="How a request becomes who is shown">
          <li>{demo ? "an example" : "your words"}</li>
          <li>a model</li>
          <li>a query</li>
          <li>who matches</li>
          <li>less Hide</li>
        </ol>
        <p className="method__under">
          {demo ? <>In the app you say who to show in words and press Enter; here, pick an example in the box.</> : <>Type in the box and press Enter (or ✓); it says if it can&apos;t.</>}
        </p>
        <dl className="method__query">
          {ASKING_EXAMPLES.map(([example, meaning]) => (
            <div key={example}>
              <dt>&ldquo;{example}&rdquo;</dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>
        <p className="method__note">
          It looks over everyone, archived people too. The line under the box counts who is shown and anything it could not put in
          the query; × shows everyone again, Undo goes back.
        </p>
      </>)}

      {part("settings", "Settings", demo ? "The demo keeps the defaults." : <>Set in <code>data/settings.json</code>.</>, <>
        <Settings settings={settings} keys={SETTINGS} />
        <p className="method__note">
          {demo ? <>In the app they are set in <code>data/settings.json</code>.</> : <>To change them, edit <code>data/settings.json</code> and reload the page.</>}
        </p>
      </>)}

      {part("history", "Decision history", "What each rule was chosen from, newest first.", <>
        {DECISIONS.map((decision) => <DecisionEntry key={`${decision.day} ${decision.title}`} decision={decision} />)}
      </>)}
    </aside>
  );
}

/** Every setting, in the order Settings lists them, with what each means and its unit. */
export const SETTING_ROWS: Record<keyof Settings, { means: string; unit: string }> = {
  messageReciprocity: { means: "balance weighs a month's direct messages", unit: "of 1" },
  groupSharedPart: { means: "everyone at a group hangout or call shares", unit: "of its time" },
  catchUpHourWorth: { means: "what an hour together counts as", unit: "messages" },
  tripFullHours: { means: "a trip's time together counts whole for", unit: "hours" },
  callMinimumMinutes: { means: "a day's calls count from", unit: "minutes" },
  closenessHalfLifeDays: { means: "everything counts half after", unit: "days" },
  trendMonths: { means: "trails look back", unit: "months" },
};

const SETTINGS = Object.keys(SETTING_ROWS) as Array<keyof Settings>;

/** The months Messages works through, theirs and yours of 100. */
const BALANCES: Array<[number, number]> = [[50, 50], [90, 10], [99, 1], [100, 0]];

/** What a month counts as, out of its plain count, when you wrote `share` of it, at reciprocity `r` (directWeight). */
function reciprocal(r: number, share: number): number {
  return directWeight(share, 1 - share, r);
}

/** What can be asked, in words, and what the query counts. */
const ASKING_EXAMPLES: Array<[string, string]> = [
  ["people on Discord I've sent more than 10 messages to", "only your own messages, on Discord alone"],
  ["climbers I haven't spoken to in a year", "a tag, and the day of the last message"],
  ["who writes to me more than I write to them", "one-to-one messages each way"],
  ["in three or more of my group chats but never messaged one to one", "group chats, and one-to-one chats"],
];

/** The ages Fading's table weighs a message at, in days. */
const FADE_AGES: Array<[number, string]> = [
  [0, "today"],
  [365.25 / 4, "3 months old"],
  [365.25 / 2, "6 months old"],
  [365.25, "1 year old"],
  [365.25 * 2, "2 years old"],
];

/** How many people With several people works through, and marks on its curve. */
const SHARE_SIZES = [1, 2, 4, 9, 25];

/** The trips Trips works through, in whole days away. */
const TRIP_DAYS = [1, 2, 5, 10, 30];

/** With several people's curve: each one's share of the time by how many were there, the equal split (dashed) beside it. */
function ShareCurve({ settings }: { settings: Settings }) {
  const share = (n: number) => groupShare(settings, n);
  return (
    <Curve
      label={`Each one's share of the time, by how many were there besides you: ${SHARE_SIZES.slice(1).map((n) => `${percent(share(n))} with ${n}`).join(", ")}`}
      x={{ min: 1, max: 25, title: "people there besides you", ticks: [[1, "1"], [5, "5"], [10, "10"], [15, "15"], [20, "20"], [25, "25"]] }}
      y={{ min: 0, max: 1, title: "share", ticks: [[0, "0"], [0.5, "50%"], [1, "100%"]] }}
      lines={[
        ...(settings.groupSharedPart > 0 ? [{ f: (n: number) => 1 / n, reference: true, label: "1/n, split equally" }] : []),
        { f: share },
      ]}
      marks={SHARE_SIZES.slice(1).map((n) => ({ x: n, y: share(n), label: `${n}: ${percent(share(n))}`, anchor: n < 25 ? "start" as const : "end" as const }))}
    />
  );
}

/**
 * Trips' curve: what a trip with one friend counts by how many whole days it ran, at the settings now, Trips' table's
 * trips marked on it, and every hour whole (dashed) beside it until it leaves the top.
 */
function TripCurve({ settings, tripDay }: { settings: Settings; tripDay: number }) {
  const days = TRIP_DAYS.at(-1)!;
  const counted = (d: number) => tripCountedHours(settings, d * tripDay) * settings.catchUpHourWorth;
  const whole = (d: number) => d * tripDay * settings.catchUpHourWorth;
  const top = roundUp(counted(days));
  // Where every hour whole leaves the top, if it does; drawn only where it differs from the curve.
  const leaves = Math.min(top / (tripDay * settings.catchUpHourWorth), days);
  const differs = whole(days) - counted(days) > top / 100;
  const dayCount = (d: number) => (d === 1 ? "1 day" : `${count(d)} days`);
  return (
    <>
      <Curve
        label={`What a trip with one friend counts, by how many whole days it ran: ${TRIP_DAYS.map((d) => `${count(Math.round(counted(d)))} for ${dayCount(d)}`).join(", ")}`}
        x={{ min: 0, max: days, title: "whole days away", ticks: [0, 5, 10, 15, 20, 25, 30].filter((d) => d <= days).map((d): [number, string] => [d, String(d)]) }}
        y={{ min: 0, max: top, title: "messages", ticks: [[0, "0"], ...(roundish(top / 2) ? [[top / 2, thousands(top / 2)] as [number, string]] : []), [top, thousands(top)]] }}
        lines={[
          ...(differs ? [{ f: whole, reference: true, to: leaves, label: leaves < days ? "every hour whole, off the top" : "every hour whole" }] : []),
          { f: counted },
        ]}
        marks={TRIP_DAYS.map((d, i) => ({
          x: d,
          y: counted(d),
          label: `${dayCount(d)}: ${count(Math.round(counted(d)))}`,
          // The first two sit close together: the first's name below, the second's above it.
          anchor: i === 1 ? "middle" as const : i === TRIP_DAYS.length - 1 ? "end" as const : "start" as const,
          below: i === 0,
        }))}
      />
      {differs && leaves < days && (
        <p className="method__under">
          every hour whole (dashed) leaves the chart after {dayCount(Math.round(leaves * 10) / 10)}; {dayCount(days)} would count {count(Math.round(whole(days)))}
        </p>
      )}
    </>
  );
}

/** A chart's top: `n` rounded up to the next half or whole power of ten's step ("2,898" to "3,000"). */
function roundUp(n: number): number {
  if (n <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(n)) / 2;
  return Math.ceil(n / step) * step;
}

/** One of the Decision history's entries: the question, the options (the one taken marked), the tables, the user's words and what changed. */
function DecisionEntry({ decision }: { decision: Decision }) {
  return (
    <article className="method__decision">
      <h3 className="method__subhead">
        <time dateTime={decision.day}>{catchUpWhen(decision.day)}</time> · {decision.title}
      </h3>
      <dl className="method__decision-facts">
        <dt>Question</dt>
        <dd>{decision.question}</dd>
        {decision.asked && (
          <>
            <dt>Asked</dt>
            <dd><q>{decision.asked}</q></dd>
          </>
        )}
      </dl>
      <Rows
        caption={<>The options</>}
        rows={decision.options.map((option): Row => [
          option.chosen ? <>{option.name} <span className="method__chosen">chosen</span></> : option.name,
          option.detail,
        ])}
      />
      {decision.compared.map((table) => (
        <Rows key={table.caption} example caption={table.caption} head={table.head} rows={table.rows.map(([name, ...cells]): Row => [name, ...cells])} />
      ))}
      <dl className="method__decision-facts">
        <dt>Decided</dt>
        <dd><q>{decision.decided}</q></dd>
        <dt>Changed</dt>
        <dd>{decision.changed}</dd>
        {decision.replacedBy && (
          <>
            <dt>Since</dt>
            <dd>replaced by <em>{decision.replacedBy}</em>, above</dd>
          </>
        )}
      </dl>
    </article>
  );
}

/** Time together's curve: what a day's calls count by how long they ran, and a hangout (dashed) where that differs. */
function HourCurve({ settings }: { settings: Settings }) {
  const w = settings.catchUpHourWorth;
  const least = settings.callMinimumMinutes;
  const span = Math.max(120, 2 * least);
  const step = span <= 120 ? 30 : 60;
  const at = (m: number) => (w * m) / 60;
  const marks = [
    ...(least > 0 ? [{ x: least, y: at(least), label: `from ${least} min: ${count(Math.round(at(least) * 10) / 10)}`, anchor: "start" as const, below: true }] : []),
    ...(least < 20 ? [{ x: 30, y: at(30), label: `30 min: ${count(at(30))}`, anchor: "end" as const }] : []),
    ...(least < 50 ? [{ x: 60, y: at(60), label: `1 hour: ${count(w)}`, anchor: "end" as const }] : []),
    { x: span, y: at(span), label: `${span / 60} hours: ${count(at(span))}`, anchor: "end" as const },
  ];
  return (
    <>
      <Curve
        label={`What a day's calls count, by how long they ran: ${least > 0 ? `nothing under ${minutes(least)}, then ` : ""}${count(w)} messages an hour`}
        x={{
          min: 0,
          max: span,
          title: "minutes connected in a day",
          ticks: Array.from({ length: span / step + 1 }, (_, i): [number, string] => [i * step, i === 0 ? "0" : `${i * step} min`]),
        }}
        y={{ min: 0, max: Math.max(at(span), 1), title: "messages", ticks: [[0, "0"], [at(span) / 2, count(at(span) / 2)], [at(span), count(at(span))]] }}
        lines={[
          ...(least > 0 ? [{ f: at, reference: true }] : []),
          { f: (m: number) => (m < least ? 0 : at(m)), breaks: [least] },
        ]}
        marks={marks}
      />
      {least > 0 && <p className="method__under">a day&apos;s calls jump from nothing at {minutes(least)}; a {HANGOUT.one} (dashed) counts from its first minute</p>}
    </>
  );
}

/** On the map's curve: how far out someone sits by their rank of the `count` shown, the closest ten and hundred marked. */
function RankCurve({ count: n }: { count: number }) {
  if (n < 2) return null;
  const marks = [10, 100].filter((k) => k < n * 0.8).map((k) => ({ x: k, y: rankFraction(k, n), label: `closest ${k}: ${percent(rankFraction(k, n))} out`, anchor: "start" as const }));
  return (
    <Curve
      label={`How far out someone sits by their rank of ${count(n)}: the closest next to the sun, the long tail sharing the outer part`}
      x={{ min: 1, max: n, title: `rank by closeness, of ${count(n)}`, ticks: [[1, "1st"], [n, count(n)]] }}
      y={{ min: 0, max: 1, title: "out", ticks: [[0, "sun"], [1, "edge"]] }}
      lines={[{ f: (k: number) => rankFraction(k, n) }]}
      marks={marks}
    />
  );
}

/** One piece of the sum at a glance: a button that opens its part. */
function GlanceTile({ part, show, title, hour = false, result = false, children }: {
  part: Part;
  show: (part: Part) => void;
  title: string;
  hour?: boolean;
  result?: boolean;
  children: ReactNode;
}) {
  const kind = hour ? " method__tile--hour" : result ? " method__tile--result" : "";
  return (
    <button type="button" className={`method__tile${kind}`} onClick={() => show(part)}>
      <span className="method__tile-title">{title}</span>
      <span>{children}</span>
    </button>
  );
}

type Row = [ReactNode, ...ReactNode[]];

/** A part's rules, or a worked example (its results in bold), one per row: a name, then a cell or two. */
function Rows({ rows, caption, head, example = false }: { rows: Row[]; caption?: ReactNode; head?: string[]; example?: boolean }) {
  return (
    <table className={example ? "method__rows method__rows--example" : "method__rows"}>
      {caption && <caption>{caption}</caption>}
      {head && (
        <thead>
          <tr>{head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr>
        </thead>
      )}
      <tbody>
        {rows.map(([name, ...cells], i) => (
          <tr key={i}>
            <th scope="row">{name}</th>
            {cells.map((cell, j) => <td key={j}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The settings a part uses, with their values now and their defaults. */
function Settings({ settings, keys }: { settings: Settings; keys: Array<keyof Settings> }) {
  return (
    <table className="method__settings">
      <tbody>
        {keys.map((key) => (
          <tr key={key}>
            <th scope="row"><code>{key}</code></th>
            <td>
              {SETTING_ROWS[key].means} {settings[key].toLocaleString(locale())} {SETTING_ROWS[key].unit}
              <span className="method__default">
                {settings[key] === DEFAULT_SETTINGS[key] ? " (the default)" : ` (default ${DEFAULT_SETTINGS[key]})`}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "90 days", "1 year", "2.5 years". */
function days(n: number): string {
  if (n >= 365 && n % 365 === 0) return n === 365 ? "1 year" : `${n / 365} years`;
  return `${n.toLocaleString(locale())} days`;
}

/** A fading curve's age, roughly: "now", "9 days", "3 months", "1 year", "18 months". */
function ago(d: number): string {
  if (d === 0) return "now";
  const months = Math.round(d / MONTH_DAYS);
  if (months < 1) return `${Math.round(d)} days`;
  if (months % 12 === 0) return months === 12 ? "1 year" : `${months / 12} years`;
  return `${months} ${months === 1 ? "month" : "months"}`;
}

/** "5 minutes", "1 minute", "no time at all". */
function minutes(n: number): string {
  return n === 0 ? "no time at all" : `${n.toLocaleString(locale())} ${n === 1 ? "minute" : "minutes"}`;
}

/** "1,000", "12.5". */
function count(n: number): string {
  return n.toLocaleString(locale(), { maximumFractionDigits: 2 });
}

/** Whether a tick is round enough to name: two significant figures at most ("1,500", not "2,750"). */
function roundish(n: number): boolean {
  return Number(n.toPrecision(2)) === n;
}

/** A chart's tick in thousands: "0", "1.5k", "3k", "800". */
function thousands(n: number): string {
  return n >= 1000 ? `${count(n / 1000)}k` : count(n);
}

/** "80%". */
function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** A weight as people say it: "1", "1/2", "about 1/17", "about 1/280", "almost nothing". */
function fraction(x: number): string {
  if (x > 0.99) return "1";
  if (x < 0.001) return "almost nothing";
  const exact = 1 / x;
  const d = exact < 100 ? Math.round(exact) : Number(exact.toPrecision(2));
  const near = d < 10 && Math.abs(exact - d) / d < 0.05;
  return `${near ? "" : "about "}1/${d.toLocaleString(locale())}`;
}

/** "10, 25 and 50". */
function listed(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
