// Where things are in the bridge rig (~/.local/share/friend-map-bridge-lab,
// see its README), and the settings that can move them:
//
//   config/tuwunel.toml                 the homeserver's name, address and port
//   secrets/captain-matrix-password     the captain's Matrix password (read, never copied)
//   data/bridge/mautrix-telegram.db     the Telegram bridge's database (read-only)
//   data/whatsapp/mautrix-whatsapp.db   the WhatsApp bridge's database (read-only)
//
// Settings in data/connectors/<connector>.json (matrix-bridge.json for
// Telegram, matrix-whatsapp.json for WhatsApp), all optional:
//   source      the rig folder
//   homeserver  the homeserver's URL, if not what tuwunel.toml says
//   bridgeUrl   the bridge's own URL (its /_matrix/mau/live says it is up)
//   user        the Matrix user to read as, "captain" by default
//   healthUrl   what the host asks before starting (see the manifest)

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** What a profile may ask the bridge's database while it turns the bridge's ids into the archive's (see BridgeDb). */
export interface IdLookup {
  /** The phone number (digits) behind a WhatsApp LID (digits), if the bridge has learned it. */
  phoneOfLid(lid: string): string | null;
}

/** What one mautrix bridge looks like from Matrix. Adding a network is adding one of these, and a connector folder that uses it. */
export interface BridgeProfile {
  /** The network's name, as the captain knows it. */
  name: string;
  /** The m.bridge `protocol.id` of its rooms. */
  protocol: string;
  /** Its ghost users' localparts: `telegram_<platform id>`. */
  ghostPrefix: string;
  /** Its bot's localpart. */
  bot: string;
  /** Its database, in the rig. */
  database: string;
  /** Its own address in the rig, unless the settings name another. */
  bridgeUrl: string;
  /** The rig's script that logs it in to the network. */
  loginScript: string;
  /**
   * The Matrix device friend-map reads it as. One per bridge, because each
   * bridge's connector logs in on its own, and logging in again as a device
   * ends that device's other session.
   */
  device: string;
  /** The name an account gets when the bridge names nobody, as the network's own apps say it. */
  placeholderName: string;
  /** Placeholder names it gives accounts that name nobody, such as a deleted account. */
  placeholder: (name: string) => boolean;
  /** The archive's key for the captain's own account; their platform id when not given. */
  selfKey?: string;
  /** The name of the captain's chat with themselves, when the bridge gives it none. */
  selfChatTitle: string;
  /** The archive's key for a platform user (a ghost's id, or the other person in a one-to-one chat). */
  accountKey: (user: string, ids: IdLookup) => string;
  /** The handle (a phone number, say) an account key carries, if any. */
  handle: (key: string) => string | undefined;
  /** The archive's id for a chat (the bridge's portal id). */
  conversationId: (chat: string, ids: IdLookup) => string;
  /** The platform user a one-to-one chat is with, as its id says; null for any other chat. */
  directPartner: (chat: string) => string | null;
  /** The archive's id for a message the bridge recorded in `room` with its own id and part. */
  messageId: (room: string, id: string, partId: string) => string;
  /** Whether the bridge made a message up itself (a call notice, say) rather than bridging one someone sent. */
  bridgeMade: (id: string) => boolean;
  /**
   * Whether a notice (m.notice) from someone is the bridge's own words in place of a message it could not
   * bridge ("unsupported message", "view once"), rather than something they sent: WhatsApp has no notices.
   */
  bridgeNotices: boolean;
  /** What a notice from someone says of a call, when it is the bridge's words for one (see CallNotice); else null. */
  callNotice: (body: string) => CallNotice | null;
  /** How many people a group chat has, from the bridge's metadata for it, if it says. */
  memberCount: (metadata: Record<string, unknown>) => number | null;
  /** Whether a chat is a broadcast channel (people read it, only its admins post). */
  isBroadcast: (chatId: string, metadata: Record<string, unknown>) => boolean;
}

/**
 * A call, as the bridge's notice for it says: a call record (`call`, with how long it was connected when the words
 * say, 0 for one never connected), or a call ringing (`ring`: the call record the bridge writes when it ends stands
 * for it).
 */
export type CallNotice = { kind: "call"; seconds?: number } | { kind: "ring" };

/**
 * mautrix-telegram's words for a call (pkg/connector/handletelegram.go), which it writes, as a notice from whoever
 * called, only for calls made or ended while it runs (it never backfills them): a one-to-one call when it ends,
 * "Call ended (12 minutes and 5 seconds)", "Video call missed" (missed, disconnected, ended or rejected, with how long
 * when it was connected); a call ringing on the captain, "Started a call" or "Started a video call"; and a group's
 * video chat, "Started a video chat", or "Ended the video chat (1 hour and 2 minutes)" when it is first seen ended.
 */
