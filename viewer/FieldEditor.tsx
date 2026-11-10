// The one field editor (viewer/editWire.ts; server/edits/): a value of a row the table's owner lets be edited, drawn as
// it always is, which a click (or Enter) turns into its editor; Enter or leaving it saves, Escape puts it back. The
// drawer uses it for every field it edits, opened from the Calendar or from the table alike, so a table edits the same
// wherever it is drawn. A value the captain has corrected carries a small "edited" mark, what its source said on hovering
// it. A field this row cannot have changed (an imported call's time) is drawn as it always is, with why in its title;
// a field no table edits is never wrapped at all, so it looks as it did.
//
// Times are the archive's wall clock, in its time zone (src/time.ts, set from the page's settings), whatever the
// browser's. A note's words are content: they are read only when its editor opens, and the read is kept in the trail.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { fetchNote, fetchOptions } from "./api.ts";
import "./edit.css";
import { editValueText, type EditField, type EditOption, type EditValue, type FieldState } from "./editWire.ts";

interface Props {
  kind: string;
  rowId: string;
  field: EditField;
  state: FieldState | undefined;
  people: Record<number, string>;
  /** The value as the table draws it. */
  children: ReactNode;
  /** Saves `value`: resolves once saved, rejects with why it was not. */
  onSave: (value: EditValue) => Promise<void>;
}

/** A field's value, to be edited with a click (see the top). */
export function EditableField({ kind, rowId, field, state, people, children, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  /** A field this row keeps as it is, tapped: why, under it. */
  const [why, setWhy] = useState(false);
  if (!state) return <>{children}</>;
  if (state.locked) {
    // Hovering it says why on a wide screen; a tap says so under it, as a phone has no hover.
    return (
      <span className="edit__locked" title={`Not editable: ${state.locked}`} data-why={`Not editable: ${state.locked}`} onClick={() => setWhy(!why)}>
        {children}
        {why && <span className="edit__status edit__why">Not editable: {state.locked}</span>}
      </span>
    );
  }

  if (editing) return <OpenEditor kind={kind} rowId={rowId} field={field} state={state} people={people} onSave={onSave} onDone={() => setEditing(false)} />;
  const edited = state.original !== undefined;
  return (
    <span
      className="edit"
      role="button"
      tabIndex={0}
      title={`Edit ${field.label.toLowerCase()}${edited ? ` (edited: it was ${editValueText(field, state.original!, people)})` : ""}`}
      onClick={(event) => (event.stopPropagation(), setEditing(true))}
      onKeyDown={(event) => event.key === "Enter" && (event.stopPropagation(), setEditing(true))}
    >
      <span className="edit__value">{field.input === "note" ? (state.has ? "Has a note" : <span className="table__dim">No note</span>) : children}</span>
      {edited && (
        <span className="edit__mark" data-was={`Was ${editValueText(field, state.original!, people)}`}>
          edited
        </span>
      )}
      <span className="edit__pen" aria-hidden="true">✎</span>
    </span>
  );
}

/**
 * A field's editor, open: the drawer's once its value is clicked, and a grid cell's (VirtualTable.tsx) as it is
 * clicked. Saving says so, and why it was not saved; `onDone` once it is saved or put back.
 */
export function OpenEditor({ kind, rowId, field, state, people, onSave, onDone }: Omit<Props, "children" | "state"> & { state: FieldState; onDone: () => void }) {
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const save = (value: EditValue) => {
    setSaving(true);
    setFailed(null);
    onSave(value).then(
      () => (setSaving(false), onDone()),
      (error: Error) => (setSaving(false), setFailed(error.message)),
    );
  };
  return (
    <div className="edit edit--open">
      <Editor kind={kind} rowId={rowId} field={field} state={state} people={people} saving={saving} onSave={save} onCancel={onDone} />
      {saving && <span className="edit__status">Saving…</span>}
      {failed && <span className="edit__status edit__status--failed" role="alert">Not saved: {failed}</span>}
    </div>
  );
}

interface EditorProps {
  kind: string;
  rowId: string;
  field: EditField;
  state: FieldState;
  people: Record<number, string>;
  saving: boolean;
  onSave: (value: EditValue) => void;
  onCancel: () => void;
}

/** Escape cancels and goes no further (the drawer closes on Escape otherwise); Enter saves `value()`, but in a note with Shift. */
function keys(onSave: () => void, onCancel: () => void, multiline = false) {
  return (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && !(multiline && event.shiftKey)) {
      event.stopPropagation();
      event.preventDefault();
      onSave();
    }
  };
}

