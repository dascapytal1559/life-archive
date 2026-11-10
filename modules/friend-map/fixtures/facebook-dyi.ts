// A small, entirely made-up Facebook "Download your information" messages
// export in the real JSON format (see connectors/facebook-dyi/read.ts), for
// tests. It is written as zip parts on demand, not committed.
//
// It has what the real download has that matters: several parts, a chat split
// over message_1.json and message_2.json in different parts, a zip stored
// inside a part (and an empty one), files repeated in every part, every
// message folder (inbox, e2ee_cutover, archived_threads, filtered_threads,
// message_requests), a chat file directly in its message folder, a JSON file
// someone sent (not a chat), strings escaped the way Facebook escapes them
// (UTF-8 bytes as Latin-1 characters), photos, videos, voice messages (.mp4),
// GIFs, files and stickers, media the export lacks, an exact duplicate record,
// two records from one sender in one millisecond, an unsent message, a call, a
// share, reactions with times in seconds, two different "Facebook user" chats,
// a group with only two people left, someone who left a group, and a
// Marketplace chat. The media
// bytes are placeholders, not images.
//
// The same people as the phone export's sample (fixtures/messenger.ts), so the
// two exports share accounts. `overlappingExports()` builds a pair of exports,
// one in each format, that share some messages, to prove the archive keeps
// each message once.

import { join } from "node:path";
import { writeZip, zipBytes, type ZipInput } from "../../../sdk/server.ts";
import { SELF } from "./messenger.ts";

type Media = { uri: string; creation_timestamp?: number };
export type DyiRecord = {
  sender_name: string;
  timestamp_ms: number;
  content?: string;
  photos?: Media[];
  videos?: Media[];
  audio_files?: Media[];
  gifs?: Media[];
  files?: Media[];
  sticker?: { uri: string; ai_stickers: unknown[] };
  share?: { link: string; share_text?: string };
  reactions?: Array<{ reaction: string; actor: string; timestamp?: number }>;
  call_duration?: number;
  is_unsent?: boolean;
  is_geoblocked_for_viewer: boolean;
  is_unsent_image_by_messenger_kid_parent: boolean;
};

const at = (iso: string) => Date.parse(iso);
const ROOT = "your_facebook_activity/messages";

export function rec(sender: string, timestamp: number, content: string | undefined, extra: Partial<DyiRecord> = {}): DyiRecord {
  return {
    sender_name: sender,
    timestamp_ms: timestamp,
    ...(content === undefined ? {} : { content }),
    ...extra,
    is_geoblocked_for_viewer: false,
    is_unsent_image_by_messenger_kid_parent: false,
  };
}

export function threadFile(participants: string[], title: string, threadPath: string, messages: DyiRecord[]): string {
  return facebookJson({
    participants: participants.map((name) => ({ name })),
    // Facebook lists messages newest first.
    messages: [...messages].sort((a, b) => b.timestamp_ms - a.timestamp_ms),
    title,
    is_still_participant: true,
    thread_path: threadPath,
    magic_words: [],
  });
}

/** JSON as Facebook writes it: every non-ASCII character as its UTF-8 bytes, each escaped as \u00XX. */
export function facebookJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[^\x00-\x7f]/gu, (char) =>
    [...Buffer.from(char, "utf8")].map((byte) => `\\u00${byte.toString(16).padStart(2, "0")}`).join(""),
  );
}

const ADA = `${ROOT}/inbox/adasample_1000000000000001`;
const CLEO = `${ROOT}/e2ee_cutover/cleoexample_1000000000000002`;
const FLAT = `${ROOT}/archived_threads/oldflat_1000000000000003`;
const CREW = `${ROOT}/inbox/climbingcrew_1000000000000006`;

const duplicate = rec("Ada Sample", at("2019-05-02T09:00:00+10:00"), "Coffee on Saturday?");
const welcome = rec("Ada Sample", at("2019-05-01T18:00:00+10:00"), "Welcome to Melbourne! 🎉", {
  reactions: [{ reaction: "❤", actor: SELF, timestamp: at("2019-05-01T18:01:00+10:00") / 1000 }],
});

