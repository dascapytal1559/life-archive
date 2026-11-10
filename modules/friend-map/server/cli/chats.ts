// friend map's commands about the chats themselves (`npm run archive -- coverage`, `import-status`, `exports`, `media`,
// `repair`, `storage`, `timeline`, `search`, `changes`; commands.ts runs them): what each platform's imports cover, the
// exports and their media, the repairs, what the folder holds, the content commands, which keep every read in the
// core's trail, and the change log.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ARCHIVE_REASONS, type ArchiveReason, archiveUrl, callDuration, callLabel, callPlatformName, callTotals, type CatchUp, catchUpDayCount, catchUpTitle, changesCommand, type ChangesetInfo, type ConnectorStatus, dayKey, defaultCallAccount, isDay, isPlatform, isSqlQuery, KEEP_DAYS, LOCALE, nasLine, othersLabel, parseCallLength, type PersonCall, type PersonGroup, type PersonSummary, PRIVATE_FROM, PRIVATE_TO, readCaptureStatus, readerFromEnvironment, readNasStatus, type ReadScope, relativeDay, TIME_ZONE, timeLabel, type TimelineMessage, timeOfDay, transcriptsLine, type Trip, when, zonePlace } from "../../../../sdk/server.ts";
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
import { everyRow } from "../calendarPush.ts";
import { backupBefore, change, cli, id, into, show } from "./context.ts";

/** The commands about the chats themselves: what each platform's imports cover, the exports and media, repairs, storage, the content commands (timeline and search) and the change log. Whether `command` is one of them. */
export async function chatCommands(command: string, args: readonly string[]): Promise<boolean | void> {
    const { structure, people, content } = cli.archive;
    const host = cli.archive.live.host;
  switch (command) {
    case "coverage": {
      const report = structure.coverage();
      if (report.platforms.length === 0) console.log("Nothing imported yet.");
      for (const p of report.platforms) {
        console.log(`${p.platform}: ${p.messageCount} messages, ${p.firstMessageAt ? dayKey(p.firstMessageAt) : "-"} to ${p.lastMessageAt ? dayKey(p.lastMessageAt) : "-"}`);
        console.log(`  silent for ${p.silentDays ?? "-"} days (${zonePlace()}); last import ${p.lastImport ? `${dayKey(p.lastImport.at)} (${p.lastImport.label})` : "never"}`);
        for (const span of p.spans) console.log(`  covered ${dayKey(span.from)} to ${dayKey(span.to)} by ${span.kind}`);
        for (const gap of p.gaps) console.log(`  gap ${dayKey(gap.from)} to ${dayKey(gap.to)}`);
        console.log(`  per month: ${p.months.map((m) => `${m.month} ${m.count}`).join(", ")}`);
      }
      return;
    }
    case "import-status": {
      const running = await serverConnectors();
      const connectors = (await host.statuses()).map((c) => ({
        ...c,
        obtain: host.manifests().find((m) => m.id === c.id)?.obtain ?? null,
        live: running ? (running.find((r) => r.id === c.id)?.live ?? null) : undefined,
      }));
      const report = importStatus(cli.archive.db, connectors);
      if (cli.values.json) console.log(JSON.stringify(report, null, 2));
      else printImportStatus(report);
      return;
    }
    case "exports":
      return exportsCommand(args[0], args.slice(1));
    case "media": {
      if (args[0] !== "repoint") throw new Error("media takes repoint: media repoint [--apply]");
      const plan = await planRepoint(cli.archive.db, cli.dataDir, (note) => process.stderr.write(`  ${note}\n`));
      printRepointPlan(plan);
      if (!cli.values.apply) {
        printUnreferenced(await unreferencedCopies(cli.archive.db, cli.dataDir, plan), "once re-pointed");
        console.log("Nothing changed (a dry run); --apply makes it, after a backup (npm run archive -- backup <label>).");
        return;
      }
      const result = await applyRepoint(cli.archive.db, cli.dataDir, plan, (note) => process.stderr.write(`  ${note}\n`));
      console.log(`Re-pointed ${result.repointed} attachments (${result.liveCopiesMade} live copies made, ${result.ledgerEntries} ledger entries carried); logged to ${result.log}.`);
      if (result.changedSince > 0) console.log(`${result.changedSince} had changed since the plan and were left as they are; run it again.`);
      printUnreferenced(await unreferencedCopies(cli.archive.db, cli.dataDir), "now");
      return;
    }
    case "repair": {
      if (args[0] !== "messenger-phone-chats") throw new Error("repair takes messenger-phone-chats: repair messenger-phone-chats [--apply]");
      const texts = await unsentTexts(cli.dataDir);
      const plan = planPhoneChats(cli.archive.db, texts);
      printPhoneChatPlan(plan);
      if (plan.repairs.length === 0) return;
      if (!cli.values.apply) {
        console.log("Nothing changed (a dry run); --apply makes it, after a checked backup.");
        return;
      }
      const backup = await backupBefore("repair messenger-phone-chats");
      console.log(`Backed up to ${backup}, integrity ok.`);
      const result = applyPhoneChats(cli.archive.db, () => cli.archive.people.runRules(), texts);
      // Chats merged and messages moved: every row of friend map's in the calendar again.
      cli.archive.live.calendar.replace(everyRow(cli.archive.db));
      console.log(
        `Repaired ${result.plan.repairs.length} ${result.plan.repairs.length === 1 ? "chat" : "chats"}: ${result.chatsDeleted} copies deleted, ` +
          `${result.messagesDeleted} of their messages merged and ${result.messagesMoved} moved, ${result.messagesRekeyed} of the first chats' messages ` +
          `given new ids, ${result.doublesMerged} held twice in one chat merged, ${result.accountsDeleted} accounts merged away and ${result.peopleDeleted} people with no account left deleted by the rules.`,
      );
      return;
    }
    case "storage": {
      printStorage(await storageReport(cli.archive.db, cli.dataDir));
      console.log(nasLine(await readNasStatus(cli.dataDir), Date.now()));
      console.log(transcriptsLine(await readCaptureStatus(cli.dataDir), Date.now()));
      return;
    }
    case "timeline": {
      const person = id(args[0], "person");
      const read = content.timeline(person, { limit: cli.values.limit ? Number(cli.values.limit) : 50 });
      if (!read) throw new Error(`no person ${args[0]}`);
      contentRead("timeline", { person });
      const page = cli.values.redacted ? redactPage(read) : read;
      if (cli.values.json) console.log(JSON.stringify(page, null, 2));
      else for (const message of [...page.messages].reverse()) console.log(messageLine(message));
      return;
    }
    case "search": {
      const scope = { words: args.join(" "), person: cli.values.person ? Number(cli.values.person) : undefined };
      const found = content.search(scope.words, { personId: scope.person });
      contentRead("search", scope);
      const hits = cli.values.redacted ? redactHits(found) : found;
      if (cli.values.json) console.log(JSON.stringify(hits, null, 2));
      else {
        for (const hit of hits) console.log(`${messageLine(hit).split(": ")[0]}: ${hit.snippet}`);
        console.log(`${hits.length} matches.`);
      }
      return;
    }
    case "changes":
      return changesCommand(args[0], args.slice(1), {
        changes: cli.archive.changes, command: "changes", dataDir: cli.dataDir, values: cli.values, backupBefore, made: (made) => (cli.made = made),
      });
    default:
      return false;
  }
}

