import type { ConnectorManifest } from "../../../../sdk/connector.ts";

export const manifest: ConnectorManifest = {
  id: "wechat-ios",
  label: "WeChat, from an iPhone backup",
  platform: "wechat",
  sourceKind: "app-db",
  capabilities: { history: true, sync: false, send: false },
  needs: ["app-data-access"],
  description:
    "WeChat's own databases as the iPhone app keeps them (WCDB_Contact.sqlite, MM.sqlite, message_<n>.sqlite and the chats' " +
    "Img, Video, Audio and OpenData folders), taken out of an iPhone backup by npm run extract-wechat",
  obtain: {
    from: "iphone-backup",
    step: "take a new iPhone backup (Finder, over Wi-Fi), then npm run extract-wechat",
  },
  calls: {
    lengths: "some",
    how: "call records with how long each was connected, all but those WeChat compressed, which only its dictionary reads",
  },
  encrypted: "WeChat is not end-to-end encrypted; the Mac app encrypts its databases on disk, so the iPhone backup's are read",
};
