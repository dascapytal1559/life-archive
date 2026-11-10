// The notifier: how the archive's jobs and its background work tell whoever looks after the archive something needs
// them (a job that failed, an export the Cua Space waits on). Each note has an id, and a
// note with an id sent before is not sent again where the adapter keeps ids (FirstMate's inbox does).
//
// The adapter is the installation's (notifierLayer): FirstMate's inbox where FIRSTMATE_HOME names its home
// (firstmate.ts), else this Mac's notifications (desktopNotes), and on a system with none the job's log. It is chosen
// at each note, so a FIRSTMATE_HOME set or cleared in .env.local holds from the next one. A module reaches it through
// the SDK (sdk/server.ts): `Notifier` to yield, `notifierLayer` to provide.

import { spawnSync } from "node:child_process";
import { Context, Effect, Layer } from "effect";
import { run, type RunFailed } from "../childProcess.ts";
import { firstMateInbox, firstMateNotes } from "./firstmate.ts";

/** What a notifier does: one note, by its id. */
export interface Notes {
  readonly note: (id: string, text: string) => Effect.Effect<void, RunFailed>;
}

/** The notifier a job yields: the installation's adapter (notifierLayer), or a stand-in in tests. */
export class Notifier extends Context.Service<Notifier, Notes>()("life-archive/Notifier") {}

/**
 * This Mac's notifications, titled `title`, so the owner still hears where no agent looks after the archive; on any
 * other system, the line in the job's log. They keep no ids: a job that sends one a day says so in its id and checks.
 */
export const desktopNotes = (log: (line: string) => void, title: string): Notes => ({
  note: (_id, text) =>
    process.platform === "darwin"
      ? run("/usr/bin/osascript", ["-e", `display notification ${JSON.stringify(text.slice(0, 200))} with title ${JSON.stringify(title)}`]).pipe(Effect.asVoid)
      : Effect.sync(() => log(`${title}: ${text}`)),
});

/** The installation's notifier: FirstMate's inbox where FIRSTMATE_HOME names one, else desktopNotes titled `title`. */
export const notifierLayer = (log: (line: string) => void, title: string) =>
  Layer.succeed(Notifier, {
    note: (id: string, text: string) => {
      const inbox = firstMateInbox();
      return (inbox ? firstMateNotes(inbox, log) : desktopNotes(log, title)).note(id, text);
    },
  });

/** A macOS notification, now, for a run that failed; nothing where there is none (any other system: the job's log has it). */
export function notify(title: string, message: string): void {
  if (process.platform !== "darwin") return;
  const quote = (text: string) => JSON.stringify(text.slice(0, 200));
  spawnSync("/usr/bin/osascript", ["-e", `display notification ${quote(message)} with title ${quote(title)}`], { stdio: "ignore" });
}