export async function exportsCommand(sub: string | undefined, rest: string[]): Promise<void> {
  switch (sub) {
    case "move-imports": {
      const plan = await planImportsMove(cli.dataDir);
      for (const move of plan.moves) console.log(`${move.blocked ? "Cannot move" : cli.values.apply ? "Moving" : "Would move"} data/${move.from} to data/${move.to}${move.blocked ? ` (${move.blocked})` : ""}`);
      for (const name of plan.unknown) console.log(`Left in data/imports/: ${name} (its name gives no <platform>-<date>)`);
      if (!cli.values.apply) {
        console.log(`${plan.moves.filter((m) => !m.blocked).length} to move (a dry run); --apply moves them.`);
        return;
      }
      const { moved, blocked } = await moveImports(cli.dataDir, plan);
      const relabelled = relabelSources(cli.archive.db, plan);
      const left = (await readdir(join(cli.dataDir, "imports")).catch(() => [])).filter((name) => !name.startsWith("."));
      console.log(`Moved ${moved}${blocked ? `, ${blocked} could not move` : ""}; ${relabelled} imports now name their export's new place.`);
      console.log(left.length === 0 ? "data/imports/ is empty (but for hidden files such as Finder's .DS_Store)." : `data/imports/ still holds: ${left.join(", ")}`);
      return;
    }
    case "unpack": {
      if (!rest[0]) throw new Error("name the export's folder, e.g. exports unpack ~/life-archive-data/platform-exports/messenger/2026-09-28/");
      const counts = await unpackExport(resolve(rest[0]), (done, total, name) => name && process.stderr.write(`  ${done + 1} of ${total}: ${name}\n`));
      console.log(
        `Unpacked ${counts.zips} zips: ${counts.written} files written (${gigabytes(counts.writtenBytes)}), ${counts.present} already there` +
          `${counts.differ ? `, ${counts.differ} already there with another size (the first part's kept)` : ""}. The zips are kept.`,
      );
      return;
    }
    default:
      throw new Error("exports takes move-imports or unpack");
  }
}
export function printRepointPlan(plan: RepointPlan): void {
  for (const p of plan.platforms) {
    const unmatched = Object.values(p.unmatched).reduce((sum, n) => sum + n, 0);
    console.log(`${p.platform}: ${p.attachments} attachments (${p.missing} without a file, ${p.home} already home)`);
    if (p.exports.length) console.log(`  exports searched, newest first: ${p.exports.join(", ")}`);
    console.log(`  re-point to an export: ${p.toExport} (${p.toExportFiles} files, ${gigabytes(p.toExportBytes)})`);
    console.log(`  to its live folder (no export behind them): ${p.toLive} (${p.toLiveFiles} files, ${gigabytes(p.toLiveBytes)})`);
    console.log(`  stay on their copy, unmatched: ${unmatched}`);
    for (const [why, n] of Object.entries(p.unmatched)) console.log(`    ${n}: ${why}`);
    if (p.toExport + p.toLive > 0) {
      console.log(`  their copies: ${p.copiesChecked} the same as the record${p.copiesDiffer ? `, ${p.copiesDiffer} different` : ""}${p.copiesMissing ? `, ${p.copiesMissing} not there` : ""}`);
    }
  }
}
export function printPhoneChatPlan(plan: PhoneChatPlan): void {
  const chat = (c: PhoneChat) => `chat #${c.conversation} (${c.type}) "${c.title ?? ""}"`;
  for (const r of plan.repairs) {
    const title = r.kept.newTitle !== r.kept.title ? `, titled "${r.kept.newTitle ?? ""}"` : "";
    const doubled = r.doubled > 0 ? `; ${r.doubled} it holds twice (photos sent together, brought in again by a later export), which go` : "";
    console.log(
      `${chat(r.kept)}, ${r.kept.messages} messages${r.kept.dropped ? ", dropped" : ""}: ${r.rekeysChat ? "takes its new key" : "keeps its key"}${title}, ` +
        `${r.rekeyed} of its messages new ids${doubled}`,
    );
    for (const c of r.copies) {
      const dropped = c.dropped ? " (dropped; the drop is not carried)" : "";
      console.log(`  merges ${chat(c)}${dropped}, ${c.messages} messages: ${c.same} the first chat's own, which go, and ${c.moved} new to it, which move; then deletes it`);
    }
    for (const a of r.accounts) {
      const person = a.person === null ? "" : a.personGoes ? `; its person ${a.person} goes with it` : `; its person ${a.person} stays (you edited them, or they have other accounts)`;
      console.log(`  merges account #${a.account} "${a.label}" into the first chat's, #${a.into}, and deletes it${a.carriesLink ? ", which takes your link" : ""}${person}`);
    }
    if (r.removals + r.unlinks > 0) console.log(`  carries ${r.removals} taken out of the group and ${r.unlinks} unlinked from it`);
    if (r.differing > 0) console.log(`  ${r.differing} messages both have differ: the first chat's are kept, and the next import of the newest export brings them up to date`);
  }
  for (const u of plan.unrecognised) console.log(`Left as it is: chat #${u.conversation} "${u.title ?? ""}": ${u.why}`);
  const copies = plan.repairs.reduce((n, r) => n + r.copies.length, 0);
  const merged = plan.repairs.reduce((n, r) => n + r.copies.reduce((m, c) => m + c.same, 0), 0);
  const moved = plan.repairs.reduce((n, r) => n + r.copies.reduce((m, c) => m + c.moved, 0), 0);
  const accounts = plan.repairs.reduce((n, r) => n + r.accounts.length, 0);
  const rekeyed = plan.repairs.filter((r) => r.rekeysChat).length;
  const doubled = plan.repairs.reduce((n, r) => n + r.doubled, 0);
  console.log(
    plan.repairs.length === 0
      ? `Nothing to repair: ${plan.settled} phone-export chats are under their keys already${plan.unrecognised.length ? `, and ${plan.unrecognised.length} are left as they are` : ""}.`
      : `In all: ${rekeyed} chats take their new keys and ${plan.repairs.length - rekeyed} keep theirs; ${copies} copies are merged into them and deleted ` +
        `(${merged} of their messages go, ${moved} move); ${doubled} messages held twice in one chat go; ${accounts} deleted-account accounts are merged away; ` +
        `${plan.settled} chats are under their keys already; ` +
        `${plan.unrecognised.length} are left as they are.`,
  );
}
export function printUnreferenced(copies: UnreferencedCopies[], when: string): void {
  console.log(`Copies in data/archive/media/ ${when} (never deleted here; deleting them is the captain's call):`);
  for (const c of copies) {
    console.log(
      `  ${c.platform}: ${c.files} files (${gigabytes(c.bytes)}), ${c.unreferencedFiles} of them (${gigabytes(c.unreferencedBytes)}) pointed at by nothing; ` +
        (c.stillReferenced ? `${c.stillReferenced} attachments still on a copy` : "every attachment has its new home"),
    );
  }
}
export function printStorage(report: StorageReport): void {
  console.log(`data/: ${gigabytes(report.totalBytes)} in all`);
  for (const t of report.top) if (t.bytes > 0) console.log(`  ${t.name.padEnd(28)} ${gigabytes(t.bytes)}`);
  console.log(`archive.sqlite: ${gigabytes(report.archiveBytes)}, of which messages ${gigabytes(report.messageTablesBytes)} (shared out below by the size of each platform's messages)`);
  for (const p of report.platforms) {
    const exports = p.exports.reduce((sum, e) => sum + e.bytes, 0);
    console.log(`${p.platform}: messages ${gigabytes(p.messageBytes)} (${p.messages}); exports ${gigabytes(exports)}; media pointed at ${gigabytes(p.mediaBytes)} (${p.mediaFiles} files)`);
    for (const e of p.exports) {
      console.log(
        `  ${e.folder}: ${gigabytes(e.bytes)}${e.zipBytes ? ` (zips ${gigabytes(e.zipBytes)}, unpacked ${gigabytes(e.bytes - e.zipBytes)})` : ""}; ` +
          `media pointed at ${gigabytes(e.referencedBytes)} (${e.referencedFiles} files)`,
      );
    }
    if (p.copiesReferencedFiles) console.log(`  still on copies in data/archive/media/: ${gigabytes(p.copiesReferencedBytes)} (${p.copiesReferencedFiles} files)`);
    if (p.unreferencedCopyFiles) console.log(`  copies in data/archive/media/ nothing points at: ${gigabytes(p.unreferencedCopyBytes)} (${p.unreferencedCopyFiles} files)`);
  }
}
export function printImportStatus(report: ImportStatusReport): void {
  const now = report.generatedAt;
  console.log(`Import status on ${dayKey(now)} (${zonePlace()}). Each connector's steps: docs/import-runbook.md, under its name.`);
  if (report.used.length === 0) console.log("\nNothing imported yet.");
  for (const { way, heading } of IMPORT_WAYS) {
    const rows = report.used.filter((row) => row.way === way);
    if (rows.length === 0) continue;
    console.log(`\n${heading}:`);
    for (const row of rows) {
      const reach = row.way === "live"
        ? `newest ${row.platform} message ${row.newestAt === null ? "none" : `${dayKey(row.newestAt)} (${relativeDay(row.newestAt, now)})`}; last good sync ${dayOf(row.lastImportAt, now)}`
        : `covers to ${dayOf(row.coversTo, now)}; last imported ${dayOf(row.lastImportAt, now)}`;
      console.log(`  ${row.platform} (${row.connector}${row.enabled ? "" : ", switched off"}): ${reach}`);
      if (row.lastError) console.log(`    last error: ${row.lastError}`);
      console.log(`    next: ${row.next}`);
    }
  }
  if (report.unused.length > 0) {
    console.log("\nNever imported (how to start):");
    for (const row of report.unused) console.log(`  ${row.platform} (${row.connector}): ${row.next}`);
  }
}
/** "2026-10-04 (5 days ago)", or "never". */
export function dayOf(ms: number | null, now: number): string {
  return ms === null ? "never" : `${dayKey(ms)} (${relativeDay(ms, now)})`;
}
export function gigabytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}
export function messageLine(message: TimelineMessage): string {
  const when = new Date(message.sentAt).toLocaleString(LOCALE, { timeZone: TIME_ZONE });
  const who = message.fromSelf ? "me" : (message.sender ?? "system");
  const where = message.conversation.type === "group" ? ` in ${message.conversation.title ?? "a group"}` : "";
  const body = message.unsent ? "(unsent)" : [message.text, ...message.attachments.map((a) => `[${a.type}${a.missing ? ", missing" : ""}]`)].filter(Boolean).join(" ");
  return `${when} ${message.platform} ${who}${where}: ${body}`;
}
/** Keeps a content read in the trail, before it is printed; the testing data's are no read of content. */
export function contentRead(what: string, scope: ReadScope): void {
  if (cli.values.testing) return;
  cli.archive.live.contentLog.record({ surface: "cli", reader: readerFromEnvironment(), what, scope: { ...scope, redacted: cli.values.redacted }, why: cli.values.why ?? null });
}
/** The connectors as the running server reports them, if it answers. */
async function serverConnectors(): Promise<ConnectorStatus[] | null> {
  try {
    const response = await fetch(`${archiveUrl().replace(/\/+$/, "")}/api/archive/connectors`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? ((await response.json()) as ConnectorStatus[]) : null;
  } catch {
    return null;
  }
}
