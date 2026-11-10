// A module switched off runs nothing of its own, shown on Shopping (modules/shopping/), a module with work while the
// server runs (its morning pulls), a service, a mount outside its own address and a page: the archive's server (main.ts)
// started on a made-up archive whose one supplier is a stand-in storefront on this machine, once with the module on
// and once off. The archive's zone is one where it is past noon now, so the pull at start is due whenever this runs.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.ts", import.meta.url));

let root: string;
let dataDir: string;
let server: ChildProcess | null;
let storefront: Server;
let asked: string[];
let log: string;

/** A fixed-offset zone where it is 12:00 to 12:59 now: past the morning's 08:00, and far from midnight. */
function zoneAtNoon(): string {
  const hours = 12 - new Date().getUTCHours();
  return hours === 0 ? "Etc/GMT" : `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`;
}

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Resolves once `check` holds, looking every 50 ms for up to 30 s. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}; the server's log:\n${log}`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-module-switch-"));
  dataDir = join(root, "data");
  await mkdir(join(dataDir, "shopping"), { recursive: true });
  // The stand-in storefront: a Shopify collection's feed, with one product marked down.
  asked = [];
  storefront = createHttpServer((req, res) => {
    asked.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ products: [{ title: "veal 600g", handle: "veal", variants: [{ id: 1, price: "26.40", compare_at_price: "33.00", available: true }] }] }));
  });
  await new Promise<void>((resolve) => storefront.listen(0, "127.0.0.1", resolve));
  const shop = `http://127.0.0.1:${(storefront.address() as AddressInfo).port}`;
  await writeFile(join(dataDir, "shopping", "suppliers.json"), JSON.stringify([{ id: "sample-shop", name: "sample butcher", url: `${shop}/collections/specials`, adapter: "shopify", listsSpecials: false }]));
  // `codex` on the server's PATH is the stand-in (fixtures/fake-codex.ts), as main.test.ts has it.
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "codex"));
  await writeFile(join(root, "bin", "codex"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "${join(root, "codex")}" "$@"\n`);
  await chmod(join(root, "bin", "codex"), 0o755);
  server = null;
  log = "";
});

afterEach(async () => {
  server?.kill("SIGKILL");
  await new Promise((resolve) => storefront.close(resolve));
  await rm(root, { recursive: true, force: true });
});

/** The archive's server on the made-up archive with Shopping switched `on`, once it listens: its address. */
async function start(on: boolean): Promise<string> {
  const settings = join(root, "settings.json");
  await writeFile(settings, JSON.stringify({ timeZone: zoneAtNoon(), locale: "en-AU", pages: "all", modules: { shopping: on } }));
  const port = await freePort();
  log = "";
  server = spawn(process.execPath, ["--no-warnings", MAIN], {
    env: { ...process.env, LIFE_ARCHIVE_DATA: dataDir, LIFE_ARCHIVE_SETTINGS: settings, LIFE_ARCHIVE_URL: `http://127.0.0.1:${port}`, PATH: `${join(root, "bin")}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (chunk) => (log += chunk));
  server.stderr!.on("data", (chunk) => (log += chunk));
  await until(() => log.includes("The archive's server running at"), "the server to start");
  return `http://127.0.0.1:${port}`;
}

/** Stops the server with SIGTERM, as launchd does, and waits for it to exit. */
async function stop(): Promise<void> {
  const exited = new Promise((resolve) => server!.once("exit", resolve));
  server!.kill("SIGTERM");
  await exited;
  server = null;
}

const pulls = () => {
  const folder = join(dataDir, "shopping", "pulls");
  return existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".json")) : [];
};

const get = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("a module switched on, then off", { timeout: 90_000 }, () => {
  it("runs Shopping's work, service, routes and page while on, and none of them while off", async () => {
    const on = await start(true);
    // Its work: the pull at start, from the stand-in storefront, kept in the archive's folder.
    await until(() => pulls().length === 1, "the pull at start");
    expect(asked).toEqual(["/collections/specials/products.json?limit=250&page=1"]);
    expect(log).toContain("[shopping] catch-up pull: 1 specials from 1 of 1 suppliers");
    // Its service behind its route, at its mount (the address it had in the core) and at the module's own.
    for (const path of ["/life-archive/api/shopping", "/life-archive/api/m/shopping"]) {
      expect(await get(`${on}${path}`), path).toMatchObject({ status: 200, body: { suppliers: 1, pull: { trigger: "catch-up" } } });
    }
    expect((await get(`${on}/life-archive/api/settings`)).body.modules).toMatchObject({ shopping: true });
    await stop();

    // Today's pull taken away, so the module on would pull again at start.
    await rm(join(dataDir, "shopping", "pulls"), { recursive: true });
    const off = await start(false);
    expect(log).toMatch(/Modules on: .*; off: shopping/);
    // Its routes are gone, and its page with them.
    for (const path of ["/life-archive/api/shopping", "/life-archive/api/m/shopping"]) expect((await get(`${off}${path}`)).status, path).toBe(404);
    expect((await get(`${off}/life-archive/api/settings`)).body.modules).toMatchObject({ shopping: false });
    // Its work too: no pull at start though today has none, and nothing asked of the storefront. A second's grace,
    // for a pull that would start as the server does.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(asked).toHaveLength(1);
    expect(pulls()).toEqual([]);
    await stop();
  });
});
