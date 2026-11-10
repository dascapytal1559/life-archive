import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveEvent, type Db, type LiveState, loadRegistry, type ObtainStep, transaction } from "../../../sdk/server.ts";
import { loadModules, moduleConnectors } from "../../../sdk/testing.ts";
import { openArchive } from "./db.ts";
import { importStatus, type ImportStatusConnector, type ImportWay } from "./importStatus.ts";
import { ImportSession } from "./write.ts";

let db: Db;

beforeEach(() => {
  db = openArchive(":memory:");
});

afterEach(() => {
  db.close();
});

/** A time on a Melbourne day (AEDT in October). */
const at = (day: string, time = "12:00") => Date.parse(`${day}T${time}:00+11:00`);
const NOW = at("2026-10-09");

/** An import by `connector` that ended as `status`, applying `events`. */
function imported(connector: string, platform: string, kind: "export" | "app-db" | "live", status: "ok" | "failed" | "running", finishedAt: number | null, events: ArchiveEvent[] = []): void {
  transaction(db, () => {
    const source = Number(db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, finished_at, status) VALUES (?, ?, ?, 'sample', 0, ?, ?)")
      .run(platform, connector, kind, finishedAt, status).lastInsertRowid);
    const session = new ImportSession(db, platform, source, kind);
    for (const event of events) session.apply(event);
  });
}

/** One message from a friend at `sentAt`, in a chat of its own. */
function messageAt(sentAt: number, id = `m${sentAt}`): ArchiveEvent[] {
  return [
    { kind: "account", key: "Ada Sample", keyKind: "name", displayName: "Ada Sample" },
    { kind: "conversation", id: `chat-${id}`, type: "direct", members: ["Ada Sample"] },
    { kind: "message", id, idKind: "platform", conversation: `chat-${id}`, sender: "Ada Sample", isFromSelf: false, sentAt, type: "text", text: "hi", raw: {} },
  ];
}

const STEPS: Record<string, ObtainStep> = {
  "facebook-dyi": { from: "platform", step: "request the download, from {since}" },
  "messenger-export": { from: "platform", step: "download the message storage" },
  "call-history": { from: "mac", step: "copy CallHistory.storedata" },
  "whatsapp-db": { from: "iphone-backup", step: "take a new iPhone backup" },
};

function connector(id: string, platform: string, extra: Partial<ImportStatusConnector> = {}): ImportStatusConnector {
  const live = id.startsWith("matrix-");
  return {
    id,
    platform,
    enabled: true,
    lastOkAt: null,
    lastError: null,
    capabilities: { history: true, sync: live, send: false },
    obtain: STEPS[id] ?? null,
    ...extra,
  };
}

const connected: LiveState = { state: "connected", detail: null, since: 0 };

