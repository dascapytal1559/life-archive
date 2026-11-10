# Import runbook

How to bring the archive up to date from every platform, at any time: an **import session**.
The captain runs one, or asks firstmate to.
Each connector has a section below, headed by its id, with where a fresh copy comes from, how long it takes, where it goes, the commands, how to check it worked, and the steps a computer-use agent can take for him.

Nothing here is about one person.
Which platforms are used, when each was last imported and how far each reaches are read from the archive when the session starts (`import-status`, below), so they are never written into this repository.

Rules for whoever runs a session, person or agent:

- Never open a message's text, a photo, a video or any other media.
  Exports are moved, unpacked and imported by their names, sizes and dates only.
- Put every export under `data/platform-exports/`, nowhere else, and never copy one out of `data/`.
  `data/` here is the archive's folder for short: `~/life-archive-data`, unless `LIFE_ARCHIVE_DATA` names another, which the commands below then take in its place.
- Take a backup before every import (`npm run archive -- backup before-import-<connector>`): a checked copy of the archive, and of each module's database beside it.
  The prune keeps every `before-import-` backup for 48 hours, so each import in a session has its own restore point; other backups keep only the newest of each day.
- Never write a real name, number, username, account id or file name that holds one into this repository (see AGENTS.md, "What the repository holds").

## Starting a session

```sh
npm run archive -- import-status    # each connector the archive has imports from, and what to do next
npm run archive -- connectors       # the live connectors' state in more detail, and any connector's last error
```

`import-status` reads the archive: a connector with an import that finished well is one the captain uses.
It groups them by where a fresh copy comes from, in the order a session works through them:

| Way | What it takes | Below |
| --- | --- | --- |
| Live | Nothing to import: check the bridge rig is connected | "Live: nothing to import" |
| This Mac | A copy of the app's database, in minutes, from the terminal | "From this Mac" |
| iPhone backup | A backup of the phone over Wi-Fi into the one kept on this Mac (only what changed is sent), the passcode typed on the phone, then a copy out of it | "From an iPhone backup" |
| The platform | A request; the export arrives minutes to days later | "From the platform" |

For each it prints how far its imports reach ("covers to"), when it was last imported, and the next step, with the day to ask an export to start from where the platform lets you choose.
Below them it lists the connectors never imported, each with how to start.

The captain has not set how often to import.
These keep their own clocks, so leave none of them longer than this:

- **Phone calls**: the Mac keeps only about a year of phone calls, so a call older than that is lost unless a copy taken before then holds it. The 15-minute sync copies it whenever a call comes in; if it stops (Full Disk Access taken away, say), copy it within a few months.
- **WhatsApp live**: the phone must come online at least every 14 days, or WhatsApp unlinks the bridge (the bridge reminds the phone at 10 days and warns at 12).
- **Telegram live**: Telegram ends a session left unused for as long as the account's "automatically terminate old sessions" setting says.
- **Signal Desktop**: it receives messages only while it is linked; open it now and then so Signal does not unlink it.
- **Export links**: Meta's downloads expire after about four days; download each export when it arrives.

### The order of a session

1. **Look**: `npm run archive -- import-status`.
2. **Request the slow ones first**: every platform export that is due, in one sitting (with computer-use help, below), since they take minutes to days to arrive.
   Use the "from" day `import-status` gives where the export takes dates.
   Instagram, Facebook, Messenger's encrypted chats and Discord need nothing here: the Cua Space's schedule requests and imports them (`npm run cua-exports -- status`).
   Signal is the captain's, on his Mac; the schedule reminds him when it is due.
3. **Copy from this Mac**: calls and Messages, which the job does every 15 minutes (`npm run mac-imports`; "This Mac's sync"); by hand only when it has stopped (its log says).
4. **Take an iPhone backup** when the phone is at home on the Wi-Fi: WeChat, and WhatsApp when the live bridge had a gap.
5. **Import each export as it arrives**, the same way every time (next section).
6. **End**: `npm run archive -- import-status` again, and `npm run check-data`.

### Every import, the same way

```sh
day=2026-10-09                                   # the day the export was made (YYYY-MM-DD; a second one that day: 2026-10-09-2)
mkdir -p ~/life-archive-data/platform-exports/<folder>/$day/    # <folder>: the platform, but calls for the phone's calls
mv ~/Downloads/<the export's files> ~/life-archive-data/platform-exports/<folder>/$day/
npm run archive -- exports unpack ~/life-archive-data/platform-exports/<folder>/$day/    # when it came as zips holding media
npm run archive -- backup before-import-<connector>
npm run archive -- import-status                 # note the "covers to" before
npm run archive -- import <connector> ~/life-archive-data/platform-exports/<folder>/$day/
npm run archive -- import-status                 # "covers to" has moved on to the export's newest message
npm run check-data                               # fix every problem it names before going on
```

- The import prints what it added, updated and skipped, by count; `npm run archive -- coverage` gives the platform's message count and any gaps, and `npm run archive -- storage` the space each export takes.
- Importing the same export twice adds nothing, and an export that overlaps the last adds only what is new, so a "from" day earlier than needed is harmless.
  Each export keeps its own dated folder; the archive's attachments point at the newest export holding each file (data.md, "Platform exports").
- An import that fails or is stopped leaves the archive as it was; run it again.
- To take an import back: stop the server, move the database the import wrote and its `-wal` and `-shm` files aside, and copy the backup of it taken before that import there: for a chat connector, friend map's archive, `data/modules/friend-map/archive.sqlite`, from `data/backups/<date>T<time>-before-import-<connector>.archive.sqlite`; for an exercise connector (`polar`, `polar-export`), `data/modules/exercise/exercise.sqlite`, from `…-before-import-<connector>.exercise.sqlite`; for the core's (`llm-sessions`, `grok-bot`), `data/core.sqlite`, from `…-before-import-<connector>.sqlite`. Then, before starting the server, run `npm run archive -- calendar rebuild`, so the calendar forgets what that import pushed into it.

