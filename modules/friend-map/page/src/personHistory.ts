// The way back in the person panel: the people opened one from another inside
// it (a group chat's member, say), so its back arrow returns to the one before.
// A person opened from outside the panel (a map, the Table, the list) starts
// afresh, and so does closing it. Kept as plain values, so the panel only
// holds one of these in its state.

/** Who a step back leads to, with what its tooltip names them by. */
export interface PersonStep {
  id: number;
  name: string;
  aliases: readonly string[];
}

export interface PersonHistory {
  /** The person the history leads up to; when the panel shows anyone else, the history is not theirs. */
  at: number | null;
  /** The people before them, the most recent last. */
  previous: readonly PersonStep[];
  /** Whether `at` was reached by going back, so a person found gone there is passed over too. */
  cameBack: boolean;
}

export const NO_HISTORY: PersonHistory = { at: null, previous: [], cameBack: false };

/** The history of the person showing, or none when they were opened from outside it. */
export function historyOf(history: PersonHistory, openId: number | null): PersonHistory {
  return openId !== null && history.at === openId ? history : NO_HISTORY;
}

/** `from` opened `to` from inside the panel: `from` is a step back from `to`. */
export function opened(history: PersonHistory, from: PersonStep, to: number): PersonHistory {
  if (from.id === to) return historyOf(history, to);
  return { at: to, previous: [...historyOf(history, from.id).previous, from], cameBack: false };
}

/** One step back from `openId`: who to show, and the history there; null with nobody before them. */
export function back(history: PersonHistory, openId: number | null): { to: number; history: PersonHistory } | null {
  const { previous } = historyOf(history, openId);
  const step = previous.at(-1);
  if (!step) return null;
  return { to: step.id, history: { at: step.id, previous: previous.slice(0, -1), cameBack: true } };
}

/**
 * `gone` was joined into `survivor`, who now shows in their place: neither the
 * one gone nor the survivor (already showing) is a step back any more.
 */
export function merged(history: PersonHistory, gone: number, survivor: number): PersonHistory {
  const { previous } = historyOf(history, gone);
  return { at: survivor, previous: previous.filter((step) => step.id !== gone && step.id !== survivor), cameBack: false };
}
