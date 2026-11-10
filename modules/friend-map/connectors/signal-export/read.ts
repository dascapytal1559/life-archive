// Reads Signal Desktop's "Export chat history" (Settings > Chats): a folder
// signal-export-<date>/ holding
//
//   metadata.json   {"version": 1}
//   main.jsonl      Signal's backup format (Backups.proto) as JSON, one frame a line
//   files/<2 hex>/<media name>.<ext>   attachments, when the export included media
//
// The first line of main.jsonl is the header (version, backupTimeMs); each
// line after is one frame:
//   account     the captain: givenName, familyName, username (never his own id)
//   recipient   {id, contact | group | self | ...}; the id is the export's own
//               number, used only within it
//   chat        {id, recipientId}: one chat with a contact, a group, or himself
//   chatItem    {chatId, authorId, dateSent, revisions, incoming | outgoing |
//                directionless, standardMessage | stickerMessage | updateMessage | ...}
// Desktop leaves disappearing messages out of this export, and writes no
// attachment file unless asked to include media.
//
// Everything is keyed on Signal's own ids, never the export's numbers, so the
// same export imported again, or a newer one that overlaps it, adds nothing twice:
// - an account is its ACI (a UUID), else its PNI ("PNI:<uuid>"), else its
//   phone number; the captain is "me";
// - a one-to-one chat is the other account's key, Note to Self is "me", and a
//   group is "group:" and the start of a SHA-256 of its master key (the key
//   itself, which lets anyone holding it into the group, is never kept);
// - a message is its chat, its author and its first sent time, Signal's own
//   identity for a message (a quote and a reaction name it the same way), so an
//   edit keeps its id.
// A contact is named as Signal names them: the captain's nickname for them,
// else his address book's name, else their profile name, else their username,
// else their phone number (in E.164, which is also their handle, so the
// archive's phone rule can propose them as someone known elsewhere).
// The export gives the captain's own id nowhere, but group snapshots list him
// with everyone else, and every other member has a contact record of their
// own: so the member with no contact record in the most groups is him.
// A group's people are its snapshot's members and invited members; someone who
// left and never wrote is not in it. Group changes, safety-number changes,
// profile changes and the like say nothing the snapshot does not, and are only
// counted. One-to-one chats with no messages, and contacts in no chat, are not
// imported (Signal lists a chat for every contact it knows).
// Attachments are found under files/ by the name Signal gives them (a SHA-256
// of the file's plaintextHash and localKey), kept where they are (the export
// must be under data/platform-exports/), hashed, and recorded as missing when
// the export lacks them.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { type AccountEvent, type AttachmentType, type Connector, type HistoryOptions, jsonLines, keepInPlace, mediaTypeOf, type MessageType } from "../../../../sdk/connector.ts";
import { manifest } from "./manifest.ts";

export const signalExport: Connector = { manifest, history: readSignalExport };

/** The captain's key: the export never gives his own id. */
export const SELF_KEY = "me";

type Json = Record<string, unknown>;

/**
 * A one-to-one call's states that say it was never answered (Backups.proto's IndividualCall.State); ACCEPTED, and
 * a state not known, are answered. Migration 34 in server/archive/db.ts reads those imported before so.
 */
const UNANSWERED_CALL_STATES = new Set(["MISSED", "NOT_ACCEPTED", "MISSED_NOTIFICATION_PROFILE"]);

interface Name {
  displayName: string;
  nameSource: string;
  handle?: string;
}

interface Contact {
  key: string;
  aci?: string;
  name: Name;
}

interface Group {
  id: string;
  title?: string;
  /** Member ACIs, as UUIDs. */
  members: string[];
}

interface Chat {
  recipientId: string;
  items: Json[];
}

/** What main.jsonl holds, by the export's own numbers. */
interface Frames {
  backupTime: number;
  account: Json;
  self: string | null;
  contacts: Map<string, Contact>;
  groups: Map<string, Group>;
  chats: Map<string, Chat>;
  /** Recipients that are neither a person nor a group: Signal's release notes, story lists, call links. */
  others: Set<string>;
}