/** Ada's chat, split over two files in two parts. */
const ADA_1 = [
  welcome,
  rec(SELF, at("2019-05-01T18:05:00+10:00"), undefined, {
    photos: [{ uri: `${ADA}/photos/111.jpg` }, { uri: `${ADA}/photos/112.jpg` }],
  }),
  duplicate,
  rec("Ada Sample", at("2019-05-02T09:10:00+10:00"), "Bring your shoes."),
  rec("Ada Sample", at("2019-05-02T09:10:00+10:00"), "And chalk."),
  rec(SELF, at("2019-05-03T12:00:00+10:00"), "https://example.com/crag", { share: { link: "https://example.com/crag" } }),
];
const ADA_2 = [
  { ...duplicate },
  rec("Ada Sample", at("2019-05-04T08:00:00+10:00"), undefined, { is_unsent: true }),
  rec("Ada Sample", at("2019-05-04T20:00:00+10:00"), "Ada called you.", { call_duration: 120 }),
  rec(SELF, at("2019-05-04T20:30:00+10:00"), undefined, { sticker: { uri: `${ROOT}/stickers_used/369239263222822.png`, ai_stickers: [] } }),
  rec("Ada Sample", at("2019-05-05T07:00:00+10:00"), undefined, { audio_files: [{ uri: `${ADA}/audio/voice_113.mp4` }] }),
  rec(SELF, at("2019-05-05T07:10:00+10:00"), undefined, { files: [{ uri: `${ADA}/files/notes.json` }] }),
];

const CLEO_MESSAGES = [
  rec("Cléo Example", at("2023-06-01T10:00:00+10:00"), "Ça va? Les billets sont arrivés 🎟️"),
  rec(SELF, at("2023-06-01T10:05:00+10:00"), undefined, { gifs: [{ uri: `${CLEO}/gifs/114.gif` }] }),
  rec(SELF, at("2023-06-01T10:06:00+10:00"), undefined, { videos: [{ uri: `${CLEO}/videos/115.mp4` }] }),
];

const FLAT_MESSAGES = [
  rec("Esme Fictional", at("2016-12-24T17:00:00+11:00"), "Merry Christmas, old flat!"),
  rec("Dev Testington", at("2016-12-24T17:02:00+11:00"), "Same to you both."),
  rec("Former Flatmate", at("2016-12-24T17:03:00+11:00"), "Miss you all."),
];

const CREW_MESSAGES = [
  rec("Gus Unlisted", at("2021-03-01T09:00:00+11:00"), "Topo for Sunday", { files: [{ uri: `${CREW}/files/116.pdf` }] }),
  rec(SELF, at("2021-03-01T09:05:00+11:00"), "Thanks!"),
];

