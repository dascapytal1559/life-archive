// The Time river, at /time-river: the river's look and time axis (River.tsx,
// whose geometry, riverLayout.ts, it shares unchanged) over hangouts, calls,
// both together or messages, chosen on the filter bar under the header
// (FilterBar: Messages on its own, or Calls and Hangouts toggled, with the
// time it covers, the app, and for calls whether
// those with no length show; timeRiver.ts keeps them in this browser).
// Messages: each stream as wide as that month's messages, as the river has
// them; Calls: as long as that month's answered calls (a missed call, or one
// with no length known, is a mark in a strip under the river, at its day);
// Hangouts (the start): as many hours as that month's hangouts; Calls and
// Hangouts: the hours of both added up. All time runs
// from the first month with any to now; a span covers just its months. Each
// person is a stream, friend groups flowing as channels of one colour; the
// biggest named inside their own streams, as the name choice has them (nobody
// on a phone, but whoever is picked out). Hovering a stream or a mark shows who
// and their numbers for that month; a click opens their panel, whose person
// stays picked out until it closes. A live view: the Query bar, the Table's
// Hide and the find box narrow and find who it shows, as on Orbits.

import { area, curveMonotoneX } from "d3";
import { useMemo, useState, type Ref } from "react";
import type { CatchUp, ListedCall, MessageApps } from "../archive.ts";
import { archiveApi } from "../archiveApi.ts";
import { HANGOUT } from "../eventWords.ts";
import { useNames } from "../names.ts";
import { locale, monthKey } from "../time.ts";
import { useArchive } from "../useArchive.ts";
import { monthLabel, type DemoPerson } from "./model.ts";
import { PHONE } from "./Orbits.tsx";
import { useMedia } from "./orbitsSky.ts";
import { COLORS, communityColor } from "./palette.ts";
import { layoutRiver, niceBar, placeLabels, streamAt } from "./riverLayout.ts";
import {
  ALL_APPS, appChoices, flowRows, flowsOf, inSpan, kindOn, KINDS, markAt, setFilters, spanMonths, SPANS, toggleKind, useFilters, widthLabel,
  type Filters, type Flow, type Mark, type Span,
} from "./timeRiver.ts";
import "./timeRiver.css";
import { Legend, Swatch, tipAt, useSize, type Demo, type ViewProps } from "./view.tsx";

const LABELLED = 18;
const NONE: never[] = [];

