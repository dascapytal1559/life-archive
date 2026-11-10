// The Events page's Sources tab's route (viewer/sourcesWire.ts's SOURCES_API), under the viewer's /life-archive/:
//
//   GET /life-archive/api/sources  -> SourcesAnswer: a row for each connector (sources.ts)
//
// Read afresh each time: the connectors as the server's host runs them (switched on or off, each sync connector's live
// state, their settings; the modules' among them, with their manifests), the launchd agents installed on this Mac (their
// plists, through plutil), the Cua Space's schedule (its state file), and when each scheduled job last synced its
// connectors well (their state files); the runs' facts on the viewer's own connection, which reads no content, and
// from each module's own database for its connectors' runs, what they brought by the module's hook, kept until a run
// changes (runStamp). Only reads, and only from the page itself.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { Context, Effect } from "effect";
import type { SourcesAnswer } from "../../viewer/sourcesWire.ts";
import { OpenArchive, type Archive } from "../archive/index.ts";
import { ForbiddenError } from "../errors.ts";
import { answering, fromOwnPage, sendJson, serve, type ApiHandler, type Route } from "../jsonApi.ts";
import { ViewerDb } from "../viewer/connection.ts";
import type { Reads } from "../viewer/tab.ts";
import { indexBrought, type ExportFeed, type JobFeed, runFacts, runStamp, sourceRows, type HostConnector, type RunFacts } from "./sources.ts";

/** A launchd agent's plist as installed on this Mac, as JSON; null when it is not installed. */
export type PlistReader = (label: string) => Promise<Record<string, unknown> | null>;

/** Reads ~/Library/LaunchAgents/<label>.plist through plutil; null when there is none or it does not read. */
export const installedPlist: PlistReader = async (label) => {
  const file = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  if (!existsSync(file)) return null;
  try {
    const { stdout } = await promisify(execFile)("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]);
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    console.error(`[sources] ${file} does not read: ${(error as Error).message}`);
    return null;
  }
};

/** The modules' scheduled jobs and export rounds (sdk/server.ts's `sources`). */
const feedsOf = (archive: Archive): { jobs: JobFeed[]; exports: ExportFeed[] } => ({
  jobs: archive.modules.flatMap((m) => [...(m.definition.sources?.jobs ?? [])]),
  exports: archive.modules.flatMap((m) => [...(m.definition.sources?.exports ?? [])]),
});

/** The route, for the archive kept at `dataDir`, reading launchd agents with `readPlist`. */
export const sourcesRoute = (
  dataDir: string,
  { readPlist = installedPlist, now = () => Date.now() }: { readPlist?: PlistReader; now?: () => number } = {},
): Route<ForbiddenError, ViewerDb | OpenArchive> => {
  let kept: { stamp: string; facts: Map<string, RunFacts> } | null = null;
  /** The archive's connectors' facts from `db`, and each module's connectors' from its own database (its `source` and `connector_state` tables, and its hook). */
  const factsOf = (core: DatabaseSync, archive: Archive) => {
    const ledgers = [{ db: core, brought: indexBrought }, ...archive.modules.flatMap((m) => (m.db && m.definition.connectors ? [{ db: m.db, brought: m.definition.connectors.brought }] : []))];
    const stamp = JSON.stringify(ledgers.map((ledger) => runStamp(ledger.db)));
    if (kept?.stamp !== stamp) kept = { stamp, facts: new Map(ledgers.flatMap((ledger) => [...runFacts(ledger.db, ledger.brought)])) };
    return kept.facts;
  };
  return (req, res) =>
    Effect.gen(function* () {
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "the sources are only read" });
      yield* fromOwnPage(req);
      const { archive } = yield* OpenArchive;
      const reads = (yield* ViewerDb).reads();
      if (archive instanceof Error) return sendJson(res, 503, { error: `the archive is not available: ${archive.message}` });
      if (reads instanceof Error) return sendJson(res, 503, { error: `the archive is not available: ${reads.message}` });
      const answer = yield* Effect.promise(async (): Promise<SourcesAnswer> => {
        const { jobs, exports } = feedsOf(archive);
        const labels = [...jobs.map((job) => job.label), ...exports.map((feed) => feed.label)];
        const [connectors, plists, rounds, checked] = await Promise.all([
          hostConnectors(archive),
          Promise.all(labels.map(async (label) => [label, await readPlist(label)] as const)).then(Object.fromEntries),
          Promise.all(exports.map(async (feed) => ({ feed, round: await feed.schedule(dataDir).catch(() => null) }))),
          jobsChecked(dataDir, jobs),
        ]);
        const at = now();
        return { at, rows: sourceRows({ connectors, manifests: archive.host.manifests(), facts: factsOf(reads.core, archive), plists, jobs, exports: rounds, checked }, at) };
      });
      sendJson(res, 200, answer);
    }).pipe(answering(ForbiddenError));
};

/** When each scheduled job last synced each of its connectors well, from its state file's `checked` (the latest where two say). */
async function jobsChecked(dataDir: string, jobs: readonly JobFeed[]): Promise<Record<string, number>> {
  const checked: Record<string, number> = {};
  for (const job of jobs) {
    const state = await readFile(join(dataDir, job.state), "utf8").then((text) => JSON.parse(text) as { checked?: Record<string, unknown> }, () => null);
    for (const connector of job.connectors) {
      const at = state?.checked?.[connector];
      if (typeof at === "number") checked[connector] = Math.max(checked[connector] ?? 0, at);
    }
  }
  return checked;
}

/** The connectors as `archive`'s host runs them, each with its settings ({} where they do not read). */
async function hostConnectors(archive: Archive): Promise<HostConnector[]> {
  const statuses = await archive.host.statuses();
  return Promise.all(statuses.map(async (status) => ({
    id: status.id,
    enabled: status.enabled,
    capabilities: status.capabilities,
    live: status.live,
    config: await archive.host.readConfig(status.id).then((read) => read.config, () => ({})),
  })));
}

/** The route as node:http's handler, for the tests: runs read on the archive `reads` gives, connectors from `archive`. */
export function createSourcesApi(
  dataDir: string,
  { reads, archive, readPlist, now }: { reads: () => Reads | Error; archive: Archive | Error; readPlist?: PlistReader; now?: () => number },
): ApiHandler {
  return serve(Context.make(ViewerDb, { reads }).pipe(Context.add(OpenArchive, { archive })), sourcesRoute(dataDir, { readPlist, now }));
}

