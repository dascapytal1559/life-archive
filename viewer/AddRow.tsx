// Add, for a table whose rows are partly the captain's own records (KindSpec's `own`: friend map's Hangouts and Calls),
// the captain's "add and delete rows ... for his own records only": a drawer for a row not yet made, in the drawer's
// place and look, asking each field the table's owner says Add asks (OwnRows's `add`), with the same controls the field
// editor has (FieldEditor.tsx's PeoplePicker among them). Add writes it through the one edit route (server/edits/), so it
// is in the record and undone as any edit is; the table then reads its rows again and opens the new one's drawer.
// Escape or ✕ closes it, keeping nothing. A time is the archive's wall clock, today's date to start with (the day's,
// opened from a day of the Events calendar) and, where the field needs a time of day, the time now, whatever the
// browser's zone.

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, postAdd } from "./api.ts";
import "./add.css";
import { PeoplePicker, TagsPicker, TextInput } from "./FieldEditor.tsx";
import type { EditDone, EditField, EditValue } from "./editWire.ts";
import { dayKey, timeOfDay } from "../src/time.ts";
import type { KindSpec } from "./wire.ts";

/** A field of the form as typed: text for most, people by id for a people field, words for a tags field. */
type Typed = string | number[] | string[];

/**
 * What each field starts as: `day` (today unless given: the Calendar's day an Add was opened on), with the time now
 * where a time is needed, the first choice, nobody, and empty.
 */
export function startValues(fields: readonly EditField[], now = Date.now(), day = dayKey(now)): Record<string, Typed> {
  return Object.fromEntries(fields.map((field) => {
    switch (field.input) {
      case "datetime":
        return [field.key, field.dateOnly ? day : `${day}T${timeOfDay(now)}`];
      case "choice":
        return [field.key, field.choices?.[0]?.value ?? ""];
      case "people":
      case "tags":
        return [field.key, []];
      default:
        return [field.key, ""];
    }
  }));
}

/** The form's values as the route takes them: a number typed as a number, anything left empty as null (the server says what cannot be). */
export function addValues(fields: readonly EditField[], typed: Readonly<Record<string, Typed>>): Record<string, EditValue> {
  return Object.fromEntries(fields.map((field): [string, EditValue] => {
    const value = typed[field.key];
    if (Array.isArray(value)) return [field.key, value.length === 0 ? null : (value as number[] | string[])];
    const text = (value ?? "").trim();
    if (text === "") return [field.key, null];
    return [field.key, field.input === "minutes" || field.input === "hours" || field.input === "number" ? Number(text) : text];
  }));
}

/** "Add hangout": the table's own word for one row. */
export const addTitle = (spec: Pick<KindSpec, "noun">): string => `Add ${spec.noun[0]}`;

interface Props {
  spec: KindSpec;
  /** The date its time starts on (YYYY-MM-DD), the Calendar's day; today when left out. */
  day?: string;
  onClose: () => void;
  /** Once it is added: what the route answered (the new row's id, and its number in the record). */
  onAdded: (done: EditDone) => void;
}

