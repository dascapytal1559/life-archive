// The data contract, version 1: what the friend map module serves friend-map's page (modules/friend-map/page/), under
// /api/archive, and the shapes of every answer and every write. The backend says which parts it serves in its handshake
// (GET /api/archive/contract, a Contract), and each capability lights up part of the app (CAPABILITIES, ROUTES); only
// `map` is required. A shape here is what the page works with, every field filled; on the wire a backend may leave out
// the fields the page's src/contract/schema.ts marks optional, and the page fills them in.
//
// Days and months (YYYY-MM-DD, YYYY-MM) and times of day (HH:MM) are local: in the time zone the handshake names, and
// written in its locale. "You" is the owner of the map.
//
// Two paths, kept apart on purpose:
//   /api/archive/...          structure: people, accounts, counts, dates.
//                             Never message text.
//   /api/archive/content/...  content: timelines, with message text, and
//                             attachment files.
// so a stricter policy can later be put on the content path alone.

// It imports nothing: it is the contract between friend-map's page and the
// archive, the life archive's own since friend-map-frontend was retired. Both
// halves of the friend map module import it (sdk/contract.ts), the page through
// its own src/archive.ts, so there is one copy.

/**
 * The contract's version, semver: a minor version adds an optional route, field or capability; a major one removes,
 * renames or changes the meaning of anything. The page refuses a backend of another major version.
 */
export const CONTRACT_VERSION = "1.3.0";

/** What a backend serves, and what each part lights up in the app. Only `map` is required. */
export const CAPABILITIES = {
  map: "Required. The map views (the Spider web, Orbits, Orbits 3D, Circles, the City, the frozen views), Methodology, the find box, Names, the person panel's header and its Events chart",
  "score-report": "The facts closeness is scored from, everyone's; without it friend-map works them out from the map's report (the people on the map only)",
  query: "The Query bar's answers from the backend; without it the page runs the query language itself, over GET /people",
  "query.sql": "Extension: SQL in the Query bar (a query starting SELECT or WITH)",
  "query.generate": "Extension: the Query bar's Generate, a query written by a model from what you say",
  panel: "The person panel's group chats, calls and hangouts",
  content: "The person panel's messages, and attachment files",
  table: "The Table of people, scored by friend-map",
  calendar: "The Calendar, with `content` for a day's messages",
  river: "The Time river: GET /message-apps, with /catch-ups and /calls (under `panel` and `table` below), which it reads too",
  events: "Live reload: the page draws again when people or messages change",
  identity: "The People list's merge proposals",
  changes: "The change log (the Changes panel)",
  drafts: "Extension: the person panel's draft box",
  send: "Extension: the person panel's composer, which sends a message",
  "map-facts": "Extension: the counts the static demo's shape is worked out from (npm run demo-shape)",
  "edit.people": "Adding people and changing their names, tags, note, reach-out, location and identicon",
  "edit.tags": "Making, renaming, moving and deleting tags",
  "edit.identity": "Joining two people into one, taking an account off someone, answering merge proposals",
  "edit.hangouts": "Adding, changing and deleting hangouts",
  "edit.calls": "Logging calls, and their lengths, notes and answers",
  "edit.groups": "Unlinking someone from a group chat, archiving a group chat's untouched people",
  "edit.undo": "Every change's Undo chip",
  scores: "friend-map's own scoring: the friend map module scores the Table and the Events chart with the page's code (page/scoring.ts), and adds this to the handshake",
} as const;

export type Capability = keyof typeof CAPABILITIES;

/** The handshake (GET /api/archive/contract): the contract version a backend serves, its capabilities, and its time zone. */
export interface Contract {
  /** CONTRACT_VERSION as the backend was written for it, "1.0.0". */
  version: string;
  /** What it serves; a name the page does not know is passed over. */
  capabilities: string[];
  /** The IANA time zone its days and months are in, "Europe/Berlin". */
  timeZone: string;
  /** The BCP 47 locale its numbers and dates are written in, "de-DE" (1.3.0); without it, the browser's. */
  locale?: string;
}

/** One route of the contract, under /api/archive: what it is for, what it takes and what it answers (a type below). */
export interface Route {
  capability: Capability;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** With :id, :name, :month, :day for its parts. */
  path: string;
  /** Its query, if it takes one. */
  query?: string;
  /** What it is sent, a type below. */
  body?: string;
  /** What it answers, a type below; "events" for a stream of server-sent events, "file" for a file's bytes. */
  answer: string;
  /** Capabilities it needs beside its own: it is served only where they are too. */
  needs?: readonly Capability[];
}

