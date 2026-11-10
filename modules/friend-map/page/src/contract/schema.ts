// Every answer of the contract (archive.ts) as a shape (shape.ts): what contract-check holds a backend's answers to,
// and, for the `map` capability's answers, what the page fills in where a backend leaves a field out.
//
// Only `map`'s answers have optional fields (the four routes a minimal backend serves: /contract, /relationships,
// /people, /people/:id): there a backend needs to send only who people are and how much you talk, and every field the
// page can do without has a default, worked out from the rest where it can be. The life archive's own fields
// (extension: true) are among them. Every other capability's answers are as archive.ts writes them, in full.

import {
  type AccountSummary, type ArchiveReason, type ArchiveRule, type AttachmentInfo, type CalendarCall, type CalendarChat, type CalendarDay,
  type CalendarDayChat, type CalendarDayCounts, type CalendarMonth, type CalendarPerson, type CalendarTagged, type CallCounts, type CallDay,
  type CallRef, type CatchUp, type ChangesetInfo, type Contract, type Draft, type FieldChange, type GroupChat, type GroupMember,
  type GroupMembership, type GroupPerson, type GroupUnlink, type Join, type ListedCall, type LiveState, type LocationInfo, type LoggedCall,
  type LoggedCallPerson, type MapFacts, type MapFactsPerson, type MergeEvidence, type MergeProposal, type MessageApps, type MessageCounts,
  type MonthPoints, type PeopleListing, type PeopleTable, type PersonActivity, type PersonCall, type PersonChange, type PersonGroup,
  type PersonRelationship, type PersonSummary, type PlatformCounts, type QueryResult, type RelationshipsReport, type ScoredCatchUp,
  type ScoreReport, type SendTarget, type TableRow, type TablePerson, type TagInfo, type TimelineMessage, type TimelinePage, type Trip,
  type DayMessagesPage, type ClosenessSettings, type LinkSource, type GeneratedQuery, type PersonAdded, type PersonSaved, type TagsSaved,
  type TagsChanged, type CatchUpSaved, type ManualCallSaved, type CallLengthSaved, type CallNoteSaved, type CallAnsweredSaved, type CallAnswer,
  type GroupUnlinkSaved, type ArchivedUntouched, type SendResult, type SameNamed,
} from "../archive.ts";
import { identiconSeedOf } from "../identicon.ts";
import {
  absent, anything, array, boolean, literal, named, nothing, nullable, number, object, optional, pattern, record, string, tuple,
  type AnyShape, type ObjectShape, type Shape,
} from "./shape.ts";

