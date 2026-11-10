// The agents' keys and their calls (keys.ts), the command over them (cli.ts), the grants (tool.ts), and the trail of
// content reads taking the door's reads (the calendar's second migration): on a core and a calendar in memory or in a
// folder of the test's own.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCore } from "../archive/coreDb.ts";
import { calendarVersion, CALENDAR_SCHEMA_VERSION, openCalendar } from "../calendar/db.ts";
import { mcpCommand } from "./cli.ts";
import { keptArguments, KEY_PREFIX, keyHash, McpKeys } from "./keys.ts";
import { allows, readGrant } from "./tool.ts";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-mcp-keys-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("an agent's key", () => {
  it("is printed once, kept as its hash alone, and says who calls and what it may do", () => {
    const db = openCore(":memory:");
    const keys = new McpKeys(db);
    const key = keys.add("claude-code", ["content:rituals"], 1000);
    expect(key.startsWith(KEY_PREFIX)).toBe(true);
    expect(JSON.stringify(db.prepare("SELECT * FROM mcp_key").all())).not.toContain(key);
    expect((db.prepare("SELECT key_sha256 FROM mcp_key").get() as { key_sha256: string }).key_sha256).toBe(keyHash(key));
    expect(keys.verify(key)).toEqual({ agent: "claude-code", grants: ["content:rituals"] });
    expect(keys.verify(`${key}x`)).toBeNull();
    expect(keys.verify("not-a-key")).toBeNull();
  });

  it("is one per agent, its name a slug and its grants each content or write, alone or for a module", () => {
    const keys = new McpKeys(openCore(":memory:"));
    keys.add("g", [], 1);
    expect(() => keys.add("g", [], 2)).toThrow(/has a key already/);
    expect(() => keys.add("Claude Code", [], 2)).toThrow(/lower-case letters, digits and hyphens/);
    expect(() => keys.add("codex", ["read:rituals"], 2)).toThrow(/a grant is content or write/);
    expect(() => keys.grant("nobody", ["write"])).toThrow(/has no key/);
  });

  it("has its grants added and taken, is replaced (the old one stops), and is removed, its calls kept", () => {
    const keys = new McpKeys(openCore(":memory:"));
    const first = keys.add("g", [], 1);
    expect(keys.grant("g", ["write:rituals", "content:rituals", "write:rituals"])).toEqual(["content:rituals", "write:rituals"]);
    expect(keys.ungrant("g", ["content:rituals"])).toEqual(["write:rituals"]);
    const second = keys.replace("g", 2);
    expect(keys.verify(first)).toBeNull();
    expect(keys.verify(second)).toEqual({ agent: "g", grants: ["write:rituals"] });
    keys.record({ at: 5, agent: "g", tool: "rituals_status", module: "rituals", access: "facts", ok: true, error: null, durationMs: 3, arguments: {} });
    expect(keys.find("g")!.lastUsedAt).toBe(5);
    keys.remove("g");
    expect(keys.verify(second)).toBeNull();
    expect(keys.calls()).toHaveLength(1);
  });
});

describe("grants", () => {
  it("read as the access alone or for one module, and let facts through always", () => {
    expect(readGrant("content")).toEqual({ access: "content", module: null });
    expect(readGrant("write:friend-map")).toEqual({ access: "write", module: "friend-map" });
    expect(readGrant("facts")).toBeNull();
    expect(allows([], "facts", "rituals")).toBe(true);
    expect(allows(["content:rituals"], "content", "rituals")).toBe(true);
    expect(allows(["content:rituals"], "content", "journal")).toBe(false);
    expect(allows(["content"], "content", "journal")).toBe(true);
    expect(allows(["content"], "write", "rituals")).toBe(false);
  });
});

describe("a call's arguments as kept", () => {
  it("are a facts tool's whole, and another's with every text as its length", () => {
    expect(keptArguments("facts", { day: "2026-11-04" })).toEqual({ day: "2026-11-04" });
    expect(keptArguments("write", { request: { op: "ritual_put", patch: { stretching: true }, source_text: "abc" } })).toEqual({
      request: { op: "[redacted: 10 characters]", patch: { stretching: true }, source_text: "[redacted: 3 characters]" },
    });
  });
});

describe("mcp, the command", () => {
  it("adds a key and prints it once, lists keys, grants, and lists calls", () => {
    const keys = new McpKeys(openCore(":memory:"));
    const lines: string[] = [];
    const print = (line: string) => lines.push(line);
    mcpCommand(keys, ["key", "add", "g"], { grant: ["write:rituals"] }, 1000, print);
    expect(lines[0]).toBe("A key for g (facts, and write:rituals). It is shown this once and kept nowhere; give it to the agent and never commit it:");
    expect(keys.verify(lines[2]!)?.agent).toBe("g");
    lines.length = 0;
    mcpCommand(keys, ["key", "grant", "g", "content:rituals"], {}, 1000, print);
    expect(lines).toEqual(["g may now read facts, and content:rituals, write:rituals."]);
    lines.length = 0;
    mcpCommand(keys, ["key", "list"], {}, 1000, print);
    expect(lines[0]).toMatch(/^g {2}content:rituals, write:rituals {2}made .+, last used never$/);
    lines.length = 0;
    mcpCommand(keys, ["calls"], {}, 1000, print);
    expect(lines).toEqual(["No agent has called a tool yet."]);
    expect(() => mcpCommand(keys, ["key", "rotate", "g"], {}, 1000, print)).toThrow(/mcp key takes add, list/);
  });
});

describe("the trail of content reads", () => {
  it("takes the agents' door's reads once its calendar is brought up to date, every read before kept", () => {
    const file = join(root, "calendar.sqlite");
    // A calendar at its first schema: the trail, as it was, with a read in it.
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE content_read (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, last_at INTEGER NOT NULL, reads INTEGER NOT NULL DEFAULT 1 CHECK (reads >= 1),
        surface TEXT NOT NULL CHECK (surface IN ('cli', 'app', 'viewer')), reader TEXT, what TEXT NOT NULL, scope_json TEXT NOT NULL, why TEXT);
      CREATE INDEX content_read_last_at ON content_read(last_at);
      INSERT INTO content_read (id, at, last_at, reads, surface, reader, what, scope_json, why) VALUES (7, 1, 2, 3, 'cli', 'codex', 'timeline', '{"person":2}', 'a made-up ask');
      PRAGMA user_version = 1;`);
    old.close();
    const db = openCalendar(file);
    expect(calendarVersion(db)).toBe(CALENDAR_SCHEMA_VERSION);
    expect(db.prepare("SELECT * FROM content_read").all()).toEqual([{ id: 7, at: 1, last_at: 2, reads: 3, surface: "cli", reader: "codex", what: "timeline", scope_json: '{"person":2}', why: "a made-up ask" }]);
    db.prepare("INSERT INTO content_read (at, last_at, surface, reader, what, scope_json) VALUES (3, 3, 'mcp', 'g', 'rituals_read', '{}')").run();
    expect(() => db.prepare("INSERT INTO content_read (at, last_at, surface, what, scope_json) VALUES (3, 3, 'elsewhere', 'x', '{}')").run()).toThrow(/CHECK/);
    db.close();
  });
});
