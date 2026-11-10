# The life archive's architecture

The whole system, the archive's core and its modules (friend map, the social layer, among them) and friend-map's page, part by part: what each part is, the boxes in it with their files and tables, what feeds what, every route of the archive's server, and a note for every table and column.

It was written on 2 November 2026 from the viewer's Architecture page, which drew this as a map, when the page was removed (the captain reads each platform's status and settings in Events > Sources now). Nothing checks it against the code any more: when it says something the code no longer does, the code is right; correct this file as you go.
The privacy policy is `docs/privacy.md`, and each platform's connectors `docs/platforms.md`; both are written from the code (`npm run docs`).

## The parts

### Chat platforms

*where the messages are.* Every network the captain talks on. Telegram and WhatsApp are live; the others come in as exports or app databases, with three more bridges planned.

- **Address book** (app database): The Mac's Contacts, which iCloud keeps in step with the phone (~/Library/Application Support/AddressBook: the Mac's own store and each account's under Sources/), copied each Monday into platform-exports/addressbook/<date>/ by npm run mac-imports; or the iPhone's AddressBook.sqlitedb from a backup. Names people for whatsapp-db, imessage-db and call-history, and fills notes when given with --contacts. Read from a copy, never written.
  Files: `modules/friend-map/connectors/addressBook.ts`, `modules/friend-map/server/addressBookNotes.ts`, `modules/friend-map/jobs/macImports/round.ts`, `modules/friend-map/jobs/macImports/copy.ts`.
  people.md: "People".

#### Telegram

*live.* Live through its own bridge, which pages real server history. No export is read.

- **gotd** (1 · protocol library): Telegram's MTProto, in Go (MIT), forked into mautrix-telegram. Pages real server history. Like every protocol library, it speaks the network's own protocol, logs in as a linked device or app, and handles its encryption.- **mautrix-telegram** (2 · network connector): Fills the same five slots in every bridge: login; receiving new messages; fetching history page by page; sending (messages, edits, deletes, reactions, read receipts); and stable ids for chats, people and messages. Each platform's bridge is its own program: protocol library, connector and a copy of the framework. Running in the bridge rig. Logged in as a device of its own, like a second Telegram app, so the desktop app need not run, and no phone has to come online.
#### WhatsApp

*live, read only · app database.* Live and read only through its bridge, and the phone's or Mac's own databases for the years before.

- **WhatsApp's own databases** (app database): ChatStorage.sqlite, CallHistory.sqlite (the Calls tab), LID.sqlite, ContactsV2.sqlite and Message/Media/, from a local iPhone backup or the Mac app. Read from a copy, never written. The only way WhatsApp's calls come in: the Mac app's, copied safely into platform-exports/whatsapp/mac/ each morning at 04:00 (the life archive's npm run whatsapp-mac-calls, launchd's local.whatsapp-calls-import) for a calls-only import.
  Files: `server/connectors/whatsapp-db/macCalls.ts`.
  archive.md: "The message archive".
- **whatsmeow** (1 · protocol library): WhatsApp multi-device, in Go (MPL-2.0). Logs in as a linked device; history only from what the phone sends at link time (about a year here). Like every protocol library, it speaks the network's own protocol, logs in as a linked device or app, and handles its encryption.- **mautrix-whatsapp** (2 · network connector): Fills the same five slots in every bridge: login; receiving new messages; fetching history page by page; sending (messages, edits, deletes, reactions, read receipts); and stable ids for chats, people and messages. Each platform's bridge is its own program: protocol library, connector and a copy of the framework. Running in the bridge rig. Linked to the captain's number as a device of its own, like WhatsApp Web, so the desktop app need not run. The phone must come online at least every 14 days, or WhatsApp unlinks it (the bridge warns after 12 days, and after 10 asks the phone to wake).
#### Messenger and Instagram

*exports · bridge planned.* Three exports today: Messenger's phone export (encrypted chats), Facebook's download (everything else) and Instagram's download. A live bridge is planned.

- **Messenger phone export** (export file): The zip from the Messenger app's "Download your message storage data": the end-to-end-encrypted chats, with names only and no message ids. Unpacked into platform-exports/messenger/<export date>/, where its media stay.
  archive.md: "The message archive".
- **Facebook "Download your information"** (export file): Messages as JSON, often in several zip parts, reaching back to the first message: the chats the phone export does not have. The parts are unpacked together into platform-exports/messenger/<export date>/, where its media stay; a later download continues it.
  archive.md: "The message archive".
- **Instagram "Download your information"** (export file): Messages as JSON from Accounts Center, in Facebook's format: inbox chats and message requests. Unpacked into platform-exports/instagram/<export date>/, where its photos, videos and voice notes stay.
  archive.md: "The message archive".
- **messagix** (1 · protocol library) *(planned)*: Messenger's and Instagram's Lightspeed protocol, in Go (AGPL-3.0); encrypted Messenger chats go through a WhatsApp-protocol client, live only. Like every protocol library, it speaks the network's own protocol, logs in as a linked device or app, and handles its encryption.- **mautrix-meta** (2 · network connector) *(planned)*: Fills the same five slots in every bridge: login; receiving new messages; fetching history page by page; sending (messages, edits, deletes, reactions, read receipts); and stable ids for chats, people and messages. Each platform's bridge is its own program: protocol library, connector and a copy of the framework.
#### iMessage, SMS and calls

*app databases.* The Messages app's own database, from the iPhone backup or the Mac, and the phone's call history (phone and FaceTime calls, platform phone), whose numbers are the same phone line.

- **Messages app database** (app database): The iPhone's sms.db (or the Mac's chat.db) with its Attachments folder: iMessage, SMS and RCS. Read from a copy, never written. The Mac's is copied each Monday, with the attachments since the last import, into platform-exports/imessage/<date>/ and imported by npm run mac-imports (the launchd agent local.life-archive-mac-imports, whose own launcher alone has Full Disk Access).
  Files: `server/mac-imports.ts`, `modules/friend-map/jobs/macImports/round.ts`, `modules/friend-map/jobs/macImports/copy.ts`, `server/launcher.c`.
  archive.md: "The message archive".
- **Call history** (app database): CallHistory.storedata, the Core Data database the iPhone keeps its Recents in and iCloud syncs to the Mac (~/Library/Application Support/CallHistoryDB/; an unencrypted iPhone backup leaves it out), copied into platform-exports/calls/<date>/ and imported each Monday by npm run mac-imports. Read from a copy, never written.
  Files: `server/mac-imports.ts`, `modules/friend-map/jobs/macImports/round.ts`, `modules/friend-map/jobs/macImports/copy.ts`, `server/launcher.c`.
  archive.md: "The message archive".

#### WeChat

*app database.* WeChat's own databases, from the iPhone backup. Nothing touches WeChat's servers or app.

- **WeChat's own databases** (app database): WCDB_Contact.sqlite, message_<n>.sqlite and each chat's Img, Video, Audio and OpenData folders, as the iPhone app keeps them: copied out of the iPhone backup Finder keeps (taken over Wi-Fi, only what changed sent) by the life archive's npm run extract-wechat into platform-exports/wechat/<backup date>/. Read from a copy, never written.
  Files: `modules/friend-map/connectors/wechat-ios/extract.ts`.
  archive.md: "The message archive".

#### X

*export.* Direct messages from X's archive of your data.

- **X's archive of your data** (export file): The zip from X's "Download an archive of your data": direct messages, one-to-one and group, as window.YTD scripts, with their media, which stay where they are once it is unpacked into platform-exports/x/<export date>/. Names only the captain; everyone else is an id.
  archive.md: "The message archive".

#### Signal

*export · bridge planned.* Signal Desktop's chat history export today. A live bridge is planned.

- **Signal Desktop's chat history export** (export file): The folder Signal Desktop's "Export chat history" writes: main.jsonl, Signal's backup format as JSON lines, with files/ when media were included. Never gives the captain's own id.
  archive.md: "The message archive".
- **signalmeow + libsignal** (1 · protocol library) *(planned)*: Go (AGPL-3.0) over Signal's Rust crypto library. Logs in as a linked device; history only from the transfer at link time. Like every protocol library, it speaks the network's own protocol, logs in as a linked device or app, and handles its encryption.- **mautrix-signal** (2 · network connector) *(planned)*: Fills the same five slots in every bridge: login; receiving new messages; fetching history page by page; sending (messages, edits, deletes, reactions, read receipts); and stable ids for chats, people and messages. Each platform's bridge is its own program: protocol library, connector and a copy of the framework.
#### Discord

*export · bridge planned.* Discord's data package today: the captain's own messages only. A live bridge is planned.

- **Discord's data package** (export file): The zip from "Request your data" (Messages, and Account if asked for): each channel's channel.json and messages.json, and index.json's label for it. Holds only the captain's own messages; attachments are links.
  archive.md: "The message archive".
- **discordgo** (1 · protocol library) *(planned)*: Discord user sessions, on Beeper's fork of discordgo (BSD-3-Clause); its bridgev2 rewrite is not ready for self-hosting. Like every protocol library, it speaks the network's own protocol, logs in as a linked device or app, and handles its encryption.- **mautrix-discord** (2 · network connector) *(planned)*: Fills the same five slots in every bridge: login; receiving new messages; fetching history page by page; sending (messages, edits, deletes, reactions, read receipts); and stable ids for chats, people and messages. Each platform's bridge is its own program: protocol library, connector and a copy of the framework.
### The terminal

*npm run.* The archive from the command line: imports, edits to people, backups, the data check, and where exports and media are kept (exports, media repoint, storage).

- **The CLI** (npm run archive): The life archive's npm run archive, run in its own folder. The archive from the terminal: import (with --dry-run, against an in-memory copy of the platform's records without text, the archive only read), connectors, people, group chats (and dropping one), proposals, merges, tags, person edits (person new adds someone by hand, with --location, --tag and --note, refused for a name someone already has unless --anyway), catch-ups (catch-ups, catch-up add, change and delete: in person), logged calls (call add, change and delete), drafts (person draft), bulk edits by query or SQL (edit, a dry run first), the change log and undo (changes), backups, coverage, and import-status, where each connector's imports stand and what to do next in an import session (docs/import-runbook.md), and events, the event index by day. Every change is a changeset, after a checked backup. Everything but timeline, search and event-content prints structure only; they keep each read in the trail (content-log shows it), with --redacted for every text as its length (and --testing for the testing data instead, on timeline and search), to learn their shape without content.
  Files: `server/archive/cli.ts`, `modules/friend-map/server/importStatus.ts`, `server/archive/dryRun.ts`.
  Tables: `event`, `llm_session`, `llm_turn`.
  people.md: "People".
