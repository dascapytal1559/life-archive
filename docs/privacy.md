# Privacy

The captain's privacy policy, in three layers: content, read only when he asks, and by default other people's messages by local models alone; metadata, which they read freely; and what a repository may hold, the life archive's and, apart, his public forks'.

Written from `server/privacy/policy.ts` by `npm run docs`, with each module's lines (`modules/<id>/server/privacy.ts`); change the policy there, never here.

## Content

What was said and shown.

It holds:

- every copy that holds them: the platforms' exports and media and the backups in the archive's folder (`LIFE_ARCHIVE_DATA`, else `~/life-archive-data`), the bridge rig's data under `~/.local/share/friend-map-bridge-lab/`, an export the Cua Space downloaded, in its Downloads until `npm run cua-exports` takes it (docs/data.md, "Exports from the Cua Space"), the iPhone backup Finder keeps up to date in `~/Library/Application Support/MobileSync/Backup/` (or on the disk that folder links to; docs/import-runbook.md, "Taking the backup"), and LLM transcripts that may quote it: the tools' own stores (`~/.claude`, `~/.codex`, `~/.grok`, Pi's, OpenCode's, T3 Code's and the rest, and the Cua Space's `~/.codex`, where the export rounds' Codex keeps its sessions), OpenSuperWhisper's dictations (its `recordings/` and the `recordings.sqlite` that holds their transcripts, in `~/Library/Application Support/ru.starmel.OpenSuperWhisper/`), and the archive's copy of every one of them, kept each night in `transcripts/` in the archive's folder (docs/data.md, "Every LLM transcript"); and the NAS's nightly snapshots, encrypted on this Mac before they leave it: of the archive's whole folder, each kept a week, and of its `transcripts/` and `llm/` alone, tagged `llm-transcripts` and never forgotten (docs/data.md, "The NAS copy")
- a workout's route and heart rate, in its copy among the exports: the Fitness page draws them for the captain, a route as its shape in metres laid on the map of its area that the archive keeps on this Mac (`maps/` in the archive's folder, OpenStreetMap's data and Mapterhorn's terrain downloaded once with `npm run map`, their tiles and fonts served by the archive's own server), the page told the route's corner only then; viewing one never contacts a map server, so no tile server is told where he went, and a route whose area's map is not downloaded is drawn over none
- an activity's playback in 3D (the Fitness page, Play back in 3D): the route whole, point by point with its times, distance and altitude, and the trusted heart rate, sent to the page alone and only for a route inside a map kept here; over the archive's own 3D it asks no other server for anything; the playback opens over that 3D; over the photorealistic city, only when the captain chooses it for that playback and only while CESIUM_ION_TOKEN or GOOGLE_MAPS_API_KEY is set in .env.local, the page asks Cesium ion for the tileset's address once a playback and Google for the city's tiles the camera sees as it follows the route, so the tile requests retrace the route and Google can learn where he went, piece by piece and when he played it back, though never its times, distance or heart rate, which stay on this Mac
- the captain's note on a workout (the Workouts table's Note: `workout_note` in the exercise module's database, and its change log's rows of it): read only when he opens it to edit, each read kept in the trail; never in the calendar or the record of edits
- message text, earlier texts and original records, and the search index
- photos, videos, voice notes and other files
- the captain's notes on hangouts and calls, and his drafts
- the health results and records (the health module): the lab reports and the portals' pages in their exports (`platform-exports/everlab/` and `platform-exports/my-health-record/` in the archive's folder), what the import read from them (`modules/health/imported.json`: every result of every report it reads), what was transcribed by hand (`modules/health/by-hand.json`: results, the physical assessment, runs, treatments, immunisations, medicines and Medicare's claims), and the Health page's one answer (`/life-archive/api/m/health`), every result judged
- the captain's journals and notes, in his Obsidian vault (the journal module's; the settings' `vault.folder` in the archive's folder, `Vault`, which can be a link into iCloud Drive or another folder, backed up where it lives): every note, journal, draft and recording in it, among them what the voice journals' transcription writes into its `Journals/` for each recording Voice Memos syncs (its copy under `assets/<day>/voice-memos/`, its raw transcripts and `journal-source-v1` record under `raw/<day>/`), the calls the Grok calls job copies from Grok Bot's cache into its `Journals/raw/` (each call's transcript, verbatim and readable) and the clean journals an agent (firstmate, where it is set up) writes from them; and OpenSuperWhisper's own copy of each recording and its transcript in its history (`~/Library/Application Support/ru.starmel.OpenSuperWhisper/`), kept as it keeps them for any file it transcribes
- rituals' store (`modules/rituals/data/ritual.sqlite3` in the archive's folder, which `bin/ritualctl` writes and the archive's server reads in-process, read-only, for Events' Daily rituals and Fitness's Habits): the captain's own words in it (each report's `source_text`, a day's `notes`, a workout's title and details, a weekly target's name and an entry's note, a temporary item's words), its audit of every change and the source documents it was imported from; and every copy that holds them: rituals' own backups beside it (`data/backups/`, one before each write), its exports (`data/exports/`), the dashboard snapshots it still writes (`data/views/`) and its offline queue (`modules/rituals/queue/`, whose pending entries hold a request whole, his words included), and the copies the rituals connector kept of each day's workouts before the module (`platform-exports/rituals/workouts/`), read by nothing now, until they are removed
- rituals' private notes in the archive's folder, `modules/rituals/LOCAL.md` and everything under `modules/rituals/history/` (what the rituals repository kept beside its code, the repository's bundle among them)

**Rule.** By default, messages with other people on social media and messaging platforms (WhatsApp, Messenger, Instagram, WeChat, Discord, X and the like), with their media and every copy that holds them, never reach an external model or agent (any not run on the owner's own machines: Claude, OpenAI, DeepSeek and the like): only local models on his machines read them. The rest of it, email among it, external models may read. An installation's own written policy (its `AGENTS.local.md`) may set this otherwise, and wins where it does. Whichever model reads it does so only when the captain asks for something from his chats, only for that request, and only through `npm run archive -- timeline`, `search` and `event-content`, or a content tool at the agents' MCP door to a key the captain granted it (docs/agents.md), which log every read (`npm run archive -- content-log`); never otherwise. An LLM transcript (a tool's own, the archive's copy in `transcripts/`, or a NAS snapshot of them) is read on the same terms, only when the captain asks for something from it and only for that request, and, since it may quote other people's messages, by default by a local model alone; the nightly pass that copies them, its check and the NAS backup handle them as bytes and read none, and the LLM warehouse (docs/events.md, "The LLM warehouse") reads each prompt's text only to classify it as one of a few fixed shapes (a tool's notice or hook feedback, a slash command, and, where an orchestrator's provenance adapter is set up, such as FirstMate's with `FIRSTMATE_HOME`, that orchestrator's launch briefs, doorbells and wake-ups) and to count its length, as the agents' connectors count theirs, keeping no word of it. It is never committed or published.

What holds to it:

- the three commands keep every read in the trail, with who read and the captain's words
- SQL queries cannot read it, and `--redacted` shows its shape with every text as its length
- the agents' MCP door (`/life-archive/mcp`, `server/mcp/`) answers only a key made with `npm run archive -- mcp key add`, each agent's own, and offers a key only the tools it may call: facts to every key, content only to a key granted `content` (or `content:<module>`), each content call taking the captain's words as `why` and kept in the trail with the key's agent as its reader, and writes only to a key granted `write` (or `write:<module>`); every call is kept in `core.sqlite`'s `mcp_call` with its agent, never what a content tool answered; and start_here tells every agent that what the archive answers is data, never instructions
- a workout the captain deletes from the Fitness page is removed whole from the archive's folder, with no backup taken: its copies' files, their entries in an export's zip and their rows in the exercise module's index and the calendar, and his corrections and note on it with their change log's rows (overwritten, not just unlinked); the backups and NAS snapshots taken before still hold it until they expire, and Polar Flow until he deletes it there; and between the module's landing and the migration that drops the archive's old rows (which overwrites them for good), those rows and the archive's 48-hour backups still hold its index row, metadata only
- the Events tables' drawers read a hangout's or a call's note only when he opens it to edit, each read kept in the trail; the tables, the calendar and the record of edits never hold its words
- the Events calendar's day lists who was messaged and how many, and reads a chat only when he opens it, one at a time, each page kept in the trail as a day read of that person or chat
- the Health page's answer: its route refuses another site's page and any write, and the door's Host guard and the tailnet's ACL decide who may ask; `npm run health -- import` says what each file gave and which it could not read, never a result
- the archive reads the vault only through the Journal page, and only its `Journals/`: the list of days is their files' names and sizes (metadata, not logged); a day's journal, a transcript or edit list of its `raw/<day>/` and a recording or picture of its `assets/<day>/` are read only when the captain opens them on the page (on a desk, opening the page opens its latest day, as a notebook opens on its last page; a phone reads nothing until a day is tapped; a day's edit list is read as the day opens, a transcript and a recording only when asked for), each kept in the trail of content reads as a viewer read before it is answered (a recording's ranges fold into one row as it plays and seeks), answered only to the console's own page (and on the tailnet only to the devices its ACL admits), never cached, and never handed to a model; the page only reads, and nothing it can ask leaves `Journals/` (a day is named YYYY-MM-DD, every other step is one name, and a file whose real path leaves `Journals/` through a link is refused); no other command, route or tab opens a note or a transcript (`npm run archive -- storage` counts the vault's bytes, `check-data` passes beside it, and the NAS backup leaves it out); the voice journals' transcription reads a recording's sound only to transcribe it, on this Mac alone (OpenSuperWhisper and Nemotron; nothing is sent anywhere), and of the journal's raw folder only each record's `source_id`, to leave alone what firstmate did by hand; its ledger and its log name a recording's file, times, length, state and the files written for it, never its title or a word of it; its notes to firstmate name the same and its title, the label Voice Memos' index keeps for it, which the captain can type himself, never a word of the recording
- the Grok calls job (`npm run journal -- grok-calls`) only reads Grok Bot's cache (its chats and its roster of bots' names, as the grok-bot connector does), never replaces a file it wrote, and prints and logs only ids, dates and counts, never a word of a call; nothing in the archive reads the files it writes but the Journal page, as above
- rituals' two tabs (Events' Daily rituals, Fitness's Habits) are sent only what rituals' own dashboard served (`/life-archive/api/m/rituals/dashboard`, `modules/rituals/server/dashboard.ts`): each day's workouts with his words about them, which neither tab shows, but no weekly target's notes, no one who logged an entry and no habit times; and, beyond what that dashboard served, the temporary items on the rituals (the captain's own words for each) with their marks day by day and the time of each tick, but no check's id, revision, source text or audit; no tab reads rituals' whole view (`/life-archive/api/m/rituals`) since the Rituals page's Previous tab went; and Fitness's Activities reads of a workout he logged there only its category, title, his words about it (shown to him alone), how long they say it was and whether they say zone 2
- the calendar's rituals rows (`modules/rituals/server/calendar.ts`) carry no words: a habit done is its habit, its time and how the time is known, and a day which habits and required checks were done, not done or not reported yet, in rituals' own words for the habits and a check's id (never its words), with a plank's held time
- the assistants that log through `bin/ritualctl` read the store through its read requests (`rituals`, `history`, `ritual_status`, `export` and the rest `modules/rituals/HANDOFF.md` lists) and through `bin/ritual-view`, without the archive's trail, as rituals' own contract has it: this grants no new reader and no new read; the store's audit records every write, and the archive's content commands (`timeline`, `search`, `event-content`) never reach it
- at the archive's MCP door (`server/agents.ts`), the same requests go through `bin/ritualctl` too: `rituals_status` answers a day's statuses alone (no check's words, no notes, no source text) to every key; `rituals_read`, any read request answered whole, only to a key granted `content:rituals`, each read kept in the archive's trail with the agent and the captain's words; and `rituals_write` only to a key granted `write:rituals`
- nothing in the archive reads rituals' notes in `modules/rituals/LOCAL.md` and `history/`

## Metadata

The index of what happened, without what was said.

It holds:

- when, how long, with whom, in which chat, on which platform, of what type and how big
- counts, sizes, dates, coverage and the schema
- the agents' keys, as their hashes with each agent's grants, and their calls (`core.sqlite`'s `mcp_key` and `mcp_call`): who called which tool when, how it went, a facts tool's arguments and a content or write tool's summary of what it was about (an op and a date, never its words)
- the LLM warehouse's index of every LLM session on this Mac (the core's `llm_session`, `llm_turn` and `llm_tag`): each session's and turn's time, length, tool, model, tokens and cost, what each prompt's text was classified as, and its tags (who sent it, from which device, how, in what kind of session and project, and a worker's task as firstmate's own records name it, never taken from a prompt's text)
- the inspirations' old copy from before the inspirations module (`core.sqlite`'s inspiration tables and change log, and `platform-exports/inspirations/live/`), read by nothing since the module took them over, kept until the captain says it may go
- the record of the tables' edits (`core.sqlite`'s `table_edit`, server/edits/): each change made to a row of a table from its drawer or the CLI, when, from where, which row and field, what it was and became (a person's name, tags, location and his note for them among those, metadata as they are in People), people by their ids, and the owner's receipt for its undo; never a note's words that are content (a hangout's or a call's), which stay with the note's owner, where its editor reads them through the trail
- the archive's old workout rows from before the exercise module, read by nothing: from the module's landing until `npm run archive -- migrate friend-map-module --apply` (the friend map step's move, which drops them too) overwrites them for good, they and the archive's backups of the last 48 hours still hold the index row of a workout the captain deleted (when, its sport, how far, what recorded it and where its copy was; no route or heart rate)
- the exercise module's index (`modules/exercise/exercise.sqlite` in the archive's folder): of each copy of a workout, when, its sport and family, how far, what recorded it, which sample streams it holds and where the copy is, never a heart rate or a coordinate; the weekly targets and the heart-rate zones every workout's time in zones is counted by (`modules/exercise/exercise.json` in the archive's folder, or `exercise.json` at its root until it is moved)
- a tombstone for each workout copy he deleted: its source, the source's id, its sport family, when it started and ended, and when it was deleted; nothing of what it held
- his corrections to a workout from the Workouts table (`workout_correction`): its sport, start, end or distance as he says, kept beside each copy as its source gave it, and the change log they are made under
- people's names, aliases, accounts, tags and locations, and the captain's notes for people
- which health exports the import read, left to the hand or could not read, and when (`modules/health/imported.json`'s list of files and `importedAt`); and the one authority on range (`npm run health -- ranges`: each test's source and bands, with the labs' printed intervals chosen in `modules/health/lab-intervals.json`), which is no one's result, though the labs it names and their reports' dates are the owner's own and stay in the archive's folder
- the captain's inspirations, in full: each link and what is known of it, his caption, his tags and the AI's, every save and the kept files (`modules/inspirations/`; version 1, by the captain's call)
- the voice journals' ledger (`modules/journal/ledger.json` in the archive's folder): each recording's file name (Voice Memos' own: when it began, and its id), its state (done, in the journal by hand, waiting and why, failed and why), its journal day, the names of the files written for it and whether firstmate was told; and the job's log (`~/Library/Logs/LifeArchive/voice-journal.log`), the same facts a line at a time
- the Grok calls job's log (`~/Library/Logs/LifeArchive/voice-calls.log`): each pass's count of cached calls, and each call it saved by its id, its day, its bot's name and id and the names of the files written
- when the captain checked in each evening and did each habit, how each time is known, how each day's habits and required checks stood (a check by its id) and a plank's held time; a workout's category from Rituals (gym push, bike) and the minutes its words state; the archive's old rows of them from before the module (`ritual_checkin`, `ritual_habit`, `ritual_day` and `ritual_workouts` events, and the rituals connector's runs), read by nothing, until `npm run archive -- migrate friend-map-module --apply` (the friend map step's move, which drops them too) overwrites them for good
- the Shopping module's suppliers (`shopping/suppliers.json`: the shops the owner watches, each by its name and address) and its pulls (`shopping/pulls/`: what each shop listed on special in public, at what price, and when it was asked), read from the shops' public storefronts, never behind a sign-in

