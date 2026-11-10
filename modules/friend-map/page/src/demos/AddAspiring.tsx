// "Add an aspiring friend" on Orbits and the Spider web, folded away in the menu at the top left: someone you would
// like to know (src/aspiring.ts), with a name and what you would say to them; their tag is given for you. Enter or Add
// adds them as one changeset (POST /api/archive/people), edited by hand, so the archive rules never archive them for
// having no messages; the chip offers Undo, and their panel opens. When someone already goes by that name or an alias
// (but for case), nobody is added yet: the form names them, each to open instead, or adds a second anyway. Not there in
// demo mode (read-only). Adding someone you know offline is the life archive's: Add person in Events' People table,
// where Friend Map's own Table folded on 10 November 2026.

import { type FormEvent, useId, useState } from "react";
import { type NewPerson, type SameNamed } from "../archive.ts";
import { ASPIRING_TAG } from "../aspiring.ts";
import { addPerson } from "../changeChip.ts";
import { useNames } from "../names.ts";
import { change, Name } from "../PersonParts.tsx";

/** What the form sends: the name, the aspiring tag, and what you would say to them when given. */
export function aspiringFriend(form: { name: string; note: string }, anyway: boolean): NewPerson {
  return {
    name: form.name,
    tags: [ASPIRING_TAG],
    ...(form.note.trim() && { note: form.note }),
    ...(anyway && { anyway }),
  };
}

const EMPTY = { name: "", note: "" };

/** The form: `onOpen` opens someone's panel (the person just added, or one already there picked instead), and `onClose` puts it away. */
function AspiringForm({ onOpen, onClose }: { onOpen: (person: number) => void; onClose: () => void }) {
  const names = useNames();
  const [form, setForm] = useState(EMPTY);
  const [sameName, setSameName] = useState<SameNamed[] | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (part: keyof typeof EMPTY) => (event: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [part]: event.target.value }));
    if (part === "name") setSameName(null);
  };

  const add = async (anyway: boolean) => {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    const done = await change(() => addPerson(aspiringFriend(form, anyway)));
    setSaving(false);
    if (!done) return;
    if (done.person) {
      onClose();
      onOpen(done.person.id);
    } else setSameName(done.sameName);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void add(false);
  };

  return (
    <form className="add-person__form" onSubmit={submit}>
      <label>
        <span>Name</span>
        <input autoFocus required value={form.name} onChange={set("name")} placeholder="Their name" />
      </label>
      <label>
        <span>What you would say to them</span>
        <textarea rows={2} value={form.note} onChange={set("note")} />
      </label>
      {sameName ? (
        <div className="tag-manager__confirm add-person__same" role="alert">
          <p>{sameName.length === 1 ? "Someone already goes by this name:" : "These people already go by this name:"}</p>
          {sameName.map((person) => (
            <button key={person.id} type="button" className="tag-manager__button" onClick={() => { onClose(); onOpen(person.id); }}>
              Open <Name text={names.label(person).primary} />
            </button>
          ))}
          <button type="button" className="tag-manager__button" disabled={saving} onClick={() => void add(true)}>Add anyway</button>
        </div>
      ) : (
        <div className="add-person__actions">
          <button type="button" className="tag-manager__button" onClick={onClose}>Cancel</button>
          <button type="submit" className="tag-manager__button add-person__add" disabled={!form.name.trim() || saving}>Add</button>
        </div>
      )}
    </form>
  );
}

/** "Add an aspiring friend", a section of the menu at the top left, folded until opened. `onOpen` opens someone's panel. */
export function AddAspiring({ onOpen }: { onOpen: (person: number) => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="view-switcher__settings" aria-label="Add an aspiring friend">
      <button
        type="button"
        className="view-switcher__group view-switcher__fold"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title="Someone you would like to know: they sit far out at the edge of the map, with a note for what you would say to them"
        onClick={() => setOpen(!open)}
      >
        <span className="view-switcher__caret" aria-hidden />
        Add an aspiring friend
      </button>
      {open && <div className="add-aspiring" id={id}><AspiringForm onOpen={onOpen} onClose={() => setOpen(false)} /></div>}
    </section>
  );
}
