// How close you and a person have been, all time: a bar for every month from
// your first event to your last, in the Events section of their panel, in
// closeness points (what the month's events counted for before fading). Their
// messages rise above the line and yours hang below it, on the same scale, so
// you can see how much each side wrote back; where a chat keeps only your side
// (Discord's), the replies the score assumes rise above the line in a lighter
// grey, outermost; calls and hangouts are shared, so
// each sits half above and half below, against the line. Pointing at (or
// tapping, or focusing the chart and moving with the arrow keys) a month shows
// its points and what made them up in a tooltip floating beside it, which takes
// no room at rest; screen readers hear the same through a live region. It loads on its
// own once the panel has drawn (GET /people/:id/activity: counts only), with
// your closeness settings.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { activityBars, monthCounts, monthName, monthReach, monthReadout, SELF_ONLY } from "./activity.ts";
import { appApi } from "./appApi.ts";
import { archiveApi } from "./archiveApi.ts";
import { scoreLabel } from "./demos/closeness.ts";
import { HANGOUT } from "./eventWords.ts";
import { useArchive } from "./useArchive.ts";

const WIDTH = 380;
const HEIGHT = 80;
/** Room at the left for "Them" and "You". */
const LEFT = 30;
const TOP = 2;
/** How tall each side may grow from the line. */
const HALF = 31;
const BASE = TOP + HALF;

