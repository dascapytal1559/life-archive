// The change log's command (changes.ts), as `npm run archive -- changes` shows friend map's (the people's) and
// `npm run archive -- inspiration changes` the inspirations module's: the newest changesets, one in full, or an
// undo of one, after a checked backup.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChangesetInfo } from "../../src/archive.ts";
import { TIME_ZONE } from "../../src/time.ts";
import { KEEP_DAYS, type Changes } from "./changes.ts";

/** What the command is given: the log, its name as typed, the options it reads, a checked backup before an undo, and where the undo's changeset is told. */
export interface ChangesCommand {
  readonly changes: Changes;
  readonly command: string;
  readonly dataDir: string;
  readonly values: { readonly limit?: string; readonly why?: string };
  readonly backupBefore: (action: string) => Promise<string>;
  readonly made: (made: { changeset: number | null; backup: string; undo: string }) => void;
}

/** A time as the change log shows it: the local date and time, to the minute. */
export function when(ms: number): string {
  return new Date(ms).toLocaleString("sv-SE", { timeZone: TIME_ZONE, dateStyle: "short", timeStyle: "short" });
}

/** `changes`: the change log, one changeset in full, or an undo. */
export async function changesCommand(sub: string | undefined, rest: readonly string[], cli: ChangesCommand): Promise<void> {
  const { changes, command, values } = cli;
  const number = (value: string | undefined) => {
    const clean = value?.replace(/^#/, "");
    if (!clean || !/^\d+$/.test(clean)) throw new Error("give a changeset number");
    return Number(clean);
  };
  switch (sub) {
    case undefined: {
      const limit = values.limit ? Number(values.limit) : 20;
      const list = changes.list({ limit });
      for (const c of list) {
        console.log(`${changesetLine(c)}`);
        if (c.peopleCount > 0) console.log(`    ${c.peopleCount} ${c.peopleCount === 1 ? "person" : "people"}: ${c.people.map((p) => p.name).join(", ")}${c.peopleCount > c.people.length ? ", …" : ""}`);
        for (const line of c.other) console.log(`    ${line}`);
      }
      console.log(list.length === 0 ? `No changesets (they are kept ${KEEP_DAYS} days).` : `Show one with: npm run archive -- ${command} show <#>; undo one with: ${command} undo <#>.`);
      return;
    }
    case "show": {
      printChangeset(changes.show(number(rest[0])), cli.dataDir, { command });
      return;
    }
    case "undo": {
      const target = number(rest[0]);
      changes.show(target);
      const backup = await cli.backupBefore(`undo ${target}`);
      const done = changes.undo(target, { surface: "cli", description: values.why, backup });
      cli.made({ changeset: done.changeset, backup, undo: command });
      console.log(`Undid #${target}:`);
      printChangeset(done.value, cli.dataDir, { hint: false });
      return;
    }
    default:
      throw new Error(`${command} | ${command} show <#> | ${command} undo <#>; see npm run archive`);
  }
}

export function changesetLine(c: ChangesetInfo): string {
  const flags = [c.undoneBy !== null ? `undone by #${c.undoneBy}` : "", c.description ? `"${c.description}"` : ""].filter(Boolean);
  return `#${c.id}  ${when(c.at)}  ${c.surface}  ${c.action}${flags.length > 0 ? `  ${flags.join("  ")}` : ""}`;
}

/** A changeset in full; with `hint`, how to undo it (with `command`). */
export function printChangeset(c: ChangesetInfo, dataDir: string, { hint = true, command = "changes" } = {}): void {
  console.log(changesetLine(c));
  if (c.backup) console.log(`  backup: ${c.backup}${existsSync(join(dataDir, "backups", c.backup)) ? "" : " (pruned since)"}`);
  for (const person of c.people) {
    console.log(`  ${person.id}  ${person.name}`);
    for (const line of person.changes) console.log(`    ${line.what}: ${line.before || "(none)"} -> ${line.after || "(none)"}`);
  }
  for (const line of c.other) console.log(`  ${line}`);
  if (hint && c.undoneBy === null) console.log(`Undo it with: npm run archive -- ${command} undo ${c.id}`);
}
