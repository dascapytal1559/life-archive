// Runs the made-up bridge rig (see matrix.ts) with its sample chats, for
// trying the live Telegram path and the composer in a browser without the
// real rig:
//
//   node server/fixtures/matrix-rig.ts /tmp/life-archive-matrix     # keeps running
//   LIFE_ARCHIVE_DATA=/tmp/life-archive-matrix/data LIFE_ARCHIVE_URL=http://127.0.0.1:4652 npm start
//   (and friend-map on it, in friend-map: FRIEND_MAP_DATA=/tmp/life-archive-matrix/data LIFE_ARCHIVE_URL=http://127.0.0.1:4652 PORT=4612 npm start)
//
// It writes the testing data folder's data/connectors/matrix-bridge.json to point
// at itself. Sends are answered as the real bridge answers, and a message from
// "Ada Sample" arrives every minute, so the chat is seen to follow along.

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { addSampleChats, FakeRig, ghost, SAMPLE } from "./matrix.ts";

const folder = resolve(process.argv[2] ?? "/tmp/life-archive-matrix");
const rig = await FakeRig.create(join(folder, "rig"));
addSampleChats(rig);
await mkdir(join(folder, "data", "connectors"), { recursive: true });
await writeFile(join(folder, "data", "connectors", "matrix-bridge.json"), `${JSON.stringify({ enabled: true, ...rig.settings }, null, 2)}\n`);
let n = 0;
setInterval(() => rig.post(SAMPLE.DM, ghost(SAMPLE.ADA), { msgtype: "m.text", body: `sample message ${++n}` }, { at: Date.now() }), 60_000);
console.log(`The made-up rig answers at ${rig.url}; data folder ${join(folder, "data")}.`);
console.log(`Run the archive's server on it: LIFE_ARCHIVE_DATA=${join(folder, "data")} LIFE_ARCHIVE_URL=http://127.0.0.1:4652 npm start`);
console.log(`and friend-map, in friend-map: FRIEND_MAP_DATA=${join(folder, "data")} LIFE_ARCHIVE_URL=http://127.0.0.1:4652 PORT=4612 npm start`);