function TimeRiver({ model, width, height, inset, hover, open, held = null }: ViewProps) {
  const filters = useFilters();
  const { measure } = filters;
  const names = useNames();
  const phone = useMedia(PHONE);
  const [barRef, bar] = useSize<HTMLDivElement>();
  // Only what is shown is loaded; a call, hangout or message changed anywhere reloads it.
  const showsCalls = kindOn(measure, "calls");
  const showsHangouts = kindOn(measure, "hangouts");
  const messageApps = useArchive<MessageApps[]>(() => archiveApi.messageApps(), [], { messages: true, enabled: measure === "messages" });
  const calls = useArchive<ListedCall[]>(() => archiveApi.listCalls(), [], { messages: true, enabled: showsCalls });
  const catchUps = useArchive<CatchUp[]>(() => archiveApi.catchUps(), [], { enabled: showsHangouts });
  const loading = (showsCalls && !calls.data) || (showsHangouts && !catchUps.data)
    || (measure === "messages" && filters.app.messages !== ALL_APPS && !messageApps.data);

  const data = useMemo(
    () => ({ people: model.people, months: model.months, messageApps: messageApps.data ?? NONE, calls: calls.data ?? NONE, catchUps: catchUps.data ?? NONE, now: model.now }),
    [model, messageApps.data, calls.data, catchUps.data],
  );
  // Every month with any, for the custom span's choices, and the months the span chosen covers.
  const every = useMemo(() => flowsOf({ ...filters, span: "all" }, data), [filters, data]);
  const flows = useMemo(() => inSpan(every, spanMonths(filters, every.months, model.now)), [every, filters, model.now]);
  const apps = useMemo(() => appChoices(measure, new Set(model.people.map((p) => p.id)), data), [measure, model, data]);
  const byId = useMemo(() => new Map(model.people.map((p) => [p.id, p])), [model]);
  const flowById = useMemo(() => new Map(flows.flows.map((f) => [f.id, f])), [flows]);
  const totals = useMemo(() => new Map(flows.flows.map((f) => [f.id, f.series.reduce((a, b) => a + b, 0)])), [flows]);
  const biggest = Math.max(1e-9, ...totals.values());

  const [focus, setFocus] = useState<{ id: number; month: number; mark?: Mark } | null>(null);
  const now = flows.months.length - 1;
  const current = monthKey(model.now);
  const marked = flows.marks.length > 0;

  const left = 64;
  const right = width - 64;
  const top = inset + (bar.height ? bar.height + 12 : 48) + 52;
  const bottom = height - (marked ? 132 : 104);
  const cy = (top + bottom) / 2;
  const lane = bottom + 46;

  const layout = useMemo(
    () => layoutRiver(flows.flows.map((f) => ({ id: f.id, series: f.series, community: byId.get(f.id)?.community ?? -1 })), { height: Math.max(40, bottom - top) }),
    [flows, byId, top, bottom],
  );
  // By the span's months, not the streams' samples: with only calls that have no length there are marks but no streams.
  const step = (right - left) / Math.max(1, (flows.months.length - 1) * layout.perMonth);
  const x = (sample: number) => left + sample * step;
  const monthX = (i: number) => x(i * layout.perMonth);
  const monthWidth = step * layout.perMonth;

  const paths = useMemo(() => {
    const indices = Array.from({ length: layout.samples }, (_, s) => s);
    return layout.streams.map((stream) => {
      const shape = area<number>()
        .x((s) => left + s * step)
        .y0((s) => cy + stream.y0[s])
        .y1((s) => cy + stream.y1[s])
        .curve(curveMonotoneX);
      return { stream, d: shape(indices) ?? "" };
    });
  }, [layout, left, step, cy]);

  // Named as the name choice has them: the biggest streams, none with names hidden, and on a phone only whoever is picked out.
  const picked = focus?.id ?? held;
  const labels = useMemo(() => {
    if (names.style === "hide") return [];
    const context = document.createElement("canvas").getContext("2d");
    const measureText = (text: string, size: number) => {
      if (!context) return text.length * size * 0.52;
      context.font = `500 ${size}px "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`;
      return context.measureText(text).width;
    };
    const wanted = [...layout.streams]
      .sort((a, b) => a.rank - b.rank)
      .filter((s) => (phone ? s.id === picked : s.rank < LABELLED || s.id === picked))
      .sort((a, b) => Number(b.id === picked) - Number(a.id === picked))
      .map((s) => ({ id: s.id, texts: [names.mapLabel(byId.get(s.id)!).primary].filter(Boolean) }));
    return placeLabels(layout, wanted, { x, measure: measureText, left: left + 80, right: right - 8 });
    // x depends only on left and step.
  }, [layout, byId, names, phone, picked, left, right, step]);

  const opacity = (id: number) => 0.3 + 0.64 * Math.sqrt((totals.get(id) ?? 0) / biggest);
  const years = flows.months.map((m, i) => ({ m, i })).filter(({ m, i }) => i === 0 || m.endsWith("-01"));
  const ended = flows.months[now] !== current;
  const quarters = flows.months.map((m, i) => ({ m, i })).filter(({ m, i }) => i > 0 && !(ended && i === now) && /-(04|07|10)$/.test(m));
  const scaleBar = niceBar(layout.scale);
  const markXs = useMemo(() => flows.marks.map((mark) => monthX(mark.month) + (mark.within - 0.5) * monthWidth), [flows, left, step]);
  // Drawn as a stream or as marks.
  const unshown = model.people.length - new Set([...layout.streams.map((stream) => stream.id), ...flows.marks.map((mark) => mark.id)]).size;

  const show = (event: React.PointerEvent, id: number, month: number, mark?: Mark) => {
    const person = byId.get(id);
    const flow = flowById.get(id);
    if (!person || !flow) return leave();
    setFocus({ id, month, mark });
    hover(tipAt(event, person, rows(flow, month, mark)));
  };
  const leave = () => {
    setFocus(null);
    hover(null);
  };
  const rows = (flow: Flow, month: number, mark?: Mark): Array<[string, string]> => [
    ...(mark ? [[mark.missed ? "Missed call" : "Call, no length", dayLabel(mark.day)] as [string, string]] : []),
    ...flowRows(measure, flow, month, flows.months, current),
  ];

  const pickStream = (event: React.PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const sample = (event.clientX - bounds.left - left) / step;
    const stream = streamAt(layout, sample, event.clientY - bounds.top - cy);
    if (!stream) return leave();
    show(event, stream.id, Math.max(0, Math.min(now, Math.round(sample / layout.perMonth))), undefined);
  };
  const pickMark = (event: React.PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const mark = markAt(flows.marks, markXs, event.clientX - bounds.left, 6);
    if (!mark) return leave();
    show(event, mark.id, mark.month, mark);
  };
  const click = () => {
    const person = focus && byId.get(focus.id);
    if (!person) return;
    setFocus(null);
    hover(null);
    open(person);
  };

  const lit = focus?.id ?? held;
  const litPath = lit !== null ? paths.find((p) => p.stream.id === lit) : undefined;
  const cursor = focus && !focus.mark ? layout.streams.find((s) => s.id === focus.id) : undefined;
  const cursorSample = focus ? focus.month * layout.perMonth : 0;
  const what = measure === "together" ? `calls or ${HANGOUT.many}` : KINDS.find((k) => k.value === measure)!.title.toLowerCase();

  const filterBar = <FilterBar ref={barRef} top={inset} filters={filters} months={every.months} apps={apps} />;
  const quiet = loading ? "Loading…"
    : model.people.length === 0 ? "Nobody is shown."
    : flows.months.length === 1 ? "Choose at least two months to draw a river."
    : layout.streams.length === 0 && !marked ? `No ${what} with anyone shown${filters.span === "all" ? " yet" : " then"}.`
    : null;
  if (quiet) {
    return (
      <>
        {filterBar}
        <p className="demos__status">{quiet}</p>
      </>
    );
  }

  return (
    <>
      {filterBar}
      <svg width={width} height={height} className="time-river" key={measure}>
        <defs>
          <linearGradient id="time-river-fade" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor={COLORS.night} stopOpacity="1" />
            <stop offset="1" stopColor={COLORS.night} stopOpacity="0" />
          </linearGradient>
          <clipPath id="time-river-reveal">
            <rect className="time-river__reveal" x={left - 2} y="0" width={right - left + 4} height={height} />
          </clipPath>
          <filter id="time-river-glow" x="-10%" y="-30%" width="120%" height="160%">
            <feGaussianBlur stdDeviation="14" />
          </filter>
        </defs>

        <g className="time-river__axis" aria-hidden>
          {years.map(({ m, i }) => (
            <g key={m}>
              <line x1={monthX(i)} x2={monthX(i)} y1={top - 26} y2={(marked ? lane : bottom) + 18} className="time-river__year-line" />
              <text x={monthX(i) + 6} y={top - 30} className="time-river__year">{m.slice(0, 4)}</text>
            </g>
          ))}
          {quarters.map(({ m, i }) => (
            <g key={m}>
              <line x1={monthX(i)} x2={monthX(i)} y1={top - 14} y2={(marked ? lane : bottom) + 10} className="time-river__month-line" />
              <text x={monthX(i) + 4} y={top - 16} className="time-river__month">{monthLabel(m).slice(0, 3)}</text>
            </g>
          ))}
          {/* A span that ends before this month ends at its own last month, on the months' row, not now. */}
          {ended
            ? <text x={right} y={top - 16} textAnchor="end" className="time-river__month">{monthLabel(flows.months[now]).slice(0, 3)}</text>
            : <text x={right} y={top - 30} textAnchor="end" className="time-river__now">now</text>}
        </g>

        <g clipPath="url(#time-river-reveal)" className={lit !== null ? "time-river__water time-river__water--focused" : "time-river__water"}>
          <g className="time-river__glow" filter="url(#time-river-glow)">
            {paths.filter(({ stream }) => stream.rank < 40).map(({ stream, d }) => (
              <path key={stream.id} d={d} fill={communityColor(stream.community)} />
            ))}
          </g>
          {paths.map(({ stream, d }) => (
            <path
              key={stream.id}
              d={d}
              className={stream.rank < 30 ? "time-river__stream time-river__stream--edged" : "time-river__stream"}
              fill={communityColor(stream.community)}
              fillOpacity={opacity(stream.id)}
            />
          ))}
          {litPath && <path d={litPath.d} fill={communityColor(litPath.stream.community)} className="time-river__focus" />}
          {/* The first month fades in from the dark rather than starting square. */}
          <rect x={left - 20} y={top - 20} width={90} height={bottom - top + 40} fill="url(#time-river-fade)" />
          {labels.map((label) => (
            <text
              key={label.id}
              x={label.x}
              y={cy + label.y}
              dy="0.35em"
              textAnchor="middle"
              fontSize={label.size}
              className={`time-river__label${opacity(label.id) > 0.72 ? " time-river__label--on-light" : ""}${lit === label.id ? " is-focus" : ""}`}
            >
              {label.text}
            </text>
          ))}
        </g>

        {marked && (
          <g className={lit !== null ? "time-river__marks time-river__marks--focused" : "time-river__marks"}>
            <text x={left} y={lane - 14} className="time-river__lane">calls with no length</text>
            {flows.marks.map((mark, i) => (
              <line
                key={i}
                x1={markXs[i]}
                x2={markXs[i]}
                y1={lane - 7}
                y2={lane + 7}
                stroke={communityColor(byId.get(mark.id)?.community ?? -1)}
                className={`time-river__mark${mark.missed ? " time-river__mark--missed" : ""}${lit === mark.id ? " is-focus" : ""}`}
              />
            ))}
          </g>
        )}

        {focus && cursor && (
          <g className="time-river__cursor" pointerEvents="none">
            <line x1={x(cursorSample)} x2={x(cursorSample)} y1={top - 8} y2={bottom + 8} />
            <circle cx={x(cursorSample)} cy={cy + (cursor.y0[cursorSample] + cursor.y1[cursorSample]) / 2} r="3.5" />
            <text x={x(cursorSample)} y={bottom + 28} textAnchor="middle">{monthLabel(flows.months[focus.month])}</text>
          </g>
        )}

        <rect
          x={left}
          y={top - 20}
          width={Math.max(0, right - left)}
          height={Math.max(0, bottom - top + 40)}
          fill="transparent"
          className={focus ? "time-river__hit time-river__hit--on" : "time-river__hit"}
          onPointerMove={pickStream}
          onPointerLeave={leave}
          onClick={click}
        />
        {marked && (
          <rect
            x={left - 8}
            y={lane - 12}
            width={Math.max(0, right - left + 16)}
            height={24}
            fill="transparent"
            className={focus ? "time-river__hit time-river__hit--on" : "time-river__hit"}
            onPointerMove={pickMark}
            onPointerLeave={leave}
            onClick={click}
          />
        )}
      </svg>
      <Legend>
        {scaleBar.px > 0 && (
          <div className="time-river-key">
            <svg width="14" height={Math.max(6, scaleBar.px)} aria-hidden>
              <rect x="4" y="0" width="6" height={Math.max(6, scaleBar.px)} rx="1.5" fill={COLORS.star} fillOpacity="0.8" />
            </svg>
            width: {widthLabel(measure, scaleBar.messages)} that month
          </div>
        )}
        <div>
          <Swatch color={communityColor(0)} />
          <Swatch color={communityColor(1)} />
          <Swatch color={communityColor(2)} /> one channel per friend group
        </div>
        <div><Swatch color={COLORS.loner} /> no shared group chats, along the banks</div>
        {marked && (
          <div className="time-river-key">
            <svg width="14" height="14" aria-hidden><line x1="7" x2="7" y1="1" y2="13" stroke={COLORS.star} className="time-river__mark time-river__mark--missed" /></svg>
            a missed call (fainter: no length known)
          </div>
        )}
        {measure !== "messages" && <div className="time-river-key__note">One with several people widens each of their streams</div>}
        {unshown > 0 && <div className="time-river-key__note">{unshown.toLocaleString(locale())} with no {what} aren’t drawn</div>}
      </Legend>
    </>
  );
}

