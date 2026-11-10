// The round's browser, through this Mac (docs/data.md's "Exports from the Cua Space"): a small MCP server the round's Codex
// reaches from the Space as its `cua_driver` tools. Each call goes on to the Space's cua-driver through this Mac's Cua
// (`cua mcp`), so the round's Chrome is this Mac's.
//
// Why: Meta asks for the password again at Start export and at Download, and the Cua Keyvault can fill that box only in
// a browser this Mac's Cua drives. cua-driver gives a browser, its tabs and its session to the connection that launched
// it: a Chrome the round launched with the Space's own driver tools cannot be read or typed into from this Mac ("session
// is not available to this transport"; browser_prepare's "browser_endpoint_owner_mismatch"), and the Keyvault fills
// through this Mac's connection, which every `cua` process here shares through the Cua daemon. So the round launches
// and drives its browser through here, and at Meta's password box it calls request_site_login, which fills the box in
// the round's own tab.
//
// What it lets the round do, and no more: the browser tools of DRIVER_TOOLS, on its own Space, each in the round's one
// session, its Chrome always the export profile, every snapshot of a page semantic (a dom_refs_v1 snapshot's labels can
// carry what was typed into a box, a password the Keyvault filled among them); and request_site_login for a tab on one
// of Meta's origins, which the Keyvault fills only once the captain has approved it (or unlocked that login in Cua), and
// only when the page is on the saved login's exact origin. The password never passes through here: the Keyvault, in
// the Cua daemon, types it into the page through the Space's driver.

import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Context, Data, Effect, Schedule } from "effect";
import { NotFoundError, readJson, type Route, type RouteError, type RunFailed, sendJson, serve } from "../../../../sdk/server.ts";

/** What an MCP tool call gives: its content parts, whether it failed, and its structured result. */
export interface ToolResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  structuredContent?: unknown;
}

/** This Mac's Cua MCP server (`cua mcp`): one of its tools, the Space's driver tools among them through `call_tool`. */
export class HostCua extends Context.Service<HostCua, {
  readonly call: (tool: string, args: Record<string, unknown>) => Effect.Effect<ToolResult, RunFailed>;
}>()("life-archive/HostCua") {}

/** The driver tools a round may use: the browser's, and the window list it binds the browser from. */
export const DRIVER_TOOLS = ["browser_prepare", "list_windows", "get_browser_state", "browser_navigate", "browser_click", "browser_type", "browser_pointer", "browser_dialog"] as const;

/**
 * The origins where Meta asks for the password again (Accounts Center's export pages, Facebook, Instagram, and
 * messenger.com's secure storage): the only pages the Keyvault is asked to fill. The Keyvault then fills only a login
 * saved for the page's exact origin.
 */
export const META_ORIGINS = [
  "https://accountscenter.facebook.com",
  "https://www.facebook.com",
  "https://m.facebook.com",
  "https://accountscenter.instagram.com",
  "https://www.instagram.com",
  "https://www.messenger.com",
] as const;

/** How long one request_site_login call waits for the captain's decision; under Codex's minute for a tool call. */
export const WAIT_SECS = 50;
/**
 * How long a new request is waited on before it is answered pending: a login the captain unlocked in Cua is granted at
 * once, but the Keyvault still answers the call that files it pending, and grants it seconds later without asking.
 */
export const GRANT_SECS = 15;

/** A query no page matches: a snapshot that reads only the page's address and title. */
const NOTHING = "zz-life-archive-nothing-zz";

const PROTOCOL = "2025-06-18";

const INSTRUCTIONS =
  "The Cua driver's browser tools for the export round, through the life archive on the captain's Mac. Every call is " +
  "made in the round's own session (session is set for you), browser_prepare always opens the export Chrome profile, " +
  "and page snapshots are always semantic_v2. request_site_login fills Meta's password box from the captain's Cua " +
  "Keyvault: you never see, type or read the password.";

const SITE_LOGIN_TOOL = {
  name: "request_site_login",
  description:
    "Fill Meta's password box (\"Please re-enter your password\") in a tab of this round's browser with the captain's saved " +
    "password from the Cua Keyvault, and press the form's submit button. You never see or type the password. The tab must be " +
    `on one of Meta's sites (${META_ORIGINS.join(", ")}). The first call files a Keyvault request and answers pending with a ` +
    `request_id, which the captain approves in Cua (until he unlocks that login there). Call again with the request_id: each ` +
    `call waits up to ${WAIT_SECS} seconds for his decision, then fills. It answers filled (submitted says whether it pressed a ` +
    "submit button), pending again, expired (he did not answer within 10 minutes: ask again, without the request_id), or an " +
    "error (no saved login for that site, or he declined).",
  inputSchema: {
    type: "object",
    properties: {
      target_id: { type: "string", description: "The browser target id, from get_browser_state." },
      tab_id: { type: "string", description: "The tab with the password box, from get_browser_state." },
      request_id: { type: "string", description: "The request_id an earlier call gave; absent on the first call." },
    },
    required: ["target_id", "tab_id"],
  },
};

