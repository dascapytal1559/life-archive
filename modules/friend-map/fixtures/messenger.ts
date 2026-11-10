// A small, entirely made-up Messenger end-to-end-encrypted export in the real
// format (see connectors/messenger-export/read.ts), for tests and the testing data
// folder. `npm run make-fixtures` writes it to data/messenger/messages.zip.
//
// It has what the real export has that matters: names only, each chat's place
// in the export in its file name and threadName ("Ada Sample_1"), an exact duplicate
// record, two records from one sender in the same millisecond, unsent
// placeholders, photos sent in one millisecond as separate records, media the
// zip has and media it lacks (in folders that don't match the uris), reactions,
// four different "Facebook user" chats (two of them empty), groups,
// and name variants of one person ("Bruno P" / "Bruno Placeholder",
// "Cléo Example" / "Cleo Example"). The media bytes are placeholders, not images.

export const SELF = "Riley Self";

/** A Melbourne wall-clock time with its offset: +10:00 (AEST) or +11:00 (AEDT from 2025-10-05). */
const at = (iso: string) => Date.parse(iso);

type Record = {
  senderName: string;
  timestamp: number;
  type: "text" | "media" | "link" | "placeholder";
  text: string;
  isUnsent: boolean;
  media: Array<{ uri: string }>;
  reactions: Array<{ actor: string; reaction: string }>;
};

function msg(senderName: string, timestamp: number, text: string, extra: Partial<Record> = {}): Record {
  return { senderName, timestamp, type: "text", text, isUnsent: false, media: [], reactions: [], ...extra };
}

/** An unsent message: a placeholder whose text says it was unsent, which the archive does not keep (see write.ts). */
function unsent(senderName: string, timestamp: number): Record {
  return msg(senderName, timestamp, `${senderName} unsent a message`, { type: "placeholder", isUnsent: true });
}

const duplicate = msg("Ada Sample", at("2025-10-04T21:30:00+10:00"), "Are you around this weekend?");

