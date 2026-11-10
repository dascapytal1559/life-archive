// A one-time repair of the chats Messenger's phone export doubled
// (npm run archive -- repair messenger-phone-chats).
//
// messenger-export used to key a group, and a chat with a placeholder such as
// "Facebook user" (a deleted account), by its threadName as the export wrote
// it, `<name>_<n>`, where `<n>` is the chat's place in that export; and an
// empty chat with a placeholder by the export's newest message. Both move from
// one export to the next, so a later export brought the same chat in again as
// a new chat, with new ids for all its messages (the writer never matches
// messages from one connector) and a new deleted-account person. The connector
// now keys them by the chat's name (chatKey in connectors/messenger-export/
// read.ts). Photos sent together (records alike but for their media) were told
// apart by their file names, which each export names anew, so a later export
// brought them in again too, in any chat (one-to-one chats as well), and the
// copies of a group could not be matched there; the connector now tells them
// apart by their place among them (burstOrder). This brings what earlier
// imports wrote under those keys and ids:
//
//   planPhoneChats    reads the archive, writes nothing. A chat is the phone export's only when its id is the
//                     one the old rule (or the new) gives its members and title, so nothing is changed on a
//                     guess. Chats that come to one key are one chat: the first (the lowest number) is kept and
//                     the others are its copies. A chat under its key already (a one-to-one chat with a named
//                     person always is) has only its photos sent together checked.
//   applyPhoneChats   works the plan out again and makes it, in one transaction: each kept chat and its messages
//                     take their new ids (worked out from each message's original record, which must give its
//                     old id: an unsent message's has lost its text, so that is looked for in the phone exports
//                     under platform-exports/messenger/, see unsentTexts; photos sent together take their places
//                     among them as the import that brought them had them, see newIdsOf), and each copy is
//                     merged into it, as is a message the chat holds twice: a
//                     message both have is kept once, with the attachments of the newest export (README's rule)
//                     and everything said about either copy (its reactions, edits, call lengths and notes); a
//                     message only the copy has moves; the copy's
//                     deleted-account person joins the kept chat's; who was taken out of the copy or unlinked
//                     from it stays so in the kept chat. The kept chat stays dropped or not as it was: a copy's
//                     drop (the stopgap for this) is not carried. The copies, and the accounts merged away, are
//                     deleted; the rules then run, so counts are worked out again and a person left with no
//                     account goes, unless the captain edited them.
//
// Run again, it finds nothing to do. Chats it cannot recognise, or whose
// messages' records no longer give their ids, are left as they are and named.
// The CLI takes a checked backup first, and refuses without one. Until it has
// run, a messenger-export import is refused (chatsUnderOldKeys and
// chatsWithFileNameIds, checked by the connector host), since it would bring
// each chat still under its old key, and each photo with an id made from its
// file name, in once more.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Db, EXPORTS_FOLDER, homeRank, isPlaceholderName, transaction } from "../../../sdk/server.ts";
import {
  burstOrder,
  chatKey,
  chatName,
  type ExportMessage,
  exportMessages,
  idBase,
  isKeyedByName,
  mediaNames,
  messageId,
  numberedKey,
  sha256,
} from "../connectors/messenger-export/read.ts";

const CONNECTOR = "messenger-export";
const SEPARATOR = "\u001f";
const FIELD = "\u001e";
/** How far the export's numbers for a file are searched when recognising a deleted account's chat (see oldKeys). */
const MAX_FILE_NUMBER = 5000;
/** How far order numbers (two chats with one key in an export) are searched. */
const MAX_ORDER_NUMBER = 20;
/** How far a photo's place among those sent with it (burstOrder) is searched. */
const MAX_BURST_PLACE = 500;
/**
 * Whether message `m` may be one of several photos sent together (see burstOrder): it has attachments, and another
 * message in its chat has its sender, time and kind. Only such a message's id can hold its place, or its file names.
 */
const IN_BURST = `(EXISTS (SELECT 1 FROM attachment WHERE message_id = m.id) AND EXISTS (SELECT 1 FROM message o
  WHERE o.conversation_id = m.conversation_id AND o.sent_at = m.sent_at AND o.sender_account_id IS m.sender_account_id
    AND o.type = m.type AND o.id <> m.id))`;

/**
 * The texts the phone exports give unsent messages, by sender and time (see unsentTexts). The writer keeps no text for
 * an unsent message, in its record too, but the export gave its placeholder one, and its id was made with it.
 */
export type UnsentTexts = Map<string, string[]>;

export interface PhoneChat {
  conversation: number;
  type: "direct" | "group";
  title: string | null;
  /** Its title once repaired: a group's without the export's number. */
  newTitle: string | null;
  messages: number;
  dropped: boolean;
}

export interface PhoneChatCopy extends PhoneChat {
  /** Of its messages, those the kept chat has too (merged into them), and those it does not (moved to it). */
  same: number;
  moved: number;
}

export interface MergedAccount {
  account: number;
  label: string;
  /** The person it is linked to, and whether the rules will delete them (no other account, never edited). */
  person: number | null;
  personGoes: boolean;
  /** The kept chat's account it joins. */
  into: number;
  /** It was linked by the captain, so the kept account takes that link. */
  carriesLink: boolean;
}

