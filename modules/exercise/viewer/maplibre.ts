// MapLibre GL, loaded the first time a map is drawn (the console's other pages never load it), its worker from this
// server's own copy of the package, and the painter that draws the feed's thumbnails: one map, off the page, that
// paints each thumbnail's view in turn and keeps it as a picture, since a page of live maps would need a WebGL
// context each and browsers allow only a handful.

import type { Theme } from "../../../sdk/viewer.ts";
import { mapStyle } from "./mapStyle.ts";

type MapLibre = typeof import("maplibre-gl");

let loading: Promise<MapLibre> | null = null;

/** MapLibre, loaded once. */
export function loadMapLibre(): Promise<MapLibre> {
  loading ??= Promise.all([import("maplibre-gl"), import("maplibre-gl/dist/maplibre-gl-worker.mjs?url"), import("maplibre-gl/dist/maplibre-gl.css")]).then(([maplibre, worker]) => {
    maplibre.setWorkerUrl(worker.default);
    return maplibre;
  });
  loading.catch(() => (loading = null));
  return loading;
}

/** A thumbnail to paint: which map in which look, at what size in CSS pixels, centred where at what zoom. */
export interface Still {
  region: string;
  maxZoom: number;
  theme: Theme;
  width: number;
  height: number;
  center: [number, number];
  zoom: number;
}

/** Each still painted (an object URL of its picture), by what it shows; kept while the page is open. */
const painted = new Map<string, Promise<string>>();
/** Stills are painted one at a time, in the order asked. */
let queue: Promise<unknown> = Promise.resolve();
let painter: { map: import("maplibre-gl").Map; box: HTMLDivElement; style: string } | null = null;

/** How long a still may take to paint before it is given up on (its tiles not answering, say). */
const PAINT_MS = 10_000;

/** `still`'s picture, painted once (and only if `signal` has not been aborted by the time its turn comes). */
export function paintStill(still: Still, signal: AbortSignal): Promise<string> {
  const ratio = window.devicePixelRatio || 1;
  const key = JSON.stringify([still.region, still.theme, Math.round(still.width), Math.round(still.height), still.center.map((v) => v.toFixed(6)), still.zoom.toFixed(3), ratio]);
  const kept = painted.get(key);
  if (kept) return kept;
  const job = queue.then(() => {
    if (signal.aborted) throw new DOMException("no longer shown", "AbortError");
    return paint(still, ratio);
  });
  queue = job.catch(() => {});
  painted.set(key, job);
  job.catch(() => painted.delete(key));
  return job;
}

async function paint(still: Still, ratio: number): Promise<string> {
  const maplibre = await loadMapLibre();
  const style = `${still.region}:${still.maxZoom}:${still.theme}`;
  const width = Math.max(1, Math.round(still.width));
  const height = Math.max(1, Math.round(still.height));
  if (!painter) {
    const box = document.createElement("div");
    box.setAttribute("aria-hidden", "true");
    Object.assign(box.style, { position: "fixed", left: "-10000px", top: "0", width: `${width}px`, height: `${height}px`, pointerEvents: "none" });
    document.body.append(box);
    const map = new maplibre.Map({
      container: box,
      style: mapStyle(still.region, still.maxZoom, still.theme),
      center: still.center,
      zoom: still.zoom,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: ratio,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    painter = { map, box, style };
  } else {
    Object.assign(painter.box.style, { width: `${width}px`, height: `${height}px` });
    painter.map.resize();
    if (painter.style !== style) {
      painter.map.setStyle(mapStyle(still.region, still.maxZoom, still.theme));
      painter.style = style;
    }
    painter.map.jumpTo({ center: still.center, zoom: still.zoom });
  }
  const { map } = painter;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, PAINT_MS);
    map.once("idle", () => {
      clearTimeout(timer);
      resolve();
    });
    map.triggerRepaint();
  });
  const blob = await new Promise<Blob | null>((resolve) => map.getCanvas().toBlob(resolve, "image/webp", 0.9));
  if (!blob) throw new Error("the map could not be painted");
  return URL.createObjectURL(blob);
}
