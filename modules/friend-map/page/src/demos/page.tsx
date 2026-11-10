// What the map views' page (Demos.tsx) has beside the views: the side panel beside or over them, the
// "h" key for No name (the name choice itself is in the menu, NamesMenu.tsx), the notice for a change the
// archive refused, and the chip that offers to undo an archive.

import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { callDuration } from "../calls.ts";
import { groupName } from "../groupName.ts";
import { changeChip, type Chip, type ChipHold, type ChipPerson, type ChipPhase, type ChipSubject } from "../changeChip.ts";
import { type NameChange } from "../nameChips.ts";
import { nameStyleStore, useNames } from "../names.ts";
import { Name } from "../PersonParts.tsx";
import { locale } from "../time.ts";

/** Where the side panel is: closed (null), at the People list (person null), or at one person. */
export type PanelAt = { person: number | null } | null;

/**
 * The side panel's state: where it is (PanelAt, or what a page's own panel holds), or null when closed. Escape
 * closes it, unless `over` (something floating over the page, nearer the eye) is open, which Escape closes first. A
 * docked panel is kept as last opened (`shown`) while the dock slides away after closing; call `closed` when the
 * dock's slide ends.
 */
export function useSidePanel<At extends object = NonNullable<PanelAt>>(docked: boolean, over: { open: boolean; close: () => void } = { open: false, close: () => {} }) {
  const [panel, setPanel] = useState<At | null>(null);
  const [leaving, setLeaving] = useState<At | null>(panel);
  useEffect(() => {
    if (panel || !docked) setLeaving(panel);
  }, [panel, docked]);

  useEffect(() => {
    if (!panel && !over.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (event.target as HTMLElement).closest("input, textarea")) return;
      if (over.open) over.close();
      else setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // over.close is the page's own setter, in effect the same every render.
  }, [panel, over.open]);

  return {
    panel,
    setPanel,
    shown: panel ?? (docked ? leaving : null),
    closed: () => {
      if (!panel) setLeaving(null);
    },
  };
}

/** The docked panel's column: slides in while `open`, and says when it has slid away. */
export function Dock({ open, onClosed, children }: { open: boolean; onClosed: () => void; children: ReactNode }) {
  return (
    <div
      className="demos__dock"
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !open) onClosed();
      }}
    >
      {children}
    </div>
  );
}

/** "h" switches No name on, or back to the choice before, while `enabled`, unless you are typing. */
export function useHideNamesKey(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "h" || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
      nameStyleStore.toggleHidden();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** A change the archive refused (an empty name, say), shown until dismissed. */
export function ErrorNotice() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onError = (event: Event) => setError((event as CustomEvent<string>).detail);
    document.addEventListener("friend-map:error", onError);
    return () => document.removeEventListener("friend-map:error", onError);
  }, []);
  if (!error) return null;
  return (
    <div className="app__error" role="alert">
      {error}
      <button type="button" onClick={() => setError(null)}>Dismiss</button>
    </div>
  );
}

/**
 * The chips after changes (changeChip.ts), the newest at the bottom: what each was, with Undo, until it goes by
 * itself or is dismissed. Pointing at one, pressing it or moving into it holds its time; when one goes or comes,
 * the others slide to their new places.
 */
export function ChangeChip() {
  const chips = useSyncExternalStore(changeChip.subscribe, changeChip.all, changeChip.all);
  const shown = useRef(new Map<number, HTMLElement>());
  const stack = useRef<HTMLDivElement>(null);
  // How far up from the stack's bottom (where it is anchored, so a resize leaves it alone) each chip was.
  const heights = useRef(new Map<number, number>());
  useLayoutEffect(() => {
    const bottom = stack.current?.getBoundingClientRect().bottom ?? 0;
    const moving = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const now = new Map<number, number>();
    for (const [changeset, element] of shown.current) {
      const height = bottom - element.getBoundingClientRect().top;
      now.set(changeset, height);
      const was = heights.current.get(changeset);
      if (!moving || !element.animate) continue;
      if (was === undefined) element.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "ease-out" });
      else if (was !== height) element.animate([{ transform: `translateY(${height - was}px)` }, { transform: "none" }], { duration: 200, easing: "ease-out" });
    }
    heights.current = now;
  }, [chips]);
  if (chips.length === 0) return null;
  return (
    <div className="change-chips" ref={stack}>
      {chips.map((chip) => {
        const hold = (by: ChipHold, holding: boolean) => () => changeChip.hold(chip.changeset, by, holding);
        return (
          <div
            key={chip.changeset}
            className="change-chips__chip"
            ref={(element) => void (element ? shown.current.set(chip.changeset, element) : shown.current.delete(chip.changeset))}
            onPointerEnter={hold("pointer", true)}
            onPointerLeave={hold("pointer", false)}
            onPointerCancel={hold("pointer", false)}
            // Only keyboard focus holds it: a click leaves focus behind after the pointer has gone.
            onFocus={(event) => event.target.matches(":focus-visible") && hold("focus", true)()}
            onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && hold("focus", false)()}
          >
            <ChangeChipView chip={chip} onUndo={() => void changeChip.undo(chip.changeset)} onDismiss={() => changeChip.dismiss(chip.changeset)} />
          </div>
        );
      })}
    </div>
  );
}

