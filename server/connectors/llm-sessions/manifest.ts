import type { ConnectorManifest } from "../contract.ts";

export const manifest: ConnectorManifest = {
  id: "llm-sessions",
  label: "Claude Code sessions",
  platform: "claude-code",
  cadence: { as: "files-change" },
  sourceKind: "app-db",
  capabilities: { history: true, sync: true, send: false },
  needs: [],
  keepsCopies: true,
  description:
    "The captain's conversations with an LLM, from Claude Code's session files on this Mac (~/.claude/projects), each " +
    "copied into the archive (data/llm/claude-code) and read there, live within seconds of a change: only the projects " +
    "named in its settings (the archive's llmSessions.projects unless said), only sessions someone was at, for the event index, never their text",
  defaultSource: "~/.claude/projects",
  calls: { lengths: null, how: "none: conversations with an LLM, not chats" },
  encrypted: null,
};
