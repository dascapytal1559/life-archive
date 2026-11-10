// The Hide button at the end of the Query bar, and the small panel it opens:
// every tag Hide lists (see hideChoices.ts), with how many people have it,
// each switched on or off. The button is an icon alone (an eye struck through), square, as tall as the
// header's other controls; it says how many are on only in its title, and the panel
// ends with one button that switches every row on, or off when all already are.

import { useEffect, useRef, useState } from "react";
import { chooseAllHide, chooseHide, forgetOldPanels, HIDE_KEYS, hides, loadHideChoices, saveHideChoices, type HideChoices, type HideEntry, type HideScope } from "./hideChoices.ts";
import { number } from "./view.tsx";

/** Hide's choices for a view over `scope`, as last made in this browser, followed as another page changes them (a tag renamed in Events' Tags). */
export function useHideChoices(scope: HideScope): [HideChoices, (next: HideChoices) => void] {
  const key = HIDE_KEYS[scope];
  const [value, setValue] = useState(() => {
    forgetOldPanels();
    return loadHideChoices(key);
  });
  useEffect(() => {
    const follow = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setValue(loadHideChoices(key));
    };
    window.addEventListener("storage", follow);
    return () => window.removeEventListener("storage", follow);
  }, [key]);
  const update = (next: HideChoices) => {
    setValue(next);
    saveHideChoices(key, next);
  };
  return [value, update];
}

export function HidePanel({ entries, choices, onChange }: {
  entries: HideEntry[];
  choices: HideChoices;
  onChange: (next: HideChoices) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isOn = (entry: HideEntry) => hides(choices, entry.tag);
  const allOn = entries.every(isOn);
  const on = entries.filter(isOn).length;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="tag-filter" ref={ref}>
      <button
        type="button"
        className="demos__method tag-filter__button"
        aria-label="Hide"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`Hide: people with any of the tags switched on are left out, after the query (${on} on)`}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path d="M1.5 8 C3.3 4.9 5.5 3.5 8 3.5 S12.7 4.9 14.5 8 C12.7 11.1 10.5 12.5 8 12.5 S3.3 11.1 1.5 8 Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M2.5 13.5 L13.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="tag-filter__panel" role="dialog" aria-label="Hide by tag">
          <ul>
            {entries.map((entry) => (
              <li key={entry.tag}>
                {/* A row is struck through while it leaves people out. */}
                <label className={isOn(entry) ? "tag-filter__off" : undefined}>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={isOn(entry)}
                    onChange={(event) => onChange(chooseHide(choices, entry.tag, event.target.checked))}
                  />
                  <span className="tag-filter__tag">{entry.tag}</span>
                  {entry.count === null ? (
                    <span className="tag-filter__count" title="Counted once the map shows them (archived people are loaded only then)">…</span>
                  ) : (
                    <span className="tag-filter__count">{number(entry.count)}</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className="tag-filter__all" onClick={() => onChange(chooseAllHide(choices, entries, !allOn))}>
            {allOn ? "Unselect all" : "Select all"}
          </button>
        </div>
      )}
    </div>
  );
}
