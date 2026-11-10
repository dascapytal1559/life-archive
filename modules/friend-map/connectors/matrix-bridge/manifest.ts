import type { ConnectorManifest } from "../../../../sdk/connector.ts";

export const manifest: ConnectorManifest = {
  id: "matrix-bridge",
  label: "Telegram, through the bridge rig",
  platform: "telegram",
  cadence: { as: "messages-come" },
  sourceKind: "live",
  capabilities: { history: true, sync: true, send: true },
  needs: ["companion"],
  description:
    "Telegram, live, through the bridge rig (~/.local/share/friend-map-bridge-lab: the mautrix-telegram bridge and its local " +
    "Tuwunel homeserver), read as the captain's Matrix user; sends text only when asked, and never read receipts, typing or presence",
  defaultSource: "~/.local/share/friend-map-bridge-lab",
  companion: { name: "the bridge rig's homeserver", healthUrl: "http://127.0.0.1:46080/_matrix/client/versions" },
  calls: {
    lengths: "some",
    how:
      "the bridge's notice for each call made or ended while it runs (\"Call ended (12 minutes)\"; it never backfills them), read " +
      "as a call record: a one-to-one call with how long it was connected (0 when missed or rejected); a group's video chat " +
      "with no length unless first seen ended",
  },
  encrypted: "secret chats, Telegram's only end-to-end-encrypted ones, stay on the device that started them, so the bridge never sees them",
};
