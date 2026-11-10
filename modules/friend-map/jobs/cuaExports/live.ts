// The Mac's side of the Cua Space's exports, wired to the real things (round.ts has what it does): the Space and its
// Cua Volume through the `cua` command, and this Mac's Cua MCP server for the round's browser (bridge.ts) (the archive's
// own commands and firstmate's inbox are server/jobs.ts's).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { delimiter, join } from "node:path";
import { Effect, Layer } from "effect";
import { envSetting, jobPath, jsonLines, launchdPlist, run, RunFailed, settings, spawnScoped } from "../../../../sdk/server.ts";
import { bridgeAddress, HostCua, type ToolResult } from "./bridge.ts";
import { CuaSpace } from "./round.ts";

/**
 * The rounds' label in Cua, and their folder in the Space's part of the Cua Volume. Each round is a run of its own
 * (`cua agent run`), not a persistent agent's turn: a persistent agent keeps Codex's home in the Cua Volume, where Codex
 * cannot start (its SQLite state fails there with "Operation not supported", and Cua cannot link the sign-in in), and
 * where every version of its sign-in and its session logs would be kept for good. A plain run uses the Space's own
 * ~/.codex, where the captain signed Codex in.
 */
export const AGENT = settings().cua.agent;
export const AGENT_FOLDER = AGENT;
export const HARNESS = "openai-codex";
/** A round's model unless setup is given one: LIFE_ARCHIVE_MODEL. */
export const DEFAULT_MODEL = envSetting("LIFE_ARCHIVE_MODEL");

/** The `cua` command: CUA_BIN, else on the PATH, else where Cua Spaces' installer links it (launchd's PATH has neither). */
export function cuaBin(env = process.env): string {
  if (env.CUA_BIN) return env.CUA_BIN;
  const found = [...(env.PATH ?? "").split(delimiter).filter((dir) => dir.startsWith("/")), join(homedir(), ".local", "bin")]
    .map((dir) => join(dir, "cua"))
    .find((file) => existsSync(file));
  if (!found) throw new Error("there is no `cua` command: install Cua Spaces, or name it in CUA_BIN");
  return found;
}

/** `cua <args>`: what it printed. */
export const cua = (args: string[], input?: string) => run(cuaBin(), args, input === undefined ? {} : { input }).pipe(Effect.map(({ stdout }) => stdout));

/**
 * One tool of this Mac's Cua MCP server, in a `cua mcp` of its own (about half a second): every `cua` process here reaches
 * the Space through the Cua daemon, so they share its driver sessions, which the Keyvault fills.
 */
export const hostCuaCall = (tool: string, args: Record<string, unknown>): Effect.Effect<ToolResult, RunFailed> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { child } = yield* spawnScoped(() => spawn(cuaBin(), ["mcp"], { stdio: ["pipe", "pipe", "pipe"] }));
      let stderr = "";
      child.stderr!.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
      child.stdin!.on("error", () => {}); // it stopped; its close says why
      const send = (message: object) => void child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      return yield* Effect.callback<ToolResult, RunFailed>((resume) => {
        let done = false;
        const end = (result: Effect.Effect<ToolResult, RunFailed>) => {
          if (!done) resume(result);
          done = true;
        };
        const failed = (message: string) => end(Effect.fail(new RunFailed({ message })));
        child.once("error", (error) => failed(`cua mcp could not start: ${error.message}`));
        child.once("close", (code) => failed(`cua mcp stopped before it answered (${stderr.trim().split("\n").at(-1) || `exit code ${code}`})`));
        void (async () => {
          for await (const line of jsonLines(child.stdout!)) {
            let message: { id?: unknown; result?: unknown; error?: { message?: string } };
            try {
              message = JSON.parse(line);
            } catch {
              continue;
            }
            if (message.error && (message.id === 1 || message.id === 2)) return failed(`cua mcp ${tool}: ${message.error.message ?? "an error"}`);
            if (message.id === 1) {
              send({ method: "notifications/initialized" });
              send({ id: 2, method: "tools/call", params: { name: tool, arguments: args } });
            } else if (message.id === 2) return end(Effect.succeed(message.result as ToolResult));
          }
        })();
        send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "life-archive", version: "1" } } });
      });
    }),
  ).pipe(Effect.timeoutOrElse({ duration: "3 minutes", orElse: () => Effect.fail(new RunFailed({ message: `cua mcp did not answer ${tool} within 3 minutes` })) }));

