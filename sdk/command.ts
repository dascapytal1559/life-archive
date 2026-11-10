// What a module's command (its CLI, run by an npm script) imports first, before anything else: the pinned Node (a
// command on any other Node stops with a message saying so, server/nodeVersion.ts), the archive's folder its --data
// names, if it is given one (server/onDataFlag.ts), and the archive's settings (the
// clock, the locale and the phone country set before any module loads, server/onSettings.ts; a settings file that
// cannot be used stops the command, saying why). The server and the core's own commands import the same two.

import "../server/onPinnedNode.ts";
import "../server/onDataFlag.ts";
import "../server/onSettings.ts";

/** The --data option, for a command's own strict parseArgs: onDataFlag.ts has read it already, so it is taken and left alone. */
export const DATA_OPTION = { data: { type: "string" } } as const;
