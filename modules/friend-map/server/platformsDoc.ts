// Each chat platform the archive reads, connector by connector, for docs/platforms.md: how its messages arrive (live,
// from an app's database on this Mac, from an iPhone backup, or as an export the platform makes when asked), how its
// calls arrive and whether they say how long they were, how it treats end-to-end-encrypted chats, and how it keeps up.
// All of it comes from friend map's connector manifests (connectors/connectors.ts): their `obtain`, as `npm run archive -- import-status` and docs/import-runbook.md go by, and their `calls` and
// `encrypted`. Written by `npm run docs` (the core's tools/docs/docs.ts, as the module declares it, sdk/server.ts's
// `documents`) and held to the manifests by the core's docs.test.ts.

import { PLATFORMS, type ConnectorManifest } from "../../../sdk/server.ts";
import { MANIFESTS } from "../connectors/connectors.ts";
import { IMPORT_WAYS, wayOf, type ImportWay } from "./importStatus.ts";

const PLATFORM_NAMES: Record<string, string> = {
  messenger: "Messenger", instagram: "Instagram", whatsapp: "WhatsApp", imessage: "iMessage", telegram: "Telegram", x: "X", signal: "Signal", discord: "Discord",
  wechat: "WeChat", phone: "Phone",
};

/** One connector of a platform. */
export interface PlatformSource {
  connector: string;
  way: ImportWay;
  /** Whether it brings messages; the phone's call history (platform "phone") brings only calls. */
  messages: boolean;
  /**
   * How it keeps up: "live" follows along by itself; "since" is imported again with what came since the last import
   * reached (its obtain step takes a date); "whole" is taken whole each time, what the archive has already skipped.
   */
  renew: "live" | "since" | "whole";
  calls: ConnectorManifest["calls"];
  encrypted: string | null;
}

/** One row for each platform some connector reads, in the contract's order, its connectors live first. */
export function platformRows(manifests: readonly ConnectorManifest[] = MANIFESTS): Array<{ platform: string; sources: PlatformSource[] }> {
  const order = (way: ImportWay) => IMPORT_WAYS.findIndex((w) => w.way === way);
  return PLATFORMS.map((platform) => ({
    platform,
    sources: manifests
      .filter((manifest) => manifest.platform === platform && wayOf(manifest) !== null)
      .map((manifest) => ({ manifest, way: wayOf(manifest)! }))
      .sort((a, b) => order(a.way) - order(b.way) || a.manifest.id.localeCompare(b.manifest.id))
      .map(({ manifest, way }): PlatformSource => ({
        connector: manifest.id,
        way,
        messages: platform !== "phone",
        renew: way === "live" ? "live" : manifest.obtain!.step.includes("{since}") ? "since" : "whole",
        calls: manifest.calls,
        encrypted: manifest.encrypted,
      })),
  })).filter((row) => row.sources.length > 0);
}

const RENEW: Record<PlatformSource["renew"], string> = {
  live: "Follows along by itself",
  since: "Import again, from where the last import reached",
  whole: "Import again, whole each time; what the archive has is skipped",
};

function callLengths(calls: PlatformSource["calls"]): string {
  switch (calls.lengths) {
    case "all": return "With their lengths";
    case "some": return "Some with their lengths; Add length for the rest";
    case "none": return "No lengths: Add length";
    default: return "No call records";
  }
}

const cell = (text: string) => text.replace(/\s+/g, " ").replaceAll("|", "\\|");

/** The platforms' table as Markdown. */
export function platformsMarkdown(): string {
  const lines = [
    "# Platforms",
    "",
    "For each chat platform the archive reads, each connector that reads it: how its messages arrive, how its calls arrive and whether they say how long they were, how it treats end-to-end-encrypted chats, and how it keeps up. Each platform's status and when it last synced are in the viewer's Events > Sources.",
    "",
    "Written from the connectors' manifests (`server/connectors/*/manifest.ts`) by `npm run docs`; change a manifest, never this file.",
    "",
    "| Platform | Connector | Way in | Messages | Calls | Encrypted chats | Keeps up |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...platformRows().flatMap(({ platform, sources }) => sources.map((s) => {
      const way = IMPORT_WAYS.find((w) => w.way === s.way)!.name;
      const calls = `${callLengths(s.calls)}: ${s.calls.how}`;
      return `| ${PLATFORM_NAMES[platform] ?? platform} | \`${s.connector}\` | ${way} | ${s.messages ? "Yes" : "No, calls only"} | ${cell(calls)} | ${cell(s.encrypted ?? "None")} | ${RENEW[s.renew]} |`;
    })),
  ];
  return `${lines.join("\n")}\n`;
}
