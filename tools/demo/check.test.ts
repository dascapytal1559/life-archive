// The demo as npm run build:demo builds it (build.ts, here without the network: no map) passes its own check
// (check.ts), and the check stops what must never be published: a name the private dictionary holds, in a recorded
// answer or a copied database ("Zelda Privateer" plays the real person, as in the guard's tests), a real-looking email,
// a file a demo is not made of, and a file the archive's folder holds byte for byte. Also: every page a demo has is
// built, with the answers its pages open with.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerFile, answerKey, databaseFile, DEMO_DATA } from "../../sdk/demo.ts";
import { emptyDictionary } from "../../server/guard/dictionary.ts";
import { PrivacyScanner } from "../../server/guard/scan.ts";
import { buildDemo } from "./build.ts";
import { checkDemo, kindOf } from "./check.ts";

let scratch: string;
let out: string;

const clean = { scanner: new PrivacyScanner(emptyDictionary()), archive: null };
const PLAYS_REAL = "Zelda Privateer";

/** A copy of the built demo to plant things in. */
function copyOfDemo(name: string): string {
  const copy = join(scratch, name);
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(join(copy, DEMO_DATA, "answers"), { recursive: true });
  for (const path of ["_headers", "_redirects", "404.html", `${DEMO_DATA.slice(1)}/answers.json`]) copyFileSync(join(out, path), join(copy, path));
  return copy;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "life-archive-demo-check-"));
  out = join(scratch, "dist-demo");
  // Checked against a folder that is no archive: the test reads nothing of a real one.
  const problems = await Effect.runPromise(buildDemo({ out, network: false, keep: false, log: () => {}, archives: [join(scratch, "no-archive")] }));
  expect(problems).toEqual([]);
}, 300_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the demo's build", () => {
  it("builds the console and friend-map's page over the demo's backend, with the answers they open with", () => {
    for (const page of ["life-archive", "friend-map"]) {
      expect(existsSync(join(out, page, "index.html")), page).toBe(true);
      expect(existsSync(join(out, page, "404.html")), page).toBe(true);
    }
    const keys = JSON.parse(readFileSync(join(out, DEMO_DATA, "answers.json"), "utf8")) as string[];
    for (const path of ["/life-archive/api/settings", "/life-archive/api/kinds", "/friend-map/api/archive/contract", "/friend-map/api/archive/relationships", "/friend-map/api/archive/people"]) {
      const key = answerKey("GET", new URL(path, "http://demo.invalid"));
      expect(keys, path).toContain(key);
      expect(JSON.parse(readFileSync(join(out, DEMO_DATA, answerFile(key)), "utf8")).status, path).toBe(200);
    }
    // The demo's settings: no Shopping (its module is unfinished, so off in a fresh install), so it is not in its rail,
    // and no module's own settings (the modules git tracks tell their pages nothing; a private one is not in the build at all).
    const settings = JSON.parse(readFileSync(join(out, DEMO_DATA, answerFile("GET /life-archive/api/settings")), "utf8")).body;
    expect(settings.modules.shopping).toBe(false);
    expect(settings.moduleSettings).toEqual({});
    for (const name of ["core.sqlite", "calendar.sqlite", "modules/friend-map/archive.sqlite"]) expect(existsSync(join(out, DEMO_DATA, databaseFile(name))), name).toBe(true);
    expect(readFileSync(join(out, "_redirects"), "utf8")).toContain("/life-archive/dev/* /life-archive/index.html 200");
  });
});

