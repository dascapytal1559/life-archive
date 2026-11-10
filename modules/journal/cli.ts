// The journal module's command (README.md), `npm run journal`: its two jobs' commands, each in its jobs/<job>/.
//
//   npm run journal [-- ...]                the voice journals Voice Memos syncs, transcribed each morning
//                                           (jobs/voice-journal/command.ts: a pass, status, retry, install, uninstall)
//   npm run journal -- grok-calls [...]     Grok Bot's finished calls copied into the journal
//                                           (jobs/grok-calls/command.ts: a pass, install, uninstall)
//
// It stays here, whatever moves under jobs/: the voice journals' launcher, which Full Disk Access is given to, has this
// file's path built in (jobs/voice-journal/live.ts's SCRIPT), and rituals' bin/ritual-voice-calls, which an agent
// rituals installed still runs, hands its run here. A module's command: sdk/command.ts first (the pinned Node, the
// settings), then each job's command, which imports the SDK for the rest.

import { parseArgs } from "node:util";
import "../../sdk/command.ts";

// The job is the first word that is no option, wherever `--data <dir>` (sdk/command.ts's) stands; the rest goes on as it is.
const args = process.argv.slice(2);
const { tokens } = parseArgs({ args, options: { data: { type: "string" } }, strict: false, allowPositionals: true, tokens: true });
const job = tokens.find((token) => token.kind === "positional");
if (job?.value === "grok-calls") await (await import("./jobs/grok-calls/command.ts")).grokCalls(args.toSpliced(job.index, 1));
else await import("./jobs/voice-journal/command.ts");
