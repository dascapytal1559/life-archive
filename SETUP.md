# Setting up your own life archive

This is for a person setting up a life archive of their own from scratch, and for the coding agent doing it for them
(Claude Code, Codex and the like): read it top to bottom, do each step, and stop to ask the person wherever it says so.
It works on macOS and Linux; where a step differs, both are given. Windows is not supported yet.

If you are an agent: read [AGENTS.md](AGENTS.md) first. Its rules apply from the moment the archive holds anyone's
data, and they decide how you may read it.

## 1. What you need

| | macOS | Linux |
| --- | --- | --- |
| Node | 24.22.1 exactly (`.node-version`; `package.json`'s `devEngines` pins the same). Any version manager that reads `.node-version` (nvm, fnm, mise), or the Vite+ shims (`export PATH="$HOME/.vite-plus/bin:$PATH"`). Every command stops on another version and says so. | the same |
| git | yes | yes |
| Reading health PDFs | `swift` (`xcode-select --install`), only for the health module's imports | `pdftotext` (`poppler-utils`), only for the health module's imports |
| Backups to a NAS | `restic` (`brew install restic`), only for `npm run nas-backup` | not yet (below) |

Nothing else: the databases are Node's own SQLite, and the page is served by the server itself.

## 2. Get the code and try it on made-up data

```sh
git clone <this repository> life-archive
cd life-archive
npm ci
npm test                 # every test, on made-up data; a few minutes
npm run typecheck
npm run testing-data -- /tmp/life-archive-testing --crowd
LIFE_ARCHIVE_DATA=/tmp/life-archive-testing LIFE_ARCHIVE_URL=http://127.0.0.1:4651 npm start
```

Open <http://127.0.0.1:4651/life-archive/> and look around with the person: Events, Friend Map, Fitness, Health
Record, Inspirations. This is how every part looks with data in it, so they can choose what they want. Stop the server
(Ctrl-C) when done; the testing folder can be deleted.

Then read, in this order: [README.md](README.md), [docs/running.md](docs/running.md),
[docs/settings.md](docs/settings.md), [docs/people.md](docs/people.md) and
[docs/import-runbook.md](docs/import-runbook.md).

## 3. Make the archive's folder

The archive lives in one folder, outside the code: `~/life-archive-data` unless `LIFE_ARCHIVE_DATA` names another
(in the environment, or in `.env.local` in the repository). Make it, and the server makes the databases in it on its
first start:

```sh
mkdir ~/life-archive-data
```

It is private. It never goes into git (it is outside the repository, and `/data` is ignored too), and it should be on
a disk that is backed up.

## 4. Settings

Two files, neither kept by git; [docs/settings.md](docs/settings.md) has every key.

**`settings.json`** in the archive's folder. Ask the person for their time zone, their locale and their country's
calling code, then write at least:

```json
{
  "timeZone": "Europe/Berlin",
  "locale": "de-DE",
  "phoneCountry": "49"
}
```

The time zone matters most: the archive reckons its days in it and keeps the zone of its first start, refusing any
other later, so set it before the first `npm start`. Name the locale too: under launchd a Mac's locale can be `en-US`
whatever its region says.

**`.env.local`** in the repository, for addresses and paths on this machine: copy what is needed from `.env.example`,
which lists every key with its default. Most people need none of it at first. `LIFE_ARCHIVE_MODEL` names the model the
AI service uses (writing queries, tagging inspirations); without it those features say so and the rest works.

## 5. Choose the modules

A new archive offers the pages that are ready: Events, the home page, always there, and one module to choose.

| Module | Worth it when | Needs |
| --- | --- | --- |
| `friend-map` | they want their chats, calls and people | exports from their apps (below) |

It is on unless `settings.json` switches it off (`{ "modules": { "friend-map": false } }`).

The repository has other pages too (the modules `exercise`, `health`, `inspirations`, `journal`, `rituals` and
`shopping`), but they are unfinished: off and out of the menu. Do not offer them. Someone who asks for one by
name can switch it on (`{ "modules": { "rituals": true } }`), or every page
with `{ "pages": "all" }`; its README says what it needs ([docs/modules.md](docs/modules.md)'s "Ready pages").

**A private module of their own** goes in `modules/<id>/`: git ignores any folder there that the repository does not
name, so it is never committed by accident, and it is on as soon as it is there. [docs/modules.md](docs/modules.md)
says how a module is built.

## 6. Start it

```sh
npm start
```

It says which modules are on and where it answers: <http://127.0.0.1:4650/life-archive/>. It listens on 127.0.0.1
alone. Run one server per archive: it is the only process that opens the archive, and a second cannot bind the port.

## 7. Bring the data in

Each chat platform has one or more connectors; [docs/platforms.md](docs/platforms.md) says what each brings, and
[docs/import-runbook.md](docs/import-runbook.md) how to run each, step by step. A connector is on when
`connectors/<id>.json` in the archive's folder says `{"enabled": true}`; a missing file means off.

| Way in | Connectors | macOS | Linux |
| --- | --- | --- | --- |
| An export the person requests from the platform | `facebook-dyi`, `messenger-export`, `instagram-dyi`, `x-archive`, `signal-export`, `discord-package`, `polar-export` | yes | yes |
| Coding agents' session files | `llm-sessions` (Claude Code's `~/.claude/projects`) | yes | yes |
| An iPhone backup made by the Mac's Finder | `whatsapp-db`, `wechat-ios`, the address book | yes | not yet: written for a Finder backup's place and layout |
| The Mac's own databases | `imessage-db`, `call-history`, WhatsApp for Mac's calls | yes, with Full Disk Access | no |
| Live, through a Matrix bridge the person runs | `matrix-bridge` (Telegram), `matrix-whatsapp` | advanced: the bridge rig is set up by hand | the same |

Start with one export, import it, and look at it together: `npm run archive -- import-status` says what each
connector has and what to do next. After every import, and after any change to people, run `npm run check-data` and
fix what it names.

People: everyone in the chats becomes a person, joined across platforms by the rules in
[docs/people.md](docs/people.md). Change people only through friend-map's page, the Events page's People and Tags tables, or `npm run archive -- person ...`
and the commands beside it, never by editing a database.

## 8. Keep it running

**macOS**: a per-user launchd agent. Save as `~/Library/LaunchAgents/local.life-archive.plist`, with the paths filled
in, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.life-archive.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>local.life-archive</string>
<key>ProgramArguments</key><array><string>/path/to/node-24.22.1</string><string>server/main.ts</string></array>
<key>WorkingDirectory</key><string>/path/to/life-archive</string>
<key>KeepAlive</key><true/>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>/tmp/life-archive-server.log</string>
<key>StandardErrorPath</key><string>/tmp/life-archive-server.log</string>
</dict></plist>
```

After changing code the server runs, `launchctl kickstart -k gui/$(id -u)/local.life-archive` restarts it.

**Linux**: a systemd user service. Save as `~/.config/systemd/user/life-archive.service`, then
`systemctl --user enable --now life-archive` (and `loginctl enable-linger $USER` to keep it running when logged out):

```ini
[Unit]
Description=The life archive's server

[Service]
WorkingDirectory=/path/to/life-archive
ExecStart=/path/to/node-24.22.1 server/main.ts
Restart=always

[Install]
WantedBy=default.target
```

`systemctl --user restart life-archive` restarts it.

**From a phone**, through Tailscale: `tailscale serve` in front of the port, and the machine's tailnet name in
`LIFE_ARCHIVE_ALLOWED_HOSTS` (`.env.local`); the server refuses any other host name.

## 9. Connect your agents

The archive is an MCP server too, at `/life-archive/mcp`, so an agent reads it, and logs to it where you let it, with
no path to the code. Give each agent a key of its own (printed once; keep it out of any file you commit):

```sh
npm run archive -- mcp key add claude-code                      # reads facts: names, times, counts, statuses
npm run archive -- mcp key add my-assistant --grant write:rituals --grant content:rituals
```

Then one line in the agent (the key below is made up):

```sh
claude mcp add --transport http life-archive http://127.0.0.1:4650/life-archive/mcp --header "Authorization: Bearer la_mcp_EXAMPLEexampleEXAMPLEexampleEXAMPLE00000"
grok mcp add --transport http life-archive http://127.0.0.1:4650/life-archive/mcp --header "Authorization: Bearer la_mcp_EXAMPLEexampleEXAMPLEexampleEXAMPLE00000"
codex mcp add life-archive --url http://127.0.0.1:4650/life-archive/mcp --bearer-token-env-var LIFE_ARCHIVE_MCP_KEY
```

Its first call is `start_here`, which says what your archive holds, which tools its key may call and the rules. From
another device use the tailnet address (`https://<machine>.<tailnet>.ts.net/life-archive/mcp`). [docs/agents.md](docs/agents.md)
has the grants, every tool, other agents (Grok Bot, plain `curl`) and how a module adds tools of its own.

## Scheduled jobs

Every job is optional and off until installed. On macOS each installs its own launchd agent; on Linux the install
refuses and says so, and the job's plain command can run from cron or a systemd timer instead, where the job itself
runs there.

| Job | Command | What it needs |
| --- | --- | --- |
| The Mac's calls and Messages, every 15 minutes | `npm run mac-imports -- install` (a run: `npm run mac-imports`) | macOS, Full Disk Access |
| WhatsApp for Mac's calls | `npm run whatsapp-mac-calls -- install` | macOS, WhatsApp for Mac |
| Voice journals, each morning | `npm run journal -- install` | macOS, OpenSuperWhisper |
| Grok Bot's voice calls, into the journal | `npm run journal -- grok-calls install` | macOS, Grok Bot |
| Exports through a Cua Space | `npm run cua-exports -- install` | a Cua computer-use Space; the author's own set-up |
| Encrypted backup to a NAS | `npm run nas-backup -- install` (a run: `npm run nas-backup`) | macOS (it keeps restic's password in the Keychain), restic, a NAS over ssh |

Without a NAS, back the archive's folder up with whatever backs up the rest of the disk. The archive's own backups,
kept inside it (taken before a schema changes, and by `npm run archive -- backup <name>` before a change by hand;
[docs/data.md](docs/data.md)'s "Backups"), are for undoing a change, not for losing the disk.

## Privacy, and the agent's own notes

The archive holds other people's words. [AGENTS.md](AGENTS.md) is the agents' rulebook: read content only when the
person asks, only through the commands that log each read (`npm run archive -- timeline`, `search`, `event-content`,
with `LIFE_ARCHIVE_READER` set to the agent's name and the person's words as `--why`), and never by opening a
database or an export. Ask the person which AI providers may read their data at all, and write their answer down
where their agents will see it:

- **`AGENTS.local.md`**, beside `AGENTS.md`: the person's own orders for their agents (their choices about providers,
  their machines, their habits). Git ignores it. `AGENTS.md` tells every agent to read it first, and it wins where the
  two differ.
- **`CLAUDE.local.md`**: Claude Code reads it by itself; make it a link to `AGENTS.local.md`
  (`ln -s AGENTS.local.md CLAUDE.local.md`) so both agents read the same orders.

## Linux: what works and what does not yet

Works: the server and both pages, the tests and the typecheck, the testing data, every importer fed by an export, the
coding-agent sessions, Polar's export, and the health module's PDFs (through `pdftotext`). Checked on 7 November
2026: `npm ci`, the typecheck, `npm run testing-data` and every test pass on Debian 12 with Node 24.22.1.

Not yet: the iPhone-backup importers (written for a Finder backup), the Mac's own databases (iMessage, call history,
WhatsApp for Mac: macOS only by nature), the voice journals (OpenSuperWhisper is a Mac app), Polar's live connection
and the NAS backup (both keep their secrets in the Keychain), a HEIC photo as
your own photo on friend map's page (turned into a JPEG by macOS's `sips`; a JPEG, PNG or WebP works anywhere), and launchd itself
(use the plain commands, above). The Sources tab reads launchd's agents, and shows each job as not installed on Linux.

## When something is wrong

- `npm run check-data`: names each person or account with a problem.
- `npm run archive -- import-status`: each connector, what it has, and what to do next.
- The server's own log, where `npm start` writes (the terminal, or the log file the service names).
