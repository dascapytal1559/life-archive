// A made-up Signal Desktop "Export chat history" folder in the real format
// (see connectors/signal-export/read.ts), for the signal-export tests. Every
// id, key, name, number and line is invented. Written by the tests, never committed.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A made-up id in the form Signal's JSON writes one (16 bytes, base64), and its UUID. */
function id(n: number): { b64: string; uuid: string } {
  const hex = n.toString(16).padStart(32, "0");
  return {
    b64: Buffer.from(hex, "hex").toString("base64"),
    uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  };
}

export const SIGNAL_SELF = { aci: id(0x100), name: "Sample Captain", username: "sample.01" };
/** Named by the captain's address book, with a phone number. */
export const SIGNAL_ADA = { recipient: "2", aci: id(0x201), phone: "+61491571266", name: "Ada Sample" };
/** Named by their profile, with a phone number. */
export const SIGNAL_BRUNO = { recipient: "3", aci: id(0x202), phone: "+61491571491", name: "Bruno Placeholder" };
/** No name, only a phone number; writes and is never written to. */
export const SIGNAL_CLEO = { recipient: "4", aci: id(0x203), phone: "+61491571804" };
/** The captain's nickname for them wins over his address book's; in the small group, never writes. */
export const SIGNAL_DEV = { recipient: "5", aci: id(0x204), name: "Dev T" };
/** Named by their profile; writes only in the small group. */
export const SIGNAL_ESME = { recipient: "6", aci: id(0x205), name: "Esme Example" };
/** Known only by their PNI, in no chat. */
export const SIGNAL_FINN = { recipient: "7", pni: id(0x206) };
/** A chat with no messages. */
export const SIGNAL_GUS = { recipient: "8", aci: id(0x207) };
/** Thirteen others in the big group, so it is fourteen people with the captain. */
export const SIGNAL_CROWD = Array.from({ length: 13 }, (_, i) => ({ recipient: String(20 + i), aci: id(0x300 + i), name: `Crowd Member ${i + 1}` }));

const SMALL_KEY = Buffer.alloc(32, 7);
const BIG_KEY = Buffer.alloc(32, 9);
export const SIGNAL_SMALL_GROUP = `group:${createHash("sha256").update(SMALL_KEY).digest("hex").slice(0, 32)}`;
export const SIGNAL_BIG_GROUP = `group:${createHash("sha256").update(BIG_KEY).digest("hex").slice(0, 32)}`;

export const SIGNAL_PHOTO = Buffer.from("made-up photo bytes");
export const SIGNAL_GIF = Buffer.from("made-up gif bytes");
const PHOTO_LOCATOR = { plaintextHash: Buffer.alloc(32, 1).toString("base64"), localKey: Buffer.alloc(64, 2).toString("base64"), key: Buffer.alloc(64, 3).toString("base64"), size: SIGNAL_PHOTO.length };
const GIF_LOCATOR = { plaintextHash: Buffer.alloc(32, 4).toString("base64"), localKey: Buffer.alloc(64, 5).toString("base64"), key: Buffer.alloc(64, 6).toString("base64"), size: SIGNAL_GIF.length };

export const SIGNAL_SAMPLE = {
  directChats: 4,
  groupChats: 2,
  messages: 14,
  reactions: 2,
  /** Two stored, one missing. */
  attachments: 3,
};

/** Milliseconds on a day of January 2025, at 10:00 UTC plus `minute`. */
export const signalAt = (day: number, minute = 0) => Date.UTC(2025, 0, day, 10, minute);
const t = (day: number, minute = 0) => String(signalAt(day, minute));

const incoming = (day: number) => ({ incoming: { dateReceived: t(day, 1), dateServerSent: t(day), read: true, sealedSender: true } });
const outgoing = (day: number) => ({ outgoing: { dateReceived: t(day), sendStatus: [] } });
const text = (body: string) => ({ text: { body } });

function contact(recipient: string, fields: Record<string, unknown>) {
  return { recipient: { id: recipient, contact: { avatarColor: "A100", profileSharing: true, ...fields } } };
}

function group(recipient: string, masterKey: Buffer, title: string | undefined, members: string[]) {
  return {
    recipient: {
      id: recipient,
      group: {
        masterKey: masterKey.toString("base64"),
        whitelisted: true,
        snapshot: {
          ...(title ? { title: { title } } : {}),
          version: 3,
          members: members.map((userId) => ({ userId, role: "DEFAULT" })),
          accessControl: { attributes: "MEMBER", members: "MEMBER", addFromInviteLink: "UNSATISFIABLE" },
        },
      },
    },
  };
}

