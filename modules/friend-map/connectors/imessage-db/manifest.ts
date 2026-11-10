import type { ConnectorManifest } from "../../../../sdk/connector.ts";

export const manifest: ConnectorManifest = {
  id: "imessage-db",
  label: "iMessage, SMS and RCS",
  platform: "imessage",
  sourceKind: "app-db",
  capabilities: { history: true, sync: false, send: false },
  needs: ["app-data-access"],
  description:
    "The Messages app's own database (iMessage, SMS and RCS): the iPhone's sms.db with Library/SMS/Attachments/, as taken " +
    "from an iPhone backup, or the Mac's chat.db with its Attachments/, with names from the address book (the Mac's Contacts, or the iPhone's AddressBook.sqlitedb) when given",
  obtain: {
    from: "mac",
    step: "copy the Messages app's chat.db from ~/Library/Messages/, with the attachments that came since {since}",
  },
  calls: { lengths: null, how: "FaceTime calls come from the phone's call history (call-history)" },
  encrypted: "iMessage is end-to-end encrypted on the way; the Messages app's own database holds it readable",
};
