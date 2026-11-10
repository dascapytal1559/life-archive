// The backend as the page sees it: the data contract (archive.ts, docs/contract.md) bound to the page. Every view and
// panel reaches the backend only through `archiveApi`, so where the data comes from is one choice, made once at the
// page's entry: the server's routes (archiveHttp.ts, which src/main.tsx provides), or the static demo's made-up crowd,
// held in the page itself (src/demo/archive.ts, which src/demo/main.tsx provides; see demoMode.ts). Nothing in between knows which, so the demo is the same views and panels over another source, not a
// copy of them. A method of a capability the backend does not serve (its handshake, contract()) answers
// ArchiveUnavailable, as a route it does not have answers 404. friend-map's own server, apart from any backend, is
// AppApi (appApi.ts).
//
// Two paths, kept apart on purpose:
//   structure   people, accounts, counts, dates. Never message text.
//   content     timelines, with message text, and attachment files.
// so a stricter policy can later be put on the content path alone.

import type {
  ArchivedUntouched,
  CalendarDay,
  CalendarMonth,
  CatchUp,
  CatchUpInput,
  CallLengthSaved,
  CallAnswer,
  CallAnsweredSaved,
  CallNoteSaved,
  CallRef,
  CatchUpSaved,
  Draft,
  ListedCall,
  LoggedCall,
  ManualCallInput,
  ManualCallSaved,
  ChangesetInfo,
  Contract,
  DayMessagesPage,
  LocationInfo,
  GeneratedQuery,
  GroupChat,
  GroupUnlinkSaved,
  PersonSaved,
  MergeProposal,
  MessageApps,
  NewPerson,
  PeopleListing,
  PeopleTable,
  PersonActivity,
  PersonAdded,
  PersonCall,
  PersonGroup,
  PersonSummary,
  QueryResult,
  RelationshipsReport,
  SendResult,
  SendTarget,
  TagInfo,
  TagsChanged,
  TagsSaved,
  TimelinePage,
} from "./archive.ts";
import type { ClosenessSettings } from "./settings.ts";
import type { ArchiveChange } from "./useArchive.ts";

/** An archive answer that is an error, with the archive's own words for what is wrong (`reason`). */
export class ArchiveError extends Error {
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.reason = reason;
  }
}

/** An archive answer that is not an error: the archive has nothing (404) or is not available (503). */
export class ArchiveUnavailable extends ArchiveError {}

/** The archive not available at all (503): no backend answers, or it will not serve (`reason`, friend-map's server's words). */
export class ArchiveDown extends ArchiveUnavailable {}

/**
 * A page of a chat: `before` from the last page's `nextBefore`, or `after` (a page's `nextAfter`, or a moment as
 * `<ms>:0`) for the messages just newer, `limit` messages, and with `count` how many there are in all.
 */
export interface ChatPage {
  before?: string;
  after?: string;
  limit?: number;
  count?: boolean;
}

/**
 * A page of a person's messages: their one-to-one chats, what they said in groups only with `groups`, Marketplace chats only with `marketplace`,
 * and with `account` only that one account of theirs.
 */
export interface TimelineRequest extends ChatPage {
  groups?: boolean;
  marketplace?: boolean;
  account?: number;
}