## Computer-use help

Most requests are a few screens in a browser or an app, and an agent can do them, stopping where only the captain can go on.
Each platform section has **computer-use steps**; a step marked **[captain]** needs him: signing in, a code sent to him (2FA), a password, the phone's passcode, or anything on the phone itself.

### The Cua Space's schedule: Instagram, Facebook, Messenger and Discord

`instagram-dyi`, `facebook-dyi`, `messenger-export` (from messenger.com, since Messenger's phone app has no download) and `discord-package` are requested, downloaded and imported by themselves, with no import session: an agent in his Cua Space makes the requests each day they are due and downloads each export when it is ready, and `npm run cua-exports` on this Mac takes it into the archive the way "Every import, the same way" does (data.md, "Exports from the Cua Space", for how it works).
Instagram and Facebook are asked for each week, from the day before `import-status`'s "covers to" to the day before today, since the Space's Chrome keeps US Pacific time and Meta will not save a range ending after its own today (Messages only, JSON, higher quality); Messenger's encrypted chats and Discord each 30 days.
The steps it follows are the platform sections' computer-use steps, written for it in `modules/friend-map/jobs/cuaExports/agent/PLAYBOOK.md`, under the same rules as below.

What a session does about these four is only look:

```sh
npm run cua-exports -- status    # the schedule, the latest rounds, today's plan, the latest events (a stop names what is needed), the imports
```

**[captain], once.** In the Space's own screen (the Cua app's viewer, or `cua sandbox view <the Space>`):

1. Sign Codex in: in Terminal there, `codex login` (the full line, with the PATH it needs, is what `npm run cua-exports -- setup` prints), with a ChatGPT account. Each round's Codex uses this sign-in (the Space's `~/.codex`).
2. Double-click **Export browser** on its Desktop: the agent's Chrome profile (`friend-map-exports`) opens at the four pages. Sign in to Instagram, Facebook, messenger.com and Discord (Discord also takes a QR code from its phone app), then quit that Chrome (Chrome > Quit Google Chrome): a round cannot use the profile while it is open by hand. Not Chrome from the Space's Dock: that is Chrome's default profile, which the rounds cannot use, and Chrome sync brings no site's sign-in, so a Google sign-in is not needed.

Then, from the life archive's checkout on this Mac: `npm run cua-exports -- install`, `npm run cua-exports -- setup --enable`, and `npm run cua-exports -- nudge` for a first round.

**Meta's password, again.** The password Meta asks for again at Start export or Download is not a stop: the round asks the Cua Keyvault to fill it, through the browser bridge on this Mac (data.md, "Exports from the Cua Space"), and goes on. The Keyvault asks him to approve each such request in Cua (Touch ID), and firstmate hears its request id, until that login is unlocked in Cua (Keyvault > All Items > the login > its lock); after that it needs nothing from him, and firstmate hears only that it was handled. A site's box needs that site's login imported once into the Keyvault from Chrome (`cua keyvault import-passwords --site facebook.com`, or `instagram.com`, or `messenger.com`, with Touch ID), and until then the box there is a stop.

**[captain], at a stop.** The Mac raises a notification and firstmate hears, both within 15 minutes: a sign-in that expired, Meta's password box where the Keyvault could not fill it (no login saved for that page, or he declined), a code, a captcha, Meta's "Was this you?", Messenger's secure storage PIN, an identity check, the Export browser left open, and each Discord package's emailed link, which he opens in the Export browser. The agent leaves its Chrome window open and waits up to 45 minutes: done there on the Space's screen, the round goes on by itself. Later, he does it in the Export browser (quit after), then `npm run cua-exports -- nudge` (else the next day's round goes on).

**When it goes wrong.** No round starts while the browser bridge is not answering (`status` says whether it is; its log is `~/Library/Logs/LifeArchive/cua-bridge.log`, and `npm run cua-exports -- install` puts it back). An import that fails leaves its export in `data/platform-exports/<platform>/<day>/`: run the import by hand as "Every import, the same way" says, from the backup step. A round whose run failed (Codex did not start, say) is told to firstmate once, and `status` gives Cua's reason; `codex login status` in the Space's Terminal says whether Codex is still signed in. The agent silent for two days means Codex is signed out in the Space, or the Space stopped. To make the requests by hand instead, `npm run cua-exports -- setup --no-enable` and follow the platform's section.

### By hand, or by firstmate's worker

**The browser: one the captain is already signed in to.**
For a request the schedule does not make, the steps run in a browser where his sessions persist, so a sign-in is a stop only the first time on each site, or when the site ends the session:

- **From the desktop**, a dedicated Chrome profile for this work, driven through `chrome-devtools-axi`. He signs in to each site once in that profile, and stays signed in from one import session to the next.
- **From the phone**, Codex (reached from the ChatGPT app) uses its Chrome extension on this Mac.

Either way, two-factor codes and identity checks are his: the worker stops and asks.

**How firstmate runs them.**
firstmate does the terminal steps itself (copies on this Mac, unpacking, imports, the checks).
For a request made in a browser, it hands that section's computer-use steps to its computer-use worker: by the installation's routing (a computer-use model through Pi, say), driving that Chrome profile through `chrome-devtools-axi`.
That worker cannot control a Mac app; native control is only in the ChatGPT desktop app's Computer Use plugin, so steps in a Mac app (Signal Desktop) go to the captain to run there, or to do himself.
Steps on the phone are always his.

The hand-off to the worker is the section's steps, the "from" day from `import-status`, and these rules:

