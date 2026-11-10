# life-archive

A life archive: every message, call, hangout and LLM session from its owner's apps (the captain, in these documents), kept in SQLite databases in one folder, with the code that imports them, keeps them in sync and answers for them.
The core keeps the agents' sessions, the event index, the calendar and the trail of content reads; the modules under `modules/` keep the rest (the inspirations among them, `modules/inspirations/`). The friend map module (`modules/friend-map/`) is the social layer: the messages, calls, hangouts and people, and friend-map's page (once friend-map-frontend's, now this project's own), served by this project's server under `/friend-map/`.
README.md says what it is, SETUP.md how to set one up, and `docs/` how it works; read `docs/people.md`'s "People" before changing anyone's name, aliases, tags or links.

If an `AGENTS.local.md` exists beside this file, read it first: it holds this installation's owner's own orders, and it wins where the two differ. It is never committed.

## Running

- `npm start` runs the archive's server (`server/main.ts`): the only process that opens the archive, on 127.0.0.1 at the port `LIFE_ARCHIVE_URL` names (4650 unless set), serving the archive's viewer at `/life-archive/`, and through the friend map module friend-map's contract at `/api/archive/` and friend-map's page at `/friend-map/`.
  Never start a second copy on the real archive; it cannot bind the port. If it is down, read how this installation runs it (AGENTS.local.md, else SETUP.md's "Keep it running") and its log rather than starting one by hand.
- After changing a file the server runs (anything under `server/`, `sdk/` or `src/` but tests, a module's `module.ts`, `wire.ts`, `src/`, `server/` and `connectors/` (`modules/<id>/`), and `viewer/wire.ts`, `viewer/editWire.ts`, `viewer/sourcesWire.ts` and `viewer/format.ts`; the rest of `viewer/` and a module's `viewer/` reload by themselves), restart the server the way this installation runs it. friend-map's page shows "archive unavailable" for those seconds and reconnects by itself.
- To try a change, run a server of your own on testing data and a spare port (`docs/running.md`'s "Running"): never on the archive's folder.
- Stop a test server you started by its pid (the process you spawned), never by name with `pkill` or `killall`: a name matches the live services too.

## Friend data

- The real data lives in the archive's folder: `~/life-archive-data`, outside every checkout, or wherever `LIFE_ARCHIVE_DATA` (environment, then `.env.local`) names (`server/dataHome.ts`). `data/` means that folder for short; a linked git worktree's own `data/` is empty, and never the real one. It holds the core's own database in `core.sqlite`, the calendar and the trail of content reads in `calendar.sqlite`, each module's database under `modules/<id>/`, among them friend map's archive in `modules/friend-map/archive.sqlite`, whose person table holds every person's name, aliases and tags and which chat accounts are whom; its media in the platforms' exports under `platform-exports/` (older copies in `archive/media/`); the connectors' settings; and its backups.
  Every entry point (the server, `npm run archive`, `check-data`, the connectors' scripts) finds it by itself; never pass a path to the real data by hand.
  It is private: never commit it, and never copy it anywhere outside that folder.
- Privacy defaults, which the owner's AGENTS.local.md may change (its privacy rules win over these): messages with other people on social media and messaging platforms never reach a cloud model or cloud agent, only local models on the owner's machines; email and other personal information may go to model providers, with training opt-outs on where offered; nothing personal goes public.
- The privacy policy is kept in `server/privacy/policy.ts` (`PRIVACY`, and `REPO_PRIVACY` and `FORK_PRIVACY` for what a repository may hold); read it there or in `docs/privacy.md`. It has three layers: content (message text, media, the captain's hangout notes and drafts, and every copy that holds them), read only when he asks, every read logged, and by default other people's messages by local models alone; metadata (names, times, durations, counts and the rest of the index), which they read freely; and what a repository may hold.
- Read content only with a model those privacy rules allow (under the defaults, a local model), only when the captain asks for something from his chats (a sentiment summary, a search), only for that request, and only through `npm run archive -- timeline`, `search` and `event-content` (the text behind the event index's LLM sessions), which keep every read in the trail (`npm run archive -- content-log`): set `LIFE_ARCHIVE_READER` to your name (`claude-code`, `codex`; `FRIEND_MAP_READER`, its old name, still works) and pass his words as `--why`. Never read it by opening `modules/friend-map/archive.sqlite`, an export, a media file, a backup, the rig's data or a session file, and never open imported photos or videos: move and organize them by metadata only. SQL queries cannot read it. `catch-ups`, `person show` and `people --reach-out` print hangout notes and drafts without the trail: use them for those only on the same terms.
- When you build, import or organize, learn a format without content: `timeline`, `search` and `event-content` take `--redacted` (every text as its length; a search is still logged) and `--json` for the app's own shape, and `timeline` and `search` take `--testing` (the testing data, never the archive).
- Change people only through friend-map's page, the Events page's People and Tags tables, or `npm run archive -- person ...` (and `edit`, `merge`, `detach`, `tags`; see `docs/people.md`'s "People"), never by editing friend map's `archive.sqlite` directly.
- After every data edit, run `npm run check-data`; it names each person with a problem and what is wrong. Fix every one before moving on.
- Imports follow `docs/import-runbook.md`.

## Changing friend data from a chat

The captain may open you here (Claude Code or Codex) to change people: hide them (tag `archive`), tag them, set their location, and the like. `docs/people.md`'s "Changing data from a chat" has the detail.

- Use only `npm run archive` commands: `edit` for one change to many people, chosen by a query or by number, and `person`, `merge`, `detach` and the rest otherwise. Never write SQL.
- Run the dry run first (`edit` without `--apply`) and show the captain who will change; apply only once they agree, with the dry run's `--expect`.
- When an instruction is ambiguous (for example "who I have not tagged myself": nobody with any tag, or everyone without this one?), ask instead of guessing.
- One changeset per instruction, with the captain's words as `--why`; a second edit for the same instruction goes in with `--into <changeset>`.
- Tell the captain the changeset number, and offer `npm run archive -- changes undo <changeset>` (or Undo in friend-map's Changes).
- Run `npm run check-data` after.

## What the repository holds

Code and made-up data, nothing else: the archive's folder, `.env.local`, `AGENTS.local.md` and `CLAUDE.local.md` are never committed, and tests, fixtures and the testing data use only made-up people:

- Use only names from the made-up pools in `server/fixtures/madeUpNames.ts`; its test holds every quoted name in the tests, fixtures and testing data to them. Never copy a real case from the archive into a test or an example; make up one with the same shape.
- Use numbers set aside for fiction (such as +61 491 570 006 and +61 491 570 110, from the ACMA's list of numbers for creative works).
- No one's own values in code: what is one person's (their time zone, locale, hosts, paths, suppliers, family) goes in `settings.json` or `.env.local` (`docs/settings.md`), with a default that suits anyone.
- A module of the owner's own goes in `modules/<id>/`, which git ignores unless `.gitignore` names it (`docs/modules.md`'s "Private modules").

## What came from friend-map

friend-map-frontend is retired: the captain is folding it into this project. What this project took of it is its own now.

- friend-map's page (`modules/friend-map/page/`: its `index.html` and every file it reaches), the contract (`src/archive.ts`: the shapes the page renders and writes back; the page imports it through `sdk/contract.ts`, one copy) and `server/fixtures/madeUpNames.ts` are this project's: change them here, as any other code. Nothing is pinned or synced from friend-map-frontend any more.
- The page keeps its own copies of two of the archive's pieces, the name check `isPlaceholderName` (`page/src/names.ts`) and the query language (`page/src/demo/query.ts`); `modules/friend-map/server/pageCopies.test.ts` fails when they disagree with the archive's (`names.ts`, `query.ts`). Change them together.
- The page still links to friend-map's public demo (friend-map-demo.pages.dev) and has a Demo entry; whether the demo stays is the captain's call, so leave them.
- A change to a connector's manifest or to the privacy policy changes the documents written from them (`docs/platforms.md`, `docs/privacy.md`): run `npm run docs` and commit both; `tools/docs/docs.test.ts` fails until you do.
- The helpers copied once (`src/time.ts`, `identicon.ts`, `groupName.ts`, `calls.ts`, `catchUps.ts`, `eventWords.ts`, and `server/errors.ts`, `files.ts`, `jsonApi.ts`, `allowedHosts.ts`, `nodeVersion.ts`, `onPinnedNode.ts`, `dataHome.ts`) are this project's own; the page has older copies of some of them (its `src/time.ts`, `identicon.ts` and the rest), which have drifted apart from these.

## Code changes

- The stack is TypeScript and Effect: new server code is written in Effect, as `docs/effect.md` says, and older code moves in the order `docs/effect-migration.md` sets.
- Keep `npm test` and `npm run typecheck` passing (on the pinned Node, `.node-version`), and add or update tests with behaviour changes.
- Every code file (tests too) is at most 1000 lines; the files already longer are on a ratchet in `oversized-files.json` (they may not grow, and their ceilings come down as they shrink). Split a file by responsibility, not by line count. `npm test` holds this (`npm run file-size` alone).
- Tests and experiments never touch the real archive's folder.
- Keep `docs/people.md`'s "People" accurate when you change how people are kept.
- Keep it working on Linux as well as macOS: a macOS-only part (launchd, Swift, the Mac's own databases) either has a Linux path or is optional and says so (SETUP.md's "Linux: what works and what does not yet").
