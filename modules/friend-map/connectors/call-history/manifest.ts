import type { ConnectorManifest } from "../../../../sdk/connector.ts";

export const manifest: ConnectorManifest = {
  id: "call-history",
  label: "Phone and FaceTime calls",
  platform: "phone",
  sourceKind: "app-db",
  capabilities: { history: true, sync: false, send: false },
  needs: ["app-data-access"],
  description:
    "The phone's call history (phone and FaceTime calls): a copy of CallHistory.storedata, as iCloud keeps it on the Mac " +
    "in ~/Library/Application Support/CallHistoryDB/, with names from the address book (the Mac's Contacts, or the iPhone's AddressBook.sqlitedb) when given",
  obtain: {
    from: "mac",
    step: "copy CallHistory.storedata from ~/Library/Application Support/CallHistoryDB/",
  },
  calls: {
    lengths: "all",
    how: "every phone and FaceTime call the call history keeps (about a year back): when, how long, which way, answered or not",
  },
  encrypted: null,
};
