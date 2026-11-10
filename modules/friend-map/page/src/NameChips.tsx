// The person panel's names: a view first, with small edits. Their round identicon (which opens its picker,
// IconPicker.tsx) spans two rows beside the "Names +" label, one button that turns into a borderless "add new name"
// box in its place (Enter adds the name last), and below the label a chip for each name they go by, in order
// (nameChips.ts). The first chip is their name, which labels them everywhere, drawn bolder.
//
// A chip drags to another place, by mouse or by touch (dropping one first makes it their name); with the keyboard,
// Alt with an arrow key moves the chip in focus, and the arrows alone go from chip to chip. Pointing at a chip, or
// focusing it, shows its × to remove it, except on the last name left: nobody is without a name. A click or tap (one
// that does not drag) or Enter writes it again in place (Enter or leaving saves, Esc or leaving it empty puts it back).
// Each change is saved as one changeset, whose chip offers Undo (changeChip.ts's saveNames).
//
// While names are hidden (No name except…) the chips show neutral shapes but for those picked, and nothing can be
// changed (choose another Name format to); on a read-only page they are the names alone, as the page labels them (First L.
// in the demo). The map's own choices (First name, First L.) leave them in full, as they are kept.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { PersonSummary } from "./archive.ts";
import { saveNames } from "./changeChip.ts";
import { IconPicker } from "./IconPicker.tsx";
import { addName, draftResult, dropIndex, moveName, namesOf, removeName, renameName, type DraftEnd } from "./nameChips.ts";
import { useNames } from "./names.ts";
import { change, Name } from "./PersonParts.tsx";
import { useReadOnly } from "./readOnly.ts";

/** How far a pointer moves on a chip before it is a drag, not a click. */
const DRAG_PX = 5;

/** A press on a chip that may become a drag: which chip, where it began, and once dragging, where it is now. */
interface Press {
  index: number;
  pointerId: number;
  x: number;
  y: number;
  dragging: boolean;
  /** Where it would go among the others, while dragging. */
  to: number;
  /** How far the chip has moved, while dragging. */
  dx: number;
  dy: number;
}