export interface PhoneChatRepair {
  /** The chat's new id (the platform's, a hash of its new key). */
  key: string;
  kept: PhoneChat;
  /** It takes its new key (else it is under it already, and only some of its messages take new ids). */
  rekeysChat: boolean;
  /** Its messages that take new ids. */
  rekeyed: number;
  /** Of its messages, those it holds twice (photos sent together that a later export brought in again): merged into the first. */
  doubled: number;
  copies: PhoneChatCopy[];
  /** The copies' deleted-account accounts, each merged into the kept chat's of that label. */
  accounts: MergedAccount[];
  /** The copies' members taken out of the group and people unlinked from it, carried to the kept chat. */
  removals: number;
  unlinks: number;
  /** Messages both have whose records differ (text, unsent, edit or kind): the kept chat's is kept; the next import of the newest export brings it up to date. */
  differing: number;
}

export interface UnrecognisedChat {
  conversation: number;
  title: string | null;
  why: string;
}

export interface PhoneChatPlan {
  repairs: PhoneChatRepair[];
  unrecognised: UnrecognisedChat[];
  /** Chats already under their new key, with nothing to merge. */
  settled: number;
}

export interface PhoneChatResult {
  plan: PhoneChatPlan;
  chatsDeleted: number;
  messagesDeleted: number;
  messagesMoved: number;
  messagesRekeyed: number;
  /** The kept chats' own messages merged into a twin in the same chat (see PhoneChatRepair.doubled). */
  doublesMerged: number;
  accountsDeleted: number;
  /** People the rules deleted after it, left with no account. */
  peopleDeleted: number;
}

interface ChatRow {
  id: number;
  key: string;
  type: "direct" | "group";
  title: string | null;
  dropped_at: number | null;
}

interface Member {
  account: number;
  key: string;
  /** The name it stands for in the chat's key: its key, or a placeholder's label. */
  name: string;
  /** The label, when it is this chat's own placeholder account (`<label> #<the chat's id, first 8>`). */
  placeholder: string | null;
}

/** A chat recognised by its id: the key that gives it, and what the new key is made of. */
interface Recognised {
  chat: ChatRow;
  members: Member[];
  /** The key its id and its messages' ids were made with. */
  currentKey: string;
  name: string;
  /** Its first message's time, as its new key has it; null when the export had no messages for it. */
  firstAt: number | null;
  /** The phone imports it came from, as far as the archive tells. */
  sources: Set<number>;
  base: string;
}

interface MessageRow {
  id: number;
  conversation_id: number;
  platform_message_id: string;
  sender_account_id: number | null;
  first_source_id: number;
  last_source_id: number;
  type: string;
  text: string | null;
  unsent: number;
  edited_at: number | null;
  raw_json: string;
  /** It may be one of several photos sent together (IN_BURST). */
  in_burst: number;
}

/** Everything a repair changes, worked out from the archive as it is. */
interface Work {
  repair: PhoneChatRepair;
  /** The kept chat first, then its copies. */
  chats: Recognised[];
  /** Each message's new id, by its row. */
  newIds: Map<number, string>;
  messages: MessageRow[];
  /** The copies' placeholder accounts that join an account of the same label, by account, to the one they join. */
  accountInto: Map<number, number>;
  /** The placeholder accounts that stay (the kept chat's, and a copy's of a label it lacks), with their new keys. */
  renamed: Map<number, string>;
}

/** What the repair would do: reads the archive, writes nothing. `texts` are the exports' for unsent messages (unsentTexts). */
export function planPhoneChats(db: Db, texts: UnsentTexts = new Map()): PhoneChatPlan {
  return work(db, texts).plan;
}

/**
 * The texts of the unsent records in every phone export kept under platform-exports/messenger/<export date>/ (a
 * folder with chat files at its top, or only zips: Facebook's own downloads there are neither), by sender and time.
 * A text is only ever used when it gives a message back its stored id, so one from another chat or export does no
 * harm.
 */
export async function unsentTexts(dataDir: string): Promise<UnsentTexts> {
  const texts: UnsentTexts = new Map();
  const root = join(dataDir, EXPORTS_FOLDER, "messenger");
  const folders = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const folder of folders.filter((f) => f.isDirectory()).map((f) => join(root, f.name))) {
    const names = (await readdir(folder)).filter((name) => !name.startsWith("."));
    const phoneExport = names.some((name) => name.endsWith(".json")) || (names.length > 0 && names.every((name) => name.endsWith(".zip")));
    if (!phoneExport) continue;
    for (const m of await exportMessages(folder)) {
      if (!(m.isUnsent === true || m.type === "placeholder") || typeof m.text !== "string" || m.text === "") continue;
      const at = textKey(m);
      const known = texts.get(at) ?? [];
      if (!known.includes(m.text)) texts.set(at, [...known, m.text]);
    }
  }
  return texts;
}

const textKey = (m: Pick<ExportMessage, "senderName" | "timestamp">) => `${m.senderName}${SEPARATOR}${m.timestamp}`;

/**
 * The phone-export chats still under the keys the connector gave them before it keyed chats by name: an import of a
 * phone export would bring each in again as a new chat, so the connector host refuses one while there are any.
 */
export function chatsUnderOldKeys(db: Db): Array<{ conversation: number; title: string | null }> {
  return (recogniseChats(db)?.recognised ?? [])
    .filter((r) => !isKeyedByName(r.currentKey) && r.currentKey !== r.base)
    .map((r) => ({ conversation: r.chat.id, title: r.chat.title }));
}

