// What friend map's commands (`npm run archive -- person ...` and the rest, sdk/server.ts's `commands`) share as one
// runs: its options, as the core's CLI parses them with its own (FRIEND_MAP_OPTIONS), the friend map it runs on, the
// archive's folder, a checked backup of every database before a change, and the changeset it made, which the core
// tells at the end. Set once per command (setCli), before it runs.

import type { CommandLive } from "../../../../sdk/server.ts";
import type { FriendMap } from "../friendMap.ts";

/** The options friend map's commands take, merged into the core's CLI's (server/archive/cli.ts). */
export const FRIEND_MAP_OPTIONS = {
  tag: { type: "string", multiple: true },
  query: { type: "string" },
  limit: { type: "string" },
  person: { type: "string" },
  archived: { type: "boolean" },
  dropped: { type: "boolean" },
  removed: { type: "boolean" },
  "reach-out": { type: "boolean" },
  location: { type: "string" },
  // Gone (Met and Lives became one Location), kept only to say so.
  met: { type: "string" },
  lives: { type: "string" },
  day: { type: "string" },
  until: { type: "string" },
  end: { type: "string" },
  private: { type: "string" },
  "one-day": { type: "boolean" },
  time: { type: "string" },
  hours: { type: "string" },
  others: { type: "string" },
  minutes: { type: "string" },
  app: { type: "string" },
  account: { type: "string", multiple: true },
  note: { type: "string" },
  why: { type: "string" },
  people: { type: "string" },
  apply: { type: "boolean" },
  anyway: { type: "boolean" },
  expect: { type: "string" },
  into: { type: "string" },
  json: { type: "boolean" },
  redacted: { type: "boolean" },
  testing: { type: "boolean" },
} as const;

/** The options as parsed. */
export type CliValues = { -readonly [K in keyof typeof FRIEND_MAP_OPTIONS]?: (typeof FRIEND_MAP_OPTIONS)[K] extends { type: "boolean" } ? boolean : (typeof FRIEND_MAP_OPTIONS)[K] extends { multiple: true } ? string[] : string };

/** The changeset a command made, the backup before it and the command that undoes it, told at the end. */
export interface Made {
  changeset: number | null;
  backup: string;
  undo: string;
}

export interface Cli {
  values: CliValues;
  archive: FriendMap;
  dataDir: string;
  live: CommandLive;
  made: Made | null;
}

/** The command running now. */
export const cli = {} as Cli;

export function setCli(next: Cli): void {
  Object.assign(cli, next);
}

/** A checked backup of every database before a change, named for it; its file name (the core's, CommandLive). */
export const backupBefore = (action: string): Promise<string> => cli.live.backup(action);

/** Runs an edit to people as one changeset in the change log (the core's changes.ts), after a checked backup of every database (whose name the changeset keeps). */
export async function change<T>(action: string, work: () => T): Promise<T> {
  const backup = await backupBefore(action);
  const recorded = cli.archive.changes.record({ surface: "cli", action, description: cli.values.why, backup, into: into() }, work);
  cli.made = { changeset: recorded.changeset, backup, undo: "changes" };
  return recorded.value;
}

/** The changeset --into names, to add this change to. */
export function into(): number | undefined {
  if (cli.values.into === undefined) return undefined;
  const id = cli.values.into.replace(/^#/, "");
  if (!/^\d+$/.test(id)) throw new Error("--into takes a changeset number, e.g. --into 12");
  return Number(id);
}

/** A person's summary, or the error that names them. */
export const show = (personId: number) => {
  const person = cli.archive.structure.getPerson(personId);
  if (!person) throw new Error(`no person ${personId}`);
  return person;
};

/** `value` as the number of a `what`, or the error that asks for one. */
export const id = (value: string | undefined, what: string): number => {
  if (!value || !/^\d+$/.test(value)) throw new Error(`give a ${what} number`);
  return Number(value);
};