export function ActivityChart({ personId, groups }: { personId: number; groups: boolean }) {
  const activity = useArchive(() => appApi.settings().then((s) => archiveApi.activity(personId, s.settings)), [personId], { messages: true });
  const [hovered, setHovered] = useState<number | null>(null);
  const chart = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  // Whether the pointer is in the chart's left half, to keep the tooltip off it when no side of the month has room.
  const [pointerLeft, setPointerLeft] = useState(true);
  // A tap elsewhere puts a tapped month's tooltip away (a mouse does it by leaving).
  useEffect(() => {
    if (hovered === null) return;
    const away = (e: globalThis.PointerEvent) => {
      if (!chart.current?.contains(e.target as Node)) setHovered(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [hovered]);
  // Beside the month's band, right of it when it fits and else left, inside the chart, wrapping narrower on the
  // roomier side when neither fits; when the band is too wide even for that (a few months only), at the chart's far
  // side from the pointer.
  useLayoutEffect(() => {
    const tip = tooltip.current;
    const band = chart.current?.querySelector(".activity-chart__month");
    if (!tip || !band || !chart.current) return;
    tip.style.maxWidth = "";
    const box = chart.current.getBoundingClientRect();
    const month = band.getBoundingClientRect();
    const gap = 6;
    const roomRight = box.right - month.right - gap;
    const roomLeft = month.left - box.left - gap;
    const fit = (room: number) => Math.min(tip.offsetWidth, room);
    let left: number;
    if (tip.offsetWidth <= roomRight) left = month.right - box.left + gap;
    else if (tip.offsetWidth <= roomLeft) left = roomLeft - tip.offsetWidth;
    else if (Math.max(roomLeft, roomRight) >= 120) {
      const room = Math.max(roomLeft, roomRight);
      tip.style.maxWidth = `${room}px`;
      left = roomRight >= roomLeft ? month.right - box.left + gap : roomLeft - fit(room);
    } else left = pointerLeft ? box.width - tip.offsetWidth : 0;
    tip.style.left = `${left}px`;
  });
  if (!activity.data) return <div className="activity-chart activity-chart--waiting" />;
  const bars = activityBars(activity.data, groups);
  const { months } = bars;
  if (months.length === 0) return null;
  const reach = months.map((_, i) => monthReach(bars, i));
  const top = Math.max(1, ...reach.map((r) => Math.max(r.above, r.below)));
  const step = (WIDTH - LEFT) / months.length;
  const gap = Math.min(2, step * 0.25);
  const width = Math.max(0.5, step - gap);
  const x = (i: number) => LEFT + i * step + gap / 2;
  const height = (points: number) => (points / top) * HALF;
  const shown = hovered !== null && hovered < months.length ? hovered : null;
  const point = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const at = ((e.clientX - box.left) / box.width) * WIDTH;
    setPointerLeft(at < WIDTH / 2);
    setHovered(at < LEFT ? null : Math.min(months.length - 1, Math.floor((at - LEFT) / step)));
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    const last = months.length - 1;
    const at = shown ?? last;
    const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: last }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setHovered(Math.max(0, Math.min(last, next)));
  };
  const readout = shown === null ? null : monthReadout(bars, shown);
  const counts = shown === null ? null : monthCounts(bars, shown) || "Nothing this month";
  const hasCalls = bars.calls.some((n) => n > 0);
  const hasHangouts = bars.hangouts.some((n) => n > 0);
  const hasAssumed = bars.themAssumed.some((n) => n > 0);
  return (
    <div className="activity-chart" ref={chart}>
      <p className="visually-hidden" aria-live="polite">{readout && `${readout}. ${counts}`}</p>
      {shown !== null && (
        <div
          className="activity-chart__tooltip"
          aria-hidden="true"
          ref={tooltip}
        >
          {readout}
          <br />
          <span className="activity-chart__counts">{counts}</span>
        </div>
      )}
      <svg
        tabIndex={0}
        onKeyDown={key}
        onFocus={() => setHovered((h) => h ?? months.length - 1)}
        onBlur={() => setHovered(null)}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Closeness points a month, ${monthName(months[0])} to ${monthName(months.at(-1)!)}: their messages above the line${hasAssumed ? `, some assumed as ${SELF_ONLY}` : ""}, yours below, calls and ${HANGOUT.many} half each side, at most ${scoreLabel(top)}`}
        onPointerMove={point}
        onPointerDown={point}
        onPointerLeave={(e) => e.pointerType === "mouse" && setHovered(null)}
      >
        <text className="activity-chart__axis" x={0} y={BASE - HALF / 2 + 3}>Them</text>
        <text className="activity-chart__axis" x={0} y={BASE + HALF / 2 + 3}>You</text>
        {shown !== null && (
          <rect className="activity-chart__month" x={LEFT + shown * step} width={step} y={TOP - 1} height={HALF * 2 + 2} />
        )}
        {months.map((month, i) => {
          // From the line out: the hangouts' half, the calls' half, then the side's own messages (theirs with the replies assumed, drawn as theirs).
          const hangout = height(bars.hangouts[i] / 2);
          const call = height(bars.calls[i] / 2);
          const shared = hangout + call;
          const them = height(bars.them[i]);
          return (
            <g key={month}>
              {hangout > 0 && <rect className="activity-chart__bar--hangouts" x={x(i)} width={width} y={BASE - hangout} height={hangout * 2} />}
              {call > 0 && (
                <>
                  <rect className="activity-chart__bar--calls" x={x(i)} width={width} y={BASE - shared} height={call} />
                  <rect className="activity-chart__bar--calls" x={x(i)} width={width} y={BASE + hangout} height={call} />
                </>
              )}
              {them > 0 && <rect className="activity-chart__bar" x={x(i)} width={width} y={BASE - shared - them} height={them} />}
              {bars.you[i] > 0 && (
                <rect className="activity-chart__bar--you" x={x(i)} width={width} y={BASE + shared} height={height(bars.you[i])} />
              )}
            </g>
          );
        })}
        <line className="activity-chart__base" x1={LEFT} x2={WIDTH} y1={BASE} y2={BASE} />
        <text className="activity-chart__axis" x={LEFT} y={HEIGHT - 3}>{monthName(months[0])}</text>
        {months.length > 1 && (
          <text className="activity-chart__axis" x={WIDTH} y={HEIGHT - 3} textAnchor="end">{monthName(months.at(-1)!)}</text>
        )}
      </svg>
      <ul className="activity-chart__legend" aria-hidden="true">
        <li><span className="activity-chart__key activity-chart__key--them" />Them</li>
        <li><span className="activity-chart__key activity-chart__key--you" />You</li>
        {hasCalls && <li><span className="activity-chart__key activity-chart__key--calls" />Calls</li>}
        {hasHangouts && <li><span className="activity-chart__key activity-chart__key--hangouts" />{HANGOUT.Many}</li>}
      </ul>
    </div>
  );
}