describe("the demo's check", () => {
  it("knows a demo's files from anything else", () => {
    expect(kindOf("life-archive/assets/app-1a2b.js")).toBe("page");
    expect(kindOf("friend-map/index.html")).toBe("page");
    expect(kindOf("demo-data/answers/0123456789abcd.json")).toBe("answer");
    expect(kindOf("demo-data/db/core.sqlite.gz")).toBe("database");
    expect(kindOf("life-archive/api/m/exercise/map/sample-city/15/1/2.mvt")).toBe("served");
    for (const path of ["demo-data/db/core.sqlite", "core.sqlite", "life-archive/api/x.sqlite-wal", "life-archive/server.log", "notes.txt", "life-archive/.env.local"]) expect(kindOf(path), path).toBeNull();
  });

  it("passes the demo as built, and stops a name the private dictionary holds wherever it is", async () => {
    expect(await checkDemo(out, clean)).toEqual([]);
    const copy = copyOfDemo("planted");
    writeFileSync(join(copy, DEMO_DATA, answerFile("GET /friend-map/api/archive/people/1")), JSON.stringify({ status: 200, body: { name: PLAYS_REAL } }));
    // And in a copied database: someone's name.
    const db = join(scratch, "archive.sqlite");
    writeFileSync(db, gunzipSync(readFileSync(join(out, DEMO_DATA, databaseFile("modules/friend-map/archive.sqlite")))));
    const archive = new DatabaseSync(db);
    archive.prepare("UPDATE person SET name = ? WHERE id = (SELECT min(id) FROM person)").run(PLAYS_REAL);
    archive.close();
    mkdirSync(join(copy, DEMO_DATA, "db", "modules", "friend-map"), { recursive: true });
    writeFileSync(join(copy, DEMO_DATA, databaseFile("modules/friend-map/archive.sqlite")), gzipSync(readFileSync(db)));
    const dictionary = { ...emptyDictionary(), person_names: [PLAYS_REAL] };
    const problems = await checkDemo(copy, { scanner: new PrivacyScanner(dictionary), archive: null });
    expect(problems.some((p) => p.startsWith(`${DEMO_DATA.slice(1)}/answers/`) && p.endsWith("a real person's name"))).toBe(true);
    expect(problems.some((p) => p.includes("archive.sqlite.gz (table person)") && p.endsWith("a real person's name"))).toBe(true);
    // Without the dictionary the same name is a name like any other.
    expect(await checkDemo(copy, clean)).toEqual([]);
  });

  it("stops a real-looking email, a file a demo is not made of, and a file the archive's folder holds", async () => {
    const copy = copyOfDemo("strays");
    writeFileSync(join(copy, DEMO_DATA, answerFile("GET /life-archive/api/settings")), JSON.stringify({ status: 200, body: { owner: ["ada.sample", "post.zz"].join("@") } }));
    writeFileSync(join(copy, "core.sqlite"), "");
    writeFileSync(join(copy, "server.log"), "");
    const archive = join(scratch, "an-archive");
    mkdirSync(join(archive, "platform-exports"), { recursive: true });
    copyFileSync(join(out, "_headers"), join(archive, "platform-exports", "renamed.bin"));
    const problems = await checkDemo(copy, { ...clean, archive });
    expect(problems.filter((p) => p.endsWith("email address"))).toEqual([`${DEMO_DATA.slice(1)}/${answerFile("GET /life-archive/api/settings")}:1:32: a real-looking email address`]);
    expect(problems).toContain("core.sqlite: not a file a demo is made of");
    expect(problems).toContain("server.log: not a file a demo is made of");
    expect(problems).toContain("_headers: the same bytes as a file in the archive's folder");
  });

  it("takes the demo's own files in the archive's folder for none of the archive's: the build checked, and the main preview's builds", async () => {
    const archive = join(scratch, "an-archive-with-builds");
    const inside = copyOfDemo("an-archive-with-builds/elsewhere/build");
    expect(await checkDemo(inside, { ...clean, archive })).toEqual([]);
    copyOfDemo("an-archive-with-builds/main-preview/builds/served");
    const outside = copyOfDemo("a-new-preview");
    expect((await checkDemo(outside, { ...clean, archive })).sort()).toEqual(
      ["_headers", "_redirects", "404.html", `${DEMO_DATA.slice(1)}/answers.json`].map((path) => `${path}: the same bytes as a file in the archive's folder`).sort(),
    );
    rmSync(inside, { recursive: true, force: true });
    expect(await checkDemo(outside, { ...clean, archive })).toEqual([]);
  });
});
