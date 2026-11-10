// The chip after a change you may want to take back, from anywhere in
// the page: archiving someone (the person panel's Archive or its tag box), or
// several at once (a group chat's "Archive untouched"), saying who or how many;
// and a tag made or deleted by a person's tag box (a tag typed that nobody
// had, or one taken from the last person who had it, which deletes it), naming
// the tag; and a hangout (a catch-up) or a logged call added, changed or deleted
// with Add event's form (CatchUps.tsx), naming it; and someone's location set
// or cleared (the person panel's Location), naming them and the place; and someone's identicon given a new
// colour or a new picture (the person panel's icon picker, IconPicker.tsx),
// naming them; and someone's names added to, removed, renamed or put in another
// order (the person panel's name chips, NameChips.tsx), naming the name; and a call given a length or had it
// taken away (the chat's call record, Timeline.tsx), naming its day; and someone unlinked from a group chat or linked
// through it again (the person panel's break-link button, PersonGroups.tsx), naming them and the group. Undo puts back that change's changeset
// (the change log's own undo, so it is refused, saying why, when it has
// changed since: an older chip's Undo is refused while a later change depends
// on it). Each change gets its own chip, stacked (the newest at the bottom),
// each going by itself after a few seconds, or when dismissed; a refusal stays
// until dismissed. Pointing at a chip, holding it on a touch screen or moving
// into it with the keyboard holds its time. At most CHIP_STACK show: one more
// sends the oldest away early, its change still undoable from the change log.
// A save that both archives someone and makes or deletes a tag shows the
// archive (its Undo takes back the whole save). ChangeChip draws the stack
// (src/demos/page.tsx).

import {
  ARCHIVE_TAG,
  type CallAnswer,
  type CallAnsweredSaved,
  type CallRef,
  type CatchUp,
  type CatchUpInput,
  type CatchUpSaved,
  type ManualCallInput,
  type ManualCallSaved,
  type NewPerson,
  type PersonAdded,
  type PersonCall,
  type PersonGroup,
  type PersonSummary,
} from "./archive.ts";
import { ArchiveError, archiveApi } from "./archiveApi.ts";
import { callRecords, type CallAnswerState, type CallLength, type CallRecordState } from "./callRecords.ts";
import { callDuration, callPlatformName } from "./calls.ts";
import { catchUpDayCount, catchUpTitle, catchUpWhen, timeLabel } from "./catchUps.ts";
import { HANGOUT } from "./eventWords.ts";
import { nameChange, type NameChange } from "./nameChips.ts";
import { dayKey, timeOfDay } from "./time.ts";
import { archiveChanged } from "./useArchive.ts";

/** How long a chip stays after a change, and after its undo is done. */
export const CHIP_MS = 6000;
export const UNDONE_MS = 3000;
/** How many chips show at once. */
export const CHIP_STACK = 3;

export type ChipPhase = "shown" | "undoing" | "undone" | "refused";

/** Someone archived, as much as their label takes (useNames, so it follows the name choice). */
export interface ChipPerson {
  id: number;
  name: string;
  aliases: readonly string[];
}