/**
 * The bar under the header: what the river shows (Messages on its own, or Calls, Hangouts or both, toggled apart), the
 * time it covers (a span, or from one month to another of those with any), the app calls or messages were on, and for
 * calls whether those with no length show. Every choice is kept in this browser
 * (timeRiver.ts).
 */
function FilterBar({ ref, top, filters, months, apps }: {
  ref: Ref<HTMLDivElement>;
  top: number;
  filters: Filters;
  /** Every month with any of the measure, to choose a span's ends from. */
  months: readonly string[];
  /** The App filter's choices. */
  apps: ReadonlyArray<{ value: string; title: string }>;
}) {
  const { measure } = filters;
  const appOf = measure === "messages" ? "messages" : "calls";
  const app = filters.app[appOf];
  // The app chosen stays offered when nobody shown has any of it now, so the choice still reads as made.
  const appOptions = app === ALL_APPS || apps.some((a) => a.value === app) ? apps : [...apps, { value: app, title: app }];
  const ends = months.length > 0 ? months : [monthKey(Date.now())];
  const from = filters.from && ends.includes(filters.from) ? filters.from : ends[0];
  const to = filters.to && ends.includes(filters.to) ? filters.to : ends[ends.length - 1];
  return (
    <div className="time-river-bar" ref={ref} style={{ top }}>
      {/* Messages on its own, then Calls and Hangouts, which go on together: a count cannot add to time. */}
      <div className="time-river-bar__kinds" role="group" aria-label="Show">
        {KINDS.map((k) => {
          const on = kindOn(measure, k.value);
          const last = on && toggleKind(measure, k.value) === measure;
          return (
            <span key={k.value} className={`time-river-bar__kind time-river-bar__kind--${k.value}`}>
              {k.value === "hangouts" && <span className="time-river-bar__plus" aria-hidden>+</span>}
              <button
                type="button"
                aria-pressed={on}
                title={last ? `${k.about} (at least one stays on)` : k.about}
                onClick={() => setFilters({ measure: toggleKind(measure, k.value) })}
              >
                {k.title}
              </button>
            </span>
          );
        })}
      </div>
      <label className="time-river-bar__field">
        <span>Time</span>
        <select value={filters.span} onChange={(event) => setFilters({ span: event.target.value as Span })}>
          {SPANS.map((s) => <option key={s.value} value={s.value}>{s.title}</option>)}
        </select>
      </label>
      {filters.span === "custom" && (
        <span className="time-river-bar__range">
          <select aria-label="From" value={from} onChange={(event) => setFilters({ from: event.target.value, to: event.target.value > to ? event.target.value : to })}>
            {ends.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <span aria-hidden>to</span>
          <select aria-label="To" value={to} onChange={(event) => setFilters({ to: event.target.value, from: event.target.value < from ? event.target.value : from })}>
            {ends.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </span>
      )}
      {measure !== "hangouts" && (
        <label className="time-river-bar__field" title={measure === "together" ? `The app calls were on; ${HANGOUT.many} have none` : undefined}>
          <span>{measure === "together" ? "Calls on" : "App"}</span>
          <select value={app} onChange={(event) => setFilters({ app: { ...filters.app, [appOf]: event.target.value } })}>
            <option value={ALL_APPS}>All apps</option>
            {appOptions.map((a) => <option key={a.value} value={a.value}>{a.title}</option>)}
          </select>
        </label>
      )}
      {kindOn(measure, "calls") && (
        <label className="time-river-bar__check">
          <input type="checkbox" checked={filters.missed} onChange={(event) => setFilters({ missed: event.target.checked })} />
          Calls with no length
        </label>
      )}
    </div>
  );
}

/** "Sat 4 Oct 2026". */
function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export const timeRiver: Demo = {
  slug: "time-river",
  title: "Time river",
  View: TimeRiver,
};
