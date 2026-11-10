# Settings

Everything about one person's archive that is not code is in two files, neither of them kept by git:

- **`.env.local`** in the repository: addresses and paths on this machine. `.env.example` lists every key, with its default. The environment wins over it.
- **`settings.json`** in the archive's folder (`server/settings.ts` reads it, once): the values with a shape. It travels with the archive and its backups.

A copy with neither runs on the defaults below. A `settings.json` that is there and wrong stops every entry point with what is wrong, a key no setting has among it, because a misspelled key would otherwise quietly show a default. Change one and restart what runs; the page is told as it opens (`GET /life-archive/api/settings`).

`--data <dir>`, and `check-data`'s argument, make that folder the archive's folder for the run and the processes it starts, so its `settings.json` is the one read.

**Local** in this project's words means the archive's time zone.

## settings.json

| Key | What | Default |
|---|---|---|
| `timeZone` | The IANA zone the archive's days are reckoned in. An archive keeps the zone of its first open in its `meta` table and refuses any other, since its stored days were reckoned in it. | the machine's |
| `locale` | The BCP 47 locale numbers and dates are written in. Under launchd a Mac's locale can be `en-US` whatever its region says, so name yours. | the machine's |
| `phoneCountry` | The country calling code a local number (0 and nine digits) is read in, such as `"61"`. | none: left as written |
| `owner.name` | The owner's name, as the agents' `start_here` names the archive ("Riley's life archive"; docs/agents.md). The default names nobody, and `start_here` then names no one. | `"Me"` |
| `nasBackup.hosts` | The ssh hosts (`~/.ssh/config`) the NAS is tried at, in order. | `["nas"]` |
| `nasBackup.repository` | The restic repository on the NAS, from its user's home. | none: no NAS backup |
| `nasBackup.folders` | Folders backed up beside the archive's: `{"folder", "exclude", "database"}`, each folder's `~/` the home folder, `exclude` restic's patterns from it, `database` a SQLite file in it sent as a checked copy. | none |
| `vault.folder` | The captain's Obsidian vault's folder in the archive's folder (the journal module's; features.md's "Journal"), which the voice journals' transcription writes into and the NAS leaves out. | `"Vault"` |
| `llmSessions.projects` | The projects the llm-sessions connector reads when `connectors/llm-sessions.json` names none. | none |
| `cua.agent` | The Cua agent, and its browser profile, the export rounds run as. | `"friend-map-exports"` |
| `maps.regions` | The regions `npm run map -- download <region>` knows, by id: `{"name", "bbox"}`, the box `[west, south, east, north]`. | none |
| `pages` | Which pages are on when not switched by name (docs/modules.md's "Ready pages"): `"ready"`, only those ready for anyone (Events and Friend Map, and any private module of the owner's), or `"all"`, every page, the unfinished ones too. A page switched by name below (`modules`) follows its switch either way. An archive made before the ready pages is given `"all"` when it upgrades, so nothing it had is switched off (docs/modules.md). | `"ready"` |
| `modules` | Each module's switch, by id (docs/modules.md): `{"health": true}` switches an unfinished one on, `{"health": false}` one off, listed but not loaded, its page gone from the rail. A module not named follows `pages` and its ready mark (its `package.json`'s `lifeArchiveReady`; a private module has none, and is on). One named that this checkout does not have is said so on stderr by the server and any `npm run archive` command that opens the archive (the callers that pass the switches, as the documents, the testing data and the guard load every installed module without them), and switches nothing: `settings.json` is every checkout's, so it may switch a private module that another checkout has (a git worktree has none of the private modules), and a misspelt id is never passed over without a word. Every page but Events (the home, which has no switch) is a module's, so this is every switch: the core pages that became modules were switched in `aspects` before, which is no setting any more. Shopping's `aspects.shopping` and Inspirations' `aspects.inspirations` are read as `modules.shopping` and `modules.inspirations` from the archive's `settings.json`, and Baby's `aspects.baby` as `modules.baby` by a checkout where the private module baby is installed (one without it reads past it, saying so); an `aspects` left empty goes with them. Every entry point reads them so in memory, leaving the file as it is; only the archive's server (`npm start`) writes the moved switches back into it as it starts, so a process of another checkout (`npm run docs` in a worktree, say) never rewrites the file into a form an older checkout's server would refuse, and `aspects` is refused in a file `LIFE_ARCHIVE_SETTINGS` names, saying where it went. | the ready ones on (`pages`) |

## Beside it

- **`shopping/suppliers.json`** in the archive's folder: the shopping module's suppliers, a list of the entries `modules/shopping/server/suppliers.ts` describes (the module's README). With no file there are no suppliers and no pulls, and its page says where they go.
- **`connectors/<id>.json`** in the archive's folder: each connector's switch and settings (data.md's "Where the data lives"). The Matrix rig's user is `user` in `connectors/matrix-bridge.json`, `captain` unless said.

## A module's own settings

A module keeps its own settings in `settings.json` too, under its id: `{"garden": {"plots": ["north"]}}` for a module `garden`. The core takes a top-level key it does not know that names an installed module (docs/modules.md) as that module's own, and the module reads it against its own schema, as strictly as the core reads its own (`sdk/server.ts`'s `moduleSettings`): a key its schema does not know stops it, and a section left out is every key at its default. A top-level key that names neither a setting above nor an installed module stops every entry point, naming it, unless it is the section of a module another checkout has: Baby's (`baby`, a private module's), or one `modules` switches. That one is left as written and not read, said so on stderr, as `settings.json` is every checkout's. Its keys are its README's to list, not this table's. A module may read keys of its own from `.env.local` as well (an address on this machine, say), which its README lists too.