- Request the export, and download it when it is ready; change no other setting, and delete nothing.
- Never open or read a message, a photo or the export's contents; never paste them anywhere.
- At a **[captain]** step, stop and say what he needs to do; go on when he says it is done.
- Report what was requested and when, what the platform said about the wait, and where any download was saved.

Cua Spaces' Keyvault is not used for imports by hand: only the Cua Space's rounds use it, for Meta's password box.

## Live: nothing to import

The captain's conversations with agents (Claude Code's and Grok Bot's) reach the archive within seconds, the archive's server watching their apps' files; Telegram and WhatsApp reach it as they happen, through the **bridge rig** (`~/.local/share/friend-map-bridge-lab/`, its README for everything about it; archive.md, "Telegram, live" and "WhatsApp, live").
A session only checks they are still following along:

```sh
npm run archive -- import-status    # live: each is "nothing: it follows along by itself" when connected
npm run archive -- connectors       # the same state, and any last error
cd ~/.local/share/friend-map-bridge-lab && ./service.sh status    # the homeserver and both bridges running
```

`import-status` also gives each platform's newest message: a platform with friends who write every day and nothing for days is worth a look even when it says connected.

### `matrix-bridge`

Telegram, live.

- **Healthy**: `connectors` says `live: connected`; the newest Telegram message is recent.
- **Not connected**: `waiting` means the rig's homeserver does not answer (`./service.sh start homeserver`, or `./service.sh status` to see which part is down); `logged-out` means Telegram ended the bridge's session (the rig's README, "log in": the captain runs `./telegram-login.sh` with his number and the code Telegram sends him **[captain]**).
- **A chat missing**: chats in Telegram's Archive folder, groups of more than 12 and channels are left out by choice (archive.md, "Telegram, live").
- **Gap**: after an outage the bridge catches up by itself; history it missed is refilled as the rig's README says (`delete-all-portals`, then `sync-chats`).

### `matrix-whatsapp`

WhatsApp, live, read only.

- **Healthy**: `connectors` says `live: connected`; the newest WhatsApp message is recent.
- **Unlinked**: the phone was offline more than 14 days, or WhatsApp logged out linked devices. Link it again with the rig's `README-whatsapp.md` (`./whatsapp-login.sh`, then on the phone **[captain]**: WhatsApp > Settings > Linked devices > Link a device > "Link with phone number instead", and the code it printed). Linking brings about a year of history back.
- **Gap**: what the bridge missed while unlinked comes from an iPhone backup (`whatsapp-db`, below).
- **Calls**: the bridge brings none (no length, no outcome, only a notice when a call rings on it), so WhatsApp's calls come from the Mac app within 15 minutes (`npm run whatsapp-mac-calls`, run every 15 minutes by the launchd agent `local.whatsapp-calls-import`, installed with `npm run whatsapp-mac-calls -- install`; archive.md's "The Mac app's calls, every 15 minutes") and from an iPhone backup (`whatsapp-db`, below). Check its log, `/tmp/whatsapp-calls-import.log`: each run says it found nothing new, or what it copied and what it added.

### `llm-sessions`

The captain's conversations with firstmate, for the event index, live: Claude Code's session files (`~/.claude/projects`), each copied into the archive's folder (`data/llm/claude-code/`) and read there, since Claude Code deletes a session file 30 days after it last changed.
The archive's server reads a session within seconds of it changing, and every session again when it starts and each hour (events.md, "The event index").
Only the projects in `data/connectors/llm-sessions.json`'s `projects` are read (else `llmSessions.projects` in the settings), and only sessions someone was at: headless runs are left out and counted.
It brings no messages and no people; their text stays in the copies and is read only through `event-content`.

- **Healthy**: `connectors` says `live: connected (watching 1 of 1 folder)`; `events` reaches today.
- **Not connected**: `error` with a reason, or the server's log (`/tmp/life-archive-server.log`, lines `[live] llm-sessions: ...`). `npm run archive -- import llm-sessions` reads every session again by hand, the same way, and is safe while the server runs: one waits for the other.

### `grok-bot`

The captain's conversations with his Grok Bot bots, for the event index, live: the desktop app's cache (`~/Library/Application Support/Grok Bot/sand-client-persistence/`), which keeps only each bot's last 200 entries, so every entry is copied into the archive's folder as it comes (`data/llm/grok-bot/<bot id>.jsonl`) and read there.
Switch it on once (`npm run archive -- enable grok-bot`), and the archive's server follows it within seconds of a change, as for `llm-sessions`.

- **Healthy**: `connectors` says `live: connected`; `events` has `grok-bot` sessions from today when he has talked to a bot.
- **Not read**: `live: error (... not read: a chat with ...)` means the app changed its cache's format: the archive keeps that chat's entries but reads none of it until its reader learns the change (`server/connectors/grok-bot/entries.ts`); nothing is guessed. The tallies of `npm run archive -- import grok-bot` say the same.

### Rituals

No connector: rituals is a module (`modules/rituals/`; features.md, "Rituals"), reading its own store in the archive's folder (`modules/rituals/data/ritual.sqlite3`, which `bin/ritualctl` writes) and pushing its habits and days into the calendar itself, a watch looking at the store every 20 seconds while the server runs. Nothing to import by hand; `data/connectors/rituals.json` is no longer read.

