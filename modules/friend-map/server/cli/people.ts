// friend map's commands about people (`npm run archive -- people`, `person`, `tag`, `merge`, `edit`, `groups` and the
// rest; commands.ts runs them): who they are, their tags, locations, groups and notes, the rules, and many changed at
// once. Every one that changes people is one changeset in the change log, after a checked backup (context.ts's change).

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
import { catchUpLine } from "./calls.ts";

/** The commands about people: who they are, their tags, locations, groups and notes, the rules, and many changed at once. Whether `command` is one of them. */
export async function peopleCommands(command: string, args: readonly string[]): Promise<boolean | void> {
    const { structure, people, content } = cli.archive;
    const host = cli.archive.live.host;
  switch (command) {
    case "people": {
      // SQL in --query: the people it returns, archived people too; other words search names, notes and handles.
      const sql = cli.values.query !== undefined && isSqlQuery(cli.values.query) ? new Set(await sqlQuery(cli.archive.db, cli.values.query)) : null;
      const query = sql ? undefined : cli.values.query;
      const chosen = (list: PersonSummary[]) => (sql ? list.filter((p) => sql.has(p.id)) : list);
      if (cli.values["reach-out"]) {
        const toReachOut = chosen(structure.listPeople({ tag: cli.values.tag?.at(-1), query, reachOut: true }).people);
        for (const person of toReachOut) {
          console.log(personLine(person));
          for (const draft of cli.archive.people.drafts.list(person.id)) for (const line of draft.text.split("\n")) console.log(`    ${line}`);
        }
        console.log(`${toReachOut.length} to reach out to.`);
        return;
      }
      if (cli.values.met !== undefined || cli.values.lives !== undefined) throw new Error("--met and --lives are gone: Met and Lives became one Location (--location)");
      const byField = { location: cli.values.location };
      const all = structure.listPeople({ tag: cli.values.tag?.at(-1), query, ...byField });
      const listing = { ...all, people: chosen(all.people) };
      // Asked by SQL or by a field's value, everyone it chooses, archived or not.
      const anyField = sql !== null || Object.values(byField).some(Boolean);
      const shown = listing.people.filter((p) => anyField || (p.archived !== null) === (cli.values.archived === true));
      for (const person of shown) console.log(personLine(person));
      const reasons = new Map<string, number>();
      for (const p of listing.people) if (p.archived) reasons.set(p.archived, (reasons.get(p.archived) ?? 0) + 1);
      const archivedCount = listing.people.length - listing.people.filter((p) => p.archived === null).length;
      const joined = listing.people.filter((p) => p.joined).length;
      console.log(
        `${listing.people.length - archivedCount} people on the map (${joined} joined by name), ${archivedCount} archived` +
          (reasons.size > 0 ? ` (${[...reasons].map(([reason, n]) => `${ARCHIVE_REASONS[reason as ArchiveReason].toLowerCase()}: ${n}`).join("; ")})` : "") +
          `. Tags: ${listing.tags.map((t) => `${t.tag} (${t.count})`).join(", ") || "none"}.`,
      );
      if (listing.me) console.log(`You: ${listing.me.accounts.map((a) => `${a.platform} "${a.displayName}"`).join(", ")}`);
      return;
    }
    case "proposals": {
      const proposals = structure.proposals();
      for (const p of proposals) {
        console.log(`#${p.id} ${p.tier}: ${p.people.map((person) => `${person.name} [person ${person.id}]`).join("  <->  ")}`);
        for (const e of p.evidence) console.log(`    ${e.rule}: ${e.detail}`);
      }
      console.log(`${proposals.length} proposals. Confirm with: npm run archive -- confirm <#>; reject with: reject <#>.`);
      return;
    }
    case "confirm": {
      const proposal = id(args[0], "proposal");
      console.log(`Merged: ${personLine(show(await change(`confirm proposal ${proposal}`, () => people.confirm(proposal))))}`);
      return;
    }
    case "reject": {
      const proposal = id(args[0], "proposal");
      await change(`reject proposal ${proposal}`, () => people.reject(proposal));
      console.log(`Rejected proposal ${args[0]}; it will not be proposed again.`);
      return;
    }
    case "merge": {
      const [kept, other] = [id(args[0], "person"), id(args[1], "person")];
      console.log(`Merged: ${personLine(show(await change("merge", () => people.merge(kept, other))))}`);
      return;
    }
    case "detach": {
      const [person, account] = [id(args[0], "person"), id(args[1], "account")];
      const fresh = await change("detach", () => people.detach(person, account));
      console.log(`Detached account ${args[1]}; it is person ${fresh} of its own now.`);
      return;
    }
    case "tags": {
      const person = id(args[0], "person");
      console.log(personLine(show(await change("tags", () => people.setTags(person, args.slice(1))))));
      return;
    }
    case "edit":
      return editCommand(args[0], args.slice(1));
    case "groups": {
      if (cli.values.removed) {
        const removed = structure.removedMembers();
        for (const r of removed) {
          console.log(`#${r.groupId}  ${r.title ?? "untitled"}: ${r.name} (#${r.personId}), taken out ${dayKey(r.removedAt)}`);
        }
        console.log(`${removed.length} taken out of group chats. Put one back with: npm run archive -- group put-back <group> <person>`);
        return;
      }
      const groups = cli.values.person
        ? structure.groupsOf(id(cli.values.person, "person"))
        : structure.findGroups(args.join(" "), { dropped: cli.values.dropped });
      if (!groups) throw new Error(`no person ${cli.values.person}`);
      for (const g of groups) console.log(groupLine(g));
      console.log(cli.values.dropped
        ? `${groups.length} dropped group ${groups.length === 1 ? "chat" : "chats"}. Bring one back with: npm run archive -- group restore <number>`
        : `${groups.length} group chats. Ask for their people with group:#<number>, or group:"<title>" for every chat of that title.`);
      return;
    }
    case "group": {
      const [sub, number, personArg] = args;
      const usage = "group drop <number> | group restore <number> | group remove-member <number> <person> | group put-back <number> <person>; see npm run archive";
      if (sub !== "drop" && sub !== "restore" && sub !== "remove-member" && sub !== "put-back") throw new Error(usage);
      const group = id(number?.replace(/^#/, ""), "group chat");
      if (sub === "remove-member" || sub === "put-back") {
        const person = id(personArg?.replace(/^#/, ""), "person");
        const remove = sub === "remove-member";
        const changed = await change(`group ${sub}`, () => (remove ? people.removeFromGroup(group, person) : people.putBackInGroup(group, person)));
        const name = structure.getPerson(person)?.name ?? `#${person}`;
        console.log(changed
          ? `${remove ? `Took ${name} out of` : `Put ${name} back in`} the group chat #${group}.`
          : `${name} was ${remove ? "out of" : "in"} the group chat #${group} already.`);
        return;
      }
      const changed = await change(`group ${sub}`, () => (sub === "drop" ? people.dropGroup(group) : people.restoreGroup(group)));
      const shown = structure.findGroups("", { dropped: sub === "drop" }).find((g) => g.id === group);
      const what = shown ? groupLine(shown) : `#${group}`;
      console.log(changed
        ? `${sub === "drop" ? "Dropped" : "Brought back"} ${what}${sub === "drop" ? ": it links nobody now." : "."}`
        : `${what} was ${sub === "drop" ? "dropped" : "not dropped"} already.`);
      return;
    }
    case "person":
      return personCommand(args[0], args.slice(1));
    case "tag":
      return tagCommand(args[0], args.slice(1));
    case "locations":
      return printLocations();
    case "location":
      return locationCommand(args[0], args.slice(1));
    case "field":
      throw new Error(`field is gone: location is a column of person now (${args[0] === "list" || !args[0] ? "locations" : "location rename <location> <new name>"})`);
    case "contact-notes": {
      if (!args[0]) throw new Error("name the address book, e.g. contact-notes ~/life-archive-data/platform-exports/addressbook/<date>/");
      const backup = await backupBefore("contact-notes");
      printContactNotes(await cli.archive.fillContactNotes(resolve(args[0]), (work) => {
        const recorded = cli.archive.changes.record({ surface: "cli", action: "contact-notes", description: cli.values.why, backup, into: into() }, work);
        cli.made = { changeset: recorded.changeset, backup, undo: "changes" };
        return recorded.value;
      }));
      return;
    }
    case "rules": {
      cli.archive.runRules();
      const everyone = structure.listPeople().people;
      console.log(`Rules run. People: ${everyone.length}, ${everyone.filter((p) => p.joined).length} of them joined by name; proposals waiting: ${structure.proposals().length}.`);
      return;
    }
    default:
      return false;
  }
}

export async function personCommand(sub: string | undefined, rest: string[]): Promise<void> {
  const { structure, people } = cli.archive;
  const edit = <T>(work: () => T) => change(`person ${sub}`, work);
  const number = (value: string | undefined, what: string) => {
    if (!value || !/^\d+$/.test(value)) throw new Error(`give a ${what} number`);
    return Number(value);
  };
  const words = (from: number) => {
    const text = rest.slice(from).join(" ").trim();
    if (!text) throw new Error("give the name");
    return text;
  };
  let personId: number;
  switch (sub) {
    case "show":
      personId = number(rest[0], "person");
      break;
    case "new": {
      const name = words(0);
      const already = cli.values.anyway ? [] : people.sameNamed(name);
      if (already.length > 0) {
        const named = already.map((id) => personLine(structure.getPerson(id)!)).join("\n  ");
        throw new Error(`already here with that name or alias:\n  ${named}\nadd them anyway with --anyway`);
      }
      const input = {
        name,
        location: cli.values.location,
        tags: cli.values.tag?.flatMap((tag) => tag.split(",")).map((tag) => tag.trim()).filter(Boolean),
        note: cli.values.note,
      };
      personId = await edit(() => people.add(input));
      break;
    }
    case "set-name": {
      const [person, name] = [number(rest[0], "person"), words(1)];
      personId = await edit(() => people.setName(person, name));
      break;
    }
    case "add-alias": {
      const [person, alias] = [number(rest[0], "person"), words(1)];
      personId = await edit(() => people.addAlias(person, alias));
      break;
    }
    case "remove-alias": {
      const [person, alias] = [number(rest[0], "person"), words(1)];
      personId = await edit(() => people.removeAlias(person, alias));
      break;
    }
    case "tag": {
      const person = number(rest[0], "person");
      personId = await edit(() => people.addTags(person, rest.slice(1)));
      break;
    }
    case "untag": {
      const person = number(rest[0], "person");
      personId = await edit(() => people.removeTags(person, rest.slice(1)));
      break;
    }
    case "link": {
      const [account, person] = [number(rest[0], "account"), number(rest[1], "person")];
      personId = await edit(() => people.link(account, person));
      break;
    }
    case "unlink": {
      const account = number(rest[0], "account");
      personId = await edit(() => people.unlink(account));
      break;
    }
    case "note": {
      const person = number(rest[0], "person");
      const text = rest.slice(1).join(" ").trim();
      if (!text) throw new Error("give the note (clear-note takes it away)");
      personId = await edit(() => people.setNote(person, text));
      break;
    }
    case "clear-note": {
      const person = number(rest[0], "person");
      personId = await edit(() => people.setNote(person, ""));
      break;
    }
    case "reach-out":
    case "no-reach-out": {
      const person = number(rest[0], "person");
      personId = await edit(() => people.setShouldReachOut(person, sub === "reach-out"));
      break;
    }
    case "draft": {
      const person = number(rest[0], "person");
      const text = rest.slice(1).join(" ").trim();
      if (!text) throw new Error("give the draft (clear-draft deletes it)");
      // A draft is no edit: no changeset, as the panel saves one.
      const [first] = people.drafts.list(person);
      if (first) people.drafts.set(first.id, text);
      else people.drafts.add(person, text);
      personId = person;
      break;
    }
    case "clear-draft": {
      const person = number(rest[0], "person");
      const [first] = people.drafts.list(person);
      if (first) people.drafts.remove(first.id);
      personId = person;
      break;
    }
    case "opener":
    case "clear-opener":
      throw new Error(`person ${sub} is gone: a draft opener is a draft now (person ${sub === "opener" ? "draft" : "clear-draft"})`);
    case "location": {
      const [person, value] = [number(rest[0], "person"), words(1)];
      personId = await edit(() => people.setLocation(person, value));
      break;
    }
    case "clear-location": {
      const person = number(rest[0], "person");
      personId = await edit(() => people.setLocation(person, null));
      break;
    }
    case "met":
    case "lives":
    case "clear-met":
    case "clear-lives":
      throw new Error(`person ${sub} is gone: Met and Lives became one Location (person ${sub.startsWith("clear-") ? "clear-location" : "location"})`);
    case "me": {
      const person = number(rest[0], "person");
      await edit(() => people.markAsMe(person));
      console.log(`Person ${rest[0]}'s accounts are yours now.`);
      return;
    }
    case "delete": {
      const person = number(rest[0], "person");
      await edit(() => people.delete(person));
      console.log(`Deleted person ${rest[0]}.`);
      return;
    }
    default:
      throw new Error(
        "person show | new | set-name | add-alias | remove-alias | tag | untag | note | clear-note | reach-out | no-reach-out | draft | clear-draft | " +
          "location | clear-location | link | unlink | me | delete; see npm run archive",
      );
  }
  const person = structure.getPerson(personId);
  if (!person) throw new Error(`no person ${personId}`);
  console.log(personLine(person));
  if (person.aliases.length > 0) console.log(`  also known as: ${person.aliases.join(", ")}`);
  if (person.location) console.log(`  location: ${person.location}`);
  if (person.note) {
    console.log(`  note${person.noteFromContacts ? " (from the address book)" : ""}:`);
    for (const line of person.note.split("\n")) console.log(`    ${line}`);
  }
  if (person.shouldReachOut) console.log("  you should reach out to them");
  for (const draft of cli.archive.people.drafts.list(person.id)) {
    console.log("  draft:");
    for (const line of draft.text.split("\n")) console.log(`    ${line}`);
  }
  for (const a of person.accounts) {
    console.log(`  account ${a.id}: ${a.platform} "${a.displayName}"${a.handle ? ` ${a.handle}` : ""}, ${a.messageCount} messages, linked by ${a.link}`);
  }
  for (const catchUp of cli.archive.people.catchUps.list({ personId: person.id })) console.log(`  ${catchUpLine(catchUp)}`);
}
export async function tagCommand(sub: string | undefined, rest: string[]): Promise<void> {
  const { tags } = cli.archive.people;
  const name = (value: string | undefined) => {
    if (!value) throw new Error("name the tag");
    return value;
  };
  switch (sub) {
    case "list":
      break;
    case "add": {
      const tag = name(rest[0]);
      console.log(`Added the tag ${await change("tag add", () => tags.create(tag))}.`);
      break;
    }
    case "rename": {
      const [from, to] = [name(rest[0]), name(rest[1])];
      const { name: kept, merged } = await change("tag rename", () => tags.rename(from, to));
      console.log(merged ? `Merged ${rest[0]} into ${kept}: everyone who had ${rest[0]} has ${kept}.` : `Renamed ${rest[0]} to ${kept} for everyone.`);
      break;
    }
    case "delete": {
      const tag = name(rest[0]);
      const count = await change("tag delete", () => tags.delete(tag));
      console.log(`Deleted the tag ${rest[0]}, taken from ${count} ${count === 1 ? "person" : "people"}.`);
      break;
    }
    case "move": {
      const [tag, position] = [name(rest[0]), rest[1]];
      if (!position || !/^[1-9]\d*$/.test(position)) throw new Error("give the position, 1 first");
      await change("tag move", () => tags.move(tag, Number(position) - 1));
      break;
    }
    default:
      throw new Error("tag list | add | rename | delete | move; see npm run archive");
  }
  tags.list().forEach((tag, i) => console.log(`${i + 1}  ${tag.name} (${tag.count})${tag.builtIn ? " built in" : ""}`));
}
export function printLocations(): void {
  const list = cli.archive.people.locations.list();
  console.log(list.length === 0 ? "Nobody has a location yet." : list.map((v) => `${v.name} (${v.count})`).join(", "));
}
export async function locationCommand(sub: string | undefined, rest: string[]): Promise<void> {
  if (sub !== "rename") throw new Error("location rename <location> <new name>; see npm run archive (and locations for the list)");
  const [from, to] = rest;
  if (!from || !to || rest.length > 2) throw new Error('location rename <location> <new name>: quote one of several words ("New York")');
  const { name, count, merged } = await change("location rename", () => cli.archive.people.locations.rename(from, to));
  const people = `${count} ${count === 1 ? "person" : "people"}`;
  console.log(merged ? `Merged ${from} into ${name}: ${people} moved there.` : `Renamed ${from} to ${name} for ${people}.`);
  printLocations();
}
/**
 * `edit`: changes many people at once (edits.ts). Without --apply it is the
 * dry run; with it, the edit is made to the same choice as one changeset, but
 * only if it would change exactly --expect people (the dry run's count), so
 * what the captain was shown is what is done.
 */
export async function editCommand(verb: string | undefined, rest: string[]): Promise<void> {
  const action = parseEditAction(verb, rest);
  if ((cli.values.query === undefined) === (cli.values.people === undefined)) throw new Error("choose who with --query <query> or --people <person,person,...> (one of them)");
  const selection: Selection = cli.values.query !== undefined ? { query: cli.values.query } : { people: personList(cli.values.people!) };
  const what = describeEdit(action);
  const chosen = "query" in selection ? `the query ${selection.query}` : `people ${selection.people.join(", ")}`;
  const plan = planEdit(cli.archive, selection, action);
  const shown = (value: string) => value || "(none)";
  const changeLines = () => plan.change.forEach((p) => console.log(`  ${p.id}  ${p.name}: ${shown(p.before)} -> ${shown(p.after)}`));
  const alreadyLines = () => plan.already.forEach((p) => console.log(`  ${p.id}  ${p.name}: ${shown(p.value)}`));
  if (!cli.values.apply) {
    console.log(`edit ${what}, for ${chosen}: ${plan.selected} chosen.`);
    console.log(`Would change ${plan.change.length}:`);
    changeLines();
    console.log(`Already so ${plan.already.length}:`);
    alreadyLines();
    for (const add of plan.adds) console.log(`Would add ${add}.`);
    for (const gone of plan.deletes) console.log(`Would delete ${gone}, as nobody would have it.`);
    console.log(plan.change.length === 0
      ? "Nothing to change, and nothing written."
      : `Nothing written (a dry run). To make it, run the same with --apply --expect ${plan.change.length} --why "<the captain's words>".`);
    return;
  }
  if (cli.values.expect === undefined || !/^\d+$/.test(cli.values.expect)) throw new Error("--apply needs --expect <n>: how many people the dry run said it would change");
  const expected = Number(cli.values.expect);
  const check = (count: number) => {
    if (count !== expected) throw new Error(`this would change ${count} ${count === 1 ? "person" : "people"}, not ${expected}: people changed since the dry run, so run it again and show the captain`);
  };
  check(plan.change.length);
  if (plan.change.length === 0) {
    console.log(`Nothing to change: all ${plan.selected} chosen are that way already.`);
    return;
  }
  // Chosen again inside the changeset, so nothing can change between the check and the edit.
  const done = await change(`edit ${what}`, () => {
    const now = planEdit(cli.archive, selection, action);
    check(now.change.length);
    applyEdit(cli.archive.people, action, now.change.map((p) => p.id));
    return now;
  });
  plan.change = done.change;
  plan.already = done.already;
  console.log(`Changed ${plan.change.length}${plan.already.length > 0 ? ` (${plan.already.length} already so)` : ""}:`);
  changeLines();
  for (const gone of done.deletes) console.log(`Deleted ${gone}, as nobody has it.`);
}
/** "12,34 56" as person numbers. */
export function personList(text: string): number[] {
  const ids = text.split(/[\s,]+/).filter(Boolean);
  if (ids.length === 0 || ids.some((id) => !/^\d+$/.test(id))) throw new Error("--people takes person numbers, e.g. --people 12,34");
  return ids.map(Number);
}
export function personLine(person: PersonSummary): string {
  const tags = person.tags.length > 0 ? ` [${person.tags.join(", ")}]` : "";
  const last = person.lastMessageAt ? `, last ${dayKey(person.lastMessageAt)}` : "";
  const flags = person.archived ? ` (archived: ${ARCHIVE_REASONS[person.archived].toLowerCase()})`
    : person.directMessageCount === 0 && person.groupMessageCount > 0 ? " (groups only)" : "";
  const joined = person.joined ? ` (joined by name: ${person.accounts.map((a) => a.platform).join(", ")})` : "";
  return `${person.id}  ${person.name}${tags}: ${person.directMessageCount} direct, ${person.groupMessageCount} in groups${last}${flags}${joined}`;
}
/** A group chat as `groups` lists it: number, title (or who is in it), platform, size and last message. */
export function groupLine(g: Omit<PersonGroup, "fromThem" | "fromMe" | "unlinked">): string {
  const name = g.title ?? `untitled, with ${g.namedBy.map((p) => p.name).join(", ") || "nobody known"}`;
  const last = g.lastMessageAt ? `, last ${dayKey(g.lastMessageAt)}` : "";
  return `#${g.id}  ${name} (${g.platform}, ${g.people} people${last})`;
}
export function printContactNotes(n: AddressBookNotes): void {
  console.log(
    `Address book: ${n.contacts} contacts; ${n.withCompany} with a company, department or job title, ${n.withNote} with a note, ` +
      `${n.withEither} with either; ${n.matched} of those matched to people (${n.matchedSeveral} to more than one person).`,
  );
  console.log(
    `Notes: ${n.people} people have one in the address book: ${n.written} written, ${n.unchanged} already as it says, ` +
      `${n.keptCaptains} kept because you changed them.`,
  );
}