export const hostCuaLayer = Layer.succeed(HostCua, { call: hostCuaCall });

/** Where the round's browser bridge listens, on this Mac's address on the Space's network (docs/data.md's "Exports from the Cua Space"): CUA_BRIDGE_PORT, else 4656. */
export const BRIDGE_PORT = Number(envSetting("CUA_BRIDGE_PORT") ?? 4656);

/** This Mac's address on a local Space's network, which the Space reaches it at; fails while that network is down. */
export const bridgeHost = (space: string) =>
  cua(["--json", "sandbox", "info", space]).pipe(
    Effect.flatMap((text) => {
      const ip = (JSON.parse(text) as { provider_details?: { host?: unknown } }).provider_details?.host;
      const address = typeof ip === "string" ? bridgeAddress(ip, networkInterfaces()) : null;
      return address
        ? Effect.succeed(address)
        : Effect.fail(new RunFailed({ message: typeof ip === "string" ? `this Mac has no address on the Space's network (${ip}): is the Space running?` : `the Space ${space} has no local address: the bridge serves a local Space only` }));
    }),
  );

/** The bridge's MCP address, as the round's Codex reaches it from the Space. */
export const bridgeUrl = (host: string, token: string) => `http://${host}:${BRIDGE_PORT}/${token}/mcp`;

/** A round's prompt: where the playbook is, as the agent sees the Cua Volume in its Space. */
export const roundPrompt = (space: string) =>
  `read "~/Cua Volume/${volumeFolder(space)}/PLAYBOOK.md" and do the round it describes, with plan.json and settings.json beside it.`;

/** The Space folder of the Cua Volume for a Space id: spaces/local-work/ for local:work. */
export const volumeFolder = (space: string) => `spaces/${space.replaceAll(":", "-")}/${AGENT_FOLDER}`;

/** The persistent agent and daily routine the first design made (both retired by setup), and its Space; null when none. */
export const ROUTINE_TITLE = "Export round";
export const oldAgent = Effect.gen(function* () {
  const listed = JSON.parse(yield* cua(["--json", "agent", "persistent"])) as { agents?: Array<Record<string, unknown>> };
  const agent = listed.agents?.find((a) => a.name === AGENT);
  if (!agent) return null;
  const space = agent.space ?? agent.space_id;
  const { routines } = JSON.parse(yield* cua(["--json", "agent", "routine", "ls", AGENT])) as { routines: Array<{ id: string; title: string }> };
  return { space: typeof space === "string" ? space : null, routines: routines.map((r) => r.id) };
});

/** A run as `cua agent ls --json` lists it. */
interface ListedRun {
  run_id: string;
  alive?: boolean;
  status?: string;
  phase?: string;
  reason?: string;
  meta?: { label?: string; created_at?: number };
}

/** The rounds' runs in the Space, newest first, with Cua's word on how each went. */
export const listRuns = (space: string) =>
  cua(["--json", "agent", "ls", space]).pipe(
    Effect.map((text) => (JSON.parse(text) as ListedRun[]).filter((r) => r.meta?.label === AGENT)),
  );

