// The change log: "Changes" in the live map views' header (the Table's, until it folded into Events' Tables) opens a panel listing the
// recent changesets (GET /api/archive/changes), newest first: every edit to
// people, from the app or the CLI (an agent's, with the user's words), with
// when, where from, what, and who it touched (click a name to open them).
// "Details" shows each person's before and after; "Undo", after a confirm,
// puts back exactly what it changed, or says who has changed since. It reloads
// whenever people change, from anywhere. It follows the name choice (changesList.ts).

import { useEffect, useRef, useState } from "react";
import { archiveApi } from "../archiveApi.ts";
import { useNames } from "../names.ts";
import { change, Name } from "../PersonParts.tsx";
import { useArchive } from "../useArchive.ts";
import { changeEntry, changeLine, personName, type ChangeEntry } from "./changesList.ts";

/** How many changesets the panel lists. */
const LISTED = 40;

export function ChangesPanel({ onOpen }: { onOpen: (person: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
        className="demos__method"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="What was changed about people, here or from the CLI, with Undo"
        onClick={() => setOpen((o) => !o)}
      >
        Changes
      </button>
      {open && <ChangesList onOpen={onOpen} />}
    </div>
  );
}

function ChangesList({ onOpen }: { onOpen: (person: number) => void }) {
  const changes = useArchive(() => archiveApi.changes(LISTED), []);
  const [details, setDetails] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const names = useNames();
  const entries = changes.data?.map((c) => changeEntry(c, names));

  return (
    <div className="tag-filter__panel changes-panel" role="dialog" aria-label="Changes">
      {!entries ? (
        <p className="changes-panel__status">{changes.unavailable ? "The archive is not running." : (changes.error ?? "Loading…")}</p>
      ) : entries.length === 0 ? (
        <p className="changes-panel__status">No changes yet. Every edit to people, here or from the CLI, is listed here, kept 90 days.</p>
      ) : (
        <ol className="changes-panel__list">
          {entries.map((entry) => (
            <ChangeItem
              key={entry.id}
              entry={entry}
              details={details === entry.id}
              confirming={confirm === entry.id}
              onOpen={onOpen}
              onDetails={() => setDetails((d) => (d === entry.id ? null : entry.id))}
              onUndo={() => setConfirm(entry.id)}
              onConfirm={() => {
                setConfirm(null);
                void change(() => archiveApi.undoChange(entry.id));
              }}
              onCancel={() => setConfirm(null)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

export function ChangeItem({ entry, details, confirming, onOpen, ...on }: {
  entry: ChangeEntry;
  details: boolean;
  confirming: boolean;
  onOpen: (person: number) => void;
  onDetails: () => void;
  onUndo: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const touched = entry.people.length + entry.more;
  return (
    <li className={`changes-panel__item${entry.canUndo ? "" : " changes-panel__item--undone"}`}>
      <div className="changes-panel__head">
        <span className="changes-panel__action">{entry.action}</span>
        {entry.canUndo && !confirming && (
          <button type="button" className="tag-manager__button" title="Put back what it changed" onClick={on.onUndo}>Undo</button>
        )}
      </div>
      <div className="changes-panel__meta">{entry.meta}{entry.state && <> · {entry.state}</>}</div>
      {entry.words && <q className="changes-panel__words">{entry.words}</q>}
      {entry.people.length > 0 && (
        <div className="changes-panel__people">
          {entry.people.map((person, i) => (
            <span key={person.id}>
              {i > 0 && ", "}
              <button type="button" className="changes-panel__person" onClick={() => onOpen(person.id)}><Name text={person.name} /></button>
            </span>
          ))}
          {entry.more > 0 && <> and {entry.more} more</>}
        </div>
      )}
      {entry.other.map((line) => <div key={line} className="changes-panel__other">{line}</div>)}
      {touched > 0 && (
        <button type="button" className="changes-panel__toggle" aria-expanded={details} onClick={on.onDetails}>
          {details ? "Hide details" : "Details"}
        </button>
      )}
      {details && <ChangeDetails id={entry.id} onOpen={onOpen} />}
      {confirming && (
        <div className="tag-manager__confirm" role="alertdialog" aria-label="Undo?">
          <p>
            Undo #{entry.id}? It puts back what it changed{touched > 0 ? ` for ${touched} ${touched === 1 ? "person" : "people"}` : ""}, and is
            refused, naming who, if any of it has changed since.
          </p>
          <button type="button" className="tag-manager__button tag-manager__button--danger" autoFocus onClick={on.onConfirm}>Undo</button>
          <button type="button" className="tag-manager__button" onClick={on.onCancel}>Cancel</button>
        </div>
      )}
    </li>
  );
}

/** Everyone a changeset touched, each with what changed, before and after. */
function ChangeDetails({ id, onOpen }: { id: number; onOpen: (person: number) => void }) {
  const full = useArchive(() => archiveApi.changeset(id), [id]);
  const names = useNames();
  if (!full.data) return <p className="changes-panel__status">{full.error ?? "Loading…"}</p>;
  return (
    <ul className="changes-panel__details">
      {full.data.people.map((person) => (
        <li key={person.id}>
          <button type="button" className="changes-panel__person" onClick={() => onOpen(person.id)}>
            <Name text={personName(person, names)} />
          </button>
          {person.changes.map((line) => <div key={line.what} className="changes-panel__line">{changeLine(line, names)}</div>)}
        </li>
      ))}
    </ul>
  );
}