/** What the chip is about. */
export type ChipSubject =
  /** Who was archived, or how many people when several were at once. */
  | { kind: "archived"; who: ChipPerson | number }
  /** Tags made and deleted; `emptied` when deleted because nobody had them any more. */
  | { kind: "tags"; created: readonly string[]; deleted: readonly string[]; emptied: boolean }
  /**
   * A hangout or a logged call added, changed or deleted, or one made the other kind ("converted", named as it is
   * now), as the chip names it: "hangout of 2 hours on 4 Oct 2026" (" at 7:30 pm" after
   * it with a time), "call of 25 min on FaceTime, 4 Oct 2026 at 7:30 pm".
   */
  | { kind: "event"; done: "added" | "changed" | "deleted" | "converted"; what: string }
  /** Someone added by hand. */
  | { kind: "added"; who: ChipPerson }
  /** Someone's identicon in a colour picked (a new picture in it), or a new picture in the colour they have. */
  | { kind: "identicon"; who: ChipPerson; done: "colour" | "picture" }
  /** Someone's names changed: one added, removed or renamed, another put first, or their order changed. */
  | { kind: "names"; who: ChipPerson; change: NameChange }
  /** Someone's location set, or cleared (null). */
  | { kind: "location"; who: ChipPerson; location: string | null }
  /** Someone unlinked from a group chat (it connects them to nobody), or linked through it again: them and the group, as it is named. */
  | { kind: "group-link"; who: ChipPerson; group: Pick<PersonGroup, "title" | "people" | "namedBy">; unlinked: boolean }
  /** A call given a length, or had it taken away: the call (its record, and its day as the chip names it), before and after. */
  | { kind: "call-length"; messageId: number; day: string; before: CallLength; after: CallLength }
  /**
   * An imported call said to be answered, missed or not known (null), or set back to what its source says (`set` false);
   * for a call record, what Undo puts back in the chat (`record`: its answer, and the length yours that missed took away).
   */
  | { kind: "call-answered"; day: string; answered: boolean | null; set: boolean; record?: { messageId: number; before: Partial<CallRecordState> } };

export interface Chip {
  what: ChipSubject;
  /** The changeset that made the change, which Undo undoes; it is also which chip this is. */
  changeset: number;
  phase: ChipPhase;
  /** Why the undo was refused, in the archive's words. */
  reason: string | null;
}

/** A chip's time: how much is left, and while it runs (not held), its timer and when that started. */
interface Clock {
  left: number;
  timer?: ReturnType<typeof setTimeout>;
  started?: number;
}

/** The chips, oldest first; a new array on every change, for useSyncExternalStore. */
let chips: readonly Chip[] = [];
const clocks = new Map<number, Clock>();
/** What holds each chip's time: pointing at or pressing it, and keyboard focus in it. */
export type ChipHold = "pointer" | "focus";
const held = new Map<number, Set<ChipHold>>();
const listeners = new Set<() => void>();

function told(next: readonly Chip[]): void {
  chips = next;
  for (const listener of listeners) listener();
}

function stop(changeset: number): void {
  const clock = clocks.get(changeset);
  if (clock?.timer === undefined) return;
  clearTimeout(clock.timer);
  clock.left -= Date.now() - clock.started!;
  clock.timer = clock.started = undefined;
}

function run(changeset: number): void {
  const clock = clocks.get(changeset);
  if (!clock || clock.timer !== undefined || (held.get(changeset)?.size ?? 0) > 0) return;
  clock.started = Date.now();
  clock.timer = setTimeout(() => changeChip.dismiss(changeset), Math.max(0, clock.left));
}

/** Puts `next` in its chip's place (or at the end, as the newest), going after `closeAfter` (unless held), or staying. */
function put(next: Chip, closeAfter?: number): void {
  stop(next.changeset);
  // Its buttons change, so whatever had focus in it may be gone, with no blur to say so.
  held.get(next.changeset)?.delete("focus");
  clocks.delete(next.changeset);
  if (closeAfter !== undefined) clocks.set(next.changeset, { left: closeAfter });
  const at = chips.findIndex((chip) => chip.changeset === next.changeset);
  told(at < 0 ? [...chips, next] : chips.map((chip, i) => (i === at ? next : chip)));
  run(next.changeset);
}

function drop(changesets: readonly number[]): void {
  for (const changeset of changesets) {
    stop(changeset);
    clocks.delete(changeset);
    held.delete(changeset);
  }
  told(chips.filter((chip) => !changesets.includes(chip.changeset)));
}

