import type { ConnectorManifest } from "../../../../sdk/connector.ts";

export const manifest: ConnectorManifest = {
  id: "matrix-whatsapp",
  label: "WhatsApp, through the bridge rig",
  platform: "whatsapp",
  cadence: { as: "messages-come" },
  sourceKind: "live",
  // Read only for now (the captain's choice, for the first weeks): the composer offers no WhatsApp chat, and a send is refused.
  capabilities: { history: true, sync: true, send: false },
  needs: ["companion"],
  description:
    "WhatsApp, live, through the bridge rig (~/.local/share/friend-map-bridge-lab: the mautrix-whatsapp bridge, linked to the " +
    "captain's number as a linked device, and the rig's local Tuwunel homeserver), read as the captain's Matrix user with the " +
    "matrix-bridge connector's reader; keyed by phone number as whatsapp-db is, so live and imported messages are one; " +
    "never sends messages, read receipts, typing or presence",
  defaultSource: "~/.local/share/friend-map-bridge-lab",
  companion: { name: "the bridge rig's homeserver", healthUrl: "http://127.0.0.1:46080/_matrix/client/versions" },
  calls: {
    lengths: null,
    how: "the bridge passes on no call's length or outcome, only a notice when a call rings on it, kept as a system message; WhatsApp's calls come from whatsapp-db",
  },
  encrypted: "all of WhatsApp is end-to-end encrypted; the bridge is one of the captain's own linked devices, so it reads every chat",
};
