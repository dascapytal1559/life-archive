// The Cua Space's exports, the Mac's side (server/cuaExports/; docs/data.md's "Exports from the Cua Space"):
//
//   npm run cua-exports                  a round: notes for firstmate, downloads taken into the archive and imported, the next plan
//   npm run cua-exports -- --dry-run     says what a round would do, and does nothing
//   npm run cua-exports -- status        the schedule, the latest rounds, the plan, the latest events and imports
//   npm run cua-exports -- setup --space <id> [--at 10:00] [--model <model>] [--[no-]rehearse] [--[no-]enable]
//                                        puts the playbook in the Space's folder of the Cua Volume and Export browser on its
//                                        Desktop, and keeps the daily round's schedule (off until --enable); run again, it
//                                        changes only what its flags name
//   npm run cua-exports -- nudge         starts a round now (after the captain cleared a stop, say)
//   npm run cua-exports -- bridge        the round's browser bridge (server/cuaExports/bridge.ts), kept running by launchd
//   npm run cua-exports -- install       writes the two launchd agents (the run every 15 minutes, and the bridge) and loads
//                                        them; --dry-run prints them
//
// Each line is logged with its time; a run that fails logs an ERROR line, raises a macOS notification and exits 1.

import { DATA_OPTION } from "../../../sdk/command.ts";
import { archivePath } from "../server/storage.ts";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Schedule } from "effect";
import { archiveCommandsLayer, archiveFolder, notifierLayer, installLaunchAgent, jobNode, localTime, LOG_FOLDER, notify, REPO, runMain } from "../../../sdk/server.ts";
import { parseEvents, platform } from "./cuaExports/plan.ts";
import { runBridge } from "./cuaExports/bridge.ts";
import {
  AGENT, BRIDGE_LABEL, BRIDGE_PORT, bridgeHost, bridgePlist, cua, cuaSpaceLayer, DEFAULT_MODEL, hostCuaLayer, LAUNCHD_LABEL, listRuns, oldAgent, plist,
  ROUTINE_TITLE, volumeFolder,
} from "./cuaExports/live.ts";
import { CuaSpace, exportRound, readState, type Schedule as RoundSchedule, SHARED, writeState } from "./cuaExports/round.ts";

const LOG_FILE = join(LOG_FOLDER, "cua-exports.log");
const BRIDGE_LOG_FILE = join(LOG_FOLDER, "cua-bridge.log");
const AGENT_FILES = fileURLToPath(new URL("./cuaExports/agent/", import.meta.url));
/** Opens the agent's Chrome profile for the captain (server/cuaExports/agent/). */
const LAUNCHER = "Export browser.command";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    ...DATA_OPTION,
    "dry-run": { type: "boolean" },
    space: { type: "string" },
    at: { type: "string" },
    model: { type: "string" },
    rehearse: { type: "boolean" },
    enable: { type: "boolean" },
  },
});
const command = positionals[0] ?? "run";
const dryRun = values["dry-run"] ?? false;

function log(line: string): void {
  console.log(`${localTime(new Date())} ${line}`);
}

/** Plain work in the program, its failure the error itself. */
const plain = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: (error) => error as Error });

/** The Space and schedule setup kept, or a failure saying to run setup. */
const theSetup = Effect.gen(function* () {
  const state = yield* plain(() => readState(archiveFolder()));
  if (!state.space || !state.schedule) return yield* Effect.fail(new Error("the Cua Space's exports are not set up: run npm run cua-exports -- setup --space <the Space's id>"));
  return { space: state.space, schedule: state.schedule, bridgeToken: state.bridge?.token };
});

