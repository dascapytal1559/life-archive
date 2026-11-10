import type { ConnectorManifest } from "../../../../sdk/connector.ts";

export const manifest: ConnectorManifest = {
  id: "polar-export",
  label: "Polar's account export",
  platform: "polar",
  sourceKind: "export",
  capabilities: { history: true, sync: false, send: false },
  needs: ["export-file"],
  description:
    "Polar's account data export (account.polar.com, Download your data), unpacked in its folder: each training session " +
    "a workout event for the module's index, its file kept where it is, saying which sample streams it holds, never a heart " +
    "rate or a coordinate; the history the live polar connector cannot reach (it sees only the last 30 days)",
  obtain: { from: "platform", step: "request Polar's \"Download your data\" at account.polar.com (the whole account: it takes no dates)" },
  calls: { lengths: null, how: "none: Polar keeps workouts, not chats" },
  encrypted: null,
};
