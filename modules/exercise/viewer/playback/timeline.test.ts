// The playback's motion (timeline.ts, camera.ts) on made-up tracks at 0°, 0°, in the sea as the made-up workouts are:
// the recorder's pauses cut, a stop played as it was, the marker gliding (no jumps, never backwards, always on the
// drawn line) and the trail's end exactly at it, the readouts the recording's own, and the camera easing its turns.

import { describe, expect, it } from "vitest";
import type { PlaybackTrack } from "../../wire.ts";
import { followCamera, maplibreView, SHOTS, wrap } from "./camera.ts";
import { rateOf, speedReadout } from "./Playback.tsx";
import { heartRateAt, lerpAt, monotoneCubic, PAUSE_KEPT_S, playbackTimes, smoothed, timelineOf, zoneOf } from "./timeline.ts";

/** A metre in degrees of longitude at the equator. */
const M = 1 / 111_195;

/**
 * A made-up ride east along the equator, a point a second at 5 m/s with a little GPS wander, a 20 s stop at 200 s
 * and the recorder paused for 10 minutes at 300 s; its heart rate climbing a beat every 5 s.
 */
function madeUpTrack(): PlaybackTrack {
  const t: number[] = [];
  const lon: number[] = [];
  const lat: number[] = [];
  const distance: number[] = [];
  let at = 0;
  let d = 0;
  for (let i = 0; i < 500; i++) {
    if (i > 0) {
      const paused = i === 300;
      at += paused ? 600 : 1;
      const stopped = at >= 200 && at < 220;
      d += stopped ? 0 : 5;
    }
    t.push(at);
    distance.push(d);
    lon.push(d * M);
    lat.push(Math.sin(i * 1.7) * 1.5 * M);
  }
  return {
    id: "1", title: "Test ride", start: "2026-10-14T06:50", family: "ride",
    points: { t, lat, lon, distance, altitude: null },
    heartRate: t.map((s) => [s, 100 + Math.floor(s / 5)] as [number, number]),
    zones: [{ zone: 1, from: 90 }, { zone: 2, from: 120 }, { zone: 3, from: 140 }],
    map: { region: "made-up", maxZoom: 14, south: 0, west: 0 },
    terrain: null,
    photoreal: null,
  };
}

describe("the pieces", () => {
  it("cuts the recorder's pauses to a second and keeps the rest of time as it was", () => {
    expect([...playbackTimes([0, 1, 2, 62, 63])]).toEqual([0, 1, 2, 2 + PAUSE_KEPT_S, 3 + PAUSE_KEPT_S]);
  });

  it("passes a monotone cubic through its points, never falling between them", () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = [0, 10, 10, 10, 30];
    const f = monotoneCubic(xs, ys);
    xs.forEach((x, i) => expect(f(x)).toBeCloseTo(ys[i]));
    let last = -Infinity;
    for (let x = 0; x <= 4; x += 0.01) {
      expect(f(x)).toBeGreaterThanOrEqual(last - 1e-9);
      last = f(x);
    }
    // Flat during a stop: no creeping on.
    expect(f(1.5)).toBeCloseTo(10);
    expect(f(-1)).toBe(0);
    expect(f(9)).toBe(30);
  });

  it("smooths, keeping the ends where they are", () => {
    const out = smoothed([0, 10, 0, 10, 0, 10, 0]);
    expect(out[0]).toBe(0);
    expect(out[6]).toBe(0);
    expect(Math.max(...out.slice(2, 5))).toBeLessThan(7);
    expect(lerpAt([0, 10], [0, 100], 2.5)).toBe(25);
  });

  it("reads a heart rate between two readings close together, and none across a strap's dropout or far past the ends", () => {
    expect(heartRateAt([100, 101], [150, 152], 100.5)).toBe(151);
    expect(heartRateAt([100, 700], [150, 110], 400)).toBeNull();
    expect(heartRateAt([100, 101], [150, 152], 120)).toBe(152);
    expect(heartRateAt([100, 101], [150, 152], 200)).toBeNull();
    expect(heartRateAt([100, 101], [150, 152], 50)).toBeNull();
    expect(heartRateAt([], [], 0)).toBeNull();
  });

  it("tells a heart rate's zone by the zones' lower limits", () => {
    const zones = [{ zone: 1, from: 90 }, { zone: 2, from: 120 }];
    expect(zoneOf(80, zones)).toBeNull();
    expect(zoneOf(90, zones)).toBe(1);
    expect(zoneOf(130, zones)).toBe(2);
    expect(zoneOf(null, zones)).toBeNull();
    expect(zoneOf(130, [])).toBeNull();
  });
});

