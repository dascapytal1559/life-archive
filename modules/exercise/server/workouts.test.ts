// The matcher and the order of most detail (workouts.ts), on made-up copies: the same activity across sources by
// family, start and overlap; three sources in one chain; an activity of one copy kept; and each rule of most detail
// deciding in its order.

import { describe, expect, it } from "vitest";
import { activities, moreDetail, sameActivity, trustRule, trustRules, type WorkoutCopy } from "./workouts.ts";

const T0 = Date.parse("2026-10-14T19:50:00Z");
const MIN = 60_000;

function copy(origin: string, nativeId: string, change: Partial<WorkoutCopy> = {}): WorkoutCopy {
  return {
    origin, nativeId, event: null, family: "run", at: T0, endAt: T0 + 30 * MIN, distanceMeters: 5000, recorder: null, streams: {},
    summaryHeartRate: false, trustedHeartRate: false, ...change,
  };
}

const HR = { heartRate: { samples: 1800, everySeconds: 1 } };

describe("the same activity", () => {
  it("is one sport family, starting within two minutes, sharing 80% of the shorter", () => {
    const polar = copy("polar", "a");
    expect(sameActivity(polar, copy("strava", "b", { at: T0 + 2 * MIN, endAt: T0 + 31 * MIN }))).toBe(true);
    expect(sameActivity(polar, copy("strava", "b", { at: T0 + 2 * MIN + 1, endAt: T0 + 31 * MIN }))).toBe(false);
    expect(sameActivity(polar, copy("strava", "b", { family: "ride" }))).toBe(false);
    // A copy cut short shares little of the other.
    expect(sameActivity(copy("polar", "a", { endAt: T0 + 10 * MIN }), copy("strava", "b", { at: T0 + 1 * MIN, endAt: T0 + 3 * MIN }))).toBe(true);
    expect(sameActivity(copy("polar", "a", { at: T0, endAt: T0 + 10 * MIN }), copy("strava", "b", { at: T0 + 2 * MIN, endAt: T0 + 30 * MIN }))).toBe(true);
    expect(sameActivity(copy("polar", "a", { at: T0, endAt: T0 + 5 * MIN }), copy("strava", "b", { at: T0 + 2 * MIN, endAt: T0 + 30 * MIN }))).toBe(false);
  });

  it("joins copies from three sources in one chain, keeps a run only one has, and lists every copy", () => {
    const polar = copy("polar", "api", { streams: HR, trustedHeartRate: true });
    const exported = copy("polar", "export/1", { at: T0 + 10_000, streams: HR, trustedHeartRate: true });
    const strava = copy("strava", "s1", { at: T0 + 90_000, streams: { gps: { samples: 1800, everySeconds: 1 } } });
    const alone = copy("strava", "s2", { at: T0 + 24 * 60 * MIN, endAt: T0 + 24 * 60 * MIN + 20 * MIN });
    const found = activities([strava, alone, exported, polar]);
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({ chosen: alone, decidedBy: null, others: [] });
    expect([found[1].chosen, ...found[1].others].map((c) => c.nativeId).sort()).toEqual(["api", "export/1", "s1"]);
    expect(found[1].others.at(-1)).toBe(strava);
  });
});

describe("the most detail", () => {
  const rules: Array<[string, WorkoutCopy, WorkoutCopy]> = [
    ["trusted-heart-rate", copy("strava", "a", { summaryHeartRate: true, trustedHeartRate: true }), copy("polar", "b", { streams: { ...HR, rr: { samples: 9, everySeconds: null } } })],
    ["heart-rate-samples", copy("strava", "a", { streams: HR }), copy("by-hand", "b", { summaryHeartRate: true })],
    ["rr", copy("strava", "a", { streams: { ...HR, rr: { samples: 9, everySeconds: null } } }), copy("polar", "b", { streams: { ...HR, gps: { samples: 1, everySeconds: 1 } } })],
    ["gps", copy("strava", "a", { streams: { ...HR, gps: { samples: 1, everySeconds: 1 } } }), copy("polar", "b", { streams: { ...HR, cadence: { samples: 9, everySeconds: 1 } } })],
    ["more-streams", copy("strava", "a", { streams: { ...HR, cadence: { samples: 9, everySeconds: 1 } } }), copy("polar", "b", { streams: HR })],
    ["sample-rate", copy("strava", "a", { streams: { heartRate: { samples: 1800, everySeconds: 1 } } }), copy("polar", "b", { streams: { heartRate: { samples: 360, everySeconds: 5 } } })],
    ["maker", copy("polar", "a", { streams: HR }), copy("strava", "b", { streams: HR })],
  ];

  it.each(rules)("is decided by %s before anything after it", (rule, better, worse) => {
    expect(moreDetail(better, worse)).toBeLessThan(0);
    expect(moreDetail(worse, better)).toBeGreaterThan(0);
    const [activity] = activities([worse, better]);
    expect(activity.chosen).toBe(better);
    expect(activity.decidedBy).toBe(rule);
  });
});

describe("the captain's trust rule", () => {
  it("trusts a named recorder's heart rate, and nothing without heart rate or by another recorder", () => {
    const rules = [{ device: "Polar Flow app", sensor: "Polar H10" }];
    expect(trustRule(rules, { recorder: "Polar Flow app", streams: HR, summaryHeartRate: false })).toEqual(rules[0]);
    expect(trustRule(rules, { recorder: "Sample watch", streams: HR, summaryHeartRate: false })).toBeNull();
    expect(trustRule(rules, { recorder: "Polar Flow app", streams: {}, summaryHeartRate: false })).toBeNull();
    expect(trustRules({})).toEqual([]);
    expect(trustRules({ trustedHeartRate: rules })).toEqual(rules);
    expect(trustRules({ trustedHeartRate: [{ sensor: "Polar H10" }] })).toBeInstanceOf(Error);
    expect(trustRules({ trustedHeartRate: "Polar Flow app" })).toBeInstanceOf(Error);
  });
});
