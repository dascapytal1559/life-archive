// Events in the person panel: Add event's form, which adds a hangout (a
// catch-up, src/catchUps.ts: time with people in person) or a call you
// log yourself (manual_call: with one or more people, each on one of their
// accounts, the chip of each saying which; calls.ts), picked by the
// toggle at its top (Call | Hangout; Message is there too once MESSAGE_EVENTS
// in eventWords.ts is on), the fields below following the kind. A hangout may
// be a trip, over several days: ticking Several days asks when it started and
// ended, each a date and a time, and each day's private hours (midnight to
// 10 am to start), and it counts the time between less those; it is one
// hangout, listed, changed and deleted whole. The
// person's hangouts are listed under a heading that opens and closes them
// (closed to start), the latest first, each with its hours (a trip's in all,
// over how many days), its date and time (a trip's first to last), whoever else was there (a name
// opens their panel) and its note. A hangout can take more people by name and
// say how many more were there unnamed (the wedding: "+ 20 others"), who take
// a share of its worth. Adding, changing and deleting each show the change
// chip, whose Undo takes it back (changeChip.ts). On a read-only page the list
// alone shows. Every word for a hangout comes from eventWords.ts.
// Each hangout also sits in the person's chat (Timeline.tsx) at its time, or
// at the start of its day without one (a trip where it began; ChatCatchUp), and so does each call
// logged (ChatLoggedCall), with the imported calls; a click on either opens
// the form on its kind, with Delete, and its toggle makes it the other kind
// (hangoutOfCall, callOfHangout), saved as one change. An imported call never
// opens the form, so it stays a call. A day's heading there offers "+ event"
// on that day (NewChatEvent).

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { MANUAL_CALL_APPS, type AccountSummary, type CatchUp, type CatchUpInput, type GroupPerson, type LoggedCall, type ManualCallApp, type ManualCallInput, type PersonCall, type Trip } from "./archive.ts";
import { archiveApi } from "./archiveApi.ts";
import { CALL_LENGTH_MOST_MINUTES, callDuration, callLengthText, callPlatformName, carriesCalls, defaultCallAccount, parseCallLength } from "./calls.ts";
import { catchUpDayCount, catchUpTitle, catchUpWhen, dayAfter, DAYS_MOST, daysLabel, freshCatchUp, hoursLabel, HOURS_MOST, OTHERS_MOST, othersLabel, PRIVATE_FROM, PRIVATE_TO, timeLabel, tripHours } from "./catchUps.ts";
import { addCall, addCatchUp, callToCatchUp, catchUpToCall, changeCall, changeCatchUp, deleteCall, deleteCatchUp } from "./changeChip.ts";
import { EVENT_KIND_NAMES, HANGOUT, SHOWN_EVENT_KINDS, type EventKind } from "./eventWords.ts";
import { joinCandidates, useNames } from "./names.ts";
import { change, Name } from "./PersonParts.tsx";
import { useReadOnly } from "./readOnly.ts";
import { dayKey, partsTime, timeOfDay, timeParts, type TimeParts } from "./time.ts";
import { useArchive } from "./useArchive.ts";

/** How many are listed before "Show all". */
const FIRST = 3;

/** What the form edits for a hangout: a catch-up, with everyone at it. */
type HangoutDraft = Omit<CatchUp, "id">;

/**
 * What a call is on with someone: one of their accounts that carries calls (and its platform, for their chip), or for
 * someone with none, the app.
 */
export type CallOn = { accountId: number; platform: string } | { accountId: null; app: ManualCallApp };

/** Someone on a call as the form edits it: who, and what it is on with them (null until chosen: their usual one, once their accounts are in). */
export interface CallPick {
  person: GroupPerson;
  on: CallOn | null;
}

/**
 * What the form edits for a call: everyone on it (a group call has several), its date and time (empty until given),
 * its length as typed, and its note; and how many more were on it unnamed, which the form does not change (the archive
 * keeps a call's as they were) but carries to a hangout it is made.
 */
export interface CallDraft {
  people: CallPick[];
  day: string;
  time: string;
  length: string;
  note: string;
  others: number;
}

/** A new call with `person` (or nobody yet) on `day` (today unless said): no time or length yet, on their usual account. */
export function freshCall(person?: GroupPerson, day = dayKey(Date.now())): CallDraft {
  return { people: person ? [{ person, on: null }] : [], day, time: "", length: "", note: "", others: 0 };
}

/** A logged call's group (everyone on it) as the form edits it, with the `others` on it unnamed (its PersonCall's). */
export function callDraftOf(call: LoggedCall, others = 0): CallDraft {
  return {
    others,
    people: call.people.map(({ person, accountId, platform }) => ({
      person,
      on: accountId !== null ? { accountId, platform }
        : { accountId: null, app: (MANUAL_CALL_APPS as readonly string[]).includes(platform) ? (platform as ManualCallApp) : "phone" },
    })),
    day: dayKey(call.at),
    time: timeOfDay(call.at),
    length: callLengthText(Math.round(call.durationSeconds / 60)),
    note: call.note,
  };
}

/** What a call is on with someone, chosen from their `accounts` that carry calls: `accountId`'s, or with none, the app. */
export function callOnOf(accounts: readonly Pick<AccountSummary, "id" | "platform">[], accountId: number): CallOn {
  return { accountId, platform: accounts.find((a) => a.id === accountId)?.platform ?? "other" };
}

/**
 * What a new call with someone is on, as their chip first shows it: of their `accounts` (any; those that carry calls
 * count) the one they are usually called on (defaultCallAccount, by `calls`), else, with none, the phone.
 */
