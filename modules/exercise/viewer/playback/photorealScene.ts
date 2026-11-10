// The playback over the photorealistic city: Google's Photorealistic 3D Tiles, drawn by CesiumJS, reached through
// Cesium ion (the token in the archive's .env.local, CESIUM_ION_TOKEN; the captain's Community plan carries Google's
// tiles) or, without one, from Google directly by a Maps Platform key. The tileset is asked for once a playback (one
// root request: one ion session, good for three hours of tiles), and kept while the playback is open, so switching
// to the archive's own 3D and back asks for none again.
//
// Privacy: the route never leaves this Mac. Google is asked for the tiles the camera sees as it follows the route
// (so it learns the area looked at, tile by tile), and Cesium ion for the tileset's address (it learns that the
// tileset was asked for, not where). CesiumJS itself, its workers and its assets are this server's copy of the package.
//
// The route needs a height to stand at: Google's city is measured from the ellipsoid, the terrain kept here from sea
// level, and the two differ by the geoid (some metres) and the terrain's own error. So the route is laid at the
// terrain's height (terrainSampler.ts) moved by the difference measured on Google's city at the start, and drawn
// through anything in front of it (dimmer where hidden), as the archive's own 3D drapes it on the ground.

import type * as CesiumModule from "cesium";
import { CESIUM_URL, type Photoreal, type PlaybackTrack } from "../../wire.ts";
import { FIELD_OF_VIEW, type CameraState } from "./camera.ts";
import type { PlaybackScene, SceneColours } from "./scene.ts";
import type { GroundAt } from "./terrainSampler.ts";
import type { Frame, Timeline } from "./timeline.ts";

type Cesium = typeof CesiumModule;

let loading: Promise<Cesium> | null = null;

/** CesiumJS, loaded once from this server's copy of its built package (its workers and assets beside it; ../../server/cesium.ts). */
export function loadCesium(): Promise<Cesium> {
  loading ??= (async () => {
    const base = `${window.location.origin}${CESIUM_URL}`;
    Object.assign(window, { CESIUM_BASE_URL: base });
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${base}Widgets/widgets.css`;
    document.head.append(link);
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${base}Cesium.js`;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("CesiumJS could not be loaded"));
      document.head.append(script);
    });
    return (window as unknown as { Cesium: Cesium }).Cesium;
  })();
  loading.catch(() => (loading = null));
  return loading;
}

/** Above the ground the trail and the marker float, metres, so the city's surface never cuts them. */
const LIFT_M = 1.2;