export interface ArchiveApi {
  /** The handshake: the contract version the backend serves, its capabilities and its time zone (src/contract/handshake.ts). */
  contract(): Promise<Contract>;
  // Structure: names, counts and dates only.
  people(filter?: { query?: string; tag?: string }): Promise<PeopleListing>;
  person(id: number): Promise<PersonSummary>;
  /**
   * "Add person": someone added by hand, with no accounts, as one changeset (its chip offers to undo it); when someone
   * already goes by that name and `anyway` is not set, nobody is added, and they are in `sameName`.
   */
  addPerson(person: NewPerson): Promise<PersonAdded>;
  /**
   * Every name they go by, in order (the person panel's chips): the first their name and label, the rest their aliases;
   * at least one. With the changeset it made, so the chip can offer to undo it.
   */
  setNames(id: number, names: string[]): Promise<PersonSaved>;
  /** With the changeset it made and the tags it made or deleted, so the chip can offer to undo them (changeChip.ts). */
  setTags(id: number, tags: string[]): Promise<TagsSaved>;
  /** Your note about them ("" for none). */
  setNote(id: number, note: string): Promise<PersonSummary>;
  /** Whether you should reach out to them. */
  setShouldReachOut(id: number, shouldReachOut: boolean): Promise<PersonSummary>;
  /** The messages you are writing to them (drafts), the first first. Drafts are no edit: no changeset. */
  drafts(personId: number): Promise<Draft[]>;
  /** A new draft to them; null, and none kept, when `text` is empty. */
  addDraft(personId: number, text: string): Promise<Draft | null>;
  /** Draft `id` with this text; emptied, it is deleted (null). */
  setDraft(id: number, text: string): Promise<Draft | null>;
  /** Where they are, as far as you last knew (null for not said), with the changeset it made, so the chip can offer to undo it. */
  setLocation(id: number, location: string | null): Promise<PersonSaved>;
  /** Their identicon drawn from `seed` in `hue` (whole degrees; null for the seed's own): the icon picker's draft saved. */
  setIdenticon(id: number, seed: string, hue: number | null): Promise<PersonSaved>;
  /** "Join person": `id` is joined into `into`, which is kept (with its name) and returned; `id` is deleted. */
  join(id: number, into: number): Promise<PersonSummary>;
  detach(id: number, accountId: number): Promise<PersonSummary>;
  /** Every tag, in your order, with how many people have it. Each change below answers with the list after it, and its changeset. */
  tags(): Promise<TagInfo[]>;
  createTag(name: string): Promise<TagsChanged>;
  /** For everyone who has it; onto a tag that exists, the two are merged into that one. */
  renameTag(from: string, to: string): Promise<TagsChanged>;
  /** To `position` in the order, 0 first. */
  moveTag(name: string, position: number): Promise<TagsChanged>;
  /** Takes it from everyone. */
  deleteTag(name: string): Promise<TagsChanged>;
  /** Every location someone is at, the most people first. */
  locations(): Promise<LocationInfo[]>;
  proposals(): Promise<MergeProposal[]>;
  confirm(id: number): Promise<PersonSummary>;
  reject(id: number): Promise<null>;
  /** The change log, newest first: every edit to people, from here or the CLI, each with its first few people. */
  changes(limit?: number): Promise<ChangesetInfo[]>;
  /** One changeset, with everyone it touched. */
  changeset(id: number): Promise<ChangesetInfo>;
  /** Puts back what a changeset changed (a changeset of its own); an ArchiveError naming who when any of it has changed since. */
  undoChange(id: number): Promise<ChangesetInfo>;
  /**
   * The map's report; with `reveal`, also the archived people the query `q` matches, whether you archived them
   * or the rules did.
   */
  relationships(q?: string, reveal?: boolean): Promise<RelationshipsReport>;
  /** Everyone's messages by app and month, as the map views count them (the Time river's App filter). */
  messageApps(): Promise<MessageApps[]>;
  /** Everyone, archived people too, one light row each, closeness scored with `settings`. */
  table(settings: ClosenessSettings): Promise<PeopleTable>;
  /** Every catch-up, or just those `personId` was at, the latest first, each with everyone at it. */
  catchUps(personId?: number): Promise<CatchUp[]>;
  /** Adds a catch-up, as one changeset (its chip offers to undo it). */
  addCatchUp(input: CatchUpInput): Promise<CatchUpSaved>;
  /** Makes a catch-up as `input` says, who was at it too. */
  changeCatchUp(id: number, input: CatchUpInput): Promise<CatchUpSaved>;
  deleteCatchUp(id: number): Promise<CatchUpSaved>;
  /** Logs a call with one or more people (Add event's Call), as one changeset (its chip offers to undo it). */
  addCall(input: ManualCallInput): Promise<ManualCallSaved>;
  /** Logged call `id`'s group: everyone on it, to change it. */
  loggedCall(id: number): Promise<LoggedCall>;
  /** Makes logged call `id`'s whole group as `input` says. */
  changeCall(id: number, input: ManualCallInput): Promise<ManualCallSaved>;
  /** Deletes logged call `id`'s whole group. */
  deleteCall(id: number): Promise<ManualCallSaved>;
  /** Makes logged call `id`'s whole group a catch-up as `input` says, as one changeset (its chip offers to undo it). */
  callToCatchUp(id: number, input: CatchUpInput): Promise<CatchUpSaved>;
  /** Makes catch-up `id` a logged call as `input` says, as one changeset (its chip offers to undo it). */
  catchUpToCall(id: number, input: ManualCallInput): Promise<ManualCallSaved>;
  /**
   * Gives a call record whose app does not say how long it was its length, in whole minutes, or takes that away
   * (null), as one changeset (its chip offers to undo it); an ArchiveError for any other call.
   */
  setCallLength(messageId: number, minutes: number | null): Promise<CallLengthSaved>;
  /** Every call with anyone, from every source, one each, newest first, with its note: the Time river's calls (once the Table's Calls tab too). */
  listCalls(): Promise<ListedCall[]>;
  /** Gives call `call` its note, or takes it away (empty), as one changeset (its chip offers to undo it). */
  setCallNote(call: CallRef, note: string): Promise<CallNoteSaved>;
  /** Whether imported call `call` was answered, as you say; the same as its source says takes yours away. */
  setCallAnswered(call: CallRef, answered: CallAnswer): Promise<CallAnsweredSaved>;
  /** A month of the Calendar view (YYYY-MM): what each local day had, with who was in it. */
  calendarMonth(month: string): Promise<CalendarMonth>;
  /** A day of the Calendar view (YYYY-MM-DD): its catch-ups, calls and chats. */
  calendarDay(day: string): Promise<CalendarDay>;
  /** The chats the composer in a person's panel can send into, with how their connector is doing. */
  sendTargets(personId: number): Promise<SendTarget[]>;
  /** Their messages, calls and hangouts each month, all time, and what each counted for in closeness points with `settings` (the chart in their panel). */
  activity(personId: number, settings: ClosenessSettings): Promise<PersonActivity>;
  /** Their calls of known length (the phone's, other apps', and those logged), newest first; with `accountId`, only that account's of theirs. */
  calls(personId: number, accountId?: number): Promise<PersonCall[]>;
  /** The group chats they are in, the latest first (the list in their panel's Messages). */
  groups(personId: number): Promise<PersonGroup[]>;
  /** Unlinks them from a group chat (it connects them to nobody, though they stay in it), or links them through it again; with its changeset. */
  setGroupUnlinked(personId: number, groupId: number, unlinked: boolean): Promise<GroupUnlinkSaved>;
  /** One group chat for its header: its size, everyone in it with what they sent there, and what came in when. */
  group(groupId: number): Promise<GroupChat>;
  /**
   * Archives everyone in a group chat who is untouched and not archived, as one changeset (its chip offers Undo);
   * `shown` is who the page said it would archive, and an ArchiveError when that is no longer who it is.
   */
  archiveUntouched(groupId: number, shown: readonly number[]): Promise<ArchivedUntouched>;
  /**
   * Everyone, archived people too, a query matches (the Query bar), and how many of them have none of the `hide` tags
   * (Hide's ticked tags); an ArchiveError saying what is wrong when it does not run.
   */
  query(q: string, hide?: readonly string[]): Promise<QueryResult>;
  /** A query the model writes from `transcript`, new or changing `current` (the Query bar's Generate). */
  generateQuery(current: string, transcript: string): Promise<GeneratedQuery>;
  /** Calls `onChange` whenever people change anywhere (the CLI included), or new messages come in. Returns a function that stops it. */
  follow(onChange: (change: ArchiveChange) => void): () => void;

