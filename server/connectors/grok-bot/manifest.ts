import type { ConnectorManifest } from "../contract.ts";

export const manifest: ConnectorManifest = {
  id: "grok-bot",
  label: "Grok Bot conversations",
  platform: "grok-bot",
  cadence: { as: "files-change" },
  sourceKind: "app-db",
  capabilities: { history: true, sync: true, send: false },
  needs: [],
  keepsCopies: true,
  description:
    "The captain's conversations with his Grok Bot bots, from the desktop app's cache on this Mac (its last 200 entries of " +
    "each bot's chat), each entry copied into the archive (data/llm/grok-bot) as it comes and read there, live within " +
    "seconds of a change: the chat window, each call's transcript and the bot's backstage talk with the call, for the " +
    "event index, never their text",
  defaultSource: "~/Library/Application Support/Grok Bot/sand-client-persistence",
  calls: { lengths: null, how: "none: conversations with an LLM, not chats" },
  encrypted: null,
};