describe("importStatus", () => {
  it("lists the connectors imported from, live first, then this Mac, an iPhone backup and the platforms, and the rest apart", () => {
    imported("facebook-dyi", "messenger", "export", "ok", at("2026-10-05"), [{ kind: "coverage", from: at("2016-01-01"), to: at("2026-10-04", "21:30") }]);
    imported("call-history", "phone", "app-db", "ok", at("2026-10-06"), [{ kind: "coverage", from: at("2025-01-01"), to: at("2026-10-06", "08:00") }]);
    imported("matrix-whatsapp", "whatsapp", "live", "ok", at("2026-10-07"), messageAt(at("2026-10-08")));
    imported("messenger-export", "messenger", "export", "failed", at("2026-10-01"));

    const report = importStatus(db, [
      connector("call-history", "phone"),
      connector("facebook-dyi", "messenger"),
      connector("matrix-whatsapp", "whatsapp", { live: connected, lastOkAt: at("2026-10-09", "09:00") }),
      connector("messenger-export", "messenger"),
      connector("whatsapp-db", "whatsapp"),
    ], NOW);

    expect(report.used.map((row) => [row.way, row.connector])).toEqual([
      ["live", "matrix-whatsapp"],
      ["mac", "call-history"],
      ["platform", "facebook-dyi"],
    ]);
    // A failed import is no import: Messenger's phone export was never brought in.
    expect(report.unused.map((row) => row.connector)).toEqual(["whatsapp-db", "messenger-export"]);

    const [whatsapp, calls, facebook] = report.used;
    // The live session still running has its last good batch only in the connector's state.
    expect(whatsapp).toMatchObject({ lastImportAt: at("2026-10-09", "09:00"), coversTo: null, newestAt: at("2026-10-08"), next: "nothing: it follows along by itself" });
    expect(calls).toMatchObject({ lastImportAt: at("2026-10-06"), coversTo: at("2026-10-06", "08:00"), newestAt: null, next: "copy CallHistory.storedata" });
    // {since} is the Melbourne day its imports reach.
    expect(facebook).toMatchObject({ coversTo: at("2026-10-04", "21:30"), next: "request the download, from 2026-10-04" });
    // An import of a platform whose live connector is connected only fills a gap in it.
    expect(report.unused[0].next).toBe("nothing while matrix-whatsapp is connected; only to fill a gap in it, or reach back before it");
    expect(report.unused[1].next).toBe("download the message storage");
  });

  it("asks for everything, from the start, before a first import, and the step itself when the live connector is not connected", () => {
    const report = importStatus(db, [
      connector("facebook-dyi", "messenger"),
      connector("whatsapp-db", "whatsapp"),
      connector("matrix-whatsapp", "whatsapp", { live: { state: "waiting", detail: null, since: 0 } }),
    ], NOW);
    expect(report.used).toEqual([]);
    expect(Object.fromEntries(report.unused.map((row) => [row.connector, row.next]))).toEqual({
      "facebook-dyi": "request the download, from the start",
      "whatsapp-db": "take a new iPhone backup",
      "matrix-whatsapp": "check the bridge rig: it is waiting",
    });
  });

  it("says how a live connector is doing, or that the server cannot say", () => {
    imported("matrix-bridge", "telegram", "live", "ok", at("2026-10-07"));
    const next = (extra: Partial<ImportStatusConnector>) => importStatus(db, [connector("matrix-bridge", "telegram", extra)], NOW).used[0].next;
    expect(next({ live: undefined })).toMatch(/^the server does not answer/);
    expect(next({ live: null })).toBe("the server does not run it: restart the server");
    expect(next({ live: { state: "logged-out", detail: "no Telegram login", since: 0 } })).toBe("check the bridge rig: it is logged-out (no Telegram login)");
    expect(next({ enabled: false, live: connected })).toBe("switched off: npm run archive -- enable matrix-bridge, then restart the server");
  });

  it("leaves out a connector with no way to obtain it, and one with no platform (its manifest failed to load)", () => {
    imported("broken", "messenger", "export", "ok", at("2026-10-01"));
    const report = importStatus(db, [connector("broken", "messenger"), { ...connector("unknown", "messenger"), platform: null }], NOW);
    expect(report).toEqual({ generatedAt: NOW, used: [], unused: [] });
  });
});

describe("every connector", () => {
  it("says how a fresh copy is had unless it is live, and has its steps in docs/import-runbook.md, under its way", async () => {
    const runbook = await readFile(new URL("../../../docs/import-runbook.md", import.meta.url), "utf8");
    // Each connector's section, headed by its id, and the way its part of the runbook is about.
    const sections = new Map<string, ImportWay | undefined>();
    let way: ImportWay | undefined;
    for (const line of runbook.split("\n")) {
      if (line.startsWith("## ")) way = WAY_PARTS[line.slice(3)];
      const id = /^#{3,4} `([a-z0-9-]+)`$/.exec(line)?.[1];
      if (id) sections.set(id, way);
    }
    // The core's connectors, and the modules' (the exercise module's polar and polar-export), which the runbook has sections for too.
    const registry = [...(await loadRegistry()), ...moduleConnectors(await loadModules({ all: true }))];
    expect(registry.length).toBeGreaterThan(0);
    for (const { id, manifest } of registry) {
      expect(manifest, id).not.toBeNull();
      if (manifest!.capabilities.sync) expect(manifest!.obtain, id).toBeUndefined();
      else expect(manifest!.obtain?.step, id).toBeTruthy();
      expect([...sections.keys()], `docs/import-runbook.md has no section headed \`${id}\``).toContain(id);
      expect(sections.get(id), `${id}'s section is under the wrong part of docs/import-runbook.md`).toBe(manifest!.capabilities.sync ? "live" : manifest!.obtain!.from);
    }
    // And no section for a connector that is not there any more.
    expect([...sections.keys()].filter((id) => !registry.some((entry) => entry.id === id))).toEqual([]);
  });
});

/** The runbook's parts, by their headings, and the way each is about. */
const WAY_PARTS: Record<string, ImportWay> = {
  "Live: nothing to import": "live",
  "From this Mac": "mac",
  "From an iPhone backup": "iphone-backup",
  "From the platform": "platform",
};
