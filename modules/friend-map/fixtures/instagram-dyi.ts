// A small, entirely made-up Instagram "Download your information" messages
// export in the real JSON format (Meta's, as Facebook's; see
// connectors/metaDyi.ts), for tests, written on demand as the folder
// the zip unpacks to, or as the zip. Not committed.
//
// It has what the real download has that matters: inbox chats and message
// requests, reported_conversations.json, a chat split over message_1.json and
// message_2.json, strings escaped the way Meta escapes them, photos, videos
// and voice messages (.aac and .mp4) kept in the export, one the export lacks
// and one only linked, a share, reactions, an unsent message, a call, an
// "Instagram User" (a deleted account), a two-person group with an invite
// link (joinable_mode), a small group the captain wrote in, a big one he never
// wrote in, a request he never answered and one he did, and a name that is an
// Instagram username. The media bytes are placeholders, not images.
//
// The captain is the phone export's (fixtures/messenger.ts), and Ada Sample is
// in Messenger's samples too, so a test can join her across platforms.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeZip } from "../../../sdk/server.ts";
import { facebookJson, rec } from "./facebook-dyi.ts";
import { SELF } from "./messenger.ts";

const at = (iso: string) => Date.parse(iso);
const ROOT = "your_instagram_activity/messages";
const ADA = `${ROOT}/inbox/adasample_17840000000000001`;
const CLEO = `${ROOT}/inbox/cleoexample_17840000000000002`;

export const IG = {
  ada: "Ada Sample",
  cleo: "Cléo Example",
  /** A username, which Instagram gives as the name of someone with no full name. */
  username: "dev.testington",
  crew: ["Esme Fictional", "Gus Placeholder"],
  /** Fourteen people in a group the captain never wrote in, more than SMALL_GROUP_MAX. */
  crowd: Array.from({ length: 14 }, (_, i) => `Crowd Member ${i + 1}`),
  stranger: "Hal Stranger",
  answered: "Ivy Answered",
};

const CROWD_GROUP = [SELF, ...IG.crowd];

