// Laying a route's shape (metres east and north of its south-west corner; ../server/track.ts's shapeOf) on a map:
// its points as longitudes and latitudes, and the view (centre and zoom) that shows its box at a size in pixels.

import type { MapPlace, Shape } from "../wire.ts";

/** The earth's radius and degrees as ../server/track.ts flattens a route with, so this undoes it exactly. */
const EARTH_M = 6_371_000;
const RAD = Math.PI / 180;
const KY = EARTH_M * RAD;

/** Metres per degree of longitude about the shape's middle latitude, as shapeOf flattened it. */
function metresPerLon(place: MapPlace, shape: Shape): number {
  return KY * Math.cos((place.south + shape.height / KY / 2) * RAD);
}

/** A point of the shape, [x, y] metres from its south-west corner, as [longitude, latitude]. */
export function shapeToLngLat(place: MapPlace, shape: Shape, [x, y]: readonly [number, number]): [number, number] {
  return [place.west + x / metresPerLon(place, shape), place.south + y / KY];
}

/**
 * The box a route is drawn in, in the shape's metres: square and a little larger than the route (a nearly straight
 * one still gets room), widened `wide` times for the feed's thumbnail. RouteShape's SVG view and the map behind it
 * are both this box, fitted into the same pixels, so the two line up.
 */
export function routeBox(shape: Shape, wide: number): { x: number; y: number; width: number; height: number; side: number; pad: number } {
  const side = Math.max(shape.width, shape.height, 200);
  const pad = side * 0.08;
  const box = side + 2 * pad;
  const [x0, y0] = [(shape.width - side) / 2 - pad, (shape.height - side) / 2 - pad];
  return { x: x0 - ((wide - 1) * box) / 2, y: y0, width: box * wide, height: box, side, pad };
}

/** MapLibre's world is 512 pixels wide at zoom 0. */
const WORLD_PX = 512;

/**
 * The map's view that shows `shape`'s box (routeBox) fitted into `width` × `height` pixels, centred, as an SVG with
 * preserveAspectRatio="xMidYMid meet" fits it: its centre and its zoom, at which a metre east is as many pixels as
 * in the SVG (Web Mercator, which matches the shape's flat projection about its middle to well under a pixel).
 */
export function viewOf(place: MapPlace, shape: Shape, wide: number, width: number, height: number): { center: [number, number]; zoom: number } {
  const box = routeBox(shape, wide);
  const pxPerMetre = Math.min(width / box.width, height / box.height);
  const center = shapeToLngLat(place, shape, [shape.width / 2, shape.height / 2]);
  // Pixels per degree of longitude at zoom z are WORLD_PX · 2^z / 360.
  const zoom = Math.log2((pxPerMetre * metresPerLon(place, shape) * 360) / WORLD_PX);
  return { center, zoom };
}