export const THREADS: Array<{ file: string; participants: string[]; threadName: string; messages: Record[] }> = [
  {
    file: "Ada Sample_1.json",
    participants: [SELF, "Ada Sample"],
    threadName: "Ada Sample_1",
    messages: [
      duplicate,
      { ...duplicate },
      msg(SELF, at("2025-10-04T21:45:00+10:00"), "Yes! Climbing on Sunday?", {
        reactions: [{ actor: "Ada Sample", reaction: "👍" }],
      }),
      // After the clocks go forward: the next Melbourne day, on AEDT.
      msg("Ada Sample", at("2025-10-05T09:15:00+11:00"), "Sunday works. I'll bring the rope."),
      msg("Ada Sample", at("2025-10-05T09:15:00+11:00"), "And snacks."),
      msg("Ada Sample", at("2025-10-05T18:02:00+11:00"), "", {
        type: "media",
        media: [{ uri: "./messages_photos_ada/crag_view.jpeg" }],
      }),
      msg(SELF, at("2025-10-05T18:10:00+11:00"), "", {
        type: "media",
        media: [{ uri: "./messages_videos_ada/top_out.mp4" }],
      }),
      // Two photos sent in one burst: separate records, same sender and millisecond, no text.
      msg("Ada Sample", at("2025-10-05T18:30:00+11:00"), "", { type: "media", media: [{ uri: "./messages_photos_ada/burst_1.jpeg" }] }),
      msg("Ada Sample", at("2025-10-05T18:30:00+11:00"), "", { type: "media", media: [{ uri: "./messages_photos_ada/burst_2.jpeg" }] }),
      msg(SELF, at("2025-10-06T08:00:00+11:00"), "https://example.com/route-guide", { type: "link" }),
      unsent("Ada Sample", at("2025-10-06T08:05:00+11:00")),
      msg("Ada Sample", at("2026-09-20T19:30:00+10:00"), "Dinner at mine next week?", {
        reactions: [{ actor: SELF, reaction: "❤️" }],
      }),
    ],
  },
  {
    file: "Bruno Placeholder_2.json",
    participants: [SELF, "Bruno Placeholder"],
    threadName: "Bruno Placeholder_2",
    messages: [
      msg("Bruno Placeholder", at("2026-03-02T12:00:00+11:00"), "Long time! Coffee soon?"),
      msg(SELF, at("2026-03-02T12:20:00+11:00"), "", { type: "media", media: [{ uri: "./messages_gifs/wave.gif" }] }),
      msg(SELF, at("2026-03-02T12:21:00+11:00"), "Yes, Thursday?"),
    ],
  },
  {
    file: "Facebook user_3.json",
    participants: [SELF, "Facebook user"],
    threadName: "Facebook user_3",
    messages: [
      msg("Facebook user", at("2024-05-01T10:00:00+10:00"), "Hi, is this still available?"),
      msg(SELF, at("2024-05-01T10:30:00+10:00"), "Sorry, it's gone."),
    ],
  },
  {
    file: "Facebook user_4.json",
    participants: [SELF, "Facebook user"],
    threadName: "Facebook user_4",
    messages: [msg("Facebook user", at("2024-11-11T20:00:00+11:00"), "Happy birthday!")],
  },
  // Chats with deleted accounts that have no messages left, as the real export has.
  { file: "Facebook user_9.json", participants: [SELF, "Facebook user"], threadName: "Facebook user_9", messages: [] },
  { file: "Facebook user_10.json", participants: [SELF, "Facebook user"], threadName: "Facebook user_10", messages: [] },
  {
    file: "Climbing crew_5.json",
    participants: [SELF, "Ada Sample", "Cleo Example", "Gus Unlisted", "Bruno P"],
    threadName: "Climbing crew_5",
    messages: [
      msg("Gus Unlisted", at("2026-08-01T09:00:00+10:00"), "Gym at 6 tonight?", {
        reactions: [
          { actor: "Cleo Example", reaction: "👍" },
          { actor: "Ada Sample", reaction: "👍" },
        ],
      }),
      msg("Cleo Example", at("2026-08-01T09:05:00+10:00"), "I'm in."),
      msg("Bruno P", at("2026-08-01T09:06:00+10:00"), "Can't tonight, next time."),
      msg(SELF, at("2026-08-01T09:10:00+10:00"), "See you there."),
      unsent("Gus Unlisted", at("2026-08-01T09:12:00+10:00")),
    ],
  },
  {
    file: "Hana Newface_6.json",
    participants: [SELF, "Hana Newface"],
    threadName: "Hana Newface_6",
    messages: [
      msg("Hana Newface", at("2026-09-25T14:00:00+10:00"), "Great to meet you at the workshop!"),
      msg(SELF, at("2026-09-25T14:30:00+10:00"), "", { type: "media", media: [{ uri: "./messages_audio/voice_note.ogg" }] }),
    ],
  },
  {
    file: "Cléo Example_7.json",
    participants: [SELF, "Cléo Example"],
    threadName: "Cléo Example_7",
    messages: [
      msg("Cléo Example", at("2026-07-14T08:00:00+10:00"), "Did you get the tickets?"),
      msg(SELF, at("2026-07-14T08:03:00+10:00"), "Two, row F."),
    ],
  },
  {
    file: "Old flat_8.json",
    participants: [SELF, "Dev Testington", "Esme Fictional"],
    threadName: "Old flat_8",
    messages: [
      msg("Esme Fictional", at("2025-12-24T17:00:00+11:00"), "Merry Christmas, old flat!"),
      msg("Dev Testington", at("2025-12-24T17:02:00+11:00"), "Same to you both."),
    ],
  },
];

/** Media the zip holds: the folders differ from the uris' folders, as in the real export. top_out.mp4 is left out. */
export const MEDIA_FILES: Array<{ name: string; data: string }> = [
  { name: "media/ada_sample_1/crag_view.jpeg", data: "placeholder bytes: not an image (1)" },
  { name: "media/ada_sample_1/burst_1.jpeg", data: "placeholder bytes: not an image (4)" },
  { name: "media/ada_sample_1/burst_2.jpeg", data: "placeholder bytes: not an image (5)" },
  { name: "media/bruno_placeholder_2/wave.gif", data: "placeholder bytes: not a gif (2)" },
  { name: "media/hana_newface_6/voice_note.ogg", data: "placeholder bytes: not audio (3)" },
];

export function exportFiles(): Array<{ name: string; data: string }> {
  return [
    ...THREADS.map(({ file, participants, threadName, messages }) => ({
      name: file,
      data: JSON.stringify({ participants, threadName, messages }, null, 2),
    })),
    ...MEDIA_FILES,
  ];
}

type ExportFiles = Array<{ name: string; data: string }>;

/**
 * Two exports of the same chats a fortnight apart, as the phone app makes them, for the tests of keying chats by
 * name and of the repair (archive/messengerPhoneChats.ts). In the later one, new chats come first, so every other
 * chat's place in the export, and with it its file name and threadName, moves up by three (as `_21` became `_24`);
 * the group has a new message, so the export's newest message is newer; and each export holds the group's photo in
 * its own media folder. The group, and the one-to-one chat with Ada, each have two photos sent together, which each
 * export names anew, as the real exports do. Both have a "Facebook user" chat with messages and two without.
 */
