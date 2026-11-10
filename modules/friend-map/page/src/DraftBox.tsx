// The draft box at the foot of a person's panel, where the Send box was
// (sending is off for now: server/archive/send.ts): the message you
// are writing to them, yours to rework as often as you like. It saves as you type
// (drafts.ts) and is there again when the panel opens; it makes no changeset.
// Someone has one box, or one per draft when a merge gave them several. Hidden
// with names, as notes are (a draft can say who they are); on a read-only page
// it only shows a draft there is.

import { useEffect, useRef, useState } from "react";
import type { Draft } from "./archive.ts";
import { archiveApi } from "./archiveApi.ts";
import { DraftSaver, type DraftState } from "./drafts.ts";
import { useNames } from "./names.ts";
import { useReadOnly } from "./readOnly.ts";
import { useArchive } from "./useArchive.ts";

export function DraftBox({ personId }: { personId: number }) {
  // Loaded when the panel opens, and not again while it is open: the box holds what you are typing.
  const drafts = useArchive(() => archiveApi.drafts(personId), [personId], { follow: false });
  const readOnly = useReadOnly();
  if (!drafts.data) return null;
  if (readOnly && drafts.data.length === 0) return null;
  const shown: Array<Draft | null> = drafts.data.length > 0 ? drafts.data : [null];
  return (
    <>
      {shown.map((draft, i) => (
        <DraftEditor key={draft?.id ?? "new"} personId={personId} draft={draft} label={shown.length > 1 ? `Draft ${i + 1}` : "Draft"} />
      ))}
    </>
  );
}

export function DraftEditor({ personId, draft, label }: { personId: number; draft: Draft | null; label: string }) {
  const [text, setText] = useState(draft?.text ?? "");
  const [state, setState] = useState<DraftState>({ state: "saved" });
  const saver = useRef<DraftSaver | null>(null);
  saver.current ??= new DraftSaver(personId, draft, archiveApi, setState);
  // Whatever is waiting is saved when the panel goes.
  useEffect(() => () => void saver.current?.flush(), []);
  const names = useNames();
  const readOnly = useReadOnly();
  const id = `draft-${personId}-${draft?.id ?? "new"}`;
  return (
    <div className="composer draft-box">
      <label className="composer__label muted" htmlFor={id}>
        {label}
        <span className={`composer__state${state.state === "failed" ? " draft-box__state--failed" : ""}`} role="status">
          {stateLabel(state, text)}
        </span>
      </label>
      {names.hidden ? (
        <span className="muted">{text ? "Hidden" : "None"}</span>
      ) : readOnly ? (
        <p className="read-only-text">{text}</p>
      ) : (
        <textarea
          id={id}
          className="composer__text"
          rows={Math.min(10, Math.max(3, text.split("\n").length + 1))}
          value={text}
          placeholder="Write a message to them here, and rework it as often as you like; it saves as you type"
          onChange={(e) => {
            setText(e.target.value);
            saver.current!.type(e.target.value);
          }}
          onBlur={() => void saver.current!.flush()}
        />
      )}
    </div>
  );
}

/** " · Saved", " · Saving…", " · Not saved: why"; nothing for an empty box with nothing to save. */
function stateLabel(state: DraftState, text: string): string {
  if (state.state === "failed") return ` · Not saved: ${state.error}`;
  if (state.state === "saving" || state.state === "waiting") return " · Saving…";
  return text.trim() ? " · Saved" : "";
}