export function telegramCallNotice(body: string): CallNotice | null {
  if (/^Started a (video )?call$/.test(body)) return { kind: "ring" };
  if (body === "Started a video chat") return { kind: "call" };
  const ended = /^(?:(?:Video call|Call) (?:missed|disconnected|ended|rejected)(?: \((.+)\))?|Ended the video chat \((.+)\))$/.exec(body);
  if (!ended) return null;
  const words = ended[1] ?? ended[2];
  if (words === undefined) return { kind: "call", seconds: 0 };
  const seconds = bridgeDuration(words);
  return seconds === undefined ? { kind: "call" } : { kind: "call", seconds };
}

const UNIT_SECONDS: Record<string, number> = { week: 604_800, day: 86_400, hour: 3_600, minute: 60, second: 1 };

/** How long the bridge's words say ("1 hour, 2 minutes and 5 seconds", mautrix's exfmt.Duration), in seconds; undefined for other words. */
function bridgeDuration(words: string): number | undefined {
  let seconds = 0;
  for (const part of words.split(/, | and /)) {
    const match = /^(\d+) (week|day|hour|minute|second)s?$/.exec(part);
    if (!match) return undefined;
    seconds += Number(match[1]) * UNIT_SECONDS[match[2]];
  }
  return seconds;
}

export const TELEGRAM: BridgeProfile = {
  name: "Telegram",
  protocol: "telegram",
  ghostPrefix: "telegram_",
  bot: "telegrambot",
  database: "data/bridge/mautrix-telegram.db",
  bridgeUrl: "http://127.0.0.1:46081",
  loginScript: "telegram-login.sh",
  device: "FRIENDMAP",
  placeholderName: "Telegram user",
  placeholder: (name) => /^deleted account( \d+)?$/i.test(name.trim()),
  selfChatTitle: "Saved Messages",
  // Telegram's ids are the archive's: an account is its Telegram id, a chat the bridge's "user:<id>", "chat:<id>" or "channel:<id>".
  accountKey: (user) => user,
  handle: () => undefined,
  conversationId: (chat) => chat,
  directPartner: (chat) => /^user:(.+)$/.exec(chat)?.[1] ?? null,
  // A chat's own message id, prefixed by the chat: "user:777000/124233", "chat:900000002/88",
  // "channel:1000000001/16537". The bridge writes a channel's ids as "<channel>.<message>" and
  // the others' as the bare number, which private chats and small groups share across the account.
  // A Telegram Desktop export gives each chat's id and each message's id, so it can form the same ids.
  messageId: (room, id, partId) => {
    const channel = /^channel:(\d+)$/.exec(room)?.[1];
    const own = channel && id.startsWith(`${channel}.`) ? id.slice(channel.length + 1) : id;
    return `${room}/${own}${partId ? `#${partId}` : ""}`;
  },
  bridgeMade: () => false,
  bridgeNotices: false,
  callNotice: telegramCallNotice,
  memberCount: (metadata) => (typeof metadata.member_count === "number" && metadata.member_count > 0 ? metadata.member_count : null),
  // A supergroup and a broadcast channel are both "channel:<id>"; the bridge marks a supergroup (is_supergroup) and
  // leaves the mark off a broadcast channel.
  isBroadcast: (chatId, metadata) => /^channel:\d+$/.test(chatId) && metadata.is_supergroup !== true,
};

/**
 * A WhatsApp user as whatsapp-db keys them, so live and imported accounts are
 * one: their phone JID ("61491571266@s.whatsapp.net") when the number is known,
 * else their LID ("100000000000001@lid"). The bridge names a user by phone
 * ("61491571266"), by LID ("lid-100000000000001") or as a Meta AI bot ("bot-<n>").
 */
function whatsAppKey(user: string, ids: IdLookup): string {
  const lid = /^lid-(\d+)$/.exec(user)?.[1];
  if (lid) {
    const phone = ids.phoneOfLid(lid);
    return phone ? `${phone}@s.whatsapp.net` : `${lid}@lid`;
  }
  const bot = /^bot-(\d+)$/.exec(user)?.[1];
  return bot ? `${bot}@bot` : `${user}@s.whatsapp.net`;
}

