// The spider's hold on whoever is selected (their panel open), and its beam
// to whoever is hovered, on the Spider web (webLook.ts draws the hold from the
// spider's mouth and the beam from its eyes). Selecting someone takes them
// up: a line is laid out to them from the mouth with a little slack, draws
// its slack in, and snaps taut with a flash and a twang, then holds them as
// an energised beam. While they stay selected the hold is the only line: the
// spider faces only them, and hovering anyone else fires no beam and turns
// nothing. With nobody selected, the beam goes to whoever is hovered. A beam
// already on the person selected (they were hovered as they were clicked)
// stays until the hold has them, then is let go of. Deselecting them lets
// the hold go: it reels back into the mouth. The square targeting reticle
// goes with the hover, not the beam: it snaps onto whoever is hovered,
// whether or not someone is held, and springs off as the pointer leaves
// them; whoever is held never has one (the hold marks them). Under reduced
// motion the hold and the reticle are simply there, with no wait. This file
// is the state machine and its timing alone, pure, so it can be tested.

/** The hold's tempo, ms: the line running out, drawing its slack in, the flash as it snaps taut, and a hold let go of reeling in. */
export const HOLD_TIMING = { lay: 220, reach: 200, snap: 120, reel: 360 };

/** The hover beam's tempo, ms: the beam running out, flickering as it locks, the flash as it holds, and a beam let go of breaking up. */
export const BEAM_TIMING = { travel: 160, reach: 200, snap: 90, release: 220 };

/** The hover reticle's tempo, ms: snapping onto whoever is hovered, and springing off once they are not; short, so sweeping across many people stays readable. */
export const MARK_TIMING = { on: 110, off: 130 };

/** A line from the spider's head to someone: to whom, and since when. */
export interface Line {
  id: number;
  start: number;
}

/** The hold on whoever is selected, the beam to whoever is hovered, and the reticle on whoever is hovered. */
export interface HoldState {
  hold: Line | null;
  beam: Line | null;
  mark: Line | null;
}

export function newHoldState(): HoldState {
  return { hold: null, beam: null, mark: null };
}

export type HoldPhase = "lay" | "reach" | "snap" | "held";

/** Where a hold is at `now`: its phase, how far through it (0 to 1), and the ms since it began. */
export function holdPhase(hold: Line, now: number): { phase: HoldPhase; p: number; since: number } {
  const T = HOLD_TIMING;
  const since = now - hold.start;
  if (since < T.lay) return { phase: "lay", p: Math.max(0, since / T.lay), since };
  if (since < T.lay + T.reach) return { phase: "reach", p: (since - T.lay) / T.reach, since };
  if (since < T.lay + T.reach + T.snap) return { phase: "snap", p: (since - T.lay - T.reach) / T.snap, since };
  return { phase: "held", p: 1, since };
}

/** Whether the hold has them: snapped taut, or held. */
export function holdLocked(hold: Line, now: number): boolean {
  return now - hold.start >= HOLD_TIMING.lay + HOLD_TIMING.reach;
}

/** What was let go of this frame: the beam on someone (to break up), the hold on someone (to reel in), and the reticle on someone (to spring off). */
export interface LetGo {
  beam: number | null;
  hold: number | null;
  mark: number | null;
}

export interface HoldInput {
  hoverId: number | null;
  /** Whoever is selected and on the map, or null. */
  heldId: number | null;
  reduced: boolean;
}

/** Whom the spider looks at, its head and body turned to them: whoever it holds, else whoever is hovered. */
export function lookedAt(input: Pick<HoldInput, "hoverId" | "heldId">): number | null {
  return input.heldId ?? input.hoverId;
}

/** Whom the reticle marks: whoever is hovered, unless they are whoever is held. */
export function markedId(input: Pick<HoldInput, "hoverId" | "heldId">): number | null {
  return input.hoverId !== input.heldId ? input.hoverId : null;
}

/**
 * Moves the hold, the beam and the reticle on to `now`. The hold is let go of once its
 * person is no longer selected, and taken up for whoever is (already taut
 * under reduced motion). The beam is on whoever is hovered while nobody is
 * held; while someone is, a beam already on them stays until the hold has
 * them and is then let go of, the hold having taken over, and a beam on
 * anyone else is let go of at once. The reticle follows markedId (on at once
 * under reduced motion).
 */
export function stepHold(state: HoldState, now: number, input: HoldInput): LetGo {
  const gone: LetGo = { beam: null, hold: null, mark: null };
  const { hoverId, heldId, reduced } = input;
  if (state.hold && state.hold.id !== heldId) {
    gone.hold = state.hold.id;
    state.hold = null;
  }
  if (heldId !== null && !state.hold) state.hold = { id: heldId, start: reduced ? -Infinity : now };
  const hold = state.hold;
  const wanted = hold === null ? hoverId : state.beam?.id === hold.id && !holdLocked(hold, now) ? hold.id : null;
  if (state.beam && state.beam.id !== wanted) {
    gone.beam = state.beam.id;
    state.beam = null;
  }
  if (wanted !== null && !state.beam) state.beam = { id: wanted, start: now };
  const marked = markedId(input);
  if (state.mark && state.mark.id !== marked) {
    gone.mark = state.mark.id;
    state.mark = null;
  }
  if (marked !== null && !state.mark) state.mark = { id: marked, start: reduced ? -Infinity : now };
  return gone;
}