export interface BridgeOptions {
  /** The round's Space. */
  space: string;
  /** The export Chrome profile, the only one browser_prepare opens. */
  profile: string;
  /** The round's driver session: every call is made in it (started again when it has ended), and the Keyvault fills its tabs. */
  session: string;
  /** Who asks, as the Keyvault's approval shows it. */
  agent: string;
  log: (line: string) => void;
}

/** A tool's failure, as the agent sees it. */
const failure = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** A driver tool's arguments as the bridge sends them on: in the round's session, the export profile, semantic snapshots. */
export function driverArgs(tool: string, args: Record<string, unknown>, options: Pick<BridgeOptions, "session" | "profile">): Record<string, unknown> {
  const forced: Record<string, unknown> = { ...args, session: options.session };
  if (tool === "browser_prepare") {
    // Never another process or profile: the export profile's own Chrome, launched or found running.
    delete forced.pid;
    delete forced.window_id;
    delete forced.strategy;
    Object.assign(forced, { allow_launch: true, profile: { mode: "isolated_named", name: options.profile } });
  }
  if (tool === "get_browser_state" && forced.target_id !== undefined) forced.snapshot_format = "semantic_v2";
  return forced;
}

/** The origin of a page's address, or null for one that is not a web page. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** A tool result's status (filled, pending, ok), its refusal's code, or "error". */
function outcome(result: ToolResult): string {
  const structured = result.structuredContent as { status?: unknown; refusal?: { code?: unknown } } | undefined;
  if (typeof structured?.refusal?.code === "string") return structured.refusal.code;
  if (typeof structured?.status === "string") return structured.status;
  if (result.isError) return "error";
  const status = answered(result).status;
  return typeof status === "string" ? status : "ok";
}

/** A tool result's JSON answer (request_site_login's), or nothing when its text is not JSON. */
function answered(result: ToolResult): { status?: unknown; request_id?: unknown } {
  const text = result.content.find((part) => typeof part.text === "string")?.text as string | undefined;
  try {
    const value: unknown = JSON.parse(text ?? "");
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    // Not JSON: the text is the tool's own words.
    return {};
  }
}

/**
 * A request the captain did not answer within the Keyvault's 10 minutes, said plainly. The Keyvault reports it as
 * declined ("denied: the user declined the sign-in (the request expired); do not ask again ..."), and once it is gone
 * as not found, which would make the round give up on a captain who was only away; it is to ask again.
 */
function expiredIsExpired(result: ToolResult): ToolResult {
  const text = result.content.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
  if (!result.isError || !/\(the request expired\)|not_found: not found: request [0-9a-f]{32}/.test(text)) return result;
  const answer = { status: "expired", message: "The captain did not answer this request within the Keyvault's 10 minutes. Ask again: call request_site_login without request_id, for a new request." };
  return { content: [{ type: "text", text: JSON.stringify(answer) }], structuredContent: answer };
}

interface Listed {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] } & Record<string, unknown>;
}