/** Every route of the contract, by capability; a route several capabilities read is under the first. */
export const ROUTES: readonly Route[] = [
  { capability: "map", method: "GET", path: "/contract", answer: "Contract" },
  { capability: "map", method: "GET", path: "/relationships", query: "q=<query>&reveal=archive (with `query` only)", answer: "RelationshipsReport" },
  { capability: "map", method: "GET", path: "/people", query: "query=<words>&tag=<tag> (both optional)", answer: "PeopleListing" },
  { capability: "map", method: "GET", path: "/people/:id", answer: "PersonSummary" },
  { capability: "score-report", method: "GET", path: "/score-report", answer: "ScoreReport" },
  { capability: "query", method: "GET", path: "/query", query: "q=<query>&hide=<tag> (hide repeated, optional)", answer: "QueryResult" },
  { capability: "query.generate", method: "POST", path: "/query/generate", body: "{ query: string; transcript: string }", answer: "GeneratedQuery" },
  { capability: "panel", method: "GET", path: "/people/:id/groups", answer: "PersonGroup[]" },
  { capability: "panel", method: "GET", path: "/groups/:id", answer: "GroupChat" },
  { capability: "panel", method: "GET", path: "/people/:id/calls", query: "account=<account id> (optional)", answer: "PersonCall[]" },
  { capability: "panel", method: "GET", path: "/catch-ups", query: "person=<person id> (optional)", answer: "CatchUp[]" },
  { capability: "panel", method: "GET", path: "/calls/:id", answer: "LoggedCall" },
  { capability: "content", method: "GET", path: "/content/people/:id/timeline", query: "before=&after=&limit=&count=1&groups=1&marketplace=1&account= (all optional)", answer: "TimelinePage" },
  { capability: "content", method: "GET", path: "/content/conversations/:id/messages", query: "before=&after=&limit=&count=1 (all optional)", answer: "TimelinePage" },
  { capability: "content", method: "GET", path: "/content/attachments/:id", answer: "file" },
  { capability: "table", method: "GET", path: "/table-rows", answer: "TableRow[]" },
  { capability: "table", method: "GET", path: "/calls", answer: "ListedCall[]" },
  { capability: "table", method: "GET", path: "/locations", answer: "LocationInfo[]" },
  { capability: "table", method: "GET", path: "/tags", answer: "TagInfo[]" },
  { capability: "calendar", method: "GET", path: "/calendar/:month", answer: "CalendarMonth" },
  { capability: "calendar", method: "GET", path: "/calendar/:day", answer: "CalendarDay" },
  { capability: "calendar", method: "GET", path: "/content/conversations/:id/days/:day", query: "after=&limit= (optional)", answer: "DayMessagesPage" },
  { capability: "river", method: "GET", path: "/message-apps", answer: "MessageApps[]" },
  { capability: "events", method: "GET", path: "/events", answer: "events" },
  { capability: "identity", method: "GET", path: "/merge-proposals", answer: "MergeProposal[]" },
  { capability: "changes", method: "GET", path: "/changes", query: "limit=<n> (optional)", answer: "ChangesetInfo[]" },
  { capability: "changes", method: "GET", path: "/changes/:id", answer: "ChangesetInfo" },
  { capability: "drafts", method: "GET", path: "/people/:id/drafts", answer: "Draft[]" },
  { capability: "drafts", method: "POST", path: "/people/:id/drafts", body: "{ text: string }", answer: "Draft | null" },
  { capability: "drafts", method: "PUT", path: "/drafts/:id", body: "{ text: string }", answer: "Draft | null" },
  { capability: "send", method: "GET", path: "/people/:id/send-targets", answer: "SendTarget[]" },
  { capability: "send", method: "POST", path: "/content/conversations/:id/send", body: "{ text: string }", answer: "SendResult" },
  { capability: "map-facts", method: "GET", path: "/map-facts", answer: "MapFacts" },
  { capability: "edit.people", method: "POST", path: "/people", body: "NewPerson", answer: "PersonAdded" },
  { capability: "edit.people", method: "PUT", path: "/people/:id/names", body: "{ names: string[] }", answer: "PersonSaved" },
  { capability: "edit.people", method: "PUT", path: "/people/:id/tags", body: "{ tags: string[] }", answer: "TagsSaved" },
  { capability: "edit.people", method: "PUT", path: "/people/:id/note", body: "{ note: string }", answer: "PersonSummary" },
  { capability: "edit.people", method: "PUT", path: "/people/:id/should-reach-out", body: "{ shouldReachOut: boolean }", answer: "PersonSummary" },
  { capability: "edit.people", method: "PUT", path: "/people/:id/location", body: "{ location: string | null }", answer: "PersonSaved" },
  { capability: "edit.people", method: "PUT", path: "/people/:id/identicon", body: "{ seed: string; hue: number | null }", answer: "PersonSaved" },
  { capability: "edit.tags", method: "POST", path: "/tags", body: "{ name: string }", answer: "TagsChanged" },
  { capability: "edit.tags", method: "PUT", path: "/tags/:name", body: "{ name: string }", answer: "TagsChanged" },
  { capability: "edit.tags", method: "PUT", path: "/tags/:name/position", body: "{ position: number }", answer: "TagsChanged" },
  { capability: "edit.tags", method: "DELETE", path: "/tags/:name", answer: "TagsChanged" },
  { capability: "edit.identity", method: "POST", path: "/people/:id/merge", body: "{ with: number }", answer: "PersonSummary" },
  { capability: "edit.identity", method: "POST", path: "/people/:id/accounts/:accountId/detach", answer: "PersonSummary" },
  { capability: "edit.identity", method: "POST", path: "/merge-proposals/:id/confirm", answer: "PersonSummary" },
  { capability: "edit.identity", method: "POST", path: "/merge-proposals/:id/reject", answer: "null" },
  { capability: "edit.hangouts", method: "POST", path: "/catch-ups", body: "CatchUpInput", answer: "CatchUpSaved" },
  { capability: "edit.hangouts", method: "PUT", path: "/catch-ups/:id", body: "CatchUpInput", answer: "CatchUpSaved" },
  { capability: "edit.hangouts", method: "DELETE", path: "/catch-ups/:id", answer: "CatchUpSaved" },
  { capability: "edit.hangouts", method: "POST", path: "/catch-ups/:id/call", body: "ManualCallInput", answer: "ManualCallSaved" },
  { capability: "edit.calls", method: "POST", path: "/calls", body: "ManualCallInput", answer: "ManualCallSaved" },
  { capability: "edit.calls", method: "PUT", path: "/calls/:id", body: "ManualCallInput", answer: "ManualCallSaved" },
  { capability: "edit.calls", method: "DELETE", path: "/calls/:id", answer: "ManualCallSaved" },
  { capability: "edit.calls", method: "POST", path: "/calls/:id/catch-up", body: "CatchUpInput", answer: "CatchUpSaved" },
  { capability: "edit.calls", method: "PUT", path: "/messages/:id/call-length", body: "{ minutes: number | null }", answer: "CallLengthSaved" },
  { capability: "edit.calls", method: "PUT", path: "/call-notes", body: "{ call: CallRef; note: string }", answer: "CallNoteSaved" },
  { capability: "edit.calls", method: "PUT", path: "/call-answered", body: "{ call: CallRef; answered: CallAnswer }", answer: "CallAnsweredSaved" },
  { capability: "edit.groups", method: "PUT", path: "/people/:id/groups/:groupId/unlinked", body: "{ unlinked: boolean }", answer: "GroupUnlinkSaved" },
  { capability: "edit.groups", method: "POST", path: "/groups/:id/archive-untouched", body: "{ people: number[] }", answer: "ArchivedUntouched" },
  { capability: "edit.undo", method: "POST", path: "/changes/:id/undo", body: "{}", answer: "ChangesetInfo" },
  { capability: "scores", method: "GET", path: "/table", query: "<closeness settings> (each optional)", answer: "PeopleTable", needs: ["table"] },
  { capability: "scores", method: "GET", path: "/people/:id/activity", query: "<closeness settings> (each optional)", answer: "PersonActivity" },
];

/** Routes a capability reads besides its own in ROUTES, which ROUTES lists under another. */
export const ALSO_READS: Partial<Record<Capability, readonly string[]>> = {
  table: ["/catch-ups"],
  river: ["/catch-ups", "/calls"],
};

/** Tagging someone this archives them: off the map and every map view (the Table still lists them), whatever the automatic rules say. */
export const ARCHIVE_TAG = "archive";

/** Tagging someone this keeps them out of the automatic archive rules (the "archive" tag still wins). */
export const KEEP_TAG = "keep";

/**
 * Tagging someone this says you live with them: infinitely close, ranked above everyone else whatever their
 * closeness score (closenessRanks in src/demos/closeness.ts), and placed right next to the sun on Orbits.
 */
export const LIVE_TOGETHER_TAG = "live-together";

/**
 * Tagging someone this picks them for the name choice No name except… (src/names.ts): with it on, the page names
 * nobody but those with this tag. Kept with them in the archive, so a pick goes through the change log like any tag.
 */
export const SHOW_NAME_TAG = "show-name";

/** The tags that are always there: they can be moved, but not renamed, deleted or merged into. */
export const BUILT_IN_TAGS: readonly string[] = [ARCHIVE_TAG, KEEP_TAG, LIVE_TOGETHER_TAG, SHOW_NAME_TAG];

/** Whether someone with these tags lives with you (LIVE_TOGETHER_TAG). */
export function livesTogether(person: { tags: readonly string[] }): boolean {
  return person.tags.includes(LIVE_TOGETHER_TAG);
}

/**
 * The old name for the rules' archive, from when it was shown apart from the
 * yours. There is one archive now (tagsWithRule), but this is still
 * refused as a tag, and a browser's remembered Hide choice for it folds into
 * "archive" (hideChoices.ts).
 */
export const SYSTEM_ARCHIVE_TAG = "system-archive";

/**
 * A tag as the archive writes it: lower case, with any run of spaces a dash
 * ("Tokyo era" is "tokyo-era"). The server also checks what is left
 * (normalizeTag in server/archive/personFields.ts).
 */
