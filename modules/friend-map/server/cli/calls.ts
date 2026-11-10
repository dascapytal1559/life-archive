// friend map's commands about calls and catch-ups (`npm run archive -- calls`, `call`, `catch-ups`, `catch-up`;
// commands.ts runs them): every call and every hangout, someone's, and the captain's own logged and changed.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type ArchiveReason, ARCHIVE_REASONS, type CatchUp, type ChangesetInfo, type ConnectorStatus, isSqlQuery, type PersonCall, type PersonGroup, type PersonSummary, type TimelineMessage, type Trip, callDuration, callLabel, callPlatformName, callTotals, defaultCallAccount, parseCallLength, catchUpDayCount, catchUpTitle, othersLabel, PRIVATE_FROM, PRIVATE_TO, timeLabel, dayKey, isDay, relativeDay, timeOfDay, LOCALE, TIME_ZONE, zonePlace, isPlatform, type ReadScope, readerFromEnvironment, KEEP_DAYS, changesCommand, when } from "../../../../sdk/server.ts";
import { type AddressBookNotes } from "../addressBookNotes.ts";
import { callsOf, everyonesCalls, loggedCall } from "../calls.ts";
import { applyEdit, describeEdit, parseEditAction, planEdit, type Selection } from "../edits.ts";
import { IMPORT_WAYS, importStatus, type ImportStatusReport } from "../importStatus.ts";
import { applyPhoneChats, planPhoneChats, unsentTexts, type PhoneChat, type PhoneChatPlan } from "../messengerPhoneChats.ts";
import { moveImports, planImportsMove, relabelSources, unpackExport } from "../platformExports.ts";
import { applyRepoint, planRepoint, unreferencedCopies, type RepointPlan, type UnreferencedCopies } from "../repoint.ts";
import { redactHits, redactPage, redactText } from "../redact.ts";
import { sqlQuery } from "../sqlQuery.ts";
import { storageReport, type StorageReport } from "../storage.ts";
import { draftsFromOpeners, locationColumn, locationFold, loggedCallsToAccounts, namesFirstAliasLeads } from "../db.ts";
import { contactNotesLines } from "../friendMap.ts";
import { backupBefore, change, cli, id, into, show } from "./context.ts";
import { personList } from "./people.ts";

/** The commands about calls and catch-ups (time in person). Whether `command` is one of them. */
export async function callCommands(command: string, args: readonly string[]): Promise<boolean | void> {
    const { structure, people, content } = cli.archive;
    const host = cli.archive.live.host;
  switch (command) {
    case "catch-ups": {
      const list = people.catchUps.list({ personId: cli.values.person === undefined ? undefined : id(cli.values.person, "person") });
      for (const catchUp of list) console.log(catchUpLine(catchUp));
      console.log(`${list.length} ${list.length === 1 ? "catch-up" : "catch-ups"}. Add one with: npm run archive -- catch-up add <person> [person ...]`);
      return;
    }
    case "calls": {
      if (args[0] !== undefined) {
        const personId = id(args[0], "person");
        const calls = structure.calls(personId);
        if (!calls) throw new Error(`no person ${args[0]}`);
        for (const call of calls) {
          const way = call.manual ? "logged   " : call.direction === "incoming" ? "from them" : "from you ";
          // A logged call says where and its number; an app's in no chat (a WhatsApp three-way call), where; either with several, how many more.
          const where = call.manual ? ` on ${callPlatformName(call.platform)} (#${call.id})` : call.messageId === null && call.platform !== "phone" ? ` on ${callPlatformName(call.platform)}` : "";
          const others = call.people > 1 ? `, with ${call.people - 1} ${call.people === 2 ? "other" : "others"}` : "";
          console.log(`${dayKey(call.at)} ${timeOfDay(call.at)}  ${way}  ${callLabel(call)}${where}${others}`);
        }
        console.log(callsSummary(calls));
        return;
      }
      const everyone = [...everyonesCalls(cli.archive.db)]
        .map(([personId, calls]) => ({ personId, calls, totals: callTotals(calls) }))
        .sort((a, b) => b.totals.seconds - a.totals.seconds || b.calls[0].at - a.calls[0].at);
      for (const { personId, calls } of everyone) {
        console.log(`#${personId} ${structure.getPerson(personId)?.name ?? ""}: ${callsSummary(calls)}`);
      }
      const all = everyone.flatMap((entry) => entry.calls);
      console.log(`${everyone.length} people, ${callsSummary(all)}`);
      return;
    }
    case "catch-up":
      return catchUpCommand(args[0], args.slice(1));
    case "call":
      return callCommand(args[0], args.slice(1));
    default:
      return false;
  }
}

