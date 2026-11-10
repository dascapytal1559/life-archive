// The module loader (loader.ts), on made-up modules in a temporary checkout: which folders are modules, the switches
// in the settings, a module broken by its id or SDK major, the services and privacy lines gathered, and the routes
// at MODULES_API/<id>, through the door (archive/server.ts) as the server mounts them.

import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Option } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODULES_API } from "../../viewer/wire.ts";
import { archiveServer } from "../archive/server.ts";
import type { RouteError } from "../errors.ts";
import { sendJson, serve, type Route } from "../jsonApi.ts";
import { RunsByHand } from "./services.ts";
import { installedModules, installedPrivacy, loadModules, moduleOf, modulePrivacy, moduleRoutes, moduleServices, modulesLine, moduleSwitches, readyModules, TRACKED_MODULES_ONLY, trackedModules, type Modules } from "./loader.ts";

const SDK = new URL("../../sdk/server.ts", import.meta.url).href;

/** A made-up module's module.ts: `id` and `sdk` as given, answering {module: id, path} at its routes, offering one run by hand. */
const moduleSource = (id: string, sdk = 1) => `
import { defineModule, Effect, Layer, RunsByHand, sendJson } from ${JSON.stringify(SDK)};
export default defineModule({
  id: ${JSON.stringify(id)},
  sdk: ${sdk},
  routes: ({ folder }) => (req, res) => Effect.sync(() => sendJson(res, 200, { module: ${JSON.stringify(id)}, path: new URL(req.url ?? "/", "http://localhost").pathname, folder })),
  services: () => Layer.succeed(RunsByHand, { runs: Effect.succeed([{ start: "2026-01-02T07:00", sport: "Running", device: "Polar H10", trusted: true, duration: "30:00", distanceMi: 3, avgHr: 150, maxHr: 170, minHr: 100, source: "made up" }]) }),
  fixtures: { what: "a made-up ${id}", write: async () => {} },
  privacy: { content: ["the ${id} module's content line"], metadata: ["the ${id} module's metadata line"] },
});
`;