- **Inspire shortcut** (the iPhone's share sheet): The captain's quickest door for what he comes across scrolling: share a link, text or a picture to it, say or type a line, done. It posts the shared thing and his words to the archive's capture route over the tailnet (POST /life-archive/api/inspirations/capture, origin share-sheet) and shows "Saved #42 (new): …" or the archive's error. Built and signed outside this repository; installing it on the phone is the captain's step.
  features.md: "Inspirations".
- **Grok Bot agent** (agent): Optional: a Grok Bot agent the owner may set up on the Mac, logged in to whichever platforms he chooses: when he sends it something to keep, it looks at it with its logins and captures it with npm run archive -- inspiration add, with the link, his words as the caption, what it saw as the title, author and description, --origin grok-bot and --wait, and tells him the item's number and its AI tags. The second door, for talking a thing through: the same capture as the share sheet's. Its charter's instruction is docs/grok-bot-inspirations.md.
  Files: `docs/grok-bot-inspirations.md`.
- **The night's job** (npm run nas-backup): launchd's local.life-archive-nas-backup, at 06:00: first every LLM transcript, from the named folders of Claude Code (its crews and subagents too), Codex, the Grok CLI and Pi, and checked copies of OpenCode's and T3 Code's databases (the retired machines' copies and the idle tools once), then OpenSuperWhisper's dictations (each recording and a checked copy of the database of their transcripts), never a tool's sign-in or secrets files; then the encrypted restic snapshot of the archive's folder on the NAS, kept a week, and beside it a snapshot of the folder's transcripts/ and llm/ alone, tagged llm-transcripts and never forgotten. Says what it took and what it could not read.
  Files: `server/nas-backup.ts`, `server/archive/nasBackup.ts`, `server/archive/transcripts.ts`.
  data.md: "The NAS copy".
- **Data check** (npm run check-data): The life archive's check-data checks the person table, the tag table, the catch-ups, logged calls and drafts, and names each person with a problem; friend-map's check-settings checks its own settings file alone.
  Files: `server/check-data.ts`.
  friend-map's files: `server/check-settings.ts`.
  running.md: "Checking the data".

### Connectors

*how they get in.* From an export, an app's database or the live Telegram and WhatsApp bridges: one connector for each way in, each its own child process, and everything goes through one host and one writer into one archive.

- **Connector switches** (settings file): connectors/<id>.json in the archive's folder turns each connector on or off (a missing file is off) and holds its settings, such as selfName or contacts.
  data.md: "Where the data lives".
- **Connector host** (server/connectors): Finds connectors by their manifest.ts, runs each import in its own child process (memory cap, one-hour limit), reads one JSON event per line from its stdout, checks every event against the contract, and spools them to disk. A crash, hang or bad event fails that import alone, with a backoff; the archive is left as it was. A sync connector runs with the server while switched on and its companion answers: each batch is applied at its checkpoint with the cursor, commands go to it on stdin, and it is restarted after a growing wait. Only one process runs the sync connectors on an archive: it keeps an owner record with a heartbeat in meta (live_owner), and another waits until it stops, dies or its heartbeat stands still.
  Files: `server/connectors/host.ts`, `server/connectors/sync.ts`, `server/connectors/liveLock.ts`, `server/connectors/runtime.ts`, `server/connectors/contract.ts`, `server/connectors/lines.ts`.
  Tables: `source`, `connector_state`, `meta`.
  archive.md: "The message archive".
- **Import writer** (server/archive): Applies a whole import's checked events in one transaction: import people, chats and members, messages (new, edited or unsent, and the same message from another connector kept once), reactions, attachments and what the import covers; and the event index's events, keyed on their source's own ids (a workout event is refused: those are the exercise module's, applied to its own database by its `apply`, `modules/exercise/server/apply.ts`, through the host's ledger for it). Then, after a chat platform's import, the rules run.
  Files: `modules/friend-map/server/write.ts`, `server/archive/events.ts`.
  Tables: `source`, `import_person`, `conversation`, `conversation_member`, `message`, `message_alias`, `message_version`, `reaction`, `attachment`, `coverage_span`, `event`, `device`, `llm_session`, `llm_turn`, `ritual_checkin`, `ritual_habit`, `ritual_day`, `ritual_workouts` (and, until `npm run archive -- migrate friend-map-module --apply`, the friend map step's move, drops them, the `workout` and `deleted_workout` rows from before exercise was a module; `server/archive/legacy.ts`).
  archive.md: "The message archive".

#### Matrix bridge framework

*shared by every live network.* Live sync from chat networks, option A, and what every bridge has in common, drawn once: mautrix bridges write into a local Tuwunel chat server, which the archive's matrix-bridge and matrix-whatsapp connectors read as a Matrix client. Telegram and WhatsApp (read only) are live; the others would each be one more bridge in the rig. Each bridge is linked to the account as a device of its own, so the desktop apps need not run; the rig starts at login, collects while the archive's server is down, and needs the Mac awake and online.

- **mautrix-go bridgev2** (3 · shared framework): The same in every bridge: the event queue, de-duplication, a small database of chats, people and messages (the same tables in every bridge, which matrix-bridge and matrix-whatsapp read read-only for message ids), history scheduling and retries.- **Matrix connector** (4 · Matrix connector): The output side: turns chats into rooms and people into users on the chat server, and says how each message sent from Matrix went (message status events, on in the rig). Swappable: option B would replace it.- **friend-map connector** (option B · layer 4) *(planned)*: A connector of friend-map's own in place of the Matrix connector, writing straight into friend-map through the connector host, with no chat server.- **Tuwunel** (5 · chat server): The captain's own local Matrix chat server: one store for every network. It listens on 127.0.0.1 only, with federation and sign-up off.- **The bridge rig** (where they run): ~/.local/share/friend-map-bridge-lab/: mautrix-telegram, mautrix-whatsapp (with one local change: nothing it does on friend-map's behalf marks a chat read) and Tuwunel built from pinned commits, run on 127.0.0.1 only, apart from friend-map, as three launchd agents in ~/Library/LaunchAgents (service.sh installs them; definitions in its launchd/): com.friend-map.bridge-rig.homeserver, .whatsapp and .telegram. They start at login and are started again 30 s after stopping with an error, so they keep collecting while the archive's server is down. Nothing runs while the Mac sleeps or is offline; on waking they catch up from the networks. matrix-bridge and matrix-whatsapp read it as the captain's Matrix user, each as its own device, and each bridge's database read-only for its ids. Another network is another bridge here.
  archive.md: "The message archive".
  See also: The rig's own README: ~/.local/share/friend-map-bridge-lab/README.md.
- **Any Matrix app** (6 · reader): Reads and sends through the chat server like any chat app.
#### Event sources

*beyond chats.* Sources of the life archive's event index that are no chat platform: the captain's conversations with agents, firstmate's (Claude Code's session files) and his Grok Bot bots' (the desktop app's cache), his evening check-ins, habit times and the workouts he logs (rituals), on this Mac, and his workouts (Polar). For the agents' conversations the archive keeps its own copy of each conversation in llm/<origin>/ in the archive's folder, only ever added to, and reads only the copy; its server follows the sources live, watching their folders (a pass about 2 s after a change settles), and reads them all again when it starts and every hour. They bring no messages and no people: when, how long, which model and where the content is, never the content.

- **Claude Code's sessions** (session files): ~/.claude/projects/<project folder>/<session id>.jsonl: one JSON entry per line, only ever added to, with each entry's time, model and how the session was run (cli or claude-desktop when someone was at it, sdk-* when headless). Copied byte for byte into the archive's own llm/claude-code/, only ever appended to, and read only from the copy; tier 2, so their text is read only through event-content.
  events.md: "The event index".
- **llm-sessions** (connector): Reads the session files of the projects in its settings (the archive's llmSessions.projects unless said), leaving out headless runs, sessions in another folder and those with no prompt from the captain: each session, each prompt he wrote (origin human) and each reply (the model's entries after what started the turn), keyed on Claude Code's own ids, with times, model, length in characters and where its lines are in the file. Never the text: the host refuses an event of it that carries any.
  Files: `server/connectors/llm-sessions/manifest.ts`, `server/connectors/llm-sessions/main.ts`, `server/connectors/llm-sessions/read.ts`, `server/connectors/llm-sessions/entries.ts`, `server/fixtures/llm-sessions.ts`.
  events.md: "The event index".
- **Grok Bot's cache** (app cache): The Grok Bot desktop app's cache, ~/Library/Application Support/Grok Bot/sand-client-persistence/: one .blob of JSON per bot holding its chat's last 200 entries, written whole on each change, and the app's roster of bots. Never a draft, the settings or the sign-in files. Logged entry by entry into the archive's own llm/grok-bot/<bot id>.jsonl, only ever appended to; tier 2, so their text is read only through event-content.
  events.md: "The event index".
- **grok-bot** (connector): Reads each bot's chat from the archive's copy as three kinds of session: the chat window, each finished call's transcript, and backstage on each call; each prompt the captain wrote and each reply, keyed on the app's own ids, with times, model and length in characters. A chat in a shape it does not know is not read. Never the text: the host refuses an event of it that carries any.
  Files: `server/connectors/grok-bot/manifest.ts`, `server/connectors/grok-bot/main.ts`, `server/connectors/grok-bot/read.ts`, `server/connectors/grok-bot/entries.ts`, `server/fixtures/grok-bot.ts`.
  events.md: "The event index".
- **Rituals** (the rituals module's store): Rituals' own store, modules/rituals/data/ritual.sqlite3 in the archive's folder, written by rituals' own bin/ritualctl (the one write path, which G and firstmate log through) and read by the module in-process, read-only, through rituals' own view (what bin/ritual-view printed: every rule applied). Its two tabs (Events' Daily rituals, Fitness's Habits) read it so: only what rituals' own dashboard served (/life-archive/api/m/rituals/dashboard: no target's notes, no one who logged them, no habit times). The module pushes its rows into the calendar itself: each habit done a moment (keyed on rituals' id, or tick/<day>/<habit> for a habit a day ticks done with no doing of it), each day rituals shows a summary of which habits and required checks (by id) were done, not done or not reported yet, for the Events calendar's Rituals row; a watch looks at the store every 20 seconds while the server runs and pushes them whole when it changed, or every five minutes. The workouts he logs there are the RitualWorkouts service, which the Fitness page asks for. The rituals connector that indexed the store from another checkout is gone; the archive's ritual_* rows from it stay until `migrate friend-map-module` (the friend map step's move) drops them.
  Files: `modules/rituals/module.ts`, `modules/rituals/server/view.ts`, `modules/rituals/server/calendar.ts`, `modules/rituals/server/watch.ts`, `modules/rituals/server/workouts.ts`, `modules/rituals/server/service.ts`, `modules/rituals/server/http.ts`, `modules/rituals/server/habitsTab.ts`, `modules/rituals/src/view.ts`, `modules/rituals/src/store.ts`, `modules/rituals/bin/ritualctl`, `modules/rituals/fixtures/rituals.ts`.
  Tables: rituals' own, in its store: `rituals`, `habit_events`, `workouts`, `reminders`, `applicability_exceptions`, `ritual_attachments`, `ritual_attachment_checks`, `weekly_targets`, `weekly_target_entries`, `changes`, `source_documents`, `legacy_checkpoints`, `imports`, `schema_migrations`.
  features.md: "Rituals".
- **Polar** (AccessLink and account export): The captain's workouts from Polar Flow, two ways: Polar's AccessLink API as his own registered client, after one login (npm run exercise -- polar login; its token in the Keychain), which sees only the last 30 days; and Polar's account export (Download your data), unpacked in its folder, for the history before. Both connectors are the exercise module's (modules/exercise/connectors/), run by the core's host as its own are; each import is applied to the module's own database and what it changed pushed into the calendar.
  events.md: "Workouts from Polar".
- **polar** (connector): Looked at when the server starts and every 3 hours: each exercise kept as Polar gave it, its JSON and FIT file in platform-exports/polar/accesslink/, and one workout event for the exercise module's index, saying which sample streams it holds; never one the captain deleted (its tombstones come in its settings), not even fetched. A 401 shows as reconnect needed. Never a heart rate or a coordinate.
  Files: `modules/exercise/connectors/polar/manifest.ts`, `modules/exercise/connectors/polar/main.ts`, `modules/exercise/connectors/polar/read.ts`, `modules/exercise/connectors/polar/api.ts`.
  events.md: "Workouts from Polar".
- **polar-export** (connector): Polar's account export, read in place: each training session one workout event, its file kept where it is, saying which sample streams it holds; none the captain deleted. Never a heart rate or a coordinate.
  Files: `modules/exercise/connectors/polar-export/manifest.ts`, `modules/exercise/connectors/polar-export/main.ts`, `modules/exercise/connectors/polar-export/read.ts`.
  events.md: "Workouts from Polar".

#### Live connectors

*sync connectors.* The archive's own Matrix clients, one per live network: each walks history, then follows a long sync from its saved cursor.

- **matrix-bridge** (sync connector): Telegram, live, as the archive's own Matrix client (option A of the chat bridges, through which every bridge arrives): walks each bridged room with /messages, then follows a long /sync (next_batch as its cursor, saved with each batch, so after a restart or a time with the server down it goes on from there and nothing the bridge collected meanwhile is missed). Rooms are chats by the bridge database's record of them (its portal table), @telegram_<id> ghosts are accounts, ids come from the bridge's database; groups of more than 12 (the archive rules' small-group line) and broadcast channels are not read. The bridge's notice for a call ("Call ended (12 minutes)") is a call record with its length, and its notice of a call ringing a system message. Sends text when the host commands it, and its Matrix client can never send read receipts, typing or presence. Each network is a profile (rig.ts) over the same reader, with a Matrix device of its own.
  Files: `modules/friend-map/connectors/matrix-bridge/manifest.ts`, `modules/friend-map/connectors/matrix-bridge/main.ts`, `modules/friend-map/connectors/matrix-bridge/read.ts`, `modules/friend-map/connectors/matrix-bridge/client.ts`, `modules/friend-map/connectors/matrix-bridge/bridgeDb.ts`, `modules/friend-map/connectors/matrix-bridge/map.ts`, `modules/friend-map/connectors/matrix-bridge/rig.ts`, `modules/friend-map/fixtures/matrix.ts`.
  archive.md: "The message archive".
- **matrix-whatsapp** (sync connector): WhatsApp, live and read only, with matrix-bridge's reader and the WhatsApp profile: chats and people keyed by phone number as whatsapp-db keys them (the bridge keys most by LID; its database's LID map, read read-only, gives the number), and a message's id its stanza id, so a message imported and bridged is one. The same rules as Telegram's for groups and channels (and communities are not read). The bridge passes on no call's length or outcome, so calls come from whatsapp-db. It never sends: the composer offers no WhatsApp chat and a send is refused.
  Files: `modules/friend-map/connectors/matrix-whatsapp/manifest.ts`, `modules/friend-map/connectors/matrix-whatsapp/main.ts`, `modules/friend-map/connectors/matrix-bridge/rig.ts`, `modules/friend-map/connectors/matrix-bridge/bridgeDb.ts`.
  archive.md: "The message archive".

#### Import connectors

*exports and app databases.* One per export or app database: Messenger's two, Instagram's, X, Signal and Discord's exports, and WhatsApp's, Messages' and WeChat's databases. Each reads its source in place or from a copy.

- **What connectors share** (shared code): Keeping an export's media where they are (hashed, never copied), copying live media by content hash into the platform's live folder with a ledger of copies made, reading zips, reading an app's SQLite database from a copy, the address book (the Mac's Contacts or the iPhone's), an iPhone backup's files (Finder's on this Mac, another folder, or one over ssh), and Meta's download format (Facebook's and Instagram's: its parts, folders and escaped strings).
  Files: `server/connectors/media.ts`, `server/connectors/zip.ts`, `modules/friend-map/connectors/appDb.ts`, `modules/friend-map/connectors/addressBook.ts`, `modules/friend-map/connectors/iphoneBackup.ts`, `modules/friend-map/connectors/metaDyi.ts`, `modules/friend-map/connectors/metaDyiParts.ts`.
  wiring.md: "How it is wired".

##### Exports

*what a platform gives.* One per platform's export of your data: Messenger's two, Instagram's, X's, Signal's and Discord's. Each reads it in place, unpacked under platform-exports/.

- **messenger-export** (connector): Reads the phone export. With no message ids, messages get ids made from their content, and accounts are keyed by name.
  Files: `modules/friend-map/connectors/messenger-export/manifest.ts`, `modules/friend-map/connectors/messenger-export/main.ts`, `modules/friend-map/connectors/messenger-export/read.ts`.
  archive.md: "The message archive".
- **facebook-dyi** (connector): Reads the download unpacked beside its zip parts, as one export, through Meta's shared reader, and marks Marketplace chats; each attachment points at its file in the export. Shares Messenger with messenger-export: a message both bring is kept once (message_alias).
  Files: `modules/friend-map/connectors/facebook-dyi/manifest.ts`, `modules/friend-map/connectors/facebook-dyi/main.ts`, `modules/friend-map/connectors/facebook-dyi/read.ts`, `modules/friend-map/connectors/overlap.test.ts`.
  archive.md: "The message archive".
- **instagram-dyi** (connector): Reads the unpacked download through Meta's shared reader, accounts keyed by name as Messenger's are. Copies nothing: each attachment points at its file in the export (refused anywhere but platform-exports/).
  Files: `modules/friend-map/connectors/instagram-dyi/manifest.ts`, `modules/friend-map/connectors/instagram-dyi/main.ts`, `modules/friend-map/connectors/instagram-dyi/read.ts`, `modules/friend-map/fixtures/instagram-dyi.ts`.
  archive.md: "The message archive".
- **x-archive** (connector): Reads the archive's direct messages in place, keyed on X's own ids (user, conversation and message ids). Names people from the captain's tweets that mention them, else stands in their id; tweets, followers and following are never people.
  Files: `modules/friend-map/connectors/x-archive/manifest.ts`, `modules/friend-map/connectors/x-archive/main.ts`, `modules/friend-map/connectors/x-archive/read.ts`, `modules/friend-map/fixtures/x-archive.ts`.
  archive.md: "The message archive".
- **signal-export** (connector): Reads the export's frames in place, keyed on Signal's own ids (ACI, a hash of a group's master key, a message's sender and sent time). Names people as Signal does, with their phone numbers as handles; the captain is the group member with no contact of his own.
  Files: `modules/friend-map/connectors/signal-export/manifest.ts`, `modules/friend-map/connectors/signal-export/main.ts`, `modules/friend-map/connectors/signal-export/read.ts`, `modules/friend-map/fixtures/signal-export.ts`.
  archive.md: "The message archive".
- **discord-package** (connector): Reads the package in place, keyed on Discord's own ids (user, channel and message snowflakes, a message's giving its time sent). Marks every chat self-only, so the archive rules never read the others' missing side as silence; names people by username unless the Account section gives more.
  Files: `modules/friend-map/connectors/discord-package/manifest.ts`, `modules/friend-map/connectors/discord-package/main.ts`, `modules/friend-map/connectors/discord-package/read.ts`, `modules/friend-map/fixtures/discord-package.ts`.
  archive.md: "The message archive".

##### App databases

*what an app keeps.* One per app's own databases, taken from the iPhone backup or the Mac app: WhatsApp's, Messages' and WeChat's. Each reads a copy, never the original.

- **whatsapp-db** (connector): Reads WhatsApp's databases from a copy, keyed on WhatsApp's own ids: accounts by phone JID or LID, chats by JID, messages by stanza id, and each call, from its chat's call record or the Calls tab, by its call id, as a call record with its length; a three-way call outside any group is a call in no chat (a call event) with everyone on it the copy has a chat with, the rest counted unnamed. For the Mac app's copy, calls alone (only: calls), placed by the chats' call records and only where the copy bears out who a call only the Calls tab has was with (callsFrom: chats), with LIDs from the bridge's database (bridgeDb).
  Files: `modules/friend-map/connectors/whatsapp-db/manifest.ts`, `modules/friend-map/connectors/whatsapp-db/main.ts`, `modules/friend-map/connectors/whatsapp-db/read.ts`.
  archive.md: "The message archive".
- **imessage-db** (connector): Reads the Messages app's database from a copy: accounts by handle, messages by guid, tapbacks as reactions, text from attributedBody when needed.
  Files: `modules/friend-map/connectors/imessage-db/manifest.ts`, `modules/friend-map/connectors/imessage-db/main.ts`, `modules/friend-map/connectors/imessage-db/read.ts`, `modules/friend-map/connectors/imessage-db/typedstream.ts`.
  archive.md: "The message archive".
- **call-history** (connector): Reads the call history from a copy: each phone or FaceTime call with one other party, keyed on its own id, with its time, how long it was connected, which way, answered or not. The other party is an account keyed by number or Apple ID as imessage-db keys one, so the rules put it on whoever holds that number on iMessage; other apps' calls, group calls and withheld numbers are counted and left out.
  Files: `modules/friend-map/connectors/call-history/manifest.ts`, `modules/friend-map/connectors/call-history/main.ts`, `modules/friend-map/connectors/call-history/read.ts`, `modules/friend-map/fixtures/call-history.ts`.
  archive.md: "The message archive".
- **wechat-ios** (connector): Reads WeChat's iPhone databases from a copy, keyed on WeChat's own ids: accounts by wxid (named by the captain's remark, else their nickname), chats by id, messages by MesSvrID. The captain is the id whose md5 names the account's folder; a group message's sender is the id its content starts with. A call record's words give its length ("通话时长 12:05"), or 0 when it never connected ("Declined"). Content WeChat compressed with its own dictionary is read only when that dictionary is given: without it, a message is kept without content when its sender is known anyway (a call then without a length), and a group message from someone else is skipped, both counted.
  Files: `modules/friend-map/connectors/wechat-ios/manifest.ts`, `modules/friend-map/connectors/wechat-ios/main.ts`, `modules/friend-map/connectors/wechat-ios/read.ts`, `modules/friend-map/connectors/wechat-ios/records.ts`, `modules/friend-map/fixtures/wechat.ts`.
  archive.md: "The message archive".

### The archive

*the archive's folder (LIFE_ARCHIVE_DATA).* The core's own database (core.sqlite), the calendar (calendar.sqlite), each module's database in modules/<id>/, friend map's archive among them (every message and the captain's record of people), the media beside them, and backups. Only the core's server/archive/ and the modules' own code know SQL.

- **The core's database** (core.sqlite): The core's own SQLite database (Node's built-in node:sqlite, WAL), as the migrations in server/archive/coreDb.ts make it: the event index of the agents' sessions, prompts and replies (`event`, `llm_session`, `llm_turn`, `device`), every LLM tool's on this Mac among them since the LLM warehouse (server/llm/: their measures, facts and tags, `llm_tag`, and its bookmarks, `llm_file`; events.md, "The LLM warehouse"), the core connectors' runs and cursors (`source`, `connector_state`, llm-sessions' and grok-bot's). Nothing in it names a person. Until the friend map step these tables were the archive's own, in archive.sqlite; `npm run archive -- migrate friend-map-module` copied them out once. It still holds the inspirations' tables and their change log as they were until 8 November 2026, read by nothing since the inspirations module took them over, kept until the captain says they may go.
  Files: `server/archive/coreDb.ts`, `server/archive/coreWrite.ts`, `server/archive/index.ts`.
  Tables: `event`, `llm_session`, `llm_turn`, `llm_tag`, `llm_file`, `device`, `source`, `connector_state`, `meta`.
  data.md: "Where the data lives".
- **Friend map's archive** (modules/friend-map/archive.sqlite): The friend map module's database: every message, every import person and the captain's own record of people (Node's built-in node:sqlite, WAL, full-text search), as the migrations in modules/friend-map/server/db.ts make it, which the module opens itself (its `database.open`) and nothing opens while an archive.sqlite from before the module is still at the folder's root. Open it for its tables: they are drawn from the code, and their notes are hand-written.
  Files: `modules/friend-map/server/db.ts`, `modules/friend-map/module.ts`, `modules/friend-map/server/schema.ts`, `server/archive/migrate.ts`.
  data.md: "Where the data lives".
- **The exercise module's database** (modules/exercise/exercise.sqlite): The first module's own store, in modules/<id>/ of the archive's folder, which the core opens before the archive and brings up to date with the module's own migrations (server/modules/store.ts): its index of workout copies (`workout`), its tombstones (`deleted_workout`) and its connectors' runs and cursors (`source`, `connector_state`), and the core's `meta` (with when its rows were taken over from the archive). The NAS backup sends a checked copy of it each night.
  Files: `server/modules/store.ts`, `modules/exercise/server/db.ts`, `modules/exercise/server/workoutIndex.ts`.
  Tables: its own `workout`, `deleted_workout`, `source`, `connector_state` and `meta`.
  features.md: "Exercise".
- **The journal module** (modules/journal/ · the vault): The owner's Obsidian vault, `Vault` in the archive's folder (a folder, or a link to one elsewhere, such as Obsidian's iCloud Drive folder; read here only by the Journal page's routes, a day as it is opened, each read in the trail of content reads), and the voice journals transcribed into its Journals/ on the Mac each day at 06:00, each recording Voice Memos has synced and the owner has not deleted, by a launchd job of the module's own (`npm run journal`: the agent local.life-archive-voice-journal and the launcher Full Disk Access is given to, built from the core's launcher.c through the SDK), which copies the recording into the vault's assets, transcribes the copy with the core's transcribers (OpenSuperWhisper, then Nemotron when it is here), writes the raw transcripts and the journal-source-v1 record, and tells the notifier (FirstMate's inbox where the installation has one); its ledger of recordings done is modules/journal/ledger.json. A second job of its own (`npm run journal -- grok-calls`, the agent local.life-archive-voice-calls, once rituals') copies each finished call in Grok Bot's cache into Journals/raw/, where Grok Bot is used, when the cache changes and every 30 minutes, each file once. No database and no rows in the calendar; its routes serve the Journal page, read-only.
  Files: `modules/journal/module.ts`, `modules/journal/cli.ts`, `modules/journal/jobs/voice-journal/round.ts`, `modules/journal/jobs/voice-journal/recordings.ts`, `modules/journal/jobs/voice-journal/ledger.ts`, `modules/journal/jobs/voice-journal/live.ts`, `modules/journal/jobs/grok-calls/round.ts`, `modules/journal/jobs/grok-calls/live.ts`, `server/voiceTools.ts`, `server/jobs.ts`, `server/notifier/notifier.ts`, `server/launcher.c`.
  features.md: "Journal".
- **The calendar** (calendar.sqlite): The core's own small index of what happened, which the Events page's tables and calendar read rather than asking each part live: every call, hangout, agent session, prompt and reply, workout copy (from what the exercise module's `apply` answers, pushed by the host under its name) and habit done (the rituals module's, pushed by its watch from its store) as a moment, and a day's summaries (whom he messaged and how many messages, friend map's; how each ritual's day went, rituals'), keyed on the module that pushed them and the source's own id, so a push again changes nothing. Pushed after each import, the people rules, each edit and each change of rituals' store; rebuilt whole from the archive and the modules' stores when new (`npm run archive -- calendar rebuild`, `calendar check` for the drift). Never content, never a name: the people on a row are the owning module's ids, named at read time through its two hooks (labelPeople, detail). It holds the trail of content reads too, which is not derived: a rebuild leaves it alone, and the NAS backup sends a checked copy of the file.
  Files: `server/calendar/db.ts`, `server/calendar/sink.ts`, `server/calendar/push.ts`, `server/calendar/rows.ts`, `modules/friend-map/server/calendarRows.ts`, `server/calendar/eventIndex.ts`, `server/calendar/owners.ts`.
  Tables: its own `event`, `content_read` and `meta`.
  events.md: "The calendar".
- **People, tags and rules** (modules/friend-map/server): Links each import person to a person, runs the rules (link new accounts, join exact names, the archive rules, merge proposals) after every import, and makes every edit: names, aliases, tags, locations, notes, reaching out, catch-ups (the page's hangouts), the calls he logs, the lengths he gives calls whose app says none, the notes he gives calls, whether an imported call was answered as he says, merges and "Not them". It keeps his drafts too, which are no edit.
  Files: `modules/friend-map/server/people.ts`, `modules/friend-map/server/tags.ts`, `modules/friend-map/server/locations.ts`, `modules/friend-map/server/catchUps.ts`, `modules/friend-map/server/manualCalls.ts`, `modules/friend-map/server/drafts.ts`, `modules/friend-map/server/archiving.ts`, `modules/friend-map/server/stats.ts`, `server/archive/names.ts`, `modules/friend-map/server/personFields.ts`, `modules/friend-map/server/addressBookNotes.ts`.
  Tables: `person`, `import_person`, `tag`, `person_tag`, `catch_up`, `catch_up_person`, `manual_call`, `draft`, `call_length`, `call_note`, `call_answered`, `group_unlink`, `merge_proposal`, `import_person_stats`, `meta`.
  people.md: "People".
- **Change log and bulk edits** (server/archive, over friend map's archive and the inspirations module's database): Every edit to people (in friend map's archive) and to the captain's inspirations (in modules/inspirations/inspirations.sqlite), from the app's routes, the archive's viewer or the CLI, is one changeset: when, from where, what, the captain's words when an agent passed them, and every row it changed before and after (logged by triggers only while it is recorded), so it can be shown and undone exactly; an undo is refused, naming who, when any of it has changed since. Kept 90 days. Bulk edits (npm run archive -- edit) choose people with the Query language, dry run first.
  Files: `server/archive/changes.ts`, `modules/inspirations/server/changeLog.ts` (how the inspirations' changes are said), `modules/friend-map/server/edits.ts`.
  Tables: `changeset`, `change_row`.
  people.md: "Changing data from a chat".
- **Inspirations store** (modules/inspirations/server): The only code on the inspirations' tables, in the inspirations module's own database (modules/inspirations/inspirations.sqlite, which took them over once from core.sqlite, ids and change history kept); the host reaches the rest of the module through its module.ts (its routes, work, commands, checks, demo and made-up data), as any module's, and `boundary.test.ts` holds that nothing outside reads its tables or kept files. A capture (the share sheet's route, or npm run archive -- inspiration add from the Grok Bot agent or a terminal) reduces the link to one canonical form, finds or makes the item by it (a photo with no link by its content hash, the file kept in modules/inspirations/files/), records the save and adds his words (verbatim: the first save's words are the caption, a later save's added after them, never replacing them) and tags, with no changeset, as an import; his edits (caption, tags, hidden, his vocabulary), from the page or the CLI, are changesets. Items kept before 8 November 2026 may carry a probe (when firstmate was told his words asked for something to be done, and a result link); they are only read now, nothing sets them. Lists filter by his tags or the AI's (never both), words, or a platform; the counts the page heads include each platform's.
  Files: `modules/inspirations/server/store.ts`, `modules/inspirations/server/links.ts`, `modules/inspirations/server/cli.ts`, `modules/inspirations/server/part.ts`, `modules/inspirations/server/db.ts`, `modules/inspirations/server/files.ts`, `modules/inspirations/module.ts`.
  Tables: `inspiration`, `inspiration_save`, `inspiration_file`, `inspiration_tag`, `inspiration_item_tag`, `inspiration_ai_tag`.
- **Backups** (backups/): npm run archive -- backup <label> copies the core's database with VACUUM INTO to <date>T<time>-<label>.sqlite (local time) and checks it, and each module's database beside it to <date>T<time>-<label>.<its file's name> (friend map's archive as .archive.sqlite). The prune, which keeps or deletes them as one backup: over 48 hours old goes, and of the rest only the newest of each local day and every before-import-* one stay. The server prunes once at start.
  Files: `server/archive/backups.ts`.
  data.md: "Backups".
- **Every LLM transcript** (transcripts/): Every LLM tool's transcripts on this Mac as the tool wrote them, so none is lost when its tool deletes it (Claude Code's after 30 days): <source>/<its path>.zst, zstd that gives back the file's bytes exactly, with each source's index beside it. Only ever grows: what a tool adds is appended as a frame, a rewritten file is a version beside the earlier, and a file its tool deleted stays, marked gone. Each night's state of it (and of llm/) is also kept on the NAS for good, in the night's job's llm-transcripts snapshot. Content: read only when the captain asks.
  Files: `server/archive/transcripts.ts`.
  data.md: "Every LLM transcript".
- **Old media copies** (archive/media/): The copies connectors made by content hash before platform-exports/: read while an attachment points at one, never written. npm run archive -- media repoint points attachments at the same file in their export (or a live home) and lists the copies nothing points at, which only the captain deletes.
  Files: `server/archive/mediaPaths.ts`, `modules/friend-map/server/repoint.ts`.
  Tables: `attachment`.
  data.md: "Where the data lives".
- **Platform exports** (platform-exports/): Every platform's exports, <platform>/<export date>/, their zips kept beside what they unpack to, and <platform>/live/ for media with no export behind them (what a live bridge downloads), by content hash. Each attachment points at its file here, in the newest export holding it, so there is one copy; the server serves attachments only from here and the old copies. npm run archive -- storage tells what each platform holds.
  Files: `server/archive/mediaPaths.ts`, `modules/friend-map/server/platformExports.ts`, `modules/friend-map/server/storage.ts`, `server/connectors/media.ts`.
  data.md: "Where the data lives".

### The app

*localhost:4650.* One server, the archive's: through the friend map module it reads the archive two ways (structure, and message text) and serves friend-map's page under /friend-map/: Orbits and the other map views, and the panels. Sending is off for now: the send executor refuses every send, and the person panel has a draft box in the composer's place.

- **The archive's server** (life-archive · npm start): The life archive's project (~/Projects/life-archive, a repository of its own on this Mac) runs it, as the launchd agent local.life-archive, which starts it at login and again whenever it stops, on port 4650 of this Mac alone: the only process that opens the archive. It answers /api/archive/ and /friend-map/ through the friend map module (its mounts and its page), runs the live connectors and Codex, and prunes the backups when it starts. While it is down or starting again, the bridge rig keeps collecting, and the live connectors go on from their saved cursors when it is back.
  Files: `server/main.ts`, `server/archive/server.ts`, `modules/friend-map/server/http.ts`.
  running.md: "Running".
  - **AI service (Codex)** (codex app-server): Every AI request goes through it, the Query bar's Generate first: codex app-server on the captain's ChatGPT plan (no API key), started with the server and kept running, read-only in a scratch folder outside the repo and the data folders, with no approvals and the captain's MCP servers, apps and plugins off. Generate tells it the SQL views' and tables' columns with what they mean, every tag and each field's values with how many have them, the current query and the transcript, never anyone's name, note or messages, and gets back SQL and what it left out. Started again after a growing wait when it stops or is signed out.
    Files: `server/ai.ts` (the service and which adapter answers), `server/codex.ts`, `modules/friend-map/server/queryWriter.ts`.
    queries.md: "The AI service".
  - **Structure** (read path): People, reports, the Table's rows, the score report friend-map works out closeness from, and the Calendar's days: names, counts and dates, never message text. The message-derived part of the reports is kept in the derived table until messages or links change; a Calendar month is counted from the messages' message_time index (by when each was sent, with its chat, sender and type), reading only that month.
    Files: `modules/friend-map/server/structure.ts`, `modules/friend-map/server/calendarView.ts`.
    Tables: `person`, `import_person`, `import_person_stats`, `conversation`, `conversation_member`, `message`, `reaction`, `derived`, `coverage_span`, `source`, `call`, `call_length`, `call_note`, `call_answered`, `manual_call`, `catch_up`, `catch_up_person`.
    friend-map's docs: `docs/docs/views.md`.
  - **Content** (read path): Message text: a person's timeline a page at a time, a chat's messages, a chat's day for the Calendar, search, and attachment files. Only served under /api/archive/content/, so a stricter rule can be put on that path alone, and to the CLI's timeline and search; every read, from either, is kept in the trail of content reads (content_read, in the calendar's file), with who read it and why. The text of the captain's conversations with an LLM is in no table: the CLI's event-content reads it from the session file where the event index says it is, checked to be what was imported, into the same trail. The SQL queries never read content: their authorizer refuses message text, original records, the search index, catch-ups' and calls' notes and drafts.
    Files: `modules/friend-map/server/content.ts`, `server/archive/contentLog.ts`, `server/archive/redact.ts`, `server/archive/llmContent.ts`.
    Tables: `message`, `message_fts`, `attachment`, `reaction`, `conversation`, `call_length`, `call_note`, `call_answered`, `llm_session`, `llm_turn`.
    archive.md: "The message archive".
  - **Inspirations worker** (modules/inspirations/server): The inspirations module's work, a fiber of the archive's server: within a few seconds of a capture it fetches the item's preview (YouTube's and X's public oEmbed, any other page's own meta tags; never anything behind a login, this Mac, the local network or an address alone), and, once started by hand (npm run archive -- inspiration instagram start), an Instagram save's words and one small picture from the post's public embed page, logged out, one post at a time at a slow pace (inspiration_fetch) and asks the AI service for two to five AI tags, from his caption and everything known of it, steered by his vocabulary, kept apart with the model and when (asked again when a preview lands after them with more of what is known). It tells no one anything: a caption that asks for something to be built is kept and tagged like any other, never sent on. An AI that cannot answer is tried again after a growing wait, and given up on after six tries until asked again.
    Files: `modules/inspirations/server/worker.ts`, `modules/inspirations/server/previews.ts`, `modules/inspirations/server/instagram.ts`, `modules/inspirations/server/aiTags.ts`.
    Tables: `inspiration`, `inspiration_ai_tag`, `inspiration_tag`, `inspiration_file`, `inspiration_fetch`.
  - **Inspirations page** (/life-archive/dev/inspirations): The console's Inspirations, on this Mac and on the tailnet: Platforms (how many platforms the items come from, a bar each with its icon and count, the most first, each opening Recent narrowed to it), Recent, By tag (his or the AI's, never both), Search, Untagged, Tags (his vocabulary) and Changes, with an item panel to edit his caption and tags, make the AI's again, see the probe an old item carries (when firstmate was told, and the result's link; a card says "probe asked" or "probe · result"), see every save, and hide it. Its routes under /life-archive/api/inspirations are the viewer's first that write, scoped to inspirations alone: a write is answered only to a Host the door admits and only from the page itself (a JSON body and an Origin naming this server), and the tailnet is the guard: no login is checked. Every edit is one changeset, with Undo. The share sheet's capture route (POST /life-archive/api/inspirations/capture: a form or JSON with the link, text or file, and his words) lives beside them, asks for no Origin (a shortcut is not a page; a page elsewhere is still refused by its browser's Sec-Fetch-Site or Origin) and answers at once, the worker doing the rest.
    Files: `modules/inspirations/server/http.ts`, `modules/inspirations/viewer.tsx`, `modules/inspirations/viewer/InspirationsSection.tsx`, `modules/inspirations/viewer/InspirationsView.tsx`, `modules/inspirations/viewer/api.ts`.
    Tables: `inspiration`, `inspiration_save`, `inspiration_file`, `inspiration_tag`, `inspiration_item_tag`, `inspiration_ai_tag`, `changeset`, `change_row`.
  - **Shopping** (the shopping module, modules/shopping · /life-archive/dev/shopping): The console's Shopping, its pilot On special: every supplier's specials in one layout. The module's work, a fiber of the archive's server, pulls every supplier each morning at 08:00 local time (once at start when today has none, and on the page's Refresh), each through its storefront's public feed (Shopify's products.json or collection page, Shopify's Storefront API with the public token a headless storefront's own page carries, WooCommerce's Store API, a Wix page), keeps every in-stock product marked down or on a supplier's own specials list, and keeps each pull whole in the archive's folder (shopping/pulls/), never in the archive. No message, person or content is read; the specials are public prices.
    Files: `modules/shopping/module.ts`, `modules/shopping/server/pull.ts`, `modules/shopping/server/fetch.ts`, `modules/shopping/server/parse.ts`, `modules/shopping/server/suppliers.ts`, `modules/shopping/server/http.ts`, `modules/shopping/wire.ts`, `modules/shopping/viewer/ShoppingSection.tsx`, `modules/shopping/viewer/format.ts`.
    features.md: "Shopping".
  - **Console** (/life-archive/dev): The life archive's front end, the archive's viewer: a rail of aspects, one level (each an angle on the whole archive, not a bucket of it, so a view may sit under several), each aspect's views its page's own tabs along the top of its surface, the surface beside it the screen's whole height, drawn with one set of blocks (KPIs, cards, a bar chart, facts, a table), premium white by day and true black at night, on a phone a bar along the bottom (the mark at the left, a dropdown of the pages at the right) with the page's tabs above it, and Jump to (⌘K). On a desk the captain drags the aspects into an order of his own (or moves one with Option+↑↓), kept on that device, which the phone's dropdown and Jump to follow (the home stays Events wherever it puts it); a phone shows it but does not change it. Its views are one typed registry, so adding one is one entry. Its rail is the captain's, Events first: Journal (the journal module's Days: the journals of his Obsidian vault, read-only, a day read only as he opens it, Obsidian their editor), Friend Map (the friend map module's: friend-map's page embedded, at the same host's /friend-map/, which the archive's server serves, on this Mac and on the tailnet alike, its tables shown and edited on Events' Tables; the place for people), Health Record, Fitness (Activities, the exercise module's: every workout from every source, one activity each as the index's workouts match them, a workout logged in Rituals laid on the one it is (the same day, sport and duration) or else an activity of its own known by its day, as a training log lays them out: the week's minutes in zone 2 against the weekly target the archive keeps (exercise.json's zone2WeeklyMinutes), each activity's counted once, from its trusted heart rate's zones, else its Rituals log saying zone 2 and how long, and the recent weeks' against it; a feed newest first, the week's totals and the last twelve weeks, and each activity's page with its route, splits, heart rate over time and time in each zone, and its Delete, after one confirmation naming it: every copy gone for good, their files, their entry in an export's zip and their rows in the index and the calendar, no backup taken, only a tombstone left (deleted_workout: the copy's source, id, sport family and times) so no source brings it back; read at /life-archive/api/m/exercise/activities from each shown copy's file, the heart rate only where the captain's rule trusts it, a route sent as a shape in metres and drawn on the map of its area kept on this Mac (maps/ in the archive's folder, downloaded once by npm run map, OpenStreetMap's data from Protomaps; tiles and fonts served at /life-archive/api/m/exercise/map/ by the archive's server, MapLibre drawing them), told the route's corner only then, so no tile server ever learns where he went, and over none where the area's map is not downloaded; the Health tab's highest heart rate is taken from the same activities; then Habits, the rituals module's: the weekly targets but the fish one as rows of dots, a week a dot, read at /life-archive/api/m/rituals/dashboard, what rituals' dashboard routes served: the daily matrix whole and the weekly targets without any entry's note or who logged it), Events (first in the rail and the console's home since 6 November 2026; its views the captain's: the Calendar, then rituals' Daily rituals, every habit (magnesium, protein, stretches, the plank, journalling and wind-down) and the temporary checks running now as rows of dots, read as Habits is, then Tables, a list of every table, the core's and the modules', each opened as it is kept, then Sources; the Calendar's views each the whole width, its title alone over a filter chip a kind, each chip counting its kind over what the view shows: the day, its building block, event by event (each call, hangout and workout a row in time order, with no hour grid and no empty hours, ↑ and ↓ stepping from one to the next) beside everyone on the day; the week's calls, hangouts and workouts as each day's list in its column, and whom he messaged and the agents each day as summary rows (a row of faces; the agent messages and sessions), a day's head opening its day; or the month at a glance, a day opening its day and a week's number its week, each day's messages as a tint and one line of counts along its foot (messages, calls, hangouts, agent messages: the prompts he sent to agents, from the calendar's day summaries; workouts), or the year, twelve small months, its totals in the filter chips, each day shaded by how much happened (each kind on up to a point against its own busy day, the points added; a chart by day for each of its calls, hangouts, workouts and rituals, the day summaries for the rest), a month opening its month; read from the tabs' own routes and the calendar's day summaries (/life-archive/api/calendar/days); and Sources, a status table of where the events come from, a row a connector in a card for each way it syncs (live in the server, a scheduled job on this Mac, the Cua Space's exports, by hand): what it is, how often (the sync connector's manifest's cadence and its settings' interval, the launchd agent's schedule as installed on this Mac, the Cua Space's round's ask for each export), when it last synced well, whether it is failing and since when, and what it has brought, one overdue (its last good sync older than two of its intervals, unless the server holds it connected) or failing tinted to stand out; read at /life-archive/api/sources from the connectors' manifests and settings, their runs in the archive and the installed launchd agents, never from a schedule kept in the page), Inspirations, the old viewer's page wrapped with the console's blocks above it, Shopping (On special, every supplier's specials today), and Architecture, wrapped as the others. The old viewer is gone: any other address under /life-archive/ opens the console's home (Events; there is no overview page), and People has no page of its own (Friend Map is its place; its table is in Events' Tables).
    Files: `viewer/console/Console.tsx`, `viewer/console/registry.ts`, `viewer/console/address.ts`, `viewer/console/blocks.tsx`, `viewer/console/Jump.tsx`, `modules/friend-map/viewer/FriendMapView.tsx`, `modules/friend-map/viewer/frame.ts`, `modules/health/viewer/HealthSection.tsx`, `modules/exercise/viewer/ExerciseSection.tsx`, `modules/exercise/viewer/Drawings.tsx`, `modules/exercise/viewer/RouteMap.tsx`, `modules/exercise/viewer/mapStyle.ts`, `modules/exercise/wire.ts`, `modules/exercise/server/maps/tiles.ts`, `modules/exercise/server/maps/http.ts`, `modules/exercise/server/maps/download.ts`, `modules/exercise/server/http.ts`, `modules/exercise/server/delete.ts`, `modules/exercise/viewer/DeleteActivity.tsx`, `modules/exercise/server/activities.ts`, `modules/exercise/server/track.ts`, `modules/exercise/server/rituals.ts`, `modules/exercise/server/settings.ts`, `modules/exercise/viewer/Zone2.tsx`, `viewer/console/EventsSection.tsx`, `modules/rituals/viewer/HabitViews.tsx`, `modules/rituals/viewer/DotRows.tsx`, `modules/rituals/viewer/dots.ts`, `modules/rituals/viewer/dots.css`, `modules/rituals/server/dashboard.ts`, `modules/rituals/server/http.ts`, `modules/inspirations/viewer/InspirationsSection.tsx`, `modules/inspirations/viewer/InspirationsPlatforms.tsx`, `modules/shopping/viewer/ShoppingSection.tsx`, `viewer/console/ArchitectureSection.tsx`, `viewer/Rows.tsx`, `viewer/main.tsx`, `viewer/console/calendar/CalendarView.tsx`, `viewer/console/calendar/calendar.ts`, `viewer/console/calendar/calendar.css`, `viewer/console/calendar/faces.tsx`, `viewer/console/calendar/DayView.tsx`, `viewer/console/calendar/day.ts`, `viewer/console/calendar/day.css`, `viewer/console/calendar/YearGrid.tsx`, `viewer/console/calendar/year.ts`, `viewer/console/calendar/year.css`, `viewer/console/theme.ts`, `viewer/console/order.ts`, `viewer/console/reorder.ts`, `viewer/console/console.css`, `viewer/console/registry.test.ts`, `viewer/console/order.test.ts`.
    console.md: "The console".
  - **Send executor** (server/archive): The only sender, turned off for now (SENDING): every send is refused, and the page has no composer. Turned on, the composer's route calls it, and nothing is sent by itself. It sends into a direct chat on a platform whose sync connector is connected, as a send command, records how it went (never the text), and the message then arrives through sync like any other.
    Files: `modules/friend-map/server/send.ts`.
    Tables: `outgoing_message`, `conversation`.
    archive.md: "The message archive".
- **friend-map's page, served by the archive** (/friend-map/): friend-map's page, the module's own code in modules/friend-map/page/ (from friend-map-frontend, retired), served by the archive's server under /friend-map/ through a Vite of its own (server/modulePages.ts; base /friend-map/), the same on this Mac and on the tailnet, where Tailscale Serve passes /friend-map on to the same server. The page's own API is at /friend-map/api/ and its contract at /friend-map/api/archive/, where the module answers the Table and the activity chart itself, scored by the page's own code from the archive's facts (modules/friend-map/server/page/scoring.ts), and everything else from the archive. friend-map's own server (local.friend-map, port 4600) did this before the module, and is retired at the switch. While the archive's server is down or starting again, the page cannot load; while friend map's database cannot open, its paths answer 503 saying why.
  Files: `server/modulePages.ts`, `modules/friend-map/server/routes.ts`, `modules/friend-map/server/page/pageApi.ts`, `modules/friend-map/server/page/scoring.ts`, `modules/friend-map/server/page/savedSettingsPlugin.ts`.
  friend-map's docs: `docs/docs/running.md`.
  - **Settings and usage** (modules/friend-map/page/ in the archive's folder: settings.json, view-settings.json, usage.jsonl, me/): Optional settings (how far back trends look, the closeness half-life, what an hour caught up counts as, and the shortest day of calls that counts); the captain's saved view settings (the Spider web's, with the names choice), which every browser and the phone share, served into each page as it opens; a record of which views are opened and for how long; and the captain's photo for the sun on Orbits. Before the module they were friend-map-frontend's data/, moved here at the switch.
    Files: `modules/friend-map/server/page/settings.ts`, `modules/friend-map/server/page/viewSettings.ts`, `modules/friend-map/server/page/savedSettingsPlugin.ts`, `modules/friend-map/server/page/usage.ts`, `modules/friend-map/server/page/mePhoto.ts`.
    friend-map's docs: `docs/docs/settings.md`.

#### The page

*src/.* What the browser shows: Orbits (the main view), the Time river (the Table and the Calendar folded into the Events page's on 10 November 2026), the frozen views, the people and chat panels, and the static demo.

- **The Table, folded** (no view now): friend-map's Table (everyone in a table, with its Location cell, Add person, the tag manager, a Query bar and Hide, and a Platform picker) folded into the Events page's Tables on 10 November 2026, one tab at a time: Hangouts and Calls first, then People, with its tag manager as the Tags table (console.md's "People" and "Tags"). Any /table address opens the table its tab is now (People for none). Its Hide is the map views' own now, on their Query bar, and its Changes sits in their header; Add an aspiring friend stays in the switcher's menu.
  friend-map's files: `src/demos/movedToEvents.ts`, `src/demos/ChangesPanel.tsx`, `src/demos/AddAspiring.tsx`, `src/demos/HidePanel.tsx`.
  friend-map's docs: `docs/docs/views.md`.
- **Orbits** (main view): The main view at /orbits (the app opens on the Spider web): everyone the query matches and Hide leaves (the map's own since the Table folded) (archived people only once their box is unticked), placed by closeness rank around the captain (whoever is tagged live-together first, in the sun itself; the sun is the captain's photo once one is added by the + shown on hovering it, kept in data/me/), A to Z, or in friend circles from shared group chats on the same map at /circles (Circles, its own entry in the view switcher), and whoever's panel is open held picked out with the people they share group chats with. Each person's dot is their identicon's main colour, and the hover card shows the identicon. It zooms and pans (the wheel or a pinch, a drag, or + − 0), spreading people out while dots and names keep their size, so more are named; on a phone nobody is named but whoever is picked out. Its title at the top left, as on every page, is the view switcher, which lists the main views (Orbits, Orbits 3D, the Spider web and the City) first, as a group of their own; a view with settings of its own (viewSettings.ts) has them in a section of that menu set apart from the views, as toggle buttons and sliders: Orbits' Theme (Orange or any custom colour for the sun and the guide rings, kept per browser, Orbits' alone; orbitsTheme.ts), the Spider web's Colour, Strand curve (how deep its cross threads sag), Spokes (8 to 48) and Web strength, the Calendar's Messages, and each main view's own Show top names (topNames.ts: the closest 25, 50, 100 or 200, or All, named without hovering, 100 until another is chosen (50 in the demo), kept per view and per browser, but the Spider web's saved on the server; the markers big enough to read their identicons stay the closest 100 whatever it says, so it moves nobody, and the Spider web's boot locks in whoever it names). The Query bar (one box and the map's Hide) narrows who is shown, at most 1,000 people: more is refused before it loads, the Query bar's box turning red. Name format, first in the view's settings in the menu at the top left, one choice shared with every live view, First L. until another is chosen and saved on the server (names.ts, NamesMenu.tsx), names everyone on the map by First name, First L. ("Ada S."), Full name or No name (also the h key), changing nothing off the map; or, in the real app alone, No name except… (shownNames.ts): every name on every screen hidden but those of the people picked, tagged show-name, and of their connections (everyone on the map they share a group chat with, from the relationships report), within each view's own rule for whom it names. Every map view draws each named person as their name alone, centred where their icon would be (centreOnIcons in orbitsLayout.ts; on Orbits and the Spider web, those named on the whole map first turned a few degrees round their orbits, the closest first, so no name, measured in the view's own type, covers another or a ring label, kept the view's Name padding apart (namePadding.ts, 0 to 10 pixels, 3 on Orbits kept per browser, 5 on the Spider web saved on the server), nobody's distance from the sun changing: useNameFit, fitNames over nameRoom.ts), with no icon or glow, the name taking the icon's part (hover, click, and on the Spider web the beam, the hold, and the reticle fit round it, the web running on behind it), everyone not named keeping their icon; each name in its person's own icon colour with the plain outline and nothing behind it, no card, a glowing one's glow on its letters; none leaves out a name Show top names names, and whoever is picked out is always named. The demo is the public demo (the static demo, https://friend-map-demo.pages.dev/spider), which Demo in the real app's switcher opens in a new tab, the app holding no demo of its own (an old /demo or /demo/<view> address is sent there, server/oldDemo.ts): Orbits, Orbits 3D, the Spider web, the City, the river and Reciprocity (no Table, Calendar or Circles, and nothing called frozen) with its own switcher, over a made-up crowd shaped like the captain's map at about half its size (400 people on it), held in the page and read-only, with nothing of the captain's asked of the server, its Spider web's settings starting at the captain's saved ones (served into the page, and built into the static demo), its own Name format (the map's four choices, starting at the captain's where it shows names, and everyone off the map as First L.), no Architecture page and no way into the real map. Orbits 3D, at /orbits-3d (its own entry in the switcher, after Orbits), is the same sky as a solar system: it opens exactly as Orbits does, seen from straight above (orbitsSky.ts places everyone for both views), and the camera then moves as the City's does (a drag with the middle or right button or with Ctrl, two fingers twisted or dragged up and down, a compass to put it back); as the sky tilts, the discs round into spheres lit by the sun, each with its identicon on top, on an orbit leaning a little out of the plane by an inclination from the person's seed, the rings become ellipses, and the names move into the scene (orbits3dNames.ts): past a small tilt, each stands in its person's place, drawn on the canvas at their depth so anything nearer hides it. It is drawn on an SVG beneath (rings, trails, links), a WebGL canvas (the sun, the glows, the spheres and the tilted names: plain WebGL 2 written by hand, no library, a few draw calls a frame with a depth buffer) and an SVG above (the ring labels, and from straight above the names), loaded only when opened, with everything else Orbits' (hover, click, the held person's links, the find box, the Query bar, Methodology, Name format, the demo, and the same zoom and pan). The guide rings, labelled "top 10", "top 25" and so on, and their labels are coloured from the sun's orange outward to a muted violet, fainter ring by ring (ringColours.ts). The Spider web, at /spider (its own entry in the switcher, after Circles, and the view the app opens on: / and any address that names no view lead to it), is the same map as a spider's web on Orbits' own engine: a canvas under the SVG draws a holographic wireframe, a web running out past the edges of the screen: a clean orb web of even spokes (as many as its slider says, webStyle.ts, kept on the device) and rings of cross threads (straight, or sagging toward the hub as deep as its slider says) whose rings, the closest 10 to 250, stand evenly apart in place of the guide rings, everyone placed by rank between them (the even scale, orbitsLayout.ts), their labels on each ring's level top, and a wire drone of a spider at the hub that boots the web in with a scan line from the top down, everyone condensing in place as it passes, and again whenever the captain re-queries (a new query, ×, or Hide changing; never the query run again as messages arrive), everyone else moving to new places as on Orbits, in Amber or any custom colour its whole palette is worked out from (webTheme.ts), the beam teal in every one, the colour last chosen in the Spider web's settings in the menu, saved on the server (the captain's blue until one is), unless the address asks for another (?colour=3dff9a that custom colour, ?colour=amber Amber) until one is chosen, the last custom colour kept on the device, the web as strong as the Spider web's slider says; the Spider web's settings come in two groups, its name settings (Name format, Show top names, Name padding) then its look, and are saved by the archive's server (view-settings.json in modules/friend-map/page/ of the archive's folder, savedStore.ts), so every browser and the phone share them and the demo starts at them; the spider is an armoured machine in a real spider's shape (webSpider.ts), a small body on long legs, each of six segments (coxa, femur, patella, tibia, metatarsus, tarsus) solved in three dimensions from its hip and its foothold and drawn as layered plates with specular and rim light, emissive seams and glowing joints, every joint's height shading it and casting its shadow on the web, growing gently with the zoom so it can be looked at closely, a rig of parts (webRig.ts): its head looks toward whoever is selected, else whoever is hovered, almost at once (never the bare cursor), its chassis follows later and slower to face whoever is selected, and anyone hovered only from beyond the cone of 90° in front of it, its abdomen trails on a spring, its eight legs stand fanned round the body as a star, keep footholds on the web and step through a turn, staggered and overlapping, toward footholds planned from where the body is going, lifting off the web, each leg standing anywhere within a range of its own round its rest (a few degrees round its hip, a little in or out), picked anew at random at every turn and drifted within a little at rest, one leg at a time, and its body leans away from the legs in the air, it holds where it last turned, at rest it shifts its weight, plucks the web, grooms with a front leg, looks round, settles and flexes of its own, never on a loop, its eyes blink, glance and scan on their own (webEyes.ts), and hovering someone, with nobody selected, fires a beam from its eyes that locks on and holds, while whoever is selected it takes up from its mouth (webHold.ts): a line laid out with a little slack, a snap taut with a twang into an energised beam, which wins over a beam from the eyes on them, and no reticle on them, reeling back in once they are deselected (a click on empty map deselects them), and while they stay selected only they and the people they share group chats with are named, hovered or clicked (`heldOnly` in Orbits.tsx), and hovering one of those fires no beam and turns nothing; the square reticle goes with the hover, snapping onto whoever is hovered (never the held) and springing off as the pointer leaves, the only bracket on anyone once the boot's lock-in has flashed and gone; the beam, the reticle and the hold are drawn over everything, other people's icons included, on a canvas above the SVG, the hover card in one place for each person, beside their dot on the far side of it; the web is cut away under every icon so nothing shows through one; the scan plays at load and on each re-query; its sun is always the sun, never the captain's photo; everything else is Orbits'. All new view work goes here.
  friend-map's files: `src/demos/Demos.tsx`, `src/demos/Orbits.tsx`, `src/demos/orbitsSky.ts`, `src/demos/namePadding.ts`, `src/demos/addressChoice.ts`, `src/demos/webColour.ts`, `src/demos/webTheme.ts`, `src/demos/themeColour.ts`, `src/demos/orbitsTheme.ts`, `src/demos/webStrength.ts`, `src/demos/webStyle.ts`, `src/demos/topNames.ts`, `src/viewSettings.ts`, `src/ViewSettings.tsx`, `src/keptSetting.ts`, `src/demos/WebLayer.tsx`, `src/demos/webSpider.ts`, `src/demos/webEyes.ts`, `src/demos/webRig.ts`, `src/demos/webLook.ts`, `src/demos/webHold.ts`, `src/demos/webDraw.ts`, `src/demos/webGeometry.ts`, `src/demos/webChoreography.ts`, `src/demos/Orbits3D.tsx`, `src/demos/orbits3dScene.ts`, `src/demos/orbits3dGl.ts`, `src/demos/orbits3dNames.ts`, `src/demos/orbits3d.css`, `src/demos/cityCamera.ts`, `src/demos/Compass.tsx`, `src/demos/SunPhoto.tsx`, `src/ViewSwitcher.tsx`, `src/demos/model.ts`, `src/demos/closeness.ts`, `src/demos/orbitsLayout.ts`, `src/demos/nameRoom.ts`, `src/demos/friendCircles.ts`, `src/demos/orbitsZoom.ts`, `src/demos/Methodology.tsx`, `src/identicon.ts`, `src/demos/QueryBar.tsx`, `src/demos/queryBar.ts`, `src/demos/HidePanel.tsx`, `src/demos/hideChoices.ts`, `src/names.ts`, `src/NamesMenu.tsx`, `src/shownNames.ts`, `src/demoMode.ts`, `src/DemoMode.tsx`, `server/oldDemo.ts`, `src/views.ts`.
  friend-map's docs: `docs/docs/views.md`.
- **City** (view): The same closeness as Orbits, at /city, as a neon city seen from above at an angle: the captain's tower in the middle, lit amber, a lit floor in it for whoever is tagged live-together, and everyone else a building nearer the tower the closer they are (the rank on Orbits' own scale), with avenues round the closest 10, 25, 50 and so on, in Orbits' ring colours. Height is the closeness score, footprint messages, both tapering away past the closest few hundred to dots at the edge (a logistic in rank, with the knee at 500; the Legend draws the curve); neon edges the person's identicon colour (their picked hue included), fainter tier by tier; names painted on the roofs where a roof is big enough on the screen to carry one, of as many of the closest as the City's Show top names says (then also everyone to reach out to, and whoever shares group chats with the held), whoever is picked out always readable; a beacon pulses on the roof of everyone to reach out to, and light runs down the roads from everyone talked with in the last week. The camera turns and tilts as Google Maps' does (a drag with the middle or right button or with Ctrl, two fingers twisted or dragged up and down, a compass to put it back), buildings drawn back to front as it sees them. Drawn on three canvases (ground, buildings and names, beacons), so hundreds of buildings and moving light stay smooth on a phone; it zooms and pans as Orbits does, hovering shows the card, clicking opens the panel, and the Query bar, Hide, the find box, Names, the demo (/demo/city) and the settings all apply as on Orbits.
  friend-map's files: `src/demos/City.tsx`, `src/demos/topNames.ts`, `src/demos/cityLayout.ts`, `src/demos/cityCamera.ts`, `src/demos/Compass.tsx`, `src/demos/city.css`, `src/demos/orbitsZoom.ts`, `src/demos/closeness.ts`, `src/demos/model.ts`.
  friend-map's docs: `docs/docs/views.md`, "City".
- **People and the person panel** (panel): People lists everyone, archived people under Archived, with proposals; a person's panel shows their identicon (a small mirrored pixel picture drawn from the seed kept on them, src/identicon.ts) beside a chip for each name they go by (dragged to reorder, the first their name), tags, location, note, whether to reach out, their hangouts (catch-ups) and Add event, which adds a hangout (or a trip over several days, from a start to an end less each day's private hours, one hangout changed and deleted whole) or a call the captain logs (each changed and deleted there or in the chat, with the change chip's Undo), accounts and fixes, then when you last spoke and last hung out, how much you talked each month, all time, and the group chats they are in, any of which opens in place of their chat (Accounts, Hangouts, Group chats and the chat, under Messages, are closed whenever a panel opens, and the chat's messages are asked for only once Messages is opened, unless the panel opens at a moment; Show group messages and Load all sit inside Messages, above the chat); a person opened from inside the panel (a group chat's member) can be left by the back arrow at its top left, to whoever they were opened from. Every panel and view reaches the archive through one interface (archiveApi.ts), which the page's entry points at the server's routes (archiveHttp.ts) or, in the static demo, at made-up data held in the page (demoMode.ts).
  friend-map's files: `src/PeoplePanel.tsx`, `src/personHistory.ts`, `src/PersonParts.tsx`, `src/CatchUps.tsx`, `src/catchUps.ts`, `src/eventWords.ts`, `src/Identicon.tsx`, `src/identicon.ts`, `src/ActivityChart.tsx`, `src/PersonGroups.tsx`, `src/groupName.ts`, `src/archiveApi.ts`, `src/archiveHttp.ts`, `src/useArchive.ts`, `src/readOnly.ts`.
  people.md: "People".
- **Static demo** (friend-map-frontend's own `npm run build:demo` and `check-demo`, not this repository's, which build and check the life archive's demo, docs/demo.md: friend-map-frontend's generator, demo archive and build stayed there when the page came here; whether that public demo stays is the captain's call): The app's demo (Orbits, Orbits 3D, the Spider web, the City, the river and Reciprocity, with the Query bar, Methodology and the person panel), the public demo that Demo in the app's switcher opens (https://friend-map-demo.pages.dev/spider), built as plain files (dist-demo/) for a site of their own on Cloudflare Pages, deployed by hand with wrangler, over a made-up crowd shaped like the captain's map at about half its size (400 people on it, and archived people, group chats, messages, calls and hangouts in the same proportion to his), made in the page as it opens by a seeded generator shaped by counts taken from the captain's archive (mapShape.ts, written by npm run demo-shape from the archive's facts, closeness scored by friend-map: counts and distributions only, never a name or a message); its 700,000 messages are columns, each one's line of chat picked from a small pool of made-up lines when it is shown. The same views and panels over another archive (archive.ts, in the page, read only), not a copy of them; the Query bar's box offers example requests in place of a model. Its page may reach no network (its content security policy), and npm run check-demo holds its built files to nothing from data/, no server route and no real name.
  Files: `modules/friend-map/server/mapFacts.ts`.
  friend-map's files: `src/demo/main.tsx`, `src/demo/index.html`, `src/demo/public/_headers`, `src/demo/public/_redirects`, `src/demo/archive.ts`, `src/demo/rules.ts`, `src/demo/query.ts`, `src/demo/generate.ts`, `src/demo/words.ts`, `src/demo/examples.ts`, `src/demo/shape.ts`, `src/demo/mapShape.ts`, `server/demo-shape.ts`, `server/check-demo.ts`, `vite.demo.config.ts`.
  friend-map's docs: `docs/docs/demo.md`.
- **Chat** (panel): A person's messages, or a group chat opened from their panel (read only, every sender named), as a messaging app shows them, newest at the bottom, loading older pages as you scroll up, or all at once, with a person's calls (those logged too) and hangouts at their time; under a person's, a draft box where the captain works on a message to them, saved as he types (the composer that sent on Telegram is off for now).
  friend-map's files: `src/Timeline.tsx`, `src/GroupChat.tsx`, `src/chatDays.ts`, `src/DraftBox.tsx`, `src/drafts.ts`, `src/Composer.tsx`, `src/liveState.ts`.
  archive.md: "The message archive".
- **Frozen views** (frozen views) *(frozen)*: The river and Reciprocity: kept working on the same data, not extended (they draw real names whatever the Name format choice).
  friend-map's files: `src/demos/River.tsx`, `src/demos/Reciprocity.tsx`.
  friend-map's docs: `docs/docs/views.md`.

##### Over time

*views.* The views of when: the Calendar, every communication by day, and the Time river, messages, calls, hangouts or both together month by month.

- **Calendar** (folded): Friend Map's own Calendar folded into the Events page's Calendar on 10 November 2026 (the captain: "Fold it"): its old address (/friend-map/calendar?day=…, ?month=…) opens the same day or month there, and it is gone from the view switcher. Events' day lists who was messaged and how many, opens one chat at a time as a plain list, adds a hangout or a call on the day, and opens someone in Friend Map (/friend-map/?person=…, their panel).
  friend-map's files: `src/demos/movedToEvents.ts`, `src/demos/personAddress.ts`; the life archive's `viewer/console/calendar/DayPeople.tsx`.
  friend-map's docs: `docs/docs/views.md`.
- **Time river** (view): Hangouts, calls (or both together) or messages over time, at /time-river, in the river's look (its geometry, riverLayout.ts, shared unchanged). A filter bar under the header, every choice kept per browser: Messages on its own, or Calls, Hangouts or both toggled apart (Hangouts to start); the time it covers (the last 3 or 6 months, the last year, all time, or from one month to another); the app (the apps the people shown have any of it on, from GET /message-apps for messages and the calls' own for calls, the calls alone with both); and for calls whether those with no length show. Time runs left to right over that span, and each person is a stream as wide as that month's messages, minutes on answered calls, hours at hangouts (a trip's in the months of its days), or with both the hours of calls and hangouts added up, the hover card giving each part (one with several widens each of their streams), friend groups flowing as channels of one colour, the biggest named inside their streams as the name choice has them (nobody on a phone but whoever is picked out). A missed call, or one with no length known, is a mark in a strip under the river at its day. Hovering a stream or a mark shows who and their numbers that month, over the span and their busiest; a click opens their panel, docked beside it. A live view: the Query bar, Hide and the find box, as on Orbits. The demo has no Time river.
  friend-map's files: `src/demos/TimeRiver.tsx`, `src/demos/timeRiver.ts`, `src/demos/timeRiver.css`, `src/demos/riverLayout.ts`.
  friend-map's docs: `docs/docs/views.md`.

## What feeds what

Each arrow the map drew, from one box or table to another.

- Messenger phone export → messenger-export
- Facebook "Download your information" → facebook-dyi
- Instagram "Download your information" → instagram-dyi
- WhatsApp's own databases → whatsapp-db
- Messages app database → imessage-db
- Call history → call-history
- WeChat's own databases → wechat-ios
- X's archive of your data → x-archive
- Signal Desktop's chat history export → signal-export
- Discord's data package → discord-package
- Address book → whatsapp-db: names
- Address book → imessage-db: names
- Address book → call-history: names
- Connector switches → Connector host: on or off
- matrix-bridge → Connector host: batches, checkpoints
- matrix-whatsapp → Connector host: batches, checkpoints
- Send executor → Connector host: send command
- Content routes → Send executor: send
- messenger-export → Connector host: JSON lines
- facebook-dyi → Connector host
- instagram-dyi → Connector host
- whatsapp-db → Connector host
- imessage-db → Connector host
- call-history → Connector host
- wechat-ios → Connector host
- x-archive → Connector host
- signal-export → Connector host
- discord-package → Connector host
- Claude Code's sessions → llm-sessions: copied live, read from the copy
- llm-sessions → Connector host
- Grok Bot's cache → grok-bot: copied live, read from the copy
- grok-bot → Connector host
- Rituals → The calendar: the module's watch, read in-process
- Rituals → Exercise: the RitualWorkouts service
- Polar → polar: AccessLink, every 3 hours
- Polar → polar-export: the export, in place
- polar → Connector host
- polar-export → Connector host
- What connectors share → Platform exports: points at, copies live media
- Connector host → Import writer: checked events
- Connector host → The exercise module's database: the polar connectors' checked events, applied by the module
- The exercise module's database → The calendar: its rows, after each import; every row for a rebuild
- Import writer → The database: one transaction
- People, tags and rules → The database: rules, edits
- Change log and bulk edits → People, tags and rules: edits
- The database → Backups: VACUUM INTO
- The night's job → Every LLM transcript: compressed, every version kept
- The CLI → Connector host: import
- The CLI → Change log and bulk edits: every change
- Data check → The database
- Inspire shortcut → Inspirations page: the capture route, over the tailnet
- Grok Bot agent → The CLI: inspiration add
- The CLI → Inspirations store: capture, edits
- Inspirations page → Inspirations store: capture
- Inspirations store → The database
- Inspirations store → Inspirations worker: waiting items
- AI service (Codex) → Inspirations worker: AI tags, and whether his words are an ask
- Inspirations store → Inspirations page
- friend-map's page, served by the archive → Console
- The database → Structure
- The database → Content
- Old media copies → Content
- Platform exports → Content
- People, tags and rules → People routes
- Structure → People routes
- People, tags and rules → Tag and location routes
- Change log and bulk edits → Change log routes
- Change log routes → Table: Changes
- People, tags and rules → Merge proposals
- People, tags and rules → Live updates: people_version, links_version
- Structure → Reports
- Structure → Query routes
- AI service (Codex) → Query routes: a query
- Content → Content routes
- Settings and usage → App API
- friend-map's page, served by the archive → Orbits: serves the page
- Reports → Orbits: relationships
- Reports → Table: table
- Reports → Calendar: calendar
- Calendar → Chat: a day's chats
- Calendar → People and the person panel
- Reports → Frozen views
- Query routes → Orbits: query
- Query routes → Table
- People routes → People and the person panel
- Tag and location routes → Table
- Tag and location routes → People and the person panel
- Merge proposals → People and the person panel
- Live updates → Orbits: reload
- Content routes → Chat
- App API → Orbits: settings, usage
- Reports → City: relationships
- Reports → Time river: relationships, message apps
- People routes → Time river: calls, catch-ups
- Time river → People and the person panel: click someone
- City → People and the person panel: click someone
- Orbits → People and the person panel: click someone
- Orbits → Static demo: built as plain files
- People and the person panel → Chat
- Archive rules → person.archive_rule: stored by the rules *(derived)*
- import_person_stats.import_person_id → Archive rules: read by *(derived)*
- "archive" from the rules → person.archive_rule: shown when set *(derived)*
- whatsmeow → mautrix-whatsapp
- mautrix-whatsapp → mautrix-go bridgev2
- signalmeow + libsignal → mautrix-signal *(planned)*
- mautrix-signal → mautrix-go bridgev2 *(planned)*
- gotd → mautrix-telegram
- mautrix-telegram → mautrix-go bridgev2
- messagix → mautrix-meta *(planned)*
- mautrix-meta → mautrix-go bridgev2 *(planned)*
- discordgo → mautrix-discord *(planned)*
- mautrix-discord → mautrix-go bridgev2 *(planned)*
- mautrix-go bridgev2 → Matrix connector
- mautrix-go bridgev2 → friend-map connector *(planned)*
- Matrix connector → Tuwunel: rooms and users
- Tuwunel → Any Matrix app
- Tuwunel → matrix-bridge: option A: Matrix client API
- Tuwunel → matrix-whatsapp
- friend-map connector → Connector host: option B *(planned)*

## Routes

Every route of the archive's server, by group. Every write (anything but GET and HEAD) is taken only from friend-map's own page: one another site's page sent is refused (403, `fromOwnPage` in `server/jsonApi.ts`).

### People, tags and rules

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/archive/people` | Everyone, with query=, tag= and location= filters, and reachOut=1 for only those to reach out to (PeopleListing). |
| POST | `/api/archive/people` | Add someone by hand, with no accounts, and their location, tags and note if given (the aspiring friend's form; Add person in Events' People table goes through the core's edit route instead), as one changeset; when someone already goes by that name or alias, nobody is added and they are named, unless anyway is set (PersonAdded). |
| GET | `/api/archive/people/:id` | One person (404 once merged away). |
| PUT | `/api/archive/people/:id/names` | Set every name they go by, in order: the first their name and label, the rest their aliases, at least one (the person panel's name chips: one added, removed, written again or dragged to another place), answered with its changeset so the page can undo it. |
| PUT | `/api/archive/people/:id/tags` | Set their tags; answers with the changeset made and the tags made or deleted, so the chip can undo an archive or a tag. |
| PUT | `/api/archive/people/:id/note` | Set their note. |
| PUT | `/api/archive/people/:id/should-reach-out` | Set whether to reach out to them (Orbits' glow). |
| GET | `/api/archive/people/:id/drafts` | The messages the captain is writing to them, the first first. |
| POST | `/api/archive/people/:id/drafts` | A new draft to them (none, when empty); no changeset. |
| PUT | `/api/archive/drafts/:id` | A draft's text as he types it; emptied, it is deleted. No changeset. |
| DELETE | `/api/archive/drafts/:id` | Delete a draft. |
| PUT | `/api/archive/people/:id/identicon` | Their identicon drawn from the seed and in the hue given: the person panel's icon picker saving its draft (a new picture, a new colour, or both, as one change), answered with its changeset so the page can undo it. |
| PUT | `/api/archive/people/:id/location` | Set where they are, as far as the captain last knew (one value, or none), answered with its changeset so the page can undo it (the person panel's Location; Events' People table sets it through the core's edit route). |
| POST | `/api/archive/people/:id/merge` | Join another person into this one, which is kept. |
| POST | `/api/archive/people/:id/accounts/:accountId/detach` | "Not them": the account becomes a person of its own. |
| GET | `/api/archive/catch-ups` | Every catch-up, or a person's (person=), the latest first, each with everyone at it. |
| POST | `/api/archive/catch-ups` | Add a catch-up, time in person (its date, time if any, hours, note, people and unnamed others; or a trip, with its end and each day's private window, its hours worked out; byCall true, from when one could be by call, is refused, a call being logged as a call); answers with the changeset made, so it can be undone. |
| PUT | `/api/archive/catch-ups/:id` | Change a catch-up, who was at it too, as adding one takes it. |
| DELETE | `/api/archive/catch-ups/:id` | Delete a catch-up. |
| POST | `/api/archive/catch-ups/:id/call` | Make a catch-up a logged call (Add event's toggle on one being changed): the catch-up goes and the call comes in its place, its unnamed others with it, as one changeset that undo takes back whole. |
| GET | `/api/archive/calls` | Every call with anyone, from every source (the phone's call history, the apps' call records and calls lists, and those logged), one each however many were on it, newest first, with who was on it by id, whose its length is and the captain's note: the Time river's calls. |
| PUT | `/api/archive/call-notes` | Give a call its note, or take it away (empty): a logged call's whole group, an imported call in call_note; one changeset. |
| PUT | `/api/archive/call-answered` | Say whether an imported call was answered, missed or unknown, over its source's (the same as its source's takes it away), in call_answered; the closeness score follows it; one changeset. |
| POST | `/api/archive/calls` | Log a call with one or more people (its date, time and minutes, each one's account, a note if any, and how many more were on it unnamed); answers with the changeset made, so it can be undone. |
| GET | `/api/archive/calls/:id` | A logged call's group: everyone on it and the account it was on with each, to change it. |
| PUT | `/api/archive/calls/:id` | Change a logged call, for everyone on it (its unnamed others as they were, unless said). |
| DELETE | `/api/archive/calls/:id` | Delete a logged call, for everyone on it. |
| POST | `/api/archive/calls/:id/catch-up` | Make a logged call's whole group a catch-up, as POST /catch-ups/:id/call makes one a call. |
| PUT | `/api/archive/messages/:id/call-length` | Give a call whose app says no length its length in whole minutes, or take it away (null); one changeset. |
| GET | `/api/archive/people/:id/send-targets` | The chats the composer in their panel can send into, with how each one's connector is doing. |
| GET | `/api/archive/people/:id/activity` | Their messages, calls and hangouts each month, all time, and what each counted for in closeness points with the settings named, for the chart in their panel. friend map's scoring answers it (modules/friend-map/server/page/scoring.ts, the page's own code), from the archive's score report. |
| GET | `/api/archive/people/:id/calls` | Their calls whose length is known, newest first (account= for one account's): the phone's call history, for the chat in their panel, and Messenger's and Instagram's call records, already in the chat, for the panel's sum of their calls. |
| GET | `/api/archive/people/:id/groups` | The group chats they are in, with how many people and what each of you sent there, the latest first; an untitled one with the first few people in it, to name it by; and whether the captain unlinked them from each. |
| PUT | `/api/archive/people/:id/groups/:groupId/unlinked` | Unlinks them from a group chat (unlinked: true): they stay in it and closeness still counts it, but it connects them to nobody on the map or in friend circles; false links them through it again. The person panel's break-link button, as one changeset its chip can undo. |
| GET | `/api/archive/groups/:id` | One group chat, for its header when opened in a person's panel: its size, everyone in it with what they sent there, whether each is untouched and archived, and what came in when. |
| POST | `/api/archive/groups/:id/archive-untouched` | Archives everyone in the group the captain has never changed and not archived yet, as one changeset its chip can undo; refused when that is no longer who the page showed. |

### tags

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/archive/tags` | Every tag in order, with how many have it. |
| POST | `/api/archive/tags` | A new tag, last; this and the changes below answer with the tags and the changeset. |
| PUT | `/api/archive/tags/:name` | Rename for everyone; onto a tag that exists, a merge. |
| PUT | `/api/archive/tags/:name/position` | Move in the order. |
| DELETE | `/api/archive/tags/:name` | Take from everyone, and delete. |
| GET | `/api/archive/locations` | Every location someone is at, the most people first, with how many are at each (from person.location's index). |
| PUT | `/api/archive/locations/:name` | Rename a location for everyone at it; onto another location someone is at, a merge. |

### proposals

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/archive/merge-proposals` | Pending proposals. |
| POST | `/api/archive/merge-proposals/:id/confirm` | Join the two. |
| POST | `/api/archive/merge-proposals/:id/reject` | Never propose them again. |

### reports

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/archive/relationships` | For everyone on the map (archived people only counted, but for those the query q= matches with reveal=archive, archived by the captain or the rules, which the map's Hide shows): counts by sender and month, reactions, reopened chats and group membership, with who the captain unlinked from which group chat, for the map views. |
| GET | `/api/archive/message-apps` | Everyone's messages (archived people too) by app and local month, counted as the map views count them (one-to-one both ways, theirs in groups): the Time river's App filter. Counts only. |
| GET | `/api/archive/contract` | The handshake of friend-map's contract (its docs/contract.md): the contract version served (1.3.0), its capabilities (all of them, scores last, which friend map's scoring adds), the time zone its days are counted in (local) and the locale its numbers and dates are written in. friend-map's page asks before anything draws. |
| GET | `/api/archive/table` | Everyone, one light row each, closeness worked out with the closeness settings given (closenessHalfLifeDays=, catchUpHourWorth=, callMinimumMinutes=, messageReciprocity=, groupSharedPart= and tripFullHours=). friend map's scoring answers it (modules/friend-map/server/page/scoring.ts), from the archive's rows and score report. |
| GET | `/api/archive/table-rows` | Everyone, one light row each, without closeness: the archive's part of the Table, with when each was added to the archive and when the captain and they were first in touch (their first message, call or hangout). With an ETag of the archive's version, and 304 while it is unchanged. |
| GET | `/api/archive/score-report` | What closeness and activity are worked out from: everyone's messages by month, the group chats, the catch-ups and the calls. Facts only, with an ETag of the archive's version, and 304 while it is unchanged. |
| GET | `/api/archive/map-facts` | What the static demo's shape is worked out from (npm run demo-shape): counts, times and person ids of everyone the map shows, the archived counted by why, the group chats, messages by month and the calls. Never a name, a tag, a title or a message. |
| GET | `/api/archive/calendar/:month` | A month (YYYY-MM) for the Calendar view: each local day's messages per chat (system messages, Marketplace and dropped chats left out), calls and catch-ups, with everyone in each by id and their tags for Hide, and the first and last days with anything. Counted from the message_time index, so a month reads only its own rows. |
| GET | `/api/archive/calendar/:day` | A day (YYYY-MM-DD) for the Calendar view's day panel: its catch-ups, calls and chats in time order, each chat with its messages that day and what names it, and everyone in them. |
| GET | `/api/archive/coverage` | What each platform's imports cover (the CLI's coverage; no view uses it yet). |
| GET | `/api/archive/connectors` | Each connector, on or off, its last run, and a sync connector's live state (the CLI shows it). |

### query

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/archive/query` | The ids of everyone, archived people too, a query matches (q=: the query language, or a read-only SQL SELECT); 400 saying what is wrong when it does not run. |
| POST | `/api/archive/query/generate` | A SQL query written by the model from a transcript, new or changing the current one, checked to run and counted, with what it left out as the note. JSON from friend-map's own page only; 409 when Codex is not running or signed in. |

### Change log and bulk edits

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/archive/changes` | The change log, newest first (limit=, 50 by default), each changeset with its first few people; every edit from the app or the CLI is one. |
| GET | `/api/archive/changes/:id` | One changeset, with everyone it touched, each before and after. |
| POST | `/api/archive/changes/:id/undo` | Put back exactly what it changed, as a changeset of its own. JSON from friend-map's own page only; 409 naming who when any of it has changed since. |

### events

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/archive/events` | Server-sent events: `people` whenever people change; `messages` when only new messages came in. |

### Content

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/archive/content/people/:id/timeline` | A person's messages, or with account= one account's of theirs, newest first, up to 5000 a page: older from before=, or newer from after= (a chip in the Table's Who opening their chat at a moment). |
| GET | `/api/archive/content/conversations/:id/messages` | One chat's messages, newest first: a group chat opened in a person's panel, a page at a time (before=, or after= for newer) or all at once. |
| GET | `/api/archive/content/conversations/:id/days/:day` | One chat's messages on one local day, oldest first, a page at a time (after=): a chat in the Calendar view's day panel. |
| GET | `/api/archive/content/search` | Full-text search, by person and platform (no view uses it yet). |
| GET, HEAD | `/api/archive/content/attachments/:id` | An attachment's file, with byte ranges so players can seek. |
| POST | `/api/archive/content/conversations/:id/send` | Send a text message into a direct chat (the composer's Send; the only way anything is sent). JSON from friend-map's own page only; 409 while its connector is not connected. |

### The app

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/settings` | friend-map's own data/settings.json, not the archive's, with defaults filling any gap. |
| GET, PUT | `/api/view-settings` | The captain's saved view settings, data/view-settings.json (the Spider web's, with the names choice): read, or changed a few at a time, each to one of its own values, from friend-map's own page only. |
| POST | `/api/usage` | Record which view was open, and for how long, from friend-map's own page only. |
| GET | `/api/me` | Where the captain's photo for the sun on Orbits is shown from, or none. |
| GET, PUT, DELETE | `/api/me/photo` | The captain's photo in data/me/: shown, replaced by an upload (JPEG, PNG, WebP or HEIC, kept as a JPEG), or removed. |

## Tables

A note for every table of the archive and its columns (the columns themselves are the migrations': friend map's archive's in `modules/friend-map/server/db.ts`, the core's in `server/archive/coreDb.ts`, the calendar's in `server/calendar/db.ts`, each other module's in its own).

### `meta`

Small values: rules_version (the rules last run) and counters that change whenever people or links do (people_version, links_version), which the page's live updates follow.

- `key`
- `value`

### `reaction`

An emoji reaction (or a tapback) on a message.

- `message_id`
- `actor_account_id`: The import person who reacted.
- `emoji`
- `added_at`
- `source_id`

### `coverage_span`

What each import claims to cover, so gaps and staleness can be worked out (npm run archive -- coverage).

- `id`
- `platform`
- `conversation_id`: Empty for the whole platform.
- `source_id`
- `from_ms`
- `to_ms`
- `kind`: export, app-db or live.

### `changeset`

The change log: one row per edit to people, from the app or the CLI, kept 90 days; friend map's archive holds the people's, and the inspirations module's database its own for the inspirations. (people.md: "Changing data from a chat")

- `id`
- `at`
- `surface`: app or cli.
- `action`: What was done, in a few words ("edit tag commercial", "merge").
- `description`: The captain's words, when an agent passed them.
- `backup`: The backup the CLI took just before, by file name.
- `summary_json`: Each person's before and after for what changed, and what else changed, for showing.
- `undoes`: The changeset this one undid.
- `undone_by`: The changeset that undid this one.

### `event`

The life archive's event index: one row for each thing that happened, keyed on its source's own id, so importing again changes nothing; never its content. Read freely: what has content behind it is read through the content path alone. (events.md: "The event index")

- `id`
- `origin`: Where it comes from: claude-code or grok-bot (polar's workouts are the exercise module's, in its own database, and rituals' habits and days the rituals module's, from its own store; the archive's rows of them from before stay until `migrate friend-map-module`, the friend map step's move, drops them).
- `native_id`: The source's own id for it (a session's id, a turn's first entry's id), the same every import.
- `kind`: llm_session, llm_prompt or llm_reply (and, until dropped, the old ritual_checkin, ritual_habit, ritual_day, ritual_workouts and workout rows, read by nothing).
- `subkind`: A session: how it was run (cli, claude-desktop). A reply: what started its turn (human, the captain's prompt, or a notice such as task-notification).
- `at`: When, ms since the epoch.
- `at_end`: When it ended, for what lasts (a session, a reply).
- `day`: The local date of at, YYYY-MM-DD: what a day's events are found by.
- `self`: 1 when the captain did it (a session he held, a prompt he wrote).
- `direction`: out for a prompt, in for a reply.
- `detail`: The typed table its detail is in: llm_session or llm_turn (the old rows' ritual_checkin, ritual_habit, ritual_day, ritual_workouts and workout, until dropped).
- `detail_id`: Its row there.
- `device_id`: The device it happened on.
- `size`: How big its content is, never the content: a prompt's or reply's characters, a session file's bytes.
- `has_content`: 1 when tier-2 content stands behind it.
- `first_source_id`: The import that first brought it.
- `last_source_id`: The import that last changed it.

### `device`

A device something happened on: this Mac, so far, where the LLM sessions ran. (events.md: "The event index")

- `id`
- `key`: The connector's name for it, the same every import: computer:<host name>.
- `name`
- `kind`: computer, phone or other.

### `llm_session`

An LLM session's detail: where it ran and where the archive's copy of it is. Its text stays in that copy. (events.md: "The event index")

- `id`
- `project`: The folder it ran in, or the bot it is with.
- `file`: The archive's copy of the conversation (llm/claude-code/..., llm/grok-bot/...), relative to the archive's folder, where its content stays.
- `version`: The tool's version, as the session last wrote it.
- `model`: The model most of its replies came from.

### `llm_turn`

A prompt's or reply's detail: its session, its model, and where its lines are in the session file, which event-content reads them from. Never its text. (events.md: "The event index")

- `id`
- `session_id`
- `role`: prompt or reply.
- `reply_to`: A reply's prompt; empty for a reply to a notice.
- `model`: The model that wrote the reply, or answered the prompt.
- `images`: Pictures in a prompt.
- `tool_calls`: Tools a reply used on its way.
- `line`: Its first line in the session file, from 1.
- `byte_offset`: Where its lines start in the file.
- `byte_length`: How many bytes they take.

### `ritual_checkin`, `ritual_habit`, `ritual_workouts`, `ritual_day`

The rituals connector's detail tables from before the rituals module: a check-in's day, a habit's doing's day and habit, a day's workouts (their categories and stated minutes, and where the day's copy was), and a day's cells (how each habit stood on it). Read by nothing since the module reads rituals' own store; they and their events stay until `npm run archive -- migrate friend-map-module --apply`, the friend map step's move, drops them. (events.md: "Rituals' habits and days, from the rituals module")

### `workout`

The exercise module's, in its own database, `modules/exercise/exercise.sqlite` (`modules/exercise/server/db.ts`), since M4: one row each copy of an activity, with what the archive's `event` row held of it (its origin, native id, sport family, times, day and size) and the detail below, keyed on the old event's id. The archive's own `workout` and `event` rows of workouts, from before, are legacy, copied into the module's database once when it first ran and kept until `npm run archive -- migrate friend-map-module --apply` (the friend map step's move) drops them.

A workout's detail, metadata only: one row each copy of an activity (the live API's and the export's are matched when shown, never merged). Never a heart rate or a coordinate. The viewer's Events lists each activity once, in its Workouts table; the Fitness page shows every activity, with its route and its trusted heart rate read from the copy, and the Health tab the highest heart rate among them. (events.md: "Workouts from Polar", "Exercise")

- `id`
- `sport`: The sport as the source names it.
- `distance_m`: How far, in metres.
- `recorder`: What recorded it (the watch or app).
- `streams`: Which sample streams the file holds, each with its count and rate (JSON); never the samples.
- `file`: Where the copy's file is, in the archive's folder.
- `raw_file`: The raw file beside it (a FIT), when there is one.

### `deleted_workout`

The exercise module's too, in its database (the archive's rows legacy, as `workout`'s). A tombstone for each copy of a workout the captain deleted from the Fitness page, so no source brings it back: the import writer and the Polar connectors leave out its own copy and any copy of the same activity. Only enough to know it again; nothing of what it held. (features.md: "Exercise")

- `origin`: The copy's source (polar).
- `native_id`: The source's own id for the copy (Polar's exercise id; export/<id> for its account export's).
- `family`: Its sport family, to know another source's copy of the same activity.
- `at`: When it started, ms since the epoch.
- `at_end`: When it ended.
- `deleted_at`: When it was deleted.

### `workout_correction`

The exercise module's, in its database (`modules/exercise/server/corrections.ts`). What the captain changed of a copy from the Workouts table, one row a field, kept beside the copy as its source gave it, so an import of it again never undoes it; every read of the index takes them over the copy (the calendar, its rebuild, the Fitness page, the agents' tools). An activity's copies are corrected alike, so they stay one activity. A correction back to what the source says is no row. Made and undone under the module's own change log (`changeset`, `change_row` in its database). (console.md: "Editing")

- `origin`, `native_id`: The copy, as `workout` keys it.
- `field`: sport, at, at_end or distance_m.
- `value`: What he says it is: the sport in its source's word, an instant (ms), metres, or none.
- `set_at`: When he last set it.

### `workout_note`

The exercise module's too: the captain's note on a copy (every copy of an activity has the same). Content: only its editor reads it, when he opens it, each read kept in the trail; a delete takes it, and its change log's rows, with the workout.

- `origin`, `native_id`: The copy.
- `note`: His words.
- `set_at`: When he last set it.

### `table_edit`

The core's, in `core.sqlite` (`server/edits/log.ts`): the record of the tables' edits, one row for each change made to a row of a table through its owner (from a row's drawer on the Calendar or in a table, or `npm run archive -- edits undo`), each undoable. Never a note's words, and people by their owner's ids, so nothing in it names a person. (console.md: "Editing")

- `id`, `at`
- `surface`: app or cli; `who`: the CLI's reader, as $LIFE_ARCHIVE_READER names them.
- `kind`: The table (workouts, calls, hangouts, habits, ritual-days); `module`: its owner.
- `origin`, `native_id`, `row_kind`: The row, as the calendar keys it.
- `field`: The field, as the table's edits name it.
- `before_json`, `after_json`: What it was and became; null for a note's words.
- `receipt`: The owner's own record of it (friend map's or exercise's changeset, the rituals' requests and what they changed), which its undo is given back.
- `undoes`, `undone_by`: The edit it undid, and the one that undid it.

### `inspiration`

The inspirations module's, in `modules/inspirations/inspirations.sqlite` (`core.sqlite` keeps its old copy of this table and the six below, read by nothing). One item for one thing the captain keeps: a link in its one canonical form, or a photo with no link, joined by its kept file's hash. What is known of it fills only what is still empty, from what the capturing agent saw and then its preview. Metadata, all of it.

- `id`
- `link`: The canonical link (Instagram's /p/<code>/, X's /i/status/<id>, YouTube's watch?v=<id>, any other without its fragment or tracking); empty for a photo.
- `platform`: Whose link it is (instagram, x, youtube, web), or file.
- `form`: What it is there: a post, reel, video, short, page or photo.
- `title`
- `author`
- `description`
- `image_url`: Its preview's picture, never downloaded.
- `caption`: His own words about it; a second save's are added after a blank line.
- `hidden_at`: When he hid it.
- `created_at`
- `edited_at`
- `preview_state`: The worker's queue for its preview: waiting, done, none or failed.
- `ai_state`: The worker's queue for its AI tags: waiting, done or failed.
- `ai_model`: The model that made its AI tags.
- `ai_at`: When they were made.
- `ai_error`: Why the last try failed.
- `ai_tries`: How many tries since it was last asked.
- `ai_retry_at`: When to try again, after a growing wait.
- `preview_tries`: How many times Instagram's lane has asked for its post.
- `preview_retry_at`: When Instagram's lane may ask for it again.
- `preview_note`: What Instagram's lane found, skipped and why, gave up on, or is blocked until.
- `probe_requested_at`: Old items only: when firstmate was told that his words ask for something to be done with it; nothing sets it any more, null otherwise.
- `probe_result`: Old items only: the probe's result, a web link to its report or preview; read, never set any more.
- `probe_result_at`: Old items only: when the result was set.

### `inspiration_save`

Each time and place an item was sent in, kept as it came: the same reel sent again is a second save of one item.

- `id`
- `inspiration_id`
- `origin`: The door it came in by (share-sheet, grok-bot, cli).
- `native_id`: The door's own id for it, so a save is never kept twice.
- `link`: The link as given.
- `caption`: The words sent with it.
- `saved_at`

### `inspiration_file`

A photo or screenshot sent in, kept by its hash in modules/inspirations/files/<xx>/<sha256>.<ext> (its path from the module's folder; platform-exports/inspirations/live/ before the module, whose copies stay there). Nothing else is downloaded.

- `id`
- `inspiration_id`
- `role`: What it is to the item (its picture).
- `path`: Where it is, in the archive's folder.
- `mime`
- `bytes`
- `sha256`
- `added_at`

### `inspiration_fetch`

Every fetch the worker's Instagram lane made, logged out, so its pace holds across restarts: one post at a time, 15 to 30 seconds apart, at most 100 a day, and a pause of 6 hours, doubling up to 48, after Instagram refuses one.

- `id`
- `platform`: Whose servers were asked (instagram).
- `inspiration_id`: The item it was for; empty once the item is gone.
- `at`
- `outcome`: found, empty, blocked or failed.
- `note`: Why, in a few words.
- `next_at`: The platform's next fetch, not before this.

### `inspiration_tag`

The captain's inspiration vocabulary, apart from people's tags, in his order: a tag is added by tagging with it and stays until he deletes it; renaming one onto another merges the two.

- `id`
- `name`: Written as tags are (interior-design).
- `description`: What it covers, which also steers the AI.
- `sort_order`: His order.
- `created_at`

### `inspiration_item_tag`

His tags on each item, any number, so one thing can be about two at once.

- `inspiration_id`
- `tag_id`
- `added_at`

### `inspiration_ai_tag`

The AI's tags on each item, two to five free words written as tags are, best first, from the AI service; never made his, and never mixed with his in a filter.

- `inspiration_id`
- `name`
- `rank`: Best first.

### `content_read`

The trail of content reads: every read of message text, search or an attachment's file through the CLI's timeline and search and the content routes, the same read again within ten minutes adding to its row. Never deleted from. Since the calendar came (server/calendar/) the trail is written in the calendar's file, the core's, where the archive's rows were copied once; the friend map step's move (`migrate friend-map-module`) dropped this table from the archive. (archive.md: "The message archive", "The calendar")

- `id`
- `at`: The first read.
- `last_at`: The last read added to it.
- `reads`: How many.
- `surface`: cli or app.
- `reader`: Who, as FRIEND_MAP_READER named them; empty when unnamed, as the app's page is.
- `what`: timeline, search, event-content, conversation, day or attachments.
- `scope_json`: What it read: a person, a chat, a day of one, search words, an event and its kind, and whether redacted.
- `why`: The captain's words for the job, when given.

### `change_row`

Every row a changeset changed, as it was before and after, written by triggers only while a changeset is recorded, so it can be undone exactly. (people.md: "Changing data from a chat")

- `id`
- `changeset_id`
- `tbl`: person, tag, person_tag, import_person, merge_proposal, conversation (a group chat dropped), conversation_member (someone taken out of one), group_unlink (someone unlinked from one), catch_up, catch_up_person, call_length, call_note, call_answered, manual_call or draft; rows of field_value and person_field_value from before migration 32 that it could not fold into person rows stay, and refuse an undo.
- `row_key`: The row's key, as a JSON array.
- `before_json`: The row before; empty when the changeset added it.
- `after_json`: The row after; empty when the changeset deleted it.

### `catch_up`

Catch-ups, which the page calls hangouts: time the captain spent with people in person (never by call: a call is a logged call, manual_call), each worth its hours times an hour's worth of direct messages in the closeness score on its date, times each one's share with everyone at it, unnamed others too (half shared by all, half split, by default). A trip (several days away together) runs from its day and time to its last day and end time, less a private window each day, and counts each day's part on that day. His own record: imports never write one. (people.md: "People")

- `id`
- `day`: Its local date, 2026-10-04: today or before.
- `time`: When it started that day local time, 19:30, or none: where it sits in the person's chat. A one-day hangout's score never reads it; a trip needs it, its time together starting then.
- `hours`: How long it lasted: above 0, at most 24, to two decimal places; a trip's time together in all, which the archive works out from its times and private window (tripHours).
- `note`: The captain's note on it; empty for none.
- `others`: How many more were there that he did not name (a crowd): 0 to 10,000, 0 for none. They take a share of its worth and are no one.
- `trip_last_day`: A trip's last local date, after its day and no later than today, at most 366 days in all; none for a hangout on one day. The trip's columns are all set or all none.
- `trip_end_time`: When a trip ended on its last day, 14:00.
- `trip_private_from`: When each day's private window starts on a trip, 00:00 unless the captain says: hours kept to himself, which do not count.
- `trip_private_to`: When it ends, 10:00 unless he says; earlier than its start runs across midnight, the same is no window.
- `created_at`

### `manual_call`

A call the captain logs himself (Add event's Call), with one person on one of their accounts that carries calls: it counts as a call imported on that account does, under the account, in the chat, the calls added up, the Calendar and the closeness score. A call with several people (or people on it unnamed) is one row each, sharing a call group, and the score gives each their share of its time, as a hangout's worth is shared. One on the phone or FaceTime with one person and that day's calls from the phone's call history count the longer, never both, as it may be one of them (callDays). His own record: imports never write one, so a re-import neither deletes nor repeats it. (people.md: "People")

- `id`
- `call_group`: The calls logged as one call with several people share it (the number of the first logged); a call with one person is a group of one. A change or delete of any is of the whole group.
- `person_id`: Only for one on no account (someone with no account that carries calls): who it was with (never the captain). A merge gives the one kept the other's.
- `account_id`: The account it was on; its person is who it was with, so it goes with the account through a merge or a detach, and its platform is the call's. Null only for one on no account.
- `at`: When it started, milliseconds since the epoch.
- `duration_seconds`: How long it lasted, in whole minutes as seconds: from 60 to a day.
- `app`: Only for one on no account: what it was on (phone, facetime, whatsapp, messenger, instagram, signal, telegram, wechat, discord or other).
- `note`: The captain's note on it, the whole group's, as its time and length are; empty for none. Content: SQL never reads it.
- `others`: How many more were on it that he did not name, the whole group's: 0 to 10,000, 0 for none (migration 60). They count among its people, so each one named takes a smaller share; one made of a hangout keeps the hangout's.
- `created_at`

### `draft`

A message the captain is writing to someone, saved as he types in the draft box at the foot of their panel. Any number per person (the panel shows each, one for now); his scratch space, so no changeset, though a merge moving one is logged. The draft openers became drafts in migration 38. (people.md: "People")

- `id`
- `person_id`: Whom it is to.
- `text`: The message so far; never empty (emptied, it is deleted).
- `created_at`
- `updated_at`

### `catch_up_person`

Who was at each catch-up: one person or more, never the captain. A merge gives the one kept the other's. (people.md: "People")

- `catch_up_id`
- `person_id`

### `group_unlink`

A group chat the captain unlinked someone from (the person panel's break-link button): they stay in it, counted in its size and their closeness, but it connects them to nobody (no links or friend circles through it). By person, so a merge gives the one kept the other's; imports never write it. (people.md: "People")

- `person_id`
- `conversation_id`: The group chat.
- `unlinked_at`

### `person_tag`

Who has which tag. (people.md: "People")

- `person_id`
- `tag_id`
- `added_at`

### `message_fts` *(derived)*

The full-text index of message text (SQLite FTS5), kept in step with message by triggers.

- `text` *(derived)*: Indexed from message.text.

### `message_chars` *(derived)*

Each message's length in characters, kept in step with message by triggers, so the archive's viewer can chart and sort messages by length without reading their text.

- `message_id`
- `chars` *(derived)*: The length of message.text.

### `tag`

The captain's tags, one row each, in the captain's order. "archive", "keep", "live-together" and "show-name" are built in. (people.md: "People")

- `id`
- `name`: Lower case, spaces written as dashes.
- `sort_order`: 0 first; every tag list goes in this order.
- `built_in`: 1 for "archive", "keep", "live-together" and "show-name": moved, never renamed, merged into or deleted.
- `created_at`

### `attachment`

A photo, video, voice note or file on a message: the file itself in an export under platform-exports/ (the newest export holding it), a copy in its platform's live folder there, or an old copy in archive/media/.

- `id`
- `message_id`
- `ordinal`: Its place among the message's attachments.
- `platform_attachment_id`
- `type`: image, video, audio, gif, sticker or file.
- `filename`
- `mime`
- `size`: In bytes.
- `sha256`: The file's content hash, which a copy is named by.
- `local_path`: Relative to the archive's folder: platform-exports/<platform>/<export date>/... for a file in its export, platform-exports/<platform>/live/... for a live copy, archive/media/... for an old copy; empty when the source lacked the file.
- `source_id`

### `conversation`

A chat on one platform.

- `id`
- `platform`
- `platform_conversation_id`: The platform's id for the chat.
- `type`: direct (you and one other person) or group.
- `title`
- `is_marketplace`: 1 for a Facebook Marketplace chat, left out of every count.
- `is_self_only`: 1 when its source holds only the captain's own messages (Discord's data package), so whether others wrote in it is not known.
- `dropped_at`: When the captain dropped this group chat (npm run archive -- group drop): it links nobody and counts in nothing worked out from group chats, though its messages stay. Imports never write it.

### `import_person_stats` *(derived)*

What each import person did, counted from the messages when imports or rules run, so people and the archive rules are read without a scan.

- `import_person_id`
- `direct_count` *(derived)*: Messages in one-to-one chats with them, both ways.
- `group_count` *(derived)*: What they sent in group chats.
- `marketplace_count` *(derived)*: Messages in Marketplace chats with them.
- `last_message_at` *(derived)*: Outside Marketplace.
- `they_direct` *(derived)*: What they sent in one-to-one chats.
- `you_direct` *(derived)*: What the captain sent in one-to-one chats with them.
- `you_direct_self_only` *(derived)*: What he sent in those of them whose source holds only his side: the archive rules never call such a chat one-sided.
- `in_direct` *(derived)*: In any one-to-one chat.
- `in_group` *(derived)*: In any group chat.
- `in_marketplace` *(derived)*: In any Marketplace chat.
- `in_small_group` *(derived)*: In a group of twelve or fewer, the captain included, where the captain sent at least one message (whether or not they did); the archive rules keep them.

### `message`

One message. Not a cache: it may exist nowhere else later.

- `id`
- `platform`
- `conversation_id`
- `platform_message_id`: The platform's id, or one made from the content.
- `id_kind`: "platform" or "synthetic".
- `sender_account_id`: The import person who sent it; empty for system events.
- `is_from_self`
- `sent_at`: Milliseconds since the epoch.
- `type`: text, media, link, sticker, call, location, contact, system or other.
- `text`: Message content: served only under /api/archive/content/.
- `reply_to_platform_id`: The platform id of the message it answers.
- `unsent`: 1 once taken back; its text is gone.
- `edited_at`
- `call_seconds`: A call record's length, when its app says (Messenger, Instagram): seconds connected, 0 never answered (which Signal says too); empty otherwise. Any call in a one-to-one chat counts as a call, not a message; one with no length counts nothing until the captain gives it one (call_length).
- `first_source_id`: The import that first brought it.
- `last_source_id`: The import that last saw it.
- `raw_json`: The original record.

### `conversation_member`

Who is in each chat, the captain included.

- `conversation_id`
- `account_id`: An import person.
- `removed_at`: When the captain took this member, who never wrote there, out of the group chat (npm run archive -- group remove-member): they are no member of it in anything worked out from group chats. Imports never write it.

### `merge_proposal`

Two identities that may be the same person, found by the rules; a rejected pair is never proposed again. (people.md: "People")

- `id`
- `left_key`: A person (person:<id>) or an account (account:<platform>:<key>); not a foreign key, so it survives rebuilds.
- `right_key`: The other one; left_key sorts first.
- `rule`: Which rule proposed them.
- `tier`: high, medium or low.
- `evidence_json`: Why, for the captain to judge.
- `status`: pending or rejected.
- `created_at`
- `decided_at`

### `derived` *(derived)*

Reports worked out from the messages (the message-derived part of relationships), kept until what they were made from changes.

- `key`
- `stamp`: What it was made from; a different stamp means work it out again.
- `json` *(derived)*

### `import_person`

One identity on one platform, as an import found it (the code and connectors still call it an account), and which person it is. (people.md: "People")

- `id`
- `platform`: messenger, whatsapp, imessage, telegram, …
- `key`: The strongest identity the platform offers: a JID, a handle, or a display name.
- `key_kind`: "id", or "name" when the export has nothing better.
- `display_name`: Its name as the connector gave it.
- `handle`: Phone number (E.164), email or username.
- `is_self`: 1 for the captain's own accounts.
- `person_id`: The person it is.
- `name_source`: Where the connector found the name, when it says.
- `first_seen_at`: When an import first reported it.
- `last_seen_at`: When an import last reported it.
- `link_source`: How it came to be linked: "import", "rule:<name>" or "captain" (rules never undo the captain's).
- `linked_at`

### `call_length`

The length the captain gave a call record whose app says none (WeChat's compressed ones, Signal's answered calls, Messenger's phone-app export), from the chat's Add length or Events' Calls table: it then counts as a call that long. His own record: imports never write one, and the change log keeps each change, so it can be undone. (archive.md: "The message archive")

- `message_id`: The call record (a message of type call, in a one-to-one chat).
- `seconds`: How long he says it was, in whole minutes as seconds: from 60 to a day.
- `set_at`: When he last set it.

### `call_note`

The captain's note on an imported call, from Events' Calls table, shown beside the call in its chat (a logged call keeps its own, manual_call.note). One row for each call he has given a note: a call record in a chat by its message, or a call in no chat by its source's own key, which every row of a call with several people shares and a re-import keeps. His own record: imports never write one, and the change log keeps each change, so it can be undone; a note taken away leaves its row, emptied. Content: SQL never reads it. (archive.md: "The message archive")

- `id`
- `message_id`: The call record (a message of type call, in a one-to-one chat); null for a call in no chat.
- `platform`: For a call in no chat: its platform (call.platform); else null.
- `platform_call_id`: For a call in no chat: its source's own id (call.platform_call_id); else null.
- `note`: The note, as he wrote it, trimmed; empty once taken away.
- `set_at`: When he last set it.

### `call_answered`

Whether an imported call was answered, as the captain says in Events' Calls table or with the chat's No answer (which the chat reads back beside the call record): answered, missed or unknown, over what its source says (call.answered, or a call record's length), which stays as it was. The closeness score follows it: missed or unknown counts nothing whatever its length, answered counts its length. Kept as call_note is: one row for each call he has set, a call record in a chat by its message, or a call in no chat by its source's own key. His own record: imports never write one, and the change log keeps each change, so it can be undone; set back to what its source says, its row is emptied. (archive.md: "The message archive")

- `id`
- `message_id`: The call record (a message of type call, in a one-to-one chat); null for a call in no chat.
- `platform`: For a call in no chat: its platform (call.platform); else null.
- `platform_call_id`: For a call in no chat: its source's own id (call.platform_call_id); else null.
- `answered`: answered, missed or unknown; empty once set back to what its source says.
- `set_at`: When he last set it.

### `call`

A call in no chat, metadata only: one from the phone's call history, with one other party, or an app's call with several people made in no group chat (a WhatsApp three-way call), one row for each person on it its source names, sharing its call id, with how many more it could not name. Kept apart from messages, so it counts in no message count; a day's answered calls count toward closeness by how long they were, as hours caught up, added to the day's calls with them on the other apps whose length is known (message.call_seconds, or call_length), each on a call with several taking their share of it. (archive.md: "The message archive")

- `id`
- `platform`: phone, or the app (whatsapp).
- `platform_call_id`: The source's own id for it (the call history's ZUNIQUE_ID, WhatsApp's call id), so a newer copy adds only new calls; shared by the rows of a call with several people.
- `import_person_id`: Who it was with: on the phone's, the other party, an account on platform phone keyed by number or Apple ID; on an app's with several people, one of them (one row each).
- `at`: When it started, milliseconds since the epoch.
- `duration_seconds`: How long it was connected; 0 for one never answered; NULL when the source does not say (answered on another of the captain's devices).
- `direction`: incoming or outgoing.
- `answered`: 1 when connected: picked up when it came in, or answered at the other end (or by voicemail) when it went out.
- `service`: phone, facetime-audio or facetime-video; an app's voice or video.
- `others`: How many more were on it, whom its source could not name (no chat in the copy has them); 0 for none.
- `first_source_id`: The import that first brought it.
- `last_source_id`: The import that last saw it.
- `raw_json`: The original record, without its binary fields.

### `message_alias`

The id another connector gave a message the archive already holds, so the same message from two exports is kept once.

- `platform`
- `platform_message_id`: That connector's id for it.
- `message_id`: The message kept.
- `source_id`

### `person`

The captain's record of someone. Everything the captain decides about people lives here and in its neighbours, so it is backed up with the archive. (people.md: "People")

- `id`
- `name`: Their name: the first of the names they go by, which labels them everywhere.
- `name_source`: "import": follows its one import person's name; "captain": the captain named them.
- `aliases_json`: The other names they go by, after their name, in order (the person panel's chips; the Query bar's person_names view lists every name).
- `is_self`: 1 for the captain's own person.
- `edited_at`: When the captain last named, tagged or merged them; empty if never.
- `archive_rule` *(derived)*: The automatic archive rule that fits them, stored when the rules run.
- `created_at`: When they were added to the archive: by the import that first met them, or by the captain (Add person; a detach makes a fresh person then). A merge keeps the kept person's. The Table's Added.
- `note`: The captain's free-text note.
- `address_book_note`: The note as the address book last wrote it: while the note still matches, the address book may write it again.
- `should_reach_out`: 1 when the captain should reach out to them (Orbits' glow); indexed, to list them.
- `identicon_seed`: What their identicon (src/identicon.ts) is drawn from: 16 hex digits, given when they are made, from their id and when they were made, and a new one at random for each new picture drafted in the person panel's icon picker, kept when saved. Kept rather than the picture, so the drawing can be retuned.
- `identicon_hue`: The hue the captain picked for their identicon in the person panel's icon picker, whole degrees 0 to 359: their main colour everywhere (Orbits' dot, name and glow among them), the seed still drawing the picture. Null for the seed's own colour.
- `location`: Where they are, as far as the captain last knew ("Sampletown"), as typed; empty for not said. Compared without case, one spelling each, and indexed, so who is where and every location with how many come from the index.

### `message_version`

Earlier texts of a message whose text changed between imports.

- `message_id`
- `text`: The text before.
- `replaced_at`
- `source_id`

### `source`

One import: of an export file, a read of an app's database, or one run of a sync connector (kind live).

- `id`
- `platform`
- `connector`: The connector's id (its folder under server/connectors/).
- `kind`: export, app-db or live.
- `label`: The file or folder name.
- `content_sha256`: Of an export file, to notice one imported before.
- `started_at`
- `finished_at`
- `status`: running, ok or failed.
- `counts_json`: What it added and skipped (a live run's, summed over its batches).
- `error`

### `outgoing_message`

Each message the captain sent from friend-map: where to, when, and what the platform said. Never its text: the message arrives through sync and is kept in message.

- `id`
- `connector`: The sync connector that sent it.
- `conversation_id`
- `requested_at`
- `status`: sending, sent, failed, or unconfirmed (handed to the bridge, which did not say in time; also a send the server stopped in the middle of).
- `finished_at`
- `error`: Why it failed, in the platform's or bridge's words.
- `platform_message_id`: The sent message's id, when the platform gave one.

### `connector_state`

Each connector's last run, errors and backoff.

- `connector`: The connector's id.
- `status`: idle, running or error.
- `last_run_at`
- `last_ok_at`
- `last_error`
- `last_error_at`
- `failures`: Failed runs in a row.
- `retry_after`: Backoff: no automatic run before this time.
- `cursor_json`: Where a sync connector resumes: the cursor of its last applied batch (matrix-bridge's: the sync token, walks in progress, rooms walked, events waiting).

### Links that are not foreign keys

- `merge_proposal.left_key` → `person.id`: person:<id>
- `merge_proposal.left_key` → `import_person.id`: account:<platform>:<key>
- `message.reply_to_platform_id` → `message.platform_message_id`: replies to
- `source.connector` → `connector_state.connector`: same connector
- `event.detail_id` → `llm_session.id`: detail = llm_session
- `event.detail_id` → `llm_turn.id`: detail = llm_turn
- `event.detail_id` → `ritual_checkin.id`, `ritual_habit.id`, `ritual_day.id`, `ritual_workouts.id`, `workout.id`: the old rows' detail, until dropped
