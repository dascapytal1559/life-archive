import type { ConnectorManifest } from "../../../../sdk/connector.ts";

export const manifest: ConnectorManifest = {
  id: "facebook-dyi",
  label: "Facebook's messages export",
  platform: "messenger",
  sourceKind: "export",
  capabilities: { history: true, sync: false, send: false },
  needs: ["export-file"],
  description: "Facebook's \"Download your information\" messages export in JSON (a folder of its zip parts, or the zips)",
  obtain: {
    from: "platform",
    step: "request an export of your Facebook information in Accounts Center: Messages only, JSON, from {since}",
  },
  calls: { lengths: "all", how: "call records in their chats, each with how long it was connected (0 when not answered)" },
  encrypted: "leaves out the end-to-end-encrypted chats, all but their history from before they moved: messenger-export brings them",
};
