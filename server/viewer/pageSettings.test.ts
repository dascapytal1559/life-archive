import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "../jsonApi.ts";
import { archiveServer } from "../archive/server.ts";
import { SETTINGS_API, type PageSettings } from "../../viewer/wire.ts";
import { pageSettingsRoute } from "./pageSettings.ts";

const SETTINGS: PageSettings = {
  timeZone: "Asia/Tokyo", locale: "en-AU",
  modules: { health: false, garden: true }, moduleSettings: { garden: { url: "https://garden.example/" } },
};

describe("GET /life-archive/api/settings", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    const context = await Effect.runPromise(Effect.context<never>());
    const unavailable = () => {
      throw new Error("not this route");
    };
    server = archiveServer({
      hosts: [],
      viewer: { api: unavailable, page: unavailable, settings: serve(context, pageSettingsRoute(SETTINGS)) },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("answers what the page opens on, with no archive behind it", async () => {
    const res = await fetch(`${origin}${SETTINGS_API}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SETTINGS);
  });

  it("only reads, and only for its own page", async () => {
    expect((await fetch(`${origin}${SETTINGS_API}`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${origin}${SETTINGS_API}`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });
});