**Rule.** External models may read it freely, with no read logged. What of it may be committed is the repository layer's to say: counts, dates and places may be, names and ids may not.

## The repository

What may be committed or published. The repository is private, but every tracked file and commit message is held to this as if published, since making it public publishes them all.

**Rule.** Anything may be committed but these, wherever they would go (code, comments, tests, fixtures, docs, screenshots, commit messages and the captain's quoted asks). Only these stop a commit; anything else the review notices is a suggestion, logged for the captain, that never stops one:

Never:

- a real person's name or nickname, the captain's own included (his GitHub identity as commit author aside), or a real group chat's title (`name`)
- a real phone number (`phone-number`)
- a real email address (`email`)
- a real chat handle or account id (Telegram, WhatsApp, Signal, Discord, WeChat, X and the like) (`account`)
- a tailnet host name or Tailscale address, a host name on the captain's own network, or this Mac's user or host name (`private-host`)
- a real machine's IP address (loopback, private-network and documentation ones, such as 127.0.0.1, 192.168.1.5 and 203.0.113.7, are fine) (`ip-address`)
- a precise real-world address: a street address or an exact spot (`street-address`)
- a local path that holds a user name (`/Users/<name>/…`) (`user-path`)
- any content (the first layer): text from the archive, that is friends' messages, media, and the captain's hangout notes and drafts, or text from his notes for people (`content`)
- a secret: an API key, token, password or private key (`secret`)
- the captain's own health records and results: a result of his, a diagnosis, condition, allergy, treatment or medicine of his, or which labs or clinics tested him and when (made-up results in tests and fixtures are fine) (`health`)

Fine:

- cities, towns, regions and countries (Melbourne, Tokyo, Australia) and time zones (`Australia/Melbourne`)
- dates and times
- counts and sizes from the archive, even about one person
- ordinary words and phrases and code identifiers, even capitalised ones that look like a name ("Since Aug")
- the made-up names in `server/fixtures/madeUpNames.ts`, numbers set aside for fiction, example domains, and placeholder hosts (a tailnet named `tail1234`, `your-mac`)
- in the commit check's own tests (the life archive's `server/guard/scan.test.ts`), the real-looking values each built from pieces with `join(...)` for the check to stop: they are made up
- generic stand-ins ("[a friend]", "Person A") and the word "captain"
- commit messages quoting the captain's own asks to his agents, real names replaced with "[a friend]": they are his instructions about the software, not content; a friend's message quoted in one is still content
- public companies, products, libraries, tools, AI models and agents and their authors, and public figures named as such
- third-party licence notices bundled as their licence requires, with their authors' public contact details (a font's OFL notice and its author's email)
- the captain's GitHub handle
- Handles and account ids made from the made-up names, as a test or fixture writes them (adasample, ada_sample, @ada_sample, ada_sample_77).
- The addresses set aside for documentation (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32), in tests of which hosts are refused.

