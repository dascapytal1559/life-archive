// Laying a route's shape on a map: its points back as longitudes and latitudes, where they were recorded, and the view
// that shows its box at the pixels the thumbnail has, as its SVG does.

import { describe, expect, it } from "vitest";
import { boundsOf, metresBetween, shapeOf } from "../server/track.ts";
import type { MapPlace } from "../wire.ts";
import { routeBox, shapeToLngLat, viewOf } from "./place.ts";

/** A made-up loop of about a kilometre across, near 37.8° south, far enough from the equator that a degree of longitude is much shorter than one of latitude. */
const loop = Array.from({ length: 400 }, (_, i) => {
  const a = (i / 400) * 2 * Math.PI;
  return { lat: -37.8 + 0.005 * Math.sin(a), lon: 145 + 0.007 * Math.cos(a) * (1 + 0.2 * Math.sin(3 * a)), t: i };
});

describe("a route's shape on a map", () => {
  const shape = shapeOf(loop, 0)!;
  const bounds = boundsOf(loop)!;
  const place: MapPlace = { region: "made-up", maxZoom: 15, south: bounds.south, west: bounds.west };

  it("puts each point back where it was recorded, to within a couple of metres", () => {
    // shapeOf keeps every point at tolerance 0, rounding each to the metre.
    expect(shape.points).toHaveLength(loop.length);
    shape.points.forEach((point, i) => {
      const [lon, lat] = shapeToLngLat(place, shape, point);
      expect(metresBetween({ lat, lon }, loop[i])).toBeLessThan(2);
    });
  });

  it("shows the box at the scale the SVG fits it at, centred on it", () => {
    const wide = 2.2;
    const [width, height] = [740, 200];
    const view = viewOf(place, shape, wide, width, height);
    const box = routeBox(shape, wide);
    const pxPerMetre = Math.min(width / box.width, height / box.height);
    // At zoom z, a metre east at this latitude is 512 · 2^z / (40,075,016.7 · cos φ) pixels (Web Mercator).
    const [, lat] = view.center;
    const atZoom = (512 * 2 ** view.zoom) / (2 * Math.PI * 6_371_000 * Math.cos((lat * Math.PI) / 180));
    expect(atZoom / pxPerMetre).toBeCloseTo(1, 4);
    const [lonMid, latMid] = shapeToLngLat(place, shape, [shape.width / 2, shape.height / 2]);
    expect(view.center).toEqual([lonMid, latMid]);
  });
});
