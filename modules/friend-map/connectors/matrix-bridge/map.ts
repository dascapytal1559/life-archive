// Turning what the homeserver says into archive events, with no I/O: a
// bridged room's state into a conversation and its accounts, and a room
// event into a message, edit, reaction or attachment. See read.ts for the
// order they are asked in.
//
// - A room is a conversation when the bridge's database records it as a chat
//   (its portal), from that record rather than the room's m.bridge state,
//   which names the wrong chat when the homeserver gave two chats one room.
//   Its id is the bridge's chat id as the profile turns it into the archive's
//   (Telegram's is the archive's: "user:777000" for a one-to-one chat,
//   "chat:<id>" for a small group, "channel:<id>" for a supergroup or
//   channel; WhatsApp's one-to-one chats are keyed by the other person, as
//   whatsapp-db keys them); a one-to-one chat is you and them, anything else
//   a group.
// - A group of more than SMALL_GROUP_MAX people (the captain included, the
//   same line the archive rules draw between a small group and a big one), a
//   broadcast channel and a WhatsApp community are not read (the captain's
//   choice: big groups only link people together).
// - A ghost (`@telegram_<id>:server`) is the account with that platform id,
//   as the profile keys it (WhatsApp: by phone number when the bridge knows
//   it). The captain is their own ghost (`@telegram_<own id>`, as messages
//   from their phone arrive), under any of their ids, and their Matrix user
//   (as messages from friend-map do).
// - A message's time is the event's origin_server_ts, which the bridge sets to
//   the platform's time; its id is the bridge database's, as the profile
//   turns it into the archive's (see bridgeDb.ts and rig.ts). One the bridge
//   made up itself, such as a WhatsApp call notice, is a system message that
//   no one sent. What the bridge writes in place of a message it could not
//   bridge is not that message's text: a file it could no longer fetch (old
//   WhatsApp media) is the message it would have been, with its file missing,
//   and, where the network has no notices (WhatsApp), a notice ("unsupported
//   message") is a message of another kind, with no text. A contact card (a
//   .vcf file) is a contact, its text the name, as whatsapp-db has it.
// - The bridge's notice for a call (Telegram's "Call ended (12 minutes)", from
//   whoever called; the profile's callNotice reads it) is a call record, as
//   the other apps' are: with how long it was connected, 0 for one never
//   connected, keeping the notice's words; in a group (a video chat) it is
//   the group's call, as any app's call in a group chat is. Its notice of a
//   call ringing ("Started a call") is a system message from no one, since
//   the call record that follows it is the call.

import { type AccountEvent, type AttachmentType, type ConversationEvent, isNumberName, type MessageEvent, type MessageType } from "../../../../sdk/connector.ts";
import { SMALL_GROUP_MAX } from "../../server/stats.ts";
import type { BridgedMessage, Portal } from "./bridgeDb.ts";
import type { MatrixEvent } from "./client.ts";
import type { BridgeProfile, IdLookup } from "./rig.ts";

/** Who sent an event, as the archive sees them; a person with their platform user id (`user`), for their name. */
export type Sender = { kind: "self"; key: string } | { kind: "person"; key: string; user: string } | { kind: "other" };

export interface Identity {
  profile: BridgeProfile;
  /** The captain's Matrix user. */
  userId: string;
  /** The captain's platform id (their login's). */
  selfId: string;
  /** The captain's account key: the profile's, else their platform id. */
  selfKey: string;
  /** The bridge's database, for the ids the profile translates. */
  ids: IdLookup;
}

export const SELF_NAME = "Me";

/** The archive's key for a platform user: the captain's own key for any id of theirs. */
export function keyOf(user: string, who: Identity): string {
  const key = who.profile.accountKey(user, who.ids);
  return user === who.selfId || key === who.profile.accountKey(who.selfId, who.ids) ? who.selfKey : key;
}

export function senderOf(userId: string, who: Identity): Sender {
  if (userId === who.userId) return { kind: "self", key: who.selfKey };
  const ghost = new RegExp(`^@${who.profile.ghostPrefix}([^:]+):`).exec(userId)?.[1];
  if (!ghost) return { kind: "other" };
  const key = keyOf(ghost, who);
  return key === who.selfKey ? { kind: "self", key } : { kind: "person", key, user: ghost };
}

export interface Room {
  roomId: string;
  conversation: ConversationEvent;
  accounts: AccountEvent[];
}

const BRIDGE_TYPES = new Set(["m.bridge", "uk.half-shot.bridge"]);

/** Whether a room's state says it is one of this network's chats (the bridge may not have recorded it yet). */
export function isBridgedRoom(state: MatrixEvent[], who: Identity): boolean {
  return state.some((e) => BRIDGE_TYPES.has(e.type) && protocolOf(e) === who.profile.protocol);
}