export const changeChip = {
  /** The newest chip. */
  get: (): Chip | null => chips.at(-1) ?? null,
  /** Every chip, oldest first. */
  all: (): readonly Chip[] => chips,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /**
   * Shows a chip for a change just made, the newest, below the others; past CHIP_STACK, the oldest goes (one being
   * undone last, so it can say how that went).
   */
  show(what: ChipSubject, changeset: number): void {
    put({ what, changeset, phase: "shown", reason: null }, CHIP_MS);
    const over = chips.length - CHIP_STACK;
    if (over <= 0) return;
    const waiting = chips.filter((chip) => chip.phase !== "undoing" && chip.changeset !== changeset);
    drop([...waiting, ...chips].slice(0, over).map((chip) => chip.changeset));
  },
  /** Takes away chip `changeset`, or every chip. */
  dismiss(changeset?: number): void {
    drop(changeset === undefined ? chips.map((chip) => chip.changeset) : [changeset]);
  },
  /** Holds chip `changeset`'s time while `by` (`holding`), and lets it run on once nothing holds it. */
  hold(changeset: number, by: ChipHold, holding: boolean): void {
    if (!chips.some((chip) => chip.changeset === changeset)) return;
    const holds = held.get(changeset) ?? new Set<ChipHold>();
    held.set(changeset, holds);
    if (holding) {
      holds.add(by);
      stop(changeset);
    } else {
      holds.delete(by);
      run(changeset);
    }
  },
  /** Undoes the change on chip `changeset` (the newest when not said); the chip says when it is done, or why it was refused. */
  async undo(changeset?: number): Promise<void> {
    const shown = changeset === undefined ? changeChip.get() : chips.find((chip) => chip.changeset === changeset);
    if (!shown || shown.phase !== "shown") return;
    const still = () => chips.some((chip) => chip.changeset === shown.changeset);
    put({ ...shown, phase: "undoing" });
    try {
      await archiveApi.undoChange(shown.changeset);
      if (shown.what.kind === "call-length") callRecords.set(shown.what.messageId, shown.what.before);
      if (shown.what.kind === "call-answered" && shown.what.record) callRecords.set(shown.what.record.messageId, shown.what.record.before);
      archiveChanged();
      if (still()) put({ ...shown, phase: "undone" }, UNDONE_MS);
    } catch (error) {
      if (still()) put({ ...shown, phase: "refused", reason: error instanceof ArchiveError ? error.reason : String(error) });
    }
  },
};

/** Whether saving `after` over `before` archives them: your "archive" tag, newly added. */
export function archives(before: readonly string[], after: readonly string[]): boolean {
  return !before.includes(ARCHIVE_TAG) && after.includes(ARCHIVE_TAG);
}

/**
 * Saves a person's tags (`before` their stored tags, without the rules' "archive"); when that archives them, or makes
 * or deletes a tag, the chip offers to undo it.
 */
export async function saveTags(id: number, before: readonly string[], tags: string[]): Promise<PersonSummary> {
  const { person, changeset, created, deleted } = await archiveApi.setTags(id, tags);
  if (changeset === null) return person;
  if (archives(before, tags)) changeChip.show({ kind: "archived", who: person }, changeset);
  else if (created.length > 0 || deleted.length > 0) changeChip.show({ kind: "tags", created, deleted, emptied: true }, changeset);
  return person;
}

/**
 * A group chat's "Archive untouched": archives the untouched people `shown` (as the page listed them), one changeset;
 * the chip says how many, and offers to undo them all at once. Returns how many were archived.
 */
export async function archiveUntouched(groupId: number, shown: readonly number[]): Promise<number> {
  const { archived, changeset } = await archiveApi.archiveUntouched(groupId, shown);
  if (changeset !== null) changeChip.show({ kind: "archived", who: archived }, changeset);
  return archived;
}

/** "Add person"; when someone is added, the chip names them and offers to take them away again. */
export async function addPerson(person: NewPerson): Promise<PersonAdded> {
  const done = await archiveApi.addPerson(person);
  if (done.person && done.changeset !== null) changeChip.show({ kind: "added", who: done.person }, done.changeset);
  return done;
}

/**
 * Saves every name someone goes by, `after` (their name first), over `before` as the panel showed them; when that
 * changes them, the chip says how and offers to undo it.
 */