const day = pattern("YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/);
const month = pattern("YYYY-MM", /^\d{4}-\d{2}$/);
const clock = pattern("HH:MM", /^\d{2}:\d{2}$/);
const id = number;
const at = named(number, "ms since the epoch");
const ids = array(number);

const archiveRule: Shape<ArchiveRule> = literal("unknown", "no-name", "marketplace", "they-only", "you-only", "groups-wrote", "groups-silent", "no-messages");
const archiveReason: Shape<ArchiveReason> = literal("you", "unknown", "no-name", "marketplace", "they-only", "you-only", "groups-wrote", "groups-silent", "no-messages");
const callAnswer: Shape<CallAnswer> = literal("answered", "missed", "unknown");
const linkSource = pattern<LinkSource>('"import" | "captain" | "rule:<name>"', /^(import|captain|rule:.+)$/);

const sum = <T>(items: readonly T[], of: (item: T) => number) => items.reduce((total, item) => total + of(item), 0);
const latest = (times: ReadonlyArray<number | null>) => times.reduce<number | null>((last, t) => (t !== null && (last === null || t > last) ? t : last), null);
/** "" for none, as the page writes no text. */
const noText = () => "";
const none = <T>() => [] as T[];

// The handshake.

export const contractShape = object<Contract>("Contract", {
  version: pattern("semver, 1.0.0", /^\d+\.\d+\.\d+$/),
  capabilities: array(string),
  timeZone: string,
  locale: absent(string),
});

// `map`: people, and the map's report.

const messageCountFields = {
  directFromMe: number,
  directFromThem: number,
  directFromMeSelfOnly: optional(number, () => 0, "0", { extension: true }),
  groupFromMe: number,
  groupFromThem: number,
};

export const messageCounts = object<MessageCounts>("MessageCounts", messageCountFields);

const monthCounts = object<MessageCounts & { month: string }>("MessageCounts & { month }", { month, ...messageCountFields });

export const accountSummary = object<AccountSummary>("AccountSummary", {
  id,
  platform: string,
  displayName: string,
  handle: optional(nullable(string), () => null, "null"),
  link: optional(linkSource, () => "import" as LinkSource, '"import"', { extension: true }),
  messageCount: optional(number, () => 0, "0"),
  directMessageCount: optional(number, () => 0, "0"),
  groupMessageCount: optional(number, () => 0, "0"),
  lastMessageAt: optional(nullable(at), () => null, "null"),
});

export const join = object<Join>("Join", { rule: literal("same-name"), accountIds: ids });

export const personSummary = object<PersonSummary>("PersonSummary", {
  id,
  name: string,
  location: optional(nullable(string), () => null, "null"),
  aliases: optional(array(string), none<string>, "[]"),
  tags: optional(array(string), none<string>, "[]"),
  note: optional(string, noText, '""'),
  noteFromContacts: optional(boolean, () => false, "false", { extension: true }),
  shouldReachOut: optional(boolean, () => false, "false"),
  identiconSeed: optional(string, (p: PersonSummary) => identiconSeedOf(p.id, 0), "a seed made from their id"),
  identiconHue: optional(nullable(number), () => null, "null"),
  edited: optional(boolean, () => false, "false"),
  untouched: optional(boolean, () => false, "false"),
  archived: optional(nullable(archiveReason), () => null, "null"),
  archiveRule: optional(nullable(archiveRule), () => null, "null", { extension: true }),
  accounts: optional(array(accountSummary), none<AccountSummary>, "[]"),
  messageCount: optional(number, (p: PersonSummary) => sum(p.accounts, (a) => a.messageCount), "the sum of their accounts'"),
  directMessageCount: optional(number, (p: PersonSummary) => sum(p.accounts, (a) => a.directMessageCount), "the sum of their accounts'"),
  groupMessageCount: optional(number, (p: PersonSummary) => sum(p.accounts, (a) => a.groupMessageCount), "the sum of their accounts'"),
  marketplaceMessageCount: optional(number, () => 0, "0", { extension: true }),
  lastMessageAt: optional(nullable(at), (p: PersonSummary) => latest(p.accounts.map((a) => a.lastMessageAt)), "the latest of their accounts'"),
  unknown: optional(boolean, () => false, "false"),
  lastByPlatform: optional(array(object<{ platform: string; at: number }>("{ platform, at }", { platform: string, at })),
    (p: PersonSummary) => lastByPlatform(p.accounts), "worked out from their accounts"),
  joined: optional(nullable(join), () => null, "null", { extension: true }),
});

/** The last message on each platform, newest first, from these accounts. */
function lastByPlatform(accounts: readonly AccountSummary[]): Array<{ platform: string; at: number }> {
  const last = new Map<string, number>();
  for (const a of accounts) if (a.lastMessageAt !== null && a.lastMessageAt > (last.get(a.platform) ?? -Infinity)) last.set(a.platform, a.lastMessageAt);
  return [...last].map(([platform, at]) => ({ platform, at })).sort((a, b) => b.at - a.at);
}

export const peopleListing = object<PeopleListing>("PeopleListing", {
  people: array(personSummary),
  me: optional(nullable(personSummary), () => null, "null"),
  tags: optional(array(object<{ tag: string; count: number }>("{ tag, count }", { tag: string, count: number })),
    (p: PeopleListing) => tagCounts(p.people), "worked out from people's tags"),
});

/** Every tag these people have, with how many have it, in the order first met. */
function tagCounts(people: readonly PersonSummary[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const person of people) for (const tag of person.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count }));
}

const emptyCounts = (): MessageCounts => ({ directFromMe: 0, directFromThem: 0, directFromMeSelfOnly: 0, groupFromMe: 0, groupFromThem: 0 });