/**
 * The phone-export chats holding photos sent together whose ids were made from their file names (oldBurstId), as the
 * connector made them until it took their places instead: an import of a phone export would bring each in again, so
 * the connector host refuses one while there are any. It needs the messages' records, so a dry run's copy, which has
 * none, finds none.
 */
export function chatsWithFileNameIds(db: Db): Array<{ conversation: number; title: string | null }> {
  const recognised = recogniseChats(db)?.recognised ?? [];
  if (recognised.length === 0) return [];
  const byId = new Map(recognised.map((r) => [r.chat.id, r]));
  const found = new Set<number>();
  for (const m of db.prepare(
    `SELECT m.conversation_id, m.platform_message_id, m.raw_json FROM message m WHERE m.conversation_id IN (${[...byId.keys()].join(", ")}) AND ${IN_BURST}`,
  ).all() as Array<{ conversation_id: number; platform_message_id: string; raw_json: string }>) {
    const record = parseRecord(m.raw_json);
    if (record && oldBurstId(byId.get(m.conversation_id)!.currentKey, record) === m.platform_message_id) found.add(m.conversation_id);
  }
  return [...found].sort((a, b) => a - b).map((id) => ({ conversation: id, title: byId.get(id)!.chat.title }));
}

/** A photo's id as the connector made it until 2026-10-15, from its file names (its own copy here, so it never changes). */
function oldBurstId(conversationKey: string, record: ExportMessage): string {
  return sha256([idBase(conversationKey, record), ...mediaNames(record)].join(SEPARATOR));
}

/**
 * Works the plan out again and makes it, in one transaction, then runs the rules (see the top of this file). The
 * archive's foreign keys are on, so a row left pointing at a chat, message or account it deletes fails it whole.
 */
export function applyPhoneChats(db: Db, runRules: () => void, texts: UnsentTexts = new Map()): PhoneChatResult {
  return transaction(db, () => {
    const { plan, works } = work(db, texts);
    const result: PhoneChatResult = {
      plan, chatsDeleted: 0, messagesDeleted: 0, messagesMoved: 0, messagesRekeyed: 0, doublesMerged: 0, accountsDeleted: 0, peopleDeleted: 0,
    };
    if (works.length === 0) return result;
    for (const w of works) apply(db, w, result);
    const people = () => (db.prepare("SELECT count(*) AS n FROM person").get() as { n: number }).n;
    const before = people();
    runRules();
    result.peopleDeleted = before - people();
    return result;
  });
}

function work(db: Db, texts: UnsentTexts): { plan: PhoneChatPlan; works: Work[] } {
  const plan: PhoneChatPlan = { repairs: [], unrecognised: [], settled: 0 };
  const chats = recogniseChats(db);
  if (!chats) return { plan, works: [] };
  const { recognised } = chats;
  plan.unrecognised.push(...chats.unrecognised);

  // Chats that come to one key are one chat.
  const byBase = new Map<string, Recognised[]>();
  for (const r of recognised) byBase.set(r.base, [...(byBase.get(r.base) ?? []), r]);
  const works: Work[] = [];
  for (const [base, group] of byBase) {
    const perSource = new Map<number, number>();
    for (const r of group) for (const s of r.sources) perSource.set(s, (perSource.get(s) ?? 0) + 1);
    const crowded = [...perSource.values()].some((n) => n > 1);
    let sets: Array<{ key: string; chats: Recognised[] }>;
    if (!crowded) {
      sets = [{ key: base, chats: group }];
    } else if (group.every((r) => r.firstAt === null && r.members.some((m) => m.placeholder !== null))) {
      // Empty chats with a deleted account, alike but for their order in an export: as many as one export had are
      // kept, numbered in order, and the rest join them.
      const keep = Math.max(...perSource.values(), ...group.map((r) => orderOf(r.currentKey)));
      const kept = group.slice(0, keep);
      sets = kept.map((r, i) => ({ key: numberedKey(base, i + 1), chats: [r] }));
      group.slice(keep).forEach((r, i) => sets[i % keep].chats.push(r));
    } else {
      for (const r of group) {
        plan.unrecognised.push({ conversation: r.chat.id, title: r.chat.title, why: "one export has two chats of the same people and name, which cannot be told apart" });
      }
      continue;
    }
    for (const set of sets) {
      const w = workFor(db, set.key, set.chats, texts);
      if (typeof w === "string") {
        for (const r of set.chats) plan.unrecognised.push({ conversation: r.chat.id, title: r.chat.title, why: w });
        continue;
      }
      if (w === null) {
        plan.settled++;
        continue;
      }
      works.push(w);
    }
  }
  plan.unrecognised.sort((a, b) => a.conversation - b.conversation);
  works.sort((a, b) => a.repair.kept.conversation - b.repair.kept.conversation);
  plan.repairs = works.map((w) => w.repair);
  return { plan, works };
}