export async function readSignalExport({ sources, emit }: HistoryOptions): Promise<void> {
  if (sources.length !== 1) throw new Error("a Signal export is a single folder; name just that one");
  const dir = await exportFolder(sources[0]);
  const tallies = new Map<string, number>();
  const tally = (name: string, count = 1) => tallies.set(name, (tallies.get(name) ?? 0) + count);
  const frames = await readFrames(join(dir, "main.jsonl"), tally);
  const files = await mediaFiles(join(dir, "files"));

  const selfAci = findSelfAci(frames);
  const selfName = selfNameOf(frames.account);
  const byAci = new Map([...frames.contacts.values()].filter((c) => c.aci).map((c) => [c.aci!, c]));
  const byKey = new Map([...frames.contacts.values()].map((c) => [c.key, c]));
  /** An account key for a recipient number, or undefined when the export does not have it. */
  const keyOf = (recipientId: unknown): string | undefined =>
    recipientId === frames.self ? SELF_KEY : frames.contacts.get(String(recipientId))?.key;
  const keyOfAci = (aci: string) => (aci === selfAci ? SELF_KEY : (byAci.get(aci)?.key ?? aci));

  const announced = new Set<string>();
  const announce = async (key: string) => {
    if (announced.has(key)) return;
    announced.add(key);
    const account: AccountEvent = { kind: "account", key, keyKind: "id", displayName: key, nameSource: "none" };
    if (key === SELF_KEY) await emit({ ...account, ...selfName, isSelf: true });
    else await emit({ ...account, ...byKey.get(key)?.name });
  };

  const chats = [...frames.chats.entries()].filter(([, chat]) => {
    const id = chat.recipientId;
    if (frames.groups.has(id) || id === frames.self) return true;
    if (frames.contacts.has(id)) {
      if (chat.items.length > 0) return true;
      tally("one-to-one chats with no messages (not imported)");
      return false;
    }
    tally(frames.others.has(id) ? "chats that are not with a person or group, such as Signal's release notes" : "chats whose recipient is not in the export");
    return false;
  });

  let first = Infinity;
  let last = -Infinity;
  const inChats = new Set<string>();
  let done = 0;
  for (const [, chat] of chats) {
    const group = frames.groups.get(chat.recipientId);
    const partner = group ? undefined : (keyOf(chat.recipientId) ?? SELF_KEY);
    const id = group ? group.id : partner!;
    const members = new Set([SELF_KEY]);
    if (group) for (const aci of group.members) members.add(keyOfAci(aci));
    else members.add(partner!);
    for (const item of chat.items) {
      const author = keyOf(item.authorId);
      if (author) members.add(author);
    }
    const sorted = [...members].sort();
    for (const key of sorted) {
      await announce(key);
      inChats.add(key);
    }
    await emit({
      kind: "conversation",
      id,
      type: group ? "group" : "direct",
      ...(group
        ? (group.title ? { title: group.title } : {})
        : { title: partner === SELF_KEY ? selfName.displayName : (byKey.get(partner!)?.name.displayName ?? partner) }),
      members: sorted,
    });

    let from = Infinity;
    let to = frames.backupTime;
    for (const item of chat.items) {
      const author = keyOf(item.authorId);
      if (!author) {
        tally("chat items whose author is not in the export");
        continue;
      }
      const sentAt = await emitItem(item, id, author, partner);
      if (sentAt === null) continue;
      from = Math.min(from, sentAt);
      to = Math.max(to, sentAt);
    }
    if (from !== Infinity) {
      await emit({ kind: "coverage", conversation: id, from, to });
      first = Math.min(first, from);
      last = Math.max(last, to);
    }
    await emit({ kind: "progress", done: ++done, total: chats.length, note: "chats" });
  }

  if (first !== Infinity) await emit({ kind: "coverage", from: first, to: last });
  const unchatted = [...frames.contacts.values()].filter((c) => !inChats.has(c.key)).length;
  tally("contacts in no chat (not imported)", unchatted);
  if (selfAci === null && frames.groups.size > 0) tally("groups read without finding you among their members");
  for (const [name, count] of tallies) if (count > 0) await emit({ kind: "tally", name, count });

  /** Emits one chat item and what hangs off it; returns its sent time, or null when it is not kept as a message. */
  async function emitItem(item: Json, conversation: string, author: string, partner: string | undefined): Promise<number | null> {
    const revisions = Array.isArray(item.revisions) ? (item.revisions as Json[]) : [];
    const sentTimes = [item, ...revisions].map((i) => Number(i.dateSent)).filter((t) => Number.isSafeInteger(t) && t > 0);
    if (sentTimes.length === 0) {
      tally("chat items without a sent time");
      return null;
    }
    // The item is the latest version and is sent when it was last edited; its revisions, oldest first, are the earlier ones.
    const sentAt = Math.min(...sentTimes);
    const editedAt = revisions.length > 0 ? Number(item.dateSent) : undefined;
    const messageId = `${conversation}/${author}/${sentAt}`;
    const base = { kind: "message" as const, idKind: "platform" as const, conversation, raw: item };

    const update = item.updateMessage as Json | undefined;
    if (update) {
      const call = update.individualCall as Json | undefined;
      if (!call) {
        tally(update.groupCall ? "group calls (not kept as messages)"
          : update.groupChange ? "group changes (a group's members and name come from its snapshot; not kept as messages)"
          : "chat updates such as safety number, profile and timer changes (not kept as messages)");
        return null;
      }
      const outgoing = call.direction === "OUTGOING";
      const sender = outgoing ? SELF_KEY : author !== SELF_KEY ? author : (partner ?? author);
      const startedAt = Number(call.startedCallTimestamp);
      const at = Number.isSafeInteger(startedAt) && startedAt > 0 ? startedAt : sentAt;
      await announce(sender);
      await emit({
        ...base,
        id: typeof call.callId === "string" && call.callId ? `${conversation}/call/${call.callId}` : messageId,
        sender,
        isFromSelf: sender === SELF_KEY,
        sentAt: at,
        type: "call",
        // Signal says whether a call was answered, but not how long it was: one never answered is 0, as Messenger's is.
        ...(UNANSWERED_CALL_STATES.has(String(call.state)) ? { callSeconds: 0 } : {}),
      });
      return at;
    }

    const standard = item.standardMessage as Json | undefined;
    const viewOnce = item.viewOnceMessage as Json | undefined;
    const storyReply = item.directStoryReplyMessage as Json | undefined;
    const content = standard ?? (item.stickerMessage as Json | undefined) ?? (item.contactMessage as Json | undefined) ?? viewOnce ?? storyReply ?? (item.poll as Json | undefined);
    const unsent = Boolean(item.remoteDeletedMessage ?? item.adminDeletedMessage);
    const other = Boolean(item.paymentNotification ?? item.giftBadge);
    if (!content && !unsent && !other) {
      tally("chat items of a kind not known");
      return null;
    }

    const attachments = Array.isArray(standard?.attachments) ? (standard.attachments as Json[]) : [];
    const previews = Array.isArray(standard?.linkPreview) ? standard.linkPreview : [];
    const type: MessageType = unsent ? "text"
      : standard ? (attachments.length > 0 ? "media" : previews.length > 0 ? "link" : "text")
      : item.stickerMessage ? "sticker"
      : item.contactMessage ? "contact"
      : viewOnce ? "media"
      : storyReply ? "text"
      : "other";
    const text = unsent ? undefined
      : standard ? bodyOf(standard.text)
      : storyReply ? (bodyOf((storyReply.textReply as Json | undefined)?.text) ?? stringOr(storyReply.emoji))
      : undefined;
    if (viewOnce) tally("view-once media (Signal keeps no copy)");
    if (item.poll) tally("polls (kept as messages without their question)");
    if (editedAt !== undefined) tally("messages edited on Signal (the export gives their latest text)");

    const quote = standard?.quote as Json | undefined;
    const quoted = quote ? keyOf(quote.authorId) : undefined;
    const target = Number(quote?.targetSentTimestamp);
    await emit({
      ...base,
      id: messageId,
      sender: author,
      isFromSelf: author === SELF_KEY,
      sentAt,
      type,
      ...(text ? { text } : {}),
      ...(unsent ? { unsent: true } : {}),
      ...(editedAt !== undefined && Number.isSafeInteger(editedAt) ? { editedAt } : {}),
      ...(quoted && Number.isSafeInteger(target) && target > 0 ? { replyTo: `${conversation}/${quoted}/${target}` } : {}),
    });

    for (const [ordinal, attachment] of attachments.entries()) {
      const pointer = (attachment.pointer ?? {}) as Json;
      const fileName = stringOr(pointer.fileName);
      const mime = stringOr(pointer.contentType);
      const file = files.get(mediaName(pointer.locatorInfo as Json | undefined) ?? "");
      const name = fileName ?? (file ? basename(file) : undefined);
      const inPlace = file ? await keepInPlace(file) : undefined;
      if (!file) tally("attachments not in the export");
      await emit({
        kind: "attachment",
        message: messageId,
        ordinal,
        type: attachmentType(attachment.flag, mime, name),
        ...(name ? { filename: name } : {}),
        ...(mime ? { mime } : {}),
        ...(inPlace ? { inPlace } : {}),
      });
    }

    const reactions = content && Array.isArray(content.reactions) ? (content.reactions as Json[]) : [];
    for (const reaction of reactions) {
      const actor = keyOf(reaction?.authorId);
      const emoji = stringOr(reaction?.emoji);
      if (!actor || !emoji) {
        tally("reactions without an emoji or by someone not in the export");
        continue;
      }
      await announce(actor);
      const addedAt = Number(reaction.sentTimestamp);
      await emit({ kind: "reaction", message: messageId, actor, emoji, ...(Number.isSafeInteger(addedAt) && addedAt > 0 ? { addedAt } : {}) });
    }
    return sentAt;
  }
}