/** The chip as drawn for `chip`; apart from the store, so a test can draw each phase. */
export function ChangeChipView({ chip, onUndo, onDismiss }: { chip: Chip; onUndo: () => void; onDismiss: () => void }) {
  const names = useNames();
  const refused = chip.phase === "refused";
  return (
    <div className={refused ? "change-chip change-chip--refused" : "change-chip"} role="status">
      <span className="change-chip__text">
        {chip.what.kind === "archived" ? <ArchivedText who={chip.what.who} phase={chip.phase} />
          : chip.what.kind === "tags" ? <TagsText tags={chip.what} phase={chip.phase} />
          : chip.what.kind === "added" ? <AddedText who={chip.what.who} phase={chip.phase} />
          : chip.what.kind === "identicon" ? <IdenticonText who={chip.what.who} done={chip.what.done} phase={chip.phase} />
          : chip.what.kind === "names" ? <NamesText who={chip.what.who} change={chip.what.change} phase={chip.phase} />
          : chip.what.kind === "location" ? <LocationText who={chip.what.who} location={chip.what.location} phase={chip.phase} />
          : chip.what.kind === "call-length" ? <CallLengthText call={chip.what} phase={chip.phase} />
          : chip.what.kind === "call-answered" ? <CallAnsweredText call={chip.what} phase={chip.phase} />
          : chip.what.kind === "group-link" ? <GroupLinkText link={chip.what} phase={chip.phase} />
          : <EventText event={chip.what} phase={chip.phase} />}
        {refused && <>: {refusal(chip.reason ?? "", names.hidden)}</>}
      </span>
      {chip.phase === "shown" && <button type="button" className="change-chip__undo" onClick={onUndo}>Undo</button>}
      <button type="button" className="change-chip__dismiss" aria-label="Dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}

function ArchivedText({ who, phase }: { who: ChipPerson | number; phase: ChipPhase }) {
  const names = useNames();
  // Several people at once ("Archive untouched") are counted, not named.
  const several = typeof who === "number" && who !== 1;
  const shown = typeof who === "number"
    ? <strong>{who.toLocaleString(locale())} {who === 1 ? "person" : "people"}</strong>
    : <strong><Name text={names.label(who).primary} /></strong>;
  if (phase === "shown") return <>Archived {shown}</>;
  if (phase === "undoing") return <>Bringing back {shown}…</>;
  if (phase === "undone") return <>{shown} {several ? "are" : "is"} back</>;
  return <>Can’t undo archiving {shown}</>;
}

function AddedText({ who, phase }: { who: ChipPerson; phase: ChipPhase }) {
  const names = useNames();
  const shown = <strong><Name text={names.label(who).primary} /></strong>;
  if (phase === "shown") return <>Added {shown}</>;
  if (phase === "undoing") return <>Taking away {shown}…</>;
  if (phase === "undone") return <>{shown} is gone again</>;
  return <>Can’t undo adding {shown}</>;
}

function LocationText({ who, location, phase }: { who: ChipPerson; location: string | null; phase: ChipPhase }) {
  const names = useNames();
  const shown = <strong><Name text={names.label(who).primary} /></strong>;
  if (phase === "shown") return location === null ? <>Cleared where {shown} is</> : <>{shown} is in <strong>{location}</strong></>;
  if (phase === "undoing") return <>Undoing…</>;
  if (phase === "undone") return <>Put back where {shown} is</>;
  return <>Can’t undo where {shown} is</>;
}

function GroupLinkText({ link, phase }: { link: Extract<ChipSubject, { kind: "group-link" }>; phase: ChipPhase }) {
  const names = useNames();
  const shown = <strong><Name text={names.label(link.who).primary} /></strong>;
  const group = <strong><Name text={groupName(link.group, names)} /></strong>;
  if (phase === "shown") return link.unlinked ? <>{group} no longer connects {shown}</> : <>{group} connects {shown} again</>;
  if (phase === "undoing") return <>Undoing…</>;
  const what = <>{link.unlinked ? "unlinking" : "linking"} {shown} {link.unlinked ? "from" : "through"} {group}</>;
  return phase === "undone" ? <>Undid {what}</> : <>Can’t undo {what}</>;
}

function NamesText({ who, change, phase }: { who: ChipPerson; change: NameChange; phase: ChipPhase }) {
  const names = useNames();
  const shown = <strong><Name text={names.label(who).primary} /></strong>;
  // A name other than their label, as the name choice shows it (a shape while names are hidden).
  const name = (text: string) => <strong><Name text={names.shown(text)} /></strong>;
  if (phase === "shown") {
    return change.done === "added" ? <>{shown} also goes by {name(change.name)}</>
      : change.done === "removed" ? <>Took the name {name(change.name)} from {shown}</>
      : change.done === "renamed" ? <>Renamed {name(change.from)} to {name(change.to)}</>
      : change.done === "first" ? <>Put {shown} first: their name now</>
      : <>Put {shown}’s names in a new order</>;
  }
  if (phase === "undoing") return <>Undoing…</>;
  if (phase === "undone") return <>Put back {shown}’s names</>;
  return <>Can’t undo the change to {shown}’s names</>;
}

function IdenticonText({ who, done, phase }: { who: ChipPerson; done: "colour" | "picture"; phase: ChipPhase }) {
  const names = useNames();
  const shown = <strong><Name text={names.label(who).primary} /></strong>;
  if (phase === "shown") return done === "colour" ? <>New colour for {shown}</> : <>New icon for {shown}</>;
  if (phase === "undoing") return <>Undoing…</>;
  if (phase === "undone") return <>Put back {shown}’s icon</>;
  return <>Can’t undo {shown}’s new icon</>;
}

function TagsText({ tags, phase }: { tags: Extract<ChipSubject, { kind: "tags" }>; phase: ChipPhase }) {
  const list = (names: readonly string[]) => names.map((name, i) => <Fragment key={name}>{i > 0 && ", "}<strong>{name}</strong></Fragment>);
  const tag = (names: readonly string[]) => (names.length === 1 ? "tag" : "tags");
  const created = tags.created.length > 0 && <>{tag(tags.created)} {list(tags.created)}</>;
  const deleted = tags.deleted.length > 0 && <>{tag(tags.deleted)} {list(tags.deleted)}</>;
  if (phase === "shown") {
    return <>
      {created && <>Created {created}</>}
      {created && deleted && ", "}
      {deleted && <>{created ? "deleted" : "Deleted"} {deleted}{tags.emptied && <>, as nobody has {tags.deleted.length === 1 ? "it" : "them"} now</>}</>}
    </>;
  }
  if (phase === "undoing") return <>Undoing…</>;
  const what = <>{created && <>creating {created}</>}{created && deleted && " and "}{deleted && <>deleting {deleted}</>}</>;
  return phase === "undone" ? <>Undid {what}</> : <>Can’t undo {what}</>;
}

function CallLengthText({ call, phase }: { call: Extract<ChipSubject, { kind: "call-length" }>; phase: ChipPhase }) {
  const what = <>the call on <strong>{call.day}</strong></>;
  const length = call.after.callSeconds === null ? null : <strong>{callDuration(call.after.callSeconds)}</strong>;
  if (phase === "shown") return length === null ? <>Took away the length of {what}</> : <>Set {what} to {length}</>;
  if (phase === "undoing") return <>Undoing…</>;
  return phase === "undone" ? <>Undid the length of {what}</> : <>Can’t undo the length of {what}</>;
}

function CallAnsweredText({ call, phase }: { call: Extract<ChipSubject, { kind: "call-answered" }>; phase: ChipPhase }) {
  const what = <>the call on <strong>{call.day}</strong></>;
  const answer = <strong>{call.answered === null ? "unknown" : call.answered ? "answered" : "missed"}</strong>;
  if (phase === "shown") return call.set ? <>Set {what} to {answer}</> : <>Set {what} back to {answer}, as its source says</>;
  if (phase === "undoing") return <>Undoing…</>;
  return phase === "undone" ? <>Undid whether {what} was answered</> : <>Can’t undo whether {what} was answered</>;
}

function EventText({ event, phase }: { event: Extract<ChipSubject, { kind: "event" }>; phase: ChipPhase }) {
  const { done, what } = event;
  if (phase === "shown") return <>{done === "added" ? "Added a" : done === "changed" ? "Changed the" : done === "converted" ? "Made it a" : "Deleted the"} <strong>{what}</strong></>;
  if (phase === "undoing") return <>Undoing…</>;
  const doing = done === "converted" ? <>making it a <strong>{what}</strong></>
    : <>{done === "added" ? "adding" : done === "changed" ? "changing" : "deleting"} the <strong>{what}</strong></>;
  return phase === "undone" ? <>Undid {doing}</> : <>Can’t undo {doing}</>;
}

/**
 * Why an undo was refused, in the archive's words without its "can't undo #n:" opening; with names hidden, those
 * words (which can name people) are left out.
 */
export function refusal(reason: string, hidden: boolean): string {
  if (hidden) return "it has changed since, or was undone already";
  return reason.replace(/^can't undo #\d+: /, "");
}