describe("the timeline", () => {
  const track = madeUpTrack();
  const timeline = timelineOf(track);

  it("lasts the time recorded less the pause", () => {
    expect(timeline.duration).toBe(499 - 1 + PAUSE_KEPT_S);
    expect(timeline.totalDistance).toBe(track.points.distance.at(-1));
  });

  it("starts at the start and ends at the end", () => {
    const first = timeline.frameAt(0);
    const last = timeline.frameAt(timeline.duration + 50);
    expect(first.lng).toBeCloseTo(0, 9);
    expect(first.progress).toBe(0);
    expect(last.lng).toBeCloseTo(track.points.lon.at(-1)!, 9);
    expect(last.progress).toBeCloseTo(1);
    expect(last.distance).toBe(track.points.distance.at(-1));
  });

  it("glides: at sixty frames a second the marker moves on smoothly, never back, its trail ending where it is", () => {
    let last = timeline.frameAt(0);
    let lastStep: number | null = null;
    for (let at = 1 / 60; at < timeline.duration; at += 1 / 60) {
      const frame = timeline.frameAt(at);
      const step = (frame.lng - last.lng) / M;
      expect(step).toBeGreaterThanOrEqual(-1e-6);
      // 5 m/s is 0.083 m a frame; the speed eases rather than jumps between samples (into a stop too, over its second).
      expect(step).toBeLessThan(0.2);
      if (lastStep !== null) expect(Math.abs(step - lastStep)).toBeLessThan(0.02);
      expect(frame.progress).toBeGreaterThanOrEqual(last.progress - 1e-9);
      // The marker is on the drawn line, between its points `index` and the next.
      const [a, b] = [timeline.line[frame.index], timeline.line[frame.index + 1]];
      expect(frame.lng).toBeCloseTo(a[0] + (b[0] - a[0]) * frame.share, 12);
      lastStep = step;
      last = frame;
    }
  });

  it("holds the marker still through a stop, and the GPS's wander there is not played", () => {
    // Well inside the stop (200 s to 220 s), past the smoothing's reach of the moving either side.
    const stopped = [208, 210, 212].map((s) => timeline.frameAt(s));
    for (const frame of stopped) {
      expect(frame.lng).toBeCloseTo(stopped[0].lng, 9);
      expect(frame.lat).toBeCloseTo(stopped[0].lat, 9);
      expect(frame.speed).toBe(0);
    }
  });

  it("smooths the wander out of the line, and heads the way of travel", () => {
    // On the move (the wander is 1.5 m either side, a point to the next).
    const wander = Math.max(...timeline.line.slice(10, 190).map(([, lat]) => Math.abs(lat))) / M;
    expect(wander).toBeLessThan(0.1);
    expect(timeline.frameAt(100).heading).toBeCloseTo(90, 0);
  });

  it("reads the recording's own numbers at the moment", () => {
    const frame = timeline.frameAt(100);
    expect(frame.elapsed).toBeCloseTo(100);
    expect(frame.distance).toBeCloseTo(500);
    expect(frame.speed).toBeCloseTo(5);
    expect(frame.heartRate).toBe(120);
    expect(frame.zone).toBe(2);
    // After the pause, the recorder's clock has the pause in it.
    expect(timeline.frameAt(350).elapsed).toBeCloseTo(350 - PAUSE_KEPT_S + 600 - 1 + 1, 0);
  });

  it("finds a point ahead along the line", () => {
    const [lng] = timeline.pointAhead(100, 50);
    expect((lng - timeline.frameAt(100).lng) / M).toBeCloseTo(50, 0);
  });
});

describe("the camera", () => {
  it("turns the short way round, eased, the same at any frame rate", () => {
    expect(wrap(350)).toBe(-10);
    expect(wrap(-190)).toBe(170);
    const fast = followCamera({ target: [0, 0], heading: 350 });
    const slow = followCamera({ target: [0, 0], heading: 350 });
    for (let i = 0; i < 60; i++) fast.step(1 / 60, [0, 0], 10);
    for (let i = 0; i < 10; i++) slow.step(1 / 10, [0, 0], 10);
    // Through north, not round by the south.
    const heading = fast.state.heading;
    expect(heading < 10 || heading > 350).toBe(true);
    expect(wrap(fast.state.heading - slow.state.heading)).toBeCloseTo(0, 6);
    expect(fast.snap([1, 1], 200).heading).toBe(200);
  });

  it("eases from following to the flyover's wider shot", () => {
    const camera = followCamera({ target: [0, 0], heading: 0 });
    camera.shot = "flyover";
    for (let i = 0; i < 600; i++) camera.step(1 / 60, [0, 0], 0);
    expect(camera.state.range).toBeCloseTo(SHOTS.flyover.range, -1);
    expect(camera.state.tilt).toBeCloseTo(SHOTS.flyover.tilt, 0);
  });

  it("gives MapLibre the zoom that puts the camera its range away: half the range, one zoom in", () => {
    const state = { target: [0, 0] as [number, number], heading: 30, tilt: 60, range: 1000 };
    const far = maplibreView(state, 900);
    const near = maplibreView({ ...state, range: 500 }, 900);
    expect(near.zoom - far.zoom).toBeCloseTo(1);
    expect(far).toMatchObject({ center: [0, 0], bearing: 30, pitch: 60 });
  });
});

describe("the controls", () => {
  it("plays at the times asked, and flies the whole route in under a minute", () => {
    expect(rateOf(4, 2600)).toBe(4);
    expect(rateOf("flyover", 2600) * 45).toBeCloseTo(2600);
    expect(rateOf("flyover", 10)).toBe(1);
  });

  it("writes the moment's speed as the sport does", () => {
    expect(speedReadout("speed", 25 / 3.6)).toBe("25.0 km/h");
    expect(speedReadout("pace", 1000 / 300)).toBe("5:00 /km");
    expect(speedReadout("pace", 0)).toBe("—");
  });
});
