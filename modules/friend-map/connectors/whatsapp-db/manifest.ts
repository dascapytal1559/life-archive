import type { ConnectorManifest } from "../../../../sdk/connector.ts";

export const manifest: ConnectorManifest = {
  id: "whatsapp-db",
  label: "WhatsApp's own databases",
  platform: "whatsapp",
  sourceKind: "app-db",
  capabilities: { history: true, sync: false, send: false },
  needs: ["app-data-access"],
  description:
    "WhatsApp's own databases (ChatStorage.sqlite, CallHistory.sqlite, LID.sqlite, ContactsV2.sqlite and Message/Media/) in a folder, " +
    "as taken from an iPhone backup or the Mac app (its calls alone, daily: npm run whatsapp-mac-calls), with names from the address book (the Mac's Contacts, or the iPhone's AddressBook.sqlitedb) when given",
  obtain: {
    from: "iphone-backup",
    step: "take a new iPhone backup, then copy WhatsApp's ChatStorage.sqlite, CallHistory.sqlite, LID.sqlite and Message/Media/ out of it",
  },
  calls: {
    lengths: "some",
    how:
      "WhatsApp's call history and the call records in its chats: which way, voice or video, answered or not, and how long, all " +
      "but one answered on another device; a three-way call outside a group is a call with each person the copy knows, the rest counted unnamed",
  },
  encrypted: "all of WhatsApp is end-to-end encrypted; the app's own databases hold every chat readable",
};