/** A bridged room's conversation, as the bridge records the chat (`portal`), and every account in its state. */
export function describeRoom(roomId: string, state: MatrixEvent[], portal: Portal, who: Identity, ghostName: (id: string) => string | null): Room {
  // The room's m.bridge state for this chat, for the name it gives it; a room given to two chats has one for each.
  const bridge = state.find((e) => BRIDGE_TYPES.has(e.type) && protocolOf(e) === who.profile.protocol && channelOf(e)?.id === portal.id);
  const channel = bridge ? channelOf(bridge) : undefined;
  const partner = who.profile.directPartner(portal.id);
  const direct = portal.direct || partner !== null;
  // A one-to-one chat is you and them; your chat with yourself (Telegram's Saved Messages) is you alone.
  const other = direct && partner !== null ? keyOf(partner, who) : undefined;
  const members: string[] = [who.selfKey];
  const names = new Map<string, { name: string; user: string }>();
  for (const event of state) {
    if (event.type !== "m.room.member" || typeof event.state_key !== "string") continue;
    const sender = senderOf(event.state_key, who);
    if (sender.kind !== "person") continue;
    const displayName = typeof event.content.displayname === "string" ? event.content.displayname : null;
    if (displayName) names.set(sender.key, { name: displayName, user: sender.user });
    else if (!names.has(sender.key)) names.set(sender.key, { name: "", user: sender.user });
    const membership = event.content.membership;
    if (!direct && (membership === "join" || membership === "invite") && !members.includes(sender.key)) members.push(sender.key);
  }
  const accounts: AccountEvent[] = [selfAccount(who)];
  for (const [key, { name, user }] of names) accounts.push(personAccount(key, name || ghostName(user), who));
  if (other && other !== who.selfKey) {
    members.push(other);
    if (!names.has(other)) accounts.push(personAccount(other, ghostName(partner!), who));
  }
  const nameEvent = state.find((e) => e.type === "m.room.name" && e.state_key === "");
  const roomName = typeof nameEvent?.content.name === "string" && nameEvent.content.name ? nameEvent.content.name : null;
  const channelName = typeof channel?.displayname === "string" && channel.displayname ? channel.displayname : null;
  const title = roomName ?? channelName ?? (other === who.selfKey || (direct && members.length === 1) ? who.profile.selfChatTitle : undefined);
  return {
    roomId,
    conversation: {
      kind: "conversation",
      id: who.profile.conversationId(portal.id, who.ids),
      type: direct ? "direct" : "group",
      ...(title ? { title } : {}),
      members,
    },
    accounts,
  };
}

/** Why a chat is not read (a tally's name), or null when it is: a group of more than SMALL_GROUP_MAX people, the captain included, a broadcast channel, or a community. */
export function notRead(room: Room, portal: Portal, profile: BridgeProfile): string | null {
  if (room.conversation.type === "direct") return null;
  if (profile.isBroadcast(portal.id, portal.metadata)) return "chats-not-read-channel";
  if (portal.space) return "chats-not-read-community";
  const size = profile.memberCount(portal.metadata) ?? room.conversation.members.length;
  return size > SMALL_GROUP_MAX ? `chats-not-read-group-of-${SMALL_GROUP_MAX + 1}-or-more` : null;
}

function channelOf(event: MatrixEvent): { id?: unknown; displayname?: unknown } | undefined {
  return event.content.channel as { id?: unknown; displayname?: unknown } | undefined;
}

function protocolOf(event: MatrixEvent): string | undefined {
  const protocol = event.content.protocol as { id?: unknown } | undefined;
  return typeof protocol?.id === "string" ? protocol.id : undefined;
}

export function selfAccount(who: Identity): AccountEvent {
  return { kind: "account", key: who.selfKey, keyKind: "id", displayName: SELF_NAME, isSelf: true };
}

/**
 * A platform user by their account key: named as the bridge names them, by
 * their number when that is all it has (as whatsapp-db names them, "+61..."),
 * or else the network's placeholder, for a deleted account or none.
 */
export function personAccount(key: string, name: string | null, who: Identity): AccountEvent {
  const handle = who.profile.handle(key);
  const named = name && !who.profile.placeholder(name) ? name.trim() : null;
  const account = { kind: "account", key, keyKind: "id", ...(handle ? { handle } : {}) } as const;
  if (named && !isNumberName(named)) return { ...account, displayName: named, nameSource: "profile" };
  if (named || handle) return { ...account, displayName: handle ?? named!, nameSource: "number" };
  return { ...account, displayName: who.profile.placeholderName, nameSource: "none" };
}

export interface MappedMessage {
  message: MessageEvent;
  /** The message's attachment, whose file (at `url`, an mxc:// address) is still to be copied in. */
  attachment: { type: AttachmentType; url: string | null; filename: string; mime?: string } | null;
}

/** The archive's id for a bridged message, and for the one it replies to. */
export function platformIds(row: BridgedMessage, profile: BridgeProfile): { id: string; replyTo?: string } {
  return {
    id: profile.messageId(row.roomId, row.id, row.partId),
    ...(row.replyToId ? { replyTo: profile.messageId(row.roomId, row.replyToId, row.replyToPartId ?? "") } : {}),
  };
}

