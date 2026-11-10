// The agents' keys and their calls, in the core's database (archive/coreDb.ts's mcp_key and mcp_call): one key for each
// agent (claude-code, codex, g), made by `npm run archive -- mcp key add <agent>` (cli.ts), printed once and kept only as
// its SHA-256, with what it is granted beyond facts (tool.ts: content, write, or either for one module); and every tool
// call an agent made, by whom, when, how it went and with what arguments (a facts tool's whole, another's with every
// text as its length), which the transcript warehouse reads to tag an agent's calls. A key is checked against the table
// on every request, so one added, granted or removed counts at once, with no restart.

import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../archive/db.ts";
import { redactText } from "../archive/redact.ts";
import { InvalidInputError, NotFoundError } from "../errors.ts";
import { readGrant, type Access } from "./tool.ts";

/** What every key starts with, so one pasted where it should not be is known for what it is. */
export const KEY_PREFIX = "la_mcp_";

/** An agent's name: lower-case letters, digits and hyphens, a letter or digit first, at most 40. */
export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A new key: the prefix and 32 random bytes. */
export const newKey = (): string => `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;

/** What the table keeps of a key: its SHA-256, hex (a key is random enough that nothing slower is needed). */
export const keyHash = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

/** An agent's key as the table holds it, less the hash. */
export interface AgentKey {
  agent: string;
  grants: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

/** One tool call, as kept. */
export interface ToolCallRecord {
  at: number;
  agent: string;
  tool: string;
  module: string;
  access: Access;
  ok: boolean;
  error: string | null;
  durationMs: number;
  arguments: unknown;
}

/** A call's arguments as kept: a facts tool's whole; another's with every text as its length, so no word of content is kept. */
export function keptArguments(access: Access, input: unknown): unknown {
  if (access === "facts") return input ?? {};
  const redact = (value: unknown): unknown =>
    typeof value === "string" ? redactText(value) : Array.isArray(value) ? value.map(redact) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)])) : value;
  return redact(input ?? {});
}

function checkAgent(agent: string): string {
  if (!AGENT_NAME.test(agent)) throw new InvalidInputError(`an agent's name is lower-case letters, digits and hyphens (claude-code, codex, g), not ${JSON.stringify(agent)}`);
  return agent;
}

function checkGrants(grants: readonly string[]): string[] {
  for (const grant of grants) {
    if (!readGrant(grant)) throw new InvalidInputError(`a grant is content or write, alone or for one module (content:rituals, write:rituals), not ${JSON.stringify(grant)}`);
  }
  return [...new Set(grants.map((g) => g.trim()))].sort();
}

interface KeyRow {
  agent: string;
  grants_json: string;
  created_at: number;
  last_used_at: number | null;
}

const keyOf = (row: KeyRow): AgentKey => ({ agent: row.agent, grants: JSON.parse(row.grants_json) as string[], createdAt: row.created_at, lastUsedAt: row.last_used_at });

/** The keys and calls in the core's database open in `db`. */
export class McpKeys {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** A key for `agent`, which has none yet, with `grants`: the key, to print once. */
  add(agent: string, grants: readonly string[], now: number): string {
    checkAgent(agent);
    const kept = checkGrants(grants);
    if (this.find(agent)) throw new InvalidInputError(`${agent} has a key already: \`mcp key replace ${agent}\` makes it a new one, \`mcp key grant ${agent} ...\` changes what it may do`);
    const key = newKey();
    this.db.prepare("INSERT INTO mcp_key (agent, key_sha256, grants_json, created_at) VALUES (?, ?, ?, ?)").run(agent, keyHash(key), JSON.stringify(kept), now);
    return key;
  }

  /** A new key for `agent` in place of its old one, which stops working at once; its grants stay. The key, to print once. */
  replace(agent: string, now: number): string {
    this.mustFind(agent);
    const key = newKey();
    this.db.prepare("UPDATE mcp_key SET key_sha256 = ?, created_at = ?, last_used_at = NULL WHERE agent = ?").run(keyHash(key), now, agent);
    return key;
  }