/** Saves when the focus leaves `box` for somewhere outside it (a click elsewhere), as Enter does. */
function onLeave(box: React.RefObject<HTMLElement | null>, save: () => void) {
  return (event: React.FocusEvent) => {
    if (box.current && event.relatedTarget instanceof Node && box.current.contains(event.relatedTarget)) return;
    save();
  };
}

function Editor({ kind, rowId, field, state, people, saving, onSave, onCancel }: EditorProps) {
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>(null);
  useEffect(() => first.current?.focus(), []);
  /** A number's text as typed. */
  const typed = useRef(state.value === null ? "" : String(state.value));
  /** Saves `value` once: a blur after Enter does nothing more. */
  const done = useRef(false);
  const once = (value: EditValue) => {
    if (done.current || saving) return;
    done.current = true;
    onSave(value);
  };
  useEffect(() => {
    if (!saving) done.current = false;
  }, [saving]);

  switch (field.input) {
    case "datetime": {
      const [day0, time0] = state.value === null ? ["", ""] : String(state.value).split("T");
      return <DateTimeEditor field={field} day0={day0 ?? ""} time0={time0 ?? ""} onSave={once} onCancel={onCancel} />;
    }
    case "minutes":
    case "hours":
    case "number": {
      const read = (): EditValue => {
        const text = first.current?.value ?? typed.current;
        return text.trim() === "" ? null : Number(text);
      };
      return (
        <div className="edit__box" ref={box}>
          <input
            ref={first}
            className="edit__input edit__input--number"
            type="number"
            inputMode="decimal"
            step={field.input === "minutes" ? 1 : field.input === "hours" ? 0.25 : 0.01}
            min={field.min}
            max={field.max}
            defaultValue={typed.current}
            aria-label={field.label}
            onChange={(event) => (typed.current = event.target.value)}
            onKeyDown={keys(() => once(read()), onCancel)}
            onBlur={onLeave(box, () => once(read()))}
          />
          <span className="edit__unit">{field.input === "minutes" ? "min" : field.input === "hours" ? "h" : field.unit}</span>
        </div>
      );
    }
    case "choice": {
      const now = state.value === null ? "" : String(state.value);
      const choices = [...(field.choices ?? [])];
      if (now !== "" && !choices.some((c) => c.value === now)) choices.unshift({ value: now, label: now });
      return (
        <select
          ref={first}
          className="edit__input"
          defaultValue={now}
          aria-label={field.label}
          onChange={(event) => once(event.target.value)}
          onKeyDown={keys(() => onCancel(), onCancel)}
          onBlur={() => !done.current && onCancel()}
        >
          {now === "" && <option value="">Not yet</option>}
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      );
    }
    case "people":
      return <PeopleEditor kind={kind} field={field} ids0={(state.value as number[] | null) ?? []} people={people} onSave={once} onCancel={onCancel} />;
    case "note":
      return <NoteEditor kind={kind} rowId={rowId} field={field} has={state.has ?? false} onSave={once} onCancel={onCancel} />;
    case "text": {
      const read = (): EditValue => first.current?.value ?? typed.current;
      return (
        <div className="edit__box" ref={box}>
          <TextInput
            kind={kind}
            field={field}
            inputRef={first}
            value={undefined}
            defaultValue={typed.current}
            onChange={(text) => (typed.current = text)}
            onKeyDown={keys(() => once(read()), onCancel, field.long)}
            onBlur={onLeave(box, () => once(read()))}
          />
          {field.long && <span className="edit__hint">Enter saves, Shift+Enter a new line.</span>}
        </div>
      );
    }
    case "tags":
      return <TagsEditor kind={kind} field={field} words0={(state.value as string[] | null) ?? []} onSave={once} onCancel={onCancel} />;
  }
}

