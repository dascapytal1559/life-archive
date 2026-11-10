import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowedHosts, guardHosts, hostAllowed } from "./allowedHosts.ts";

describe("allowedHosts", () => {
  it("is empty (localhost only) when unset or blank", () => {
    expect(allowedHosts(undefined)).toEqual([]);
    expect(allowedHosts(" , ")).toEqual([]);
  });

  it("reads exact names from a comma-separated list", () => {
    expect(allowedHosts(" Mac.tail1234.ts.net ,other.example ")).toEqual(["mac.tail1234.ts.net", "other.example"]);
  });
});

describe("hostAllowed", () => {
  const extra = ["mac.tail1234.ts.net"];

  it("lets in localhost, 127.0.0.1 and [::1], with or without a port", () => {
    for (const host of ["localhost", "localhost:4600", "LocalHost:4600", "127.0.0.1", "127.0.0.1:4600", "[::1]", "[::1]:4600"]) {
      expect(hostAllowed(host, extra), host).toBe(true);
    }
  });

  it("lets in the extra names exactly, with or without a port", () => {
    expect(hostAllowed("mac.tail1234.ts.net:8443", extra)).toBe(true);
    expect(hostAllowed("Mac.tail1234.ts.net", extra)).toBe(true);
  });

  it("refuses any other name, a lookalike, another address, or no Host", () => {
    for (const host of ["evil.example", "evil.example:4600", "x.mac.tail1234.ts.net", "mac.tail1234.ts.net.evil.example", "localhost.evil.example", "app.localhost", "192.168.1.5:4600", "[::2]", "", undefined]) {
      expect(hostAllowed(host, extra), String(host)).toBe(false);
    }
  });
});

describe("guardHosts", () => {
  let server: Server;
  let port: number;
  const upgrades: string[] = [];

  beforeEach(async () => {
    upgrades.length = 0;
    server = createServer((req, res) => res.end(`handled ${req.url}`));
    // Stands in for Vite's hot-reload websocket.
    server.on("upgrade", (req, socket) => {
      upgrades.push(req.headers.host ?? "");
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    guardHosts(server, ["mac.tail1234.ts.net"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  function get(path: string, host: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject).end();
    });
  }

  function upgrade(host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/", headers: { host, connection: "Upgrade", upgrade: "websocket" } });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject).end();
    });
  }

  it("refuses API, media and page requests with a foreign Host before any handler sees them", async () => {
    for (const path of ["/api/archive/connectors", "/api/archive/media/1", "/api/usage", "/"]) {
      const res = await get(path, "evil.example:4600");
      expect(res.status, path).toBe(403);
      expect(res.body, path).not.toContain("handled");
    }
  });

  it("passes requests from localhost and an allowed name", async () => {
    expect(await get("/api/archive/connectors", "localhost:4600")).toEqual({ status: 200, body: "handled /api/archive/connectors" });
    expect(await get("/api/archive/connectors", "127.0.0.1:4600")).toEqual({ status: 200, body: "handled /api/archive/connectors" });
    expect(await get("/", "mac.tail1234.ts.net:8443")).toEqual({ status: 200, body: "handled /" });
  });

  it("refuses a websocket upgrade with a foreign Host and passes an allowed one", async () => {
    expect(await upgrade("evil.example:4600")).toBe(403);
    expect(await upgrade("localhost:4600")).toBe(101);
    expect(await upgrade("mac.tail1234.ts.net:8443")).toBe(101);
    expect(upgrades).toEqual(["localhost:4600", "mac.tail1234.ts.net:8443"]);
  });
});