/** The Space, through `cua`, its rounds' browser through the bridge whose token is `bridgeToken`. The Space's home is asked once. */
export const cuaSpaceLayer = (space: string, model: string, bridgeToken?: string) =>
  Layer.effect(CuaSpace, Effect.gen(function* () {
    const folder = volumeFolder(space);
    const home = (yield* cua(["sandbox", "exec", space, "printenv", "HOME"])).trim();
    if (!home.startsWith("/")) return yield* new RunFailed({ message: `the Space ${space} gave no home folder` });
    const download = (name: string) => {
      // plan.ts lets only an export's own names through; checked again, as the name goes into a shell line.
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`refused a download named ${JSON.stringify(name)}`);
      return `${home}/Downloads/${name}`;
    };
    return {
      space,
      read: (name: string) =>
        cua(["volume", "cat", `${folder}/${name}`]).pipe(
          Effect.map((text): string | null => text),
          Effect.catchIf((failed) => failed.code === 3 && /not found/.test(failed.message), () => Effect.succeed(null)),
        ),
      write: (name: string, text: string) => cua(["volume", "put", `${folder}/${name}`, "-"], text).pipe(Effect.asVoid),
      copyOut: (name: string, to: string) => cua(["sandbox", "cp", `${space}:${download(name)}`, to]).pipe(Effect.asVoid),
      removeDownload: (name: string) => cua(["sandbox", "exec", space, `rm -f -- '${download(name)}'`]).pipe(Effect.asVoid),
      runs: listRuns(space).pipe(
        Effect.map((runs) => runs.map((r) => ({ id: r.run_id, alive: r.alive === true, failed: r.status === "failed" || r.phase === "failed" }))),
      ),
      // It stops by itself once the round's turn ends; the agent's home is the Space's own (its ~/.codex). Its driver
      // tools are the bridge's, in place of the Space's own, so its browser is this Mac's and the Keyvault can fill it.
      startRound: Effect.gen(function* () {
        if (!bridgeToken) return yield* new RunFailed({ message: "the browser bridge has no token: run npm run cua-exports -- setup" });
        const host = yield* bridgeHost(space);
        const url = bridgeUrl(host, bridgeToken);
        const answering = yield* Effect.promise(() => fetch(url.replace(/\/mcp$/, "/health"), { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false));
        if (!answering) return yield* new RunFailed({ message: `the browser bridge (${BRIDGE_LABEL}) is not answering on ${host}:${BRIDGE_PORT}: npm run cua-exports -- install, and its log ~/Library/Logs/LifeArchive/cua-bridge.log` });
        const text = yield* cua(["--json", "agent", "run", space, HARNESS, roundPrompt(space), "--model", model, "--exit-when-idle", "--label", AGENT, "--cwd", home,
          "--no-sandbox-mcp", "--mcp", `${DRIVER_SERVER}=${url}`]);
        const id = (JSON.parse(text) as { run_id?: unknown }).run_id;
        return typeof id === "string" ? id : yield* new RunFailed({ message: "cua agent run gave no run id" });
      }),
    };
  }));

/** The MCP server name the round's Codex knows its driver tools by (`mcp__cua_driver__...`), as the Space's own were named. */
export const DRIVER_SERVER = "cua_driver";

/** The launchd agent that keeps the round's browser bridge running (`npm run cua-exports -- install`). */
export const BRIDGE_LABEL = "local.life-archive-cua-bridge";

export function bridgePlist({ node, repo, logFile, home = homedir() }: { node: string; repo: string; logFile: string; home?: string }): string {
  return launchdPlist({
    label: BRIDGE_LABEL,
    comment: `The Cua Space's export rounds reach their browser through this Mac here (${repo}, npm run cua-exports -- bridge; docs/data.md's "Exports from the Cua Space"), kept running. Written by npm run cua-exports -- install.`,
    program: [node, "--no-warnings", "modules/friend-map/jobs/cua-exports.ts", "bridge"],
    repo,
    path: jobPath(node, join(home, ".local", "bin")),
    schedule: { keepAlive: true },
    logFile,
  });
}

/** The launchd agent that runs a round every 15 minutes (`npm run cua-exports -- install`). */
export const LAUNCHD_LABEL = "local.life-archive-cua-exports";
export const EVERY_SECONDS = 15 * 60;

export function plist({ node, repo, logFile, home = homedir() }: { node: string; repo: string; logFile: string; home?: string }): string {
  return launchdPlist({
    label: LAUNCHD_LABEL,
    comment: `The Mac's side of the Cua Space's exports (${repo}, npm run cua-exports; docs/data.md's "Exports from the Cua Space"), every ${EVERY_SECONDS / 60} minutes. Written by npm run cua-exports -- install.`,
    program: [node, "--no-warnings", "modules/friend-map/jobs/cua-exports.ts", "run"],
    repo,
    path: jobPath(node, join(home, ".local", "bin")),
    schedule: { everySeconds: EVERY_SECONDS },
    logFile,
  });
}