/**
 * The export folder a source names: the folder holding main.jsonl, main.jsonl
 * itself, or a folder holding just one such export folder.
 */
async function exportFolder(source: string): Promise<string> {
  if (!(await stat(source)).isDirectory()) {
    if (basename(source) === "main.jsonl") return dirname(source);
    throw new Error(`${source} is not a Signal export: name its folder, which holds main.jsonl`);
  }
  if (await isFile(join(source, "main.jsonl"))) return source;
  const inside = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory() && (await isFile(join(source, entry.name, "main.jsonl")))) inside.push(join(source, entry.name));
  }
  if (inside.length === 1) return inside[0];
  throw new Error(
    inside.length === 0
      ? `${source} is not a Signal export: it has no main.jsonl`
      : `${source} holds ${inside.length} Signal exports; name the one to import`,
  );
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isFile(), () => false);
}

/**
 * Reads main.jsonl's frames. Throws, naming the line, when it is not Signal's
 * backup format; never quotes what is in it.
 */
export async function readFrames(path: string, tally: (name: string, count?: number) => void = () => {}): Promise<Frames> {
  const frames: Frames = {
    backupTime: 0, account: {}, self: null, contacts: new Map(), groups: new Map(), chats: new Map(), others: new Set(),
  };
  const pendingItems = new Map<string, Json[]>();
  let line = 0;
  for await (const text of jsonLines(createReadStream(path))) {
    line++;
    if (!text.trim()) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      throw new Error(`${path} is not a Signal export: line ${line} is not JSON`);
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) throw new Error(`${path} is not a Signal export: line ${line} is not a JSON object`);
    const f = frame as Json;
    if (line === 1) {
      const time = Number(f.backupTimeMs);
      if (f.version === undefined || !Number.isSafeInteger(time)) {
        throw new Error(`${path} is not a Signal export: its first line is not Signal's backup header (version and backupTimeMs)`);
      }
      frames.backupTime = time;
      continue;
    }
    if (isObject(f.account)) frames.account = f.account;
    else if (isObject(f.recipient)) readRecipient(f.recipient, frames, tally);
    else if (isObject(f.chat)) {
      const id = String(f.chat.id);
      frames.chats.set(id, { recipientId: String(f.chat.recipientId), items: pendingItems.get(id) ?? [] });
      pendingItems.delete(id);
    } else if (isObject(f.chatItem)) {
      const chatId = String(f.chatItem.chatId);
      const chat = frames.chats.get(chatId);
      if (chat) chat.items.push(f.chatItem);
      else pendingItems.set(chatId, [...(pendingItems.get(chatId) ?? []), f.chatItem]);
    }
  }
  if (line === 0) throw new Error(`${path} is not a Signal export: it is empty`);
  const orphans = [...pendingItems.values()].reduce((n, items) => n + items.length, 0);
  if (orphans > 0) tally("chat items in no chat the export lists", orphans);
  return frames;
}

