// The compass in the bottom-left corner of a view seen through a camera
// (cityCamera.ts: the City, and Orbits 3D): a needle pointing the way the
// view is turned, on a disc leaning as the view is tilted; pressing it glides
// the camera back to where the view first appears. Each view says what that is.

import { squash, type Camera } from "./cityCamera.ts";
import { COLORS } from "./palette.ts";
import "./compass.css";

export function Compass({ camera, home, onReset, homeTitle, backTo }: {
  camera: Camera;
  /** Whether the camera is where the view first appears. */
  home: boolean;
  onReset: () => void;
  /** The tooltip while home: where the camera is, and how to move it. */
  homeTitle: string;
  /** Where pressing it takes the camera ("north up and the usual tilt"). */
  backTo: string;
}) {
  const turned = (camera.bearing * 180) / Math.PI;
  const tilted = Math.round((camera.tilt * 180) / Math.PI);
  return (
    <button
      type="button"
      className={home ? "compass compass--home" : "compass"}
      title={home ? homeTitle : `Turned ${Math.round(turned)}°, tilted ${tilted}°: back to ${backTo}`}
      aria-label={`Reset the camera to ${backTo}`}
      onClick={onReset}
    >
      <svg width="34" height="34" viewBox="-17 -17 34 34" aria-hidden>
        <g transform={`scale(1 ${Math.max(0.3, squash(camera)).toFixed(3)})`}>
          <circle r="14" fill="rgba(10, 16, 32, 0.66)" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" />
          <g transform={`rotate(${turned.toFixed(1)})`}>
            <path d="M0 -11 L4 0 L-4 0 Z" fill={COLORS.me} />
            <path d="M0 11 L4 0 L-4 0 Z" fill="currentColor" fillOpacity="0.55" />
          </g>
        </g>
      </svg>
    </button>
  );
}
