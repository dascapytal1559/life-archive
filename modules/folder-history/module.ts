// The folder history's server half (sdk/server.ts's defineModule): a private git history of folders the archive does
// not own (server/folderHistory.ts). It has no database, route or page: its work, while the server runs, keeps each
// folder's history as the folder changes (a record begun finished as the server stops), and its command,
// `npm run archive -- history`, says how each history is doing (server/commands.ts). Its settings and its histories are
// where the core kept them before it was a module: data/connectors/folder-history.json and data/history/<name>/. The
// core finds this file by its place (server/modules/loader.ts) and loads it while the module is on; README.md says what
// the module is.

import { defineModule } from "../../sdk/server.ts";
import { historyCommand, HISTORY_HELP } from "./server/commands.ts";
import { keepHistories } from "./server/folderHistory.ts";

export default defineModule({
  id: "folder-history",
  sdk: 1,
  work: ({ folder }) => keepHistories(folder, (line) => console.log(`[history] ${line}`)),
  commands: {
    names: ["history"],
    options: { last: { type: "string" } },
    help: { structure: HISTORY_HELP },
    run: (_command, [name], values, { folder }) => historyCommand(folder, name, values),
  },
});