function files(): Array<{ name: string; data: string | Buffer }> {
  const chat = (folder: string, participants: string[], title: string, messages: ReturnType<typeof rec>[], extra: Record<string, unknown> = {}, part = 1) => ({
    name: `${folder}/message_${part}.json`,
    data: facebookJson({
      participants: participants.map((name) => ({ name })),
      // Meta lists messages newest first.
      messages: [...messages].sort((a, b) => b.timestamp_ms - a.timestamp_ms),
      title,
      is_still_participant: true,
      thread_path: folder.replace(`${ROOT}/`, ""),
      magic_words: [],
      ...extra,
    }),
  });
  return [
    // Ada's chat, over two files: text with a reaction, a photo, a voice message, a share, an unsent message and a call.
    chat(ADA, [IG.ada, SELF], IG.ada, [
      rec(IG.ada, at("2021-03-01T10:00:00+11:00"), "Saw your story 🎉", { reactions: [{ reaction: "❤", actor: SELF, timestamp: at("2021-03-01T10:01:00+11:00") / 1000 }] }),
      rec(SELF, at("2021-03-01T10:05:00+11:00"), undefined, { photos: [{ uri: `${ADA}/photos/1001.jpg`, creation_timestamp: 1 }] }),
      rec(IG.ada, at("2021-03-01T10:06:00+11:00"), undefined, { audio_files: [{ uri: `${ADA}/audio/1002.aac`, creation_timestamp: 1 }] }),
    ]),
    chat(ADA, [IG.ada, SELF], IG.ada, [
      rec(SELF, at("2021-03-02T09:00:00+11:00"), "Ada sent an attachment.", { share: { link: "https://www.instagram.com/reel/example/", share_text: "a reel" } }),
      rec(IG.ada, at("2021-03-02T09:05:00+11:00"), undefined, { is_unsent: true }),
      rec(IG.ada, at("2021-03-02T20:00:00+11:00"), "Ada started a video chat", { call_duration: 60 }),
    ], {}, 2),
    // Cléo: a video kept, a photo the export lacks, and one only linked.
    chat(CLEO, [IG.cleo, SELF], IG.cleo, [
      rec(IG.cleo, at("2022-07-01T12:00:00+10:00"), "Ça va?"),
      rec(SELF, at("2022-07-01T12:01:00+10:00"), undefined, { videos: [{ uri: `${CLEO}/videos/2001.mp4`, creation_timestamp: 1 }] }),
      rec(IG.cleo, at("2022-07-01T12:02:00+10:00"), undefined, { photos: [{ uri: `${CLEO}/photos/2002.jpg` }, { uri: "https://scontent.cdninstagram.com/2003.jpg" }] }),
    ]),
    // A username for a name, both writing.
    chat(`${ROOT}/inbox/devtestington_17840000000000003`, [IG.username, SELF], IG.username, [
      rec(IG.username, at("2023-01-01T10:00:00+11:00"), "gm"),
      rec(SELF, at("2023-01-01T10:01:00+11:00"), "gm!"),
    ]),
    // A deleted account.
    chat(`${ROOT}/inbox/instagramuser_17840000000000004`, ["Instagram User", SELF], "Instagram User", [
      rec("Instagram User", at("2020-01-01T10:00:00+11:00"), "hello"),
      rec(SELF, at("2020-01-01T10:01:00+11:00"), "hi"),
    ]),
    // A group of two (Esme left) with an invite link and a name of its own; the captain wrote in it.
    chat(`${ROOT}/inbox/climbing_17840000000000005`, [IG.crew[0], SELF], "Climbing", [
      rec(IG.crew[0], at("2023-05-01T10:00:00+10:00"), "Sunday?"),
      rec(SELF, at("2023-05-01T10:05:00+10:00"), "Yes"),
    ], { joinable_mode: { mode: 1, link: "" } }),
    // A small group the captain wrote in, where Gus never did.
    chat(`${ROOT}/inbox/crew_17840000000000006`, [IG.crew[0], IG.crew[1], SELF], "Crew", [
      rec(IG.crew[0], at("2023-06-01T10:00:00+10:00"), "Dinner?"),
      rec(SELF, at("2023-06-01T10:01:00+10:00"), "In"),
    ], { joinable_mode: { mode: 1, link: "" } }),
    // A big group the captain never wrote in.
    chat(`${ROOT}/inbox/giveaway_17840000000000007`, CROWD_GROUP, "Giveaway", [
      rec(IG.crowd[0], at("2024-02-01T10:00:00+11:00"), "Welcome!"),
    ], { joinable_mode: { mode: 1, link: "" } }),
    // Message requests: one never answered, one answered.
    chat(`${ROOT}/message_requests/halstranger_17840000000000008`, [IG.stranger, SELF], IG.stranger, [
      rec(IG.stranger, at("2024-03-01T10:00:00+11:00"), "Hey, collab?"),
    ], { is_pending: true }),
    chat(`${ROOT}/message_requests/ivyanswered_17840000000000009`, [IG.answered, SELF], IG.answered, [
      rec(IG.answered, at("2024-04-01T10:00:00+11:00"), "Are you Riley from the climbing gym?"),
      rec(SELF, at("2024-04-01T11:00:00+11:00"), "That's me"),
    ], { is_pending: true }),
    { name: `${ROOT}/reported_conversations.json`, data: facebookJson({ reported_conversations: [] }) },
    { name: `${ADA}/photos/1001.jpg`, data: Buffer.from("placeholder photo") },
    { name: `${ADA}/audio/1002.aac`, data: Buffer.from("placeholder voice") },
    { name: `${CLEO}/videos/2001.mp4`, data: Buffer.from("placeholder video") },
  ];
}

export const IG_SAMPLE = {
  chats: 9,
  messages: 21,
  /** Attachments: three kept in the export, one missing, one only linked. */
  attachments: 5,
  kept: 3,
};

/** Writes the export as the zip unpacks it, into `folder`; returns its files' paths inside the export. */
export async function writeInstagramExport(folder: string): Promise<string[]> {
  const all = files();
  for (const { name, data } of all) {
    await mkdir(dirname(join(folder, name)), { recursive: true });
    await writeFile(join(folder, name), data);
  }
  return all.map((file) => file.name);
}

/** Writes the export as the zip Instagram sends. */
export async function writeInstagramZip(path: string): Promise<void> {
  await writeZip(path, files());
}
