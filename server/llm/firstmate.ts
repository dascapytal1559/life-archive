// FirstMate's provenance (provenance.ts), for an installation whose agents FirstMate runs: configured by FIRSTMATE_HOME
// (its home; none when unset). Read only, never changed.
//
// Its prompt shapes, as its own code writes them, each kept as a marker:
//   - its operational input (bin/fm-operational-input.sh): U+2063 "FIRSTMATE_OP: v1 <kind>: <body>", which some
//     harnesses strip of its U+2063, a launch brief when its kind is launch-brief; its record-backed doorbell,
//     ": Firstmate operational input waiting: read '<record>' and handle ...", which is what the record holds while
//     firstmate keeps it (a week); and the legacy wake-ups it still parses (the watcher's, the session start's, the
//     turn-end guard's)
//   - its steering doorbell (bin/fm-task-inbox-lib.sh): ": Firstmate instruction waiting: list ..."
//   - its words to a secondmate: the carrier "[fm-from-firstmate]"
// Nothing else is taken from the text: a worker's task comes from its records, never from what its launch brief says.
//
// Its records, in its home: each task's folder (data/<task>/, which every task keeps) and its launch brief's setup line
// (the project whose worktree it was given) and time, each live task's state/<task>.meta (its t3_thread_id), the T3
// thread that is firstmate's own (state/t3-main-thread), and the secondmates' homes (data/secondmates.md).
//
// What they give the rules: a session is a worker's (session kind `worker`, its `task`) when its T3 thread is a live
// task's, or a launch brief is among its first prompts (its task the brief written nearest its start for its project);
// firstmate's own (`firstmate-main`) on its T3 thread, or in its home; a secondmate's in a secondmate's home or begun
// with firstmate's words. Its prompts are firstmate's (`who`), by `initial-instructions`, `inbox-note` or `steer`, and
// its wake-ups the system's; the folders under its home are its projects'.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { visible } from "./markers.ts";
import type { Orchestrator, Provenance, Said } from "./provenance.ts";
import { projectOf, under, type SessionKind, type SessionRecord } from "./rules.ts";

/** What a prompt's text can say it is, by FirstMate's shapes. */
export const FIRSTMATE_MARKERS = [
  "launch-brief", // firstmate's brief that starts a worker
  "operational", // firstmate's other operational input (a wake-up, a session start, a turn-end guard, an outcome)
  "operational-doorbell", // firstmate's doorbell for an operational record no longer there to say what it held
  "steer-doorbell", // firstmate's steering doorbell: an instruction waiting in the worker's inbox
  "from-firstmate", // firstmate's words to a secondmate
] as const;
export type FirstmateMarker = (typeof FIRSTMATE_MARKERS)[number];

/**
 * What `text` (a prompt's, whole) is by FirstMate's shapes, or null. An operational doorbell is what the record it
 * names holds, read with `openRecord` (firstmate prunes its records after about a week; one gone is
 * "operational-doorbell").
 */
export function firstmateMarkerOf(text: string, openRecord: (path: string) => string | null = readRecord): FirstmateMarker | null {
  const t = visible(text);
  if (t.startsWith("FIRSTMATE_OP: v1 launch-brief:")) return "launch-brief";
  if (t.startsWith("FIRSTMATE_OP:")) return "operational";
  const doorbell = /^: Firstmate operational input waiting: read '([^']+)'/.exec(t);
  if (doorbell) {
    const record = openRecord(doorbell[1]);
    if (record === null) return "operational-doorbell";
    return firstmateMarkerOf(record, () => null) === "launch-brief" ? "launch-brief" : "operational";
  }
  if (t.startsWith(": Firstmate instruction waiting:")) return "steer-doorbell";
  if (t.startsWith("[fm-from-firstmate]")) return "from-firstmate";
  if (t.startsWith("FIRSTMATE WATCHER WAKE:") || t.startsWith("Run `bin/fm-session-start.sh` now") || t.startsWith("TURN WOULD END BLIND") || t.startsWith("Supervisor escalate (")) {
    return "operational";
  }
  return null;
}