export const personRelationship = object<PersonRelationship>("PersonRelationship", {
  id,
  name: string,
  months: array(monthCounts),
  location: optional(nullable(string), () => null, "null"),
  aliases: optional(array(string), none<string>, "[]"),
  tags: optional(array(string), none<string>, "[]"),
  note: optional(string, noText, '""'),
  shouldReachOut: optional(boolean, () => false, "false"),
  identiconSeed: optional(string, (p: PersonRelationship) => identiconSeedOf(p.id, 0), "a seed made from their id"),
  identiconHue: optional(nullable(number), () => null, "null"),
  unknown: optional(boolean, () => false, "false"),
  platforms: optional(array(string), none<string>, "[]"),
  totals: optional(messageCounts, (p: PersonRelationship) => {
    const totals = emptyCounts();
    for (const m of p.months) for (const key of Object.keys(totals) as Array<keyof MessageCounts>) totals[key] += m[key];
    return totals;
  }, "the sum of `months`"),
  firstMessageAt: optional(nullable(at), () => null, "null"),
  lastMessageAt: optional(nullable(at), () => null, "null"),
  reactions: optional(object<{ fromMe: number; fromThem: number }>("{ fromMe, fromThem }", { fromMe: number, fromThem: number }),
    () => ({ fromMe: 0, fromThem: 0 }), "{ fromMe: 0, fromThem: 0 }"),
  openings: optional(object<{ byMe: number; byThem: number }>("{ byMe, byThem }", { byMe: number, byThem: number }),
    () => ({ byMe: 0, byThem: 0 }), "{ byMe: 0, byThem: 0 }"),
});

type GroupMonth = GroupMembership["months"][number];
const groupMonth = object<GroupMonth>("{ month, messages, fromMe, fromMembers }", {
  month,
  messages: number,
  fromMe: number,
  fromMembers: array(object<{ id: number; count: number }>("{ id, count }", { id, count: number })),
});

export const groupMembership = object<GroupMembership>("GroupMembership", {
  id,
  memberIds: ids,
  months: optional(array(groupMonth), none<GroupMonth>, "[]"),
  selfOnly: optional(boolean, () => false, "false", { extension: true }),
  messageCount: optional(number, (g: GroupMembership) => sum(g.months, (m) => m.messages), "the sum of `months`"),
  lastMessageAt: optional(nullable(at), () => null, "null"),
});

export const groupUnlink = object<GroupUnlink>("GroupUnlink", { personId: id, groupId: id });

export const trip = object<Trip>("Trip", { lastDay: day, endTime: clock, privateFrom: clock, privateTo: clock });

export const scoredCatchUp = object<ScoredCatchUp>("ScoredCatchUp", {
  id,
  day,
  hours: number,
  personIds: ids,
  time: optional(nullable(clock), () => null, "null"),
  trip: optional(nullable(trip), () => null, "null"),
  others: optional(number, () => 0, "0"),
});

export const callDay = object<CallDay>("CallDay", {
  personId: id,
  day,
  seconds: number,
  groupCalls: absent(array(object<{ seconds: number; people: number }>("{ seconds, people }", { seconds: number, people: number }))),
});

export const relationshipsReport = object<RelationshipsReport>("RelationshipsReport", {
  people: array(personRelationship),
  generatedAt: optional(at, () => Date.now(), "when the page read it"),
  gapDays: optional(number, () => 14, "14"),
  archivedCount: optional(number, () => 0, "0"),
  groups: optional(array(groupMembership), none<GroupMembership>, "[]"),
  unlinks: optional(array(groupUnlink), none<GroupUnlink>, "[]"),
  catchUps: optional(array(scoredCatchUp), none<ScoredCatchUp>, "[]"),
  callDays: optional(array(callDay), none<CallDay>, "[]"),
});

// `score-report`, and friend-map's own scores.

export const scoreReport = object<ScoreReport>("ScoreReport", {
  generatedAt: at,
  people: array(object<Pick<PersonRelationship, "id" | "months">>("{ id, months }", { id, months: array(monthCounts) })),
  groups: array(groupMembership),
  catchUps: array(scoredCatchUp),
  callDays: array(callDay),
});

