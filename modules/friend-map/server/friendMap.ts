// Friend map as one object, over its database (db.ts: the archive, modules/friend-map/archive.sqlite in the archive's
// folder) and what the core lends it (sdk/server.ts's ModuleLive): the people and their rules (people.ts), the change
// log of every edit to them (the core's changes.ts, over this database's tables), the structure the page and the
// commands read (structure.ts), friend-map's Calendar view's days (calendarView.ts), the content routes' reads
// (content.ts), the sends (send.ts), its pushes into the core's calendar (calendarPush.ts), and what it does after its
// connectors' imports: the rules, once an import or a live batch has brought someone (at most once every few seconds
// after live batches, in a fiber that stopLive and close interrupt), and notes filled from an address book.
//
// One for each open database (friendMapOf), made the first time the core asks the module for anything of it, which is
// as the archive opens: the rules run then if this code's are newer than the ones last run (people.ts), which is once
// after an upgrade.

import { Clock, Effect, Fiber, Changes, runBackground, runPromise, type ImportCounts, type ModuleLive, type ModuleStore } from "../../../sdk/server.ts";
import { fillNotesFromAddressBook, type AddressBookNotes } from "./addressBookNotes.ts";
import { ArchiveCalendar } from "./calendarView.ts";
import { changeLog } from "./changeLog.ts";
import { FriendMapPush } from "./calendarPush.ts";
import { ArchiveContent } from "./content.ts";
import type { Db } from "./db.ts";
import { People } from "./people.ts";
import { SendExecutor } from "./send.ts";
import { ArchiveStructure } from "./structure.ts";
import { pageFolder } from "./page/savedSettingsPlugin.ts";
import { scoreWith } from "./tabs/closeness.ts";
import { closenessSettingsNow } from "./page/settings.ts";
import { closenessNow } from "../page/src/demos/closeness.ts";
import type { Touched } from "./write.ts";

/** The rules run at most this often after live batches. */
export const RULES_EVERY_MS = 5000;

/** The connectors that name people from the iPhone address book, whose imports also fill notes from it. */
const CONTACT_NOTE_CONNECTORS = ["whatsapp-db", "imessage-db"];

export class FriendMap {
  readonly db: Db;
  /** The archive's folder. */
  readonly folder: string;
  readonly people: People;
  /** The change log: every edit to people is one changeset, which can be undone (the core's changes.ts). */
  readonly changes: Changes;
  readonly structure: ArchiveStructure;
  /** friend-map's Calendar view's days (calendarView.ts): what each local day had, structure only. */
  readonly days: ArchiveCalendar;
  readonly content: ArchiveContent;
  /** The only way a message is sent (see send.ts). */
  readonly sends: SendExecutor;
  /** Its pushes into the core's calendar (calendarPush.ts). */
  readonly push: FriendMapPush;
  /** What the core lends it: the calendar, the host, the trail of content reads. */
  readonly live: ModuleLive;
  /** How often the rules run after live batches: RULES_EVERY_MS, or a test's own. */
  rulesEveryMs = RULES_EVERY_MS;
  /** The rules' run after a batch (runRulesSoon), until it has run. */
  private rules: Fiber.Fiber<void> | null = null;
  private rulesDue = false;
  private rulesRanAt = 0;
  /** Whether a batch since the rules last ran added or changed an account, and so maybe someone's name or links. */
  private accountsChanged = false;
  /** Stops the People table's Closeness asking this friend map (tabs/closeness.ts). */
  private readonly forgetScores: () => void;

  constructor({ db, folder, ...live }: ModuleStore & ModuleLive) {
    this.db = db;
    this.folder = folder;
    this.live = live;
    this.people = new People(db);
    this.push = new FriendMapPush(db, live.calendar);
    // An edit (a hangout added, a call given a length, a merge) reaches the calendar once its changeset has committed.
    this.changes = changeLog(db, this.people, { afterChange: (tables) => this.push.afterEdit(tables) });
    this.structure = new ArchiveStructure(db, this.people);
    this.days = new ArchiveCalendar(db, this.people, this.structure);
    this.content = new ArchiveContent(db, folder);
    this.sends = new SendExecutor(db, live.host);
    this.changes.prune();
    // The People table's Closeness (tabs/closeness.ts): scored as the map views score it, from this structure's facts at
    // the page's closeness settings.
    this.forgetScores = scoreWith(db, () => closenessNow(this.structure.scoreReport(), closenessSettingsNow(pageFolder(folder))));
    if (!this.people.rulesAreCurrent()) {
      console.error("Running the rules (new code, or a new archive)…");
      this.runRules();
    }
  }

  /** Runs the people rules (people.ts), then pushes friend map's rows to the calendar when who is whom changed. */
  runRules(options: { onlyMessages?: boolean } = {}): void {
    this.people.runRules(options);
    this.push.afterPeople();
  }