/** An m.room.message or m.sticker event (not an edit) as a message, given the bridge's record of it. */
export function mapMessage(event: MatrixEvent, conversation: string, sender: Exclude<Sender, { kind: "other" }>, row: BridgedMessage, profile: BridgeProfile): MappedMessage {
  const { id, replyTo } = platformIds(row, profile);
  // A file the bridge could not fetch: its notice carries the message it would have been, less the file.
  const failed = event.content[FAILED_MEDIA] as { content?: unknown } | undefined;
  const content = typeof failed?.content === "object" && failed.content !== null ? { ...(failed.content as Record<string, unknown>), url: undefined } : event.content;
  if (profile.bridgeMade(row.id)) {
    // A notice the bridge wrote itself ("Incoming call..."): what happened, from no one, so it never counts as talking.
    return {
      message: {
        kind: "message", id, idKind: "synthetic", conversation, sender: null, isFromSelf: false, sentAt: event.origin_server_ts, type: "system",
        ...(typeof event.content.body === "string" && event.content.body ? { text: event.content.body } : {}),
        raw: { event_id: event.event_id, type: event.type, sender: event.sender, origin_server_ts: event.origin_server_ts, content: event.content },
      },
      attachment: null,
    };
  }
  const body = typeof content.body === "string" ? content.body : "";
  const msgtype = event.type === "m.sticker" ? "m.sticker" : String(content.msgtype ?? "");
  const info = (content.info ?? {}) as Record<string, unknown>;
  const mime = typeof info.mimetype === "string" ? info.mimetype : undefined;
  const filename = typeof content.filename === "string" && content.filename ? content.filename : body;
  let type: MessageType;
  let text: string | undefined = body;
  let attachment: MappedMessage["attachment"] = null;
  const file = (attachmentType: AttachmentType) => ({
    type: attachmentType,
    url: typeof content.url === "string" ? content.url : null,
    filename: filename || attachmentType,
    ...(mime ? { mime } : {}),
  });
  const call = msgtype === "m.notice" && !profile.bridgeNotices ? profile.callNotice(body) : null;
  if (call?.kind === "ring") {
    return {
      message: {
        kind: "message", id, idKind: "platform", conversation, sender: null, isFromSelf: false, sentAt: event.origin_server_ts, type: "system", text: body,
        raw: { event_id: event.event_id, type: event.type, sender: event.sender, origin_server_ts: event.origin_server_ts, content: event.content },
      },
      attachment: null,
    };
  }
  switch (msgtype) {
    case "m.notice":
      if (profile.bridgeNotices) {
        type = "other";
        text = undefined;
        break;
      }
      if (call) {
        type = "call";
        break;
      }
    // falls through
    case "m.text":
    case "m.emote":
      type = "text";
      break;
    case "m.image":
    case "m.video":
    case "m.audio":
    case "m.file": {
      type = "media";
      // A caption is the body when a file name is given apart from it.
      text = typeof content.filename === "string" && content.filename && body !== content.filename ? body : undefined;
      const gif = mime === "image/gif" || info["fi.mau.gif"] === true || info["fi.mau.loop"] === true;
      attachment = file(gif ? "gif" : msgtype === "m.image" ? "image" : msgtype === "m.video" ? "video" : msgtype === "m.audio" ? "audio" : "file");
      if (msgtype === "m.file" && (mime === "text/vcard" || mime === "text/x-vcard")) {
        type = "contact";
        text = filename.replace(/\.vcf$/i, "") || undefined;
      }
      break;
    }
    case "m.sticker":
      type = "sticker";
      text = undefined;
      attachment = file("sticker");
      break;
    case "m.location":
      type = "location";
      break;
    default:
      type = "other";
  }
  return {
    message: {
      kind: "message",
      id,
      idKind: "platform",
      conversation,
      sender: sender.key,
      isFromSelf: sender.kind === "self",
      sentAt: event.origin_server_ts,
      type,
      ...(text ? { text } : {}),
      ...(call?.kind === "call" && call.seconds !== undefined ? { callSeconds: call.seconds } : {}),
      ...(replyTo ? { replyTo } : {}),
      raw: { event_id: event.event_id, type: event.type, sender: event.sender, origin_server_ts: event.origin_server_ts, content: event.content },
    },
    attachment,
  };
}

/** Where mautrix-whatsapp keeps, on the notice it sends instead, the media message it could not fetch the file of. */
export const FAILED_MEDIA = "fi.mau.whatsapp.failed_media";

/** What an event relates to: an edit's, a reaction's or a status's target event. */
export function relation(event: MatrixEvent): { type: string; eventId: string; key?: string } | null {
  const relates = event.content["m.relates_to"] as { rel_type?: unknown; event_id?: unknown; key?: unknown } | undefined;
  if (typeof relates?.rel_type !== "string" || typeof relates.event_id !== "string") return null;
  return { type: relates.rel_type, eventId: relates.event_id, ...(typeof relates.key === "string" ? { key: relates.key } : {}) };
}

/** An edit's new text. */
export function editedText(event: MatrixEvent): string | null {
  const next = event.content["m.new_content"] as { body?: unknown } | undefined;
  return typeof next?.body === "string" ? next.body : null;
}

/** Whether a message event was deleted (redacted): it keeps no content. */
export function isRedacted(event: MatrixEvent): boolean {
  return Boolean(event.unsigned?.redacted_because) || Object.keys(event.content).length === 0;
}