const monthPoints = object<MonthPoints & { callSeconds: number; hangoutCount: number }>("MonthPoints & { callSeconds, hangoutCount }", {
  month,
  directThem: number,
  directThemAssumed: number,
  directYou: number,
  groupThem: number,
  groupThemAssumed: number,
  groupYou: number,
  calls: number,
  hangouts: number,
  callSeconds: number,
  hangoutCount: number,
});

export const personActivity = object<PersonActivity>("PersonActivity", { months: array(monthCounts), points: array(monthPoints) });

export const closenessSettings = object<ClosenessSettings>("ClosenessSettings", {
  closenessHalfLifeDays: number,
  catchUpHourWorth: number,
  callMinimumMinutes: number,
  messageReciprocity: number,
  groupSharedPart: number,
  tripFullHours: number,
});

// `query`.

export const queryResult = object<QueryResult>("QueryResult", { ids, shown: number });

// `panel`.

const groupPersonFields = { id, name: string, aliases: array(string) };

export const groupPerson = object<GroupPerson>("GroupPerson", groupPersonFields);

export const personGroup = object<PersonGroup>("PersonGroup", {
  id,
  title: nullable(string),
  platform: string,
  people: number,
  fromThem: number,
  fromMe: number,
  lastMessageAt: nullable(at),
  namedBy: array(groupPerson),
  unlinked: boolean,
});

export const groupMember = object<GroupMember>("GroupMember", { ...groupPersonFields, messages: number, untouched: boolean, archived: boolean });

export const groupChat = object<GroupChat>("GroupChat", {
  id,
  title: nullable(string),
  platform: string,
  people: number,
  members: array(groupMember),
  fromMe: number,
  messageCount: number,
  firstMessageAt: nullable(at),
  lastMessageAt: nullable(at),
});

const personCallFields = {
  id,
  platform: string,
  messageId: nullable(id),
  manual: boolean,
  accountId: nullable(id),
  at,
  durationSeconds: number,
  direction: nullable(literal("incoming", "outgoing")),
  answered: boolean,
  service: nullable(literal("phone", "facetime-audio", "facetime-video", "voice", "video")),
  group: nullable(number),
  people: number,
  others: number,
  note: string,
};

export const personCall = object<PersonCall>("PersonCall", personCallFields);

export const catchUp = object<CatchUp>("CatchUp", {
  id,
  day,
  time: nullable(clock),
  trip: nullable(trip),
  hours: number,
  note: string,
  people: array(groupPerson),
  others: number,
});

const loggedCallPerson = object<LoggedCallPerson>("LoggedCallPerson", { callId: id, person: groupPerson, accountId: nullable(id), platform: string });

export const loggedCall = object<LoggedCall>("LoggedCall", { at, durationSeconds: number, note: string, people: array(loggedCallPerson) });

// `content`.

const attachmentInfo = object<AttachmentInfo>("AttachmentInfo", {
  id,
  type: string,
  mime: nullable(string),
  size: nullable(number),
  missing: boolean,
  like: nullable(literal("small", "medium", "large")),
});

export const timelineMessage = object<TimelineMessage>("TimelineMessage", {
  id,
  platform: string,
  conversation: object<TimelineMessage["conversation"]>("{ id, type, title, marketplace }", {
    id,
    type: literal("direct", "group"),
    title: nullable(string),
    marketplace: boolean,
  }),
  sentAt: at,
  fromSelf: boolean,
  sender: nullable(string),
  type: string,
  text: nullable(string),
  unsent: boolean,
  callSeconds: nullable(number),
  callLengthGiven: boolean,
  callNote: string,
  callAnswer: absent(nullable(callAnswer)),
  attachments: array(attachmentInfo),
  reactions: array(object<{ emoji: string; actor: string }>("{ emoji, actor }", { emoji: string, actor: string })),
});

export const timelinePage = object<TimelinePage>("TimelinePage", {
  messages: array(timelineMessage),
  nextBefore: nullable(string),
  nextAfter: absent(nullable(string)),
  total: absent(number),
});

