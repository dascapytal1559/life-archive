// The demo's backend in a page built for a mount (demo.ts, viewer/mount.ts: the main preview at /life-archive/main):
// its routes asked under the demo's site and looked up at the server's own paths, its data fetched under the site, a
// route asked at the server's own path answered all the same (never fetched of the server the preview is served by),
// and its storage kept apart from the console that shares its origin.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MOUNT = "/life-archive/main";
const SITE = `${MOUNT}/_site`;

describe("the page's fetch in a mounted demo", () => {
  const fetched: string[] = [];
  const files = new Map<string, Response>();
  const kept = new Map<string, string>();
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("LIFE_ARCHIVE_MOUNT", MOUNT);
    fetched.length = 0;
    files.clear();
    kept.clear();
    vi.stubGlobal("location", new URL(`http://mac.invalid${MOUNT}/events`));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "http://mac.invalid");
      fetched.push(url.pathname);
      return files.get(url.pathname)?.clone() ?? new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("localStorage", {
      get length() {
        return kept.size;
      },
      key: (i: number) => [...kept.keys()][i] ?? null,
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
      clear: () => kept.clear(),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("asks its routes on the demo's site, looks them up at the server's paths, and never asks the server", async () => {
    const { answerFile, DEMO_DATA, installDemoBackend } = await import("./demo.ts");
    const { API_BASE } = await import("../viewer/wire.ts");
    const { CONSOLE_PATH } = await import("../viewer/console/address.ts");
    expect(API_BASE).toBe(`${SITE}/life-archive/api`);
    expect(CONSOLE_PATH).toBe(MOUNT);
    const live: string[] = [];
    installDemoBackend(() => [{ matches: (url) => url.pathname === `${API_BASE}/live`, answer: async (url) => (live.push(url.pathname), { live: true }) }], async () => { throw new Error("no database is opened"); });
    files.set(`${SITE}${DEMO_DATA}/${answerFile("GET /life-archive/api/kept?a=1")}`, Response.json({ status: 200, body: { kept: true } }));
    files.set(`${SITE}${DEMO_DATA}/${answerFile("GET /friend-map/api/archive/contract")}`, Response.json({ status: 200, body: { contract: 1 } }));
    files.set(`${SITE}/life-archive/api/m/exercise/map/0/0/0.mvt`, new Response("tile"));

    expect(await (await fetch(`${API_BASE}/live`)).json()).toEqual({ live: true });
    expect(await (await fetch(`${API_BASE}/kept?a=1`)).json()).toEqual({ kept: true });
    expect(await (await fetch(`${SITE}/friend-map/api/archive/contract`)).json()).toEqual({ contract: 1 });
    expect(await (await fetch(`${SITE}/life-archive/api/m/exercise/map/0/0/0.mvt`)).text()).toBe("tile");
    // Asked at the server's own path, it is still the demo's question, answered by the demo.
    expect(await (await fetch("/life-archive/api/live")).json()).toEqual({ live: true });
    expect(await (await fetch("/life-archive/api/kept?a=1")).json()).toEqual({ kept: true });
    expect((await fetch("/life-archive/api/nothing")).status).toBe(404);
    expect(live).toEqual([`${API_BASE}/live`, `${API_BASE}/live`]);
    expect(fetched.filter((path) => !path.startsWith(`${SITE}/`))).toEqual([]);
  });

  it("keeps the page's storage apart from the console that shares its origin", async () => {
    kept.set("life-archive:theme", "light");
    const shared = globalThis.localStorage;
    const { installDemoBackend } = await import("./demo.ts");
    installDemoBackend(() => [], async () => { throw new Error("no database is opened"); });
    expect(localStorage.getItem("life-archive:theme")).toBeNull();
    localStorage.setItem("life-archive:theme", "dark");
    expect(localStorage.getItem("life-archive:theme")).toBe("dark");
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toBe("life-archive:theme");
    expect(shared.getItem("life-archive:theme")).toBe("light");
    localStorage.clear();
    expect(shared.getItem("life-archive:theme")).toBe("light");
    expect(kept.size).toBe(1);
  });
});