/** The archive's Messenger chats with an id like the phone export's: those recognised (see recognise), and the rest; null with no phone import. */
function recogniseChats(db: Db): { recognised: Recognised[]; unrecognised: UnrecognisedChat[] } | null {
  const unrecognised: UnrecognisedChat[] = [];
  const phoneSources = new Map(
    (db.prepare("SELECT id, started_at FROM source WHERE connector = ?").all(CONNECTOR) as Array<{ id: number; started_at: number }>)
      .map((s) => [s.id, s.started_at]),
  );
  if (phoneSources.size === 0) return null;
  const inPhone = [...phoneSources.keys()].join(", ");
  // The export's newest message, by import: an empty chat with a placeholder was keyed by it.
  const exportedUpTo = new Map(
    (db.prepare(`SELECT source_id, max(to_ms) AS to_ms FROM coverage_span WHERE conversation_id IS NULL AND source_id IN (${inPhone}) GROUP BY source_id`)
      .all() as Array<{ source_id: number; to_ms: number }>).map((r) => [r.source_id, r.to_ms]),
  );
  const coverage = new Map<number, Array<{ source: number; from: number }>>();
  for (const row of db.prepare(`SELECT conversation_id, source_id, from_ms FROM coverage_span WHERE conversation_id IS NOT NULL AND source_id IN (${inPhone})`)
    .all() as Array<{ conversation_id: number; source_id: number; from_ms: number }>) {
    coverage.set(row.conversation_id, [...(coverage.get(row.conversation_id) ?? []), { source: row.source_id, from: row.from_ms }]);
  }
  const members = new Map<number, Array<{ account: number; key: string; first_seen_at: number | null; last_seen_at: number | null }>>();
  for (const row of db.prepare(
    `SELECT cm.conversation_id, a.id AS account, a.key, a.first_seen_at, a.last_seen_at FROM conversation_member cm
     JOIN import_person a ON a.id = cm.account_id JOIN conversation c ON c.id = cm.conversation_id WHERE c.platform = 'messenger'`,
  ).all() as Array<{ conversation_id: number; account: number; key: string; first_seen_at: number | null; last_seen_at: number | null }>) {
    members.set(row.conversation_id, [...(members.get(row.conversation_id) ?? []), row]);
  }
  const firstMessage = new Map(
    (db.prepare("SELECT conversation_id, min(sent_at) AS at FROM message WHERE platform = 'messenger' GROUP BY conversation_id").all() as
      Array<{ conversation_id: number; at: number }>).map((r) => [r.conversation_id, r.at]),
  );

  const recognised: Recognised[] = [];
  const chats = (db.prepare("SELECT id, platform_conversation_id AS key, type, title, dropped_at FROM conversation WHERE platform = 'messenger' ORDER BY id").all() as
    unknown as ChatRow[]).filter((c) => /^[0-9a-f]{64}$/.test(c.key));
  for (const chat of chats) {
    const chatMembers = (members.get(chat.id) ?? []).map((m): Member & { first_seen_at: number | null; last_seen_at: number | null } => {
      const own = /^(.*) #([0-9a-f]{8})$/.exec(m.key);
      const label = own && isPlaceholderName(own[1]) ? own[1] : null;
      return { ...m, name: label ?? m.key, placeholder: label !== null && own![2] === chat.key.slice(0, 8) ? label : null };
    });
    const names = [...new Set(chatMembers.map((m) => m.name))].sort();
    const hasPlaceholder = names.some(isPlaceholderName);
    const spans = coverage.get(chat.id) ?? [];
    // A one-to-one chat with a named person is keyed by the names alone, before and since: only its photos sent
    // together may need new ids. Another's (not the phone export's) is left alone, unnamed, as before.
    if (names.length <= 2 && !hasPlaceholder) {
      const key = chatKey(names, chat.title ?? "", null);
      if (sha256(key) === chat.key) {
        recognised.push({ chat, members: chatMembers, currentKey: key, name: chat.title ?? "", firstAt: null, sources: new Set(spans.map((s) => s.source)), base: key });
      }
      continue;
    }
    const firstTimes = [...new Set([...spans.map((s) => s.from), ...(firstMessage.has(chat.id) ? [firstMessage.get(chat.id)!] : [])])];
    const hadMessages = firstTimes.length > 0;
    const found = recognise(chat, names, hasPlaceholder, firstTimes, hadMessages ? [] : [...new Set(exportedUpTo.values())]);
    if (!found) {
      // Not the phone export's (another connector's chat with an id like it), or made some other way: left alone.
      if (chatMembers.length > 0) unrecognised.push({ conversation: chat.id, title: chat.title, why: "its id is not the one the phone export gives its members and title" });
      continue;
    }
    const sources = new Set(spans.map((s) => s.source));
    if (found.emptyIn !== null) for (const [source, at] of exportedUpTo) if (at === found.emptyIn) sources.add(source);
    // An empty chat under the new key says where it came from only by when its placeholder account was seen.
    if (!hadMessages && found.emptyIn === null) {
      for (const m of chatMembers.filter((m) => m.placeholder !== null)) {
        for (const [source, at] of phoneSources) if (at === m.first_seen_at || at === m.last_seen_at) sources.add(source);
      }
    }
    const firstAt = hadMessages ? Math.min(...firstTimes) : null;
    recognised.push({
      chat, members: chatMembers, currentKey: found.key, name: found.name, firstAt, sources,
      base: chatKey(names, found.name, hasPlaceholder ? firstAt : null),
    });
  }

  return { recognised, unrecognised };
}

/**
 * The key a chat's id was made from, under the old rule or the new, or null. The old rule put the threadName as the
 * export wrote it (a group's is its title; a deleted account's chat is titled with the label alone, so its number is
 * searched for) and, for a chat with a placeholder, its first message's time, or the export's newest when it had none.
 */