function readRecipient(recipient: Json, frames: Frames, tally: (name: string) => void): void {
  const id = String(recipient.id);
  if (isObject(recipient.self)) {
    frames.self = id;
  } else if (isObject(recipient.contact)) {
    const contact = recipient.contact;
    const aci = uuidOf(contact.aci);
    const pni = uuidOf(contact.pni);
    const phone = e164Of(contact.e164);
    const key = aci ?? (pni ? `PNI:${pni}` : phone);
    if (!key) {
      tally("contacts with no id or number");
      return;
    }
    frames.contacts.set(id, { key, ...(aci ? { aci } : {}), name: contactName(contact, key, phone) });
  } else if (isObject(recipient.group)) {
    const group = recipient.group;
    const masterKey = typeof group.masterKey === "string" ? Buffer.from(group.masterKey, "base64") : Buffer.alloc(0);
    if (masterKey.length === 0) {
      tally("groups with no master key");
      return;
    }
    const snapshot = isObject(group.snapshot) ? group.snapshot : {};
    const title = isObject(snapshot.title) ? stringOr(snapshot.title.title)?.trim() : undefined;
    const listed = [
      ...(Array.isArray(snapshot.members) ? snapshot.members : []),
      ...(Array.isArray(snapshot.membersPendingProfileKey) ? snapshot.membersPendingProfileKey.map((p: Json) => p?.member) : []),
    ] as Array<Json | undefined>;
    const members = [...new Set(listed.map((m) => uuidOf(m?.userId)).filter((m): m is string => m !== undefined))];
    frames.groups.set(id, {
      id: `group:${createHash("sha256").update(masterKey).digest("hex").slice(0, 32)}`,
      ...(title ? { title } : {}),
      members,
    });
  } else {
    frames.others.add(id);
  }
}

