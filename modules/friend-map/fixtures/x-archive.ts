// A made-up X archive ("Download an archive of your data") in the real format
// (see connectors/x-archive/read.ts), for the x-archive tests. Every id, name
// and line is invented. Written by the tests, never committed.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeZip, type ZipInput } from "../../../sdk/server.ts";

export const X_SELF = { id: "100", username: "sample_captain", name: "Sample Captain" };
/** Named by a tweet that mentions them. */
export const X_ADA = { id: "201", username: "ada_sample", name: "Ada Sample" };
/** Only replied to, so known by their @handle. */
export const X_BRUNO = { id: "202", username: "bruno_p" };
/** Named by nothing in the archive. */
export const X_CLEO = { id: "203" };
/** In the small group, never writes. */
export const X_DEV = { id: "204", username: "dev_t", name: "Dev Testington" };
export const X_ESME = { id: "205" };
/** Thirteen others in the big group, so it is fourteen people with the captain; one tweet names them all. */
export const X_CROWD = Array.from({ length: 13 }, (_, i) => String(300 + i));

export const PHOTO = Buffer.from("made-up photo bytes");
export const GROUP_GIF = Buffer.from("made-up gif bytes");

export const X_SAMPLE = {
  directChats: 3,
  groupChats: 2,
  messages: 11,
  reactions: 2,
  /** Two stored, one missing. */
  attachments: 3,
};

const at = (day: number, minute = 0) => new Date(Date.UTC(2025, 0, day, 10, minute)).toISOString();

function message(id: string, sender: string, createdAt: string, extra: Record<string, unknown> = {}, recipient?: string) {
  return {
    messageCreate: {
      ...(recipient ? { recipientId: recipient } : {}),
      reactions: [], urls: [], text: "", mediaUrls: [], senderId: sender, id, createdAt, editHistory: [], ...extra,
    },
  };
}

/** The data file as X writes it. */
export function ytd(name: string, records: unknown[], part = 0): string {
  return `window.YTD.${name}.part${part} = ${JSON.stringify(records, null, 2)}`;
}

export function directChats() {
  const S = X_SELF.id;
  return [
    {
      dmConversation: {
        conversationId: `${S}-${X_ADA.id}`,
        // Newest first, as X writes them.
        messages: [
          message("9006", S, at(3), {
            text: "Here it is https://t.co/media1",
            urls: [{ url: "https://t.co/media1", expanded: "https://twitter.com/messages/media/9006", display: "pic.x.com/media1" }],
            mediaUrls: ["https://ton.twitter.com/dm/9006/7001/photo1.jpg"],
          }, X_ADA.id),
          message("9005", X_ADA.id, at(2, 5), {
            text: "Look https://t.co/crag",
            urls: [{ url: "https://t.co/crag", expanded: "https://example.com/crag", display: "example.com/crag" }],
          }, S),
          message("9004", S, at(2), {
            text: "Only the picture https://t.co/media2",
            urls: [{ url: "https://t.co/media2", expanded: "https://x.com/messages/media/9004", display: "pic.x.com/media2" }],
            mediaUrls: ["https://ton.twitter.com/dm/9004/7002/lost.jpg"],
          }, X_ADA.id),
          message("9001", X_ADA.id, at(1), {
            text: "Welcome to X!",
            reactions: [
              { senderId: S, reactionKey: "like", eventId: "e1", createdAt: at(1, 1) },
              { senderId: S, reactionKey: "not-a-kind", eventId: "e2", createdAt: at(1, 2) },
            ],
          }, S),
        ],
      },
    },
    {
      dmConversation: {
        conversationId: `${X_BRUNO.id}-${S}`,
        messages: [message("9101", X_BRUNO.id, at(4), { text: "Hello?" }, S)],
      },
    },
    {
      dmConversation: {
        conversationId: `${S}-${X_CLEO.id}`,
        messages: [
          message("9202", S, at(5, 1), { text: "Hi Cleo", editHistory: [{ some: "earlier version" }] }, X_CLEO.id),
          message("9201", X_CLEO.id, at(5), { text: "Hi" }, S),
        ],
      },
    },
  ];
}

export function groupChats() {
  const S = X_SELF.id;
  return [
    {
      dmConversation: {
        conversationId: "5001",
        messages: [
          message("9303", X_ESME.id, at(7), {
            text: "https://t.co/gif1",
            urls: [{ url: "https://t.co/gif1", expanded: "https://twitter.com/messages/media/9303", display: "pic.x.com/gif1" }],
            mediaUrls: ["https://video.twimg.com/dm_gif/7003/party.mp4"],
            reactions: [{ senderId: X_DEV.id, reactionKey: "funny", eventId: "e3", createdAt: at(7, 1) }],
          }),
          { conversationNameUpdate: { initiatingUserId: S, name: "Climbing crew", createdAt: at(6, 5) } },
          message("9302", S, at(6, 2), { text: "Welcome all" }),
          { conversationNameUpdate: { initiatingUserId: X_ESME.id, name: "Old name", createdAt: at(6, 1) } },
          message("9301", X_ESME.id, at(6), { text: "Made a group" }),
          { participantsJoin: { initiatingUserId: X_ESME.id, userIds: [X_DEV.id], createdAt: at(6, 3) } },
          { joinConversation: { initiatingUserId: X_ESME.id, participantsSnapshot: [S, X_ESME.id, X_ADA.id], createdAt: at(6) } },
        ],
      },
    },
    {
      dmConversation: {
        conversationId: "5002",
        messages: [
          message("9401", X_CROWD[0], at(8), { text: "Big group hello" }),
          { joinConversation: { initiatingUserId: X_CROWD[0], participantsSnapshot: [S, ...X_CROWD], createdAt: at(8) } },
        ],
      },
    },
  ];
}