export function writtenTag(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Archived by a rule rather than by your "archive" tag. */
export function archivedByRule(person: { archived: ArchiveReason | null }): boolean {
  return person.archived !== null && person.archived !== "you";
}

/**
 * Their tags as the views show them: with "archive" last when the rules archive
 * them, so there is one archive whoever archived them. It is never stored for
 * the rules' archive (their `archived` says which it was).
 */
export function tagsWithRule(person: { tags: string[]; archived: ArchiveReason | null }): string[] {
  return archivedByRule(person) ? [...person.tags, ARCHIVE_TAG] : person.tags;
}

/**
 * Fields there were once, and what each became (Met and Lives became Location, schema migration 27), so asking for one
 * says where to look instead.
 */
export const FORMER_FIELDS: Readonly<Record<string, "location">> = { met: "location", lives: "location" };

/** One location (GET /api/archive/locations), with how many people are at it. */
export interface LocationInfo {
  name: string;
  count: number;
}

/** Where a person is (person.location, see server/archive/locations.ts). */
export interface PersonLocation {
  /** Where they are, as far as you last knew ("last known location"), e.g. "Brisbane"; null for not said. */
  location: string | null;
}

/**
 * How an import person (an account) came to be linked to its person
 * (see server/archive/people.ts): made for it by an import, joined by a rule,
 * or chosen by you. Rules only ever fill in links you didn't choose.
 */
export type LinkSource = "import" | "captain" | `rule:${string}`;

export interface AccountSummary {
  id: number;
  platform: string;
  displayName: string;
  handle: string | null;
  /** How it is linked to the person it belongs to. */
  link: LinkSource;
  messageCount: number;
  /** Of those, messages in one-to-one chats with this account... */
  directMessageCount: number;
  /** ...and what it sent in group chats. */
  groupMessageCount: number;
  lastMessageAt: number | null;
}

export interface PersonSummary extends PersonLocation {
  id: number;
  name: string;
  /** Other names you know them by, in order: the first is their label (see src/names.ts). */
  aliases: string[];
  /** Their tags ("archive" and "keep" among them), in your tag order. */
  tags: string[];
  /** Your note about them, free text; empty for none. */
  note: string;
  /** The note is as the address book last wrote it (a contact's company and note), so it may write it again. */
  noteFromContacts: boolean;
  /** You should reach out to them (Orbits' glow). */
  shouldReachOut: boolean;
  /** What their identicon is drawn from (src/identicon.ts). */
  identiconSeed: string;
  /** The hue you picked for their identicon, whole degrees; null for the seed's own. */
  identiconHue: number | null;
  /** You have named, tagged or merged them: kept on the map, and never folded into anyone by the rules. */
  edited: boolean;
  /** You have never changed them by hand (People.untouched in server/archive/people.ts): drawn muted in the people views. */
  untouched: boolean;
  /** Why they are archived (off the map and every view), or null when they are not. */
  archived: ArchiveReason | null;
  /** The automatic rule that fits them, whether or not their tags or file override it. */
  archiveRule: ArchiveRule | null;
  accounts: AccountSummary[];
  messageCount: number;
  /** Of those, messages in one-to-one chats with them... */
  directMessageCount: number;
  /** ...and what they sent in group chats. Marketplace chats count in none of these. */
  groupMessageCount: number;
  /** Messages in Marketplace chats with them, left out of the counts above and of their timeline unless asked for. */
  marketplaceMessageCount: number;
  lastMessageAt: number | null;
  /** Every account is a platform's label for a deleted or unknown account, such as "Facebook user". */
  unknown: boolean;
  /** The last message on each platform, newest first. */
  lastByPlatform: Array<{ platform: string; at: number }>;
  /** How they were joined by name from several people, if they were. */
  joined: Join | null;
}

/** Why people were joined (see server/archive/people.ts): exactly the same name, of two words or more or in Chinese. */
export type JoinRule = "same-name";

export interface Join {
  rule: JoinRule;
  /** The accounts the rules joined to this person; "Not them" takes one away again. */
  accountIds: number[];
}

/** An automatic archive rule (see server/archive/archiving.ts). */
export type ArchiveRule = "unknown" | "no-name" | "marketplace" | "they-only" | "you-only" | "groups-wrote" | "groups-silent" | "no-messages";

/** Why someone is archived: by hand ("you", the "archive" tag), or by a rule. */
export type ArchiveReason = "you" | ArchiveRule;

/** How the page names each reason. */
export const ARCHIVE_REASONS: Record<ArchiveReason, string> = {
  you: "Archived by you",
  unknown: "Deleted or unknown account",
  "no-name": "No name (only a number, email, short code or id)",
  marketplace: "Only Marketplace chats",
  "they-only": "Only they wrote (a request or filtered chat)",
  "you-only": "Only you wrote",
  "groups-wrote": "Wrote only in group chats",
  "groups-silent": "In group chats, never wrote",
  "no-messages": "No messages",
};

export interface PeopleListing {
  people: PersonSummary[];
  /** Your own accounts, as one person; null before any import. */
  me: PersonSummary | null;
  /** Every tag in use, with how many people have it, in your tag order (GET /api/archive/tags lists every tag). */
  tags: Array<{ tag: string; count: number }>;
}

/** One of your tags (GET /api/archive/tags), listed in your order. */
export interface TagInfo {
  name: string;
  /** How many people have it; a tag nobody has is still a tag. */
  count: number;
  /** One of BUILT_IN_TAGS: they can be moved, but not renamed or deleted. */
  builtIn: boolean;
}

/**
 * One person's facts for the Table view, as the archive gives them (GET /api/archive/table-rows): everyone, archived
 * people included, with just what the table shows and sorts on, less closeness. Counts and dates only, never text.
 */
export interface TableRow extends PersonLocation {
  id: number;
  name: string;
  aliases: string[];
  /** Their tags, with "archive" when the rules archive them (tagsWithRule); `archived` says which archive it is. */
  tags: string[];
  note: string;
  /** What their identicon is drawn from (src/identicon.ts). */
  identiconSeed: string;
  /** The hue you picked for their identicon, whole degrees; null for the seed's own. */
  identiconHue: number | null;
  unknown: boolean;
  /** As PersonSummary's. */
  untouched: boolean;
  archived: ArchiveReason | null;
  /** The platforms of their accounts, most messages first. */
  platforms: string[];
  /** As PersonSummary counts them. */
  messageCount: number;
  directMessageCount: number;
  groupMessageCount: number;
  lastMessageAt: number | null;
  /** Their counts on each platform they have an account on, in `platforms`' order (for the Table's platform picker). */
  byPlatform: PlatformCounts[];
  /** Their calls from the phone's call history (platform "phone"), added up; null with none. */
  calls: CallCounts | null;
  /**
   * When they were added to the archive (person.created_at): by the import that first met them, or by you
   * (a person detached from another is added then). A merge keeps the kept person's.
   */
  addedAt: number;
  /**
   * When you and they were first in touch, across every platform: the earliest of their messages (as
   * messageCount counts them), their calls of any source (answered or not, logged ones too) and the catch-ups they
   * were at (a catch-up's day and time, or its day's start without one); null with none.
   */
  firstContactAt: number | null;
}

/** One row of the Table view (GET /api/archive/table): a TableRow with friend-map's closeness score (the friend map module's page/scoring.ts). */
export interface TablePerson extends TableRow {
  /** Their closeness score now (src/demos/closeness.ts), with the settings asked for. */
  closeness: number;
}

/** A person's messages on one platform, summed over their accounts there, counted as PersonSummary counts them. */
export interface PlatformCounts {
  platform: string;
  messageCount: number;
  directMessageCount: number;
  groupMessageCount: number;
  lastMessageAt: number | null;
}

/** A person's calls added up (server/archive/calls.ts, callCounts), for the Table's Phone calls. */
export interface CallCounts {
  answered: number;
  unanswered: number;
  /** How long the answered calls were connected, in all. */
  seconds: number;
  /** When the newest call started, answered or not. */
  lastCallAt: number;
}

/** These accounts' counts by platform, most messages first (then A to Z), each platform once. */
export function countsByPlatform(accounts: readonly AccountSummary[]): PlatformCounts[] {
  const counts = new Map<string, PlatformCounts>();
  for (const account of accounts) {
    const sum = counts.get(account.platform) ?? { platform: account.platform, messageCount: 0, directMessageCount: 0, groupMessageCount: 0, lastMessageAt: null };
    sum.messageCount += account.messageCount;
    sum.directMessageCount += account.directMessageCount;
    sum.groupMessageCount += account.groupMessageCount;
    if (account.lastMessageAt !== null && account.lastMessageAt > (sum.lastMessageAt ?? -Infinity)) sum.lastMessageAt = account.lastMessageAt;
    counts.set(account.platform, sum);
  }
  return [...counts.values()].sort((a, b) => b.messageCount - a.messageCount || a.platform.localeCompare(b.platform));
}

/** The platforms of these accounts, most messages first, each once. */
export function platformsOf(accounts: readonly AccountSummary[]): string[] {
  return countsByPlatform(accounts).map((counts) => counts.platform);
}

/**
 * What the closeness score is worked out with: every setting but the trend's window (src/settings.ts says what each
 * does). The Table is asked for its scores with these.
 */
export interface ClosenessSettings {
  closenessHalfLifeDays: number;
  catchUpHourWorth: number;
  callMinimumMinutes: number;
  messageReciprocity: number;
  groupSharedPart: number;
  tripFullHours: number;
}

export interface PeopleTable {
  generatedAt: number;
  /** What the closeness scores were worked out with. */
  settings: ClosenessSettings;
  people: TablePerson[];
}

export interface MergeEvidence {
  rule: string;
  tier: "high" | "medium" | "low";
  detail: string;
}

export interface MergeProposal {
  id: number;
  tier: "high" | "medium" | "low";
  evidence: MergeEvidence[];
  people: [PersonSummary, PersonSummary];
}

/** Not in the contract: the life archive's own (its CLI and viewer read it), kept here for its copy of this file. */
export interface CoverageReport {
  generatedAt: number;
  platforms: Array<{
    platform: string;
    messageCount: number;
    firstMessageAt: number | null;
    lastMessageAt: number | null;
    /** Whole local days since the last captured message. */
    silentDays: number | null;
    spans: Array<{ from: number; to: number; kind: string }>;
    /** Stretches no source covers, between covered spans. */
    gaps: Array<{ from: number; to: number }>;
    lastImport: { at: number; label: string; kind: string } | null;
    /** Messages per local month, YYYY-MM. */
    months: Array<{ month: string; count: number }>;
  }>;
}

/** Not in the contract: the life archive's own, as CoverageReport. */
export interface ConnectorStatus {
  id: string;
  platform: string | null;
  description: string;
  enabled: boolean;
  status: "idle" | "running" | "error" | "disabled";
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  failures: number;
  capabilities: { history: boolean; sync: boolean; send: boolean };
  /** The service it reads, if it needs one running beside friend-map (the bridge rig). */
  companion: string | null;
  /** How a sync connector is doing while the server runs it; null for the others, and from the CLI. */
  live: LiveState | null;
}

/** How a sync connector is doing (see server/connectors/sync.ts). */
export interface LiveState {
  /**
   * "off": switched off; "waiting": the service it reads does not answer; "starting"; "stopped";
   * "connecting", "connected", "logged-out" (the bridge has no login), "bridge-offline"; or "error".
   */
  state: "off" | "waiting" | "starting" | "stopped" | "connecting" | "connected" | "logged-out" | "bridge-offline" | "error";
  detail: string | null;
  since: number;
}

export interface AttachmentInfo {
  /** Its file is served at /api/archive/content/attachments/<id> (see attachmentUrl in archiveApi.ts). */
  id: number;
  type: string;
  mime: string | null;
  size: number | null;
  /** The source did not have the file. */
  missing: boolean;
  /** Messenger's like sticker (the thumbs-up), in which of its three sizes; null for anything else. */
  like: "small" | "medium" | "large" | null;
}

export interface TimelineMessage {
  id: number;
  platform: string;
  conversation: { id: number; type: "direct" | "group"; title: string | null; marketplace: boolean };
  sentAt: number;
  fromSelf: boolean;
  /** The sender's display name; null for system events. */
  sender: string | null;
  type: string;
  text: string | null;
  unsent: boolean;
  /**
   * A call record's (type "call") length: seconds connected, as its app says (Messenger, Instagram; 0 for one never
   * answered, which Signal says too), else as you gave it (callLengthGiven); null when not known (WeChat,
   * Signal's answered calls, Messenger's phone-app export) and for anything not a call.
   */
  callSeconds: number | null;
  /** The call's length is your own (call_length), so you may change it or take it away. */
  callLengthGiven: boolean;
  /** A call record's note, your own (call_record_note); empty for none and for anything not a call. */
  callNote: string;
  /**
   * Whether a call record was answered, as you said it (the chat's No answer, PUT /call-answered; or Events' Calls table),
   * over what its app says; null when you said nothing, and for anything not a call. A call you said was missed has
   * no length of yours (callSeconds is its app's own). Since contract 1.1.0: a backend before it leaves it out, read
   * as null.
   */
  callAnswer?: CallAnswer | null;
  attachments: AttachmentInfo[];
  reactions: Array<{ emoji: string; actor: string }>;
}

export interface TimelinePage {
  messages: TimelineMessage[];
  /** Pass as `before` for the next, older page; null when there is none, and on a page asked for with `after`. */
  nextBefore: string | null;
  /** Only on a page asked for with `after`: pass as `after` for the next, newer page; null when this one reaches the newest. */
  nextAfter?: string | null;
  /** How many messages there are in all, when asked for (`count`). */
  total?: number;
}

/** Not in the contract: the life archive's own, as CoverageReport. */
export interface SearchHit extends TimelineMessage {
  /** The matching part of the text, with matches between [ and ]. */
  snippet: string;
}

/** Message counts split by who sent them: in one-to-one chats, and in group chats both share. */
export interface MessageCounts {
  directFromMe: number;
  directFromThem: number;
  /**
   * Of directFromMe, those in one-to-one chats whose source holds only your side (conversation.is_self_only:
   * Discord's data package), where what they wrote back is not known. The closeness score assumes as many back.
   */
  directFromMeSelfOnly: number;
  /** What you sent in group chats the person is in. */
  groupFromMe: number;
  /** What the person sent in group chats. */
  groupFromThem: number;
}

/**
 * What one person's events counted for in a month, in closeness points (direct messages' worth) before fading: the
 * terms the score adds up, each month on its own. Messages are split between the sides by who sent them.
 */
export interface MonthPoints {
  month: string;
  /** The month's direct messages (monthDirect in src/demos/closeness.ts), the share they sent, with the replies assumed where only your side is kept. */
  directThem: number;
  /** Of directThem, the replies assumed (directParts' `assumed`, half of it): not messages of theirs, the even exchange the score takes. */
  directThemAssumed: number;
  /** The month's direct messages, the share you sent. */
  directYou: number;
  /** Their messages in group chats you are both in: each × your share there ÷ others (as closenessScores weighs them); where only your side is kept, half the even exchange assumed (selfOnlyGroupPoints). */
  groupThem: number;
  /** Of groupThem, the part assumed where only your side is kept. */
  groupThemAssumed: number;
  /** Your messages in group chats they are in: each × their share there ÷ others; where only your side is kept, the other half of the even exchange assumed. */
  groupYou: number;
  /** Their days of calls (callCatchUps). */
  calls: number;
  /** Their hangouts (catch-ups, hangoutWorths): their share of each. */
  hangouts: number;
}

/** A person's events each month, all time, for the chart in their panel: counts and closeness points only (personActivity in activity.ts). */
export interface PersonActivity {
  /** Messages per local month (YYYY-MM), oldest first, months with none left out; Marketplace chats are left out (as PersonRelationship's). */
  months: Array<MessageCounts & { month: string }>;
  /**
   * What their messages, calls and hangouts counted for in closeness points each month (personMonthPoints), with how
   * long their answered calls ran and how many hangouts they were at; oldest first, months with none of either left out.
   */
  points: Array<MonthPoints & { callSeconds: number; hangoutCount: number }>;
}

/** A group chat a person is in (listed as a member, or wrote there), for their panel: structure and counts only. */
export interface PersonGroup {
  /** The conversation's id. */
  id: number;
  title: string | null;
  platform: string;
  /**
   * How many people are in it, you included: its listed members and anyone who wrote there, as the archive
   * rules count a group's size (a deleted or unknown account counts as one, though it may stand for several).
   */
  people: number;
  fromThem: number;
  fromMe: number;
  /** Its last message, from anyone. */
  lastMessageAt: number | null;
  /** With no title: the first few people in it, as GroupChat lists its members, to name it by (groupName.ts); else empty. */
  namedBy: GroupPerson[];
  /** You unlinked them from it (People.unlinkFromGroup): it connects them to nobody, though they are in it. */
  unlinked: boolean;
}

/** Someone in a group chat, as much as naming them takes (the Names choice goes by name and aliases). */
export interface GroupPerson {
  id: number;
  name: string;
  aliases: string[];
}

/** Someone in an open group chat: what they sent there, and what "Archive untouched" goes by. */
export interface GroupMember extends GroupPerson {
  messages: number;
  /** As PersonSummary's. */
  untouched: boolean;
  /** Archived, by you or the rules. */
  archived: boolean;
}

/**
 * One group chat, for its header in a person's panel: its size as PersonGroup counts it, everyone in it but
 * you (listed members and anyone who wrote there), most messages there first, and what came in and when.
 */
export interface GroupChat {
  id: number;
  title: string | null;
  platform: string;
  people: number;
  members: GroupMember[];
  fromMe: number;
  messageCount: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
}

/** One person's side of the relationship in numbers: counts and dates only, never text. */
export interface PersonRelationship extends PersonLocation {
  id: number;
  name: string;
  aliases: string[];
  tags: string[];
  /** Your note about them, free text; empty for none. Orbits' find box finds people by it, as the Table's search does. */
  note: string;
  /** You should reach out to them (Orbits' glow). */
  shouldReachOut: boolean;
  /** What their identicon is drawn from (src/identicon.ts). */
  identiconSeed: string;
  /** The hue you picked for their identicon, whole degrees; null for the seed's own. */
  identiconHue: number | null;
  /** Every account is a platform's label for a deleted or unknown account, such as "Facebook user". */
  unknown: boolean;
  /** The platforms of their accounts, most messages first (as TablePerson's). */
  platforms: string[];
  /** Marketplace chats are left out of every count here. */
  totals: MessageCounts;
  /** The first and last message in a direct chat with them, or that they sent in a group. */
  firstMessageAt: number | null;
  lastMessageAt: number | null;
  /** Messages per local month (YYYY-MM), oldest first; months with none are left out. */
  months: Array<MessageCounts & { month: string }>;
  /** Reactions you put on their messages, and they on yours. */
  reactions: { fromMe: number; fromThem: number };
  /** Direct conversations picked up again after RelationshipsReport.gapDays or more of quiet, by who wrote first. */
  openings: { byMe: number; byThem: number };
}

/** A group chat as membership only: who is in it (as person ids), and how busy it is. No title. */
export interface GroupMembership {
  id: number;
  /** Everyone in it but you. */
  memberIds: number[];
  /** Its source holds only your own messages (conversation.is_self_only: Discord's data package), so fromMembers is empty. */
  selfOnly: boolean;
  messageCount: number;
  lastMessageAt: number | null;
  /**
   * Messages per local month (YYYY-MM), oldest first, months with none
   * left out: all of them, yours, and each person's who wrote (by
   * person id, only those who did).
   */
  months: Array<{ month: string; messages: number; fromMe: number; fromMembers: Array<{ id: number; count: number }> }>;
}

/** Someone you unlinked from a group chat: they are in it, but it connects them to nobody. */
export interface GroupUnlink {
  personId: number;
  groupId: number;
}

/** Who of group chat `group`'s members are unlinked from it, by `unlinks`. */
export function unlinkedIds(group: Pick<GroupMembership, "id" | "memberIds">, unlinks: readonly GroupUnlink[]): number[] {
  return group.memberIds.filter((id) => unlinks.some((u) => u.groupId === group.id && u.personId === id));
}

/**
 * Who a group chat connects: its members but those unlinked from it. Everything that goes by who shares group chats
 * (the map's links when holding someone, friend circles) goes by these; closeness does not.
 */
export function connectedIds(group: Pick<GroupMembership, "id" | "memberIds">, unlinks: readonly GroupUnlink[]): number[] {
  const unlinked = unlinkedIds(group, unlinks);
  return unlinked.length === 0 ? group.memberIds : group.memberIds.filter((id) => !unlinked.includes(id));
}

/**
 * A catch-up (src/catchUps.ts): time you spent with people in person, on a date, for some hours, or over several
 * days (a trip away together, `trip`); a call is never one, but a call (ManualCallInput). Your own record: imports
 * never write one.
 */
export interface CatchUp {
  id: number;
  /** Its local date, YYYY-MM-DD; with a trip, the day it began. */
  day: string;
  /** When it started on that date, local time, 19:30; null when not said (it then sits at the start of its day). Needed with a trip: when it began (when you left, say). */
  time: string | null;
  /** How it ran over several days, when it did (a trip away together); null for one on a single date. */
  trip: Trip | null;
  /**
   * How long it lasted: more than 0, at most HOURS_MOST, to two decimal places. With a trip, its time together in all:
   * every hour from its start to its end outside each day's private window (tripHours in src/catchUps.ts), more than
   * 0, which the archive works out from them (whatever hours it is given).
   */
  hours: number;
  /** Your note on it, free text; empty for none. */
  note: string;
  /** Everyone at it but you, A to Z. */
  people: GroupPerson[];
  /** How many more were there, unnamed (a crowd at a wedding): a whole number from 0 to OTHERS_MOST. They take a share of its worth and are no one. */
  others: number;
}

/**
 * How a catch-up over several days ran (src/catchUps.ts): from its day at its time to `lastDay` at `endTime`, with
 * `privateFrom` to `privateTo` of each day kept private (asleep, time alone; PRIVATE_FROM to PRIVATE_TO unless
 * you say), all times of day in the time zone, of day written 19:30. The window runs across midnight when privateFrom is the
 * later (23:00 to 07:00), and is no time at all when they are the same. Its time together is the rest (tripDayHours).
 */
export interface Trip {
  /** Its last local date, YYYY-MM-DD: after the catch-up's day, no later than today, at most DAYS_MOST days from it (both counted). */
  lastDay: string;
  /** When it ended on lastDay (when you got home, say). */
  endTime: string;
  /** When each day's private window starts. */
  privateFrom: string;
  /** When it ends. */
  privateTo: string;
}

/** A catch-up to add, or what one becomes: all of it but its number, with everyone at it by person id. */
export type CatchUpInput = Omit<CatchUp, "id" | "people"> & { personIds: number[] };

/** "Add person": someone you know offline, added by hand with no accounts; all but the name optional. */
export interface NewPerson {
  name: string;
  location?: string | null;
  tags?: string[];
  note?: string;
  /** Add them even when someone already has that name or alias (`sameName`). */
  anyway?: boolean;
}

/** Someone who already goes by a name being added, so the page can offer them instead. */
export interface SameNamed {
  id: number;
  name: string;
  aliases: string[];
}

/**
 * What "Add person" did: the person and the changeset that added them (to undo); or, when someone already goes by
 * that name and `anyway` was not given, nobody added (person and changeset null) and who they are in `sameName`.
 */
export interface PersonAdded {
  person: PersonSummary | null;
  changeset: number | null;
  sameName: SameNamed[];
}

/** A catch-up added, changed or deleted (null), and the changeset that did it (null when nothing changed), so it can be undone. */
export interface CatchUpSaved {
  catchUp: CatchUp | null;
  changeset: number | null;
}

/** A catch-up as the map's report has it, for the closeness score: when (and how it ran, over several days), how long, and who. */
export type ScoredCatchUp = Pick<CatchUp, "id" | "day" | "time" | "trip" | "hours" | "others"> & { personIds: number[] };

/**
 * A day's answered calls with one person (the phone's call history), for the closeness score: they count as hours
 * caught up, by how long they add up to (callHours in src/catchUps.ts).
 */
export interface CallDay {
  personId: number;
  /** The local day the calls started on, YYYY-MM-DD. */
  day: string;
  /** How long the day's answered one-to-one calls with them were connected, in all: a call held twice (one you logged that the phone's call history brings in too) counted once. */
  seconds: number;
  /**
   * The day's answered calls with them and others (logged by you, or an app's in no chat), each its whole
   * length and how many people were on it besides you, unnamed ones too; each counts their share of its time
   * (callDaySeconds in src/catchUps.ts). Left out for none.
   */
  groupCalls?: Array<{ seconds: number; people: number }>;
}

/**
 * A call with someone whose length is known, for their panel: when, how long, which way, and over what. From the
 * phone's call history, another app's call with several people made in no chat (a WhatsApp three-way call), another
 * app's call record in a one-to-one chat (Messenger, Instagram, or any you gave a length), or one you
 * logged yourself (Add event's Call: `manual`).
 */
export interface PersonCall {
  /**
   * The call in no chat (call.id: the phone's, or one row of an app's with several people); for another app's in a
   * chat, its call record (message.id), as messageId says; for one logged, manual_call.id.
   */
  id: number;
  /**
   * "phone" for the phone's call history (phone and FaceTime calls), else the app ("messenger", "instagram",
   * "whatsapp"); for one logged, its account's platform, or on no account the app you said it was on (a ManualCallApp).
   */
  platform: string;
  /** Another app's call record, which is a message in the chat as well (so the chat has it already); else null. */
  messageId: number | null;
  /** You logged it yourself (manual_call): it says neither which way nor over what service. */
  manual: boolean;
  /**
   * The account the call was with (one of the person's: on platform "phone", the app's in the chat, or the one you
   * logged it on); null for one logged on no account.
   */
  accountId: number | null;
  /** When it started, ms since the epoch. */
  at: number;
  /** How long it was connected; 0 for one never answered. */
  durationSeconds: number;
  /** Null for one logged. */
  direction: "incoming" | "outgoing" | null;
  /** Connected: picked up when it came in, or answered at the other end (or by voicemail) when it went out. One logged was. */
  answered: boolean;
  /**
   * Over what: the phone's "phone", "facetime-audio" or "facetime-video"; an app's in no chat "voice" or "video"; null
   * for another app's in a chat and one logged.
   */
  service: "phone" | "facetime-audio" | "facetime-video" | "voice" | "video" | null;
  /**
   * For a call with several people (one logged, or an app's in no chat), its call group, which every row of it shares:
   * for one logged, the number of its first logged call; for an app's, minus its first row's number (call.id), so the
   * two never meet. Else null.
   */
  group: number | null;
  /**
   * How many people were on it, you aside: 1, or for one with several, how many (each counts a share of its
   * time), its unnamed `others` among them.
   */
  people: number;
  /** How many of them its source could not name (an app's call in no chat with people it knows no account of), or you did not (one you logged); else 0. */
  others: number;
  /** Your note on it (CallRef says where it is kept); empty for none. */
  note: string;
}

/**
 * Which call a note or a length is for, whatever its source: a call in no chat (`call`: call.id, any row of it, the
 * phone's or an app's with several people), another app's call record in a chat (`record`: message.id), or one
 * you logged (`logged`: manual_call.id, any of its group).
 */
export type CallRef = { kind: "call" | "record" | "logged"; id: number };

/**
 * One call as listCalls lists them (GET /api/archive/calls; calls.ts listCalls): every call with anyone, from every
 * source, as one row however many were on it, newest first. Its note is your own, content as a hangout's note is.
 */
export interface ListedCall {
  /** Which call it is, for its note and length (and a logged call's id, to change it). */
  ref: CallRef;
  /** When it started, ms since the epoch. */
  at: number;
  /** As PersonCall's: "phone" for the phone's call history, else the app; one logged, its account's platform or app. */
  platform: string;
  /** As PersonCall's: over what, for a call in no chat; null for a call record and one logged. */
  service: PersonCall["service"];
  /**
   * Where it comes from: the phone's call history (`history`), an app's calls list (`app`: a WhatsApp three-way call),
   * a call record in a one-to-one chat (`record`), or you (`logged`).
   */
  source: "history" | "app" | "record" | "logged";
  /** Null for one logged. */
  direction: PersonCall["direction"];
  /**
   * Connected, as PersonCall's; null when not known (its source says neither how long nor whether, a WeChat call
   * compressed). Your answer when you set one (answeredSet), else its source's.
   */
  answered: boolean | null;
  /** Whether `answered` is yours (call_answered), not its source's; never for one logged. */
  answeredSet: boolean;
  /** What its source says, whatever you set: as `answered`. One logged was answered. */
  sourceAnswered: boolean | null;
  /** How long it was connected (0 for one never answered); null when not known. */
  durationSeconds: number | null;
  /**
   * Whose its length is: its source's (`source`), yours for a call record that had none (`given`,
   * call_length), or one you logged (`logged`); null when not known.
   */
  length: "source" | "given" | "logged" | null;
  /** Whether you may set or change its length here: a call record in a one-to-one chat without its app's, and one logged. */
  lengthEditable: boolean;
  /** Everyone on it its source names, by person id (never you), each once. */
  people: number[];
  /** How many more were on it, whom its source could not name. */
  others: number;
  note: string;
}

/** Whether an imported call was answered, as you set it (Events' Calls table, the chat's No answer; null in `answered`: not known). */
export type CallAnswer = "answered" | "missed" | "unknown";

/**
 * An imported call's answer set (PUT /api/archive/call-answered): whether it was answered now (null: not known), whether
 * that is yours (false once set back to what its source says), and the changeset that did it (null when
 * nothing changed).
 */
export interface CallAnsweredSaved {
  call: CallRef;
  answered: boolean | null;
  answeredSet: boolean;
  changeset: number | null;
}

/** A call's note set or taken away (empty), and the changeset that did it (null when nothing changed). */
export interface CallNoteSaved {
  call: CallRef;
  note: string;
  changeset: number | null;
}

/** The apps a call you log on no account may be on (manual_call.app), for someone with no account that carries calls. */
export const MANUAL_CALL_APPS = ["phone", "facetime", "whatsapp", "messenger", "instagram", "signal", "telegram", "wechat", "discord", "other"] as const;
export type ManualCallApp = (typeof MANUAL_CALL_APPS)[number];

/**
 * A call you log yourself (Add event's Call), with one or more people: who was on it, each on one of their
 * accounts, the local date and time it started (no later than today), and how long it lasted in whole minutes.
 */
export interface ManualCallInput {
  /** Everyone on it, each once: a group call has several, kept as one logged call each (a call group). */
  people: CallPersonInput[];
  /** YYYY-MM-DD. */
  day: string;
  /** HH:MM, local time. */
  time: string;
  minutes: number;
  /** A note, if you like: one for the whole call; empty for none. */
  note: string;
}

/** Someone on a call you log, and what it was on with them. */
export interface CallPersonInput {
  personId: number;
  /**
   * One of their accounts that carries calls (CALL_PLATFORMS in calls.ts): the call is on its platform, and goes with
   * it when it moves to someone else. Null only for someone with none, when `app` says what it was on.
   */
  accountId: number | null;
  /** On no account (accountId null), the app; else null. */
  app: ManualCallApp | null;
}

/** A call you logged, as Add event's Call changes it: when, how long, and everyone on it. */
export interface LoggedCall {
  /** When it started, ms since the epoch. */
  at: number;
  durationSeconds: number;
  note: string;
  /** Everyone on it, in the order they were added (a person once even if two of theirs were since merged). */
  people: LoggedCallPerson[];
}

/** Someone on a logged call: their logged call of it, and the account it was on with them. */
export interface LoggedCallPerson {
  /** Their logged call (manual_call.id), which their chat shows. */
  callId: number;
  person: GroupPerson;
  /** The account it was on; null for none. */
  accountId: number | null;
  /** Its account's platform, or on no account the app (a ManualCallApp). */
  platform: string;
}

/** A logged call added, changed or deleted (null), as the person's calls list it, and the changeset that did it. */
export interface ManualCallSaved {
  call: PersonCall | null;
  changeset: number | null;
}

/** A message you are writing to someone (server/archive/drafts.ts): your scratch space, saved as you type. */
export interface Draft {
  id: number;
  personId: number;
  text: string;
  createdAt: number;
  updatedAt: number;
}

/** A call record given its length by you, or its length taken away: the call as the chat now reads it, and the changeset. */
export interface CallLengthSaved {
  call: Pick<TimelineMessage, "callSeconds" | "callLengthGiven"> & { messageId: number };
  changeset: number | null;
}

/**
 * A month of the Calendar view (GET /api/archive/calendar/:month): what each local day of it had, with who was in
 * each chat, call and catch-up, so the page can leave out whoever its Hide does and count the rest. Never message text.
 * Marketplace chats, dropped group chats and system messages count in nothing, as everywhere else.
 */
export interface CalendarMonth {
  /** YYYY-MM. */
  month: string;
  /** The first and last local days with any message, call or catch-up in the archive (null with none), to navigate by. */
  span: { first: string | null; last: string | null };
  /** Every chat with messages in the month. */
  chats: CalendarChat[];
  /** Everyone in them, and in the month's calls and catch-ups, with their tags ("archive" too for the rules' archive), for Hide. */
  people: CalendarTagged[];
  /** The days with anything, in order. */
  days: CalendarDayCounts[];
}

/** A chat in the Calendar view: one-to-one or a group, and the people in it. */
export interface CalendarChat {
  id: number;
  type: "direct" | "group";
  /**
   * Everyone in it but you, by person id: a one-to-one chat's other person (nobody, for your chat with
   * yourself); a group's listed members and whoever wrote there in the month (or on the day) asked for.
   */
  people: number[];
}

/** Someone in a month or day of the Calendar view, with their tags for Hide ("archive" for the rules' archive too). */
export interface CalendarTagged {
  id: number;
  tags: string[];
}

/** What one day of a CalendarMonth had: messages per chat, calls and catch-ups. */
export interface CalendarDayCounts {
  /** YYYY-MM-DD. */
  day: string;
  chats: Array<{ chat: number; messages: number }>;
  /** Each call with each person: a call with several (logged, or an app's in no chat) is one each, sharing its group (PersonCall.group). */
  calls: Array<{ person: number; answered: boolean; seconds: number; group: number | null }>;
  /** Each catch-up that day (its number, so a trip on several days is known as one), a trip on each of its days with its hours that day (tripDayHours). */
  catchUps: Array<{ id: number; people: number[]; hours: number }>;
}

/**
 * One day of the Calendar view (GET /api/archive/calendar/:day): its catch-ups, its calls and the chats with messages
 * that day, each in time order, without message text; the messages come from the content path a chat at a time
 * (DayMessagesPage).
 */
export interface CalendarDay {
  /** YYYY-MM-DD. */
  day: string;
  /** Its catch-ups, one over several days (a trip) on each of its days. */
  catchUps: CatchUp[];
  calls: CalendarCall[];
  /** In the order their first message that day came. */
  chats: CalendarDayChat[];
  /** Everyone in them, with what a heading shows of them. */
  people: CalendarPerson[];
}

/** A call on a Calendar day, with who it was with. */
export interface CalendarCall extends PersonCall {
  person: number;
}

/** A chat on a Calendar day: where it is, what it is called, and its messages that day. */
export interface CalendarDayChat extends CalendarChat {
  platform: string;
  title: string | null;
  /** How many people are in it, you included, as a group chat's header counts them. */
  size: number;
  /** An untitled group's first few people, most messages there first, to name it by (groupName). */
  namedBy: GroupPerson[];
  /** How many messages it had that day, and when the first and last came. */
  messages: number;
  first: number;
  last: number;
}

export interface CalendarPerson extends GroupPerson, CalendarTagged {
  identiconSeed: string;
  identiconHue: number | null;
}

/** A page of one chat's messages on one local day, oldest first (GET /api/archive/content/conversations/:id/days/:day). */
export interface DayMessagesPage {
  messages: TimelineMessage[];
  /** Pass as `after` for the next, later page; null when there is none. */
  nextAfter: string | null;
}

/**
 * One person's messages by app and local month (GET /api/archive/message-apps), counted as a map view counts
 * them: one-to-one both ways, and theirs in group chats. Counts only: the Time river's App filter.
 */
export interface MessageApps {
  id: number;
  /** Each app (the platform of the chats) they have messages on, A to Z, its months with any oldest first. */
  apps: Array<{ platform: string; months: Array<{ month: string; messages: number }> }>;
}

export interface RelationshipsReport {
  generatedAt: number;
  /** The quiet stretch, in days, after which a direct message counts as reopening the conversation. */
  gapDays: number;
  /**
   * Everyone on the map, their tags with "archive" for the rules' archive too. Archived people are left out (the
   * Table lists them), but for those the map's Hide shows (GET /relationships?q=&reveal=); `groups` still names
   * them, so a group keeps its real size.
   */
  people: PersonRelationship[];
  /** How many people are archived, in `people` or not. */
  archivedCount: number;
  groups: GroupMembership[];
  /**
   * Everyone you unlinked from a group chat (the person panel's break-link button, People.unlinkFromGroup):
   * still in it, in `groups` (so its size and closeness count them), but it connects them to nobody (connectedIds).
   */
  unlinks: GroupUnlink[];
  /** Every catch-up, oldest first, naming everyone at it (archived people too, as `groups` does). */
  catchUps: ScoredCatchUp[];
  /** Every day with answered calls, per person (archived people too), oldest first. */
  callDays: CallDay[];
}

/**
 * What closeness and activity are worked out from (GET /api/archive/score-report; src/demos/closeness.ts and
 * src/activity.ts): everyone's messages by month, the group chats, the catch-ups and the calls. From the archive,
 * `people` is everyone with messages, archived people too, and anyone at a catch-up or on a call without any (someone
 * added by hand, say) with no months, and `generatedAt` is when it was read; friend-map scores it as of its own now.
 */
export type ScoreReport = Pick<RelationshipsReport, "generatedAt" | "groups" | "catchUps" | "callDays"> & {
  people: Array<Pick<PersonRelationship, "id" | "months">>;
};

/**
 * What the static demo's shape is worked out from (GET /api/archive/map-facts; server/demo-shape.ts, with the score
 * report for closeness and the hangouts): counts, times and person ids only, never a name, a tag, a title or a message.
 * People are told apart as the app tells them (archiveReason), you left out.
 */
export interface MapFacts {
  /** Everyone the map shows: those with an account, or edited, archived neither by hand nor by the rules. */
  people: MapFactsPerson[];
  archived: {
    byHand: number;
    /** How many each automatic rule archived. */
    byRule: Record<string, number>;
  };
  /** Messages on each platform, all time, system messages aside. */
  platformMessages: Record<string, number>;
  /** How many locations someone is at. */
  locations: number;
  /** Each group chat with people listed in it (Marketplace chats aside): how many, whether it has a title, and how many the map shows. */
  groups: Array<{ size: number; titled: boolean; shown: number }>;
  /** Each group chat with messages (Marketplace chats and system messages aside): how many, how many yours, the first's and the last's time. */
  groupMessages: Array<{ messages: number; mine: number; first: number; last: number }>;
  /** Messages each UTC month (YYYY-MM) with any, oldest first, system messages aside. */
  months: Array<{ month: string; count: number }>;
  /** The calls with the people shown, from every source. */
  calls: Array<{ personId: number; at: number; answered: boolean | null; durationSeconds: number | null }>;
  /** How many people have each tag in the tag table. */
  tagPeople: number[];
}

/** One person the map shows, in MapFacts. */
export interface MapFactsPerson {
  id: number;
  /** One-to-one messages both ways plus theirs in group chats. */
  messages: number;
  /** One-to-one messages you sent them, and they sent you. */
  youDirect: number;
  theyDirect: number;
  lastMessageAt: number | null;
  /** The platforms they have an account on. */
  platforms: string[];
  /** How many tags they have, "archive" and "keep" aside. */
  tags: number;
  /** How many group chats they are in. */
  groups: number;
  located: boolean;
  reachOut: boolean;
  /** What the map's report counts of their messages; null when it has none of them. */
  report: { firstMessageAt: number | null; reactions: { fromMe: number; fromThem: number }; openings: { byMe: number; byThem: number } } | null;
}

/** A chat the person panel's composer can send into (see server/archive/send.ts). */
export interface SendTarget {
  conversationId: number;
  platform: string;
  title: string | null;
  /** The sync connector that sends there, and how it is doing: sending works only while it is "connected". */
  connector: string;
  state: LiveState;
}

/** How a send went. "unconfirmed": handed to the bridge, which did not say in time whether the platform took it. */
export interface SendResult {
  id: number;
  status: "sent" | "failed" | "unconfirmed";
  error: string | null;
  /** The sent message's platform id, when the platform gave one. */
  messageId: string | null;
}

/** A query's answer: the ids of everyone, archived people too, it matches (GET /api/archive/query). */
export interface QueryResult {
  ids: number[];
  /** How many of them Hide shows: those with none of the tags it was given ("archive" counting everyone archived); all of them without. */
  shown: number;
}

/**
 * Whether a query is SQL rather than the query language: its first word, after any SQL comments, is SELECT
 * or WITH, followed by a space or a new line (so the tags select-crew and with-family stay tags). SQL runs read-only
 * over the archive's tables and views (server/archive/sqlQuery.ts); a tag named "select" or "with" is asked for
 * as tag:select.
 */
export function isSqlQuery(text: string): boolean {
  return /^(?:\s|--[^\n]*(?:\n|$)|\/\*(?:[^*]|\*(?!\/))*(?:\*\/|$))*(?:select|with)(?:\s|$)/i.test(text);
}

/**
 * The most people the map draws: a query that would show more after Hide is
 * refused before anything of it loads (useQueryBar's `limit`), as tens of
 * thousands, everyone archived, would freeze the page.
 */
export const SHOWN_LIMIT = 1_000;

/** A query a model wrote from what you said (POST /api/archive/query/generate), checked to run. */
export interface GeneratedQuery {
  query: string;
  /** How many people, archived people too, it matches. */
  count: number;
  /** What the model could not put in the query, in a sentence; empty when nothing. */
  note: string;
}

/** Where a change to people was made: the app (its routes) or the CLI (npm run archive, which agents use). */
export type ChangeSurface = "cli" | "app";

/** One thing a changeset changed about a person, as it read before and after ("" for none). */
export interface FieldChange {
  /** name, aliases, tags, location, note, reach out, draft opener, identicon, accounts, or person (added or deleted). */
  what: string;
  before: string;
  after: string;
}

/** What saving someone's tags (PUT /api/archive/people/:id/tags) answers: them after, and the changeset it made (null when it changed nothing). */
export interface TagsSaved {
  person: PersonSummary;
  changeset: number | null;
  /** Tags it added to the tag table, as nobody had made them yet. */
  created: string[];
  /** Tags it deleted, as it took them from the last person who had them. */
  deleted: string[];
}

/**
 * What setting someone's names, location or identicon (PUT /api/archive/people/:id/names, /location, /identicon) answers: them after,
 * and the changeset it made (null when it changed nothing).
 */
export interface PersonSaved {
  person: PersonSummary;
  changeset: number | null;
}

/**
 * What unlinking someone from a group chat, or linking them through it again (PUT
 * /api/archive/people/:id/groups/:groupId/unlinked), answers: whether they are unlinked now, and the changeset it made
 * (null when it changed nothing).
 */
export interface GroupUnlinkSaved {
  unlinked: boolean;
  changeset: number | null;
}

/** What a change to the tag table (POST, PUT or DELETE under /api/archive/tags) answers: every tag after it, and its changeset (null when it changed nothing). */
export interface TagsChanged {
  tags: TagInfo[];
  changeset: number | null;
}

/** What "Archive untouched" in a group chat (POST /api/archive/groups/:id/archive-untouched) did: how many it archived, as one changeset (null when nobody). */
export interface ArchivedUntouched {
  archived: number;
  changeset: number | null;
}

/** A person a changeset touched, with what changed. */
export interface PersonChange {
  id: number;
  /** Their name now, or as it was when the changeset deleted them. */
  name: string;
  changes: FieldChange[];
}

/**
 * One changeset of the change log (GET /api/archive/changes): one edit to people, from the app or the CLI,
 * with each person's before and after, and what else it changed (tags, values, proposals). Undoing it
 * (POST /api/archive/changes/:id/undo) is a changeset too.
 */
export interface ChangesetInfo {
  id: number;
  at: number;
  surface: ChangeSurface;
  /** What was done, in a few words ("edit tag commercial", "tags", "merge"). */
  action: string;
  /** Your words, when an agent passed them. */
  description: string | null;
  /** The backup taken just before it (the CLI's), by file name. */
  backup: string | null;
  undoes: number | null;
  undoneBy: number | null;
  /** Everyone it touched (in a listing, only the first few; see peopleCount). */
  people: PersonChange[];
  peopleCount: number;
  /** What else it changed: tags or values added, renamed, deleted or reordered, people said to be different. */
  other: string[];
}
