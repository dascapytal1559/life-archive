// A route on the map of its area, where the archive keeps one on this Mac (server/maps/; the activity's `map`), drawn
// from this server alone; elsewhere its shape alone, saying its area's map is not downloaded yet.
//
//   RouteThumb: the feed's thumbnail, the route (RouteShape's SVG, unchanged) over a picture of the map painted to fit
//     the same box (maplibre.ts's paintStill), painted once the card comes near the screen.
//   RouteMapLarge: an activity's page, a live map to move and zoom, the route on it, a scale and the credit.

import { useContext, useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { LookContext, type Theme } from "../../../sdk/viewer.ts";
import { MAP_CREDIT, MAP_CREDIT_URL, type MapPlace, type Shape } from "../wire.ts";
import { RouteShape, THUMB_WIDE } from "./Drawings.tsx";
import { loadMapLibre, paintStill } from "./maplibre.ts";
import { mapStyle } from "./mapStyle.ts";
import { shapeToLngLat, viewOf } from "./place.ts";

/** Said where a route's area has no map kept on this Mac. */
export const NO_MAP = "This area's map is not downloaded yet";

/** A region's name for a person: sample-city as Sample City. */
export const regionName = (region: string): string => region.replace(/(^|-)([a-z])/g, (_, dash: string, letter: string) => `${dash ? " " : ""}${letter.toUpperCase()}`);

/** The feed's thumbnail of a route: on its area's map where one is kept, else its shape alone, saying so. */
export function RouteThumb({ shape, place, label }: { shape: Shape; place: MapPlace | null; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const theme = useContext(LookContext);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [near, setNear] = useState(false);
  const [picture, setPicture] = useState<string | null>(null);

  // Its size, and whether it is near the screen: a map is painted only for a card that may be seen.
  useEffect(() => {
    const element = box.current;
    if (!element || !place) return;
    const sized = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    const seen = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: "600px 0px" });
    sized.observe(element);
    seen.observe(element);
    return () => {
      sized.disconnect();
      seen.disconnect();
    };
  }, [place]);

  useEffect(() => {
    if (!place || !size || !near || size.width < 1 || size.height < 1) return;
    const abort = new AbortController();
    const view = viewOf(place, shape, THUMB_WIDE, size.width, size.height);
    paintStill({ region: place.region, maxZoom: place.maxZoom, theme, width: size.width, height: size.height, ...view }, abort.signal)
      .then((url) => abort.signal.aborted || setPicture(url))
      .catch(() => {});
    return () => abort.abort();
  }, [place, shape, size, near, theme]);

  return (
    <div ref={box} className={`route-box${place ? " route-box--map" : ""}`}>
      {picture && <img className="route-box__map" src={picture} alt="" />}
      <RouteShape shape={shape} label={label} />
      {place ? <span className="route-box__credit">{MAP_CREDIT}</span> : <span className="route-box__note">{NO_MAP}</span>}
    </div>
  );
}

/** The console's colours a route is drawn in on a live map, read from the page's tokens (exercise.css). */
function routeColours(element: HTMLElement): { line: string; halo: string; finish: string } {
  const css = getComputedStyle(element);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return { line: token("--c-accent", "#15803d"), halo: token("--c-surface", "#ffffff"), finish: token("--c-text", "#0f0f0f") };
}

/** The map's style with the route on it: its line over a halo, a filled dot at the start and a ringed one at the finish. */
function routeStyle(place: MapPlace, line: Array<[number, number]>, theme: Theme, colours: ReturnType<typeof routeColours>): StyleSpecification {
  const base = mapStyle(place.region, place.maxZoom, theme);
  base.sources.route = { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } } };
  base.sources.ends = {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { end: "finish" }, geometry: { type: "Point", coordinates: line.at(-1)! } },
        { type: "Feature", properties: { end: "start" }, geometry: { type: "Point", coordinates: line[0] } },
      ],
    },
  };
  const round = { "line-cap": "round", "line-join": "round" } as const;
  base.layers.push(
    { id: "route-halo", type: "line", source: "route", layout: round, paint: { "line-color": colours.halo, "line-width": 7, "line-opacity": 0.9 } },
    { id: "route-line", type: "line", source: "route", layout: round, paint: { "line-color": colours.line, "line-width": 3.5 } },
    {
      id: "route-ends",
      type: "circle",
      source: "ends",
      paint: {
        "circle-radius": 5.5,
        "circle-color": ["match", ["get", "end"], "start", colours.line, colours.halo],
        "circle-stroke-color": ["match", ["get", "end"], "start", colours.halo, colours.finish],
        "circle-stroke-width": ["match", ["get", "end"], "start", 2, 3],
      },
    },
  );
  return base;
}

/** An activity's route on a live map of its area, fitted to it, to move and zoom (a modifier key with the wheel, two fingers by touch). */
function LiveRouteMap({ shape, place, label }: { shape: Shape; place: MapPlace; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const theme = useContext(LookContext);
  const [failed, setFailed] = useState<string | null>(null);
  const line = shape.points.map((point) => shapeToLngLat(place, shape, point));

  useEffect(() => {
    let gone = false;
    loadMapLibre()
      .then((maplibre) => {
        const element = box.current;
        if (gone || !element) return;
        const lngs = line.map(([lng]) => lng);
        const lats = line.map(([, lat]) => lat);
        const live = new maplibre.Map({
          container: element,
          style: routeStyle(place, line, theme, routeColours(element)),
          bounds: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
          fitBoundsOptions: { padding: 36 },
          maxZoom: 18,
          dragRotate: false,
          touchPitch: false,
          cooperativeGestures: true,
          attributionControl: { compact: false, customAttribution: `<a href="${MAP_CREDIT_URL}" target="_blank" rel="noreferrer">${MAP_CREDIT}</a>` },
        });
        live.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
        live.addControl(new maplibre.ScaleControl({ unit: "metric", maxWidth: 110 }), "bottom-left");
        live.on("error", (event) => console.warn("the map:", event.error?.message));
        map.current = live;
      })
      .catch((error: Error) => gone || setFailed(error.message));
    return () => {
      gone = true;
      map.current?.remove();
      map.current = null;
    };
    // The map is made once for the route; a change of look restyles it below.
  }, [shape, place]);

  // A change of look: the same view, in the other look's colours.
  useEffect(() => {
    if (map.current && box.current) map.current.setStyle(routeStyle(place, line, theme, routeColours(box.current)));
  }, [theme]);

  if (failed) return <RouteShape shape={shape} large label={label} />;
  return <div ref={box} className="route-live" role="img" aria-label={label} />;
}

/** An activity's route on its page: on a live map where its area's map is kept, else its shape alone. */
export function RouteMapLarge({ shape, place, label }: { shape: Shape; place: MapPlace | null; label: string }) {
  return place ? <LiveRouteMap shape={shape} place={place} label={label} /> : <RouteShape shape={shape} large label={label} />;
}