export async function saveNames(id: number, before: readonly string[], after: readonly string[]): Promise<PersonSummary> {
  const { person, changeset } = await archiveApi.setNames(id, [...after]);
  const change = nameChange(before, [person.name, ...person.aliases]);
  if (changeset !== null && change !== null) changeChip.show({ kind: "names", who: person, change }, changeset);
  return person;
}

/** Sets where someone is (null: not said); when that changes it, the chip names them and the place and offers to undo it. */
export async function saveLocation(id: number, location: string | null): Promise<PersonSummary> {
  const { person, changeset } = await archiveApi.setLocation(id, location);
  if (changeset !== null) changeChip.show({ kind: "location", who: person, location: person.location }, changeset);
  return person;
}

/**
 * Someone's identicon drawn from `seed` in `hue`, the icon picker's draft saved: a new colour (`done` "colour"), or a
 * new picture in the colour they have ("picture"); the chip names them and offers to put the old one back.
 */
export async function saveIdenticon(id: number, seed: string, hue: number | null, done: "colour" | "picture"): Promise<PersonSummary> {
  const { person, changeset } = await archiveApi.setIdenticon(id, seed, hue);
  if (changeset !== null) changeChip.show({ kind: "identicon", who: person, done }, changeset);
  return person;
}

/** Adds a catch-up; the chip names it and offers to undo it. */
export async function addCatchUp(input: CatchUpInput): Promise<CatchUpSaved> {
  return catchUpChange(await archiveApi.addCatchUp(input), "added", input);
}

/** Changes a catch-up to `input`; the chip names it as it is now and offers to put it back. */
export async function changeCatchUp(id: number, input: CatchUpInput): Promise<CatchUpSaved> {
  return catchUpChange(await archiveApi.changeCatchUp(id, input), "changed", input);
}

/** Deletes a catch-up; the chip names it and offers to bring it back. */
export async function deleteCatchUp(catchUp: CatchUp): Promise<CatchUpSaved> {
  return catchUpChange(await archiveApi.deleteCatchUp(catchUp.id), "deleted", catchUp);
}

/** Makes logged call `id` (its whole group) a catch-up as `input` says; the chip names the catch-up and offers to put the call back. */
export async function callToCatchUp(id: number, input: CatchUpInput): Promise<CatchUpSaved> {
  return catchUpChange(await archiveApi.callToCatchUp(id, input), "converted", input);
}

function catchUpChange(done: CatchUpSaved, how: ChipEvent["done"], catchUp: Pick<CatchUp, "hours" | "day" | "time" | "trip">): CatchUpSaved {
  // "hangout of 2 hours on 4 Oct 2026 at 7:30 pm"; a trip, "hangout of 24 hours over 3 days on 4–6 Oct 2026 from 6:00 pm".
  const when = catchUp.time ? ` ${catchUp.trip ? "from" : "at"} ${timeLabel(catchUp.time)}` : "";
  const what = `${HANGOUT.one} of ${catchUpTitle(catchUp.hours, catchUpDayCount(catchUp))} on ${catchUpWhen(catchUp.day, catchUp.trip?.lastDay)}${when}`;
  if (done.changeset !== null) changeChip.show({ kind: "event", done: how, what }, done.changeset);
  return done;
}

type ChipEvent = Extract<ChipSubject, { kind: "event" }>;

/** Logs a call; the chip names it and offers to undo it. */
export async function addCall(input: ManualCallInput): Promise<ManualCallSaved> {
  const done = await archiveApi.addCall(input);
  return callChange(done, "added", done.call);
}

/** Changes a logged call's whole group to `input`; the chip names it as it is now and offers to put it back. */
export async function changeCall(id: number, input: ManualCallInput): Promise<ManualCallSaved> {
  const done = await archiveApi.changeCall(id, input);
  return callChange(done, "changed", done.call);
}

/** Makes catch-up `id` a logged call as `input` says; the chip names the call and offers to put the catch-up back. */
export async function catchUpToCall(id: number, input: ManualCallInput): Promise<ManualCallSaved> {
  const done = await archiveApi.catchUpToCall(id, input);
  return callChange(done, "converted", done.call);
}

