import type { ConnectorManifest } from "../../../../sdk/connector.ts";

export const manifest: ConnectorManifest = {
  id: "discord-package",
  label: "Discord's data package",
  platform: "discord",
  sourceKind: "export",
  capabilities: { history: true, sync: false, send: false },
  needs: ["export-file"],
  description: "Discord's data package (\"Request your data\") zip (or its folder): the captain's own messages in DMs, group DMs and server channels",
  obtain: {
    from: "platform",
    step: "request Discord's data package (User Settings, Data & Privacy, Request your data) with Messages only",
  },
  calls: {
    lengths: null,
    how:
      "none: the package gives each message only its id, time, text and attachments, so a call is an empty message it does not " +
      "tell from a sticker or an embed (kept, without text, and counted)",
  },
  encrypted: "Discord's messages are not end-to-end encrypted; the package holds the captain's own as Discord keeps them",
};
