// The filter bar under the header: a search box for a tab that has one (People, by name), a button for each of the
// tab's filters, opening its values with how many rows have each under the other filters (the facets), the time range
// the chart set, and Clear. Every change goes to one filter object, which the table, the chart and the facets all follow.

import { useEffect, useRef, useState } from "react";
import { countText, dateText } from "./format.ts";
import { isFiltered } from "./viewState.ts";
import { NO_FILTERS, type FacetValue, type Filters, type FilterSpec, type KindSpec } from "./wire.ts";

interface Props {
  spec: KindSpec;
  filters: Filters;
  facets: Record<string, FacetValue[]> | null;
  onChange: (filters: Filters) => void;
}

export function FilterBar({ spec, filters, facets, onChange }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const range = filters.from !== null || filters.to !== null;
  return (
    <div className="filters" role="toolbar" aria-label="Filters">
      {spec.search && <SearchBox key={spec.kind} placeholder={spec.search} search={filters.search} onSearch={(search) => onChange({ ...filters, search })} />}
      {spec.filters.map((filter) => (
        <FilterMenu
          key={filter.key}
          filter={filter}
          filters={filters}
          values={facets?.[filter.key] ?? null}
          open={open === filter.key}
          onOpen={(isOpen) => setOpen(isOpen ? filter.key : null)}
          onChange={onChange}
        />
      ))}
      {range && (
        <span className="chip chip--range">
          {rangeText(filters.from, filters.to)}
          <button type="button" aria-label="Clear the time range" onClick={() => onChange({ ...filters, from: null, to: null })}>
            ✕
          </button>
        </span>
      )}
      {isFiltered(filters) && (
        <button type="button" className="filters__clear" onClick={() => onChange(NO_FILTERS)}>
          Clear all
        </button>
      )}
    </div>
  );
}

/** How long typing waits before it searches. */
const TYPING = 250;

/** The search box: what is typed searches once typing pauses (or on Enter), and follows the filters when they clear it. */
function SearchBox({ placeholder, search, onSearch }: { placeholder: string; search: string | null; onSearch: (search: string | null) => void }) {
  const [text, setText] = useState(search ?? "");
  useEffect(() => setText(search ?? ""), [search]);
  useEffect(() => {
    const wanted = text.trim() || null;
    if (wanted === search) return;
    const timer = setTimeout(() => onSearch(wanted), TYPING);
    return () => clearTimeout(timer);
    // Only what is typed starts a search.
  }, [text]);
  return (
    <input
      className="filters__search"
      type="search"
      name="search"
      placeholder={placeholder}
      aria-label={placeholder}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => event.key === "Enter" && onSearch(text.trim() || null)}
    />
  );
}

/** "3 Mar 2026 – 9 Mar 2026": the range's first day to its last (its end is the start of the day after). */
function rangeText(from: number | null, to: number | null): string {
  if (from === null) return `until ${dateText(to! - 1)}`;
  if (to === null) return `from ${dateText(from)}`;
  const first = dateText(from);
  const last = dateText(to - 1);
  return first === last ? first : `${first} – ${last}`;
}

interface MenuProps {
  filter: FilterSpec;
  filters: Filters;
  values: FacetValue[] | null;
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (filters: Filters) => void;
}

function FilterMenu({ filter, filters, values, open, onOpen, onChange }: MenuProps) {
  const box = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");

  // A press outside, or Escape, closes it.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) onOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onOpen]);

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const chosen = filter.kind === "person" ? (filters.person === null ? [] : [String(filters.person)]) : (filters.choices[filter.key] ?? []);
  const names = chosen.map((value) => values?.find((v) => v.value === value)?.label ?? (filter.kind === "person" ? `Person ${value}` : value));
  const summary = chosen.length === 0 ? (filter.kind === "person" ? "Anyone" : "All") : chosen.length === 1 ? names[0] : `${chosen.length} chosen`;

  const toggle = (value: string) => {
    if (filter.kind === "person") {
      onChange({ ...filters, person: chosen.includes(value) ? null : Number(value) });
      onOpen(false);
      return;
    }
    const next = chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value];
    const choices = { ...filters.choices };
    if (next.length > 0) choices[filter.key] = next;
    else delete choices[filter.key];
    onChange({ ...filters, choices });
  };
  const clear = () => {
    if (filter.kind === "person") onChange({ ...filters, person: null });
    else {
      const choices = { ...filters.choices };
      delete choices[filter.key];
      onChange({ ...filters, choices });
    }
    onOpen(false);
  };

  const needle = search.trim().toLowerCase();
  const listed = (values ?? []).filter((v) => needle === "" || v.label.toLowerCase().includes(needle));

  return (
    <div className="filter" ref={box}>
      <button
        type="button"
        className={`filter__button${chosen.length > 0 ? " filter__button--on" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => onOpen(!open)}
      >
        <span className="filter__label">{filter.label}</span> <span className="filter__summary">{summary}</span>
        <span className="filter__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="filter__menu" role="dialog" aria-label={filter.label}>
          {filter.find && (
            <input
              className="filter__search"
              type="search"
              name={`${filter.key}-search`}
              placeholder={filter.find}
              value={search}
              autoFocus
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
          <ul className="filter__values">
            <li>
              <button type="button" className="filter__value filter__value--any" aria-pressed={chosen.length === 0} onClick={clear}>
                {filter.kind === "person" ? "Anyone" : "All"}
              </button>
            </li>
            {values === null && <li className="filter__note">Loading…</li>}
            {listed.map((v) => (
              <li key={v.value}>
                <button type="button" className="filter__value" aria-pressed={chosen.includes(v.value)} onClick={() => toggle(v.value)}>
                  {filter.kind === "choice" && <span className="filter__check" aria-hidden="true" />}
                  <span className="filter__name">{v.label}</span>
                  <span className="filter__count">{countText(v.count)}</span>
                </button>
              </li>
            ))}
            {values !== null && listed.length === 0 && <li className="filter__note">{needle ? "None by that name" : "None"}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
