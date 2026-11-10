import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RunFailed, serve } from "../../../../sdk/server.ts";
import { bridgeAddress, bridgeRoute, DRIVER_TOOLS, driverArgs, GRANT_SECS, HostCua, makeBridge, META_ORIGINS, type ToolResult, WAIT_SECS } from "./bridge.ts";

const SPACE = "local:space-sample";
const OPTIONS = { space: SPACE, profile: "friend-map-exports", session: "friend-map-exports", agent: "friend-map-exports", log: () => {} };
const REQUEST = "61a66b4ec0d7eeb2d1b08fd846ca5f4e";

/** The driver's tools as `list_tools` lists them: the round's, and some it must not get. */
const LISTED = [...DRIVER_TOOLS, "browser_download", "browser_set_input_files"].map((name) => ({
  name,
  description: `${name}, as the driver says`,
  inputSchema: { type: "object", additionalProperties: true, properties: { session: { type: "string" }, target_id: { type: "string" } }, required: name === "browser_pointer" ? ["session", "target_id"] : [] },
}));

/**
 * This Mac's Cua, made up: each call kept, `list_tools` from LISTED, a tab's snapshot on `pageUrl`, and request_site_login
 * pending, then filled; with `unlocked` false, a request is still pending on its first wait (the captain not yet asked).
 */
function fakeHost(calls: Array<{ tool: string; args: Record<string, unknown> }>, pageUrl = "https://accountscenter.facebook.com/info_and_permissions/dyi/", unlocked = true) {
  return Layer.succeed(HostCua, {
    call: (tool: string, args: Record<string, unknown>) =>
      Effect.sync((): ToolResult => {
        calls.push({ tool, args });
        if (tool === "list_tools") return { content: [], structuredContent: { tools: LISTED.filter((t) => t.name.includes(String(args.name))) } };
        if (tool === "request_site_login") {
          return args.request_id && (unlocked || args.wait_secs === WAIT_SECS)
            ? { content: [{ type: "text", text: JSON.stringify({ status: "filled", submitted: true }) }] }
            : { content: [{ type: "text", text: JSON.stringify({ status: "pending", request_id: REQUEST }) }] };
        }
        const inner = args.arguments as Record<string, unknown>;
        if (args.tool === "get_browser_state" && inner.query) return { content: [], structuredContent: { status: "ok", page: { url: pageUrl, title: "Download your information" } } };
        return { content: [{ type: "text", text: "ok" }], structuredContent: { status: "ok" } };
      }),
  });
}