export async function catchUpCommand(sub: string | undefined, rest: string[]): Promise<void> {
  const { people } = cli.archive;
  const number = (value: string | undefined, what: string) => {
    if (!value || !/^#?\d+$/.test(value)) throw new Error(`give a ${what} number`);
    return Number(value.replace(/^#/, ""));
  };
  switch (sub) {
    case "add": {
      if (rest.length === 0) throw new Error("give the people at it by number: catch-up add <person> [person ...]");
      const input = {
        day: cli.values.day ?? dayKey(Date.now()),
        trip: tripGiven(null),
        time: cli.values.time ?? null,
        hours: cli.values.hours ?? 1,
        note: cli.values.note ?? "",
        personIds: rest.map((value) => number(value, "person")),
        others: cli.values.others ?? 0,
      };
      const added = await change("catch-up add", () => people.addCatchUp(input));
      console.log(`Added ${catchUpLine(people.catchUps.get(added))}`);
      return;
    }
    case "change": {
      if (cli.values["one-day"] && (cli.values.until ?? cli.values.end ?? cli.values.private) !== undefined) throw new Error("--one-day takes the trip away: give it or --until, --end and --private, not both");
      const before = people.catchUps.get(number(rest[0], "catch-up"));
      const input = {
        day: cli.values.day ?? before.day,
        trip: cli.values["one-day"] ? null : tripGiven(before.trip),
        time: cli.values.time ?? before.time,
        hours: cli.values.hours ?? before.hours,
        note: cli.values.note ?? before.note,
        personIds: cli.values.people === undefined ? before.people.map((p) => p.id) : personList(cli.values.people),
        others: cli.values.others ?? before.others,
      };
      const changed = await change("catch-up change", () => people.changeCatchUp(before.id, input));
      console.log(changed ? `Changed to ${catchUpLine(people.catchUps.get(before.id))}` : `#${before.id} was that already.`);
      return;
    }
    case "delete": {
      const catchUp = people.catchUps.get(number(rest[0], "catch-up"));
      await change("catch-up delete", () => people.deleteCatchUp(catchUp.id));
      console.log(`Deleted ${catchUpLine(catchUp)}`);
      return;
    }
    default:
      throw new Error("catch-up add <person> [person ...] | catch-up change <catch-up> | catch-up delete <catch-up>; see npm run archive");
  }
}
export async function callCommand(sub: string | undefined, rest: string[]): Promise<void> {
  const { people } = cli.archive;
  const number = (value: string | undefined, what: string) => {
    if (!value || !/^#?\d+$/.test(value)) throw new Error(`give a ${what} number`);
    return Number(value.replace(/^#/, ""));
  };
  const minutes = (value: string) => {
    const length = parseCallLength(value);
    if (length === null) throw new Error("--minutes is how long it lasted: 25, or 1:30 for an hour and a half");
    return length;
  };
  const show = (id: number) => {
    const call = people.manualCalls.loggedCall(id);
    const everyone = call.people.map((p) => `${p.person.name} on ${callPlatformName(p.platform)}`).join(", ");
    const others = othersLabel(people.manualCalls.get(id).others);
    return `#${id}  ${dayKey(call.at)} ${timeOfDay(call.at)}  Call · ${callDuration(call.durationSeconds)}: ${everyone}${others ? ` ${others}` : ""}`;
  };
  const accounts = (cli.values.account ?? []).map((value) => number(value, "account"));
  // What a call is on with each of `personIds`: an --account of theirs, else what it was on with them (`before`), else
  // the one they are called on (defaultCallAccount); for someone with none, --app (else what it was, else phone).
  const onAccounts = (personIds: number[], before: Map<number, { accountId: number | null; app: string | null }> = new Map()) => {
    const used = new Set<number>();
    const everyone = personIds.map((personId) => {
      const theirs = people.manualCalls.callAccounts(personId);
      const given = accounts.find((id) => theirs.some((account) => account.id === id));
      if (given !== undefined) used.add(given);
      const was = before.get(personId);
      const accountId = given ?? (was && (was.accountId === null ? theirs.length === 0 : theirs.some((a) => a.id === was.accountId)) ? was.accountId : undefined)
        ?? defaultCallAccount(theirs, callsOf(cli.archive.db, personId))?.id ?? null;
      return { personId, accountId, app: accountId === null ? cli.values.app ?? was?.app ?? "phone" : null };
    });
    const stray = accounts.find((id) => !used.has(id));
    if (stray !== undefined) throw new Error(`--account ${stray} is not one of theirs that carries calls, for anyone on the call`);
    if (cli.values.app !== undefined && everyone.every((p) => p.accountId !== null)) {
      throw new Error("--app is for someone with no account that carries calls, and everyone on this call has one: say which with --account");
    }
    return everyone;
  };
  switch (sub) {
    case "add": {
      if (rest.length === 0 || cli.values.time === undefined || cli.values.minutes === undefined) throw new Error("call add <person> [person ...] --time <HH:MM> --minutes <length>");
      const input = {
        people: onAccounts(rest.map((value) => number(value, "person"))),
        day: cli.values.day ?? dayKey(Date.now()),
        time: cli.values.time,
        minutes: minutes(cli.values.minutes),
        note: cli.values.note ?? "",
        others: cli.values.others ?? 0,
      };
      const added = await change("call add", () => people.addCall(input));
      console.log(`Logged ${show(added)}`);
      return;
    }
    case "change": {
      const id = number(rest[0], "call");
      const before = people.manualCalls.loggedCall(id);
      const was = new Map(before.people.map((p) => [p.person.id, { accountId: p.accountId, app: p.accountId === null ? p.platform : null }]));
      const input = {
        people: onAccounts(cli.values.people === undefined ? before.people.map((p) => p.person.id) : personList(cli.values.people), was),
        day: cli.values.day ?? dayKey(before.at),
        time: cli.values.time ?? timeOfDay(before.at),
        minutes: cli.values.minutes === undefined ? before.durationSeconds / 60 : minutes(cli.values.minutes),
        note: cli.values.note ?? before.note,
        others: cli.values.others ?? null,
      };
      const group = people.manualCalls.get(id).call_group;
      const changed = await change("call change", () => people.changeCall(id, input));
      console.log(changed ? `Changed to ${show(people.manualCalls.firstOf(group))}` : `#${id} was that already.`);
      return;
    }
    case "delete": {
      const id = number(rest[0], "call");
      const shown = show(id);
      await change("call delete", () => people.deleteCall(id));
      console.log(`Deleted ${shown}`);
      return;
    }
    default:
      throw new Error("call add <person> [person ...] --time <HH:MM> --minutes <length> | call change <call> | call delete <call>; see npm run archive");
  }
}
/**
 * A catch-up's trip as --until, --end and --private give it, over `before` (the trip it was, or null): null when it was
 * none and none of them is given. Whether it is whole and right is normalizeCatchUp's to check.
 */
export function tripGiven(before: Trip | null): Trip | null {
  if (before === null && cli.values.until === undefined && cli.values.end === undefined) {
    if (cli.values.private !== undefined) throw new Error("--private is a trip's: give --until and --end too");
    return null;
  }
  const window = cli.values.private === undefined ? null : /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(cli.values.private);
  if (cli.values.private !== undefined && !window) throw new Error("--private is a window of each day, such as 00:00-10:00");
  return {
    lastDay: cli.values.until ?? before?.lastDay ?? "",
    endTime: cli.values.end ?? before?.endTime ?? "",
    privateFrom: window?.[1] ?? before?.privateFrom ?? PRIVATE_FROM,
    privateTo: window?.[2] ?? before?.privateTo ?? PRIVATE_TO,
  };
}
/** "#7  2026-10-04 7:30 pm  2.5 hours: Walt Example (#12), Ada (#3); dinner at Ada's" (no time when it has none). */
export function catchUpLine(catchUp: CatchUp): string {
  const who = catchUp.people.map((p) => `${p.name} (#${p.id})`).join(", ");
  const { trip } = catchUp;
  const start = `${catchUp.day}${catchUp.time ? ` ${timeLabel(catchUp.time)}` : ""}`;
  const when = trip === null ? start : `${start} to ${trip.lastDay} ${timeLabel(trip.endTime)} (private ${timeLabel(trip.privateFrom)}–${timeLabel(trip.privateTo)})`;
  return `#${catchUp.id}  ${when}  ${catchUpTitle(catchUp.hours, catchUpDayCount(catchUp))}: ${who}${catchUp.others > 0 ? ` ${othersLabel(catchUp.others)}` : ""}${catchUp.note ? `; ${catchUp.note.replace(/\n/g, " ")}` : ""}`;
}
/** "14 answered calls, 6 h 5 min in all; 3 not answered; last 2026-10-01". */
export function callsSummary(calls: PersonCall[]): string {
  const { answered, seconds, unanswered } = callTotals(calls);
  const last = calls.length > 0 ? `; last ${dayKey(Math.max(...calls.map((call) => call.at)))}` : "";
  return `${answered} answered ${answered === 1 ? "call" : "calls"}, ${callDuration(seconds)} in all; ${unanswered} not answered${last}`;
}