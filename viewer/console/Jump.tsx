// Jump to: the console's palette (⌘K, Ctrl+K, or the bar's button), a box to type in over a list of every place in the
// console (each aspect, each view under an aspect that has several, and each table the archive keeps, which Events'
// Tables opens: jumpEntries), narrowed by the words typed; ↑ and ↓ move, Enter
// opens, Esc closes. Keyboard navigation across the whole console in one place, and the one search the console has.

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icons.tsx";

export interface JumpEntry {
  label: string;
  /** Where it is ("Health"), under the label. */
  detail: string;
  path: string;
}

/** A place Jump to can open: its name and its address. */
export interface JumpPlace {
  label: string;
  path: string;
}

/**
 * Everything Jump to lists, in the rail's order: each page (`pages`: an aspect, at its first view), each view of a page
 * that has several (a page of one view is listed once, as itself: its view has no tab to be known by), then each table
 * the archive keeps (`tables`), said to be at `tablesAt` ("Events · Tables"), so a table is found by its name from
 * anywhere, whichever module's it is.
 */
export function jumpEntries(pages: ReadonlyArray<JumpPlace & { views: readonly JumpPlace[] }>, tables: readonly JumpPlace[], tablesAt: string): JumpEntry[] {
  return [
    ...pages.flatMap((page) => [
      { label: page.label, detail: "Aspect", path: page.path },
      ...(page.views.length > 1 ? page.views.map((view) => ({ label: view.label, detail: page.label, path: view.path })) : []),
    ]),
    ...tables.map((table) => ({ label: table.label, detail: tablesAt, path: table.path })),
  ];
}

export function Jump({ entries, onGo, onClose }: { entries: readonly JumpEntry[]; onGo: (path: string) => void; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const words = typed.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = entries.filter((entry) => words.every((word) => `${entry.label} ${entry.detail}`.toLowerCase().includes(word)));
  const chosen = shown[Math.min(at, Math.max(0, shown.length - 1))];

  useEffect(() => {
    input.current?.focus();
  }, []);
  // The page behind is kept still and out of reach while the palette is open.
  useEffect(() => {
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => void (document.body.style.overflow = was);
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") return void (event.preventDefault(), onClose());
    if (event.key === "ArrowDown") return void (event.preventDefault(), setAt(shown.length ? (Math.min(at, shown.length - 1) + 1) % shown.length : 0));
    if (event.key === "ArrowUp") return void (event.preventDefault(), setAt(shown.length ? (Math.min(at, shown.length - 1) - 1 + shown.length) % shown.length : 0));
    if (event.key === "Enter" && chosen) return void (event.preventDefault(), onGo(chosen.path));
  };

  return (
    <div className="jump" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="jump__box" role="dialog" aria-modal="true" aria-label="Jump to">
        <div className="jump__field">
          <Icon name="search" />
          <input
            ref={input}
            type="text"
            value={typed}
            placeholder="Jump to an aspect, a view or a table"
            aria-label="Jump to"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={chosen ? `${listId}-${shown.indexOf(chosen)}` : undefined}
            aria-autocomplete="list"
            onChange={(event) => (setTyped(event.target.value), setAt(0))}
            onKeyDown={onKeyDown}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="jump__list" id={listId} role="listbox">
          {shown.length === 0 && <li className="jump__none">Nothing called that.</li>}
          {shown.map((entry, i) => (
            <li
              key={`${entry.detail}/${entry.label}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={entry === chosen}
              className={`jump__entry${entry === chosen ? " is-chosen" : ""}`}
              onMouseEnter={() => setAt(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onGo(entry.path)}
            >
              <span className="jump__label">{entry.label}</span>
              <span className="jump__detail">{entry.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
