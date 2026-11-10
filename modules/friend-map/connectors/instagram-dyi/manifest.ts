import type { ConnectorManifest } from "../../../../sdk/connector.ts";

export const manifest: ConnectorManifest = {
  id: "instagram-dyi",
  label: "Instagram's messages export",
  platform: "instagram",
  sourceKind: "export",
  capabilities: { history: true, sync: false, send: false },
  needs: ["export-file"],
  description: "Instagram's \"Download your information\" messages export in JSON, unpacked under data/platform-exports/instagram/<export date>/ (its media are kept there)",
  obtain: {
    from: "platform",
    step: "request an export of your Instagram information in Accounts Center: Messages only, JSON, from {since}",
  },
  calls: { lengths: "all", how: "call records in their chats, each with how long it was connected (0 when not answered)" },
  encrypted:
    "reads what Instagram's download holds; whether it leaves out end-to-end-encrypted chats, as Facebook's does, is not known yet",
};