/** The median of some numbers; null with none. */
const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** The playback over the photorealistic city in `element`; it fails when the tileset cannot be had (no session, a refused token). */
export async function photorealScene(
  element: HTMLElement,
  track: PlaybackTrack,
  timeline: Timeline,
  photoreal: Photoreal,
  ground: GroundAt | null,
  colours: SceneColours,
): Promise<PlaybackScene> {
  const C = await loadCesium();
  // Nothing of ion's default token: the captain's own, or none when Google is reached directly.
  C.Ion.defaultAccessToken = photoreal.via === "cesium-ion" ? photoreal.token : "";
  const viewer = new C.Viewer(element, {
    baseLayer: false,
    globe: false,
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    useDefaultRenderLoop: false,
    msaaSamples: 4,
  });
  const scene = viewer.scene;
  scene.screenSpaceCameraController.enableInputs = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
  scene.fog.enabled = true;

  let tileset: CesiumModule.Cesium3DTileset;
  try {
    tileset = await C.createGooglePhotorealistic3DTileset(photoreal.via === "google" ? { key: photoreal.key, onlyUsingWithGoogleGeocoder: true } : { onlyUsingWithGoogleGeocoder: true });
  } catch (error) {
    viewer.destroy();
    // Cesium's request errors carry a status, not a message: ion answers 401 or 403 to a token it does not take here.
    const status = (error as { statusCode?: number }).statusCode;
    const said = (error as Error).message ?? (status ? `${photoreal.via === "cesium-ion" ? "Cesium ion" : "Google"} answered ${status}` : String(error));
    throw new Error(status === 401 || status === 403 ? `${said}: the token is not accepted at this address` : said);
  }
  scene.primitives.add(tileset);

  // Each point of the line's height above sea level: the terrain's, else the recording's altitude, else none.
  const n = timeline.line.length;
  const altitude = track.points.altitude;
  const baseHeights = timeline.line.map(([lng, lat], i) => ground?.(lng, lat) ?? altitude?.[i] ?? 0);
  let offset = 0;
  const positionsAt = () => timeline.line.map(([lng, lat], i) => C.Cartesian3.fromDegrees(lng, lat, baseHeights[i] + offset + LIFT_M));
  let positions = positionsAt();

  // The difference between Google's city and the terrain, measured where the route starts, once its tiles are in.
  const start = timeline.line.slice(0, Math.min(n, 60)).filter((_, i) => i % 6 === 0);
  scene
    .sampleHeightMostDetailed(start.map(([lng, lat]) => C.Cartographic.fromDegrees(lng, lat)))
    .then((sampled) => {
      const gaps = sampled.flatMap((c, i) => (c && Number.isFinite(c.height) ? [c.height - baseHeights[i * 6]] : []));
      const measured = median(gaps);
      if (measured !== null && Math.abs(measured) < 200) {
        offset = measured;
        positions = positionsAt();
      }
    })
    .catch(() => {});

  const ahead = C.Color.fromCssColorString(colours.ahead).withAlpha(0.75);
  const trailColour = C.Color.fromCssColorString(colours.trail);
  viewer.entities.add({
    polyline: { positions: C.Cartesian3.fromDegreesArray(timeline.line.flat()), width: 4, clampToGround: true, classificationType: C.ClassificationType.BOTH, material: ahead },
  });
  let trail: CesiumModule.Cartesian3[] = [];
  viewer.entities.add({
    polyline: {
      positions: new C.CallbackProperty(() => trail, false) as unknown as CesiumModule.Property,
      width: 9,
      arcType: C.ArcType.NONE,
      material: new C.PolylineGlowMaterialProperty({ glowPower: 0.22, taperPower: 1, color: trailColour }),
      depthFailMaterial: new C.PolylineGlowMaterialProperty({ glowPower: 0.22, taperPower: 1, color: trailColour.withAlpha(0.45) }),
    },
  });
  const points = scene.primitives.add(new C.PointPrimitiveCollection()) as CesiumModule.PointPrimitiveCollection;
  const halo = points.add({ pixelSize: 26, color: trailColour.withAlpha(0.3), disableDepthTestDistance: Number.POSITIVE_INFINITY });
  const marker = points.add({ pixelSize: 13, color: C.Color.WHITE, outlineColor: trailColour, outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY });

  const fitView = () => {
    const frustum = viewer.camera.frustum as CesiumModule.PerspectiveFrustum;
    const aspect = element.clientWidth / Math.max(1, element.clientHeight);
    const half = (FIELD_OF_VIEW * Math.PI) / 360;
    frustum.fov = aspect > 1 ? 2 * Math.atan(Math.tan(half) * aspect) : 2 * half;
  };
  fitView();

  return {
    kind: "photoreal",
    show(frame: Frame, camera: CameraState) {
      // The marker's height, between the two points of the line about it.
      const i = frame.index;
      const height = baseHeights[i] + (baseHeights[Math.min(n - 1, i + 1)] - baseHeights[i]) * frame.share + offset + LIFT_M;
      const here = C.Cartesian3.fromDegrees(frame.lng, frame.lat, height);
      trail = [...positions.slice(0, i + 1), here];
      marker.position = here;
      halo.position = here;
      viewer.camera.lookAt(here, new C.HeadingPitchRange(C.Math.toRadians(camera.heading), -C.Math.toRadians(90 - camera.tilt), camera.range));
      viewer.render();
    },
    groundAt: (lng, lat) => ground?.(lng, lat) ?? null,
    resize() {
      viewer.resize();
      fitView();
    },
    destroy: () => viewer.destroy(),
  };
}