/** The bridge's answers to one MCP message each, with the driver's tool list asked once. */
export function makeBridge(options: BridgeOptions) {
  let tools: unknown[] | null = null;

  const toolList = Effect.gen(function* () {
    if (tools) return tools;
    const host = yield* HostCua;
    const listed: Listed[] = [];
    for (const name of ["browser", "list_windows"]) {
      const result = yield* host.call("list_tools", { space: options.space, name });
      const structured = (result.structuredContent ?? JSON.parse(String(result.content[0]?.text ?? "{}"))) as { tools?: Listed[] };
      listed.push(...(structured.tools ?? []));
    }
    const driver = DRIVER_TOOLS.map((name) => listed.find((tool) => tool.name === name)).filter((tool): tool is Listed => tool !== undefined);
    // The session is the bridge's to set.
    tools = [...driver.map(({ name, description, inputSchema }) => {
      const properties = { ...inputSchema?.properties };
      delete properties.session;
      return { name, description, inputSchema: { ...inputSchema, type: "object", properties, required: (inputSchema?.required ?? []).filter((key) => key !== "session") } };
    }), SITE_LOGIN_TOOL];
    return tools;
  });

  /**
   * A driver tool in the round's session, started again when it has ended: the bridge runs for days, anything may end
   * its session (a probe's clean-up did on 2026-10-22, and every round after was refused "session_ended"), and the
   * driver revives an ended name only on start_session, never on an ordinary call.
   */
  const driver = Effect.fn("driver")(function* (tool: string, args: Record<string, unknown>) {
    const host = yield* HostCua;
    const send = host.call("call_tool", { space: options.space, tool, arguments: args });
    const result = yield* send;
    if (outcome(result) !== "session_ended") return result;
    const started = yield* host.call("call_tool", { space: options.space, tool: "start_session", arguments: { session: options.session } });
    options.log(`${tool}: session_ended; start_session ${options.session}: ${outcome(started)}`);
    return started.isError ? result : yield* send;
  });

  const siteLogin = Effect.fn("siteLogin")(function* (args: Record<string, unknown>) {
    const host = yield* HostCua;
    const { target_id: target, tab_id: tab, request_id: request } = args;
    if (typeof target !== "string" || typeof tab !== "string" || !target || !tab) return failure("name the tab: its target_id and tab_id from get_browser_state");
    if (request !== undefined && (typeof request !== "string" || !/^[0-9a-f]{32}$/.test(request))) return failure("request_id is the one an earlier call gave");
    const ids = { session: options.session, target_id: target, tab_id: tab };
    // The page's address, read here rather than taken from the agent.
    const page = yield* driver("get_browser_state", { ...ids, snapshot_format: "semantic_v2", query: NOTHING });
    if (page.isError) return page;
    const url = (page.structuredContent as { page?: { url?: unknown } } | undefined)?.page?.url;
    const origin = typeof url === "string" ? originOf(url) : null;
    if (!origin || !(META_ORIGINS as readonly string[]).includes(origin)) {
      options.log(`request_site_login refused: the tab is on ${origin ?? "no web page"}`);
      return failure(`the tab is on ${origin ?? "no web page"}, not one of Meta's sites: the Keyvault is asked only for Meta's password box`);
    }
    const ask = (wait?: { request: string; secs: number }) =>
      host.call("request_site_login", { space: options.space, url, ...ids, agent: options.agent, ...(wait ? { request_id: wait.request, wait_secs: wait.secs } : {}) }).pipe(
        Effect.map(expiredIsExpired),
        Effect.tap((result) => Effect.sync(() => options.log(`request_site_login ${origin}: ${outcome(result)}${wait ? "" : " (filed)"}`))),
      );
    if (request) return yield* ask({ request, secs: WAIT_SECS });
    // A login the captain unlocked is granted at once: filled here, and the round hears pending only when he is asked.
    const filed = yield* ask();
    const id = answered(filed).request_id;
    return !filed.isError && answered(filed).status === "pending" && typeof id === "string" ? yield* ask({ request: id, secs: GRANT_SECS }) : filed;
  });

  const callTool = Effect.fn("callTool")(function* (name: unknown, args: Record<string, unknown>) {
    if ((DRIVER_TOOLS as readonly unknown[]).includes(name)) {
      const tool = name as string;
      const result = yield* driver(tool, driverArgs(tool, args, options));
      // The tool and how it went, never its arguments (browser_type's text) or what it read.
      if (result.isError) options.log(`${tool}: ${outcome(result)}`);
      return result;
    }
    if (name === "request_site_login") return yield* siteLogin(args);
    return failure(`there is no tool ${JSON.stringify(name)} here: ${[...DRIVER_TOOLS, SITE_LOGIN_TOOL.name].join(", ")}`);
  });

  /** The answer to one JSON-RPC message, or null for a notification. */
  const answer = (message: unknown) =>
    Effect.gen(function* () {
      const m = (typeof message === "object" && message !== null ? message : {}) as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
      if (m.id === undefined || m.id === null) return null;
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
      const params = m.params ?? {};
      switch (m.method) {
        case "initialize":
          return reply({
            protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "life-archive-cua-bridge", version: "1" },
            instructions: INSTRUCTIONS,
          });
        case "ping":
          return reply({});
        case "tools/list":
          return yield* toolList.pipe(
            Effect.map((tools) => reply({ tools })),
            Effect.catchTag("RunFailed", (failed) => Effect.succeed({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: `the captain's Mac could not list the Space's driver tools: ${failed.message}` } })),
          );
        case "tools/call": {
          const args = typeof params.arguments === "object" && params.arguments !== null ? params.arguments as Record<string, unknown> : {};
          // This Mac's Cua not answering is the tool's failure, for the agent to see, not the bridge's.
          return reply(yield* callTool(params.name, args).pipe(
            Effect.catchTag("RunFailed", (failed) => Effect.succeed(failure(`the captain's Mac could not reach the Space's driver: ${failed.message}`))),
          ));
        }
        default:
          return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no method ${String(m.method)}` } };
      }
    });

  return { answer };
}

/** Whether `given` is the bridge's token, compared in constant time. */
function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The bridge's one page, `/<token>/mcp`: MCP's streamable HTTP, each POST answered with JSON (no event stream), and
 * `/<token>/health` for the Mac's side to see it is there before it starts a round. Anything else is not found.
 */
export const bridgeRoute = (options: BridgeOptions & { token: string }): Route<RouteError, HostCua> => {
  const bridge = makeBridge(options);
  return (req, res) =>
    Effect.gen(function* () {
      const [, token = "", page = "", ...rest] = new URL(req.url ?? "/", "http://bridge").pathname.split("/");
      if (!sameToken(token, options.token) || rest.length > 0) return yield* new NotFoundError("no such page");
      if (page === "health" && req.method === "GET") return sendJson(res, 200, { ok: true, space: options.space });
      if (page !== "mcp") return yield* new NotFoundError("no such page");
      if (req.method === "GET") return void res.writeHead(405, { allow: "POST, DELETE" }).end();
      // Ending an MCP session: there is nothing kept per session to let go.
      if (req.method === "DELETE") return void res.writeHead(200).end();
      if (req.method !== "POST") return yield* new NotFoundError("no such page");
      const body = yield* readJson(req);
      const replies = (yield* Effect.forEach(Array.isArray(body) ? body : [body], (message) => bridge.answer(message))).filter((reply) => reply !== null);
      if (replies.length === 0) return void res.writeHead(202).end();
      sendJson(res, 200, Array.isArray(body) ? replies : replies[0]);
    });
};

/** The bridge could not listen (its address not there while the Space's network is down, or the port taken). */
export class CouldNotListen extends Data.TaggedError("CouldNotListen")<{ readonly message: string }> {}

/**
 * Serves the bridge on `address`:`port` until interrupted. `where` finds the address (the Space's network may not be up
 * yet); until it is found and listened on, it tries again every 30 seconds, saying why once each time the reason changes.
 */
export const runBridge = <E extends { message: string }>(options: BridgeOptions & { token: string; port: number; where: Effect.Effect<string, E> }) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<HostCua>();
    let said = "";
    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const address = yield* options.where;
        const server = createServer(serve(context, bridgeRoute(options)));
        yield* listen(server, options.port, address);
        options.log(`listening on http://${address}:${options.port}/ for the rounds in ${options.space}`);
        return server;
      }).pipe(
        Effect.tapError((error) => Effect.sync(() => {
          if (error.message !== said) options.log(`not listening yet: ${(said = error.message)}; trying again every 30 seconds`);
        })),
        Effect.retry({ schedule: Schedule.spaced("30 seconds") }),
      ),
      (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void)).closeAllConnections()),
    );
    return yield* Effect.never;
  }).pipe(Effect.scoped);

