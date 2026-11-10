// The playback's own 3D, from what the archive keeps on this Mac and nothing else (MapLibre GL): the region's map
// (OpenStreetMap's, Protomaps' style, ../mapStyle.ts) laid over its terrain (Mapterhorn's, maps/terrain/), every
// building raised to its height (OpenStreetMap's height, else its levels; Protomaps' buildings layer carries both as
// metres), a sky, and the route on the ground: all of it dim ahead, bright behind the marker, the bright part ending
// exactly at the marker (MapLibre's line-progress, which the timeline measures the same way). Viewing it asks no
// server but this one.

import type { GeoJSONSourceSpecification, Map as MapLibreMap, Marker, StyleSpecification } from "maplibre-gl";
import type { Theme } from "../../../../sdk/viewer.ts";
import { MAP_CREDIT, MAP_CREDIT_URL, TERRAIN_CREDIT, TERRAIN_CREDIT_URL, terrainUrl, type PlaybackTrack } from "../../wire.ts";
import { loadMapLibre } from "../maplibre.ts";
import { mapStyle } from "../mapStyle.ts";
import { maplibreView, type CameraState } from "./camera.ts";
import type { PlaybackScene, SceneColours } from "./scene.ts";
import type { Frame, Timeline } from "./timeline.ts";

/** A building OpenStreetMap gives no height: about two storeys. */
const UNKNOWN_HEIGHT_M = 6;

/** The buildings, raised: each its own height from its base, softly lit, a touch see-through so the route shows behind. */
function buildings(theme: Theme) {
  const dark = theme === "dark";
  return {
    id: "buildings-3d",
    type: "fill-extrusion" as const,
    source: "protomaps",
    "source-layer": "buildings",
    minzoom: 13,
    filter: ["in", ["get", "kind"], ["literal", ["building", "building_part"]]] as unknown as never,
    paint: {
      "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "height"], UNKNOWN_HEIGHT_M], 0, dark ? "#26282c" : "#e4e2dd", 60, dark ? "#34373d" : "#d6d4cf", 200, dark ? "#41454c" : "#c9c7c2"],
      "fill-extrusion-height": ["coalesce", ["get", "height"], UNKNOWN_HEIGHT_M],
      "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
      "fill-extrusion-opacity": 0.92,
      "fill-extrusion-vertical-gradient": true,
    },
  } as never;
}

/** The trail's colour to the marker and none past it: `progress` the share of the line behind. */
const trailGradient = (colour: string, progress: number) =>
  ["step", ["line-progress"], colour, Math.max(1e-6, Math.min(1, progress)), "rgba(0,0,0,0)"] as never;

