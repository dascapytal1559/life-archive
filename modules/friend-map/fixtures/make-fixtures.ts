// npm run make-fixtures: rewrites the synthetic sample export in data/
// from the definitions in this folder.

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { writeZip } from "../../../sdk/server.ts";
import { exportFiles } from "./messenger.ts";

export const MESSENGER_SAMPLE = fileURLToPath(new URL("./data/messenger/messages.zip", import.meta.url));

if (import.meta.main) {
  await mkdir(fileURLToPath(new URL("./data/messenger", import.meta.url)), { recursive: true });
  await writeZip(MESSENGER_SAMPLE, exportFiles());
  console.log(`Wrote ${MESSENGER_SAMPLE}`);
}