export function tweets() {
  return [
    {
      tweet: {
        id_str: "8001", full_text: "Great day with @ada_sample",
        entities: { user_mentions: [{ name: "Ada Sample", screen_name: X_ADA.username, indices: ["15", "26"], id_str: X_ADA.id, id: X_ADA.id }] },
      },
    },
    { tweet: { id_str: "8002", full_text: "@bruno_p agreed", in_reply_to_user_id_str: X_BRUNO.id, in_reply_to_screen_name: X_BRUNO.username, entities: { user_mentions: [] } } },
    {
      tweet: {
        id_str: "8004", full_text: "Thanks all",
        entities: {
          user_mentions: [
            { name: X_DEV.name, screen_name: X_DEV.username, id_str: X_DEV.id, id: X_DEV.id },
            ...X_CROWD.map((id, n) => ({ name: `Crowd Member ${n + 1}`, screen_name: `crowd_${n + 1}`, id_str: id, id })),
          ],
        },
      },
    },
    // Someone mentioned who is not in any chat: not an account.
    { tweet: { id_str: "8003", full_text: "hi @stranger", entities: { user_mentions: [{ name: "Stranger", screen_name: "stranger", id_str: "999", id: "999" }] } } },
  ];
}

/** Every file of the archive, by its path in the zip. `split` writes the one-to-one chats as two parts. */
export function xArchiveFiles({ split = false } = {}): ZipInput {
  const direct = directChats();
  const account = [{ account: { email: "captain@example.com", username: X_SELF.username, accountId: X_SELF.id, createdAt: at(1), accountDisplayName: X_SELF.name } }];
  const manifest = `window.__THAR_CONFIG = ${JSON.stringify({ userInfo: { accountId: X_SELF.id }, archiveInfo: { generationDate: new Date(Date.UTC(2025, 1, 1)).toISOString() } })}`;
  return [
    { name: "Your archive.html", data: "<html></html>" },
    { name: "data/manifest.js", data: manifest },
    { name: "data/account.js", data: ytd("account", account) },
    { name: "data/profile.js", data: ytd("profile", [{ profile: { description: { bio: "", website: "", location: "" } } }]) },
    ...(split
      ? [
          { name: "data/direct-messages.js", data: ytd("direct_messages", direct.slice(0, 1)) },
          { name: "data/direct-messages-part1.js", data: ytd("direct_messages", direct.slice(1), 1) },
        ]
      : [{ name: "data/direct-messages.js", data: ytd("direct_messages", direct) }]),
    { name: "data/direct-message-headers.js", data: ytd("direct_message_headers", []) },
    { name: "data/direct-messages-group.js", data: ytd("direct_messages_group", groupChats()) },
    { name: "data/tweets.js", data: ytd("tweets", tweets()) },
    { name: "data/follower.js", data: ytd("follower", [{ follower: { accountId: X_CLEO.id, userLink: `https://twitter.com/intent/user?user_id=${X_CLEO.id}` } }]) },
    { name: "data/following.js", data: ytd("following", [{ following: { accountId: "777", userLink: "https://twitter.com/intent/user?user_id=777" } }]) },
    { name: "data/message-event.js", data: ytd("message_event", [
      { messageEvent: { conversationId: "100:201", messageId: "1", senderId: X_SELF.id, detail: { messageCreateEvent: { contents: "c2VhbGVk" } } } },
      { messageEvent: { conversationId: "100:201", messageId: "2", senderId: X_SELF.id, detail: { markConversationReadEvent: {} } } },
    ]) },
    { name: "data/direct_messages_media/9006-photo1.jpg", data: PHOTO },
    { name: "data/direct_messages_group_media/9303-party.mp4", data: GROUP_GIF },
    { name: "data/tweets_media/8001-tweet.jpg", data: "a tweet's photo, never read" },
  ];
}

export async function writeXArchiveZip(path: string, options?: { split?: boolean }): Promise<void> {
  await writeZip(path, xArchiveFiles(options));
}

/** The archive as the folder it unzips to. */
export async function writeXArchiveFolder(folder: string): Promise<void> {
  for (const file of xArchiveFiles()) {
    await mkdir(dirname(join(folder, file.name)), { recursive: true });
    await writeFile(join(folder, file.name), file.data);
  }
}