/** What the chip names a logged call by: its time, length, platform and how many were on it. */
type ChipCall = Pick<PersonCall, "id" | "at" | "durationSeconds" | "platform" | "people">;

/** Deletes a logged call's whole group (`call`, any of it, as it was); the chip names it and offers to bring it back. */
export async function deleteCall(call: ChipCall): Promise<ManualCallSaved> {
  return callChange(await archiveApi.deleteCall(call.id), "deleted", call);
}

/**
 * The chip for a logged call added, changed or deleted: "call of 25 min on Messenger, 4 Oct 2026 at 7:30 pm", or for
 * one with several people "call of 45 min with 3 people, ...".
 */
function callChange(done: ManualCallSaved, how: ChipEvent["done"], call: ChipCall | null): ManualCallSaved {
  if (done.changeset === null || call === null) return done;
  const on = call.people > 1 ? `with ${call.people} people` : `on ${callPlatformName(call.platform)}`;
  const what = `call of ${callDuration(call.durationSeconds)} ${on}, ${catchUpWhen(dayKey(call.at))} at ${timeLabel(timeOfDay(call.at))}`;
  changeChip.show({ kind: "event", done: how, what }, done.changeset);
  return done;
}

/**
 * Unlinks someone from a group chat (`unlinked`: it connects them to nobody, though they stay in it), or links them
 * through it again; when that changes it, the chip names them and the group and offers to undo it. Returns whether
 * they are unlinked now.
 */
export async function saveGroupUnlinked(who: ChipPerson, group: PersonGroup, unlinked: boolean): Promise<boolean> {
  const done = await archiveApi.setGroupUnlinked(who.id, group.id, unlinked);
  if (done.changeset !== null) changeChip.show({ kind: "group-link", who, group, unlinked: done.unlinked }, done.changeset);
  return done.unlinked;
}

/**
 * Gives call record `messageId` its length in whole minutes, or takes it away (null); the chat shows it at once
 * (callRecords.ts), the closeness score counts it, and the chip names the call's day and offers to undo it.
 */
export async function saveCallLength(messageId: number, day: string, before: CallLength, minutes: number | null): Promise<CallLength> {
  const { call, changeset } = await archiveApi.setCallLength(messageId, minutes);
  const after = { callSeconds: call.callSeconds, callLengthGiven: call.callLengthGiven };
  callRecords.set(messageId, after);
  if (changeset !== null) {
    changeChip.show({ kind: "call-length", messageId, day, before, after }, changeset);
    archiveChanged();
  }
  return after;
}

/**
 * Says whether imported call `call` was answered (the same as its source says takes yours away); the closeness
 * score follows it, and the chip names the call's day and offers to undo it. A call record's chat shows it at once
 * (callRecords.ts), from `before`, its answer and length as they were: missed takes a length you gave it away.
 * Returns the call's answer as it now is.
 */
export async function saveCallAnswered(call: CallRef, day: string, answer: CallAnswer, before?: CallAnswerState): Promise<Omit<CallAnsweredSaved, "changeset">> {
  const { changeset, ...now } = await archiveApi.setCallAnswered(call, answer);
  let record: { messageId: number; before: Partial<CallRecordState> } | undefined;
  if (call.kind === "record" && before) {
    const lengthGone = answer === "missed" && before.callLengthGiven;
    callRecords.set(call.id, { callAnswer: now.answeredSet ? answer : null, ...(lengthGone && { callSeconds: null, callLengthGiven: false }) });
    record = { messageId: call.id, before: { callAnswer: before.callAnswer, ...(lengthGone && { callSeconds: before.callSeconds, callLengthGiven: true }) } };
  }
  if (changeset !== null) {
    changeChip.show({ kind: "call-answered", day, answered: now.answered, set: now.answeredSet, ...(record && { record }) }, changeset);
    archiveChanged();
  }
  return now;
}

