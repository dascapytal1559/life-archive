# The inspirations module

The life archive's Inspirations page (the console's `/life-archive/dev/inspirations`): the things the owner keeps for the ideas in them (a post, a reel, a video, a page, a photo), each one item with their caption and their tags, the AI's tags kept apart, fed by every save of it from the iPhone's share sheet, an agent or the terminal. The core's `docs/features.md` says how it works ("Inspirations"), and `docs/modules.md` how a module is laid out, found and switched.

It runs inside a life archive, never on its own: the core loads `module.ts` (its server half) and `viewer.tsx` (its page half), and the module imports the core through the SDK alone (`../../sdk/`). It was a part of the core until 8 November 2026; its routes kept the address they had there (`/life-archive/api/inspirations`, where the share sheet's shortcut posts), and its data moved into its own database and folder once, the core's copy left where it was (below).

- `module.ts`: its database, its routes (a mount at their old address, and the module's own `/life-archive/api/m/inspirations`), its work while the server runs (previews, AI tags), its commands (`npm run archive -- inspiration ...` and `inspiration-tag ...`), its check, its made-up data, its part of the demo's build and its line of the privacy policy.
- `viewer.tsx`: the Inspirations aspect and its tabs (`viewer/InspirationsSection.tsx`, the page itself `viewer/InspirationsView.tsx`, its look `viewer/inspirations.css`).
- `wire.ts`: the routes' address and the shapes both halves share.
- `demo.ts`: the static demo's live reads of it.
- `server/`: the store (`store.ts`, the only code that reads or writes its tables), its database and the take-over (`db.ts`), its kept files (`files.ts`), the routes (`http.ts`), the worker (`worker.ts`) with the previews (`previews.ts`, `instagram.ts`), the AI's tags (`aiTags.ts`), the links' canonical forms (`links.ts`), the change log's words (`changeLog.ts`) and the commands (`cli.ts`).
- `fixtures/`: made-up inspirations for the testing data, and a made-up Instagram for the previews' tests.

## Setting it up

It is unfinished, so off in a fresh install: switch it on with `"modules": {"inspirations": true}` in the archive's `settings.json` (or every page with `"pages": "all"`), and off with `false`. A settings.json that still says `"aspects": {"inspirations": ...}`, the switch it had as a core page, is read as `modules.inspirations` everywhere, and written so into the file when the archive's server starts. Off, nothing of it runs: its routes answer 404 to a GET, and the share sheet's capture, a POST, 405, its commands are not offered, no previews or AI tags are made, and its page is not in the rail.

The AI's tags need the archive's AI service (a model named in `LIFE_ARCHIVE_MODEL`); without one each item says why it has none.

## Its data

In the archive's folder, `modules/inspirations/`:

- `inspirations.sqlite`: the items, their saves, kept files, his tags and the AI's, the paced platforms' fetches, and the change log of his edits, each undoable.
- `files/<ab>/<sha256>.<ext>`: each kept file (a shared photo or screenshot, shared text kept as a file, an Instagram post's one small picture), by its content's hash.

Inspirations are metadata, all of them (the privacy policy's metadata layer).

**The take-over.** Until this module, the inspirations were the core's: their tables in `core.sqlite`, their files in `platform-exports/inspirations/live/`. The first time the module's database is opened beside a `core.sqlite` (the server's first start on this code, or any `npm run archive` command), it copies them in, in one transaction: every row of every table, ids kept (an item's number and an Undo of an edit made before all go on meaning what they did), and every kept file into `files/`, each copy checked byte for byte. Before it commits, every table is checked to hold exactly the core's rows; anything else undoes it, the module is broken and says why (the server's log, `npm run archive`), and the next open tries again. It happens once (`meta`'s `taken_over` says the day). It never deletes: the core's tables and files stay where they were, read by nothing, until their owner decides they may go.
