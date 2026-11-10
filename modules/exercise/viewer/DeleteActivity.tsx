// An activity's Delete, at the foot of its page: one button, then one confirmation naming the activity (its date, sport
// and distance) and saying what goes, and that it is for good. Confirmed, DELETE /life-archive/api/m/exercise/activities/<id>
// (../wire.ts) removes every copy of it (../server/delete.ts); the page then goes back to the feed.
// One the archive cannot delete here (a run transcribed by hand) says why instead of offering the button.
// A modal <dialog>: the rest of the page is inert while it is open, Escape, Cancel or a click outside closes it, and
// Cancel has the focus first, so Enter alone deletes nothing.

import { useEffect, useRef, useState } from "react";
import { ACTIVITIES_API, type ActivityDeleted, type ActivityDetail, type DeleteActivity as DeleteBody } from "../wire.ts";
import { deleteName } from "./format.ts";

export function DeleteActivity({ activity, onDeleted }: { activity: ActivityDetail; onDeleted: (deleted: ActivityDeleted) => void }) {
  const [asking, setAsking] = useState(false);
  if (activity.cannotDelete) return <p className="ex-delete__cannot">{activity.cannotDelete}</p>;
  return (
    <div className="ex-delete">
      <button type="button" className="ex-delete__button" onClick={() => setAsking(true)}>
        Delete this activity
      </button>
      {asking && <Confirm activity={activity} onClose={() => setAsking(false)} onDeleted={onDeleted} />}
    </div>
  );
}

function Confirm({ activity, onClose, onDeleted }: { activity: ActivityDetail; onClose: () => void; onDeleted: (deleted: ActivityDeleted) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    cancel.current?.focus();
    return () => opener?.focus();
  }, []);

  const remove = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const res = await fetch(`${ACTIVITIES_API}/${encodeURIComponent(activity.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start: activity.start } satisfies DeleteBody),
      });
      const body = (await res.json().catch(() => ({}))) as ActivityDeleted & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      onDeleted(body);
    } catch (error) {
      setFailed((error as Error).message);
      setBusy(false);
    }
  };

  const copies = activity.alsoIn.length + 1;
  return (
    <dialog
      ref={dialog}
      className="ex-delete__dialog"
      aria-labelledby="ex-delete-title"
      aria-describedby="ex-delete-what"
      onClose={onClose}
      onCancel={(event) => busy && event.preventDefault()}
      // A click on the dialog itself, not its content, is a click on the backdrop around it.
      onClick={(event) => !busy && event.target === dialog.current && dialog.current.close()}
    >
      <div className="ex-delete__body">
        <h2 id="ex-delete-title">Delete {activity.title}?</h2>
        <p className="ex-delete__name">{deleteName(activity)}</p>
        <p id="ex-delete-what">
          Every copy the archive keeps of it ({copies === 1 ? `its one copy, from ${activity.source}` : `${copies} copies: ${[activity.source, ...activity.alsoIn].join("; ")}`}) goes for good: its route,
          heart rate and files, with no backup taken. It cannot be undone. The archive keeps only a note that it was deleted, so Polar never brings it back.
        </p>
        <p className="ex-delete__note">Polar Flow still has it until you delete it there.</p>
        {failed && (
          <p className="ex-delete__failed" role="alert">
            Not deleted: {failed}
          </p>
        )}
        <div className="ex-delete__actions">
          <button type="button" ref={cancel} className="ex-delete__cancel" disabled={busy} onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button type="button" className="ex-delete__confirm" disabled={busy} onClick={remove}>
            {busy ? "Deleting…" : "Delete for good"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