// `table`.

const callRef = object<CallRef>("CallRef", { kind: literal("call", "record", "logged"), id });

const platformCounts = object<PlatformCounts>("PlatformCounts", {
  platform: string,
  messageCount: number,
  directMessageCount: number,
  groupMessageCount: number,
  lastMessageAt: nullable(at),
});

const callCounts = object<CallCounts>("CallCounts", { answered: number, unanswered: number, seconds: number, lastCallAt: at });

const tableRowFields = {
  id,
  name: string,
  location: nullable(string),
  aliases: array(string),
  tags: array(string),
  note: string,
  identiconSeed: string,
  identiconHue: nullable(number),
  unknown: boolean,
  untouched: boolean,
  archived: nullable(archiveReason),
  platforms: array(string),
  messageCount: number,
  directMessageCount: number,
  groupMessageCount: number,
  lastMessageAt: nullable(at),
  byPlatform: array(platformCounts),
  calls: nullable(callCounts),
  addedAt: at,
  firstContactAt: nullable(at),
};

export const tableRow = object<TableRow>("TableRow", tableRowFields);

export const peopleTable = object<PeopleTable>("PeopleTable", {
  generatedAt: at,
  settings: closenessSettings,
  people: array(object<TablePerson>("TablePerson", { ...tableRowFields, closeness: number })),
});

export const listedCall = object<ListedCall>("ListedCall", {
  ref: callRef,
  at,
  platform: string,
  service: nullable(literal("phone", "facetime-audio", "facetime-video", "voice", "video")),
  source: literal("history", "app", "record", "logged"),
  direction: nullable(literal("incoming", "outgoing")),
  answered: nullable(boolean),
  answeredSet: boolean,
  sourceAnswered: nullable(boolean),
  durationSeconds: nullable(number),
  length: nullable(literal("source", "given", "logged")),
  lengthEditable: boolean,
  people: ids,
  others: number,
  note: string,
});

export const locationInfo = object<LocationInfo>("LocationInfo", { name: string, count: number });

export const tagInfo = object<TagInfo>("TagInfo", { name: string, count: number, builtIn: boolean });

// `calendar`.

const calendarChatFields = { id, type: literal("direct", "group"), people: ids };
const calendarChat = object<CalendarChat>("CalendarChat", calendarChatFields);
const calendarTagged = object<CalendarTagged>("CalendarTagged", { id, tags: array(string) });

const calendarDayCounts = object<CalendarDayCounts>("CalendarDayCounts", {
  day,
  chats: array(object<{ chat: number; messages: number }>("{ chat, messages }", { chat: id, messages: number })),
  calls: array(object<CalendarDayCounts["calls"][number]>("{ person, answered, seconds, group }", { person: id, answered: boolean, seconds: number, group: nullable(number) })),
  catchUps: array(object<CalendarDayCounts["catchUps"][number]>("{ id, people, hours }", { id, people: ids, hours: number })),
});

export const calendarMonth = object<CalendarMonth>("CalendarMonth", {
  month,
  span: object<CalendarMonth["span"]>("{ first, last }", { first: nullable(day), last: nullable(day) }),
  chats: array(calendarChat),
  people: array(calendarTagged),
  days: array(calendarDayCounts),
});

const calendarCall = object<CalendarCall>("CalendarCall", { ...personCallFields, person: id });

const calendarDayChat = object<CalendarDayChat>("CalendarDayChat", {
  ...calendarChatFields,
  platform: string,
  title: nullable(string),
  size: number,
  namedBy: array(groupPerson),
  messages: number,
  first: at,
  last: at,
});

const calendarPerson = object<CalendarPerson>("CalendarPerson", { id, name: string, aliases: array(string), tags: array(string), identiconSeed: string, identiconHue: nullable(number) });

export const calendarDay = object<CalendarDay>("CalendarDay", {
  day,
  catchUps: array(catchUp),
  calls: array(calendarCall),
  chats: array(calendarDayChat),
  people: array(calendarPerson),
});

