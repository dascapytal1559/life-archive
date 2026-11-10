// `npm run archive -- edits`: the record of the tables' edits (log.ts), and an undo of any of them through the owner
// that made it (edits.ts), the CLI's way back from the record as the drawer's Undo is the page's. Prints no note's
// words: the record holds none. A row of the captain's own added or deleted in a table is in it too, and undone alike.

import { editChangeText, type EditRecord } from "../../viewer/editWire.ts";
import { runPromise } from "../effectRuntime.ts";
import { when } from "../archive/changesCli.ts";
import type { TableEdits } from "./edits.ts";

export const EDITS_HELP = `  edits [--kind <table>] [--limit <n>]  the record of the tables' edits (made from a row's drawer, on the Calendar or
                                        in a table) and the rows of your own added or deleted there, the newest first:
                                        each its number, when, from where, the table, the field, what it was and
                                        became (a note's words never), and what undid it
  edits undo <n> [--why <words>]        puts edit n back through its table's owner, as an edit of its own; refused
                                        once its field has changed since`;

/** One edit as a line of the record. */
export function editLine(edit: EditRecord): string {
  const from = edit.surface === "cli" ? `cli ${edit.who ?? "(unnamed)"}` : edit.surface;
  const undone = edit.undone !== null ? ` (undone ${edit.undone})` : "";
  return `#${edit.id}  ${when(edit.at)}  ${from}  ${edit.kind}  ${editChangeText(edit)}${undone}`;
}

/** The `edits` command: the record, or `undo <n>`. */
export async function editsCommand(edits: TableEdits, args: readonly string[], values: { kind?: string; limit?: string; why?: string }, who: string | null): Promise<void> {
  if (args[0] === "undo") {
    const number = args[1]?.replace(/^#/, "");
    if (!number || !/^\d+$/.test(number)) throw new Error("edits undo takes an edit's number, from `npm run archive -- edits`");
    const done = await runPromise(edits.undo(Number(number), { surface: "cli", who, why: values.why ?? null }));
    console.log(`Undid #${number}${done.edit !== null ? ` as #${done.edit}` : ""}: ${editLine(edits.record(done.edit ?? Number(number)))}`);
    return;
  }
  if (args.length > 0) throw new Error(`edits takes no arguments but undo <n>, not ${JSON.stringify(args[0])}`);
  const record = edits.list({ kind: values.kind, limit: values.limit ? Number(values.limit) : 50 });
  for (const edit of record) console.log(editLine(edit));
  console.log(record.length === 0 ? "No edits have been made to the tables." : `${record.length} shown, the newest first. Undo one with: npm run archive -- edits undo <n>`);
}