let root: string;
let modules: Modules;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-modules-"));
  const write = async (id: string, files: Record<string, string>) => {
    await mkdir(join(root, "modules", id), { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(root, "modules", id, name), text);
  };
  const manifest = JSON.stringify({ name: "made-up", private: true, lifeArchive: true });
  await write("sample", { "package.json": manifest, "module.ts": moduleSource("sample") });
  await write("quiet", { "package.json": manifest, "module.ts": moduleSource("quiet") });
  await write("misnamed", { "package.json": manifest, "module.ts": moduleSource("other") });
  await write("newer", { "package.json": manifest, "module.ts": moduleSource("newer", 2) });
  await write("unloadable", { "package.json": manifest, "module.ts": "import { nothing } from './missing.ts';\nexport default nothing;\n" });
  await write("plain", { "package.json": JSON.stringify({ name: "not-a-module" }), "module.ts": moduleSource("plain") });
  await write("garbled", { "package.json": "{ not json", "module.ts": moduleSource("garbled") });
  await write("folder", { "README.md": "a folder with no package.json" });
  await symlink(join(root, "modules", "sample"), join(root, "modules", "linked"));
  modules = await loadModules({ root, switches: { quiet: false } });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("finding the modules", () => {
  it("is every folder under modules/ whose package.json says lifeArchive or cannot be read, by id, in order, and no link to one", () => {
    expect(installedModules(root).map((m) => m.id)).toEqual(["folder", "garbled", "misnamed", "newer", "quiet", "sample", "unloadable"]);
    expect(installedModules(join(root, "nowhere"))).toEqual([]);
  });

  it("installs those git tracks alone when the environment asks (the demo's build), and fails closed where git cannot say", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "life-archive-tracked-"));
    try {
      const manifest = JSON.stringify({ name: "made-up", private: true, lifeArchive: true });
      for (const id of ["shipped", "private-one"]) {
        await mkdir(join(checkout, "modules", id), { recursive: true });
        await writeFile(join(checkout, "modules", id, "package.json"), manifest);
      }
      expect(() => installedModules(checkout, { [TRACKED_MODULES_ONLY]: "1" })).toThrow();
      execFileSync("git", ["init", "-q"], { cwd: checkout });
      execFileSync("git", ["add", "modules/shipped/package.json"], { cwd: checkout });
      expect([...trackedModules(checkout)]).toEqual(["shipped"]);
      expect(installedModules(checkout, {}).map((m) => m.id)).toEqual(["private-one", "shipped"]);
      expect(installedModules(checkout, { [TRACKED_MODULES_ONLY]: "1" }).map((m) => m.id)).toEqual(["shipped"]);
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it("loads those the switches leave on, lists one switched off, and marks one broken by its manifest, its id, its SDK or its import", () => {
    expect(modules.on.map((m) => m.id)).toEqual(["sample"]);
    expect(modules.off.map((m) => m.id)).toEqual(["quiet"]);
    expect(modules.broken.map((m) => [m.id, m.problem])).toEqual([
      ["folder", expect.stringMatching(/folder\/package\.json could not be read/)],
      ["garbled", expect.stringMatching(/garbled\/package\.json could not be read/)],
      ["misnamed", expect.stringMatching(/says it is module "other", but its folder is misnamed/)],
      ["newer", expect.stringMatching(/written for SDK 2, and this life archive's SDK is 1/)],
      ["unloadable", expect.stringMatching(/could not be loaded/)],
    ]);
    expect(modules.on[0]!.definition).toMatchObject({ id: "sample", sdk: 1 });
    const [folder, garbled, misnamed, newer, unloadable] = modules.broken.map((m) => m.problem);
    expect(modulesLine(modules)).toBe(`Modules on: sample; off: quiet; broken: folder (${folder}); garbled (${garbled}); misnamed (${misnamed}); newer (${newer}); unloadable (${unloadable})`);
  });

  it("gives the installed modules' privacy lines, or `only` those named, and refuses while any wanted one is broken", async () => {
    // A module broken has lines nobody can read: what counts them (the guard's review) must not go on without them.
    const refused = installedPrivacy({ root });
    await expect(refused).rejects.toThrow(/the privacy lines of 5 modules could not be read, so nothing that counts them can go on: folder \(.*\); garbled \(.*\); misnamed \(.*\); newer \(.*\); unloadable \(/);
    expect((await installedPrivacy({ root, only: new Set(["sample", "quiet"]) })).flatMap((m) => m.content)).toEqual(["the quiet module's content line", "the sample module's content line"]);
    await expect(installedPrivacy({ root, only: new Set(["sample", "unloadable"]) })).rejects.toThrow(/the privacy lines of a module could not be read.*unloadable/);
  });

  it("loads every installed one with `all`, switched off or not", async () => {
    const all = await loadModules({ root, switches: { quiet: false }, all: true });
    expect(all.on.map((m) => m.id)).toEqual(["quiet", "sample"]);
    expect(all.off).toEqual([]);
  });

  it("says so of a switch naming no installed module, which switches nothing, and loads the rest as they are", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const loaded = await loadModules({ root, switches: { helath: false, quiet: false } });
      expect(loaded.on.map((m) => m.id)).toEqual(["sample"]);
      expect(loaded.off.map((m) => m.id)).toEqual(["quiet"]);
      expect(said).toHaveBeenCalledWith(expect.stringMatching(/^the settings' modules name "helath", of a module this checkout does not have, so it switches nothing here \(the installed modules are folder, garbled, misnamed, newer, quiet, sample, unloadable/));
    } finally {
      said.mockRestore();
    }
  });

  it("takes a switch naming a module whose manifest cannot be read: it is installed, though broken", async () => {
    expect((await loadModules({ root, switches: { garbled: false } })).off.map((m) => m.id)).toEqual(["garbled"]);
  });

  it("leaves an unfinished module off unless switched on by name or every page is asked for, and a private one on (src/pages.ts)", async () => {
    const marked = await mkdtemp(join(tmpdir(), "life-archive-ready-"));
    try {
      const write = async (id: string, ready?: boolean) => {
        await mkdir(join(marked, "modules", id), { recursive: true });
        await writeFile(join(marked, "modules", id, "package.json"), JSON.stringify({ name: "made-up", lifeArchive: true, ...(ready === undefined ? {} : { lifeArchiveReady: ready }) }));
        await writeFile(join(marked, "modules", id, "module.ts"), moduleSource(id));
      };
      await write("finished", true);
      await write("unfinished", false);
      await write("own");
      const ids = async (options: Parameters<typeof loadModules>[0]) => {
        const { on, off } = await loadModules({ root: marked, ...options });
        return { on: on.map((m) => m.id), off: off.map((m) => m.id) };
      };
      expect(await ids({})).toEqual({ on: ["finished", "own"], off: ["unfinished"] });
      expect(await ids({ switches: { unfinished: true } })).toEqual({ on: ["finished", "own", "unfinished"], off: [] });
      expect(await ids({ pages: "all" })).toEqual({ on: ["finished", "own", "unfinished"], off: [] });
      expect(await ids({ pages: "all", switches: { unfinished: false, finished: false } })).toEqual({ on: ["own"], off: ["finished", "unfinished"] });
    } finally {
      await rm(marked, { recursive: true, force: true });
    }
  });

  it("tells the page each module's switch: on, or off for one switched off or broken", () => {
    expect(moduleSwitches(modules)).toEqual({ sample: true, quiet: false, folder: false, garbled: false, misnamed: false, newer: false, unloadable: false });
  });

  it("gathers the loaded modules' services into one Layer, and their privacy lines", async () => {
    const ready = (loaded: Modules) => readyModules({ ...loaded, on: loaded.on.map((m) => ({ ...m, db: null, takenOver: false })) }, root, new Error("no archive in this test"));
    const runs = await Effect.runPromise(
      Effect.gen(function* () {
        const found = yield* Effect.serviceOption(RunsByHand);
        return Option.isSome(found) ? yield* found.value.runs : null;
      }).pipe(Effect.provide(moduleServices(ready(modules)))),
    );
    expect(runs).toMatchObject([{ device: "Polar H10", maxHr: 170 }]);
    expect(await Effect.runPromise(Effect.serviceOption(RunsByHand).pipe(Effect.map(Option.isSome), Effect.provide(moduleServices(ready({ on: [], off: [], broken: [] })))))).toBe(false);
    expect(modulePrivacy(modules)).toEqual([{ content: ["the sample module's content line"], metadata: ["the sample module's metadata line"] }]);
  });

  it("gives a module the archive's calendar and live connectors, which throw the archive's error while it is not open", () => {
    const [sample] = readyModules({ ...modules, on: modules.on.map((m) => ({ ...m, db: null, takenOver: false })) }, root, new Error("could not open it"));
    expect(sample.context.folder).toBe(root);
    expect(() => sample.context.calendar.forget([])).toThrow("the archive is not available: could not open it");
    expect(() => sample.context.pausingLive([], async () => undefined)).toThrow("the archive is not available: could not open it");
  });
});

describe("the modules' routes", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const context = { folder: root };
    // The SDK's services, as the server's Layer gives a module's route them: stand-ins here.
    const services = Context.empty();
    const handlers = new Map(modules.on.map((m) => [m.id, serve(services, m.definition.routes!(context) as Route<RouteError, never>)] as const));
    server = archiveServer({
      hosts: ["mac.tailnet.example"],
      viewer: {
        api: async (_req, res) => sendJson(res, 200, { viewer: true }),
        page: (_req, res) => void sendJson(res, 200, { page: true }),
        modules: moduleRoutes(handlers),
        // A path outside MODULES_API the sample module mounts its route at (sdk/server.ts's `mounts`).
        mounts: [{ path: "/elsewhere", handler: handlers.get("sample")! }],
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            // The Host guard answers in words.
          }
          resolve({ status: res.statusCode!, body });
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("names the module a path asks for", () => {
    expect(MODULES_API).toBe("/life-archive/api/m");
    expect(moduleOf("/life-archive/api/m/sample")).toBe("sample");
    expect(moduleOf("/life-archive/api/m/sample/deeper/still")).toBe("sample");
    expect(moduleOf("/life-archive/api/m/")).toBe("");
    expect(moduleOf("/life-archive/api/kinds")).toBe("");
  });

  it("answers a module's routes at /life-archive/api/m/<id> and under it, with the archive's folder, beside the viewer's read API", async () => {
    expect(await get("/life-archive/api/m/sample")).toEqual({ status: 200, body: { module: "sample", path: "/life-archive/api/m/sample", folder: root } });
    expect((await get("/life-archive/api/m/sample/deeper?x=1")).body).toMatchObject({ module: "sample", path: "/life-archive/api/m/sample/deeper" });
    expect((await get("/life-archive/api/kinds")).body).toEqual({ viewer: true });
    // At a path it mounts, the request whole; any other path outside them is none of the modules'.
    expect((await get("/elsewhere/x")).body).toMatchObject({ module: "sample", path: "/elsewhere/x" });
    expect((await get("/api/archive/people")).status).toBe(404);
  });

  it("answers 404 for a module switched off, and for one there is none of", async () => {
    expect(await get("/life-archive/api/m/quiet")).toEqual({ status: 404, body: { error: "no module quiet answers here" } });
    const none = await get("/life-archive/api/m/nothing/here");
    expect(none.status).toBe(404);
    expect((none.body as { error: string }).error).toMatch(/no module nothing answers here/);
    expect((await get("/life-archive/api/m/")).status).toBe(404);
  });

  it("is behind the door's Host guard, as every route is", async () => {
    expect((await get("/life-archive/api/m/sample", { host: "mac.tailnet.example" })).status).toBe(200);
    expect((await get("/life-archive/api/m/sample", { host: "rebound.example" })).status).toBe(403);
  });
});
