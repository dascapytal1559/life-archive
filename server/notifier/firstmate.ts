// The notifier's FirstMate adapter (notifier.ts), for an installation whose agents FirstMate runs: configured by
// FIRSTMATE_HOME (.env.example, in .env.local), its notes go to FirstMate's inbox, `bin/fm-inbox.sh note --request-id`,
// which keeps one note for an id however often it is sent.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { run } from "../childProcess.ts";
import { pathSetting } from "../dataHome.ts";
import type { Notes } from "./notifier.ts";

/** FirstMate's inbox script under FIRSTMATE_HOME (the environment, then .env.local), or null where there is none. */
export function firstMateInbox(home: string | undefined = pathSetting("FIRSTMATE_HOME")): string | null {
  const inbox = home && join(home, "bin", "fm-inbox.sh");
  return inbox && existsSync(inbox) ? inbox : null;
}

/** Notes into FirstMate's inbox at `inbox`, each logged as sent. */
export const firstMateNotes = (inbox: string, log: (line: string) => void): Notes => ({
  note: (id, text) =>
    run(inbox, ["note", "--request-id", id, "--", text]).pipe(
      Effect.tap(() => Effect.sync(() => log(`noted firstmate: ${id}`))),
      // 3: saved, but firstmate was not woken; it sees the note at its next look.
      Effect.catchIf((failed) => failed.code === 3, () => Effect.sync(() => log(`noted firstmate: ${id} (saved; firstmate not woken)`))),
      Effect.asVoid,
    ),
});