function recognise(
  chat: ChatRow, names: string[], hasPlaceholder: boolean, firstTimes: number[], exportedUpTo: number[],
): { key: string; name: string; emptyIn: number | null } | null {
  const title = chat.title ?? "";
  const orders = hasPlaceholder || names.length > 2 ? MAX_ORDER_NUMBER : 1;
  // The new rule: already repaired, or imported since the fix.
  for (const firstAt of hasPlaceholder ? [...firstTimes, null] : [null]) {
    const base = chatKey(names, title, firstAt);
    for (let n = 1; n <= orders; n++) if (sha256(numberedKey(base, n)) === chat.key) return { key: numberedKey(base, n), name: title, emptyIn: null };
  }
  // The old rule (its own copy here, so it never changes).
  const threadNames = [title];
  if (hasPlaceholder && names.length <= 2) for (let n = 0; n <= MAX_FILE_NUMBER; n++) threadNames.push(`${title}_${n}`);
  const times: Array<{ at: number | null; empty: boolean }> = hasPlaceholder
    ? [...firstTimes.map((at) => ({ at, empty: false })), ...exportedUpTo.map((at) => ({ at, empty: true }))]
    : [{ at: null, empty: false }];
  for (const threadName of threadNames) {
    for (const { at, empty } of times) {
      const base = [names.join(SEPARATOR), threadName, ...(hasPlaceholder ? [String(at)] : [])].join(FIELD);
      for (let n = 1; n <= (hasPlaceholder ? MAX_ORDER_NUMBER : 1); n++) {
        const key = n === 1 ? base : `${base}${FIELD}${n}`;
        if (sha256(key) === chat.key) return { key, name: chatName(threadName, threadName), emptyIn: empty ? at : null };
      }
    }
  }
  return null;
}

/**
 * A key's order number in its export, 1 when it has none. A by-name key's fields are its marker, the names, the
 * name, the first message's time for a chat with a placeholder, and then the order number, if any.
 */
function orderOf(key: string): number {
  if (!isKeyedByName(key)) return 1;
  const fields = key.split(FIELD);
  const length = fields[1].split(SEPARATOR).some(isPlaceholderName) ? 4 : 3;
  return fields.length > length ? Number(fields[length]) : 1;
}

