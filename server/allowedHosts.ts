// Which Host names, besides localhost, may reach the server: FRIEND_MAP_ALLOWED_HOSTS, a comma-separated
// list of exact names (the Mac's Tailscale name, so Tailscale Serve can reach it from the phone).
// Vite reads the list (vite.config.ts) and server/main.ts gates every request and websocket upgrade with
// it before anything handles them, which keeps DNS-rebinding pages off the page and the API alike
// (see docs/console.md: the page on the tailnet).

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { envSetting } from "./dataHome.ts";

export function allowedHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");
}

/** The names the server admits besides localhost, as it reads them as it starts: LIFE_ARCHIVE_ALLOWED_HOSTS, then FRIEND_MAP_ALLOWED_HOSTS (its old name). */
export function admittedHosts(): string[] {
  return [...allowedHosts(envSetting("LIFE_ARCHIVE_ALLOWED_HOSTS")), ...allowedHosts(envSetting("FRIEND_MAP_ALLOWED_HOSTS"))];
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// A Host header (name, optionally with a port) is allowed when its name is localhost, 127.0.0.1, [::1]
// or exactly one of the extra names. No Host at all is refused: every browser sends one.
export function hostAllowed(host: string | undefined, extra: readonly string[]): boolean {
  const name = host?.trim().toLowerCase().replace(/:\d*$/, "");
  if (!name) return false;
  return LOCAL_HOSTS.has(name) || extra.includes(name);
}

// Refuses, with 403, every request and websocket upgrade whose Host is not allowed, before any listener
// on the server sees it (the API, the media routes, Vite's page and its hot-reload websocket).
export function guardHosts(server: Server, extra: readonly string[]): void {
  const emit = server.emit.bind(server) as (event: string | symbol, ...args: unknown[]) => boolean;
  server.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === "request" || event === "upgrade") {
      const req = args[0] as IncomingMessage;
      if (!hostAllowed(req.headers.host, extra)) {
        if (event === "request") {
          const res = args[1] as ServerResponse;
          res.writeHead(403, { "content-type": "text/plain" }).end("This Host is not allowed.\n");
        } else {
          (args[1] as Duplex).end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        }
        return true;
      }
    }
    return emit(event, ...args);
  }) as Server["emit"];
}
