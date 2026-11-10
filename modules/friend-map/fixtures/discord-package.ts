// A made-up Discord data package ("Request your data", Messages section, and
// Account when asked for) in the real format (see
// connectors/discord-package/read.ts), for the discord-package tests. Every
// id, name and line is invented. Written by the tests, never committed.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeZip, type ZipInput } from "../../../sdk/server.ts";

const DISCORD_EPOCH = 1420070400000n;

/** A Discord id (snowflake) for this moment: milliseconds since Discord's epoch in the top bits, `n` in the low ones. */
export function snowflake(at: number, n = 0): string {
  return String(((BigInt(at) - DISCORD_EPOCH) << 22n) | BigInt(n));
}

/** 10:00 UTC on a day of January 2025, plus minutes. */
export const discordAt = (day: number, minute = 0) => Date.UTC(2025, 0, day, 10, minute);
const userId = (n: number) => snowflake(Date.UTC(2017, 0, 1), n);

export const DISCORD_SELF = { id: userId(1), username: "sample.captain", globalName: "Sample Captain" };
/** DMed; named by their global name only with the Account section, else by their username. */
export const DISCORD_ADA = { id: userId(2), username: "ada.sample", globalName: "Ada Sample" };
/** DMed; the captain's nickname for them, with the Account section. */
export const DISCORD_BRUNO = { id: userId(3), username: "brunop", nickname: "Bruno P" };
/** A deleted account: Discord writes "Deleted User" for its id, and labels the DM "Unknown Participant". */
export const DISCORD_CLEO = { id: "Deleted User" };
/** In the small group DM only; named only with the Account section. */
export const DISCORD_DEV = { id: userId(5), username: "dev_t", globalName: "Dev Testington" };
/** In the small group DM only, and named by nothing. */
export const DISCORD_ESME = { id: userId(6) };
/** Thirteen others in the big group DM, so it is fourteen people with the captain; friends with global names in the Account section. */
export const DISCORD_CROWD = Array.from({ length: 13 }, (_, i) => ({ id: userId(100 + i), username: `crowd${i + 1}`, globalName: `Crowd Member ${i + 1}` }));

export const CHANNELS = {
  ada: snowflake(discordAt(1), 1),
  bruno: snowflake(discordAt(1), 2),
  cleo: snowflake(discordAt(1), 3),
  smallGroup: snowflake(discordAt(1), 4),
  bigGroup: snowflake(discordAt(1), 5),
  general: snowflake(discordAt(1), 6),
  unknownChannel: snowflake(discordAt(1), 7),
  /** Only in the newer package. */
  newerDm: snowflake(discordAt(1), 8),
};
export const GUILD = { id: snowflake(discordAt(1), 9), name: "Sample Server" };

export const PHOTO = Buffer.from("made-up photo bytes");
const PHOTO_ID = snowflake(discordAt(2), 50);
const LOST_ID = snowflake(discordAt(2), 51);
export const ATTACHMENTS = {
  photo: { id: PHOTO_ID, filename: "photo.png", url: `https://cdn.discordapp.com/attachments/${CHANNELS.ada}/${PHOTO_ID}/photo.png?ex=1&is=2&hm=3` },
  lost: { id: LOST_ID, filename: "notes from trip.pdf", url: `https://cdn.discordapp.com/attachments/${CHANNELS.general}/${LOST_ID}/notes%20from%20trip.pdf?ex=1` },
};

/** The messages in the package, by id, each with when it was sent. */
export const MESSAGES = {
  adaText: snowflake(discordAt(2), 1),
  adaLink: snowflake(discordAt(2, 5), 2),
  adaPhoto: snowflake(discordAt(2, 10), 3),
  adaCall: snowflake(discordAt(2, 15), 4),
  bruno: snowflake(discordAt(3), 5),
  cleo: snowflake(discordAt(4), 6),
  smallGroup: snowflake(discordAt(5), 7),
  bigGroup: snowflake(discordAt(6), 8),
  general1: snowflake(discordAt(7), 9),
  general2: snowflake(discordAt(7, 1), 10),
  unknownChannel: snowflake(discordAt(8), 11),
  /** Only in the newer package. */
  adaNewer: snowflake(discordAt(20), 12),
  newerDm: snowflake(discordAt(21), 13),
};

export const DISCORD_SAMPLE = {
  directChats: 3,
  groupChats: 4,
  messages: 11,
  /** One stored, one missing. */
  attachments: 2,
};

interface Message {
  id: string;
  contents?: string;
  attachments?: string[];
}

