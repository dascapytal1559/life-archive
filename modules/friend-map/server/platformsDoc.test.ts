// docs/platforms.md's rows (platformsDoc.ts), held to friend map's connectors' manifests; the core's docs.test.ts holds
// the document to what it writes.

import { describe, expect, it } from "vitest";
import { isPlatform } from "../../../sdk/server.ts";
import { MANIFESTS } from "../connectors/connectors.ts";
import { platformRows } from "./platformsDoc.ts";

describe("docs/platforms.md", () => {
  it("docs/platforms.md has a row for each chat platform's connectors, live first, and none for an event source", () => {
    const rows = platformRows();
    expect(rows.flatMap((row) => row.sources.map((s) => s.connector)).sort()).toEqual(MANIFESTS.filter((m) => isPlatform(m.platform)).map((m) => m.id).sort());
    const whatsapp = rows.find((row) => row.platform === "whatsapp")!.sources;
    expect(whatsapp.map(({ connector, way, renew }) => ({ connector, way, renew }))).toEqual([
      { connector: "matrix-whatsapp", way: "live", renew: "live" },
      { connector: "whatsapp-db", way: "iphone-backup", renew: "whole" },
    ]);
    const sources = new Map(rows.flatMap((row) => row.sources.map((s) => [s.connector, s])));
    expect(sources.get("facebook-dyi")).toMatchObject({ way: "platform", renew: "since" });
    expect(sources.get("call-history")).toMatchObject({ way: "mac", messages: false, encrypted: null });
  });
});
