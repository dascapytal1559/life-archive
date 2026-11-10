import type { ConnectorManifest } from "../../../../sdk/connector.ts";

export const manifest: ConnectorManifest = {
  id: "signal-export",
  label: "Signal Desktop's export",
  platform: "signal",
  sourceKind: "export",
  capabilities: { history: true, sync: false, send: false },
  needs: ["export-file"],
  description: "Signal Desktop's \"Export chat history\" folder (main.jsonl): chats, one-to-one and group",
  obtain: {
    from: "platform",
    step: "export Signal Desktop's chat history (Settings, Chats, Export chat history; everything: it takes no dates)",
  },
  calls: { lengths: "none", how: "one-to-one call records say whether a call was answered, never how long; group calls are only counted" },
  encrypted: "all of Signal is end-to-end encrypted; Signal Desktop's own export holds every chat readable, all but disappearing messages",
};