  /** Every key, by agent. */
  list(): AgentKey[] {
    return (this.db.prepare("SELECT agent, grants_json, created_at, last_used_at FROM mcp_key ORDER BY agent").all() as unknown as KeyRow[]).map(keyOf);
  }

  find(agent: string): AgentKey | null {
    const row = this.db.prepare("SELECT agent, grants_json, created_at, last_used_at FROM mcp_key WHERE agent = ?").get(agent) as KeyRow | undefined;
    return row ? keyOf(row) : null;
  }

  private mustFind(agent: string): AgentKey {
    const found = this.find(checkAgent(agent));
    if (!found) throw new NotFoundError(`${agent} has no key: \`mcp key add ${agent}\` makes one`);
    return found;
  }

  /** Adds `grants` to what `agent`'s key may do; what it may do now. */
  grant(agent: string, grants: readonly string[]): string[] {
    const found = this.mustFind(agent);
    return this.setGrants(agent, checkGrants([...found.grants, ...grants]));
  }

  /** Takes `grants` from what `agent`'s key may do; what it may do now. */
  ungrant(agent: string, grants: readonly string[]): string[] {
    const found = this.mustFind(agent);
    const taking = new Set(checkGrants(grants));
    return this.setGrants(agent, found.grants.filter((g) => !taking.has(g)));
  }

  private setGrants(agent: string, grants: string[]): string[] {
    this.db.prepare("UPDATE mcp_key SET grants_json = ? WHERE agent = ?").run(JSON.stringify(grants), agent);
    return grants;
  }

  /** Removes `agent`'s key, which stops working at once; its calls stay in the log. */
  remove(agent: string): void {
    this.mustFind(agent);
    this.db.prepare("DELETE FROM mcp_key WHERE agent = ?").run(agent);
  }

  /** The agent a key is for, and its grants; null for a key that is not one of them. */
  verify(key: string): { agent: string; grants: string[] } | null {
    if (!key.startsWith(KEY_PREFIX)) return null;
    const row = this.db.prepare("SELECT agent, grants_json, created_at, last_used_at FROM mcp_key WHERE key_sha256 = ?").get(keyHash(key)) as KeyRow | undefined;
    return row ? { agent: row.agent, grants: keyOf(row).grants } : null;
  }

  /** Keeps a call, and when its agent last called. */
  record(call: ToolCallRecord): void {
    this.db
      .prepare("INSERT INTO mcp_call (at, agent, tool, module, access, ok, error, duration_ms, arguments_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(call.at, call.agent, call.tool, call.module, call.access, call.ok ? 1 : 0, call.error, call.durationMs, JSON.stringify(call.arguments ?? {}));
    this.db.prepare("UPDATE mcp_key SET last_used_at = max(coalesce(last_used_at, 0), ?) WHERE agent = ?").run(call.at, call.agent);
  }

  /** The last `last` calls, newest first, of one agent or every one. */
  calls({ agent = null, last = 50 }: { agent?: string | null; last?: number } = {}): ToolCallRecord[] {
    const rows = this.db
      .prepare(`SELECT at, agent, tool, module, access, ok, error, duration_ms, arguments_json FROM mcp_call ${agent === null ? "" : "WHERE agent = ?"} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...(agent === null ? [last] : [agent, last])) as Array<{ at: number; agent: string; tool: string; module: string; access: Access; ok: number; error: string | null; duration_ms: number; arguments_json: string }>;
    return rows.map((r) => ({ at: r.at, agent: r.agent, tool: r.tool, module: r.module, access: r.access, ok: r.ok === 1, error: r.error, durationMs: r.duration_ms, arguments: JSON.parse(r.arguments_json) as unknown }));
  }
}
