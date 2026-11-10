// Location in the person panel: a box that offers the locations people are
// at, the most people first, or takes a new one. Locations that differ only in
// case are one. Every change goes to the server at once, every view
// reloads, and the chip offers to undo it (changeChip.ts). Renaming one for everyone is the CLI's `location rename`.

import { useState } from "react";
import type { LocationInfo, PersonSummary } from "./archive.ts";
import { saveLocation } from "./changeChip.ts";
import { sameLocation, writtenLocation } from "./locations.ts";
import { change } from "./PersonParts.tsx";
import { useReadOnly } from "./readOnly.ts";

/** The locations offered, the most people first. */
function Suggestions({ id, values }: { id: string; values: readonly LocationInfo[] | undefined }) {
  return (
    <datalist id={id}>
      {(values ?? []).map((v) => <option key={v.name} value={v.name} />)}
    </datalist>
  );
}

/**
 * Where they are, as far as you last knew: one value, saved when the box loses focus or Enter is pressed; × clears
 * it. Read only: the value alone.
 */
export function PlaceEditor({ person, values }: { person: PersonSummary; values: readonly LocationInfo[] | undefined }) {
  const value = person.location;
  const [draft, setDraft] = useState(value ?? "");
  const readOnly = useReadOnly();
  if (readOnly) return value !== null ? <span>{value}</span> : <span className="muted">Not said</span>;
  const save = (next: string | null) => {
    if (next === value || (next !== null && value !== null && sameLocation(next, value))) return setDraft(value ?? "");
    void change(() => saveLocation(person.id, next));
  };
  const listId = `location-values-${person.id}`;
  return (
    <div className="place-editor">
      <input
        aria-label="Location"
        list={listId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => save(writtenLocation(draft) || null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(value ?? "");
        }}
      />
      {value !== null && (
        <button type="button" className="place-editor__clear" aria-label="Clear location" onClick={() => save(null)}>×</button>
      )}
      <Suggestions id={listId} values={values} />
    </div>
  );
}
