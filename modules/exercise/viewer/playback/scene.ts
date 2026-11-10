// What a playback's renderer is to the player (Playback.tsx): it draws a moment (the marker, the trail behind it and
// the camera's view) and says how high the ground is where it knows. Two renderers: the archive's own 3D
// (localScene.ts, MapLibre over the maps and terrain kept on this Mac) and the photorealistic city
// (photorealScene.ts, CesiumJS over Google's Photorealistic 3D Tiles).

import type { CameraState } from "./camera.ts";
import type { Frame } from "./timeline.ts";

export type SceneKind = "local" | "photoreal";

/**
 * The scenes a playback offers, in the order its buttons show them, the first the one it opens on: This Mac's 3D,
 * which asks no other server for anything, then the photoreal city when the archive has its credentials. The city is
 * the owner's to choose each time: its camera follows the route, so its tile requests to Google retrace it.
 */
export const sceneKinds = (track: { photoreal?: unknown }): SceneKind[] => (track.photoreal ? ["local", "photoreal"] : ["local"]);

export interface PlaybackScene {
  kind: SceneKind;
  /** Draws the moment `frame` from `camera`. */
  show(frame: Frame, camera: CameraState): void;
  /** The ground's height above sea level at a point, metres, where the renderer knows it; null otherwise. */
  groundAt(lng: number, lat: number): number | null;
  resize(): void;
  destroy(): void;
}

/** The route's colours: the line ahead, the trail behind the marker and its glow. */
export interface SceneColours {
  ahead: string;
  trail: string;
  glow: string;
}