/** The WhatsApp user a one-to-one chat's JID names, as the bridge names users. */
function whatsAppPartner(chat: string): string | null {
  const [, user, server] = /^(\d+)@(s\.whatsapp\.net|lid|bot)$/.exec(chat) ?? [];
  if (!user) return null;
  return server === "lid" ? `lid-${user}` : server === "bot" ? `bot-${user}` : user;
}

export const WHATSAPP: BridgeProfile = {
  name: "WhatsApp",
  protocol: "whatsapp",
  ghostPrefix: "whatsapp_",
  bot: "whatsappbot",
  database: "data/whatsapp/mautrix-whatsapp.db",
  bridgeUrl: "http://127.0.0.1:46082",
  loginScript: "whatsapp-login.sh",
  device: "FRIENDMAP_WHATSAPP",
  placeholderName: "WhatsApp user",
  // The bridge names someone it knows nothing of "WhatsApp user" (and at worst by their number, which map.ts handles).
  placeholder: (name) => /^whatsapp user$/i.test(name.trim()),
  // The captain is "me", as whatsapp-db has them, and their chat with themselves is named as whatsapp-db names it.
  selfKey: "me",
  selfChatTitle: "Me",
  accountKey: whatsAppKey,
  handle: (key) => {
    const phone = /^(\d+)@s\.whatsapp\.net$/.exec(key)?.[1];
    return phone ? `+${phone}` : undefined;
  },
  // A one-to-one chat is its partner's account key, as in whatsapp-db (the bridge keys most by the partner's LID); a group is its JID.
  conversationId: (chat, ids) => {
    const partner = whatsAppPartner(chat);
    return partner ? whatsAppKey(partner, ids) : chat;
  },
  directPartner: whatsAppPartner,
  // The bridge's id is "<chat JID>:<sender JID>:<message id>", and the message id (the stanza id the sender's
  // device chose) is whatsapp-db's id for the same message, so a message imported and bridged is one.
  // A message the bridge made up ("fake:...") keeps the bridge's whole id.
  messageId: (_room, id, partId) => {
    const own = id.startsWith("fake:") ? id : id.split(":").slice(2).join(":") || id;
    return `${own}${partId ? `#${partId}` : ""}`;
  },
  bridgeMade: (id) => id.startsWith("fake:") || id.split(":").slice(2).join(":").startsWith("FAKE::"),
  bridgeNotices: true,
  // Its one call notice ("Incoming call") is a message it makes up itself (bridgeMade), never someone's.
  callNotice: () => null,
  // WhatsApp's bridge keeps no member count: a group's size is its room's members, all of whom it adds.
  memberCount: () => null,
  // A WhatsApp channel ("@newsletter"), and a broadcast list or status updates ("@broadcast").
  isBroadcast: (chatId) => /@(newsletter|broadcast)$/.test(chatId),
};

/** Every bridge in the rig, so one bridge's connector knows another's rooms and invitations for someone else's. */
export const PROFILES: readonly BridgeProfile[] = [TELEGRAM, WHATSAPP];

export interface Rig {
  folder: string;
  homeserver: string;
  bridgeUrl: string;
  serverName: string;
  user: string;
  userId: string;
  password: string;
  bridgeDatabase: string;
}

export async function readRig(folder: string, config: Record<string, unknown>, profile: BridgeProfile): Promise<Rig> {
  let toml = "";
  try {
    toml = await readFile(join(folder, "config", "tuwunel.toml"), "utf8");
  } catch {
    throw new Error(`no bridge rig at ${folder} (config/tuwunel.toml is missing); see the rig's README`);
  }
  const setting = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n]+?)"?\\s*$`, "m").exec(toml)?.[1];
  const serverName = setting("server_name");
  if (!serverName) throw new Error("the rig's config/tuwunel.toml names no server_name");
  const address = setting("address") ?? "127.0.0.1";
  const port = setting("port") ?? "8008";
  let password: string;
  try {
    password = (await readFile(join(folder, "secrets", "captain-matrix-password"), "utf8")).trim();
  } catch {
    throw new Error("the rig has no secrets/captain-matrix-password yet (its start.sh makes one)");
  }
  const user = typeof config.user === "string" && config.user ? config.user : "captain";
  return {
    folder,
    homeserver: typeof config.homeserver === "string" ? config.homeserver : `http://${address}:${port}`,
    bridgeUrl: typeof config.bridgeUrl === "string" ? config.bridgeUrl : profile.bridgeUrl,
    serverName,
    user,
    userId: `@${user}:${serverName}`,
    password,
    bridgeDatabase: join(folder, profile.database),
  };
}