/** An operational record's envelope, read only from where firstmate keeps them (<home>/state/operational-inbox/<name>.msg); null when it is not there. */
export function readRecord(path: string): string | null {
  if (!/\/state\/operational-inbox\/[0-9a-z-]+\.msg$/.test(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** firstmate's records (see the top of this file). */
export interface FirstmateRecords {
  /** Its home (FIRSTMATE_HOME). */
  home: string;
  tasks: Set<string>;
  /** Each live task's T3 thread. */
  taskOfThread: Map<string, string>;
  mainThread: string | null;
  secondmateHomes: string[];
  /** Each task's launch brief: the project it names ("a disposable git worktree of <project>") and when it was written. */
  briefs: Array<{ task: string; project: string | null; at: number }>;
}

/** No records yet, in `home`. */
export const noRecords = (home: string): FirstmateRecords => ({ home, tasks: new Set(), taskOfThread: new Map(), mainThread: null, secondmateHomes: [], briefs: [] });

/** firstmate's records from its home (see the top of this file); none when it is not there. */
export function readFirstmate(home: string): FirstmateRecords {
  const records = noRecords(home);
  const data = join(home, "data");
  const state = join(home, "state");
  if (existsSync(data)) {
    for (const name of readdirSync(data)) {
      const brief = join(data, name, "launch-brief.md");
      if (existsSync(brief)) {
        records.tasks.add(name);
        // Only its setup line is read: which project's worktree the task was given.
        const project = /disposable git worktree of ([\w.-]+)/.exec(readFileSync(brief, "utf8").slice(0, 20_000))?.[1] ?? null;
        records.briefs.push({ task: name, project, at: statSync(brief).mtimeMs });
      } else if (existsSync(join(data, name, "brief.md"))) records.tasks.add(name);
    }
    const registry = join(data, "secondmates.md");
    if (existsSync(registry)) records.secondmateHomes = [...readFileSync(registry, "utf8").matchAll(/\bhome\s*[=:|]\s*`?([~/][^\s`|]+)/g)].map((m) => m[1].replace(/^~(?=\/)/, homedir()));
  }
  if (existsSync(state)) {
    for (const name of readdirSync(state)) {
      if (!name.endsWith(".meta")) continue;
      const thread = /^t3_thread_id=(?:mcp:)?(\S+)$/m.exec(readFileSync(join(state, name), "utf8"))?.[1];
      if (thread) records.taskOfThread.set(thread, name.slice(0, -".meta".length));
    }
    const main = join(state, "t3-main-thread");
    if (existsSync(main)) records.mainThread = readFileSync(main, "utf8").trim() || null;
  }
  return records;
}

/** What each of its markers says of who sent a prompt and how. */
const SAID: Record<FirstmateMarker, Said> = {
  "launch-brief": { who: "firstmate", channel: "initial-instructions" },
  operational: { who: "system", channel: "wake-up" },
  "operational-doorbell": { who: "system", channel: "wake-up", guess: true },
  "steer-doorbell": { who: "firstmate", channel: "inbox-note" },
  "from-firstmate": { who: "firstmate", channel: "steer" },
};

/** A session's first prompt a doorbell whose record is gone: its launch brief, most likely. */
const RANG_FIRST: Said = { who: "firstmate", channel: "initial-instructions", guess: true };

const MAIN = "firstmate-main";

/** What the rules ask firstmate, answered from its records. */
export function firstmateOrchestrator(records: FirstmateRecords): Orchestrator {
  const { home } = records;
  /** The task whose launch brief was written nearest the session's start, within five minutes, for the project it ran in. */
  const briefMatching = (s: SessionRecord): string | undefined => {
    const project = projectOf(s.project, orchestrator);
    let best: { task: string; off: number } | undefined;
    for (const brief of records.briefs) {
      if (brief.project === null || brief.project !== project) continue;
      const off = Math.abs(brief.at - s.at);
      if (off <= 5 * 60_000 && (!best || off < best.off)) best = { task: brief.task, off };
    }
    return best?.task;
  };
  const worker = (task: string | undefined, guess: boolean): SessionKind => ({ kind: "worker", ...(task ? { task } : {}), guess });
  const orchestrator: Orchestrator = {
    said: (marker, index) => (index === 0 && marker === "operational-doorbell" ? RANG_FIRST : Object.hasOwn(SAID, marker) ? SAID[marker as FirstmateMarker] : undefined),
    recordedKind(s, thread) {
      const briefed = s.prompts.slice(0, 3).some((p) => p.facts.marker === "launch-brief");
      const known = thread ? records.taskOfThread.get(thread) : undefined;
      if (known || briefed) return worker(known ?? briefMatching(s), false);
      // A doorbell first, its record gone: the launch brief of a worker on a harness that strips firstmate's marker.
      if (s.prompts[0]?.facts.marker === "operational-doorbell") return worker(briefMatching(s), true);
      if (thread && thread === records.mainThread) return { kind: MAIN, guess: false };
      return undefined;
    },
    placedKind: (s) =>
      records.secondmateHomes.some((peer) => under(s.project, peer)) || s.prompts[0]?.facts.marker === "from-firstmate" ? { kind: "secondmate", guess: false } : undefined,
    homeKind: (s) => (s.project === home ? MAIN : undefined),
    senderOf: (thread) => (thread === records.mainThread ? { who: "firstmate", guess: false } : records.taskOfThread.has(thread) ? { who: "worker", guess: true } : undefined),
    steererOf: (kind) => (kind.kind === MAIN ? { who: "worker", guess: true, channel: "steer" } : { who: "firstmate", guess: false, channel: "steer" }),
    workerPrompt: { who: "firstmate", channel: "steer", guess: true },
    projectOf(path) {
      if (under(path, `${home}/projects`)) return path.slice(home.length + "/projects/".length).split("/")[0] || null;
      if (under(path, home)) return "firstmate";
      return undefined;
    },
  };
  return orchestrator;
}

/** FirstMate's provenance, its records in `home`. */
export const firstmateProvenance = (home: string): Provenance => ({
  markerOf: (text) => firstmateMarkerOf(text),
  read: () => firstmateOrchestrator(readFirstmate(home)),
});
