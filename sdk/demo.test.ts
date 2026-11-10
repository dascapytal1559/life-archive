// The demo's backend in the page (demo.ts): how a question is keyed and filed, what the page's fetch answers (a change
// refused, a live route, a route error with its status, a recorded answer, a file at its own path, nothing), and the
// page's SQLite as node:sqlite has it for the server's code.

import initSqlJs from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../server/errors.ts";
import { answerFile, answerKey, DEMO_DATA, DemoDatabase, installDemoBackend, NOT_IN_DEMO, READ_ONLY, type LiveRoute } from "./demo.ts";

describe("a question's key and file", () => {
  it("is the same however its query is written", () => {
    const a = answerKey("get", new URL("http://x/friend-map/api/archive/people?tag=b&tag=a&q=1"));
    expect(a).toBe("GET /friend-map/api/archive/people?q=1&tag=a&tag=b");
    expect(answerKey("GET", new URL("http://x/friend-map/api/archive/people?q=1&tag=b&tag=a"))).toBe(a);
    expect(answerFile(a)).toMatch(/^answers\/[0-9a-f]{14}\.json$/);
    expect(answerFile(a)).toBe(answerFile(a));
    expect(answerFile(a)).not.toBe(answerFile("GET /friend-map/api/archive/people"));
  });
});

describe("the page's fetch in the demo", () => {
  const files = new Map<string, Response>();
  beforeEach(() => {
    files.clear();
    vi.stubGlobal("location", new URL("http://demo.invalid/life-archive/"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "http://demo.invalid");
      return files.get(url.pathname)?.clone() ?? new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const routes: LiveRoute[] = [
    { matches: (url) => url.pathname === "/life-archive/api/live", answer: async (url) => ({ live: url.searchParams.get("n") }) },
    { matches: (url) => url.pathname === "/life-archive/api/gone", answer: async () => { throw new NotFoundError("no such thing"); } },
    { matches: (url) => url.pathname === "/life-archive/api/kept", answer: async () => undefined },
  ];
  const json = async (response: Response) => [response.status, await response.json()];

  it("refuses every change, answers live routes and their errors, then what was recorded, then files, then nothing", async () => {
    installDemoBackend(() => routes, async () => { throw new Error("no database is opened"); });
    files.set(`${DEMO_DATA}/${answerFile("GET /life-archive/api/kept")}`, Response.json({ status: 200, body: { kept: true } }));
    files.set(`${DEMO_DATA}/${answerFile("GET /life-archive/api/missing?id=1")}`, Response.json({ status: 409, body: { error: "recorded refusal" } }));
    files.set("/life-archive/api/m/exercise/map/a/1/0/0.mvt", new Response("tile", { headers: { "content-type": "application/octet-stream" } }));
    files.set("/life-archive/assets/app.js", new Response("code"));
    expect(await json(await fetch("/friend-map/api/archive/people/1/note", { method: "PUT", body: "{}" }))).toEqual([403, { error: READ_ONLY }]);
    expect(await json(await fetch("/life-archive/api/live?n=2"))).toEqual([200, { live: "2" }]);
    expect(await json(await fetch("/life-archive/api/gone"))).toEqual([404, { error: "no such thing" }]);
    expect(await json(await fetch("/life-archive/api/kept"))).toEqual([200, { kept: true }]);
    expect(await json(await fetch("/life-archive/api/missing?id=1"))).toEqual([409, { error: "recorded refusal" }]);
    expect(await (await fetch("/life-archive/api/m/exercise/map/a/1/0/0.mvt")).text()).toBe("tile");
    expect(await json(await fetch("/life-archive/api/nothing"))).toEqual([404, { error: NOT_IN_DEMO }]);
    // The page's own files are fetched as they were, whatever they are.
    expect(await (await fetch("/life-archive/assets/app.js")).text()).toBe("code");
  });
});

describe("the page's SQLite", () => {
  it("binds, returns and calls as node:sqlite does for the server's code", async () => {
    const SQL = await initSqlJs();
    const db = new DemoDatabase(new SQL.Database()).sync;
    db.exec("CREATE TABLE t (id INTEGER, name TEXT); INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, NULL)");
    db.function("twice", { deterministic: true }, (n) => Number(n) * 2);
    expect(db.prepare("SELECT id, twice(id) AS t FROM t WHERE id > ? ORDER BY id").all(1)).toEqual([{ id: 2, t: 4 }, { id: 3, t: 6 }]);
    expect(db.prepare("SELECT name FROM t WHERE id = :id").get({ id: 2 })).toEqual({ name: "b" });
    expect(db.prepare("SELECT name FROM t WHERE id = ?").get(9)).toBeUndefined();
    const arrays = db.prepare("SELECT id, name FROM t ORDER BY id");
    arrays.setReturnArrays(true);
    expect(arrays.all()).toEqual([[1, "a"], [2, "b"], [3, null]]);
    expect(db.prepare("SELECT '[4,5]' ->> 1 AS v").get()).toEqual({ v: 5 });
  });
});