export const dayMessagesPage = object<DayMessagesPage>("DayMessagesPage", { messages: array(timelineMessage), nextAfter: nullable(string) });

// `river`.

export const messageApps = object<MessageApps>("MessageApps", {
  id,
  apps: array(object<MessageApps["apps"][number]>("{ platform, months }", {
    platform: string,
    months: array(object<{ month: string; messages: number }>("{ month, messages }", { month, messages: number })),
  })),
});

// `identity`.

const mergeEvidence = object<MergeEvidence>("MergeEvidence", { rule: string, tier: literal("high", "medium", "low"), detail: string });

export const mergeProposal = object<MergeProposal>("MergeProposal", {
  id,
  tier: literal("high", "medium", "low"),
  evidence: array(mergeEvidence),
  // Answers that are not the map's are in full: these people too.
  people: tuple(fullPerson(), fullPerson()),
});

/** A PersonSummary as every answer but `map`'s carries it: every field there. */
function fullPerson(): Shape<PersonSummary> {
  return strict(personSummary);
}

// `changes`.

const fieldChange = object<FieldChange>("FieldChange", { what: string, before: string, after: string });
const personChange = object<PersonChange>("PersonChange", { id, name: string, changes: array(fieldChange) });

export const changesetInfo = object<ChangesetInfo>("ChangesetInfo", {
  id,
  at,
  surface: literal("cli", "app"),
  action: string,
  description: nullable(string),
  backup: nullable(string),
  undoes: nullable(id),
  undoneBy: nullable(id),
  people: array(personChange),
  peopleCount: number,
  other: array(string),
});

// `drafts` and `send` (extensions).

export const draft = object<Draft>("Draft", { id, personId: id, text: string, createdAt: at, updatedAt: at });

const liveState = object<LiveState>("LiveState", {
  state: literal("off", "waiting", "starting", "stopped", "connecting", "connected", "logged-out", "bridge-offline", "error"),
  detail: nullable(string),
  since: at,
});

export const sendTarget = object<SendTarget>("SendTarget", { conversationId: id, platform: string, title: nullable(string), connector: string, state: liveState });

// `map-facts` (an extension).

const mapFactsPerson = object<MapFactsPerson>("MapFactsPerson", {
  id,
  messages: number,
  youDirect: number,
  theyDirect: number,
  lastMessageAt: nullable(at),
  platforms: array(string),
  tags: number,
  groups: number,
  located: boolean,
  reachOut: boolean,
  report: nullable(object<NonNullable<MapFactsPerson["report"]>>("{ firstMessageAt, reactions, openings }", {
    firstMessageAt: nullable(at),
    reactions: object<{ fromMe: number; fromThem: number }>("{ fromMe, fromThem }", { fromMe: number, fromThem: number }),
    openings: object<{ byMe: number; byThem: number }>("{ byMe, byThem }", { byMe: number, byThem: number }),
  })),
});

export const mapFacts = object<MapFacts>("MapFacts", {
  people: array(mapFactsPerson),
  archived: object<MapFacts["archived"]>("{ byHand, byRule }", { byHand: number, byRule: record(number) }),
  platformMessages: record(number),
  locations: number,
  groups: array(object<MapFacts["groups"][number]>("{ size, titled, shown }", { size: number, titled: boolean, shown: number })),
  groupMessages: array(object<MapFacts["groupMessages"][number]>("{ messages, mine, first, last }", { messages: number, mine: number, first: at, last: at })),
  months: array(object<{ month: string; count: number }>("{ month, count }", { month, count: number })),
  calls: array(object<MapFacts["calls"][number]>("{ personId, at, answered, durationSeconds }", {
    personId: id,
    at,
    answered: nullable(boolean),
    durationSeconds: nullable(number),
  })),
  tagPeople: array(number),
});

// What the writes answer (the edit.* capabilities, drafts and send): the thing after the change, and the changeset
// that made it (null for a backend that keeps no change log: the page then offers no Undo).

const changeset = nullable(id);
const sameNamed = object<SameNamed>("SameNamed", { id, name: string, aliases: array(string) });

