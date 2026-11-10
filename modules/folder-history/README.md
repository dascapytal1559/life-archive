# The folder history module

The life archive's folder history: a private git history of folders the archive does not own, such as a shared Google Drive folder. Drive keeps only about 100 versions or 30 days of each file and never says what changed across files at once, so while the archive's server runs, this module records each folder into a git repository of its own as it changes. `docs/events.md`'s "Folder history" says how it behaves; `docs/modules.md` how a module is laid out, found and switched.

It runs inside a life archive, never on its own: the core loads `module.ts` (its server half), and the module imports the core through the SDK alone (`../../sdk/`). It has no database, route or page half.

- `module.ts`: its work (each folder's watcher, while the server runs) and its command.
- `server/folderHistory.ts`: the settings, a record of a folder into its history, the watcher, and the read-only report of a history's state.
- `server/commands.ts`: `npm run archive -- history [<folder>] [--last <n>]`: with no folder, each folder's state; with one, its last commits too, each with the files it added, changed or deleted, never their content.

**Its data** is where the core kept it before this was a module, so an archive kept since then goes on unchanged: the settings in `connectors/folder-history.json` of the archive's folder, and each folder's history in `history/<name>/`, a bare git repository with no remote, ever. A later data move may bring both under `modules/folder-history/`; until then nothing of this module is in that folder.

Switch it off with `"modules": {"folder-history": false}` in the archive's `settings.json`: the server then records nothing and `history` is unknown. It is marked ready, so a fresh install runs it; with no folders named, it does nothing.
