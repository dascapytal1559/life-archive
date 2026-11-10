// The main preview at /life-archive/main (mainPreview.ts), served by the archive's door over a made-up build: a page
// saying none is built before the first, then the console's page for its addresses, the demo's files under _site, a
// folder's page at its address with a slash, the nearest 404.html for the rest, nothing outside the build, no change,
// and headers that let the page load nothing outside the preview's path.

import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Context } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archiveServer } from "./archive/server.ts";
import { serve, sendJson } from "./jsonApi.ts";
import { CURRENT, MAIN_PREVIEW_PATH, NOT_BUILT, mainPreviewRoute } from "./mainPreview.ts";

let root: string;
let server: Server;
let port: number;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-main-preview-"));
  // A secret beside the preview's folder, which no path under the preview may reach.
  await writeFile(join(root, "secret.txt"), "not the preview's");
  server = archiveServer({
    hosts: ["mac.tailnet.example"],
    viewer: {
      api: async (req, res) => sendJson(res, 200, { api: req.url }),
      page: (req, res) => sendJson(res, 200, { page: req.url }),
      mainPreview: serve(Context.empty(), mainPreviewRoute(join(root, "main-preview"))),
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

interface Answer {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function ask(path: string, { method = "GET", host = `localhost:${port}` }: { method?: string; host?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const out = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    out.on("error", reject);
    out.end();
  });
}

async function put(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

describe("the main preview", () => {
  it("says no preview is built yet before the first build", async () => {
    const answer = await ask(MAIN_PREVIEW_PATH);
    expect(answer.status).toBe(404);
    expect(answer.body).toBe(NOT_BUILT);
    expect(answer.headers["content-type"]).toMatch(/text\/html/);
  });

  it("serves the build its link points at: the console's page at its addresses, the demo's files under _site", async () => {
    const build = join(root, "main-preview", "builds", "one");
    await put(join(build, "life-archive", "index.html"), "console page");
    await put(join(build, "life-archive", "404.html"), "console page");
    await put(join(build, "life-archive", "assets", "app-abc123.js"), "code");
    await put(join(build, "friend-map", "index.html"), "friend-map page");
    await put(join(build, "friend-map", "404.html"), "friend-map page");
    await put(join(build, "demo-data", "answers", "00000000000001.json"), '{"status":200,"body":1}');
    await put(join(build, "404.html"), "not in the demo");
    await put(join(build, "index.html"), "the demo's root page");
    await symlink(join("builds", "one"), join(root, "main-preview", CURRENT));

    for (const path of [MAIN_PREVIEW_PATH, `${MAIN_PREVIEW_PATH}/`, `${MAIN_PREVIEW_PATH}/events`, `${MAIN_PREVIEW_PATH}/friend-map/messages?q=1`]) {
      expect(await ask(path), path).toMatchObject({ status: 200, body: "console page" });
    }
    const code = await ask(`${MAIN_PREVIEW_PATH}/_site/life-archive/assets/app-abc123.js`);
    expect(code).toMatchObject({ status: 200, body: "code" });
    expect(code.headers["content-type"]).toMatch(/javascript/);
    expect(code.headers["cache-control"]).toMatch(/immutable/);
    expect(await ask(`${MAIN_PREVIEW_PATH}/_site/demo-data/answers/00000000000001.json`)).toMatchObject({ status: 200, body: '{"status":200,"body":1}' });
    expect(await ask(`${MAIN_PREVIEW_PATH}/_site/friend-map`)).toMatchObject({ status: 308, headers: { location: `${MAIN_PREVIEW_PATH}/_site/friend-map/` } });
    expect(await ask(`${MAIN_PREVIEW_PATH}/_site/friend-map/`)).toMatchObject({ status: 200, body: "friend-map page" });
    // The build's own root is a folder too: its page at _site/, so what it loads by a relative path is found under it.
    expect(await ask(`${MAIN_PREVIEW_PATH}/_site`)).toMatchObject({ status: 308, headers: { location: `${MAIN_PREVIEW_PATH}/_site/` } });
    expect(await ask(`${MAIN_PREVIEW_PATH}/_site/`)).toMatchObject({ status: 200, body: "the demo's root page" });
    // friend-map's own addresses are its page, as Pages answers them (its 404.html), and so is a question the demo lacks.
    expect(await ask(`${MAIN_PREVIEW_PATH}/_site/friend-map/spider`)).toMatchObject({ status: 404, body: "friend-map page" });
    expect(await ask(`${MAIN_PREVIEW_PATH}/_site/nothing/here`)).toMatchObject({ status: 404, body: "not in the demo" });
    // The archive's own routes are not the preview's.
    expect(await ask("/life-archive/api/settings")).toMatchObject({ status: 200, body: '{"api":"/life-archive/api/settings"}' });
    expect(await ask("/life-archive/mainly")).toMatchObject({ status: 200, body: '{"page":"/life-archive/mainly"}' });
  });

  it("lets its pages load nothing outside its path, on the host they were opened at", async () => {
    const answer = await ask(`${MAIN_PREVIEW_PATH}/events`, { host: "mac.tailnet.example" });
    const csp = String(answer.headers["content-security-policy"]);
    for (const directive of ["default-src", "script-src", "connect-src", "img-src", "frame-src", "worker-src"]) {
      expect(csp).toContain(`${directive} mac.tailnet.example${MAIN_PREVIEW_PATH}/`);
    }
    // Who may frame it is matched by origin alone (the console frames friend-map's page); it loads nothing by it.
    expect(csp.match(/'self'/g)).toEqual(["'self'"]);
    expect(csp).toContain("frame-ancestors 'self'");
    expect(answer.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer.headers["cache-control"]).toBe("no-cache");
  });

  it("reaches nothing outside its build, and changes nothing", async () => {
    for (const path of [`${MAIN_PREVIEW_PATH}/_site/../../../secret.txt`, `${MAIN_PREVIEW_PATH}/_site/%2e%2e/%2e%2e/%2e%2e/secret.txt`, `${MAIN_PREVIEW_PATH}/_site/..%2f..%2f..%2fsecret.txt`]) {
      const answer = await ask(path);
      expect(answer.body, path).not.toContain("not the preview's");
    }
    expect(await ask(`${MAIN_PREVIEW_PATH}/_site/%E0%A4%A`)).toMatchObject({ status: 400 });
    expect(await ask(`${MAIN_PREVIEW_PATH}/_site/friend-map%00.html`)).toMatchObject({ status: 400 });
    expect(await ask(`${MAIN_PREVIEW_PATH}/events`, { method: "POST" })).toMatchObject({ status: 405 });
    expect(await ask(`${MAIN_PREVIEW_PATH}/events`, { method: "HEAD" })).toMatchObject({ status: 200, body: "" });
  });
});
