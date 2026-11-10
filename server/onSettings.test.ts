// Every process runs on the archive's settings: a process that did not read them would reckon its days in the machine's
// zone and read phone numbers as written. Each entry point is started on a settings file that cannot be used and must stop
// on it, saying so, before it does anything: on a made-up folder, with no PATH, so one that failed to stop could reach nothing.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { REPO } from "./dataHome.ts";

/**
 * Those that read no clock, phone number or settings; the guard, whose hooks' scans read none, and whose model's review
 * loads the modules, which do, so a file it cannot use stops that review with the guard's own message (guard.test.ts);
 * and the testing data's generator, which always runs on the testing settings.
 */
const NEEDS_NONE = new Set(["server/guard/cli.ts", "tools/checks/fileSize.ts","modules/friend-map/fixtures/make-fixtures.ts", "server/fixtures/testing-data.ts"]);

const scripts = Object.values((JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts);
const connectorsIn = (dir: string) => readdirSync(join(REPO, dir), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `${dir}/${entry.name}/main.ts`)
  .filter((file) => existsSync(join(REPO, file)));
const connectors = ["server/connectors", ...readdirSync(join(REPO, "modules")).map((id) => `modules/${id}/connectors`).filter((dir) => existsSync(join(REPO, dir)))].flatMap(connectorsIn);
const entries = [
  // The core's commands, and the modules' (modules/<id>/cli.ts, which import sdk/command.ts first).
  ...new Set(scripts.flatMap((script) => [...script.matchAll(/\bnode\b.*?((?:server|modules|tools)\/\S+\.ts)/g)].map((match) => match[1]))),
  "modules/friend-map/server/sqlRead.ts", // run by sqlQuery.ts, a process of its own for each query
  ...connectors,
].filter((file) => !NEEDS_NONE.has(file));

const folder = mkdtempSync(join(tmpdir(), "life-archive-entry-points-"));
const wrong = join(folder, "settings.json");
writeFileSync(wrong, JSON.stringify({ timezone: "Asia/Tokyo" }));

afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("each entry point", () => {
  it.each(entries)("%s stops on a settings file it cannot use", (file) => {
    const ran = spawnSync(process.execPath, ["--no-warnings", join(REPO, file), "no-such-command"], {
      cwd: folder,
      encoding: "utf8",
      input: "",
      timeout: 25_000,
      env: { LIFE_ARCHIVE_DATA: folder, LIFE_ARCHIVE_SETTINGS: wrong, LIFE_ARCHIVE_URL: "http://127.0.0.1:1", PATH: "", HOME: folder },
    });
    expect(ran.stderr, file).toContain("is not what docs/settings.md describes");
    expect(ran.status, file).toBe(1);
  });
});

describe("a core page's old switch, in the archive's commands", () => {
  it("is read as its module's, and the archive's settings.json is left as it is: only the archive's server writes it back", () => {
    const own = mkdtempSync(join(folder, "own-"));
    const written = JSON.stringify({ aspects: { shopping: false } });
    writeFileSync(join(own, "settings.json"), written);
    const ran = spawnSync(process.execPath, ["--no-warnings", join(REPO, "server/archive/cli.ts"), "tag", "list"], {
      cwd: folder,
      encoding: "utf8",
      input: "",
      timeout: 25_000,
      env: { LIFE_ARCHIVE_DATA: own, PATH: "", HOME: folder },
    });
    expect(ran.stderr).not.toMatch(/^\s+at .*:\d+:\d+/m);
    expect(ran.status).toBe(0);
    expect(readFileSync(join(own, "settings.json"), "utf8")).toBe(written);
  });
});

describe("a switch naming no installed module, in the archive's commands", () => {
  it("is said so, and the command goes on, as settings.json may switch a module another checkout has", () => {
    const own = mkdtempSync(join(folder, "own-"));
    writeFileSync(join(own, "settings.json"), JSON.stringify({ modules: { helath: false } }));
    const ran = spawnSync(process.execPath, ["--no-warnings", join(REPO, "server/archive/cli.ts"), "tag", "list"], {
      cwd: folder,
      encoding: "utf8",
      input: "",
      timeout: 25_000,
      env: { LIFE_ARCHIVE_DATA: own, PATH: "", HOME: folder },
    });
    expect(ran.stderr).toContain(`the settings' modules name "helath", of a module this checkout does not have, so it switches nothing here`);
    expect(ran.stderr).not.toMatch(/^\s+at .*:\d+:\d+/m);
    expect(ran.status).toBe(0);
  });
});

describe("a folder named on the command line", () => {
  const run = (file: string, args: string[]) =>
    spawnSync(process.execPath, ["--no-warnings", join(REPO, file), ...args], {
      cwd: folder,
      encoding: "utf8",
      input: "",
      timeout: 60_000,
      env: { LIFE_ARCHIVE_URL: "http://127.0.0.1:1", PATH: "", HOME: folder },
    });
  const made = () => {
    const own = mkdtempSync(join(folder, "own-"));
    writeFileSync(join(own, "settings.json"), JSON.stringify({ timeZone: "Asia/Tokyo", phoneCountry: "44" }));
    return own;
  };
  const CLI = "server/archive/cli.ts";

  it("is the folder whose settings the archive's CLI reads, and a file it cannot use there stops it", () => {
    const own = made();
    expect(run(CLI, ["people", "--data", own]).status).toBe(0);
    const archive = new DatabaseSync(join(own, "modules", "friend-map", "archive.sqlite"), { readOnly: true });
    expect(archive.prepare("SELECT value FROM meta WHERE key = 'time_zone'").get()).toEqual({ value: "Asia/Tokyo" });
    archive.close();

    writeFileSync(join(own, "settings.json"), JSON.stringify({ timezone: "Asia/Tokyo" }));
    const stopped = run(CLI, ["people", "--data", own]);
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain(join(own, "settings.json"));
  });

  it("reaches the processes the CLI starts: a query's reader reckons in that folder's zone", () => {
    const own = made();
    expect(run(CLI, ["person", "new", "Ada", "Sample", "--why", "a made-up person", "--data", own]).status).toBe(0);
    // 14:00 UTC is 23:00 on the 15th in Tokyo, whichever zone the machine is in.
    const found = (day: string) => run(CLI, ["people", "--query", `SELECT person_id FROM people WHERE day(${Date.parse("2026-01-15T14:00:00Z")}) = '${day}'`, "--data", own]).stdout;
    expect(found("2026-01-15")).toContain("Ada Sample");
    expect(found("2026-01-16")).not.toContain("Ada Sample");
  });

  it("is the folder whose settings check-data reads", () => {
    const own = made();
    writeFileSync(join(own, "settings.json"), JSON.stringify({ timezone: "Asia/Tokyo" }));
    const stopped = run("server/check-data.ts", [own]);
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain(join(own, "settings.json"));
  });
});
