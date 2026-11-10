// The notifier as tests see it (notifier/notifier.ts): each note kept by its id, once, as FirstMate's inbox keeps one
// note for an id; or refused, as a broken inbox would, when `refuse` says why.

import { Effect, Layer } from "effect";
import { RunFailed } from "../childProcess.ts";
import { Notifier } from "../notifier/notifier.ts";

/** The inbox, its notes kept in `notes` by id; `refuse` gives why a note is refused, or null to take it. */
export function fakeNotifier(notes: Map<string, string>, refuse: () => string | null = () => null): Layer.Layer<Notifier> {
  return Layer.succeed(Notifier, {
    note: (id: string, text: string) =>
      Effect.suspend(() => {
        const why = refuse();
        if (why !== null) return Effect.fail(new RunFailed({ message: why, code: 1 }));
        if (!notes.has(id)) notes.set(id, text);
        return Effect.void;
      }),
  });
}
