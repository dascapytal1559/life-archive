// Where the warehouse finds every LLM session on this Mac: each tool's own folders (WAREHOUSE_SOURCES), and, for a
// session its tool has since deleted (Claude Code deletes a session 30 days after it last changed), the copy the
// archive keeps of every transcript (archive/transcripts.ts: data/transcripts/<source>/<its path>.zst, its index
// saying when the tool's file went). A session is found once: a tool's file when it is there, else the archive's copy.
// Codex's rollout rewritten as .jsonl.zst is the same session as the .jsonl it was: the .jsonl's copy is passed over
// while the .zst is there.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TRANSCRIPTS_FOLDER, versionFile, type SourceIndex } from "../archive/transcripts.ts";
import { pathSetting } from "../dataHome.ts";
import { GROK_FILES } from "./grok.ts";

/** How a source's sessions are laid out, and so read. */
export type SourceKind = "claude" | "codex" | "grok" | "pi";

/** One tool's folder of sessions, and where its files are in the archive's copies (the transcripts source and the folder's path there). */
export interface WarehouseSource {
  kind: SourceKind;
  /** The home it is in, as a session's facts say it: claude, a Claude profile's name, codex, grok, pi. */
  account: string;
  root: string;
  copies?: { source: string; prefix: string };
}

/**
 * Every tool folder on this machine: each tool's own, and each Claude
 * Code profile found in `profiles` (CLAUDE_PROFILES_DIR, .env.example: a folder of profiles, each <name>/projects; none
 * unless named).
 */
export function warehouseSources(home = homedir(), profiles: string | null = pathSetting("CLAUDE_PROFILES_DIR") ?? null): WarehouseSource[] {
  const folder = profiles;
  const named = folder !== null && existsSync(folder) ? readdirSync(folder).filter((name) => existsSync(join(folder, name, "projects"))).sort() : [];
  return [
    { kind: "claude", account: "claude", root: join(home, ".claude", "projects"), copies: { source: "claude-code", prefix: "projects" } },
    ...named.map((name): WarehouseSource => ({ kind: "claude", account: name, root: join(folder!, name, "projects"), copies: { source: "claude-profiles", prefix: `${name}/projects` } })),
    { kind: "codex", account: "codex", root: join(home, ".codex", "sessions"), copies: { source: "codex", prefix: "sessions" } },
    { kind: "codex", account: "codex", root: join(home, ".codex", "archived_sessions"), copies: { source: "codex", prefix: "archived_sessions" } },
    { kind: "grok", account: "grok", root: join(home, ".grok", "sessions") },
    { kind: "pi", account: "pi", root: join(home, ".pi", "agent", "sessions"), copies: { source: "pi", prefix: "sessions" } },
  ];
}

/** One session to read: its tool's path (its key in the bookmarks), and the archive's copy to read when the tool's file is gone. */
export interface SessionFile {
  source: WarehouseSource;
  /** Its path in the tool's folder: a file, or a Grok session's folder. */
  path: string;
  /** Its path below the source's root. */
  rel: string;
  /** The archive's copy (a .zst), when the tool no longer has it. */
  stored?: string;
  size: number;
  mtimeMs: number;
  subagent: boolean;
}

/** Whether `rel` (below a source's root) is one of its sessions, and a subagent's. */
function sessionOf(kind: SourceKind, rel: string): { subagent: boolean } | null {
  const parts = rel.split("/");
  if (kind === "claude") {
    if (parts.length === 2 && parts[1].endsWith(".jsonl")) return { subagent: false };
    if (parts.length === 4 && parts[2] === "subagents" && /^agent-.*\.jsonl$/.test(parts[3])) return { subagent: true };
    return null;
  }
  if (kind === "codex") return /^rollout-.*\.jsonl(\.zst)?$/.test(parts.at(-1)!) ? { subagent: false } : null;
  if (kind === "pi") return parts.length === 2 && parts[1].endsWith(".jsonl") ? { subagent: false } : null;
  // A Grok session is a folder (sessionFiles finds it by its chat_history.jsonl); no file is one (the CLI's
  // prompt_history.jsonl beside them is its own).
  return null;
}

/** Every session file a source has, its tool's and the copies of those since gone (`dataDir`, the archive's folder, for its copies). */
export function sessionFiles(source: WarehouseSource, dataDir: string | null): SessionFile[] {
  const found = new Map<string, SessionFile>();
  const walk = (rel: string, depth: number) => {
    const path = rel ? join(source.root, rel) : source.root;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      let info;
      try {
        info = statSync(join(source.root, childRel));
      } catch {
        continue;
      }
      if (source.kind === "grok" && depth === 1 && info.isDirectory()) {
        // Its bookmark is all its files' together, so an update to its summary or usage alone reads it again.
        const stats = GROK_FILES.flatMap((name) => {
          const file = join(source.root, childRel, name);
          return existsSync(file) ? [{ name, stat: statSync(file) }] : [];
        });
        if (stats.some((s) => s.name === "chat_history.jsonl")) {
          const size = stats.reduce((n, s) => n + s.stat.size, 0);
          const mtimeMs = Math.max(...stats.map((s) => s.stat.mtimeMs));
          found.set(childRel, { source, path: join(source.root, childRel), rel: childRel, size, mtimeMs, subagent: false });
        }
        continue;
      }
      if (info.isDirectory()) {
        if (depth < 4) walk(childRel, depth + 1);
        continue;
      }
      const session = sessionOf(source.kind, childRel);
      if (session) found.set(childRel, { source, path: join(source.root, childRel), rel: childRel, size: info.size, mtimeMs: info.mtimeMs, subagent: session.subagent });
    }
  };
  walk("", 0);
  if (source.copies && dataDir) {
    const indexFile = join(dataDir, TRANSCRIPTS_FOLDER, `${source.copies.source}.json`);
    const index = existsSync(indexFile) ? (JSON.parse(readFileSync(indexFile, "utf8")) as SourceIndex) : null;
    const prefix = `${source.copies.prefix}/`;
    for (const [rel, entry] of Object.entries(index?.files ?? {})) {
      if (!rel.startsWith(prefix)) continue;
      const own = rel.slice(prefix.length);
      if (found.has(own) || (own.endsWith(".jsonl") && found.has(`${own}.zst`))) continue;
      const session = sessionOf(source.kind, own);
      if (!session) continue;
      found.set(own, {
        source, path: join(source.root, own), rel: own, stored: join(dataDir, TRANSCRIPTS_FOLDER, source.copies.source, versionFile(rel, entry.versions)),
        size: entry.size, mtimeMs: entry.mtimeMs, subagent: session.subagent,
      });
    }
  }
  return [...found.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}