export function usualCallOn(accounts: readonly Pick<AccountSummary, "id" | "platform">[], calls: readonly Pick<PersonCall, "accountId" | "at">[]): CallOn {
  const usual = defaultCallAccount(accounts, calls);
  return usual ? { accountId: usual.id, platform: usual.platform } : { accountId: null, app: "phone" };
}

/** `draft` with `person` put on it (once), not yet on anything chosen. */
export function withCallPerson(draft: CallDraft, person: GroupPerson): CallDraft {
  return draft.people.some((p) => p.person.id === person.id) ? draft : { ...draft, people: [...draft.people, { person, on: null }] };
}

/** `draft` with the call on `on` with person `personId`, everyone else as they were. */
export function choosingCallOn(draft: CallDraft, personId: number, on: CallOn): CallDraft {
  return { ...draft, people: draft.people.map((p) => (p.person.id === personId ? { ...p, on } : p)) };
}

/**
 * The call a draft says, when it says a whole one: someone, each on what it was on with them (their account, or on
 * none the app), a date, a time, and a length from 1 minute to a day; and its note, if any.
 */
export function callInput(draft: CallDraft): ManualCallInput | null {
  const minutes = parseCallLength(draft.length);
  if (draft.people.length === 0 || draft.people.some((p) => p.on === null) || !draft.day || !draft.time || minutes === null || minutes > CALL_LENGTH_MOST_MINUTES) return null;
  return {
    people: draft.people.map(({ person, on }) => ({ personId: person.id, accountId: on!.accountId, app: on!.accountId === null ? on!.app : null })),
    day: draft.day,
    time: draft.time,
    minutes,
    note: draft.note,
  };
}

/**
 * A hangout as the form makes it from a call it changes into one: everyone on it, at its date and time, its length in
 * hours (to two places, as a hangout keeps them; 1 while the length says none), its note, and its unnamed others.
 */
export function hangoutOfCall(call: CallDraft): HangoutDraft {
  const minutes = parseCallLength(call.length);
  return {
    day: call.day, time: call.time || null, trip: null, hours: minutes === null ? 1 : Math.max(0.01, Math.round(minutes / 60 * 100) / 100), note: call.note,
    people: call.people.map((p) => p.person), others: call.others,
  };
}

/**
 * A call as the form makes it from a hangout it changes into one: everyone named at it, each on their usual account
 * (their chip picks it, as for someone put on a new call), at its date and time (none to fill in, without one), its
 * hours as a length in whole minutes (at least 1), its note, and its unnamed others, which the archive keeps on the call.
 */
export function callOfHangout(hangout: HangoutDraft): CallDraft {
  return {
    people: hangout.people.map((person) => ({ person, on: null })), day: hangout.day, time: hangout.time ?? "",
    length: callLengthText(Math.min(CALL_LENGTH_MOST_MINUTES, Math.max(1, Math.round(hangout.hours * 60)))), note: hangout.note,
    others: hangout.others,
  };
}

/**
 * What Add event starts with: a hangout and a call with `person` on `day` (today unless said), as freshCatchUp and
 * freshCall start them, on a hangout.
 */
export function newEvent(person?: GroupPerson, day?: string): EventStart {
  return { kind: "hangout", hangout: { ...freshCatchUp(person), ...(day ? { day } : {}) }, call: freshCall(person, day) };
}

/**
 * What the event form opens on: a new event (no `id`: the toggle picks the kind), or a hangout or a logged call to
 * change (`id`: on its kind, which the toggle can change, making it the other).
 */
export type EventStart =
  | { kind: EventKind; id?: undefined; hangout: HangoutDraft; call: CallDraft }
  | { kind: "hangout"; id: number; hangout: HangoutDraft }
  | { kind: "call"; id: number; call: CallDraft };

/** Adds a hangout, or changes hangout `id` to `input`: the chip offers Undo, and every view loads again. Whether it saved. */
export async function saveCatchUp(input: CatchUpInput, id?: number): Promise<boolean> {
  return (await change(() => (id === undefined ? addCatchUp(input) : changeCatchUp(id, input)))) !== undefined;
}

/** Deletes a hangout, as saveCatchUp saves one. Whether it is gone. */
export async function removeCatchUp(catchUp: CatchUp): Promise<boolean> {
  return (await change(() => deleteCatchUp(catchUp))) !== undefined;
}

/** Logs a call, or changes logged call `id` to `input`, as saveCatchUp saves a hangout. Whether it saved. */
export async function saveCall(input: ManualCallInput, id?: number): Promise<boolean> {
  return (await change(() => (id === undefined ? addCall(input) : changeCall(id, input)))) !== undefined;
}

/** Makes logged call `id` (its whole group) a hangout as `input` says, as one change, as saveCatchUp saves one. Whether it saved. */
export async function convertToCatchUp(id: number, input: CatchUpInput): Promise<boolean> {
  return (await change(() => callToCatchUp(id, input))) !== undefined;
}

/** Makes hangout `id` a logged call as `input` says, as one change, as saveCall saves one. Whether it saved. */
export async function convertToCall(id: number, input: ManualCallInput): Promise<boolean> {
  return (await change(() => catchUpToCall(id, input))) !== undefined;
}

/** Deletes logged call `call` (its whole group), as saveCatchUp saves a hangout. Whether it is gone. */
export async function removeCall(call: Parameters<typeof deleteCall>[0]): Promise<boolean> {
  return (await change(() => deleteCall(call))) !== undefined;
}

/**
 * The person's hangouts (`catchUps`, the latest first, loaded by the panel) under a "Hangouts · 2" heading that opens
 * and closes the list (open as `open` says, the panel's choice: closed whenever it opens, as they sit in the chat too),
 * with "Add event" at the heading's right, open or closed; Edit and Delete on each; `onOpenPerson` opens someone else
 * who was there.
 */