/** The values a `text` or `tags` field offers (the locations in use, the tags) holding `query`, as it is typed; none for a field that offers none. */
function useOffered(kind: string, field: EditField, query: string, open: boolean): EditOption[] {
  const [options, setOptions] = useState<EditOption[]>([]);
  useEffect(() => {
    if (!field.suggests || !open) return setOptions([]);
    const abort = new AbortController();
    fetchOptions(kind, field.key, query, abort.signal).then((answer) => setOptions(answer.options), () => undefined);
    return () => abort.abort();
  }, [kind, field.key, field.suggests, query, open]);
  return options;
}

/**
 * A short text, the field editor's and Add's alike: one line, or a few for a `long` one; a field that `suggests`
 * offers the table's own values as it is typed (a datalist, so any new one is taken too).
 */
export function TextInput({ kind, field, inputRef, value, defaultValue, onChange, onKeyDown, onBlur }: {
  kind: string;
  field: EditField;
  inputRef?: React.Ref<HTMLInputElement & HTMLTextAreaElement>;
  /** Held by the form (Add), or left to the input (undefined) with `defaultValue` (the field editor). */
  value: string | undefined;
  defaultValue?: string;
  onChange: (text: string) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onBlur?: (event: React.FocusEvent) => void;
}) {
  const [query, setQuery] = useState(value ?? defaultValue ?? "");
  const [focused, setFocused] = useState(false);
  const offered = useOffered(kind, field, query, focused);
  const list = useId();
  const change = (text: string) => (setQuery(text), onChange(text));
  if (field.long) {
    return (
      <textarea
        ref={inputRef}
        className="edit__input edit__note"
        rows={3}
        value={value}
        defaultValue={value === undefined ? defaultValue : undefined}
        aria-label={field.label}
        onChange={(event) => change(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
    );
  }
  return (
    <>
      <input
        ref={inputRef}
        className="edit__input edit__input--text"
        type="text"
        value={value}
        defaultValue={value === undefined ? defaultValue : undefined}
        aria-label={field.label}
        list={field.suggests ? list : undefined}
        autoComplete="off"
        onChange={(event) => change(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={(event) => (setFocused(false), onBlur?.(event))}
      />
      {field.suggests && (
        <datalist id={list}>
          {offered.map((option) => <option key={String(option.value)} value={String(option.value)} />)}
        </datalist>
      )}
    </>
  );
}

function TagsEditor({ kind, field, words0, onSave, onCancel }: { kind: string; field: EditField; words0: string[]; onSave: (value: EditValue) => void; onCancel: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [words, setWords] = useState(words0);
  const latest = useRef(words0);
  latest.current = words;
  const save = () => onSave(latest.current);
  return (
    <div className="edit__box edit__box--people" ref={box} onBlur={onLeave(box, save)}>
      <TagsPicker kind={kind} field={field} words={words} onChange={(next) => ((latest.current = next), setWords(next))} onEnter={save} onEscape={onCancel} />
    </div>
  );
}

/**
 * Several short words in order, the tags field's editor and Add's alike: a chip for each (✕ takes it off), a box to
 * type another, and what the table offers that matches it (its tags), then what is typed as a new one; Enter puts on
 * the first of those, and with nothing typed, `onEnter`; Backspace in an empty box takes off the last; what is typed
 * goes on as it is when the focus leaves the box.
 */
export function TagsPicker({ kind, field, words, onChange, onEnter, onEscape, focus = true }: {
  kind: string;
  field: EditField;
  words: readonly string[];
  onChange: (words: string[]) => void;
  onEnter: () => void;
  onEscape: () => void;
  focus?: boolean;
}) {
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  /** The box has the focus: what it offers is listed only then (Add's form holds it among other fields). */
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (focus) search.current?.focus();
  }, []);
  const typed = query.replace(/\s+/g, " ").trim();
  const offered = useOffered(kind, field, query, focused).filter((option) => !words.includes(String(option.value)));
  // What is typed, as a new one, after what matches it, unless it is one of them (or one already on).
  const fresh = typed !== "" && !words.includes(typed) && !offered.some((option) => String(option.value).toLowerCase() === typed.toLowerCase());
  const shown = [...(typed === "" ? offered.slice(0, 8) : offered), ...(fresh ? [{ value: typed, label: `New: “${typed}”` }] : [])];
  const putOn = (word: string) => {
    const clean = word.replace(/\s+/g, " ").trim();
    if (clean !== "" && !words.includes(clean)) onChange([...words, clean]);
    setQuery("");
  };
  const put = (word: string) => {
    putOn(word);
    search.current?.focus();
  };
  return (
    <>
      <span className="edit__chips">
        {words.map((word) => (
          <span key={word} className="chip edit__chip">
            {word}
            <button type="button" className="edit__chip-off" aria-label={`Take ${word} off`} onClick={() => onChange(words.filter((other) => other !== word))}>
              ✕
            </button>
          </span>
        ))}
      </span>
      <input
        ref={search}
        className="edit__input"
        type="search"
        placeholder={field.suggests ? "Add one" : "Add one, Enter"}
        value={query}
        aria-label={`${field.label}: add one`}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          setFocused(false);
          const box = search.current?.closest(".edit__box");
          if (typed !== "" && !(box && event.relatedTarget instanceof Node && box.contains(event.relatedTarget))) putOn(String(offered.find((option) => String(option.value).toLowerCase() === typed.toLowerCase())?.value ?? typed));
        }}
        onKeyDown={(event) => {
          if (event.key === "Backspace" && query === "" && words.length > 0) {
            event.preventDefault();
            return onChange(words.slice(0, -1));
          }
          // Enter puts on the first offered (the best match, or what is typed as a new one), or with nothing typed saves.
          keys(() => (typed !== "" ? put(String(shown[0]?.value ?? typed)) : onEnter()), onEscape)(event);
        }}
      />
      {focused && shown.length > 0 && (
        <ul className="edit__options" role="listbox">
          {shown.map((option) => (
            <li key={String(option.value)}>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => put(String(option.value))}>
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function DateTimeEditor({ field, day0, time0, onSave, onCancel }: { field: EditField; day0: string; time0: string; onSave: (value: EditValue) => void; onCancel: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const day = useRef<HTMLInputElement>(null);
  const time = useRef<HTMLInputElement>(null);
  useEffect(() => day.current?.focus(), []);
  /** The date and time as the inputs hold them; null while the date is missing, or the time where the field needs one. */
  const value = (): EditValue => {
    const [d, t] = [day.current?.value ?? "", time.current?.value ?? ""];
    if (d === "" || (t === "" && !field.dateOnly)) return null;
    return t === "" ? d : `${d}T${t}`;
  };
  /** Enter saves a whole value and waits for one otherwise; leaving it saves a whole value and puts back one that is not. */
  const enter = () => {
    const given = value();
    if (given !== null) onSave(given);
  };
  const leave = () => {
    const given = value();
    if (given === null) onCancel();
    else onSave(given);
  };
  return (
    <div className="edit__box" ref={box} onBlur={onLeave(box, leave)} onKeyDown={keys(enter, onCancel)}>
      <input ref={day} className="edit__input" type="date" defaultValue={day0} aria-label={`${field.label}: date`} />
      <input ref={time} className="edit__input" type="time" defaultValue={time0} aria-label={`${field.label}: time${field.dateOnly ? " (if known)" : ""}`} />
    </div>
  );
}

function PeopleEditor({ kind, field, ids0, people, onSave, onCancel }: { kind: string; field: EditField; ids0: number[]; people: Record<number, string>; onSave: (value: EditValue) => void; onCancel: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [ids, setIds] = useState(ids0);
  const [names, setNames] = useState(people);
  const save = () => onSave(ids);
  return (
    <div className="edit__box edit__box--people" ref={box} onBlur={onLeave(box, save)}>
      <PeoplePicker kind={kind} field={field} ids={ids} names={names} onChange={(next, named) => (setIds(next), setNames({ ...names, ...named }))} onEnter={save} onEscape={onCancel} />
    </div>
  );
}

/**
 * People chosen by name, the people field's editor and Add's alike: a chip for each (✕ takes them off), a search box,
 * and whom it matches (the table's options); Enter takes the first match, or with none, `onEnter`.
 */
export function PeoplePicker({ kind, field, ids, names, onChange, onEnter, onEscape, focus = true }: {
  kind: string;
  field: EditField;
  ids: readonly number[];
  names: Readonly<Record<number, string>>;
  /** The people now, with the name of anyone just put on. */
  onChange: (ids: number[], named: Record<number, string>) => void;
  onEnter: () => void;
  onEscape: () => void;
  focus?: boolean;
}) {
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Array<{ value: number; label: string }>>([]);
  useEffect(() => {
    if (focus) search.current?.focus();
  }, []);
  useEffect(() => {
    if (query.trim() === "") return setOptions([]);
    const abort = new AbortController();
    fetchOptions(kind, field.key, query, abort.signal).then((answer) => setOptions(answer.options.flatMap((o) => (typeof o.value === "number" && !ids.includes(o.value) ? [{ value: o.value, label: o.label }] : []))), () => undefined);
    return () => abort.abort();
  }, [kind, field.key, query, ids]);
  const add = (option: { value: number; label: string }) => {
    onChange([...ids, option.value], { [option.value]: option.label });
    setQuery("");
    search.current?.focus();
  };
  return (
    <>
      <span className="edit__chips">
        {ids.map((id) => (
          <span key={id} className="chip chip--person edit__chip">
            {names[id] ?? `Person ${id}`}
            <button type="button" className="edit__chip-off" aria-label={`Take ${names[id] ?? "them"} off`} onClick={() => onChange(ids.filter((other) => other !== id), {})}>
              ✕
            </button>
          </span>
        ))}
      </span>
      <input
        ref={search}
        className="edit__input"
        type="search"
        placeholder="Add someone"
        value={query}
        aria-label={`${field.label}: add someone`}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={keys(() => (options[0] && query.trim() !== "" ? add(options[0]) : onEnter()), onEscape)}
      />
      {options.length > 0 && (
        <ul className="edit__options" role="listbox">
          {options.map((option) => (
            <li key={option.value}>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => add(option)}>
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function NoteEditor({ kind, rowId, field, has, onSave, onCancel }: { kind: string; rowId: string; field: EditField; has: boolean; onSave: (value: EditValue) => void; onCancel: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState<string | null>(has ? null : "");
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!has) return;
    fetchNote(kind, rowId, field.key).then((answer) => setText(answer.note), (error: Error) => setFailed(error.message));
  }, [kind, rowId, field.key, has]);
  useEffect(() => {
    if (text !== null) area.current?.focus();
  }, [text === null]);
  if (failed) return <span className="edit__status edit__status--failed">Could not read it: {failed}</span>;
  if (text === null) return <span className="table__dim">Reading…</span>;
  const save = () => onSave(area.current?.value ?? text);
  return (
    <div className="edit__box edit__box--note" ref={box}>
      <textarea ref={area} className="edit__input edit__note" defaultValue={text} rows={3} aria-label={field.label} onKeyDown={keys(save, onCancel, true)} onBlur={onLeave(box, save)} />
      <span className="edit__hint">Enter saves, Shift+Enter a new line. Reading it is kept in the trail of content reads.</span>
    </div>
  );
}