export const generatedQuery = object<GeneratedQuery>("GeneratedQuery", { query: string, count: number, note: string });
export const personAdded = object<PersonAdded>("PersonAdded", { person: nullable(fullPerson()), changeset, sameName: array(sameNamed) });
export const personSaved = object<PersonSaved>("PersonSaved", { person: fullPerson(), changeset });
export const tagsSaved = object<TagsSaved>("TagsSaved", { person: fullPerson(), changeset, created: array(string), deleted: array(string) });
export const tagsChanged = object<TagsChanged>("TagsChanged", { tags: array(tagInfo), changeset });
export const catchUpSaved = object<CatchUpSaved>("CatchUpSaved", { catchUp: nullable(catchUp), changeset });
export const manualCallSaved = object<ManualCallSaved>("ManualCallSaved", { call: nullable(personCall), changeset });
export const callLengthSaved = object<CallLengthSaved>("CallLengthSaved", {
  call: object<CallLengthSaved["call"]>("{ callSeconds, callLengthGiven, messageId }", { callSeconds: nullable(number), callLengthGiven: boolean, messageId: id }),
  changeset,
});
export const callNoteSaved = object<CallNoteSaved>("CallNoteSaved", { call: callRef, note: string, changeset });
export const callAnsweredSaved = object<CallAnsweredSaved>("CallAnsweredSaved", { call: callRef, answered: nullable(boolean), answeredSet: boolean, changeset });
export const groupUnlinkSaved = object<GroupUnlinkSaved>("GroupUnlinkSaved", { unlinked: boolean, changeset });
export const archivedUntouched = object<ArchivedUntouched>("ArchivedUntouched", { archived: number, changeset });
export const sendResult = object<SendResult>("SendResult", { id, status: literal("sent", "failed", "unconfirmed"), error: nullable(string), messageId: nullable(string) });

/** `shape` with every optional field required: what a full answer (one not of `map`) is held to. */
export function strict<T>(shape: ObjectShape<T>): Shape<T> {
  const fields = Object.fromEntries(Object.entries(shape.fields).map(([key, field]) => [key, "kind" in field && field.kind === "optional" ? field.shape : field]));
  return object<T>(shape.name, fields as never);
}

/** The shape of each answer ROUTES names (archive.ts), by that name. */
export const ANSWERS: Readonly<Record<string, AnyShape>> = {
  Contract: contractShape,
  RelationshipsReport: relationshipsReport,
  PeopleListing: peopleListing,
  PersonSummary: personSummary,
  ScoreReport: scoreReport,
  QueryResult: queryResult,
  "PersonGroup[]": array(personGroup),
  GroupChat: groupChat,
  "PersonCall[]": array(personCall),
  "CatchUp[]": array(catchUp),
  LoggedCall: loggedCall,
  TimelinePage: timelinePage,
  "TableRow[]": array(tableRow),
  "ListedCall[]": array(listedCall),
  "LocationInfo[]": array(locationInfo),
  "TagInfo[]": array(tagInfo),
  CalendarMonth: calendarMonth,
  CalendarDay: calendarDay,
  DayMessagesPage: dayMessagesPage,
  "MessageApps[]": array(messageApps),
  "MergeProposal[]": array(mergeProposal),
  "ChangesetInfo[]": array(changesetInfo),
  ChangesetInfo: changesetInfo,
  "Draft[]": array(draft),
  "SendTarget[]": array(sendTarget),
  MapFacts: mapFacts,
  PeopleTable: peopleTable,
  PersonActivity: personActivity,
  GeneratedQuery: generatedQuery,
  "Draft | null": nullable(draft),
  SendResult: sendResult,
  PersonAdded: personAdded,
  PersonSaved: personSaved,
  TagsSaved: tagsSaved,
  TagsChanged: tagsChanged,
  CatchUpSaved: catchUpSaved,
  ManualCallSaved: manualCallSaved,
  CallLengthSaved: callLengthSaved,
  CallNoteSaved: callNoteSaved,
  CallAnsweredSaved: callAnsweredSaved,
  GroupUnlinkSaved: groupUnlinkSaved,
  ArchivedUntouched: archivedUntouched,
  null: nothing,
  unknown: anything,
};
