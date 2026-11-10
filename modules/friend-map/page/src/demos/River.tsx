// The river, at /demos/river: time runs left to right and each person is a
// stream as wide as how much you talked that month, so friendships swell,
// overlap and fade. Friend groups flow as channels of one colour, the people
// you talk to most bright at their core, everyone else fading into the
// channel's edges. The geometry is in riverLayout.ts.

import { area, curveMonotoneX } from "d3";
import { useMemo, useState } from "react";
import { monthLabel, standing, type DemoPerson } from "./model.ts";
import { COLORS, communityColor } from "./palette.ts";
import { layoutRiver, niceBar, placeLabels, streamAt } from "./riverLayout.ts";
import "./river.css";
import { basicRows, Legend, number, Swatch, tipAt, type Demo, type ViewProps } from "./view.tsx";

const LABELLED = 18;

function River({ model, width, height, inset, hover, open }: ViewProps) {
  const [focus, setFocus] = useState<{ id: number; month: number } | null>(null);
  const now = model.months.length - 1;
  const byId = useMemo(() => new Map(model.people.map((p) => [p.id, p])), [model]);
  const biggest = useMemo(() => Math.max(1, ...model.people.map((p) => p.total)), [model]);

  const left = 64;
  const right = width - 64;
  const top = inset + 52;
  const bottom = height - 104;
  const cy = (top + bottom) / 2;

  const layout = useMemo(
    () => layoutRiver(model.people.map((p) => ({ id: p.id, series: p.series, community: p.community })), { height: Math.max(40, bottom - top) }),
    [model, top, bottom],
  );
  const step = (right - left) / Math.max(1, layout.samples - 1);
  const x = (sample: number) => left + sample * step;

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

  const labels = useMemo(() => {
    const firstNames = new Map<string, number>();
    for (const p of model.people) {
      const first = p.name.split(" ")[0];
      firstNames.set(first, (firstNames.get(first) ?? 0) + 1);
    }
    const context = document.createElement("canvas").getContext("2d");
    const measure = (text: string, size: number) => {
      if (!context) return text.length * size * 0.52;
      context.font = `500 ${size}px "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`;
      return context.measureText(text).width;
    };
    const wanted = [...layout.streams]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, LABELLED)
      .map((s) => {
        const name = byId.get(s.id)?.name ?? "";
        return { id: s.id, texts: [name, shortName(name, firstNames)].filter((t, i, all) => t && all.indexOf(t) === i) };
      });
    return placeLabels(layout, wanted, { x, measure, left: left + 80, right: right - 8 });
    // x depends only on left and step.
  }, [layout, byId, model, left, right, step]);

  const opacity = (person: DemoPerson | undefined) => 0.3 + 0.64 * Math.sqrt((person?.total ?? 0) / biggest);
  const years = model.months.map((m, i) => ({ m, i })).filter(({ m, i }) => i === 0 || m.endsWith("-01"));
  const quarters = model.months.map((m, i) => ({ m, i })).filter(({ m, i }) => i > 0 && /-(04|07|10)$/.test(m));
  const monthX = (i: number) => x(i * layout.perMonth);
  const scaleBar = niceBar(layout.scale);
  const silent = model.people.filter((p) => p.total === 0).length;

  const pick = (event: React.PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = event.clientX - bounds.left;
    const py = event.clientY - bounds.top;
    const sample = (px - left) / step;
    const stream = streamAt(layout, sample, py - cy);
    const person = stream && byId.get(stream.id);
    if (!person) {
      setFocus(null);
      hover(null);
      return;
    }
    const month = Math.max(0, Math.min(now, Math.round(sample / layout.perMonth)));
    setFocus({ id: person.id, month });
    hover(tipAt(event, person, rows(person, month)));
  };

  const rows = (person: DemoPerson, month: number): Array<[string, string]> => {
    const busiest = person.series.reduce((best, n, i) => (n > person.series[best] ? i : best), 0);
    return [
      [month === now ? `${monthLabel(model.months[month])} so far` : monthLabel(model.months[month]), `${number(person.series[month])} messages`],
      ...basicRows(person, standing(person, now, model)),
      ["Busiest month", `${monthLabel(model.months[busiest])} · ${number(person.series[busiest])}`],
    ];
  };

  const focusPath = focus && paths.find((p) => p.stream.id === focus.id);
  const focusStream = focusPath?.stream;
  const focusSample = focus ? focus.month * layout.perMonth : 0;

  return (
    <>
      <svg width={width} height={height} className="river">
        <defs>
          <linearGradient id="river-fade" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor={COLORS.night} stopOpacity="1" />
            <stop offset="1" stopColor={COLORS.night} stopOpacity="0" />
          </linearGradient>
          <clipPath id="river-reveal">
            <rect className="river__reveal" x={left - 2} y="0" width={right - left + 4} height={height} />
          </clipPath>
          <filter id="river-glow" x="-10%" y="-30%" width="120%" height="160%">
            <feGaussianBlur stdDeviation="14" />
          </filter>
        </defs>

        <g className="river__axis" aria-hidden>
          {years.map(({ m, i }) => (
            <g key={m}>
              <line x1={monthX(i)} x2={monthX(i)} y1={top - 26} y2={bottom + 18} className="river__year-line" />
              <text x={monthX(i) + 6} y={top - 30} className="river__year">{m.slice(0, 4)}</text>
            </g>
          ))}
          {quarters.map(({ m, i }) => (
            <g key={m}>
              <line x1={monthX(i)} x2={monthX(i)} y1={top - 14} y2={bottom + 10} className="river__month-line" />
              <text x={monthX(i) + 4} y={top - 16} className="river__month">{monthLabel(m).slice(0, 3)}</text>
            </g>
          ))}
          <text x={right} y={top - 30} textAnchor="end" className="river__now">now</text>
        </g>

        <g clipPath="url(#river-reveal)" className={focus ? "river__water river__water--focused" : "river__water"}>
          <g className="river__glow" filter="url(#river-glow)">
            {paths.filter(({ stream }) => stream.rank < 40).map(({ stream, d }) => (
              <path key={stream.id} d={d} fill={communityColor(stream.community)} />
            ))}
          </g>
          {paths.map(({ stream, d }) => (
            <path
              key={stream.id}
              d={d}
              className={stream.rank < 30 ? "river__stream river__stream--edged" : "river__stream"}
              fill={communityColor(stream.community)}
              fillOpacity={opacity(byId.get(stream.id))}
            />
          ))}
          {focusPath && <path d={focusPath.d} fill={communityColor(focusPath.stream.community)} className="river__focus" />}
          {/* The archive's first month fades in from the dark rather than starting square. */}
          <rect x={left - 20} y={top - 20} width={90} height={bottom - top + 40} fill="url(#river-fade)" />
          {labels.map((label) => (
            <text
              key={label.id}
              x={label.x}
              y={cy + label.y}
              dy="0.35em"
              textAnchor="middle"
              fontSize={label.size}
              className={`river__label${opacity(byId.get(label.id)) > 0.72 ? " river__label--on-light" : ""}${focus?.id === label.id ? " is-focus" : ""}`}
            >
              {label.text}
            </text>
          ))}
        </g>

        {focus && focusStream && (
          <g className="river__cursor" pointerEvents="none">
            <line x1={x(focusSample)} x2={x(focusSample)} y1={top - 8} y2={bottom + 8} />
            <circle cx={x(focusSample)} cy={cy + (focusStream.y0[focusSample] + focusStream.y1[focusSample]) / 2} r="3.5" />
            <text x={x(focusSample)} y={bottom + 28} textAnchor="middle">{monthLabel(model.months[focus.month])}</text>
          </g>
        )}

        <rect
          x={left}
          y={top - 20}
          width={Math.max(0, right - left)}
          height={Math.max(0, bottom - top + 40)}
          fill="transparent"
          className={focus ? "river__hit river__hit--on" : "river__hit"}
          onPointerMove={pick}
          onPointerLeave={() => {
            setFocus(null);
            hover(null);
          }}
          onClick={() => {
            const person = focus && byId.get(focus.id);
            if (!person) return;
            setFocus(null);
            open(person);
          }}
        />
      </svg>
      <Legend>
        <div className="river-key">
          <svg width="14" height={Math.max(6, scaleBar.px)} aria-hidden>
            <rect x="4" y="0" width="6" height={Math.max(6, scaleBar.px)} rx="1.5" fill={COLORS.star} fillOpacity="0.8" />
          </svg>
          width: {number(scaleBar.messages)} messages that month
        </div>
        <div>
          <Swatch color={communityColor(0)} />
          <Swatch color={communityColor(1)} />
          <Swatch color={communityColor(2)} /> one channel per friend group
        </div>
        <div><Swatch color={COLORS.loner} /> no shared group chats, along the banks</div>
        <div className="river-key river-key--fade">
          <span className="river-key__ramp" aria-hidden /> brightest: who you talk to most
        </div>
        {silent > 0 && <div className="river-key__note">{silent} with no messages yet aren’t drawn</div>}
      </Legend>
    </>
  );
}

/** "Orla" where no one else is called Orla, otherwise "Orla M.". */
function shortName(name: string, firstNames: Map<string, number>): string {
  const [first, ...rest] = name.split(" ");
  return (firstNames.get(first) ?? 0) > 1 && rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first;
}

export const river: Demo = {
  slug: "river",
  title: "The river",
  line: "Time runs left to right. Each person is a stream as wide as how much you talked that month, so friendships swell, overlap and fade.",
  View: River,
};