export function phoneExportPair(): { first: ExportFiles; later: ExportFiles; crewMessages: number } {
  const crew = [SELF, "Ada Sample", "Cleo Example", "Gus Unlisted"];
  const crewMessages = (photoFolder: string, burstNames: string[]) => [
    msg("Gus Unlisted", at("2026-05-02T09:00:00+10:00"), "Crag on Saturday?", { reactions: [{ actor: "Ada Sample", reaction: "👍" }] }),
    msg("Cleo Example", at("2026-05-02T09:04:00+10:00"), "", { type: "media", media: [{ uri: `./${photoFolder}/crag.jpeg` }] }),
    ...burst("Cleo Example", at("2026-05-02T09:06:00+10:00"), photoFolder, burstNames),
    msg(SELF, at("2026-05-02T09:10:00+10:00"), "I'll drive."),
    unsent("Gus Unlisted", at("2026-05-02T09:12:00+10:00")),
  ];
  // Each export's names for the photos sent together: the crew's two, then Ada's two.
  const chats = (shift: number, photoFolder: string, names: string[]) => [
    chat(`Climbing crew_${21 + shift}`, crew, crewMessages(photoFolder, names.slice(0, 2))),
    chat(`Old flat_${26 + shift}`, [SELF, "Dev Testington", "Esme Fictional"], [
      msg("Esme Fictional", at("2026-04-01T18:00:00+11:00"), "Flat dinner?"),
      msg("Dev Testington", at("2026-04-01T18:05:00+11:00"), "Yes!"),
    ]),
    chat(`Ada Sample_${3 + shift}`, [SELF, "Ada Sample"], [
      msg("Ada Sample", at("2026-03-01T12:00:00+11:00"), "Hi!"),
      ...burst("Ada Sample", at("2026-03-01T12:05:00+11:00"), photoFolder, names.slice(2)),
    ]),
    chat(`Facebook user_${8 + shift}`, [SELF, "Facebook user"], [
      msg("Facebook user", at("2025-06-01T10:00:00+10:00"), "Is the bike still for sale?"),
      msg(SELF, at("2025-06-01T10:20:00+10:00"), "Sold, sorry."),
    ]),
    chat(`Facebook user_${9 + shift}`, [SELF, "Facebook user"], []),
    chat(`Facebook user_${10 + shift}`, [SELF, "Facebook user"], []),
  ];
  const firstNames = ["photo_1017.jpeg", "photo_1018.jpeg", "photo_1019.jpeg", "photo_1020.jpeg"];
  const laterNames = ["photo_2052.jpeg", "photo_2053.jpeg", "photo_2054.jpeg", "photo_2055.jpeg"];
  const photos = (folders: string[], names: string[]) => [
    { name: `media/${folders[0]}/crag.jpeg`, data: "placeholder bytes: the crag" },
    ...names.map((name, i) => ({ name: `media/${folders[i < 2 ? 0 : 1]}/${name}`, data: `placeholder bytes: burst photo ${i + 1}` })),
  ];
  const first = [...chats(0, "messages_photos", firstNames), ...photos(["climbing_crew_21", "ada_sample_3"], firstNames)];
  const laterChats = chats(3, "messages_photos", laterNames);
  laterChats[0].data = JSON.stringify({
    ...JSON.parse(laterChats[0].data),
    messages: [...crewMessages("messages_photos", laterNames.slice(0, 2)), msg("Cleo Example", at("2026-10-09T19:00:00+11:00"), "Same again?")],
  });
  const later = [
    chat("Hana Newface_0", [SELF, "Hana Newface"], [msg("Hana Newface", at("2026-10-10T08:00:00+11:00"), "Great to meet you!")]),
    ...laterChats,
    ...photos(["climbing_crew_24", "ada_sample_6"], laterNames),
  ];
  return { first, later, crewMessages: 6 };
}

/** Photos sent together: a record each, from one sender in one millisecond, named `names` (each export names them anew). */
function burst(senderName: string, timestamp: number, folder: string, names: string[]): Record[] {
  return names.map((name) => msg(senderName, timestamp, "", { type: "media", media: [{ uri: `./${folder}/${name}` }] }));
}

/** A chat's file as the phone app writes it: `<threadName>.json`, where the threadName ends in the chat's place in the export. */
function chat(threadName: string, participants: string[], messages: Record[]): { name: string; data: string } {
  return { name: `${threadName}.json`, data: JSON.stringify({ participants, threadName, messages }, null, 2) };
}
