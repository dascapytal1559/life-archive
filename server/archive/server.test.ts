// The archive's server's door (server.ts), with a stand-in for the archive's routes: only /api/archive/, only to Host
// names it admits, and to friend-map only while friend-map names this archive's folder.

import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARCHIVE_FOLDER_HEADER } from "../dataHome.ts";
import { sendJson } from "../jsonApi.ts";
import { archiveServer } from "./server.ts";

let root: string;
let server: Server;
let port: number;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "friend-map-archive-server-"));
  await mkdir(join(root, "archive"));
  await symlink(join(root, "archive"), join(root, "linked"));
  server = archiveServer({ hosts: ["mac.tailnet.example"], viewer: { api: async (req, res) => sendJson(res, 200, { url: req.url }), page: (req, res) => sendJson(res, 200, { page: req.url }), mounts: [{ path: "/api/archive", handler: async (req, res) => sendJson(res, 200, { url: req.url }) }] } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

/** GET `path` with these headers (Host localhost unless given): the status and the body. */
function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const out = request({ host: "127.0.0.1", port, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body, ...(res.headers.location ? { location: res.headers.location } : {}) }));
    });
    out.on("error", reject);
    out.end();
  });
}

const naming = (folder: string) => ({ [ARCHIVE_FOLDER_HEADER]: encodeURIComponent(folder) });

describe("the archive's server", () => {
  it("answers the archive's routes, and 404 for anything else", async () => {
    expect(await get("/api/archive/people?q=1")).toEqual({ status: 200, body: '{"url":"/api/archive/people?q=1"}' });
    // A mount answers its own path as well as everything under it (Shopping's page asks /life-archive/api/shopping itself).
    expect(await get("/api/archive")).toEqual({ status: 200, body: '{"url":"/api/archive"}' });
    expect((await get("/api/archived")).status).toBe(404);
    expect((await get("/")).status).toBe(302);
    expect((await get("/elsewhere")).status).toBe(404);
    expect((await get("/api/settings")).status).toBe(404);
  });

  it("answers localhost and the names it was given, and refuses any other Host", async () => {
    expect((await get("/api/archive/people", { host: "mac.tailnet.example" })).status).toBe(200);
    expect((await get("/api/archive/people", { host: "rebound.example" })).status).toBe(403);
  });

  it("sends the console's former addresses on to the same place at its address, the query kept", async () => {
    expect(await get("/life-archive/console/health-record/records?row=2&q=a%20b")).toMatchObject({ status: 302, location: "/life-archive/dev/health-record/records?row=2&q=a%20b" });
    expect(await get("/life-archive/console")).toMatchObject({ status: 302, location: "/life-archive/dev" });
    expect(await get("/life-archive/console/")).toMatchObject({ status: 302, location: "/life-archive/dev/" });
    // Only the console's own addresses: a page whose name starts the same is the page's, and so is the console's own,
    // and so are the console's source files, which the page's Vite serves at the same path in development.
    expect(await get("/life-archive/consoles")).toEqual({ status: 200, body: '{"page":"/life-archive/consoles"}' });
    expect(await get("/life-archive/console/Console.tsx")).toEqual({ status: 200, body: '{"page":"/life-archive/console/Console.tsx"}' });
    expect(await get("/life-archive/console/calendar/calendar.css?direct")).toEqual({ status: 200, body: '{"page":"/life-archive/console/calendar/calendar.css?direct"}' });
    expect(await get("/life-archive/console/a/b/c")).toEqual({ status: 200, body: '{"page":"/life-archive/console/a/b/c"}' });
    expect(await get("/life-archive/dev/events")).toEqual({ status: 200, body: '{"page":"/life-archive/dev/events"}' });
  });
});