/** What repairing these chats as one, under `key`, takes; null when there is nothing to do, or why it cannot be done. */
function workFor(db: Db, key: string, chats: Recognised[], texts: UnsentTexts): Work | null | string {
  const sorted = [...chats].sort((a, b) => a.chat.id - b.chat.id);
  const [kept, ...copies] = sorted;
  const newId = sha256(key);
  const keptTitle = kept.chat.type === "group" ? kept.name : kept.chat.title;
  // Under its new key with nothing to merge, only its photos sent together can still need new ids (made from their file
  // names): the repair re-keys a chat's messages with it, and the connector gives a chat under its new key its messages'
  // new ids. So only theirs are checked (and no export's texts are needed for the rest).
  const keyed = copies.length === 0 && kept.chat.key === newId;
  const messages = db.prepare(
    `SELECT id, conversation_id, platform_message_id, sender_account_id, first_source_id, last_source_id, type, text, unsent, edited_at, raw_json,
       ${IN_BURST} AS in_burst
     FROM message m WHERE conversation_id IN (${sorted.map((c) => c.chat.id).join(", ")})${keyed ? ` AND ${IN_BURST}` : ""} ORDER BY id`,
  ).all() as unknown as MessageRow[];
  const chatOf = new Map(sorted.map((r) => [r.chat.id, r]));
  const newIds = newIdsOf(messages, chatOf, key, texts);
  if (typeof newIds === "string") return newIds;
  if (keyed && kept.chat.title === keptTitle && messages.every((m) => newIds.get(m.id) === m.platform_message_id)) return null;

  // A chat's own placeholder accounts (its members', and any sender's) are keyed `<label> #<its id, first 8>`. The
  // kept chat's take keys from its new id; each copy's joins the kept one of its label.
  const renamed = new Map<number, string>();
  const accountInto = new Map<number, number>();
  const labels = new Map<number, string>();
  const byLabel = new Map<string, number>();
  for (const r of sorted) {
    const suffix = ` #${r.chat.key.slice(0, 8)}`;
    const own = (db.prepare("SELECT id, key FROM import_person WHERE platform = 'messenger' AND substr(key, -10) = ? ORDER BY id").all(suffix) as
      Array<{ id: number; key: string }>).filter((a) => isPlaceholderName(a.key.slice(0, -suffix.length)));
    for (const account of own) {
      const label = account.key.slice(0, -suffix.length);
      labels.set(account.id, label);
      const into = byLabel.get(label);
      if (into === undefined) {
        byLabel.set(label, account.id);
        renamed.set(account.id, `${label} #${newId.slice(0, 8)}`);
      } else {
        accountInto.set(account.id, into);
      }
    }
  }

  const count = (sql: string, ...args: number[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const placeholderPerson = (account: number) =>
    db.prepare(
      `SELECT a.person_id, a.link_source, p.edited_at, p.is_self,
         (SELECT count(*) FROM import_person o WHERE o.person_id = a.person_id) AS accounts
       FROM import_person a LEFT JOIN person p ON p.id = a.person_id WHERE a.id = ?`,
    ).get(account) as { person_id: number | null; link_source: string; edited_at: number | null; is_self: number | null; accounts: number };
  const describe = (r: Recognised): PhoneChat => ({
    conversation: r.chat.id, type: r.chat.type, title: r.chat.title, newTitle: r.chat.type === "group" ? r.name : r.chat.title,
    messages: count("SELECT count(*) AS n FROM message WHERE conversation_id = ?", r.chat.id), dropped: r.chat.dropped_at !== null,
  });
  // Each new id's first message, the kept chat's first; any other with that id is the same message, held twice.
  const first = new Map<string, MessageRow>();
  let differing = 0;
  const twins = (own: MessageRow[]) => {
    let same = 0;
    for (const m of own) {
      const id = newIds.get(m.id)!;
      const earlier = first.get(id);
      if (earlier === undefined) {
        first.set(id, m);
        continue;
      }
      same++;
      if (earlier.text !== m.text || earlier.unsent !== m.unsent || earlier.edited_at !== m.edited_at || earlier.type !== m.type) differing++;
    }
    return same;
  };
  const keptOwn = messages.filter((m) => m.conversation_id === kept.chat.id);
  const doubled = twins(keptOwn);
  const repair: PhoneChatRepair = {
    key: newId,
    kept: { ...describe(kept), newTitle: keptTitle },
    rekeysChat: kept.chat.key !== newId,
    rekeyed: keptOwn.filter((m) => newIds.get(m.id) !== m.platform_message_id).length,
    doubled,
    copies: copies.map((copy) => {
      const own = messages.filter((m) => m.conversation_id === copy.chat.id);
      const same = twins(own);
      return { ...describe(copy), same, moved: own.length - same };
    }),
    accounts: [...accountInto].map(([account, into]) => {
      const p = placeholderPerson(account);
      return {
        account, label: labels.get(account)!, person: p.person_id, into,
        personGoes: p.person_id !== null && p.accounts === 1 && p.edited_at === null && !p.is_self,
        carriesLink: p.link_source === "captain" && placeholderPerson(into).link_source !== "captain",
      };
    }),
    removals: copies.reduce((n, c) => n + count("SELECT count(*) AS n FROM conversation_member WHERE conversation_id = ? AND removed_at IS NOT NULL", c.chat.id), 0),
    unlinks: copies.reduce((n, c) => n + count("SELECT count(*) AS n FROM group_unlink WHERE conversation_id = ?", c.chat.id), 0),
    differing,
  };
  return { repair, chats: sorted, newIds, messages, accountInto, renamed };
}

/**
 * Each message's new id under `key`, by its row, worked out from its original record, which must give its id under
 * its chat's current key: as it is, or, for an unsent message whose record lost its text, with a text the exports
 * give it. A photo sent with others (see burstOrder) takes its place among them under the new key; one whose id was
 * made from its file names (oldBurstId) takes the place it had among those the same import brought into its chat with
 * all else alike, in the order they came in, as that export had them. Why it cannot be done, if any cannot.
 */
function newIdsOf(messages: MessageRow[], chatOf: Map<number, Recognised>, key: string, texts: UnsentTexts): Map<number, string> | string {
  const verified = new Map<number, { record: ExportMessage; place: number | null | "file names" }>();
  let unverified = 0;
  let unsentUnverified = 0;
  for (const message of messages) {
    const record = parseRecord(message.raw_json);
    const current = chatOf.get(message.conversation_id)!.currentKey;
    // The record as stored, or, for an unsent message whose record lost its text, with each text the exports give it.
    const candidates = record === null ? []
      : [record, ...(message.unsent && record.text === undefined ? (texts.get(textKey(record)) ?? []).map((text) => ({ ...record, text })) : [])];
    const found = candidates.map((candidate) => ({ record: candidate, place: placeOf(current, candidate, message) })).find((c) => c.place !== undefined);
    if (found) {
      verified.set(message.id, found as { record: ExportMessage; place: number | null | "file names" });
      continue;
    }
    unverified++;
    if (message.unsent && record?.text === undefined) unsentUnverified++;
  }
  if (unsentUnverified > 0 && unsentUnverified === unverified) {
    return `${unverified} of its unsent messages' records no longer give their ids, and no phone export in ${EXPORTS_FOLDER}/messenger/ gives the text that does, so their new ids cannot be worked out`;
  }
  if (unverified > 0) return `${unverified} of its messages' records no longer give their ids, so their new ids cannot be worked out`;

  // Photos with ids made from their file names, by the import that brought them, its chat and all else alike.
  const bursts = new Map<string, MessageRow[]>();
  for (const message of messages) {
    const { record, place } = verified.get(message.id)!;
    if (place !== "file names") continue;
    const at = [message.conversation_id, message.first_source_id, idBase(chatOf.get(message.conversation_id)!.currentKey, record)].join(FIELD);
    bursts.set(at, [...(bursts.get(at) ?? []), message]);
  }
  const places = new Map<number, number>();
  let alone = 0;
  for (const burst of bursts.values()) {
    const order = burstOrder(burst.map((m) => verified.get(m.id)!.record));
    burst.forEach((m, i) => (order[i] === null ? alone++ : places.set(m.id, order[i]!)));
  }
  // Its id says others were sent with it, but none the same import brought is left beside it: its place is not known.
  if (alone > 0) return `${alone} of its photos sent with others are no longer beside them, so their new ids cannot be worked out`;

  const newIds = new Map<number, string>();
  for (const message of messages) {
    const { record, place } = verified.get(message.id)!;
    newIds.set(message.id, messageId(key, record, place === "file names" ? places.get(message.id)! : place));
  }
  return newIds;
}

/**
 * How `record` gives `message` its id under `key`: with no place (null), its place among photos sent together (a
 * number), or its file names (as the connector made such ids until 2026-10-15); undefined when it does not.
 */
function placeOf(key: string, record: ExportMessage, message: MessageRow): number | null | "file names" | undefined {
  if (messageId(key, record, null) === message.platform_message_id) return null;
  if (!message.in_burst) return undefined;
  if (oldBurstId(key, record) === message.platform_message_id) return "file names";
  for (let place = 1; place <= MAX_BURST_PLACE; place++) if (messageId(key, record, place) === message.platform_message_id) return place;
  return undefined;
}

function parseRecord(raw: string): ExportMessage | null {
  try {
    const record = JSON.parse(raw) as unknown;
    if (typeof record !== "object" || record === null || Array.isArray(record)) return null;
    const m = record as ExportMessage;
    return typeof m.senderName === "string" && Number.isSafeInteger(m.timestamp) && typeof m.type === "string" ? m : null;
  } catch {
    return null;
  }
}

function apply(db: Db, w: Work, result: PhoneChatResult): void {
  const kept = w.chats[0].chat;
  const copies = w.chats.slice(1).map((r) => r.chat);
  const accountOf = (id: number | null) => (id === null ? null : (w.accountInto.get(id) ?? id));

  // Messages: each new id once, in the kept chat, the first copy of it kept (the kept chat's own, else the oldest row).
  const byNewId = new Map<string, MessageRow[]>();
  for (const m of w.messages) byNewId.set(w.newIds.get(m.id)!, [...(byNewId.get(w.newIds.get(m.id)!) ?? []), m]);
  const attachments = db.prepare(
    "SELECT id, ordinal, platform_attachment_id, type, filename, mime, size, sha256, local_path, source_id FROM attachment WHERE message_id = ?",
  );
  for (const [id, rows] of byNewId) {
    const survivor = rows.find((m) => m.conversation_id === kept.id) ?? rows[0];
    for (const other of rows.filter((m) => m !== survivor)) {
      mergeMessage(db, survivor, other, attachments);
      if (other.conversation_id === kept.id) result.doublesMerged++;
      else result.messagesDeleted++;
    }
    if (survivor.conversation_id !== kept.id) result.messagesMoved++;
    else if (survivor.platform_message_id !== id) result.messagesRekeyed++;
    db.prepare("UPDATE message SET platform_message_id = ?, conversation_id = ?, sender_account_id = ? WHERE id = ?")
      .run(id, kept.id, accountOf(survivor.sender_account_id), survivor.id);
  }

  // The copies' deleted-account accounts join the kept chat's.
  for (const [account, into] of w.accountInto) {
    const from = db.prepare("SELECT key, person_id, link_source, linked_at FROM import_person WHERE id = ?").get(account) as
      { key: string; person_id: number | null; link_source: string; linked_at: number | null };
    const target = db.prepare("SELECT link_source FROM import_person WHERE id = ?").get(into) as { link_source: string };
    if (from.link_source === "captain" && target.link_source !== "captain") {
      db.prepare("UPDATE import_person SET person_id = ?, link_source = 'captain', linked_at = ? WHERE id = ?").run(from.person_id, from.linked_at, into);
    }
    db.prepare("UPDATE message SET sender_account_id = ? WHERE sender_account_id = ?").run(into, account);
    db.prepare("UPDATE OR IGNORE reaction SET actor_account_id = ? WHERE actor_account_id = ?").run(into, account);
    db.prepare("DELETE FROM reaction WHERE actor_account_id = ?").run(account);
    db.prepare("UPDATE OR IGNORE call SET import_person_id = ? WHERE import_person_id = ?").run(into, account);
    db.prepare("DELETE FROM call WHERE import_person_id = ?").run(account);
    db.prepare("UPDATE manual_call SET account_id = ? WHERE account_id = ?").run(into, account);
    for (const copy of copies) moveMember(db, copy.id, account, kept.id, into);
    db.prepare("DELETE FROM conversation_member WHERE account_id = ?").run(account);
    db.prepare("DELETE FROM import_person_stats WHERE import_person_id = ?").run(account);
    const intoKey = w.renamed.get(into) ?? (db.prepare("SELECT key FROM import_person WHERE id = ?").get(into) as { key: string }).key;
    rekeyProposals(db, `account:messenger:${from.key}`, `account:messenger:${intoKey}`);
    db.prepare("DELETE FROM import_person WHERE id = ?").run(account);
    result.accountsDeleted++;
  }
  for (const [account, key] of w.renamed) {
    const { key: old } = db.prepare("SELECT key FROM import_person WHERE id = ?").get(account) as { key: string };
    if (old === key) continue;
    db.prepare("UPDATE import_person SET key = ? WHERE id = ?").run(key, account);
    rekeyProposals(db, `account:messenger:${old}`, `account:messenger:${key}`);
  }

  // The copies: their members, who was taken out and unlinked, and their coverage, are the kept chat's; then they go.
  for (const copy of copies) {
    for (const { account_id } of db.prepare("SELECT account_id FROM conversation_member WHERE conversation_id = ?").all(copy.id) as Array<{ account_id: number }>) {
      moveMember(db, copy.id, account_id, kept.id, accountOf(account_id)!);
    }
    db.prepare("DELETE FROM conversation_member WHERE conversation_id = ?").run(copy.id);
    db.prepare(
      `INSERT INTO group_unlink (person_id, conversation_id, unlinked_at) SELECT person_id, ?, unlinked_at FROM group_unlink WHERE conversation_id = ?
       ON CONFLICT (person_id, conversation_id) DO UPDATE SET unlinked_at = min(unlinked_at, excluded.unlinked_at)`,
    ).run(kept.id, copy.id);
    db.prepare("DELETE FROM group_unlink WHERE conversation_id = ?").run(copy.id);
    db.prepare("UPDATE coverage_span SET conversation_id = ? WHERE conversation_id = ?").run(kept.id, copy.id);
    db.prepare("UPDATE outgoing_message SET conversation_id = ? WHERE conversation_id = ?").run(kept.id, copy.id);
    db.prepare("DELETE FROM conversation WHERE id = ?").run(copy.id);
    result.chatsDeleted++;
  }
  db.prepare("UPDATE conversation SET platform_conversation_id = ?, title = ? WHERE id = ?").run(w.repair.key, w.repair.kept.newTitle, kept.id);
}

/** A copy's member row, carried to the kept chat: there already, it keeps a removal either had. */
function moveMember(db: Db, fromChat: number, account: number, toChat: number, toAccount: number): void {
  const row = db.prepare("SELECT removed_at FROM conversation_member WHERE conversation_id = ? AND account_id = ?").get(fromChat, account) as
    { removed_at: number | null } | undefined;
  if (!row) return;
  db.prepare(
    `INSERT INTO conversation_member (conversation_id, account_id, removed_at) VALUES (?, ?, ?)
     ON CONFLICT (conversation_id, account_id) DO UPDATE SET removed_at = coalesce(removed_at, excluded.removed_at)`,
  ).run(toChat, toAccount, row.removed_at);
}

/** `other` is the same message as `survivor`: everything said about it is the survivor's, and it goes. */
function mergeMessage(db: Db, survivor: MessageRow, other: MessageRow, attachments: ReturnType<Db["prepare"]>): void {
  type Attachment = { id: number; ordinal: number; local_path: string | null } & Record<string, unknown>;
  const theirs = new Map((attachments.all(survivor.id) as Attachment[]).map((a) => [a.ordinal, a]));
  for (const attachment of attachments.all(other.id) as Attachment[]) {
    const mine = theirs.get(attachment.ordinal);
    if (!mine) {
      db.prepare("UPDATE attachment SET message_id = ? WHERE id = ?").run(survivor.id, attachment.id);
      continue;
    }
    // The newest export holding the file wins (see homeRank).
    if (attachment.local_path !== null && (mine.local_path === null || homeRank(attachment.local_path) > homeRank(mine.local_path))) {
      db.prepare(
        `UPDATE attachment SET platform_attachment_id = ?, type = ?, filename = ?, mime = ?, size = ?, sha256 = ?, local_path = ?, source_id = ?
         WHERE id = ?`,
      ).run(
        attachment.platform_attachment_id as string | null, attachment.type as string, attachment.filename as string | null,
        attachment.mime as string | null, attachment.size as number | null, attachment.sha256 as string | null, attachment.local_path,
        attachment.source_id as number, mine.id,
      );
    }
    db.prepare("DELETE FROM attachment WHERE id = ?").run(attachment.id);
  }
  db.prepare("UPDATE OR IGNORE reaction SET message_id = ? WHERE message_id = ?").run(survivor.id, other.id);
  db.prepare("DELETE FROM reaction WHERE message_id = ?").run(other.id);
  db.prepare("UPDATE message_version SET message_id = ? WHERE message_id = ?").run(survivor.id, other.id);
  db.prepare("UPDATE message_alias SET message_id = ? WHERE message_id = ?").run(survivor.id, other.id);
  for (const table of ["call_length", "call_note", "call_answered"]) {
    db.prepare(`UPDATE OR IGNORE ${table} SET message_id = ? WHERE message_id = ?`).run(survivor.id, other.id);
    db.prepare(`DELETE FROM ${table} WHERE message_id = ?`).run(other.id);
  }
  db.prepare("UPDATE message SET first_source_id = min(first_source_id, ?), last_source_id = max(last_source_id, ?) WHERE id = ?")
    .run(other.first_source_id, other.last_source_id, survivor.id);
  db.prepare("DELETE FROM message WHERE id = ?").run(other.id);
}

/** Proposals about an account (pending or rejected, by its key) are about the one it became. */
function rekeyProposals(db: Db, from: string, to: string): void {
  const rows = db.prepare("SELECT * FROM merge_proposal WHERE left_key = ? OR right_key = ?").all(from, from) as Array<Record<string, unknown> & { id: number; left_key: string; right_key: string }>;
  for (const row of rows) {
    db.prepare("DELETE FROM merge_proposal WHERE id = ?").run(row.id);
    const other = row.left_key === from ? row.right_key : row.left_key;
    if (other === to) continue;
    const [left, right] = [other, to].sort();
    db.prepare(
      `INSERT OR IGNORE INTO merge_proposal (left_key, right_key, rule, tier, evidence_json, status, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(left, right, row.rule as string, row.tier as string, row.evidence_json as string, row.status as string, row.created_at as number, row.decided_at as number | null);
  }
}