const status = Effect.gen(function* () {
  const state = yield* plain(() => readState(archiveFolder()));
  if (!state.space || !state.schedule) {
    console.log("Not set up: npm run cua-exports -- setup --space <the Space's id>.");
    return;
  }
  const { space, schedule } = state;
  console.log(`Rounds in ${space}, ${schedule.enabled ? `daily at ${schedule.at}` : `not daily (setup --enable starts one at ${schedule.at} each day)`}, Codex with ${schedule.model}; ` +
    `the agent's files in the Cua Volume's ${volumeFolder(space)}/.`);
  const bridge = yield* bridgeHost(space).pipe(
    Effect.flatMap((host) => Effect.promise(() =>
      fetch(`http://${host}:${BRIDGE_PORT}/${state.bridge?.token ?? "none"}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? `answering on ${host}:${BRIDGE_PORT}` : `answering ${r.status}`), (error: Error) => `not answering on ${host}:${BRIDGE_PORT} (${error.message})`))),
    Effect.catch((failed) => Effect.succeed(`not reachable: ${failed.message}`)),
  );
  console.log(`The rounds' browser bridge (${BRIDGE_LABEL}): ${state.bridge ? bridge : "no token yet (setup makes it)"}.`);
  const runs = yield* listRuns(space);
  console.log(`Latest rounds (${state.rounds.length} in all):`);
  for (const round of state.rounds.slice(-5)) {
    const run = runs.find((r) => r.run_id === round.run);
    console.log(`  ${localTime(new Date(round.at))}  ${round.why}, ${round.run}: ${run ? `${run.status ?? run.phase}${run.reason ? `, Cua says "${run.reason.split("\n")[0]}"` : ""}` : "no longer listed by Cua"}`);
  }
  yield* Effect.gen(function* () {
    const shared = yield* CuaSpace;
    const settings = yield* shared.read(SHARED.settings);
    console.log(`Settings: ${settings?.trim() ?? "none (setup has not written them)"}`);
    const plan = yield* shared.read(SHARED.plan);
    console.log(`Plan:\n${indent(plan ?? "none yet (the first run writes it)")}`);
    const { events, refused } = parseEvents((yield* shared.read(SHARED.events)) ?? "");
    console.log(`Latest events (${events.length} in all${refused.length ? `, ${refused.length} lines refused` : ""}):`);
    for (const e of events.slice(-15)) {
      const what = [e.from && `from ${e.from}`, e.to && `to ${e.to}`, e.until && `until ${e.until}`, e.stop && `stop: ${e.stop}`, e.request && `Keyvault request ${e.request}`, e.files && `${e.files.length} file(s)`].filter(Boolean).join(", ");
      console.log(`  ${localTime(new Date(e.at))}  ${e.kind}${e.platform ? ` ${platform(e.platform).label}` : ""}${what ? ` (${what})` : ""}${e.detail ? `: the agent said "${e.detail}"` : ""}`);
    }
    for (const { line, why } of refused) console.log(`  line ${line} refused: ${why}`);
  }).pipe(Effect.provide(cuaSpaceLayer(space, schedule.model)));
  console.log(`Imports (${state.imports.length}):`);
  for (const i of state.imports.slice(-10)) console.log(`  ${localTime(new Date(i.at))}  ${i.platform} ${i.ok ? "imported" : "FAILED"} from ${i.folder}: ${i.detail}`);
});

const setup = Effect.gen(function* () {
  const dataDir = archiveFolder();
  const state = yield* plain(() => readState(dataDir));
  const old = yield* oldAgent;
  const space = values.space ?? state.space ?? old?.space;
  if (!space) return yield* Effect.fail(new Error("name the Space: npm run cua-exports -- setup --space <id> (cua spaces ls lists them)"));
  const at = values.at ?? state.schedule?.at ?? "10:00";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return yield* Effect.fail(new Error("--at is a time, HH:MM"));
  const model = values.model ?? state.schedule?.model ?? DEFAULT_MODEL;
  if (!model) return yield* Effect.fail(new Error("name the model: --model, or LIFE_ARCHIVE_MODEL in .env.local"));
  const schedule: RoundSchedule = { at, enabled: values.enable ?? state.schedule?.enabled ?? false, model };

  // The agent's files, each written only when it changed: the Cua Volume keeps every version. The settings keep what
  // they say unless a flag changes it.
  const before = yield* Effect.gen(function* () {
    const text = yield* (yield* CuaSpace).read(SHARED.settings);
    return (text ? JSON.parse(text) : {}) as { rehearse?: boolean };
  }).pipe(Effect.provide(cuaSpaceLayer(space, schedule.model)));
  const settings = `${JSON.stringify({ browserProfile: AGENT, rehearse: values.rehearse ?? before.rehearse ?? false }, null, 2)}\n`;
  const files: Array<[string, string]> = [
    [SHARED.playbook, yield* plain(() => readFile(join(AGENT_FILES, SHARED.playbook), "utf8"))],
    [SHARED.eventScript, yield* plain(() => readFile(join(AGENT_FILES, SHARED.eventScript), "utf8"))],
    [SHARED.settings, settings],
  ];
  yield* Effect.gen(function* () {
    const shared = yield* CuaSpace;
    for (const [name, text] of files) {
      if ((yield* shared.read(name)) === text) continue;
      if (!dryRun) yield* shared.write(name, text);
      log(`${dryRun ? "would write" : "wrote"} ${volumeFolder(space)}/${name}`);
    }
  }).pipe(Effect.provide(cuaSpaceLayer(space, schedule.model)));

  // The captain's way into the agent's Chrome profile, on the Space's Desktop.
  const home = (yield* cua(["sandbox", "exec", space, "printenv", "HOME"])).trim();
  const launcher = `${home}/Desktop/${LAUNCHER}`;
  const want = createHash("sha256").update(yield* plain(() => readFile(join(AGENT_FILES, LAUNCHER)))).digest("hex");
  const there = yield* cua(["sandbox", "exec", space, `shasum -a 256 '${launcher}' 2>/dev/null || true`]);
  if (!there.startsWith(want)) {
    if (!dryRun) {
      yield* cua(["sandbox", "cp", join(AGENT_FILES, LAUNCHER), `${space}:${launcher}`]);
      yield* cua(["sandbox", "exec", space, `chmod +x '${launcher}'`]);
    }
    log(`${dryRun ? "would put" : "put"} "${LAUNCHER}" on the Space's Desktop`);
  }

  // The first design's persistent agent could not start Codex (its home is in the Cua Volume): its routine and the
  // agent go, its home staying in the Volume as Cua keeps it. The Mac starts each round now.
  if (old) {
    if (!dryRun) {
      for (const id of old.routines) yield* cua(["agent", "routine", "rm", id]);
      yield* cua(["agent", "forget", AGENT]);
    }
    log(`${dryRun ? "would retire" : "retired"} the persistent agent ${AGENT} and its routine "${ROUTINE_TITLE}"`);
  }

  // The bridge's token, made once: the round reaches its browser at an address only it is given.
  const bridge = state.bridge ?? { token: randomBytes(32).toString("hex") };
  if (JSON.stringify([state.space, state.schedule, state.bridge]) !== JSON.stringify([space, schedule, bridge])) {
    if (!dryRun) yield* plain(() => writeState(dataDir, { ...state, space, schedule, bridge }));
    log(`${dryRun ? "would keep" : "kept"} the schedule: rounds in ${space}, ${schedule.enabled ? `daily at ${schedule.at}` : "not daily (--enable)"}, Codex with ${schedule.model}`);
    // The bridge reads the Space and its token as it starts: started again, if it runs.
    if (!dryRun && (state.space !== space || !state.bridge)) {
      yield* plain(() => promisify(execFile)("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid?.()}/${BRIDGE_LABEL}`])).pipe(Effect.ignore);
    }
  }
  console.log(`
What only the captain can do, in the Space's own screen (the Cua app's viewer, or: cua sandbox view ${space}):
  1. Sign Codex in, once: open Terminal there and run
       export PATH="$HOME/.cua/bin:$PATH"; codex login
     and sign in with his ChatGPT account in the browser it opens (codex login status says whether it is).
  2. Double-click "Export browser" on its Desktop (not Chrome from the Dock: that is another profile, which the rounds
     cannot use), sign in to Instagram, Facebook, Messenger and Discord in the four tabs it opens (Discord also takes a
     QR code from its phone app), then quit that Chrome (Chrome > Quit Google Chrome). Chrome sync is not needed.
Then npm run cua-exports -- install (the Mac's side, every 15 minutes, which also starts the daily round, and the rounds' browser bridge),
npm run cua-exports -- setup --enable (the daily round) and npm run cua-exports -- nudge for a first round.`);
});

async function install(): Promise<void> {
  // The agents run this checkout on its archive: a checkout with none (a worktree, say) would import into nothing.
  const dataDir = archiveFolder();
  if (!existsSync(archivePath(dataDir))) throw new Error(`there is no friend map archive at ${archivePath(dataDir)}: install from the checkout whose archive takes the exports`);
  const node = jobNode();
  const repo = REPO.replace(/\/$/, "");
  const agents = [
    { label: BRIDGE_LABEL, text: bridgePlist({ node, repo, logFile: BRIDGE_LOG_FILE }), what: `keeps the rounds' browser bridge running, logging to ${BRIDGE_LOG_FILE}` },
    { label: LAUNCHD_LABEL, text: plist({ node, repo, logFile: LOG_FILE }), what: `takes the Cua Space's exports every 15 minutes, logging to ${LOG_FILE}` },
  ];
  for (const { label, text, what } of agents) {
    if (dryRun) {
      console.log(`Would write ~/Library/LaunchAgents/${label}.plist:\n${text}`);
      continue;
    }
    const file = await installLaunchAgent(label, text);
    console.log(`Wrote ${file} and loaded it: ${REPO} ${what}.`);
  }
}

/** The bridge: once setup has named the Space and made the token, served until launchd stops it. */
const bridge = Effect.gen(function* () {
  let said = "";
  const { space, token } = yield* Effect.gen(function* () {
    const state = yield* plain(() => readState(archiveFolder()));
    if (!state.space || !state.bridge) return yield* Effect.fail(new Error("not set up yet (npm run cua-exports -- setup)"));
    return { space: state.space, token: state.bridge.token };
  }).pipe(
    Effect.tapError((error) => Effect.sync(() => void (error.message !== said && log(`waiting: ${(said = error.message)}`)))),
    Effect.retry({ schedule: Schedule.spaced("1 minute") }),
  );
  yield* runBridge({ space, token, port: BRIDGE_PORT, profile: AGENT, session: AGENT, agent: AGENT, log, where: bridgeHost(space) }).pipe(Effect.provide(hostCuaLayer));
});

function indent(text: string): string {
  return text.trimEnd().split("\n").map((line) => `  ${line}`).join("\n");
}

const program = Effect.gen(function* () {
  if (command === "run") {
    const { space, schedule, bridgeToken } = yield* theSetup;
    const dataDir = archiveFolder();
    const layer = Layer.mergeAll(cuaSpaceLayer(space, schedule.model, bridgeToken), archiveCommandsLayer(dataDir), notifierLayer(log, "Life archive exports"));
    if (!schedule.enabled) log("the daily round is off (setup --enable): only a nudge starts one");
    const result = yield* exportRound({ dataDir, now: Date.now(), dryRun, log }).pipe(Effect.provide(layer));
    // A round has no way to notify the Mac itself: each stop for the captain is raised here too, beside firstmate's note.
    for (const e of result.handled.filter((e) => e.kind === "needs-user" && !dryRun)) {
      notify(`${platform(e.platform!).label} export: the Cua Space needs you`, `${e.stop}: on the Space's screen, in the export Chrome window (it waits 45 minutes)`);
    }
    log(`${dryRun ? "dry run: " : ""}${result.handled.length} new event${result.handled.length === 1 ? "" : "s"}, ${result.imported.length} import${result.imported.length === 1 ? "" : "s"}; ` +
      `plan: ${result.plan.tasks.map((t) => `${t.do} ${t.platform}`).join(", ") || "nothing today"}${result.started ? `; started the round ${result.started.run}` : ""}`);
  } else if (command === "status") {
    yield* status;
  } else if (command === "setup") {
    yield* setup;
  } else if (command === "nudge") {
    const { space, schedule, bridgeToken } = yield* theSetup;
    const running = (yield* listRuns(space)).filter((r) => r.alive);
    if (running.length > 0) return yield* Effect.fail(new Error(`a round is still running (${running.map((r) => r.run_id).join(", ")}): it goes on by itself once a stop is cleared`));
    const dataDir = archiveFolder();
    const run = yield* Effect.gen(function* () {
      return yield* (yield* CuaSpace).startRound;
    }).pipe(Effect.provide(cuaSpaceLayer(space, schedule.model, bridgeToken)));
    const state = yield* plain(() => readState(dataDir));
    yield* plain(() => writeState(dataDir, { ...state, rounds: [...state.rounds, { run, at: new Date().toISOString(), why: "nudge" }] }));
    log(`started a round: ${run} (npm run cua-exports -- status follows it)`);
  } else if (command === "bridge") {
    yield* bridge;
  } else if (command === "install") {
    yield* plain(install);
  } else {
    return yield* Effect.fail(new Error(`unknown command ${command}: run, status, setup, nudge, bridge or install`));
  }
}).pipe(
  Effect.catch((error: Error) =>
    Effect.sync(() => {
      log(`ERROR ${error.message}`);
      if (command === "run" && !dryRun) notify("The life archive's Cua exports failed", error.message);
      process.exitCode = 1;
    }),
  ),
);

// A signal (launchd stopping it, say) stops the `cua` or import it waits on.
await runMain(program);
