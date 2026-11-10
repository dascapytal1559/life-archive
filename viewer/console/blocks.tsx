// The console's building blocks (console.css), which every view draws its surface with, so the console reads as one
// product: a strip of KPIs, a card with a head, a bar chart (plain DOM, one bar a bucket), a list of facts, and a table
// that reflows on a phone. Each is plain markup with the console's tokens; none knows what it shows.

import type { ReactNode } from "react";
import { LOCALE } from "../../src/time.ts";

/** A row of KPIs, hairlines between them, however many fit on a line. */
export function Kpis({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="kpis" role="list" aria-label={label}>
      {children}
    </div>
  );
}

/** How a KPI's value is coloured: the text, the accent, or a Health status. */
export type Tone = "text" | "accent" | "muted" | "out" | "mild" | "edge" | "in" | "treated" | "unjudged";

/** One KPI: a label, a big number (or words), its unit beside it, and a line under it. */
export function Kpi({ label, value, unit, note, tone = "text" }: { label: string; value: ReactNode; unit?: string; note?: ReactNode; tone?: Tone }) {
  return (
    <div className={`kpi kpi--${tone}`} role="listitem">
      <div className="kpi__label">{label}</div>
      <div className="kpi__value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {note !== undefined && note !== null && <div className="kpi__note">{note}</div>}
    </div>
  );
}

/** A card: its title, a word at the right (a count, a span), and what it holds; `flush` for a table that fills it. */
export function Card({ title, aside, icon, children, flush = false, className = "" }: { title: ReactNode; aside?: ReactNode; icon?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`card${flush ? " card--flush" : ""} ${className}`.trim()}>
      <div className="card__head">
        {icon}
        <h3>{title}</h3>
        {aside !== undefined && <span className="card__aside">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

export interface Bar {
  label: string;
  value: number;
  /** What the bar's tooltip says; the label and value when left out. */
  title?: string;
}

/**
 * A bar chart of one series: each bar as tall as its share of the tallest, the last bar in the accent (the latest
 * bucket), the first and last labels under it. Its words for a screen reader are `label`, with each bar's title.
 */
export function BarChart({ bars, label, height = 150 }: { bars: readonly Bar[]; label: string; height?: number }) {
  const most = Math.max(1, ...bars.map((bar) => bar.value));
  const titleOf = (bar: Bar) => bar.title ?? `${bar.label}: ${bar.value.toLocaleString(LOCALE)}`;
  return (
    <div className="c-chart">
      <div className="c-chart__bars" style={{ height }} role="img" aria-label={`${label}. ${bars.map(titleOf).join("; ")}.`}>
        {bars.map((bar) => (
          <i key={bar.label} title={titleOf(bar)} style={{ height: `${Math.max(bar.value > 0 ? 2 : 0, Math.round((bar.value / most) * 100))}%` }} />
        ))}
      </div>
      {bars.length > 0 && (
        <div className="c-chart__cap" aria-hidden="true">
          <span>{bars[0].label}</span>
          {bars.length > 1 && <span>{bars[bars.length - 1].label}</span>}
        </div>
      )}
    </div>
  );
}

/** A list of facts, a key and a value a line. */
export function Facts({ facts }: { facts: ReadonlyArray<{ key: string; value: ReactNode }> }) {
  return (
    <ul className="facts">
      {facts.map((fact) => (
        <li key={fact.key}>
          <span className="facts__key">{fact.key}</span>
          <span className="facts__value">{fact.value}</span>
        </li>
      ))}
    </ul>
  );
}

export interface Column {
  label: string;
  /** Its track in the grid ("minmax(0, 1fr)" when left out). */
  width?: string;
  /** Written in the mono face (a number, a date). */
  mono?: boolean;
  /** Right-aligned. */
  numeric?: boolean;
  /** On a phone: left out, or kept (the first column always leads the row there). */
  phone?: "hide" | "keep";
}

export interface TableRow {
  key: string;
  cells: ReactNode[];
  /** A link: the row is an anchor, and `onClick` opens it in place. */
  href?: string;
  onClick?: (event: React.MouseEvent) => void;
  /** Marks the row to stand out (an overdue source, say). */
  alert?: boolean;
}

/**
 * A table as the console draws one: a mono header and rows on hairlines, columns as the grid tracks `columns` give,
 * each row a link when it has one. On a phone the header goes, the first column leads each row and the rest follow it,
 * those marked `hide` left out.
 */
export function Table({ columns, rows, empty = "Nothing yet.", label }: { columns: readonly Column[]; rows: readonly TableRow[]; empty?: ReactNode; label?: string }) {
  const style = { "--table-columns": columns.map((column) => column.width ?? "minmax(0, 1fr)").join(" ") } as React.CSSProperties;
  const cellClass = (column: Column, i: number) =>
    ["c-table__cell", column.mono && "c-table__cell--mono", column.numeric && "c-table__cell--numeric", column.phone === "hide" && "c-table__cell--phone-hide", i === 0 && "c-table__cell--lead"]
      .filter(Boolean)
      .join(" ");
  return (
    <div className="c-table" role="table" aria-label={label} style={style}>
      <div className="c-table__head" role="row">
        {columns.map((column, i) => (
          <span key={column.label} role="columnheader" className={cellClass(column, i)}>
            {column.label}
          </span>
        ))}
      </div>
      {rows.length === 0 && <div className="c-table__empty">{empty}</div>}
      {rows.map((row) => {
        const cells = row.cells.map((cell, i) => (
          <span key={i} role="cell" className={cellClass(columns[i], i)}>
            {cell}
          </span>
        ));
        return row.href ? (
          <a key={row.key} role="row" className={`c-table__row c-table__row--link${row.alert ? " c-table__row--alert" : ""}`} href={row.href} onClick={row.onClick}>
            {cells}
          </a>
        ) : (
          <div key={row.key} role="row" className={`c-table__row${row.alert ? " c-table__row--alert" : ""}`}>
            {cells}
          </div>
        );
      })}
    </div>
  );
}