export function CatchUpsField({ person, catchUps, open, onToggle, onOpenPerson }: {
  person: GroupPerson;
  catchUps: CatchUp[] | undefined;
  open: boolean;
  onToggle: (open: boolean) => void;
  onOpenPerson: (id: number) => void;
}) {
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [all, setAll] = useState(false);
  const readOnly = useReadOnly();
  const list = catchUps ?? [];
  const shown = all ? list : list.slice(0, FIRST);
  return (
    <div className="field">
      <span className="field__head">
        <button type="button" className="field__toggle" aria-expanded={open} onClick={() => onToggle(!open)}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> {HANGOUT.Many}{catchUps && ` · ${list.length}`}
        </button>
        {!readOnly && editing !== "new" && (
          <button type="button" className="link-button catch-ups__add" onClick={() => setEditing("new")}>Add event</button>
        )}
      </span>
      {(open || editing === "new") && (
        <div className="catch-ups">
          {open && list.length === 0 && editing !== "new" && (
            <span className="muted field__hint">{catchUps ? `None yet. Time together in person counts toward closeness; add a ${HANGOUT.one} or a call with Add event.` : "Loading…"}</span>
          )}
          {open && shown.length > 0 && (
            <ul>
              {shown.map((catchUp) => editing === catchUp.id
                ? <li key={catchUp.id}><EventForm start={{ kind: "hangout", id: catchUp.id, hangout: catchUp }} onDone={() => setEditing(null)} /></li>
                : <CatchUpRow key={catchUp.id} catchUp={catchUp} personId={person.id} onOpenPerson={onOpenPerson} onEdit={() => setEditing(catchUp.id)} />)}
            </ul>
          )}
          {open && list.length > FIRST && (
            <button type="button" className="link-button" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${list.length}`}</button>
          )}
          {editing === "new" && <EventForm start={newEvent(person)} onDone={() => setEditing(null)} />}
        </div>
      )}
    </div>
  );
}

/**
 * One hangout: how long and when, who else was there ("+20 others" after them for the unnamed), its note (hidden with
 * the names, as notes are), Edit and Delete.
 */
function CatchUpRow({ catchUp, personId, onOpenPerson, onEdit }: {
  catchUp: CatchUp;
  personId: number;
  onOpenPerson: (id: number) => void;
  onEdit: () => void;
}) {
  const names = useNames();
  const readOnly = useReadOnly();
  return (
    <li className="catch-ups__row">
      <span className="catch-ups__what">
        <strong>{catchUpTitle(catchUp.hours, catchUpDayCount(catchUp))}</strong> · {catchUpWhen(catchUp.day, catchUp.trip?.lastDay)}
        {catchUp.time && `, ${timeLabel(catchUp.time)}`}{catchUp.trip && ` to ${timeLabel(catchUp.trip.endTime)}`}
      </span>
      <CatchUpWith catchUp={catchUp} personId={personId} onOpenPerson={onOpenPerson} />
      {catchUp.note && (names.hidden ? <span className="muted">Note hidden</span> : <span className="catch-ups__note">{catchUp.note}</span>)}
      {!readOnly && (
        <span className="catch-ups__actions">
          <button type="button" className="link-button" onClick={onEdit}>Edit</button>
          <button type="button" className="link-button catch-ups__delete" onClick={() => void removeCatchUp(catchUp)}>Delete</button>
        </span>
      )}
    </li>
  );
}

/**
 * Who else was at a hangout than `personId`: "with Bea and Cy +20 others", each name a button that opens them when
 * `onOpenPerson` is given, else plain; nothing when they were alone.
 */
function CatchUpWith({ catchUp, personId, onOpenPerson }: { catchUp: CatchUp; personId: number; onOpenPerson?: (id: number) => void }) {
  const names = useNames();
  const others = catchUp.people.filter((p) => p.id !== personId);
  const unnamed = othersLabel(catchUp.others);
  if (others.length === 0 && !unnamed) return null;
  return (
    <span className="catch-ups__with muted">
      {others.length > 0 && "with "}
      {others.map((other, i) => (
        <span key={other.id}>
          {i > 0 && (i === others.length - 1 ? " and " : ", ")}
          {onOpenPerson ? (
            <button type="button" className="link-button" title="Open their panel" onClick={() => onOpenPerson(other.id)}>
              <Name text={names.label(other).primary} />
            </button>
          ) : <Name text={names.label(other).primary} />}
        </span>
      ))}
      {unnamed && `${others.length > 0 ? " " : ""}${unnamed}`}
    </span>
  );
}

/**
 * A hangout in `personId`'s chat, at its time or the start of its day: "Hangout · 7:30 pm · 3 hours" ("Hangout ·
 * 3 hours" without a time; a trip where it began, "Hangout · 6:00 pm ·
 * 24 hours over 3 days · until 6 Oct 2026, 2:00 pm"), who else was there, and its note's
 * first line (hidden with the names). A click opens the form in its place, with Delete; on a read-only page it only shows.
 */
export function ChatCatchUp({ catchUp, personId }: { catchUp: CatchUp; personId: number }) {
  const [editing, setEditing] = useState(false);
  const readOnly = useReadOnly();
  const names = useNames();
  if (editing) {
    return (
      <div className="message message--catch-up message--editing">
        <EventForm start={{ kind: "hangout", id: catchUp.id, hangout: catchUp }} onDone={() => setEditing(false)} onDelete={() => removeCatchUp(catchUp)} />
      </div>
    );
  }
  const note = catchUp.note.split("\n")[0];
  const body = (
    <>
      <span className="message__catch-up-what">
        <strong>{HANGOUT.One}</strong>{catchUp.time && ` · ${timeLabel(catchUp.time)}`} · {catchUpTitle(catchUp.hours, catchUpDayCount(catchUp))}
        {catchUp.trip && ` · until ${catchUpWhen(catchUp.trip.lastDay)}, ${timeLabel(catchUp.trip.endTime)}`}
      </span>
      <CatchUpWith catchUp={catchUp} personId={personId} />
      {note && (names.hidden ? <span className="muted">Note hidden</span> : <span className="message__catch-up-note">{note}</span>)}
    </>
  );
  return (
    <div className="message message--catch-up">
      {readOnly ? <div className="message__body">{body}</div> : (
        <button type="button" className="message__body message__catch-up-open" title={`Change this ${HANGOUT.one}`} onClick={() => setEditing(true)}>{body}</button>
      )}
    </div>
  );
}

/**
 * A call you logged, in its person's chat at its time: "Call · 7:30 pm · 25 min", its platform's chip beside
 * (its account's, as an imported call's: Messenger, FaceTime), how many others were on it when you logged it with
 * several ("with 2 others"), "you logged it", and its note's first line (hidden with the names). A click loads everyone on it and opens the form on Call in its
 * place, with Delete, both for the whole call; on a read-only page it only shows.
 */
export function ChatLoggedCall({ call }: { call: PersonCall }) {
  const [editing, setEditing] = useState(false);
  const readOnly = useReadOnly();
  const names = useNames();
  const group = useArchive(() => archiveApi.loggedCall(call.id), [call.id], { enabled: editing, follow: false });
  if (editing) {
    return (
      <div className="message message--catch-up message--editing">
        {group.data
          ? <EventForm start={{ kind: "call", id: call.id, call: callDraftOf(group.data, call.others) }} onDone={() => setEditing(false)} onDelete={() => removeCall(call)} />
          : <p className="muted">{group.error ?? "Loading the call…"}</p>}
      </div>
    );
  }
  const others = call.people - 1;
  const body = (
    <>
      <span className="message__catch-up-what"><strong>Call</strong> · {timeLabel(timeOfDay(call.at))} · {callDuration(call.durationSeconds)}</span>
      <span className="muted">
        <span className="platform-badge">{callPlatformName(call.platform)}</span>
        {others > 0 && ` · with ${others} ${others === 1 ? "other" : "others"}`} · you logged it
      </span>
      <CallNoteLine note={call.note} hidden={names.hidden} />
    </>
  );
  return (
    <div className="message message--catch-up message--logged-call">
      {readOnly ? <div className="message__body">{body}</div> : (
        <button type="button" className="message__body message__catch-up-open" title="Change this call" onClick={() => setEditing(true)}>{body}</button>
      )}
    </div>
  );
}

/** A call's note's first line, in the chat as a hangout's is: hidden with the names (No name except…); nothing for none. */
export function CallNoteLine({ note, hidden }: { note: string; hidden: boolean }) {
  const line = note.split("\n")[0];
  if (!line) return null;
  return hidden ? <span className="muted message__call-note">Note hidden</span> : <span className="message__catch-up-note message__call-note" title={note}>{line}</span>;
}

/** "+ event" on a day of `person`'s chat: Add event's form for one with them on that day, under the day's heading. Nothing on a read-only page or a day still to come. */
export function NewChatEvent({ person, day }: { person: GroupPerson; day: string }) {
  const [adding, setAdding] = useState(false);
  const readOnly = useReadOnly();
  if (readOnly || day > dayKey(Date.now())) return null;
  if (!adding) {
    return <button type="button" className="link-button timeline__add-catch-up" title="Add a call or a hangout on this day" onClick={() => setAdding(true)}>+ event</button>;
  }
  return (
    <div className="message message--catch-up message--editing">
      <EventForm start={newEvent(person, day)} onDone={() => setAdding(false)} />
    </div>
  );
}

/**
 * Add event's form, or the form to change a hangout or a logged call (`start`, see EventStart). At its top the kinds
 * (Call | Hangout) as a toggle; changing one, the other kind makes it that (its fields filled from it by hangoutOfCall
 * or callOfHangout, Save as call or Save as hangout putting it in the old one's place as one change, and no Delete
 * meanwhile); below, the kind's fields: for a hangout,
 * its date (no later than today), when it started (or none), how many hours (above 0, at most HOURS_MOST), or with
 * Several days ticked (a trip, tripOf) when it started and ended, each a date and a time, and each day's private hours
 * (PRIVATE_FROM to PRIVATE_TO to start), its days and time together said under them (tripHours), who was
 * there (chips beside "With", each with × to take them off, anyone added by typing their name below, archived people
 * too, after the rest), how many more were there unnamed (the "+ others" box) and a note; for a call, its date and
 * the time it started, how long it lasted (25 minutes, or 1:30), who was on it, as the hangout's chips, each also
 * saying what it was on with them (CallPersonChip), and a note. The date and time carry over when the kind is changed. With
 * `onDelete`, Delete too.
 */
export function EventForm({ start, onDone, onDelete }: {
  start: EventStart;
  onDone: () => void;
  /** Deletes the hangout or call being changed, offered beside Cancel; true once it is gone. */
  onDelete?: () => Promise<boolean>;
}) {
  const [kind, setKind] = useState<EventKind>(start.kind);
  // Each kind's fields: a new event's own, or the one being changed and the other kind made from it.
  const call = "call" in start ? start.call : callOfHangout(start.hangout);
  const hangout = "hangout" in start ? start.hangout : hangoutOfCall(start.call);
  // The date and time, shared by the kinds so they carry over (empty time for none).
  const first = start.kind === "call" ? call : hangout;
  const [day, setDay] = useState(first.day);
  const [time, setTime] = useState(first.time ?? "");
  const [saving, setSaving] = useState(false);
  const changing = start.id !== undefined;
  const converting = changing && kind !== start.kind;
  const run = async (work: () => Promise<boolean>) => {
    setSaving(true);
    const done = await work();
    setSaving(false);
    if (done) onDone();
  };
  const toggle = (
    <div className="event-kind" role="group" aria-label={changing ? "What kind of event: the other makes it one" : "What kind of event"}>
      {SHOWN_EVENT_KINDS.filter((option) => !changing || option !== "message").map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={kind === option}
          title={changing && option !== start.kind ? `Make it a ${EVENT_KIND_NAMES[option].toLowerCase()}` : undefined}
          onClick={() => setKind(option)}
        >
          {EVENT_KIND_NAMES[option]}
        </button>
      ))}
    </div>
  );
  const actions = (valid: boolean) => (
    <div className="catch-up-form__actions">
      <button type="submit" className="button button--primary" disabled={saving || !valid}>
        {!changing ? `Add ${EVENT_KIND_NAMES[kind].toLowerCase()}` : converting ? `Save as ${EVENT_KIND_NAMES[kind].toLowerCase()}` : "Save"}
      </button>
      <button type="button" className="link-button" onClick={onDone}>Cancel</button>
      {onDelete && !converting && (
        <button type="button" className="link-button catch-ups__delete" disabled={saving} onClick={() => void run(onDelete)}>Delete</button>
      )}
    </div>
  );
  const label = !changing ? "Add event" : `Change this ${start.kind === "call" ? "call" : HANGOUT.one}`;
  const shared = { day, setDay, time, setTime, toggle, actions, run, onDone, label };
  if (kind === "call") {
    const save = (input: ManualCallInput) => !changing ? saveCall(input) : start.kind === "call" ? saveCall(input, start.id) : convertToCall(start.id, input);
    // A trip's days have no place on a call: said, so it is no surprise they go. Its unnamed others stay on it, as said.
    const dropped = !converting ? null : [
      ...(hangout.others > 0 ? [`The ${othersLabel(hangout.others).slice(1)} unnamed at the ${HANGOUT.one} stay on the call.`] : []),
      ...(hangout.trip ? [`A call is on one day: the trip's days after its first are not kept.`] : []),
    ].join(" ") || null;
    return <CallFields key="call" draft={call} save={save} dropped={dropped} {...shared} />;
  }
  const save = (input: CatchUpInput) => !changing ? saveCatchUp(input) : start.kind === "hangout" ? saveCatchUp(input, start.id) : convertToCatchUp(start.id, input);
  return <HangoutFields key="hangout" draft={hangout} save={save} {...shared} />;
}

interface Shared {
  day: string;
  setDay: (day: string) => void;
  time: string;
  setTime: (time: string) => void;
  toggle: ReactNode;
  actions: (valid: boolean) => ReactNode;
  run: (work: () => Promise<boolean>) => Promise<void>;
  onDone: () => void;
  /** What the form is called: "Add event", or "Change this call". */
  label: string;
}

/** The form as a whole: the toggle, the kind's fields, and the actions; Escape cancels. */
function FormFrame({ label, onSubmit, onCancel, children }: { label: string; onSubmit: () => void; onCancel: () => void; children: ReactNode }) {
  return (
    <form
      className="catch-up-form"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      {children}
    </form>
  );
}

/**
 * The date, and the time it started: optional with `optionalTime` ("No time" takes one off), else needed. For a trip
 * (`trip`), its start: "Started", and the time needed.
 */
function When({ day, setDay, time, setTime, optionalTime, trip = false, children }: Pick<Shared, "day" | "setDay" | "time" | "setTime"> & { optionalTime: boolean; trip?: boolean; children?: ReactNode }) {
  const today = dayKey(Date.now());
  return (
    <div className={`catch-up-form__when${optionalTime ? "" : " catch-up-form__when--call"}${trip ? " catch-up-form__when--trip" : ""}`}>
      <label>
        <span>{trip ? "Started" : "Date"}</span>
        <input type="date" value={day} max={today} required onChange={(e) => setDay(e.target.value)} />
      </label>
      {/* Not a label, which would hand a click on "Time" to the No time button. */}
      <div className="catch-up-form__time">
        <span>
          Time
          {optionalTime && time && <button type="button" className="link-button catch-up-form__no-time" title="It sits at the start of its day" onClick={() => setTime("")}>No time</button>}
        </span>
        <TimeBox label={optionalTime ? "Time it started (if you like)" : "Time it started"} time={time} setTime={setTime} required={!optionalTime} />
      </div>
      {children}
    </div>
  );
}

/**
 * The time box: the hour, the minutes and am or pm, on pm to start, so typing 7 30 says 7:30 pm (a browser's time
 * box cannot start on pm without a whole time). The hour alone is on the hour; with both boxes empty there is no
 * time. `time` (HH:MM, or "") is kept to what it says: anything it cannot say a time from is no time, and the
 * boxes' own checks stop the form going in with it. Typing a or p sets am or pm, ":" moves to the minutes, as does a whole hour; Backspace in
 * empty minutes goes back to the hour.
 */
function TimeBox({ label, time, setTime, required }: { label: string; time: string; setTime: (time: string) => void; required: boolean }) {
  const [parts, setParts] = useState(() => timeParts(time));
  // A time set from outside ("No time") shows as it is.
  if ((partsTime(parts) ?? "") !== time) setParts(timeParts(time));
  const hourRef = useRef<HTMLInputElement>(null);
  const minuteRef = useRef<HTMLInputElement>(null);
  const set = (change: Partial<TimeParts>) => {
    const next = { ...parts, ...change };
    setParts(next);
    setTime(partsTime(next) ?? "");
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    const key = e.key.toLowerCase();
    if (key === "a" || key === "p") set({ pm: key === "p" });
    else if (key === ":" && e.currentTarget === hourRef.current) minuteRef.current?.focus();
    else if (key === "backspace" && e.currentTarget === minuteRef.current && !parts.minute) hourRef.current?.focus();
    else return;
    e.preventDefault();
  };
  const digits = (text: string) => text.replace(/\D/g, "").slice(0, 2);
  return (
    <div className="time-box" role="group" aria-label={label}>
      <input
        ref={hourRef}
        className="time-box__part"
        inputMode="numeric"
        aria-label="Hour"
        placeholder="--"
        maxLength={2}
        pattern="0?[1-9]|1[0-2]"
        required={required || parts.minute !== ""}
        value={parts.hour}
        onKeyDown={keys}
        onChange={(e) => {
          const hour = digits(e.target.value);
          set({ hour });
          if (hour.length === 2 || Number(hour) > 1) minuteRef.current?.focus();
        }}
      />
      <span aria-hidden>:</span>
      <input
        ref={minuteRef}
        className="time-box__part"
        inputMode="numeric"
        aria-label="Minutes"
        placeholder="--"
        maxLength={2}
        pattern="[0-5]?[0-9]"
        value={parts.minute}
        onKeyDown={keys}
        onChange={(e) => set({ minute: digits(e.target.value) })}
      />
      <button
        type="button"
        className="time-box__half"
        title="am or pm: click, or type a or p"
        onClick={() => set({ pm: !parts.pm })}
        onKeyDown={(e) => {
          const key = e.key.toLowerCase();
          if (key === "arrowup" || key === "arrowdown") set({ pm: !parts.pm });
          else if (key === "a" || key === "p") set({ pm: key === "p" });
          else return;
          e.preventDefault();
        }}
      >
        {parts.pm ? "PM" : "AM"}
      </button>
    </div>
  );
}

function HangoutFields({ draft, save: saveIt, day, setDay, time, setTime, toggle, actions, run, onDone, label }: Shared & { draft: HangoutDraft; save: (input: CatchUpInput) => Promise<boolean> }) {
  // As typed, so "1." or "" can be on the way to "1.5"; the server checks it.
  const [hours, setHours] = useState(String(draft.hours));
  const [note, setNote] = useState(draft.note);
  const noteId = useId();
  const [people, setPeople] = useState<GroupPerson[]>(draft.people);
  // As typed, so it can be cleared on the way to "20"; empty is none.
  const [others, setOthers] = useState(String(draft.others));
  const othersCount = others.trim() === "" ? 0 : Number(others);
  // A trip: whether it is one, when it ended, and each day's private hours, as given ("" for a time not yet given).
  const [severalDays, setSeveralDays] = useState(draft.trip !== null);
  const [lastDay, setLastDay] = useState(draft.trip?.lastDay ?? "");
  const [endTime, setEndTime] = useState(draft.trip?.endTime ?? "");
  const [privateFrom, setPrivateFrom] = useState(draft.trip?.privateFrom ?? PRIVATE_FROM);
  const [privateTo, setPrivateTo] = useState(draft.trip?.privateTo ?? PRIVATE_TO);
  const trip = severalDays ? tripOf(day, time, { lastDay, endTime, privateFrom, privateTo }) : null;
  const together = trip ? tripHours(day, time, trip) : 0;
  const valid = people.length > 0 && !!day && (severalDays ? together > 0 : Number(hours) > 0) && Number.isInteger(othersCount) && othersCount >= 0;
  const save = () => saveIt({
    day, time: time || null, trip, hours: trip ? together : Number(hours), note, personIds: people.map((p) => p.id), others: othersCount,
  });
  return (
    <FormFrame label={label} onSubmit={() => valid && void run(save)} onCancel={onDone}>
      {toggle}
      <label className="catch-up-form__several" title="A trip away together: from when it started to when it ended, less each day's private hours">
        <input type="checkbox" checked={severalDays} onChange={(e) => setSeveralDays(e.target.checked)} />
        <span>Several days</span>
      </label>
      {severalDays ? (
        <>
          <When day={day} setDay={setDay} time={time} setTime={setTime} optionalTime={false} trip />
          <div className="catch-up-form__when catch-up-form__when--call catch-up-form__when--trip">
            <label>
              <span>Ended</span>
              <input type="date" value={lastDay} min={day ? dayAfter(day) : undefined} max={dayKey(Date.now())} required onChange={(e) => setLastDay(e.target.value)} />
            </label>
            <div className="catch-up-form__time">
              <span>Time</span>
              <TimeBox label="Time it ended" time={endTime} setTime={setEndTime} required />
            </div>
          </div>
          <div className="catch-up-form__private" title="Hours each day you kept to yourself (asleep, time alone): the rest of the trip counts as time together">
            <span>Private each day</span>
            <div className="catch-up-form__private-times">
              <TimeBox label="Private from" time={privateFrom} setTime={setPrivateFrom} required />
              <span>to</span>
              <TimeBox label="Private until" time={privateTo} setTime={setPrivateTo} required />
            </div>
          </div>
          <p className="catch-up-form__trip muted">
            {!trip ? "When it ended: a day after it started, no later than today, and a time"
              : together > 0 ? `${daysLabel(catchUpDayCount({ day, trip }))}, ${hoursLabel(together)} together`
              : "No time together outside the private hours"}
          </p>
        </>
      ) : (
        <When day={day} setDay={setDay} time={time} setTime={setTime} optionalTime>
          <label>
            <span>Hours</span>
            <input type="number" inputMode="decimal" min={0.01} max={HOURS_MOST} step="any" value={hours} required onChange={(e) => setHours(e.target.value)} />
          </label>
        </When>
      )}
      <PeoplePicker people={people} setPeople={setPeople} what={HANGOUT.one}>
        <label className="catch-up-form__others" title="How many more were there that you do not name: they take a share of its worth">
          <span aria-hidden>+</span>
          <input
            type="number"
            inputMode="numeric"
            aria-label="Others there, unnamed"
            min={0}
            max={OTHERS_MOST}
            step={1}
            value={others}
            onChange={(e) => setOthers(e.target.value)}
          />
          <span aria-hidden>others</span>
        </label>
      </PeoplePicker>
      <div className="catch-up-form__note">
        <label htmlFor={noteId}>Note <span className="muted">(if you like)</span></label>
        <input id={noteId} value={note} placeholder="Dinner, a wedding" onChange={(e) => setNote(e.target.value)} />
      </div>
      {actions(valid)}
    </FormFrame>
  );
}

/**
 * The trip a hangout's fields say, once they say a whole one: it started on `day` at `time` and ended on a later
 * `lastDay`, no later than today and at most DAYS_MOST days on, at `endTime`, with a private window each day; else null.
 */
export function tripOf(day: string, time: string, fields: Trip): Trip | null {
  const { lastDay, endTime, privateFrom, privateTo } = fields;
  if (!day || !time || !endTime || !privateFrom || !privateTo || !(lastDay > day) || lastDay > dayKey(Date.now())) return null;
  return catchUpDayCount({ day, trip: fields }) > DAYS_MOST ? null : { lastDay, endTime, privateFrom, privateTo };
}

function CallFields({ draft: start, save: saveIt, dropped, day, setDay, time, setTime, toggle, actions, run, onDone, label }: Shared & {
  draft: CallDraft;
  save: (input: ManualCallInput) => Promise<boolean>;
  /** What becomes of what the hangout it is made from has that the call shows no field for, said under its people; null for nothing. */
  dropped: string | null;
}) {
  const [draft, setDraft] = useState<CallDraft>(start);
  // Whose chip is open, choosing what the call was on with them: someone just put on it opens on theirs.
  const [open, setOpen] = useState<number | null>(null);
  const input = callInput({ ...draft, day, time });
  const minutes = parseCallLength(draft.length);
  const save = () => saveIt(input!);
  const opened = draft.people.find((p) => p.person.id === open);
  const noteId = useId();

  return (
    <FormFrame label={label} onSubmit={() => input && void run(save)} onCancel={onDone}>
      {toggle}
      <When day={day} setDay={setDay} time={time} setTime={setTime} optionalTime={false}>
        <label title="Whole minutes (25), or hours and minutes (1:30)">
          <span>Length</span>
          <input
            inputMode="numeric"
            aria-label="How long it lasted: minutes, or h:mm"
            placeholder="25, 1:30"
            value={draft.length}
            required
            aria-invalid={draft.length.trim() !== "" && (minutes === null || minutes > CALL_LENGTH_MOST_MINUTES)}
            onChange={(e) => setDraft({ ...draft, length: e.target.value })}
          />
        </label>
      </When>
      <PeoplePicker
        people={draft.people.map((p) => p.person)}
        setPeople={(people) => {
          setDraft({ ...draft, people: draft.people.filter((p) => people.some((q) => q.id === p.person.id)) });
          if (!people.some((p) => p.id === open)) setOpen(null);
        }}
        onAdd={(person) => {
          setDraft(withCallPerson(draft, person));
          setOpen(person.id);
        }}
        what="call"
        chip={(person) => {
          const pick = draft.people.find((p) => p.person.id === person.id)!;
          return <CallPersonChip
            key={person.id}
            pick={pick}
            open={open === person.id}
            onToggle={() => setOpen(open === person.id ? null : person.id)}
            onUsual={(on) => setDraft((now) => choosingCallOn(now, person.id, on))}
            onRemove={() => {
              setDraft({ ...draft, people: draft.people.filter((p) => p.person.id !== person.id) });
              if (open === person.id) setOpen(null);
            }}
          />;
        }}
        under={opened && (
          <CallOnPanel
            key={opened.person.id}
            pick={opened}
            onChoose={(on) => {
              setDraft((now) => choosingCallOn(now, opened.person.id, on));
              setOpen(null);
            }}
          />
        )}
      />
      {dropped && <p className="muted catch-up-form__dropped">{dropped}</p>}
      <div className="catch-up-form__note">
        <label htmlFor={noteId}>Note <span className="muted">(if you like)</span></label>
        <input id={noteId} value={draft.note} placeholder="What you talked about" onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
      </div>
      {actions(input !== null)}
    </FormFrame>
  );
}

/**
 * Someone on a call, as a chip on the With line: their name, then what the call was on with them (its platform's
 * badge; "…" until chosen) with ▾, which opens what it may be on under the line (CallOnPanel), and × to take them off.
 * With nothing chosen yet, it loads their accounts and calls and puts the call on their usual one (`onUsual`,
 * usualCallOn), so someone put on it is on something at once.
 */
export function CallPersonChip({ pick, open, onToggle, onUsual, onRemove }: {
  pick: CallPick;
  open: boolean;
  onToggle: () => void;
  onUsual: (on: CallOn) => void;
  onRemove: () => void;
}) {
  const names = useNames();
  const unset = pick.on === null;
  const theirs = useArchive(() => Promise.all([archiveApi.person(pick.person.id), archiveApi.calls(pick.person.id)]), [pick.person.id], { enabled: unset });
  useEffect(() => {
    if (theirs.data && unset) onUsual(usualCallOn(theirs.data[0].accounts, theirs.data[1]));
  }, [theirs.data, unset]);
  const name = names.hidden ? "them" : names.label(pick.person).primary;
  const on = pick.on === null ? null : callPlatformName(pick.on.accountId === null ? pick.on.app : pick.on.platform);
  return (
    <span className={`tag-chip tag-chip--alias call-chip${open ? " call-chip--open" : ""}`}>
      <Name text={names.label(pick.person).primary} />
      <button type="button" className="call-chip__on" aria-expanded={open} aria-label={`What the call was on with ${name}: ${on ?? "not chosen yet"}`} onClick={onToggle}>
        <span className="platform-badge">{on ?? "…"}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <button type="button" aria-label={`Take ${name} off this call`} onClick={onRemove}>×</button>
    </span>
  );
}

/**
 * What a call may be on with someone whose chip is open, under the With line: their accounts that carry calls, or for
 * someone with none, the apps, loaded as it opens, with what it is on marked (someone just put on it on their usual
 * one already, so one tap on it confirms it). A choice closes it.
 */
function CallOnPanel({ pick, onChoose }: { pick: CallPick; onChoose: (on: CallOn) => void }) {
  const theirs = useArchive(() => archiveApi.person(pick.person.id), [pick.person.id]);
  const accounts = theirs.data?.accounts.filter((a) => carriesCalls(a.platform));
  return <CallOnChoices name={pick.person} accounts={accounts} on={pick.on} onChoose={onChoose} />;
}

/**
 * The choices a call may be on with `name`: each of their `accounts` (those that carry calls) as its platform's chip
 * and its name ("FaceTime" for an iMessage one, which is how it calls), or with none, the apps; `on` marked.
 * Loading while `accounts` is undefined.
 */
export function CallOnChoices({ name, accounts, on, onChoose }: {
  name: GroupPerson;
  accounts: AccountSummary[] | undefined;
  on: CallOn | null;
  onChoose: (on: CallOn) => void;
}) {
  const names = useNames();
  const labelId = useId();
  return (
    <div className="call-on">
      <span id={labelId}><Name text={names.label(name).primary} /> on</span>
      {accounts === undefined ? <span className="muted">Loading their accounts…</span> : (
        <div role="radiogroup" aria-labelledby={labelId} className="call-accounts">
          {accounts.length > 0
            ? accounts.map((account) => {
              const shown = names.shown(account.displayName);
              return (
                <button
                  key={account.id}
                  type="button"
                  role="radio"
                  aria-checked={on?.accountId === account.id}
                  className="call-accounts__account"
                  title={shown || undefined}
                  onClick={() => onChoose(callOnOf(accounts, account.id))}
                >
                  <span className="platform-badge">{callPlatformName(account.platform)}</span>
                  <span className="call-accounts__name"><Name text={shown} /></span>
                </button>
              );
            })
            : MANUAL_CALL_APPS.map((app) => (
              <button
                key={app}
                type="button"
                role="radio"
                aria-checked={on !== null && on.accountId === null && on.app === app}
                className="call-accounts__account"
                title="None of their accounts carries calls, so the call is on the app you say"
                onClick={() => onChoose({ accountId: null, app })}
              >
                <span className="platform-badge">{app === "other" ? "Other" : callPlatformName(app)}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * Who was there: chips beside "With", each with × to take them off, and a field below to add someone by typing their
 * name (archived people too, after the rest). `chip` draws each chip instead (a call's say what it was on with them),
 * `under` sits under the With line (a call chip's choices), `onAdd` puts someone on in place of `setPeople`, and
 * `children` sit beside the field (the hangout's "+ others").
 */
function PeoplePicker({ people, setPeople, what, chip, under, onAdd, children }: {
  people: GroupPerson[];
  setPeople: (people: GroupPerson[]) => void;
  /** What they are at ("hangout", "call"), for the × button's label. */
  what: string;
  chip?: (person: GroupPerson) => ReactNode;
  under?: ReactNode;
  onAdd?: (person: GroupPerson) => void;
  children?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const names = useNames();
  // Everyone, to choose from: a big download, so only once a name is typed.
  const everyone = useArchive(() => archiveApi.people(), [], { enabled: query.trim() !== "" });
  const chosen = new Set(people.map((p) => p.id));
  const matches = joinCandidates(-1, (everyone.data?.people ?? []).filter((p) => !chosen.has(p.id) && !names.outside(p.id)), query);
  return (
    <div className="catch-up-form__people">
      <div className="catch-up-form__with">
        <span>With</span>
        {people.map((p) => chip ? chip(p) : (
          <span key={p.id} className="tag-chip tag-chip--alias">
            <Name text={names.label(p).primary} />
            <button type="button" aria-label={`Take ${names.hidden ? "them" : names.label(p).primary} off this ${what}`} onClick={() => setPeople(people.filter((q) => q.id !== p.id))}>×</button>
          </span>
        ))}
      </div>
      {under}
      <div className="catch-up-form__add">
        <input
          aria-label={`Add someone who was ${what === "call" ? "on it" : "there"}`}
          placeholder="Add someone (type a name)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
        />
        {children}
      </div>
      {!everyone.data && query.trim() !== "" && <p className="muted">{everyone.error ?? "Loading everyone…"}</p>}
      {matches.length > 0 && (
        <ul className="catch-up-form__matches">
          {matches.map((match) => (
            <li key={match.id}>
              <button
                type="button"
                onClick={() => {
                  const person = { id: match.id, name: match.name, aliases: match.aliases };
                  if (onAdd) onAdd(person);
                  else setPeople([...people, person]);
                  setQuery("");
                }}
              >
                {names.hidden ? <Name text={names.label(match).primary} /> : [match.name, ...match.aliases].join(" / ")}
                {match.archived !== null && <span className="muted">, archived</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