/** Every file of the export, by part. Media bytes are placeholders. */
export function dyiParts(): Array<{ part: string; files: ZipInput }> {
  const settings = { name: `${ROOT}/messaging_settings.json`, data: facebookJson({ label_values: [] }) };
  const repeated = { name: `${ROOT}/photos/200.jpg`, data: "placeholder bytes: group photo" };
  return [
    {
      part: "facebook-rileyself-2026-09-28-aaaa1111.zip",
      files: [
        settings,
        repeated,
        { name: `${ADA}/message_1.json`, data: threadFile(["Ada Sample", SELF], "Ada Sample", "inbox/adasample_1000000000000001", ADA_1) },
        { name: `${ADA}/photos/111.jpg`, data: "placeholder bytes: not an image (111)" },
        { name: `${ROOT}/stickers_used/369239263222822.png`, data: "placeholder bytes: sticker" },
      ],
    },
    {
      part: "facebook-rileyself-2026-09-28-bbbb2222.zip",
      files: [
        settings,
        repeated,
        { name: `${ADA}/message_2.json`, data: threadFile(["Ada Sample", SELF], "Ada Sample", "inbox/adasample_1000000000000001", ADA_2) },
        { name: `${ADA}/audio/voice_113.mp4`, data: "placeholder bytes: not audio (113)" },
        { name: `${ADA}/files/notes.json`, data: facebookJson({ not: "a chat" }) },
        // 112.jpg is referenced but in no part.
        { name: `${CLEO}/message_1.json`, data: threadFile(["Cléo Example", SELF], "Cléo Example", "e2ee_cutover/cleoexample_1000000000000002", CLEO_MESSAGES) },
        { name: `${CLEO}/gifs/114.gif`, data: "placeholder bytes: not a gif (114)" },
        { name: `${CLEO}/videos/115.mp4`, data: "placeholder bytes: not a video (115)" },
        {
          name: `${FLAT}/message_1.json`,
          data: threadFile([SELF, "Dev Testington", "Esme Fictional"], "Old flat", "archived_threads/oldflat_1000000000000003", FLAT_MESSAGES),
        },
      ],
    },
    {
      part: "facebook-rileyself-2026-09-28-cccc3333.zip",
      files: [
        settings,
        repeated,
        {
          name: `${ROOT}/filtered_threads/facebookuser_1000000000000004/message_1.json`,
          data: threadFile(["Facebook user", SELF], "Facebook user", "filtered_threads/facebookuser_1000000000000004", [
            rec("Facebook user", at("2018-02-01T10:00:00+11:00"), "Is the bike still for sale?"),
          ]),
        },
        // A Marketplace chat: two people, titled "<first name> · <item>".
        {
          name: `${ROOT}/inbox/norasellerroadbike_1000000000000008/message_1.json`,
          data: threadFile(["Nora Seller", SELF], "Nora · Road bike, 54 cm", "inbox/norasellerroadbike_1000000000000008", [
            rec(SELF, at("2022-08-01T09:00:00+10:00"), "Is this still available?"),
            rec("Nora Seller", at("2022-08-01T09:30:00+10:00"), "Yes, come by Saturday."),
          ]),
        },
        {
          name: `${ROOT}/message_requests/facebookuser_1000000000000005/message_1.json`,
          data: threadFile(["Facebook user", SELF], "Facebook user", "message_requests/facebookuser_1000000000000005", [
            rec("Facebook user", at("2022-07-07T19:00:00+10:00"), "Hello from the market"),
          ]),
        },
        // A chat file directly in its message folder; its thread_path names its chat.
        {
          name: `${ROOT}/inbox/hananewface_1000000000000007_2.json`,
          data: threadFile(["Hana Newface", SELF], "Hana Newface", "inbox/hananewface_1000000000000007", [
            rec("Hana Newface", at("2024-01-10T09:00:00+11:00"), "Great to meet you!"),
          ]),
        },
        { name: "facebook_100000000000001.zip", data: "", stored: true },
        // More of the export in a zip stored inside this part.
        {
          name: "facebook_100000000000002.zip",
          stored: true,
          data: zipBytes([
            {
              name: `${CREW}/message_1.json`,
              data: threadFile([SELF, "Gus Unlisted"], "Climbing crew", "inbox/climbingcrew_1000000000000006", CREW_MESSAGES),
            },
            { name: `${CREW}/files/116.pdf`, data: "placeholder bytes: not a pdf (116)" },
          ]),
        },
      ],
    },
  ];
}

/** Writes the sample export's parts into `dir` and returns their paths. */
export async function writeDyiParts(dir: string): Promise<string[]> {
  const paths = [];
  for (const { part, files } of dyiParts()) {
    await writeZip(join(dir, part), files);
    paths.push(join(dir, part));
  }
  return paths;
}

/** What the sample holds, for tests. */
export const DYI_SAMPLE = {
  chats: 8,
  /** Records in chat files, the duplicate counted twice. */
  records: ADA_1.length + ADA_2.length + CLEO_MESSAGES.length + FLAT_MESSAGES.length + CREW_MESSAGES.length + 5,
};

/**
 * A pair of exports of the same chats, one from the phone app (messenger-export's
 * format) and one from "Download your information", sharing some messages:
 *
 *   shared by both   a text; a burst of two photos (two records in the phone
 *                    export, one message with two photos in the other); a link
 *                    each export words differently; a text with the same
 *                    reaction in both; a "Facebook user" message; a group message
 *   phone only       the newest message
 *   download only    an older message; one a millisecond after a shared one; one
 *                    from the captain in the same millisecond as a shared one
 *
 * `later` is a newer download: the shared text again, and one new message.
 */