export function NamesField({ person }: { person: PersonSummary }) {
  const names = useNames();
  const readOnly = useReadOnly();
  const editable = !readOnly && !names.hidden;
  const stored = namesOf(person);
  // The names as last changed here, shown while they are saved so a dropped chip stays where it was dropped.
  const [pending, setPending] = useState<readonly string[] | null>(null);
  const storedKey = JSON.stringify(stored);
  useEffect(() => setPending(null), [person.id, storedKey]);
  const list = pending ?? stored;

  const save = async (next: readonly string[]) => {
    if (next === list) return;
    setPending(next);
    const saved = await change(() => saveNames(person.id, list, next));
    if (saved === undefined) setPending(null);
  };

  return (
    <div className="field names-field person-name">
      <IconPicker person={person} />
      <span className="person-name__names">
        <span className="field__head field__head--name">
          {editable ? <AddName onAdd={(text) => void save(addName(list, text))} /> : <span>Names</span>}
        </span>
        {editable ? (
          <NameChips key={person.id} names={list} onChange={(next) => void save(next)} />
        ) : (
          <span className="name-chips" role="list" aria-label="Names" title={names.hidden ? "Names are hidden; choose another Name format in the menu to change them" : undefined}>
            {list.map((name, i) => (
              <span key={name} role="listitem" className={i === 0 ? "name-chip name-chip--first" : "name-chip"}>
                <Name text={i === 0 ? names.label(person).primary : names.shown(name)} />
              </span>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

/** The "Names +" label, one button (only its + green), which turns into a borderless "add new name" box in its place.
 *  Enter, or leaving it with something typed, adds the name and puts the label back; Esc, or leaving it empty, puts it
 *  back with nothing added. */
function AddName({ onAdd }: { onAdd: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  // Back to the label once the box closes, keeping the keyboard where it was (not when it closed by leaving it).
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!open && refocus.current) opener.current?.focus();
    refocus.current = false;
  }, [open]);
  // Ended once: a blur as the box goes after Enter or Esc does nothing more.
  const ended = useRef(false);
  const end = (how: DraftEnd) => {
    if (ended.current) return;
    ended.current = true;
    const text = draftResult(draft, how);
    if (text !== null) onAdd(text);
    refocus.current = how !== "leave";
    setDraft("");
    setOpen(false);
  };
  if (!open)
    return (
      <button
        ref={opener}
        type="button"
        className="add-name-open"
        // The words shown first (Names), so a spoken "Names" finds it too.
        aria-label="Names: add a name"
        title="Add a name"
        onClick={() => {
          ended.current = false;
          setOpen(true);
        }}
      >
        Names<span className="add-name-open__plus" aria-hidden="true">+</span>
      </button>
    );
  return (
    <input
      className="add-name"
      aria-label="Add a name"
      placeholder="add new name"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => end("leave")}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          end("enter");
        }
        if (e.key === "Escape") {
          // The box's, not the panel's: Esc closes it.
          e.stopPropagation();
          end("escape");
        }
      }}
    />
  );
}

/** The chips, editable: drag or Alt+arrow to reorder, × to remove, click, tap or Enter to write again. */
function NameChips({ names, onChange }: { names: readonly string[]; onChange: (next: readonly string[]) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [press, setPress] = useState<Press | null>(null);
  const chips = useRef<(HTMLSpanElement | null)[]>([]);
  // The name to focus once a change moves or rewrites its chip (by keyboard), once: a new object each time, so the
  // same name again (Esc on a chip) is focused again, and dropped once focused, so a later change leaves focus be.
  const [focusTo, setFocusTo] = useState<{ name: string } | null>(null);
  const setFocusName = (name: string | null) => setFocusTo(name === null ? null : { name });
  useLayoutEffect(() => {
    if (focusTo === null) return;
    const at = names.indexOf(focusTo.name);
    if (at < 0) return;
    chips.current[at]?.focus();
    setFocusTo(null);
  }, [names, focusTo]);

  const last = names.length === 1;
  const edit = (index: number) => {
    setPress(null);
    setEditing(index);
  };
  const move = (index: number, to: number) => {
    setFocusName(names[index]);
    onChange(moveName(names, index, to));
  };

  const pointerDown = (e: ReactPointerEvent<HTMLSpanElement>, index: number) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    setPress({ index, pointerId: e.pointerId, x: e.clientX, y: e.clientY, dragging: false, to: index, dx: 0, dy: 0 });
  };
  const pointerMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!press || e.pointerId !== press.pointerId) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!press.dragging && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!press.dragging) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // The pointer is gone already (lifted as it moved): the drag ends on its pointerup or pointercancel.
      }
    }
    const others = chips.current
      .filter((chip, i): chip is HTMLSpanElement => chip !== null && i !== press.index && i < names.length)
      .map((chip) => chip.getBoundingClientRect());
    setPress({ ...press, dragging: true, dx, dy, to: dropIndex(others, e.clientX, e.clientY) });
  };
  const pointerUp = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!press || e.pointerId !== press.pointerId) return;
    setPress(null);
    // A drag drops the chip; a click or tap that did not move writes it again.
    if (press.dragging) onChange(moveName(names, press.index, press.to));
    else setEditing(press.index);
  };
  const pointerCancel = () => setPress(null);

  const keyDown = (e: KeyboardEvent<HTMLSpanElement>, index: number) => {
    if (e.target !== e.currentTarget) return;
    const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
    const on = e.key === "ArrowRight" || e.key === "ArrowDown";
    if ((back || on) && e.altKey) {
      e.preventDefault();
      if (back ? index > 0 : index < names.length - 1) move(index, index + (back ? -1 : 1));
    } else if (back || on) {
      e.preventDefault();
      chips.current[index + (back ? -1 : 1)]?.focus();
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      edit(index);
    } else if ((e.key === "Delete" || e.key === "Backspace") && !last) {
      e.preventDefault();
      setFocusName(names[index + 1] ?? names[index - 1] ?? null);
      onChange(removeName(names, index));
    }
  };

  // Where a dragged chip would land is marked on the chip it would go before (or after, at the end).
  const target = press?.dragging ? press.to : null;
  const others = press ? names.filter((_, i) => i !== press.index) : names;
  const markBefore = target !== null && target < others.length ? others[target] : null;
  const markAfter = target !== null && target >= others.length ? others.at(-1) ?? null : null;

  return (
    <span className="name-chips" role="list" aria-label="Names: the first is their name; Alt with an arrow key moves one">
      {names.map((name, i) => {
        if (editing === i) {
          return (
            <ChipEditor
              key={name}
              name={name}
              onDone={(text) => {
                setEditing(null);
                if (text !== null) {
                  const next = renameName(names, i, text);
                  setFocusName(next[i] ?? null);
                  onChange(next);
                } else {
                  setFocusName(name);
                }
              }}
            />
          );
        }
        const dragged = press?.dragging && press.index === i;
        const className = [
          "name-chip",
          i === 0 && "name-chip--first",
          dragged && "name-chip--dragged",
          name === markBefore && "name-chip--drop-before",
          name === markAfter && "name-chip--drop-after",
        ].filter(Boolean).join(" ");
        return (
          <span
            key={name}
            ref={(chip) => {
              chips.current[i] = chip;
            }}
            role="listitem"
            aria-label={i === 0 ? `${name}, their name` : name}
            tabIndex={0}
            className={className}
            style={dragged ? { transform: `translate(${press.dx}px, ${press.dy}px)` } : undefined}
            title={`${i === 0 ? "Their name, which labels them. " : ""}Click to change; drag to reorder (or Alt with an arrow key)`}
            onPointerDown={(e) => pointerDown(e, i)}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerCancel}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => keyDown(e, i)}
          >
            {name}
            {!last && (
              <button
                type="button"
                className="name-chip__remove"
                aria-label={`Remove the name ${name}`}
                title="Remove this name"
                onClick={() => {
                  setFocusName(null);
                  onChange(removeName(names, i));
                }}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
    </span>
  );
}

/** A chip written again in place: Enter or leaving it gives the text, Esc or nothing typed gives null (no change). */
function ChipEditor({ name, onDone }: { name: string; onDone: (text: string | null) => void }) {
  const [draft, setDraft] = useState(name);
  const done = useRef(false);
  const finish = (how: DraftEnd) => {
    if (done.current) return;
    done.current = true;
    onDone(draftResult(draft, how));
  };
  return (
    <input
      className="name-chip name-chip__edit"
      aria-label={`Change the name ${name}`}
      autoFocus
      size={Math.max(4, draft.length + 1)}
      value={draft}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish("leave")}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish("enter");
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          finish("escape");
        }
      }}
    />
  );
}