/** Discord's "2025-01-02 10:00:00", in UTC. */
function timestamp(id: string): string {
  const at = Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  return new Date(at).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** messages.json as Discord writes it: newest first, each ID a bare number too big for a double. */
function messagesJson(messages: Message[]): string {
  const records = [...messages].reverse().map((m) => ({
    ID: `@@${m.id}@@`, Timestamp: timestamp(m.id), Contents: m.contents ?? "", Attachments: (m.attachments ?? []).join(" "),
  }));
  return JSON.stringify(records).replace(/"@@(\d+)@@"/g, "$1");
}

export function discordPackageFiles(options: { account?: boolean; newer?: boolean } = {}): ZipInput {
  const S = DISCORD_SELF.id;
  const channel = (id: string, about: Record<string, unknown>, messages: Message[], extra: ZipInput = []): ZipInput => [
    { name: `Messages/c${id}/channel.json`, data: JSON.stringify({ id, ...about }) },
    { name: `Messages/c${id}/messages.json`, data: messagesJson(messages) },
    ...extra,
  ];
  const index: Record<string, string | null> = {
    [CHANNELS.ada]: `Direct Message with ${DISCORD_ADA.username}`,
    [CHANNELS.bruno]: `Direct Message with ${DISCORD_BRUNO.username}`,
    [CHANNELS.cleo]: "Direct Message with Unknown Participant",
    [CHANNELS.smallGroup]: "Climbing crew",
    [CHANNELS.bigGroup]: null,
    [CHANNELS.general]: `general, ${GUILD.name}`,
    [CHANNELS.unknownChannel]: "Unknown channel, Other Server",
    ...(options.newer ? { [CHANNELS.newerDm]: `Direct Message with ${DISCORD_DEV.username}` } : {}),
  };
  const files: ZipInput = [
    { name: "README.txt", data: "Welcome to your Discord Data Package! (made up)\n" },
    { name: "Messages/index.json", data: JSON.stringify(index) },
    ...channel(CHANNELS.ada, { type: "DM", recipients: [S, DISCORD_ADA.id] }, [
      { id: MESSAGES.adaText, contents: "Climbing on Saturday?" },
      { id: MESSAGES.adaLink, contents: "This crag https://example.com/crag" },
      { id: MESSAGES.adaPhoto, attachments: [ATTACHMENTS.photo.url] },
      { id: MESSAGES.adaCall },
      ...(options.newer ? [{ id: MESSAGES.adaNewer, contents: "Back from the trip" }] : []),
    ], [{ name: `Messages/c${CHANNELS.ada}/${PHOTO_ID}/photo.png`, data: PHOTO }]),
    // An older package writes channel types as numbers.
    ...channel(CHANNELS.bruno, { type: 1, recipients: [DISCORD_BRUNO.id, S] }, [{ id: MESSAGES.bruno, contents: "Thanks for the lift" }]),
    ...channel(CHANNELS.cleo, { type: "DM", recipients: [S, DISCORD_CLEO.id] }, [{ id: MESSAGES.cleo, contents: "Hello?" }]),
    ...channel(CHANNELS.smallGroup, { type: "GROUP_DM", name: "Climbing crew", recipients: [S, DISCORD_ADA.id, DISCORD_DEV.id, DISCORD_ESME.id] }, [
      { id: MESSAGES.smallGroup, contents: "Who has the rope?" },
    ]),
    ...channel(CHANNELS.bigGroup, { type: "GROUP_DM", name: null, recipients: [S, ...DISCORD_CROWD.map((c) => c.id)] }, [
      { id: MESSAGES.bigGroup, contents: "Count me in" },
    ]),
    ...channel(CHANNELS.general, { type: "GUILD_TEXT", name: "general", guild: GUILD }, [
      { id: MESSAGES.general1, contents: "First post" },
      { id: MESSAGES.general2, contents: "Trip notes", attachments: [ATTACHMENTS.lost.url] },
    ]),
    // A channel Discord no longer knows: only its id and type.
    ...channel(CHANNELS.unknownChannel, { type: "GUILD_TEXT" }, [{ id: MESSAGES.unknownChannel, contents: "gm" }]),
    ...(options.newer
      ? channel(CHANNELS.newerDm, { type: "DM", recipients: [S, DISCORD_DEV.id] }, [{ id: MESSAGES.newerDm, contents: "Nice to meet you" }])
      : []),
  ];
  if (options.account) {
    files.push({
      name: "Account/user.json",
      data: JSON.stringify({
        id: S, username: DISCORD_SELF.username, discriminator: "0", global_name: DISCORD_SELF.globalName,
        relationships: [
          { id: DISCORD_ADA.id, type: 1, nickname: null, user: { id: DISCORD_ADA.id, username: DISCORD_ADA.username, global_name: DISCORD_ADA.globalName, discriminator: "0" } },
          { id: DISCORD_BRUNO.id, type: 1, nickname: DISCORD_BRUNO.nickname, user: { id: DISCORD_BRUNO.id, username: DISCORD_BRUNO.username, global_name: null, discriminator: "0" } },
          { id: DISCORD_DEV.id, type: 1, nickname: null, user: { id: DISCORD_DEV.id, username: DISCORD_DEV.username, global_name: DISCORD_DEV.globalName, discriminator: "0" } },
          ...DISCORD_CROWD.map((c) => ({ id: c.id, type: 1, nickname: null, user: { id: c.id, username: c.username, global_name: c.globalName, discriminator: "0" } })),
        ],
      }),
    });
  }
  return files;
}

export async function writeDiscordPackageZip(path: string, options: { account?: boolean; newer?: boolean } = {}): Promise<void> {
  await writeZip(path, discordPackageFiles(options));
}

/** The package unzipped into `folder`. */
export async function writeDiscordPackageFolder(folder: string, options: { account?: boolean; newer?: boolean } = {}): Promise<void> {
  for (const file of discordPackageFiles(options)) {
    await mkdir(dirname(join(folder, file.name)), { recursive: true });
    await writeFile(join(folder, file.name), file.data);
  }
}
