import type { ConnectorManifest } from "../../../../sdk/connector.ts";

export const manifest: ConnectorManifest = {
  id: "x-archive",
  label: "X's archive",
  platform: "x",
  sourceKind: "export",
  capabilities: { history: true, sync: false, send: false },
  needs: ["export-file"],
  description: "X's \"Download an archive of your data\" zip (or its folder): direct messages, one-to-one and group",
  obtain: {
    from: "platform",
    step: "request X's \"Download an archive of your data\" (Settings, Your account; the whole archive: it takes no dates)",
  },
  calls: { lengths: null, how: "none: the archive holds no calls (its direct messages are messages, joins and leaves; XChat's, messages, read marks and key changes)" },
  encrypted: "XChat, X's newer end-to-end-encrypted chats, cannot be read from the archive: they are only counted",
};