const listen = (server: Server, port: number, address: string): Effect.Effect<void, CouldNotListen> =>
  Effect.callback<void, CouldNotListen>((resume) => {
    const failed = (error: NodeJS.ErrnoException) => resume(Effect.fail(new CouldNotListen({ message: `could not listen on ${address}:${port} (${error.code ?? error.message})` })));
    server.once("error", failed);
    server.listen(port, address, () => {
      server.off("error", failed);
      resume(Effect.void);
    });
  });

/**
 * The address this Mac has on the Space's network: the interface address in the same subnet as the Space's own
 * (192.168.64.1 for a local Space at 192.168.64.5), or null when there is none (the Space's network is down).
 */
export function bridgeAddress(spaceIp: string, interfaces: Record<string, Array<{ family: string | number; address: string; netmask: string; internal: boolean }> | undefined>): string | null {
  const toNumber = (ip: string) => ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(spaceIp)) return null;
  const space = toNumber(spaceIp);
  for (const addresses of Object.values(interfaces)) {
    for (const a of addresses ?? []) {
      if (a.internal || (a.family !== "IPv4" && a.family !== 4)) continue;
      const mask = toNumber(a.netmask);
      if (((toNumber(a.address) & mask) >>> 0) === ((space & mask) >>> 0) && a.address !== spaceIp) return a.address;
    }
  }
  return null;
}