What holds to it:

- the life archive's privacy guard (`npm run guard`), under the `life-archive` policy, once it is installed in the repository (`npm run guard -- install life-archive`, which points its `core.hooksPath` at the guard's hooks); until it is published, the repository stays on this Mac and is not installed
- its commit check on every commit, and on every commit a push sends that was not reviewed yet (`server/guard/scan.ts`): the names, ids and notes in the archive, and phone numbers, emails, chat ids, host names, IP addresses and street addresses by their shape
- its privacy review by GPT-6.1 Sol of each commit once, whether firstmate landed it or the phone agent committed it: as its branch lands or on the first push that sends it, recorded so it is never reviewed again (`server/guard/review.ts`), given this layer; it stops only on one of these kinds with the text found where it says, and logs anything else as a suggestion (`npm run guard -- findings`)
- before the repository is made public, both checks over whatever it would publish that was not reviewed yet (`npm run guard -- publish-check`), then the captain's yes

## A public fork

Open-source code the captain publishes on GitHub, merged from its upstream with his own changes on top. Every tracked file and commit message is public as soon as it is pushed.

**Rule.** Anything about the software may be committed but these, wherever they would go (code, comments, tests, fixtures, docs, dev journals, screenshots and commit messages). Only these stop a commit; anything else the review notices is a suggestion, logged for the captain, that never stops one:

Never:

- the name of one of the captain's own machines or servers (a Mac, a remote host, a NAS), a tailnet's name or a host on it (`<host>.<tailnet>.ts.net`), a Tailscale address, a host name on his own network, or this Mac's user or host name (`private-host`)
- the name or folder of one of the captain's own accounts or tool profiles other than his GitHub identity (a second login, a Claude or Codex profile such as `.claude-profiles/<name>`), or a real chat handle or account id (`account`)
- a local path that holds a real user name (`/Users/<name>/…`, `/home/<name>/…`) (`user-path`)
- a real email address, the captain's or anyone's from his life (upstream's own published addresses, as upstream's commits carry them, aside) (`email`)
- a real person's name from the captain's life, his own included (his GitHub identity as commit author aside), or a real group chat's title (`name`)
- a real phone number (`phone-number`)
- a real machine's IP address (loopback, private-network and documentation ones, such as 127.0.0.1, 192.168.1.5 and 203.0.113.7, are fine) (`ip-address`)
- a precise real-world address: a street address or an exact spot (`street-address`)
- any content from the captain's archive (the first layer): friends' messages, media, his hangout notes and drafts, his notes for people, or his own private journal (`content`)
- a secret: an API key, token, password or private key (`secret`)

Fine:

- products, tools, AI models and coding agents by name, and which of them the software supports, runs or was tested with (Claude, Codex, Grok, Cursor, OpenCode, `gpt-6-luna`, `claude-haiku-5-5`)
- test results, live checks and verification tables: what was run, on which model, at which effort, and how it went
- that the captain has a setup, said without naming his machines, servers or profiles: "the captain's macOS arm64 build", "waits on the captain's setup", "sign in", "a remote host", "a second Claude profile", "the captain's tailnet"
- dates, times, versions, commit ids, counts, sizes and durations not tied to a named machine or profile of his
- code identifiers and ordinary words, even ones that look like a host's or a person's name (upstream's `ZData`, `zdata`, "Since Aug")
- generic paths: `~/`, `$HOME`, `/Users/<name>`, `/home/<user>`
- placeholder hosts and example domains: a tailnet named `tail1234`, `example.ts.net`, `your-mac.tail1234.ts.net`, `your-mac`, `example.com`, `.test`, `.invalid`
- the captain's GitHub handle and its noreply address, and the word "captain"
- upstream's project, its authors and contributors, and public companies, products, libraries and their authors, and public figures named as such
- made-up names, numbers set aside for fiction and documentation addresses (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32) in tests and examples
- cities, regions, countries and time zones
- commit messages quoting the captain's own asks to his agents about the software, a real name replaced with "[a friend]"

What holds to it:

- the life archive's privacy guard (`npm run guard` there), installed into the fork by pointing its `core.hooksPath` at the guard's hooks, which run the fork's own hooks first
- its commit check on every commit, and on every commit a push sends that was not reviewed yet: the private terms beside the archive, the archive's names, and emails, host names, IP addresses and the rest by their shape
- its privacy review by GPT-6.1 Sol of each commit once, on the first push that sends it, given this layer: it stops only on one of these kinds with the text found where it says, and logs anything else as a suggestion (`npm run guard -- findings`)
- every commit a push sends made under a GitHub noreply address
