// friend-map's page's own small API (pageApi.ts), through the module's route under the page's path (/friend-map/api),
// over the page's folder in a made-up archive's folder (modules/friend-map/page/), which a new folder does not have
// until the first write makes it. friend-map-frontend's server had its own tests of these files; this is the module's.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestArchive, type TestArchive } from "../../testing/archive.ts";
import { archiveHandler } from "../../testing/routes.ts";
import friendMap from "../../module.ts";
import { pageFolder } from "./savedSettingsPlugin.ts";

let dataDir: string;
let archive: TestArchive;
let server: Server;
let base: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-page-api-"));
  archive = await openTestArchive(dataDir);
  const handler = archiveHandler(archive);
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/friend-map/api`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  archive.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** A write as the page sends it: from its own origin. */
const fromPage = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });

describe("the page's own API, on a new archive's folder", () => {
  it("records a visit, making the page's folder with its first line", async () => {
    const res = await fetch(`${base}/usage`, fromPage("POST", { view: "spider", opened: Date.now() - 5000, seconds: 5 }));
    expect(res.status).toBe(204);
    const lines = (await readFile(join(pageFolder(dataDir), "usage.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ view: "spider", seconds: 5 })]);
    expect((await fetch(`${base}/usage`, fromPage("POST", { view: "../x", opened: Date.now(), seconds: 1 }))).status).toBe(400);
    // A form another site posts, with no preflight, is refused, and nothing is added.
    const crossSite = { method: "POST", headers: { "content-type": "text/plain", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ view: "spider", opened: Date.now(), seconds: 1 }) };
    expect((await fetch(`${base}/usage`, crossSite)).status).toBe(403);
    expect((await readFile(join(pageFolder(dataDir), "usage.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("saves the view settings, and gives them back; the settings with every default filled", async () => {
    expect(await (await fetch(`${base}/view-settings`)).json()).toEqual({ settings: {} });
    const saved = await fetch(`${base}/view-settings`, fromPage("PUT", { names: "full", "web.shadow": "off" }));
    expect(saved.status).toBe(200);
    expect(await (await fetch(`${base}/view-settings`)).json()).toEqual({ settings: { names: "full", "web.shadow": "off" } });
    // Another site's page may not write them.
    expect((await fetch(`${base}/view-settings`, { ...fromPage("PUT", { names: "first" }), headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" } })).status).toBe(403);
    const settings = (await (await fetch(`${base}/settings`)).json()) as { problems: string[] };
    expect(settings.problems).toEqual([]);
    expect(await (await fetch(`${base}/me`)).json()).toEqual({ photo: null });
    expect((await fetch(`${base}/me/photo`)).status).toBe(404);
  });

  it("serves the page the view settings its PUT saved, from the same folder", async () => {
    expect((await fetch(`${base}/view-settings`, fromPage("PUT", { names: "first" }))).status).toBe(200);
    // The module's page plugins, given the archive's folder as the core gives them (and the demo build).
    const [plugin] = friendMap.page!.plugins!(dataDir);
    const transform = (plugin as Plugin).transformIndexHtml as unknown as (html: string, context: { server?: unknown }) => Promise<Array<{ attrs: Record<string, string>; children: string }>>;
    const [script] = await transform("", { server: {} });
    expect(script!.attrs.id).toBe("friend-map-saved-settings");
    expect(JSON.parse(script!.children)).toEqual({ names: "first", "web.shadow": "off" });
  });
});