/** The style of the playback's map. */
function playbackStyle(track: PlaybackTrack, timeline: Timeline, theme: Theme, colours: SceneColours): StyleSpecification {
  const style = mapStyle(track.map.region, track.map.maxZoom, theme);
  const origin = window.location.origin;
  // The flat buildings give way to raised ones.
  style.layers = style.layers.filter((layer) => layer.id !== "buildings");
  if (track.terrain) {
    style.sources.terrain = {
      type: "raster-dem",
      tiles: [`${origin}${terrainUrl(track.map.region)}`],
      tileSize: 512,
      encoding: "terrarium",
      maxzoom: track.terrain.maxZoom,
      bounds: track.terrain.bbox,
      attribution: `<a href="${TERRAIN_CREDIT_URL}" target="_blank" rel="noreferrer">${TERRAIN_CREDIT}</a>`,
    };
    style.terrain = { source: "terrain", exaggeration: 1 };
    // The relief has a source of its own: MapLibre draws both better than from one.
    style.sources.relief = { ...style.sources.terrain };
    // A light relief under the map, so hills read as hills.
    const firstLine = style.layers.findIndex((layer) => layer.type === "line");
    style.layers.splice(Math.max(0, firstLine), 0, {
      id: "relief",
      type: "hillshade",
      source: "relief",
      paint: { "hillshade-exaggeration": 0.25, "hillshade-shadow-color": theme === "dark" ? "#000000" : "#7d7a73", "hillshade-highlight-color": theme === "dark" ? "#2a2a2a" : "#ffffff" },
    });
  }
  style.sky = theme === "dark"
    ? { "sky-color": "#0b1220", "horizon-color": "#1d2738", "fog-color": "#121212", "fog-ground-blend": 0.6, "horizon-fog-blend": 0.6, "sky-horizon-blend": 0.6, "atmosphere-blend": 0.4 }
    : { "sky-color": "#a9cdf0", "horizon-color": "#e9eef3", "fog-color": "#f3f3f1", "fog-ground-blend": 0.6, "horizon-fog-blend": 0.5, "sky-horizon-blend": 0.6, "atmosphere-blend": 0.5 };
  style.sources.route = { type: "geojson", lineMetrics: true, data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: timeline.line } } } satisfies GeoJSONSourceSpecification;
  const round = { "line-cap": "round", "line-join": "round" } as const;
  style.layers.push(buildings(theme));
  style.layers.push(
    { id: "route-ahead", type: "line", source: "route", layout: round, paint: { "line-color": colours.ahead, "line-width": 4, "line-opacity": 0.75 } },
    { id: "route-glow", type: "line", source: "route", layout: round, paint: { "line-gradient": trailGradient(colours.glow, 0), "line-width": 14, "line-blur": 8 } },
    { id: "route-trail", type: "line", source: "route", layout: round, paint: { "line-gradient": trailGradient(colours.trail, 0), "line-width": 5 } },
  );
  return style;
}

/** The playback's own 3D in `element`. */
export async function localScene(element: HTMLElement, track: PlaybackTrack, timeline: Timeline, theme: Theme, colours: SceneColours): Promise<PlaybackScene> {
  const maplibre = await loadMapLibre();
  const first = timeline.frameAt(0);
  const map: MapLibreMap = new maplibre.Map({
    container: element,
    style: playbackStyle(track, timeline, theme, colours),
    center: [first.lng, first.lat],
    zoom: 15,
    pitch: 60,
    bearing: first.heading,
    maxPitch: 85,
    interactive: false,
    fadeDuration: 0,
    attributionControl: {
      compact: true,
      customAttribution: `<a href="${MAP_CREDIT_URL}" target="_blank" rel="noreferrer">${MAP_CREDIT}</a>`,
    },
    canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
  });
  map.on("error", (event) => console.warn("the playback's map:", event.error?.message));

  const dot = document.createElement("div");
  dot.className = "pb-marker";
  dot.innerHTML = '<span class="pb-marker__pulse"></span><span class="pb-marker__dot"></span>';
  const marker: Marker = new maplibre.Marker({ element: dot, subpixelPositioning: true }).setLngLat([first.lng, first.lat]).addTo(map);

  await new Promise<void>((resolve) => (map.loaded() ? resolve() : map.once("load", () => resolve())));
  let shownProgress = -1;
  let shownView = "";

  return {
    kind: "local",
    show(frame: Frame, camera: CameraState) {
      const view = maplibreView(camera, element.clientHeight || 600);
      // Paused, the view does not change, and the map is left to draw only what it loads.
      const key = `${view.center[0]},${view.center[1]},${view.zoom},${view.bearing},${view.pitch}`;
      if (key === shownView) return;
      shownView = key;
      map.jumpTo(view);
      marker.setLngLat([frame.lng, frame.lat]);
      // The trail is re-drawn only when its end has moved enough to see (a ten-thousandth of the line).
      if (Math.abs(frame.progress - shownProgress) > 1e-4) {
        shownProgress = frame.progress;
        map.setPaintProperty("route-trail", "line-gradient", trailGradient(colours.trail, frame.progress));
        map.setPaintProperty("route-glow", "line-gradient", trailGradient(colours.glow, frame.progress));
      }
    },
    groundAt: (lng, lat) => (track.terrain ? map.queryTerrainElevation([lng, lat]) : null),
    resize() {
      map.resize();
      shownView = "";
    },
    destroy: () => map.remove(),
  };
}
