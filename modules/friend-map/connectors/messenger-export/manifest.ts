import type { ConnectorManifest } from "../../../../sdk/connector.ts";

export const manifest: ConnectorManifest = {
  id: "messenger-export",
  label: "Messenger's encrypted chats",
  platform: "messenger",
  sourceKind: "export",
  capabilities: { history: true, sync: false, send: false },
  needs: ["export-file"],
  description: "Messenger's end-to-end-encrypted chat export (the zip from \"Download your message storage data\")",
  obtain: {
    from: "platform",
    step: "download the end-to-end-encrypted chats' message storage in the Messenger phone app (all of it: it takes no dates)",
  },
  calls: { lengths: "none", how: "a call is an empty link, with no length or answer, so each is a call of no known length" },
  encrypted: "the end-to-end-encrypted chats, from the phone app's download of its message storage",
};
