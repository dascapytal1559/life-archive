// The playback's camera: behind the marker and above it, looking the way of travel, its turns eased so it never
// snaps (each frame it closes a share of the gap to where it should be, the share set by how much time passed, so it
// eases the same at any frame rate). The marker is always at the middle of its view, so the marker itself never
// shakes on the screen: only the world turns under it, smoothly.
//
// One camera for both renderers: where it looks (`target`), its heading (degrees clockwise from north), its tilt
// (degrees from looking straight down) and its range (metres from the target). Each renderer turns it into its own
// (MapLibre's centre, zoom, bearing and pitch: maplibreView; Cesium's heading, pitch and range).

/** How the camera follows: close behind (following), or high and wide (the whole-route flyover). */
export type Shot = "follow" | "flyover";

export interface CameraState {
  target: [number, number];
  heading: number;
  tilt: number;
  range: number;
}

/** Each shot's tilt and range, and how long its turns take to ease (seconds to close about two thirds of a turn). */
export const SHOTS: Record<Shot, { tilt: number; range: number; ease: number }> = {
  follow: { tilt: 56, range: 820, ease: 1.1 },
  flyover: { tilt: 48, range: 2600, ease: 2.6 },
};

/** How long a change of shot (tilt and range) takes to ease, as `ease` above. */
const SHOT_EASE = 1.4;

/** `angle` in (-180, 180]. */
export const wrap = (angle: number): number => {
  const a = ((angle % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
};

/** The share of a gap closed in `dt` seconds by an easing that takes `ease` seconds. */
const share = (dt: number, ease: number) => 1 - Math.exp(-Math.max(0, dt) / ease);

/** A camera that eases after the marker. */
export function followCamera(first: { target: [number, number]; heading: number }, shot: Shot = "follow") {
  const state: CameraState = { target: first.target, heading: first.heading, tilt: SHOTS[shot].tilt, range: SHOTS[shot].range };
  let current: Shot = shot;
  return {
    get state(): CameraState {
      return state;
    },
    set shot(next: Shot) {
      current = next;
    },
    /** The camera `dt` seconds on, the marker at `target` heading `heading`. */
    step(dt: number, target: [number, number], heading: number): CameraState {
      const aim = SHOTS[current];
      state.target = target;
      state.heading = (state.heading + wrap(heading - state.heading) * share(dt, aim.ease) + 360) % 360;
      state.tilt += (aim.tilt - state.tilt) * share(dt, SHOT_EASE);
      state.range += (aim.range - state.range) * share(dt, SHOT_EASE);
      return state;
    },
    /** The camera put straight where it should be, after a jump (the scrubber moved). */
    snap(target: [number, number], heading: number): CameraState {
      state.target = target;
      state.heading = heading;
      return state;
    },
  };
}

/** MapLibre's default vertical field of view, degrees; the Cesium view is given the same, so the two frame alike. */
export const FIELD_OF_VIEW = 36.87;

const EARTH_CIRCUMFERENCE = 40_075_016.686;

/**
 * The camera as MapLibre's view: the zoom at which the target is `range` metres from the camera on a map
 * `height` pixels tall (MapLibre puts the camera 1.5 heights from the centre, at its field of view), and its pitch.
 */
export function maplibreView(state: CameraState, height: number): { center: [number, number]; zoom: number; bearing: number; pitch: number } {
  const toCentre = 0.5 / Math.tan((FIELD_OF_VIEW * Math.PI) / 360) * height;
  const worldSize = (toCentre * EARTH_CIRCUMFERENCE * Math.cos((state.target[1] * Math.PI) / 180)) / state.range;
  return { center: state.target, zoom: Math.log2(worldSize / 512), bearing: state.heading, pitch: state.tilt };
}