/** How Signal names a contact: nickname, address book, profile, username, phone number. */
function contactName(contact: Json, key: string, phone: string | undefined): Name {
  const handle = phone ?? stringOr(contact.username);
  const withHandle = (displayName: string, nameSource: string): Name => ({ displayName, nameSource, ...(handle ? { handle } : {}) });
  const nickname = isObject(contact.nickname) ? fullName(contact.nickname.given, contact.nickname.family) : "";
  const system = fullName(contact.systemGivenName, contact.systemFamilyName) || fullName(contact.systemNickname);
  const profile = fullName(contact.profileGivenName, contact.profileFamilyName);
  if (nickname) return withHandle(nickname, "nickname");
  if (system) return withHandle(system, "addressBook");
  if (profile) return withHandle(profile, "profile");
  if (handle) return withHandle(handle, phone ? "phone" : "handle");
  return { displayName: key, nameSource: "none" };
}

function selfNameOf(account: Json): Name {
  const name = fullName(account.givenName, account.familyName);
  const username = stringOr(account.username);
  if (name) return { displayName: name, nameSource: "export", ...(username ? { handle: username } : {}) };
  if (username) return { displayName: username, nameSource: "export", handle: username };
  return { displayName: "Me", nameSource: "none" };
}

/**
 * The captain's ACI: the group member with no contact record who is in the
 * most groups (Signal writes a contact for everyone else in a group). Null
 * when no one is, or two are in as many.
 */
function findSelfAci(frames: Frames): string | null {
  const known = new Set([...frames.contacts.values()].map((c) => c.aci));
  const groupsOf = new Map<string, number>();
  for (const group of frames.groups.values()) {
    for (const aci of group.members) if (!known.has(aci)) groupsOf.set(aci, (groupsOf.get(aci) ?? 0) + 1);
  }
  const ranked = [...groupsOf].sort((a, b) => b[1] - a[1]);
  return ranked.length > 0 && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
}

/** The attachment files under files/, by the media name their file name starts with. */
async function mediaFiles(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name.slice(0, entry.name.length - extname(entry.name).length);
    if (/^[0-9a-f]{64}$/.test(name)) files.set(name, join(entry.parentPath, entry.name));
  }
  return files;
}

/** The name Signal gives an attachment's file in an export: SHA-256 of its plaintextHash and localKey, in hex. */
export function mediaName(locator: Json | undefined): string | undefined {
  if (typeof locator?.plaintextHash !== "string" || typeof locator.localKey !== "string") return undefined;
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from(locator.plaintextHash, "base64"), Buffer.from(locator.localKey, "base64")]))
    .digest("hex");
}

function attachmentType(flag: unknown, mime: string | undefined, fileName: string | undefined): AttachmentType {
  if (flag === "VOICE_MESSAGE") return "audio";
  if (flag === "GIF") return "gif";
  if (mime === "image/gif") return "gif";
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  return fileName ? mediaTypeOf(fileName).type : "file";
}

/** A 16-byte id, as Signal's JSON writes bytes (base64), in UUID form. */
function uuidOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const hex = Buffer.from(value, "base64").toString("hex");
  return hex.length === 32 ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : undefined;
}

/** A phone number as Signal's JSON writes it (digits, no "+"), in E.164. */
function e164Of(value: unknown): string | undefined {
  const digits = typeof value === "number" ? String(value) : value;
  return typeof digits === "string" && /^\d{6,15}$/.test(digits) ? `+${digits}` : undefined;
}

function bodyOf(text: unknown): string | undefined {
  return isObject(text) ? stringOr(text.body) : undefined;
}

function fullName(...parts: unknown[]): string {
  return parts.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean).join(" ");
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