const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe("the round's browser bridge", () => {
  it.effect("offers the round's browser tools with the session left to it, and request_site_login, and nothing else", () =>
    Effect.gen(function* () {
      const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const bridge = makeBridge(OPTIONS);
      const listed = (yield* bridge.answer({ jsonrpc: "2.0", id: 1, method: "tools/list" }).pipe(Effect.provide(fakeHost(calls)))) as { result: { tools: Array<{ name: string; inputSchema: { properties: object; required: string[] } }> } };
      const tools = listed.result.tools;
      expect(tools.map((t) => t.name)).toEqual([...DRIVER_TOOLS, "request_site_login"]);
      for (const tool of tools) {
        expect(tool.inputSchema.properties).not.toHaveProperty("session");
        expect(tool.inputSchema.required).not.toContain("session");
      }
      // Asked of the driver once, by the names the bridge needs, in the round's own Space.
      yield* bridge.answer({ jsonrpc: "2.0", id: 2, method: "tools/list" }).pipe(Effect.provide(fakeHost(calls)));
      expect(calls).toEqual([{ tool: "list_tools", args: { space: SPACE, name: "browser" } }, { tool: "list_tools", args: { space: SPACE, name: "list_windows" } }]);

      const refused = (yield* bridge.answer(call(3, "browser_download", { ref: "p1:1" })).pipe(Effect.provide(fakeHost(calls)))) as { result: ToolResult };
      expect(refused.result.isError).toBe(true);
      expect(calls).toHaveLength(2);
    }));

  it.effect("sends each driver call on in the round's session, its browser the export profile and its snapshots semantic", () =>
    Effect.gen(function* () {
      const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const bridge = makeBridge(OPTIONS);
      const host = fakeHost(calls);
      yield* bridge.answer(call(1, "browser_prepare", { allow_launch: true, pid: 4242, strategy: { kind: "existing_profile" }, profile: { mode: "isolated_named", name: "Default" }, session: "another" })).pipe(Effect.provide(host));
      yield* bridge.answer(call(2, "get_browser_state", { target_id: "bt-1", tab_id: "tab-1", snapshot_format: "dom_refs_v1", query: "Start export" })).pipe(Effect.provide(host));
      yield* bridge.answer(call(3, "get_browser_state", { pid: 4242, window_id: 7 })).pipe(Effect.provide(host));
      expect(calls).toEqual([
        { tool: "call_tool", args: { space: SPACE, tool: "browser_prepare", arguments: { allow_launch: true, profile: { mode: "isolated_named", name: "friend-map-exports" }, session: "friend-map-exports" } } },
        { tool: "call_tool", args: { space: SPACE, tool: "get_browser_state", arguments: { target_id: "bt-1", tab_id: "tab-1", snapshot_format: "semantic_v2", query: "Start export", session: "friend-map-exports" } } },
        // Binding a window takes no snapshot format.
        { tool: "call_tool", args: { space: SPACE, tool: "get_browser_state", arguments: { pid: 4242, window_id: 7, session: "friend-map-exports" } } },
      ]);
      expect(driverArgs("browser_click", { target_id: "bt-1", tab_id: "tab-1", ref: "p2:3", delivery_mode: "foreground" }, OPTIONS))
        .toEqual({ target_id: "bt-1", tab_id: "tab-1", ref: "p2:3", delivery_mode: "foreground", session: "friend-map-exports" });
    }));

  it.effect("starts the round's session again when it has ended, and sends the call on once more", () =>
    Effect.gen(function* () {
      const ended = { content: [{ type: "text", text: "session 'friend-map-exports' has ended; call start_session with session 'friend-map-exports' to start it again, or use a new session label" }], isError: true, structuredContent: { status: "refused", refusal: { code: "session_ended" } } };
      /** The driver as the 06:11 round found it on 2026-10-23: the session ended hours before, until start_session; `revives` false, a start_session that fails too. */
      const endedHost = (calls: Array<{ tool: string; args: Record<string, unknown> }>, revives = true) => {
        let alive = false;
        return Layer.succeed(HostCua, {
          call: (tool: string, args: Record<string, unknown>) =>
            Effect.sync((): ToolResult => {
              calls.push({ tool, args });
              if (args.tool === "start_session") {
                alive = revives;
                return revives ? { content: [], structuredContent: { session: "friend-map-exports", state: "active" } } : { content: [{ type: "text", text: "no" }], isError: true };
              }
              if (!alive) return ended;
              return args.tool === "get_browser_state"
                ? { content: [], structuredContent: { status: "ok", page: { url: "https://accountscenter.facebook.com/info_and_permissions/dyi/" } } }
                : { content: [{ type: "text", text: "ok" }], structuredContent: { status: "ok" } };
            }),
        });
      };
      const logged: string[] = [];
      const bridge = makeBridge({ ...OPTIONS, log: (line) => void logged.push(line) });
      const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const host = endedHost(calls);
      const prepared = (yield* bridge.answer(call(1, "browser_prepare", { allow_launch: true })).pipe(Effect.provide(host))) as { result: ToolResult };
      expect(prepared.result).toMatchObject({ structuredContent: { status: "ok" } });
      const prepare = { tool: "call_tool", args: { space: SPACE, tool: "browser_prepare", arguments: { allow_launch: true, profile: { mode: "isolated_named", name: "friend-map-exports" }, session: "friend-map-exports" } } };
      expect(calls).toEqual([prepare, { tool: "call_tool", args: { space: SPACE, tool: "start_session", arguments: { session: "friend-map-exports" } } }, prepare]);
      expect(logged).toEqual(["browser_prepare: session_ended; start_session friend-map-exports: ok"]);
      // Alive again, it is not started again.
      yield* bridge.answer(call(2, "list_windows")).pipe(Effect.provide(host));
      expect(calls.slice(3).map((c) => c.args.tool)).toEqual(["list_windows"]);

      // request_site_login's own read of the page does the same.
      const siteCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const filled = (yield* makeBridge(OPTIONS).answer(call(3, "request_site_login", { target_id: "bt-1", tab_id: "tab-1" })).pipe(Effect.provide(endedHost(siteCalls)))) as { result: ToolResult };
      expect(filled.result.isError).toBeUndefined();
      expect(siteCalls.map((c) => c.args.tool)).toEqual(["get_browser_state", "start_session", "get_browser_state", undefined]);

      // A session that cannot be started again: the round hears the driver's own refusal, once.
      const failedCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const refused = (yield* makeBridge(OPTIONS).answer(call(4, "browser_prepare")).pipe(Effect.provide(endedHost(failedCalls, false)))) as { result: ToolResult };
      expect(refused.result).toEqual(ended);
      expect(failedCalls.map((c) => c.args.tool)).toEqual(["browser_prepare", "start_session"]);
    }));

  it.effect("asks the Keyvault to fill Meta's password box in the round's own tab, from the page's address it reads itself, and waits for the captain on a retry", () =>
    Effect.gen(function* () {
      const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const bridge = makeBridge(OPTIONS);
      const asked = fakeHost(calls, undefined, false);
      const first = (yield* bridge.answer(call(1, "request_site_login", { target_id: "bt-1", tab_id: "tab-1", url: "https://evil.example/login" })).pipe(Effect.provide(asked))) as { result: ToolResult };
      expect(JSON.parse(String(first.result.content[0].text))).toMatchObject({ status: "pending", request_id: REQUEST });
      const second = (yield* bridge.answer(call(2, "request_site_login", { target_id: "bt-1", tab_id: "tab-1", request_id: REQUEST })).pipe(Effect.provide(asked))) as { result: ToolResult };
      expect(JSON.parse(String(second.result.content[0].text))).toMatchObject({ status: "filled" });
      const page = { space: SPACE, tool: "get_browser_state", arguments: { session: "friend-map-exports", target_id: "bt-1", tab_id: "tab-1", snapshot_format: "semantic_v2", query: expect.any(String) } };
      const ask = { space: SPACE, url: "https://accountscenter.facebook.com/info_and_permissions/dyi/", session: "friend-map-exports", target_id: "bt-1", tab_id: "tab-1", agent: "friend-map-exports" };
      expect(calls).toEqual([
        { tool: "call_tool", args: page },
        { tool: "request_site_login", args: ask },
        // A new request is waited on a little, for a login the captain unlocked, before the round hears pending.
        { tool: "request_site_login", args: { ...ask, request_id: REQUEST, wait_secs: GRANT_SECS } },
        { tool: "call_tool", args: page },
        { tool: "request_site_login", args: { ...ask, request_id: REQUEST, wait_secs: WAIT_SECS } },
      ]);
    }));

  it.effect("fills a login the captain unlocked in the call that asks, so the round never reports an approval nobody is asked for", () =>
    Effect.gen(function* () {
      const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const answer = (yield* makeBridge(OPTIONS).answer(call(1, "request_site_login", { target_id: "bt-1", tab_id: "tab-1" })).pipe(Effect.provide(fakeHost(calls)))) as { result: ToolResult };
      expect(JSON.parse(String(answer.result.content[0].text))).toMatchObject({ status: "filled" });
      expect(calls.filter((c) => c.tool === "request_site_login").map((c) => c.args.wait_secs)).toEqual([undefined, GRANT_SECS]);
    }));

  it.effect("says plainly that a request the captain did not answer expired, which the Keyvault words as declined, so the round asks again", () =>
    Effect.gen(function* () {
      const keyvault = (text: string) => Layer.succeed(HostCua, {
        call: (tool: string) => Effect.succeed<ToolResult>(tool === "request_site_login"
          ? { content: [{ type: "text", text }], isError: true }
          : { content: [], structuredContent: { status: "ok", page: { url: "https://accountscenter.facebook.com/info_and_permissions/dyi/" } } }),
      });
      for (const text of [
        "error: site login refused: denied: the user declined the sign-in (the request expired); do not ask again unless they bring it up",
        `error: site login refused: not_found: not found: request ${REQUEST}`,
      ]) {
        const answer = (yield* makeBridge(OPTIONS).answer(call(1, "request_site_login", { target_id: "bt-1", tab_id: "tab-1", request_id: REQUEST })).pipe(Effect.provide(keyvault(text)))) as { result: ToolResult };
        expect(answer.result.isError).toBeUndefined();
        expect(answer.result.structuredContent).toMatchObject({ status: "expired", message: expect.stringContaining("without request_id") });
      }
      // He declined, or there is no login for the site: that stays the Keyvault's own error.
      for (const text of ["error: site login refused: denied: the user declined the sign-in (not now); do not ask again", "error: site login refused: not_found: no saved password for messenger.com in the Keyvault"]) {
        const answer = (yield* makeBridge(OPTIONS).answer(call(1, "request_site_login", { target_id: "bt-1", tab_id: "tab-1" })).pipe(Effect.provide(keyvault(text)))) as { result: ToolResult };
        expect(answer.result).toEqual({ content: [{ type: "text", text }], isError: true });
      }
    }));

  it.effect("never asks the Keyvault for a page off Meta's sites, or with a request id it did not give", () =>
    Effect.gen(function* () {
      for (const url of ["https://www.facebook.com.example/login", "http://www.facebook.com/login", "https://github.com/login", "about:blank"]) {
        const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
        const answer = (yield* makeBridge(OPTIONS).answer(call(1, "request_site_login", { target_id: "bt-1", tab_id: "tab-1" })).pipe(Effect.provide(fakeHost(calls, url)))) as { result: ToolResult };
        expect(answer.result.isError).toBe(true);
        expect(calls.map((c) => c.tool)).toEqual(["call_tool"]);
      }
      const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const bad = (yield* makeBridge(OPTIONS).answer(call(1, "request_site_login", { target_id: "bt-1", tab_id: "tab-1", request_id: "approve; anything" })).pipe(Effect.provide(fakeHost(calls)))) as { result: ToolResult };
      expect(bad.result.isError).toBe(true);
      expect(calls).toEqual([]);
      expect(META_ORIGINS).toContain("https://www.messenger.com");
    }));

  it.effect("answers a tool whose call this Mac's Cua could not make as that tool's failure, and a list it could not make as an error", () =>
    Effect.gen(function* () {
      const down = Layer.succeed(HostCua, { call: () => Effect.fail(new RunFailed({ message: "the Cua daemon is not running" })) });
      const answer = (yield* makeBridge(OPTIONS).answer(call(7, "list_windows")).pipe(Effect.provide(down))) as { id: number; result: ToolResult };
      expect(answer).toMatchObject({ id: 7, result: { isError: true, content: [{ text: expect.stringContaining("the Cua daemon is not running") }] } });
      // A list it cannot make is the request's error.
      expect(yield* makeBridge(OPTIONS).answer({ jsonrpc: "2.0", id: 8, method: "tools/list" }).pipe(Effect.provide(down)))
        .toMatchObject({ id: 8, error: { code: -32603, message: expect.stringContaining("the Cua daemon is not running") } });
    }));

  it.live("serves MCP at its token's address alone: JSON answers, notifications taken, the health page for the Mac's side", () =>
    Effect.promise(() => serveOnce(async (base) => {
      const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const init = await post("/sample-token/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
      expect(init.status).toBe(200);
      expect(await init.json()).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "life-archive-cua-bridge" } } });
      expect((await post("/sample-token/mcp", { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      const batch = await post("/sample-token/mcp", [{ jsonrpc: "2.0", id: 2, method: "ping" }, { jsonrpc: "2.0", id: 3, method: "no/such" }]);
      expect(await batch.json()).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }, { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "no method no/such" } }]);
      expect((await fetch(`${base}/sample-token/mcp`)).status).toBe(405);
      expect(await (await fetch(`${base}/sample-token/health`)).json()).toEqual({ ok: true, space: SPACE });
      for (const path of ["/other-token/mcp", "/sample-token-2/health", "/sample-token/mcp/more", "/", "/sample-token/other"]) {
        expect((await fetch(`${base}${path}`, { method: "POST", body: "{}" })).status).toBe(404);
      }
    })));
});

/** Serves the bridge (token sample-token) on a port of its own on this Mac for `use`, then closes it. */
async function serveOnce(use: (base: string) => Promise<void>): Promise<void> {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const context = await Effect.runPromise(Effect.context<HostCua>().pipe(Effect.provide(fakeHost(calls))));
  const server: Server = createServer(serve(context, bridgeRoute({ ...OPTIONS, token: "sample-token" })));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("bridgeAddress", () => {
  const ifaces = {
    lo0: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", internal: true }],
    en0: [{ family: "IPv4", address: "192.168.1.5", netmask: "255.255.255.0", internal: false }, { family: "IPv6", address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", internal: false }],
    bridge100: [{ family: "IPv4", address: "192.168.64.1", netmask: "255.255.255.0", internal: false }],
  };
  it("is this Mac's address on the Space's own network, and none while that network is down", () => {
    expect(bridgeAddress("192.168.64.5", ifaces)).toBe("192.168.64.1");
    expect(bridgeAddress("192.168.65.5", ifaces)).toBeNull();
    expect(bridgeAddress("192.168.64.5", { en0: ifaces.en0 })).toBeNull();
    expect(bridgeAddress("space.example", ifaces)).toBeNull();
  });
});
