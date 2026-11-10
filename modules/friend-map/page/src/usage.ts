// Reports which view is in use to the local server (POST /api/usage, stored in
// data/usage.jsonl; see server/usage.ts): when a visit to a view began, and
// roughly how long the page was visible. Only visible time counts. Nothing
// about who is on screen is sent, and nothing leaves this Mac.
//
// A visit begins when a view is shown while the page is visible (or first
// becomes visible), and a view shown again after being hidden for half an
// hour or more counts as a new visit, so a tab left open for days still
// shows when the view was really last opened.
//
// The demo (the static demo, demoMode.ts) is not your use of a view: nothing is recorded.

import { useEffect } from "react";
import { demoMode } from "./demoMode.ts";
import { address } from "./mount.ts";

export interface UsageReport {
  view: string;
  /** When the visit began, ms: the same on every report of one visit. */
  opened: number;
  /** Seconds visible since the visit's previous report. */
  seconds: number;
}

/** Visible time is reported at least this often while a view stays open. */
export const FLUSH_MS = 60_000;
/** Hidden for this long, a view shown again is a new visit; sooner (or React remounting it in development), the same one. */
export const NEW_VISIT_AFTER_MS = 30 * 60_000;

/** The timing, with the clock and the network passed in so it can be tested. */
export function createUsageTracker(send: (report: UsageReport) => void, now: () => number = Date.now) {
  /** The view of the current visit, when it began, and since when it has been visible (null while hidden). */
  let view: string | null = null;
  let opened: number | null = null;
  let visibleSince: number | null = null;
  /** When the page was hidden or the view left; null while visible. */
  let awaySince: number | null = null;

  const flush = () => {
    if (view === null || opened === null || visibleSince === null) return;
    const at = now();
    const seconds = Math.round((at - visibleSince) / 1000);
    if (seconds < 1) return;
    visibleSince = at;
    send({ view, opened, seconds });
  };

  return {
    /** The page is visible with `slug` on screen. */
    show(slug: string) {
      if (view === slug && visibleSince !== null) return;
      const at = now();
      const resumed = view === slug && awaySince !== null && at - awaySince < NEW_VISIT_AFTER_MS;
      if (!resumed) {
        view = slug;
        opened = at;
        send({ view, opened, seconds: 0 });
      }
      visibleSince = at;
      awaySince = null;
    },
    /** The page is hidden, or the view is left: report the visible time so far. */
    hide() {
      flush();
      visibleSince = null;
      awaySince ??= now();
    },
    flush,
  };
}

const tracker = createUsageTracker((report) => {
  if (demoMode) return;
  void fetch(address("/api/usage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
    keepalive: true,
  }).catch(() => undefined);
});

/** Records use of the view `slug` while it is on screen. */
export function useUsage(slug: string): void {
  useEffect(() => {
    const onVisibility = () => (document.visibilityState === "visible" ? tracker.show(slug) : tracker.hide());
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", tracker.hide);
    const timer = setInterval(tracker.flush, FLUSH_MS);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", tracker.hide);
      tracker.hide();
    };
  }, [slug]);
}
