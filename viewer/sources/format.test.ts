import { describe, expect, it } from "vitest";
import type { SourceRow } from "../sourcesWire.ts";
import { agoText, broughtParts, cadenceText, spanText, standing } from "./format.ts";

const NOW = Date.parse("2026-11-02T10:00:00+11:00");
const MINUTE = 60_000;

function source(extra: Partial<SourceRow> = {}): SourceRow {
  return {
    connector: "call-history", label: "Phone and FaceTime calls", description: "", platform: "phone", way: "job", runner: "local.life-archive-mac-imports",
    note: null, cadence: { kind: "every", ms: 15 * MINUTE }, overdueAfterMs: 30 * MINUTE, lastOkAt: NOW - 5 * MINUTE, failing: null, live: null,
    enabled: true, brought: { messages: 0, calls: 0, events: {} }, overdue: false, ...extra,
  };
}

describe("the Sources tab's words", () => {
  it("says how often in plain words", () => {
    expect(cadenceText({ kind: "every", ms: 15 * MINUTE })).toBe("every 15 minutes");
    expect(cadenceText({ kind: "every", ms: 3 * 60 * MINUTE })).toBe("every 3 hours");
    expect(cadenceText({ kind: "every", ms: 24 * 60 * MINUTE })).toBe("every day");
    expect(cadenceText({ kind: "weekly", weekday: 1, hour: 5, minute: 0 })).toBe("Mondays at 05:00");
    expect(cadenceText({ kind: "daily", hour: 4, minute: 0 })).toBe("daily at 04:00");
    expect(cadenceText({ kind: "on-demand" })).toBe("on demand");
    expect(spanText(90 * MINUTE)).toBe("90 minutes");
  });

  it("says how long ago", () => {
    expect(agoText(NOW - 10_000, NOW)).toBe("just now");
    expect(agoText(NOW - MINUTE, NOW)).toBe("1 minute ago");
    expect(agoText(NOW - 26 * 60 * MINUTE, NOW)).toBe("1 day ago");
  });

  it("lists what a source brought, the most first", () => {
    expect(broughtParts({ messages: 0, calls: 1, events: { llm_session: 1204 } })).toEqual(["1,204 sessions", "1 call"]);
    expect(broughtParts({ messages: 0, calls: 0, events: {} })).toEqual(["nothing yet"]);
  });

  it("makes an overdue or failing source stand out, and says since when", () => {
    expect(standing(source(), NOW)).toEqual({ text: "On schedule", tone: "ok" });
    expect(standing(source({ overdue: true, lastOkAt: NOW - 60 * MINUTE }), NOW)).toEqual({ text: "Overdue: due every 15 minutes", tone: "alert" });
    expect(standing(source({ overdue: true, lastOkAt: null }), NOW).text).toBe("Overdue: never synced");
    const failing = { since: NOW - 120 * MINUTE, error: "no Full Disk Access" };
    expect(standing(source({ failing }), NOW)).toEqual({ text: "Failing since 2 hours", tone: "alert" });
    expect(standing(source({ failing, overdue: true }), NOW).text).toBe("Overdue: due every 15 minutes; failing since 2 hours");
    expect(standing(source({ cadence: { kind: "off", why: "not installed" }, overdueAfterMs: null }), NOW)).toEqual({ text: "Off", tone: "muted" });
    expect(standing(source({ way: "server", live: { state: "waiting", detail: null, since: NOW } }), NOW)).toEqual({ text: "Waiting for its service", tone: "warn" });
  });
});