  // Content: message text.
  /** A person's messages, newest first. */
  timeline(personId: number, page?: TimelineRequest): Promise<TimelinePage>;
  /** One chat's messages, newest first (a group chat opened in a person's panel). */
  conversation(conversationId: number, page?: ChatPage): Promise<TimelinePage>;
  /** One chat's messages on one local day (YYYY-MM-DD), oldest first, a page at a time from `after` (the Calendar's day). */
  dayMessages(conversationId: number, day: string, page?: { after?: string; limit?: number }): Promise<DayMessagesPage>;
  /** Sends a text message into a direct chat (the composer's Send, and nothing else). */
  send(conversationId: number, text: string): Promise<SendResult>;
  /** Where the browser loads an attachment's file from (an img, video or audio src). */
  attachmentUrl(id: number): string;
}

let provided: ArchiveApi | null = null;

/** Names where the page's archive is. The entry (src/main.tsx, src/demo/main.tsx) calls it once, before anything draws. */
export function provideArchive(api: ArchiveApi): void {
  provided = api;
}

/** The archive the entry provided; asking before it has is a mistake in the entry, and says so. */
export const archiveApi: ArchiveApi = new Proxy({} as ArchiveApi, {
  get(_target, key: string | symbol) {
    if (!provided) throw new Error(`archiveApi.${String(key)} was used before provideArchive() named where the archive is`);
    return provided[key as keyof ArchiveApi];
  },
});