- **Healthy**: Events' Daily rituals and Fitness's Habits show today; the Events week's Rituals row says the day; `npm run rituals -- status` says where the store is and what it holds; the server's log says `[rituals] the calendar's rituals rows: …` after a write; `npm run archive -- calendar check` finds nothing to change (but the open day's summary, which moves with the clock, when it is run minutes after the last push).
- **Not set up**: the page says rituals is not set up, and `status` says where ritualctl would make the store: its `config/root` (or `RITUAL_ROOT`) must name `modules/rituals/` of the archive's folder. **Cannot be read**: the page says rituals answered with an error, in rituals' own words, and the log says so once; the calendar's rows are left as they were.

### `polar`

The captain's workouts from Polar Flow (runs recorded through the Flow app), for the exercise module's index, live: the archive's server asks Polar's AccessLink API when it starts and every 3 hours, keeps each new exercise as Polar gave it (`data/platform-exports/polar/accesslink/<id>.json` and `.fit`) and writes one `workout` event of each (events.md, "Workouts from Polar").
AccessLink gives only what was uploaded to Flow in the last 30 days, after the login, so the Mac being off for a few weeks loses nothing; anything older comes from `polar-export` (below).

- **Once, to connect** **[captain]**: at https://admin.polaraccesslink.com, signed in with his Polar Flow account, create a client (any name, "Life archive, personal"; accept the API agreement) with the redirect URL `http://localhost:4655/polar/callback`; then `npm run exercise -- polar login`, typing the client's ID and secret when asked (kept in the Keychain), and signing in and accepting on Polar's page in the browser. Then add `"trustedHeartRate": [{"device": "Polar Flow app", "sensor": "Polar H10"}]` to `data/connectors/polar.json` when the Flow app's heart rate is a chest strap's (name the strap the owner uses).
- **Healthy**: `connectors` says `live: connected (last fetch <day> <time>, N workouts kept)`; `npm run exercise -- status` counts a workout copy from Polar for each run uploaded, and Events > Workouts lists it (the exercise module's; nothing of it is in `events`).
- **Reconnect needed**: `live: logged-out (reconnect needed: Polar refused the archive's token (401); ...)`: run `npm run exercise -- polar login` again **[captain]**; the server takes the new token within a minute, without a restart. `logged-out (not connected yet ...)` means the login never ran.
- **Consents**: an `error` naming a 403 means his Polar account has mandatory consents to accept at https://account.polar.com **[captain]**.
- `npm run archive -- import polar` runs the same pass by hand.

## From this Mac

`call-history` and `imessage-db` read a copy of a database the Mac keeps up to date by itself through iCloud, taken with SQLite's `.backup` so the copy is consistent while the app writes it, and name people from a copy of the Mac's Contacts taken the same way.
No computer use is needed.

### This Mac's sync

Both are synced every 15 minutes by `npm run mac-imports`, the launchd agent `local.life-archive-mac-imports`, their only schedule: a run whose databases have nothing new does nothing; one that has copies, backs up and imports exactly as the three sections below say (the address book first), then runs `check-data`. firstmate hears what came in the next day, and a failure or `check-data`'s problems at once (data.md, "This Mac's calls and Messages, every 15 minutes").
A session needs nothing here: `import-status` shows both covering to the last call or message.

**[captain], once.** Reading the three databases needs Full Disk Access, given to the job's own launcher alone (not to node, nor the terminal): System Settings > Privacy & Security > Full Disk Access; click +, press Cmd-Shift-G, paste `~/Library/Application Support/LifeArchive/life-archive-mac-imports`, choose Open, and check its switch is on.
It runs within 15 minutes (`launchctl kickstart gui/$(id -u)/local.life-archive-mac-imports` runs it now).
Until then each run reads nothing and tells firstmate what to grant; after an `npm run mac-imports -- install` that says it built the launcher anew, the grant is given again.

**When it goes wrong.** A failed import leaves its copy in `data/platform-exports/calls/<day>/` or `imessage/<day>/`, and the job tries again an hour later: run that import by hand from its backup step below when it keeps failing. The log is `~/Library/Logs/LifeArchive/mac-imports.log`.

**By hand** (when the job has stopped), the terminal needs Full Disk Access too (the same pane) **[captain, once]**; each section below has the steps.

### The address book

The Mac's Contacts name people for `call-history`, `imessage-db` and `whatsapp-db` (`--contacts`), and fill their notes from their cards (`contact-notes`).
They replace the iPhone backup's `AddressBook.sqlitedb`: iCloud keeps them in step with the phone, so a card added on the phone names its person at the next import, with no backup.
They live in `~/Library/Application Support/AddressBook/`: the Mac's own cards in `AddressBook-v22.abcddb`, and each account's (iCloud's and any other) in `Sources/<id>/AddressBook-v22.abcddb`.
The sync copies them into `data/platform-exports/addressbook/<day>/` once a day, at the same paths (the cards' photos are left); by hand:

```sh
day=$(date +%F); book="$HOME/Library/Application Support/AddressBook"; dest=~/life-archive-data/platform-exports/addressbook/$day
for store in AddressBook-v22.abcddb $(cd "$book" && ls Sources/*/AddressBook-v22.abcddb); do
  mkdir -p "$dest/$(dirname $store)" && sqlite3 -readonly "$book/$store" ".backup '$dest/$store'"
done
```

`--contacts` and `contact-notes` take that folder, or an iPhone's `AddressBook.sqlitedb` (the older copies there are the iPhone's).
When several cards have a number, the one changed last names it, so an old card in an account no longer used does not win over the one on the phone.

### `call-history`

The phone's calls (phone and FaceTime), from `~/Library/Application Support/CallHistoryDB/CallHistory.storedata`, which iCloud syncs from the iPhone.
It holds about a year of phone calls, so it must be copied at least every few months (the sync copies it whenever a call comes in); the archive keeps every call ever imported.
Calls through other apps are not in it.

```sh
day=$(date +%F)
mkdir -p ~/life-archive-data/platform-exports/calls/$day
sqlite3 -readonly "$HOME/Library/Application Support/CallHistoryDB/CallHistory.storedata" ".backup '$HOME/life-archive-data/platform-exports/calls/$day/CallHistory.storedata'"
npm run archive -- backup before-import-calls
contacts=$(ls -d ~/life-archive-data/platform-exports/addressbook/*/ | tail -1)    # the newest address book (above)
npm run archive -- import call-history ~/life-archive-data/platform-exports/calls/$day/ --contacts $contacts
```

Check: the import's count of calls added; `import-status` covers to today or the last call.

### `imessage-db`

iMessage, SMS and RCS, from the Messages app's own database on this Mac, `~/Library/Messages/chat.db`, which holds the whole history when Messages in iCloud is on.
It keeps the same ids as the iPhone's copy, so it continues an import from a backup.
Copy the database whole, and only the attachments that came since the day `import-status` names (a day or two earlier is harmless); those already imported keep pointing at their older copies.

```sh
day=$(date +%F); since=2026-09-27          # since: a day before import-status's "covers to"
dest=~/life-archive-data/platform-exports/imessage/$day
mkdir -p $dest
sqlite3 -readonly ~/Library/Messages/chat.db ".backup '$dest/chat.db'"
(cd ~/Library/Messages && find Attachments -type f -newermt "$since" -print0 | tar --null -cf - -T -) | tar -xpf - -C $dest
npm run archive -- backup before-import-imessage
contacts=$(ls -d ~/life-archive-data/platform-exports/addressbook/*/ | tail -1)    # the newest address book (above)
npm run archive -- import imessage-db $dest/ --contacts $contacts
```

Names come from the address book (`--contacts`); someone added to the contacts since that copy shows by their number until the next copy (a week at most once the job runs).
Check: the import's message count by service, and `import-status` covers to today.

## From an iPhone backup

An unencrypted local backup holds the iPhone apps' own databases.
It is the only source for WeChat (the Mac app's databases are encrypted), and the most complete one for WhatsApp, and the only one for WhatsApp's calls.
Its address book is no longer needed: the Mac's Contacts are newer ("The address book", above).
It does not hold Instagram, Telegram, Signal, Discord or Messenger messages, or the phone's own call history (iOS leaves it out of an unencrypted backup; WhatsApp's Calls tab is in WhatsApp's files).

### Taking the backup

Finder keeps one backup of the phone, in `~/Library/Application Support/MobileSync/Backup/<device id>/`, and each backup after the first brings it up to date in place, sending only what changed.
The phone backs up over the Wi-Fi once it has been set up by cable; the captain's only part each time is the phone's passcode.
The importer reads only an unencrypted backup, so "Encrypt local backup" stays off (an unencrypted backup leaves out saved passwords, Wi-Fi settings, website history, Health data and call history, none of which the archive reads).
Finder's labels below are Apple's ([back up with Finder](https://support.apple.com/guide/mac-help/update-back-up-and-restore-your-device-mchla3c8ed03/mac), [Wi-Fi](https://support.apple.com/guide/mac-help/sync-content-between-your-mac-and-iphone-or-ipad-over-wi-fi-mchlada1d602/mac), [Back Up Now](https://support.apple.com/en-us/108796), [encryption](https://support.apple.com/en-us/108353), [where backups are](https://support.apple.com/en-us/108809), [the alert at each backup](https://support.apple.com/en-us/109054); checked 2026-10-21 on macOS 26).

**Once, by cable [captain].** The first backup is the whole phone (about 300 GB, about two hours), so the disk it goes to needs that much free: check first, and if this Mac has not got it, set up "Keeping the backup on another disk" (below) before step 5.

1. Plug the phone into this Mac with a USB-C cable (a USB-C 3 one: USB 2 caps it at about 35 MB/s) and unlock it. If it asks, tap **Trust** and enter its passcode.
2. Open a Finder window and click the phone in the sidebar, under Locations.
3. Click **General** in the row near the top.
4. Under Backups:
   - choose **Back up all of the data on your iPhone to this Mac**;
   - leave **Encrypt local backup** unticked;
   - under Options, tick **Show this iPhone when on Wi-Fi**.
5. Click **Apply**, then **Back Up Now**. The phone asks for its passcode: enter it.
6. Leave both alone until it finishes: when it is done, Backups shows the date and time of the last backup to this Mac.

**Each time, over Wi-Fi [captain].**

1. The phone and this Mac on the same Wi-Fi, the phone unlocked (and, when the backup lives on another disk, that disk plugged in).
2. In Finder, click the phone in the sidebar (it shows there while on the Wi-Fi), then **General**.
3. Click **Back Up Now**. The phone asks for its passcode: enter it. That is all.
4. It is done when Backups shows today's date and time as the last backup. Later backups send only what changed since the last, so they take far less than the first.

If the phone is not in the sidebar, plug it in by cable once and check **Show this iPhone when on Wi-Fi** is still ticked.
When Finder says the backup failed or was cancelled, click **Back Up Now** again.

**Then [terminal].** `npm run extract-wechat` with no folder reads the backup Finder took last (the newest of the folders in `~/Library/Application Support/MobileSync/Backup/` holding a `Manifest.db`) and refuses one that has not finished; the terminal needs Full Disk Access to read it.
The archive keeps what each import brought, and `platform-exports/wechat/<day>/` keeps each backup's WeChat files, so the backup being brought up to date in place loses nothing.

### Keeping the backup on another disk

Finder writes backups only to `~/Library/Application Support/MobileSync/Backup/`; where they go is not a setting.
To keep it on another disk, that folder becomes a link to a folder there. Not yet tried on this Mac; the disk is the captain's choice.

1. **[captain]** In Disk Utility, give the external disk an APFS volume of its own (select the disk's APFS container, then **Add Volume**, APFS; on the Time Machine disk this is a second volume beside the backup one, sharing its free space).
   Name it, say, `iPhone Backup`.
2. **[terminal]** with Finder showing no backup under way, and the terminal given Full Disk Access:

   ```sh
   cd ~/Library/Application\ Support/MobileSync
   mkdir -p "/Volumes/iPhone Backup/Backup"
   mv Backup/* "/Volumes/iPhone Backup/Backup/" 2>/dev/null    # a backup already here moves with it
   rmdir Backup && ln -s "/Volumes/iPhone Backup/Backup" Backup
   ls -l ~/Library/Application\ Support/MobileSync    # Backup -> /Volumes/iPhone Backup/Backup
   ```

3. Take the first backup as above.

While the disk is not plugged in, the link leads nowhere: Finder's backup fails, and `extract-wechat` says the disk is not connected.

**Time Machine.** Kept on this Mac, the backup is in the home folder, so Time Machine copies it too (about 300 GB more on its disk, and the changed files after each backup).
Behind the link it does not: Time Machine keeps the link, not the volume it leads to, and by default leaves an external disk's volumes out.
To keep it on this Mac but out of Time Machine: System Settings > General > Time Machine > Options, then **+** and choose `~/Library/Application Support/MobileSync/Backup` ([excluding files](https://support.apple.com/guide/mac-help/exclude-files-from-a-time-machine-backup-mh15622/mac)).

### Taking files out of a backup

A backup keeps each file under the SHA-1 of its name, and lists them in `Manifest.db`.
This shell function copies the files whose path matches into a folder, at their own paths:

```sh
backup="$(ls -td ~/Library/Application\ Support/MobileSync/Backup/*/ | head -1)"      # Finder's backup (the folder holding Manifest.db)
take() {  # take <domain> <relativePath, % for any> <into folder>
  sqlite3 -readonly -separator $'\t' "$backup/Manifest.db" \
    "SELECT fileID, relativePath FROM Files WHERE flags = 1 AND domain = '$1' AND relativePath LIKE '$2'" |
  while IFS=$'\t' read -r id file; do
    mkdir -p "$3/$(dirname "$file")" && cp -p "$backup/${id:0:2}/$id" "$3/$file"
  done
}
```

The iPhone's own address book is in it too (`take HomeDomain 'Library/AddressBook/AddressBook.sqlitedb%' <folder>`), but the Mac's Contacts are newer and name people instead ("The address book", above).

### `wechat-ios`

WeChat, from the iPhone app's own databases, which `extract-wechat` takes out of the backup (on this Mac, or `host:folder` over ssh) into `data/platform-exports/wechat/<the backup's date>/`:

```sh
npm run extract-wechat    # Finder's backup; or name a backup folder, here or host:folder
npm run archive -- backup before-import-wechat
npm run archive -- import wechat-ios ~/life-archive-data/platform-exports/wechat/<the backup's date>/
```

Check: the import's counts, including the messages it kept without their content or skipped because WeChat compressed them (archive.md, "WeChat": the `dictionary` setting reads them); `import-status` covers to the backup's day.
No computer use: the backup and the commands are the terminal's, the passcode the captain's.

### `whatsapp-db`

WhatsApp's own databases, for history the live bridge does not have: a gap while it was unlinked, messages from before it was linked, and every call (the bridge passes on none).
`import-status` says "nothing" for it while `matrix-whatsapp` is connected, but a backup's calls come only this way: import each new backup's.
The iPhone's copy is the whole history; the Mac app's folder (`~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/`) holds only what it synced since it was linked, which can do for a short gap (macOS asks the captain before letting the terminal read it **[captain]**). Its calls come in by themselves each morning (`npm run whatsapp-mac-calls`); never import its folder for calls without that script's settings, since its Calls tab names the wrong people on about half its calls. To see first what an import would add, give it `--dry-run`: the archive is only read.

With `take` from above:

```sh
day=<the day the backup was taken>; w=AppDomainGroup-group.net.whatsapp.WhatsApp.shared
take $w 'ChatStorage.sqlite%' ~/life-archive-data/platform-exports/whatsapp/$day
take $w 'CallHistory.sqlite%' ~/life-archive-data/platform-exports/whatsapp/$day    # the Calls tab: calls no chat records, and their lengths
take $w 'LID.sqlite%' ~/life-archive-data/platform-exports/whatsapp/$day
take $w 'Message/Media/%' ~/life-archive-data/platform-exports/whatsapp/$day
npm run archive -- backup before-import-whatsapp
npm run archive -- import whatsapp-db ~/life-archive-data/platform-exports/whatsapp/$day/ --contacts $(ls -d ~/life-archive-data/platform-exports/addressbook/*/ | tail -1)
```

Messages already in the archive from the live bridge are the same rows (both use WhatsApp's own ids), so only the gap is added.
Calls are keyed by WhatsApp's call id, so a call in an older backup too is counted once.
Check: the import's tallies count the calls only the Calls tab has, the three-way calls outside a group chat (each a call in no chat, with anyone on it the copy has no chat with counted unnamed), and those left out (one with no one on it, or no one the copy has a chat with); its Calls line counts the three-way calls new, changed and already had.
The same function takes the iPhone's Messages database, should the Mac's ever lack something: `take HomeDomain 'Library/SMS/sms.db%' <folder>` and `take MediaDomain 'Library/SMS/Attachments/%' <folder>`, then `import imessage-db <folder>`.

## From the platform

Each platform makes its own export when asked and says when it is ready; the request is a few screens, then a wait.
Download it into `~/Downloads`, then file it as in "Every import, the same way".

### `polar-export`

Polar's account data export: every training session the captain's Polar account holds, the history the live `polar` connector cannot reach (it sees only the last 30 days, after its login).

- **Where** **[captain]**: https://account.polar.com > Download your data > Download.
- **Wait**: Polar emails when it is ready; the link lasts two weeks.
- **Arrives as**: one zip, `polar-user-data-export_<id>.zip`. File it in `data/platform-exports/polar/<date>/` and `exports unpack` it there: a `training-session_<start>_<id>.json` for each session, beside small account, device, calendar and target files, which are not read.
- **Import**: `npm run archive -- enable polar-export` once, then `npm run archive -- import polar-export ~/life-archive-data/platform-exports/polar/<date>/`. A run the API also brought becomes a second copy of it, which the Health tab joins to the first; an export imported again changes nothing.
- **Check**: the import's counts (`workout` added); `npm run exercise -- status` (the copies by source, in the module's own database); the Fitness page's activities, each saying where it came from. A tally `polar-sessions-not-read` names how many files it could not read (a format it does not know), which are left, never guessed at.

### `facebook-dyi`

Messenger as Facebook keeps it: every chat that is not end-to-end encrypted (and the history of those that became so), archived, filtered and message-request chats, groups and pages.
With `messenger-export` it makes the whole of Messenger.

- **Through the Cua Space**: each week, by itself ("Computer-use help", above); what follows is for doing it by hand.
- **Where**: Accounts Center (accountscenter.facebook.com, or Facebook > Settings & privacy > Settings > Accounts Center) > Your information and permissions > Export your information (or Download your information) > Create export (or Download or transfer information) > the Facebook profile > Export to device. Meta now chooses what goes in on the last screen, Confirm your export: Customize information, Clear all in every section, then **Messages** only.
- **Options**: date range **custom, from the day `import-status` gives** (all time for a first import); format **JSON**; media quality **higher**; then Start export (or Create files).
- **Wait**: minutes to a couple of days (a first, whole-history one, tens of GB, takes the longest); Facebook notifies and emails, and the files are on the same page under available downloads for about four days.
- **Arrives as**: one zip or several parts, `facebook-<username>-<date>-<n>.zip`. Put every part in one folder, `data/platform-exports/messenger/<date>/`, and `exports unpack` it (it unpacks a zip stored inside a part too).
- **Import**: `npm run archive -- import facebook-dyi ~/life-archive-data/platform-exports/messenger/<date>/` (progress shows as it goes; a big one takes a couple of minutes).
- **Check**: Messenger's count in `coverage` goes up; `import-status` covers to the export's newest message.

Computer-use steps (browser):

1. Open accountscenter.facebook.com/info_and_permissions/dyi/. **[captain]** if it asks to sign in or for a code.
2. Create export (or Download or transfer information); choose the Facebook profile; Export to device.
3. On Confirm your export: Customize information, Clear all in every section, tick only Messages, save. Date range: Custom, then its Edit: type the day given into Start date as the box writes it (`Oct 9, 2026`), with nothing after it, and pick today in End date's calendar; Save, then the Date range panel's Save, after which the page's Date range names the range (checked by hand in the Cua Space's export browser on 2026-10-23). Format: JSON. Media quality: Higher quality. Read the page back before going on.
4. Start export. If it asks for the password again (it did each time in October 2026): in the Cua Space's rounds, the Keyvault fills it ("The Cua Space's schedule", above); by hand, **[captain]**.
5. Report the request and the time. When the email or notification says it is ready, return to the same page and download every part into `~/Downloads`. The password asked for again there is filled the same way.

### `messenger-export`

Messenger's end-to-end-encrypted chats, which Facebook's download does not hold, from Messenger's secure storage: the whole of it each time (it takes no dates), deduplicated on import.

- **Through the Cua Space**: each 30 days, by itself ("Computer-use help", above), from messenger.com in the Space's export browser; what follows is for doing it by hand. Each download is the whole history (easily a GB zipped, as much again unpacked), so monthly rather than weekly; Facebook's weekly export has every chat that is not encrypted.
- **Where**: messenger.com in a desktop browser (Chrome: one guide found Safari's download failed) > Settings, help and more (the profile picture, bottom left) > Privacy & safety > End-to-end encrypted chats > Message storage (a button) > Download message storage data (also labelled Download secure storage data); Preferences is not it. The phone app can do the same where its version has it (Settings > Privacy & safety > End-to-end encrypted chats > Message storage > Download your message storage data); the captain's phone does not.
- **Asks** **[captain]**: a sign-in to messenger.com, and on a browser new to the secure storage, its PIN (or a code Meta sends) to restore it, once for that browser.
- **Wait**: minutes, with the page open; then one zip, `messages.zip` (hundreds of MB), into `~/Downloads`.
- **Import**: into `data/platform-exports/messenger/<date>/` (a `-2` folder if Facebook's download has that day), `exports unpack`, then `npm run archive -- import messenger-export ~/life-archive-data/platform-exports/messenger/<date>/`. Once, before the first such import since 2026-10-15 into an archive that has older ones: `npm run archive -- repair messenger-phone-chats` (the dry run), then with `--apply` (archive.md's "Messenger's phone export"); the import is refused until it has run (it would bring every group and "Facebook user" chat in again, and photos sent together in any chat). The repair reads unsent messages' texts from the exports there, so keep them in place until it has run.
- **Check**: the import's counts (`--dry-run` first: an export already imported adds nothing); `import-status` covers to the export's newest message.

Computer-use steps (browser), as the Cua Space's playbook has them. Written from Meta's labels as guides gave them in 2026, and the path to the download checked by hand in the Space's export browser on 2026-10-22 (the download itself not yet pressed):

1. Open www.messenger.com. **[captain]** if it asks to sign in (also "Continue as"; never pressed by the worker).
2. Settings, help and more > Privacy & safety > End-to-end encrypted chats > Message storage, looking only inside the settings dialog, never at the chat list behind it.
3. Download message storage data. **[captain]** for the PIN or a code. The password, when asked for again, as for `facebook-dyi`, once the Keyvault holds a messenger.com login.
4. Keep the page open until `messages.zip` has finished downloading into `~/Downloads`.

### `instagram-dyi`

Instagram's direct messages (the inbox and message requests), from its download in Accounts Center, the same format as Facebook's.

- **Through the Cua Space**: each week, by itself ("Computer-use help", above); what follows is for doing it by hand.
- **Where**: Accounts Center (accountscenter.instagram.com, or Instagram > Settings > Accounts Center) > Your information and permissions > Export your information (Download your information) > Create export (Download or transfer information) > the Instagram profile > Export to device > Confirm your export: Customize information, **Messages** only.
- **Options**: date range **custom, from the day `import-status` gives** (it may default to the last year: pick All time for a first import); format **JSON**; media quality medium or higher.
- **Wait**: Meta allows itself up to 30 days; it is usually minutes to hours. Notified and emailed; downloadable on the same page for about four days.
- **Arrives as**: one zip (`instagram-<username>-<date>-<id>.zip`) into `data/platform-exports/instagram/<date>/`; `exports unpack` it.
- **Import**: `npm run archive -- import instagram-dyi ~/life-archive-data/platform-exports/instagram/<date>/`.
- **Check**: the import's counts; `import-status` covers to the export's newest message.

Computer-use steps (browser): as for `facebook-dyi`, at accountscenter.instagram.com/info_and_permissions/dyi/, choosing the Instagram profile, Messages only, the custom range from the day given, JSON. **[captain]** for a sign-in or a code; the password asked for again at Start export (October 2026) as for `facebook-dyi`, once the Keyvault holds an Instagram login.

### `x-archive`

X's direct messages, one-to-one and group, from "Download an archive of your data": the whole archive each time (it takes no dates), deduplicated on import.
X's newer encrypted chats (XChat) are not readable from it; the import counts them.

- **Where**: x.com > More > Settings and privacy > Your account > Download an archive of your data (x.com/settings/download_your_data).
- **Asks**: the password, then a code sent by email or SMS **[captain]**; then Request archive.
- **Wait**: a day or more ("may take a few days"); X notifies and emails, and the Download archive button appears on the same page.
- **Arrives as**: `twitter-<date>-<hash>.zip` (tens of MB) into `data/platform-exports/x/<date>/`. It can be imported as it is; `exports unpack` it when it holds DM media.
- **Import**: `npm run archive -- import x-archive ~/life-archive-data/platform-exports/x/<date>/`.
- **Check**: the import's counts; `import-status` covers to the archive's newest message.

Computer-use steps (browser):

1. Open x.com/settings/download_your_data. **[captain]** if it asks to sign in.
2. Enter the password and the code it sends **[captain]**.
3. Request archive. Report the time.
4. When X says it is ready, return to the page and Download archive into `~/Downloads`.

### `signal-export`

Signal's chats, one-to-one and group, from Signal Desktop's own export (Signal's backup format, as JSON lines): everything Signal Desktop holds, each time.
Signal Desktop must be linked and hold the history: linked once with "Transfer message history", it keeps receiving while it is opened now and then.
Disappearing messages are not in it.

- **On the captain's Mac, by hand**: the Cua Space cannot do it. Signal Desktop's export first asks macOS for the user's presence (Touch ID, else the login password) through the Mac's Secure Enclave, and a virtual Mac has none: in the Space the check fails at once (CryptoTokenKit error -7), with no dialog, and Signal cancels the export. `npm run cua-exports` reminds him through firstmate once the archive's Signal reaches back a week, and each week after.
- **Where**: Signal Desktop > Settings > Chats > Export chat history; include attachments if it offers to.
- **Asks**: the Mac's login password **[captain]**, and a folder to save into.
- **Wait**: a minute or so; it writes `signal-export-<date>-<time>/` (`metadata.json`, `main.jsonl`, and `files/` with attachments).
- **Import**: move that folder into `data/platform-exports/signal/<date>/`, then `npm run archive -- import signal-export ~/life-archive-data/platform-exports/signal/<date>/`.
- **Check**: the import's counts; `import-status` covers to the export's newest message.
- **Unlinked, or missing history**: relink Signal Desktop with Transfer message history (Signal on the phone > Settings > Linked devices, scan the code Desktop shows) **[captain]**; the transfer brings all chats but only the last 45 days of media. Signal's rules (its "Linked Devices" help, September 2026): the phone must come online at least every 30 days, a linked device unlinks after 45 days unused, at most 5 linked devices, and a device linked without the transfer gets the history only by reinstalling and linking again.

Computer-use steps (Mac app, so the ChatGPT desktop app's Computer Use plugin, or the captain): open Signal Desktop; Settings > Chats > Export chat history; **[captain]** the Mac password; save to `~/Downloads`; report the folder's name.

### `discord-package`

The captain's own Discord messages (DMs, group DMs and server channels; never anyone else's), from Discord's data package: the whole of it each time, deduplicated on import.

- **Through the Cua Space**: each 30 days, by itself ("Computer-use help", above), but for the emailed link, which the captain opens in the Space's Chrome **[captain]**; what follows is for doing it by hand.
- **Where**: Discord (the app, or discord.com/app in a browser) > User Settings > Data & Privacy > Request Data (Request all of my data) > choose **Messages** only > Submit. On the phone only everything can be requested.
- **Wait**: Discord allows itself up to 30 days; a few days is usual. It emails a link, valid for about 30 days. One request each 30 days: until then the page says when ("You can request again on ...") and Request Data is disabled.
- **Arrives as**: `package.zip` (small) into `data/platform-exports/discord/<date>/`; it can be imported as it is.
- **Import**: `npm run archive -- import discord-package ~/life-archive-data/platform-exports/discord/<date>/`.
- **Check**: the import's counts; `import-status` covers to the package's newest message.

Computer-use steps (browser):

1. Open discord.com/app. **[captain]** if it asks to sign in or for a code.
2. User Settings (the gear) > Data & Privacy > Request Data; tick only Messages; Submit.
3. Report the time and what Discord says about the wait.
4. When Discord's email comes, the captain opens its download link in that profile, or gives the worker the link **[captain]**; the worker saves `package.zip` into `~/Downloads`.
