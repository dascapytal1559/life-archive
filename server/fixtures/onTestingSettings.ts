// Imported before onSettings.ts by what makes testing data, which is reckoned on the testing settings whatever the
// machine's are: testing-data/settings.json, which vitest.config.ts names for the tests too. Rituals' store, which
// reckons its days in a zone of its own (modules/rituals/src/instants.ts), is given the same zone.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TESTING_SETTINGS = fileURLToPath(new URL("../../testing-data/settings.json", import.meta.url));

process.env.LIFE_ARCHIVE_SETTINGS = TESTING_SETTINGS;
process.env.RITUAL_TIME_ZONE = (JSON.parse(readFileSync(TESTING_SETTINGS, "utf8")) as { timeZone: string }).timeZone;