export function AddRow({ spec, day, onClose, onAdded }: Props) {
  const fields = spec.own?.add ?? [];
  const [typed, setTyped] = useState(() => startValues(fields, Date.now(), day));
  const [names, setNames] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /** The owner would have him be sure (409: someone already goes by the name), so Add anyway is offered. */
  const [unsure, setUnsure] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  const set = (key: string, value: Typed) => (setTyped((was) => ({ ...was, [key]: value })), setUnsure(false));
  const submit = (event?: FormEvent, anyway = false) => {
    event?.preventDefault();
    if (saving) return;
    setSaving(true);
    setFailed(null);
    postAdd(spec.kind, addValues(fields, typed), anyway).then(
      (done) => (setSaving(false), onAdded(done)),
      (error: Error) => (setSaving(false), setFailed(error.message), setUnsure(error instanceof ApiError && error.status === 409)),
    );
  };
  const title = addTitle(spec);

  return (
    <aside className="drawer add" aria-label={title}>
      <header className="drawer__header">
        <h2>{title}</h2>
        <button type="button" className="drawer__close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      {/* The server says what a field takes (its bounds, a time a call needs), so the browser's own checks stay out of the way. */}
      <form ref={form} className="drawer__body add__form" onSubmit={submit} noValidate>
        <dl className="drawer__fields">
          {fields.map((field) => (
            <Field key={field.key} label={field.label}>
              <Input kind={spec.kind} field={field} value={typed[field.key] ?? ""} names={names} onNames={(named) => setNames({ ...names, ...named })} onChange={(value) => set(field.key, value)} onEnter={submit} onEscape={onClose} />
            </Field>
          ))}
        </dl>
        {failed && (
          <p className="drawer__saved drawer__saved--failed" role="alert">
            Not added: {failed}
          </p>
        )}
        <div className="add__actions">
          <button type="submit" className="add__go" disabled={saving}>
            {saving ? "Adding…" : title}
          </button>
          {unsure && (
            <button type="button" className="add__go add__anyway" disabled={saving} onClick={() => submit(undefined, true)}>
              Add anyway
            </button>
          )}
          <button type="button" className="drawer__undo add__cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
        <p className="drawer__note add__hint">It goes in the record of edits, and Undo takes it away again.</p>
      </form>
    </aside>
  );
}

/** One field's control, as the field editor has it, held by the form until Add. */
function Input({ kind, field, value, names, onNames, onChange, onEnter, onEscape }: {
  kind: string;
  field: EditField;
  value: Typed;
  names: Record<number, string>;
  onNames: (named: Record<number, string>) => void;
  onChange: (value: Typed) => void;
  onEnter: () => void;
  onEscape: () => void;
}) {
  const text = typeof value === "string" ? value : "";
  switch (field.input) {
    case "datetime": {
      const [day = "", time = ""] = text.split("T");
      const join = (d: string, t: string) => (t === "" ? d : `${d}T${t}`);
      return (
        <span className="edit__box">
          <input className="edit__input" type="date" value={day} aria-label={`${field.label}: date`} onChange={(event) => onChange(join(event.target.value, time))} />
          <input className="edit__input" type="time" value={time} aria-label={`${field.label}: time${field.dateOnly ? " (if known)" : ""}`} onChange={(event) => onChange(join(day, event.target.value))} />
        </span>
      );
    }
    case "minutes":
    case "hours":
    case "number":
      return (
        <span className="edit__box">
          <input
            className="edit__input edit__input--number"
            type="number"
            inputMode="decimal"
            step="any"
            value={text}
            aria-label={field.label}
            onChange={(event) => onChange(event.target.value)}
          />
          <span className="edit__unit">{field.input === "minutes" ? "min" : field.input === "hours" ? "h" : field.unit}</span>
        </span>
      );
    case "choice":
      return (
        <select className="edit__input" value={text} aria-label={field.label} onChange={(event) => onChange(event.target.value)}>
          {(field.choices ?? []).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      );
    case "people":
      return (
        <span className="edit__box edit__box--people">
          <PeoplePicker
            kind={kind}
            field={field}
            ids={Array.isArray(value) ? (value as number[]) : []}
            names={names}
            focus={false}
            onChange={(ids, named) => (onNames(named), onChange(ids))}
            onEnter={onEnter}
            onEscape={onEscape}
          />
        </span>
      );
    case "note":
      return <textarea className="edit__input edit__note" rows={3} value={text} aria-label={field.label} onChange={(event) => onChange(event.target.value)} />;
    case "text":
      return <TextInput kind={kind} field={field} value={text} onChange={onChange} />;
    case "tags":
      return (
        <span className="edit__box edit__box--people">
          <TagsPicker kind={kind} field={field} words={Array.isArray(value) ? (value as string[]) : []} focus={false} onChange={onChange} onEnter={onEnter} onEscape={onEscape} />
        </span>
      );
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="drawer__field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