export function overlappingExports(): { phone: ZipInput; dyi: ZipInput; later: ZipInput; shared: number } {
  const t = (minute: number) => at("2025-02-01T10:00:00+11:00") + minute * 60_000;
  const phoneMsg = (senderName: string, timestamp: number, text: string, extra: Record<string, unknown> = {}) =>
    ({ senderName, timestamp, type: "text", text, isUnsent: false, media: [], reactions: [], ...extra });
  const phoneChat = (file: string, participants: string[], threadName: string, messages: unknown[]) =>
    ({ name: file, data: JSON.stringify({ participants, threadName, messages }, null, 2) });
  const crew = [SELF, "Gus Unlisted", "Cleo Example"];
  const phone: ZipInput = [
    phoneChat("Ada Sample_1.json", [SELF, "Ada Sample"], "Ada Sample_1", [
      phoneMsg("Ada Sample", t(1), "See you at the crag"),
      phoneMsg(SELF, t(2), "", { type: "media", media: [{ uri: "./messages_photos/burst_a.jpeg" }] }),
      phoneMsg(SELF, t(2), "", { type: "media", media: [{ uri: "./messages_photos/burst_b.jpeg" }] }),
      phoneMsg(SELF, t(3), "https://example.com/topo", { type: "link" }),
      phoneMsg("Ada Sample", t(4), "Rope's in my car", { reactions: [{ actor: SELF, reaction: "👍" }] }),
      phoneMsg("Ada Sample", t(9), "Dinner after?"),
    ]),
    phoneChat("Facebook user_2.json", [SELF, "Facebook user"], "Facebook user_2", [phoneMsg("Facebook user", t(6), "Is it still available?")]),
    phoneChat("Climbing crew_3.json", crew, "Climbing crew_3", [phoneMsg("Gus Unlisted", t(7), "Gym tonight?")]),
    { name: "media/photos_1/burst_a.jpeg", data: "placeholder bytes: burst a (phone)" },
    { name: "media/photos_1/burst_b.jpeg", data: "placeholder bytes: burst b (phone)" },
  ];
  const ada = `${ROOT}/inbox/adasample_2000000000000001`;
  const adaChat = (messages: DyiRecord[]) =>
    ({ name: `${ada}/message_1.json`, data: threadFile(["Ada Sample", SELF], "Ada Sample", "inbox/adasample_2000000000000001", messages) });
  const dyi: ZipInput = [
    adaChat([
      rec("Ada Sample", t(-60 * 24 * 30), "Long time no see"),
      rec("Ada Sample", t(1), "See you at the crag"),
      rec("Ada Sample", t(1) + 1, "Bring chalk"),
      rec(SELF, t(1), "On my way"),
      rec(SELF, t(2), undefined, { photos: [{ uri: `${ada}/photos/301.jpg` }, { uri: `${ada}/photos/302.jpg` }] }),
      rec(SELF, t(3), "Riley sent a link.", { share: { link: "https://example.com/topo" } }),
      rec("Ada Sample", t(4), "Rope's in my car", { reactions: [{ reaction: "👍", actor: SELF, timestamp: t(5) / 1000 }] }),
    ]),
    { name: `${ada}/photos/301.jpg`, data: "placeholder bytes: burst a (download)" },
    { name: `${ada}/photos/302.jpg`, data: "placeholder bytes: burst b (download)" },
    {
      name: `${ROOT}/inbox/facebookuser_2000000000000002/message_1.json`,
      data: threadFile(["Facebook user", SELF], "Facebook user", "inbox/facebookuser_2000000000000002", [
        rec("Facebook user", t(6), "Is it still available?"),
      ]),
    },
    {
      name: `${ROOT}/inbox/climbingcrew_2000000000000003/message_1.json`,
      data: threadFile(crew, "Climbing crew", "inbox/climbingcrew_2000000000000003", [rec("Gus Unlisted", t(7), "Gym tonight?")]),
    },
  ];
  const later: ZipInput = [adaChat([rec("Ada Sample", t(1), "See you at the crag"), rec("Ada Sample", t(60 * 24), "Same time next week?")])];
  return { phone, dyi, later, shared: 6 };
}