  /**
   * After an import's (or a live batch's) transaction has committed: what it touched pushed to the calendar; and after
   * a live batch that changed the archive, the rules, so new people are linked and counted and open pages hear of it,
   * at most once every few seconds. Batches that only bring messages tell open pages only that counts changed (see
   * runRules' `onlyMessages`), unless the rules changed someone. A history import's rules run after it (afterImport).
   */
  afterApply(touched: Touched, counts: ImportCounts, live: boolean): void {
    this.push.afterChats(touched);
    if (!live) return;
    const changed = counts.accounts.added + counts.accounts.updated + counts.conversations.added + counts.conversations.updated
      + counts.messages.added + counts.messages.updated + counts.messages.edited + counts.messages.matched + counts.reactions.added
      + counts.attachments.added + counts.attachments.updated;
    if (counts.accounts.added + counts.accounts.updated > 0) this.accountsChanged = true;
    if (changed === 0 || this.rulesDue) return;
    this.rulesDue = true;
    this.rules = runBackground(this.runRulesSoon());
  }

  /** Runs the rules once rulesEveryMs have passed since they last ran (at once if they have). */
  private runRulesSoon(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sleep(Math.max(0, this.rulesRanAt + this.rulesEveryMs - (yield* Clock.currentTimeMillis)));
      this.rulesDue = false;
      this.rulesRanAt = yield* Clock.currentTimeMillis;
      try {
        this.runRules({ onlyMessages: !this.accountsChanged });
        this.accountsChanged = false;
      } catch (error) {
        console.error("The people rules failed after a sync batch:", (error as Error).message);
      }
    });
  }

  /** Stops the rules' run after a batch, if one is waiting. */
  async stopRules(): Promise<void> {
    const rules = this.rules;
    this.rules = null;
    this.rulesDue = false;
    if (rules) await runPromise(Fiber.interrupt(rules));
  }

  /** Marks the sends a server that stopped left unfinished as unconfirmed, as this process takes the live bridges on. */
  recoverSends(): void {
    const unconfirmed = this.sends.recover();
    if (unconfirmed > 0) console.log(`[live] ${unconfirmed} sends were unfinished when the server stopped; they are marked unconfirmed`);
  }

  /**
   * After a history import of `connector`: the rules, so the new people are linked and counted; for a whatsapp-db or
   * imessage-db import given an address book (the `contacts` setting, --contacts on the CLI), people's notes filled
   * from it (see addressBookNotes.ts). What the import command says of it.
   */
  async afterImport(connector: string, settings: Record<string, unknown>): Promise<string[]> {
    this.runRules();
    const said: string[] = [];
    const contacts = settings.contacts;
    if (typeof contacts === "string" && contacts !== "" && CONTACT_NOTE_CONNECTORS.includes(connector)) said.push(...contactNotesLines(await this.fillContactNotes(contacts)));
    const everyone = this.structure.listPeople().people;
    said.push(`People: ${everyone.length}, ${everyone.filter((p) => p.joined).length} of them joined by name; proposals waiting for the captain: ${this.structure.proposals().length}.`);
    return said;
  }

  /** Fills people's notes from the iPhone address book at `file` (see addressBookNotes.ts); `write` wraps the writing (in a changeset, say). */
  fillContactNotes(file: string, write?: <T>(work: () => T) => T): Promise<AddressBookNotes> {
    return fillNotesFromAddressBook(this.db, this.people, file, write);
  }

  close(): void {
    this.rules?.interruptUnsafe();
    this.rules = null;
    this.forgetScores();
  }
}

/** What filling notes from an address book did, in two lines. */
export function contactNotesLines(n: AddressBookNotes): string[] {
  return [
    `Address book: ${n.contacts} contacts; ${n.withCompany} with a company, department or job title, ${n.withNote} with a note, ` +
      `${n.withEither} with either; ${n.matched} of those matched to people (${n.matchedSeveral} to more than one person).`,
    `Notes: ${n.people} people have one in the address book: ${n.written} written, ${n.unchanged} already as it says, ` +
      `${n.keptCaptains} kept because you changed them.`,
  ];
}

const made = new WeakMap<Db, FriendMap>();

/** The friend map over the module's context's database, made the first time it is asked for. */
export function friendMapOf(context: ModuleStore & ModuleLive): FriendMap {
  let found = made.get(context.db);
  if (!found) made.set(context.db, (found = new FriendMap(context)));
  return found;
}

/** The friend map already made over `db` (by friendMapOf, as the archive opened), for what is handed only the database: its connectors' imports. */
export function friendMapOver(db: Db): FriendMap {
  const found = made.get(db);
  if (!found) throw new Error("friend map's database is open, but friend map was never made over it: the archive must open it first");
  return found;
}
