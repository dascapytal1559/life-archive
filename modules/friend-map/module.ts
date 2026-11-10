// Friend map's server half (sdk/server.ts's defineModule): the social layer. Its database is the archive
// (server/db.ts: modules/friend-map/archive.sqlite in the archive's folder, its people, chats, calls and hangouts, with
// migrations of its own since before it was a module); its twelve chat connectors (connectors/), which the core's host
// runs, their imports applied to that database (server/write.ts) and the calendar pushed after (server/calendarPush.ts);
// its routes (server/routes.ts: friend-map's contract at /api/archive, its page's own small API and scoring under
// /friend-map/api, and the conversations a Messages row's drawer opens); friend-map's page, served by the core under
// /friend-map/ (page/, a pinned copy of friend-map's); its answers for its calendar rows (server/calendarRows.ts); its
// tables (server/tabs/: Messages, Calls, Hangouts, People and Tags), which the Events page's Tables lists, and its
// editors for the Calls and Hangouts (server/tableEdits.ts) and for People and Tags (server/peopleEdits.ts); its commands (`npm run archive -- person ...`, server/commands.ts); its data's checks for `npm run check-data`;
// its made-up chats for the testing data (fixtures/); and its lines of the privacy policy (server/privacy.ts). The core
// finds this file by its place (server/modules/loader.ts). Its page half is viewer.tsx; README.md says what it is.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineModule, viewerReads } from "../../sdk/server.ts";
import { CONNECTORS } from "./connectors/connectors.ts";
import { beforeImport } from "./server/beforeImport.ts";
import { everyRow } from "./server/calendarPush.ts";
import { friendMapOwner } from "./server/calendarRows.ts";
import { checkPeople } from "./server/checkData.ts";
import { personName } from "./server/personName.ts";
import { FRIEND_MAP_COMMANDS, FRIEND_MAP_HELP, FRIEND_MAP_OPTIONS, friendMapCommand } from "./server/commands.ts";
import type { CliValues } from "./server/cli/context.ts";
import { openArchive, SCHEMA_VERSION } from "./server/db.ts";
import { dryRunCopy, dryRunLines } from "./server/dryRun.ts";
import { migratedLines } from "./server/migrated.ts";
import { friendMapOf, friendMapOver } from "./server/friendMap.ts";
import { platformsMarkdown } from "./server/platformsDoc.ts";
import { FRIEND_MAP_PRIVACY } from "./server/privacy.ts";
import { PAGE_PATH, pageFolder, savedSettingsPlugin } from "./server/page/savedSettingsPlugin.ts";
import { FRIEND_MAP_MOUNTS, friendMapRoute } from "./server/routes.ts";
import { openForQuery } from "./server/sqlRead.ts";
import { broughtChats } from "./server/brought.ts";
import { recordFriendMap } from "./server/demoRecord.ts";
import { CALLS } from "./server/tabs/callsTab.ts";
import { HANGOUTS } from "./server/tabs/hangoutsTab.ts";
import { MESSAGES } from "./server/tabs/messagesTab.ts";
import { PEOPLE } from "./server/tabs/peopleTab.ts";
import { TAGS } from "./server/tabs/tagsTab.ts";
import { peopleEditors } from "./server/peopleEdits.ts";
import { friendMapEditors } from "./server/tableEdits.ts";
import { applyChats } from "./server/write.ts";
import { writeMadeUpChats } from "./fixtures/madeUpChats.ts";
import { FRIEND_MAP_EXPORTS, FRIEND_MAP_JOBS } from "./jobs/sources.ts";

/** The archive's file, in the module's folder of the archive's folder. */
export const ARCHIVE_FILE = "archive.sqlite";

export default defineModule({
  id: "friend-map",
  sdk: 1,
  database: {
    file: ARCHIVE_FILE,
    migrations: [],
    // An archive still at the folder's root, from before friend map was a module, is moved here once (the core's
    // `npm run archive -- migrate friend-map-module`); until then the module is broken rather than start a new one.
    open: (file, folder) => {
      if (!existsSync(file) && existsSync(join(folder, ARCHIVE_FILE))) {
        throw new Error(`the archive is still at ${join(folder, ARCHIVE_FILE)}, from before friend map was a module: npm run archive -- migrate friend-map-module moves it here`);
      }
      return openArchive(file, { dataDir: folder });
    },
    reads: (file) => viewerReads(openForQuery(file, { heapLimit: false })),
    dryRun: dryRunCopy,
    version: SCHEMA_VERSION,
    migrated: migratedLines,
  },
  connectors: {
    connectors: CONNECTORS,
    apply: (events, db, source) => applyChats(events, db, source, (touched, counts, live) => friendMapOver(db).afterApply(touched, counts, live)),
    brought: broughtChats,
    before: beforeImport,
    dryRunSaid: dryRunLines,
    afterImport: (result, settings, db) => friendMapOver(db).afterImport(result.connector, settings),
    live: {
      onOwn: (db) => friendMapOver(db).recoverSends(),
      stop: (db) => friendMapOver(db).stopRules(),
    },
  },
  routes: (context) => friendMapRoute(friendMapOf(context)),
  mounts: FRIEND_MAP_MOUNTS,
  page: { path: PAGE_PATH, root: fileURLToPath(new URL("./page/", import.meta.url)), plugins: (folder) => [savedSettingsPlugin(pageFolder(folder))] },
  events: (context) => {
    const friendMap = friendMapOf(context);
    return { ...friendMapOwner(friendMap.db), rows: () => everyRow(friendMap.db) };
  },
  tabs: [MESSAGES, CALLS, HANGOUTS, PEOPLE, TAGS],
  edits: (context) => [...friendMapEditors(friendMapOf(context)), ...peopleEditors(friendMapOf(context))],
  commands: {
    names: FRIEND_MAP_COMMANDS,
    options: FRIEND_MAP_OPTIONS,
    help: FRIEND_MAP_HELP,
    run: (command, args, values, context) => friendMapCommand(friendMapOf(context), command, args, values as CliValues, context),
  },
  sources: { jobs: FRIEND_MAP_JOBS, exports: FRIEND_MAP_EXPORTS },
  checkData: (db, folder) => checkPeople(db, folder),
  describeScope: (db, key, value) => (key === "person" ? `person ${value} ${personName(db, Number(value)) ?? "(gone)"}` : null),
  fixtures: { what: "made-up chats, people, calls and hangouts", write: writeMadeUpChats },
  privacy: FRIEND_MAP_PRIVACY,
  documents: [{ file: "docs/platforms.md", text: platformsMarkdown }],
  demo: { record: recordFriendMap },
});
