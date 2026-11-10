// The journal's server half (sdk/server.ts's defineModule): the captain's journals, which he keeps in his Obsidian
// vault, the voice journals transcribed into it each morning from Voice Memos (jobs/voice-journal/), and the calls Grok
// Bot's cache holds, copied into it as they end (jobs/grok-calls/); each job's command is cli.ts's, `npm run journal`,
// with the launchd agent (and, for the voice journals, the launcher) it installs. It has no database: its store is
// the vault, the captain's own, which its jobs write into in one place (the vault's Journals/), and its ledger of
// recordings done (modules/journal/ledger.json in the archive's folder). Its routes (server/http.ts) are the Journal
// page's, which only read the vault's Journals/ (the days, and a day, its transcripts and its recordings as the captain
// opens them, each read kept in the trail of content reads); Obsidian edits it. It declares its made-up data for the
// testing data (fixtures/voiceJournal.ts) and its lines of the privacy policy (server/privacy.ts). The core finds this
// file by its place (server/modules/loader.ts) and loads it while the module is on; its page half is viewer.tsx, and
// README.md says what the module is.

import { defineModule } from "../../sdk/server.ts";
import { writeMadeUpVoiceJournal } from "./fixtures/voiceJournal.ts";
import { journalRoute } from "./server/http.ts";
import { JOURNAL_PRIVACY } from "./server/privacy.ts";

export default defineModule({
  id: "journal",
  sdk: 1,
  routes: ({ folder, contentLog }) => journalRoute(folder, contentLog),
  fixtures: { what: "a made-up voice journal (a vault with one recording transcribed into its Journals/ and that day's clean journal and edit list, an older day written by hand, and the module's ledger)", write: writeMadeUpVoiceJournal },
  privacy: JOURNAL_PRIVACY,
});