const item = (chatId: string, authorId: string, day: number, minute: number, rest: Record<string, unknown>) =>
  ({ chatItem: { chatId, authorId, dateSent: t(day, minute), ...rest } });

/** The frames of main.jsonl, header first. `newer` makes the export a later one: one message more, one edited again. */
export function signalExportFrames({ newer = false } = {}): unknown[] {
  const smallMembers = [SIGNAL_SELF.aci.b64, SIGNAL_ADA.aci.b64, SIGNAL_DEV.aci.b64, SIGNAL_ESME.aci.b64];
  const bigMembers = [SIGNAL_SELF.aci.b64, ...SIGNAL_CROWD.map((c) => c.aci.b64)];
  const brunoEdited = newer
    ? item("12", "1", 6, 5, { ...outgoing(6), revisions: [item("12", "1", 6, 0, { ...outgoing(6), standardMessage: text("See you then") }).chatItem], standardMessage: text("See you at six") })
    : item("12", "1", 6, 0, { ...outgoing(6), standardMessage: text("See you then") });
  return [
    { version: "1", backupTimeMs: String(newer ? Date.UTC(2025, 2, 1) : Date.UTC(2025, 1, 1)), mediaRootBackupKey: "AAAA", currentAppVersion: "Desktop 7.0.0", firstAppVersion: "Desktop 7.0.0" },
    { account: { profileKey: "AAAA", username: SIGNAL_SELF.username, givenName: "Sample", familyName: "Captain", accountSettings: { readReceipts: true } } },
    { recipient: { id: "1", self: { avatarColor: "A100" } } },
    contact(SIGNAL_ADA.recipient, { aci: SIGNAL_ADA.aci.b64, e164: SIGNAL_ADA.phone.slice(1), systemGivenName: "Ada", systemFamilyName: "Sample", profileGivenName: "Ada P" }),
    contact(SIGNAL_BRUNO.recipient, { aci: SIGNAL_BRUNO.aci.b64, e164: SIGNAL_BRUNO.phone.slice(1), profileGivenName: "Bruno", profileFamilyName: "Placeholder" }),
    contact(SIGNAL_CLEO.recipient, { aci: SIGNAL_CLEO.aci.b64, e164: SIGNAL_CLEO.phone.slice(1) }),
    contact(SIGNAL_DEV.recipient, { aci: SIGNAL_DEV.aci.b64, nickname: { given: "Dev", family: "T" }, systemGivenName: "Devon" }),
    contact(SIGNAL_ESME.recipient, { aci: SIGNAL_ESME.aci.b64, profileGivenName: "Esme", profileFamilyName: "Example" }),
    contact(SIGNAL_FINN.recipient, { pni: SIGNAL_FINN.pni.b64, systemGivenName: "Finn", notRegistered: { unregisteredTimestamp: t(1) } }),
    contact(SIGNAL_GUS.recipient, { aci: SIGNAL_GUS.aci.b64, profileGivenName: "Gus" }),
    ...SIGNAL_CROWD.map((c, i) => contact(c.recipient, { aci: c.aci.b64, profileGivenName: "Crowd", profileFamilyName: `Member ${i + 1}` })),
    group("9", SMALL_KEY, "Climbing crew", smallMembers),
    group("10", BIG_KEY, undefined, bigMembers),
    { recipient: { id: "11", releaseNotes: {} } },
    { recipient: { id: "12", distributionList: { distributionId: "AAAA", distributionList: { name: "My story", allowReplies: true, privacyMode: "ALL" } } } },
    { stickerPack: { packId: "AAAA", packKey: "AAAA" } },
    ...["11", "12", "13", "14", "15", "16", "17", "18"].map((chat, i) => ({
      chat: { id: chat, recipientId: ["2", "3", "4", "8", "9", "10", "1", "11"][i], expireTimerVersion: 1 },
    })),
    // Ada's chat.
    item("11", SIGNAL_ADA.recipient, 1, 0, {
      ...incoming(1),
      standardMessage: {
        ...text("Hello on Signal"),
        reactions: [
          { emoji: "❤️", authorId: "1", sentTimestamp: t(1, 1), sortOrder: "1" },
          { emoji: "👍", authorId: "99", sentTimestamp: t(1, 2), sortOrder: "2" },
        ],
      },
    }),
    item("11", "1", 2, 3, {
      ...outgoing(2),
      revisions: [item("11", "1", 2, 0, { ...outgoing(2), standardMessage: text("Frist") }).chatItem],
      standardMessage: text("First"),
    }),
    item("11", "1", 3, 0, {
      ...outgoing(3),
      standardMessage: {
        attachments: [
          { pointer: { contentType: "image/jpeg", fileName: "photo.jpg", width: 10, height: 10, locatorInfo: PHOTO_LOCATOR }, clientUuid: "AAAA" },
          { pointer: { contentType: "audio/aac", locatorInfo: { plaintextHash: Buffer.alloc(32, 8).toString("base64"), key: "AAAA", size: 3 } }, flag: "VOICE_MESSAGE" },
        ],
      },
    }),
    item("11", SIGNAL_ADA.recipient, 4, 0, {
      ...incoming(4),
      standardMessage: {
        quote: { targetSentTimestamp: t(2), authorId: "1", text: { body: "First" }, type: "NORMAL" },
        ...text("Look https://example.com/crag"),
        linkPreview: [{ url: "https://example.com/crag", title: "Crag" }],
      },
    }),
    item("11", SIGNAL_ADA.recipient, 4, 30, { ...incoming(4), remoteDeletedMessage: {} }),
    item("11", "1", 5, 0, {
      directionless: {},
      updateMessage: { individualCall: { callId: "5551", type: "AUDIO_CALL", direction: "OUTGOING", state: "ACCEPTED", startedCallTimestamp: t(5), read: true } },
    }),
    // A call she made that was missed.
    item("11", SIGNAL_ADA.recipient, 5, 15, {
      directionless: {},
      updateMessage: { individualCall: { callId: "5552", type: "VIDEO_CALL", direction: "INCOMING", state: "MISSED", startedCallTimestamp: t(5, 15), read: true } },
    }),
    item("11", SIGNAL_ADA.recipient, 5, 30, { directionless: {}, updateMessage: { simpleUpdate: { type: "IDENTITY_UPDATE" } } }),
    // Bruno's chat.
    item("12", SIGNAL_BRUNO.recipient, 6, 0, {
      ...incoming(6),
      stickerMessage: {
        sticker: { packId: "AAAA", packKey: "AAAA", stickerId: 1, emoji: "🙂", data: { contentType: "image/webp" } },
        reactions: [{ emoji: "😂", authorId: "1", sentTimestamp: t(6, 2), sortOrder: "1" }],
      },
    }),
    brunoEdited,
    ...(newer ? [item("12", SIGNAL_BRUNO.recipient, 20, 0, { ...incoming(20), standardMessage: text("Made it") })] : []),
    // Cleo writes, and is never written to.
    item("13", SIGNAL_CLEO.recipient, 7, 0, { ...incoming(7), standardMessage: text("Is this the right number?") }),
    // The small group.
    item("15", SIGNAL_ESME.recipient, 8, 0, {
      ...incoming(8),
      standardMessage: { attachments: [{ pointer: { contentType: "video/mp4", locatorInfo: GIF_LOCATOR }, flag: "GIF" }] },
    }),
    item("15", "1", 8, 5, { ...outgoing(8), standardMessage: text("Saturday?") }),
    item("15", "1", 8, 10, {
      directionless: {},
      updateMessage: { groupChange: { updates: [{ groupNameUpdate: { updaterAci: SIGNAL_SELF.aci.b64, newGroupName: "Climbing crew" } }] } },
    }),
    // The big group.
    item("16", SIGNAL_CROWD[0].recipient, 9, 0, { ...incoming(9), standardMessage: text("Welcome all") }),
    // Note to Self.
    item("17", "1", 10, 0, { ...outgoing(10), standardMessage: text("Remember the rope") }),
    // An item in no chat the export lists.
    item("99", SIGNAL_ADA.recipient, 11, 0, { ...incoming(11), standardMessage: text("Lost") }),
  ];
}

/** Signal's name for an attachment's file in an export, as read.ts works it out. */
function mediaFile(locator: { plaintextHash: string; localKey: string }, extension: string): string {
  const name = createHash("sha256")
    .update(Buffer.concat([Buffer.from(locator.plaintextHash, "base64"), Buffer.from(locator.localKey, "base64")]))
    .digest("hex");
  return join("files", name.slice(0, 2), `${name}.${extension}`);
}

/** Writes the export folder as Signal Desktop does: metadata.json, main.jsonl and files/. */
export async function writeSignalExport(dir: string, { newer = false } = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "metadata.json"), JSON.stringify({ version: 1 }));
  await writeFile(join(dir, "main.jsonl"), signalExportFrames({ newer }).map((f) => JSON.stringify(f)).join("\n") + "\n");
  for (const [locator, bytes, extension] of [[PHOTO_LOCATOR, SIGNAL_PHOTO, "jpg"], [GIF_LOCATOR, SIGNAL_GIF, "mp4"]] as const) {
    const path = join(dir, mediaFile(locator, extension));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
  }
}
