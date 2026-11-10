// The person panel's identicon, which opens a small picker when clicked: a
// place to draft them a new one (iconDraft.ts); the one they have stays in
// view in the panel beside it. Colour and picture change apart: a row of
// colours and a hue slider recolour the draft, keeping its picture; beside the
// draft, New picture keeps its colour and New colour keeps its picture.
// Nothing is saved while drafting: Save saves the draft as one change, with the chip's Undo and in the change log (changeChip.ts's
// saveIdenticon), and closes the picker. ×, Esc or a click elsewhere closes it
// without saving. On a read-only page the identicon is only a picture.

import { useEffect, useRef, useState } from "react";
import type { PersonSummary } from "./archive.ts";
import { drafted, draftHue, newColour, newPicture, recolour, saveDraft, startDraft, type IconDraft } from "./iconDraft.ts";
import { pickedColour } from "./identicon.ts";
import { Identicon } from "./Identicon.tsx";
import { change } from "./PersonParts.tsx";
import { useReadOnly } from "./readOnly.ts";

/** The picker's colours: twelve hues a twelfth of the way round from each other, starting at a warm red. */
export const SWATCH_HUES = Array.from({ length: 12 }, (_, i) => 15 + 30 * i);

/** The slider's track: the colours a picked hue gives all the way round. */
const TRACK = `linear-gradient(to right, ${Array.from({ length: 13 }, (_, i) => pickedColour((30 * i) % 360)).join(", ")})`;

/** How big the draft is drawn. */
const DRAFT_SIZE = 64;

export function IconPicker({ person, size = 32 }: { person: PersonSummary; size?: number }) {
  const readOnly = useReadOnly();
  // The draft while the picker is open; null while it is closed.
  const [draft, setDraft] = useState<IconDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const open = draft !== null;
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setDraft(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  // Someone else opened in the panel: the draft was this one's.
  useEffect(() => setDraft(null), [person.id]);

  if (readOnly) return <Identicon seed={person.identiconSeed} hue={person.identiconHue} size={size} className="identicon--round" />;
  const done = draft && drafted(person, draft);
  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    const saved = await change(() => saveDraft(person, draft));
    setSaving(false);
    if (saved !== undefined) setDraft(null);
  };
  return (
    <span
      className="icon-picker"
      ref={box}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        // The picker's, not the panel's: Esc closes only the picker.
        e.stopPropagation();
        setDraft(null);
      }}
    >
      <button
        type="button"
        className="icon-picker__open"
        aria-label="Change their icon"
        aria-expanded={open}
        title="Change their icon"
        onClick={() => setDraft(open ? null : startDraft(person))}
      >
        <Identicon seed={person.identiconSeed} hue={person.identiconHue} size={size} className="identicon--round" />
      </button>
      {draft && (
        <span className="icon-picker__box" role="dialog" aria-label="Their icon">
          <button type="button" className="icon-picker__close" aria-label="Close without saving" title="Close without saving" onClick={() => setDraft(null)}>
            ×
          </button>
          <span className="icon-picker__draft">
            <Identicon seed={draft.seed} hue={draft.hue} size={DRAFT_SIZE} className="identicon--round" />
            <span className="icon-picker__rerolls">
              <button type="button" className="icon-picker__reroll" title="New picture in this colour" disabled={saving} onClick={() => setDraft(newPicture(draft))}>
                <span aria-hidden="true">↻</span> New picture
              </button>
              <button type="button" className="icon-picker__reroll" title="New colour for this picture" disabled={saving} onClick={() => setDraft(newColour(draft))}>
                <span aria-hidden="true">◐</span> New colour
              </button>
            </span>
          </span>
          <span className="icon-picker__swatches">
            {SWATCH_HUES.map((h) => (
              <button
                key={h}
                type="button"
                className={h === draft.hue ? "icon-picker__swatch icon-picker__swatch--on" : "icon-picker__swatch"}
                style={{ background: pickedColour(h) }}
                aria-label={`Colour ${h}°`}
                aria-pressed={h === draft.hue}
                disabled={saving}
                onClick={() => setDraft(recolour(draft, h))}
              />
            ))}
          </span>
          <input
            type="range"
            className="icon-picker__hue"
            aria-label="Hue"
            min={0}
            max={359}
            value={draftHue(draft)}
            style={{ background: TRACK }}
            disabled={saving}
            onChange={(e) => {
              const hue = Number(e.target.value);
              setDraft((now) => now && recolour(now, hue));
            }}
          />
          <button type="button" className="button button--primary icon-picker__save" disabled={!done || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </span>
      )}
    </span>
  );
}
