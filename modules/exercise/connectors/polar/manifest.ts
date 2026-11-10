import type { ConnectorManifest } from "../../../../sdk/connector.ts";
import { ACCESSLINK } from "./api.ts";

export const manifest: ConnectorManifest = {
  id: "polar",
  label: "Polar Flow workouts",
  platform: "polar",
  cadence: { everyMs: 3 * 3_600_000, settingHours: "pollEveryHours" },
  sourceKind: "live",
  capabilities: { history: true, sync: true, send: false },
  needs: [],
  description:
    "The captain's workouts from Polar Flow (runs recorded through the Flow app, with a chest strap, say), through Polar's " +
    "AccessLink API as his own registered client, after one login (npm run exercise -- polar login; its token in the " +
    "Keychain), looked at when the server starts and every 3 hours: each exercise kept as Polar gave it, its JSON and FIT " +
    "file in platform-exports/polar/accesslink/, and one workout event of each copy for the module's index, saying which " +
    "sample streams it holds, never a heart rate or a coordinate. Only what was uploaded in the last 30 days, after login",
  defaultSource: ACCESSLINK,
  calls: { lengths: null, how: "none: Polar keeps workouts, not chats" },
  encrypted: null,
};
