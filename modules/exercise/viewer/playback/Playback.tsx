// An activity's playback (the captain's ask: "Strava has this really cool feature that lets you play back your
// journey … wonder if we can do better"): the route replayed in 3D, a camera following a marker along it with the
// trail behind, over the archive's own 3D (localScene.ts, always, and what it opens on) or, when the owner chooses it,
// the photorealistic city (photorealScene.ts, when the archive has its credentials; scene.ts's sceneKinds): play and pause, 1x to 8x of the time it took or a fast flyover of the
// whole route, a scrubber, and the moment's readouts (time, distance, speed, heart rate and its zone, elevation).
// Opened from an activity's page (its address with &play=1); full screen, and on a phone too (it only reads).
//
// Keys: space plays and pauses, ← and → step ten seconds, Escape closes.

import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, LookContext } from "../../../../sdk/viewer.ts";
import { playbackUrl, type PlaybackTrack } from "../../wire.ts";
import { clockText, distanceText, speedWay } from "../format.ts";
import { followCamera, type Shot } from "./camera.ts";
import { localScene } from "./localScene.ts";
import { photorealScene } from "./photorealScene.ts";
import { sceneKinds, type PlaybackScene, type SceneColours, type SceneKind } from "./scene.ts";
import { groundUnder, type GroundAt } from "./terrainSampler.ts";
import { timelineOf, type Frame, type Timeline } from "./timeline.ts";
import "./playback.css";

/** The speeds offered: times the time it took, and the flyover, the whole route in FLYOVER_S. */
export const SPEEDS = [1, 2, 4, 8, "flyover"] as const;
export type Speed = (typeof SPEEDS)[number];
export const FLYOVER_S = 45;

/** How many times faster than the recording a speed plays, for a playback of `duration` seconds. */
export const rateOf = (speed: Speed, duration: number): number => (speed === "flyover" ? Math.max(1, duration / FLYOVER_S) : speed);

/** The readouts are re-drawn this often (the scene itself every frame). */
const READOUT_MS = 100;

/** How long a note stays up. */
const NOTE_MS = 10_000;

/** The route's colours, from the console's tokens. */
function colours(element: HTMLElement): SceneColours {
  const css = getComputedStyle(element);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return { ahead: "#ffffff", trail: token("--pb-trail", "#ff7a2f"), glow: token("--pb-glow", "rgba(255, 122, 47, 0.55)") };
}

const KIND_NAMES: Record<SceneKind, string> = { photoreal: "Photoreal city", local: "This Mac's 3D" };

export function Playback({ id, onClose }: { id: string; onClose: () => void }) {
  const [track, setTrack] = useState<PlaybackTrack | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    fetch(playbackUrl(id), { signal: abort.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as PlaybackTrack & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        setTrack(body);
      })
      .catch((error: Error) => abort.signal.aborted || setFailed(error.message));
    return () => abort.abort();
  }, [id]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  }, [onClose]);

  // Over the whole console (its tokens are on .console), not inside the page's scrolling surface.
  return createPortal(
    <div className="pb" role="dialog" aria-label="Playback of the route">
      {track ? <Player track={track} onClose={onClose} /> : (
        <div className="pb__wait">
          <p>{failed ? `The playback is unavailable: ${failed}` : "Loading the route…"}</p>
          <button type="button" className="pb__button" onClick={onClose}>Close</button>
        </div>
      )}
    </div>,
    document.querySelector(".console") ?? document.body,
  );
}

function Player({ track, onClose }: { track: PlaybackTrack; onClose: () => void }) {
  const theme = useContext(LookContext);
  const timeline = useMemo<Timeline>(() => timelineOf(track), [track]);
  const boxes = { local: useRef<HTMLDivElement>(null), photoreal: useRef<HTMLDivElement>(null) };
  const root = useRef<HTMLDivElement>(null);
  const scrubber = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<SceneKind>(() => sceneKinds(track)[0]!);
  const [ready, setReady] = useState<Partial<Record<SceneKind, boolean>>>({});
  const [note, setNote] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [frame, setFrame] = useState<Frame>(() => timeline.frameAt(0));

  // What the frame loop reads: kept out of React's state, so a frame never waits for a render.
  const engine = useRef({
    at: 0,
    playing: false,
    speed: 1 as Speed,
    jumped: true,
    kind,
    scenes: {} as Partial<Record<SceneKind, PlaybackScene>>,
    making: {} as Partial<Record<SceneKind, Promise<PlaybackScene>>>,
    closing: undefined as ReturnType<typeof setTimeout> | undefined,
    closed: false,
    ground: null as GroundAt | null,
    camera: followCamera({ target: [timeline.frameAt(0).lng, timeline.frameAt(0).lat], heading: timeline.frameAt(0).heading }),
  });
  engine.current.playing = playing;
  engine.current.speed = speed;
  engine.current.kind = kind;
  engine.current.camera.shot = (speed === "flyover" ? "flyover" : "follow") satisfies Shot;

  // The terrain under the route, read once, for the photorealistic city's heights and the elevation readout.
  const groundReady = useMemo(() => groundUnder(track, timeline.bounds).then((ground) => (engine.current.ground = ground)), [track, timeline]);

  // Each scene made once, the first time it is shown, and kept while the playback is open: the city's tileset is asked
  // for once a playback (one session). What is being made is kept on the engine, which outlives React's StrictMode
  // putting the player up twice, so that never makes a second (nor asks for a second session).
  useEffect(() => {
    const live = engine.current;
    if (live.making[kind]) return;
    const box = boxes[kind].current;
    if (!box || !root.current) return;
    const making =
      kind === "local"
        ? localScene(box, track, timeline, theme, colours(root.current))
        : groundReady.then((ground) => photorealScene(box, track, timeline, track.photoreal!, ground, colours(root.current!)));
    live.making[kind] = making;
    making
      .then((scene) => {
        if (live.closed) return scene.destroy();
        live.scenes[kind] = scene;
        live.jumped = true;
        setReady((was) => ({ ...was, [kind]: true }));
      })
      .catch((error: Error) => {
        if (live.closed) return;
        setReady((was) => ({ ...was, [kind]: false }));
        setNote(kind === "photoreal" ? `The photoreal city is unavailable (${error.message}); showing this Mac's 3D.` : `The 3D map could not be drawn: ${error.message}`);
        if (kind === "photoreal") setKind("local");
      });
  }, [kind]);

  // A note (the city unavailable) is said for a while, then gets out of the way.
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  // Every scene goes with the playback: a moment after the player is taken down, unless it is put straight back up.
  useEffect(() => {
    const live = engine.current;
    clearTimeout(live.closing);
    return () => {
      live.closing = setTimeout(() => {
        live.closed = true;
        Object.values(live.scenes).forEach((scene) => scene?.destroy());
        live.scenes = {};
      });
    };
  }, []);

  // A change of size reaches every scene.
  useEffect(() => {
    const sized = new ResizeObserver(() => Object.values(engine.current.scenes).forEach((scene) => scene?.resize()));
    if (root.current) sized.observe(root.current);
    return () => sized.disconnect();
  }, []);

  // The frame loop: the time moved on by the speed, the moment's frame, the camera eased after it, the scene drawn.
  // With &record=1 in the address the clock stands still and window.__playback.step(dt) moves it one frame, so a
  // clip can be captured frame by frame at an exact rate (a screen recording would race the scene).
  useEffect(() => {
    const live = engine.current;
    const recording = new URLSearchParams(location.search).has("record");
    let last = performance.now();
    let readout = 0;
    let request = 0;
    const advance = (dt: number, now: number) => {
      if (live.playing) {
        live.at = Math.min(timeline.duration, live.at + dt * rateOf(live.speed, timeline.duration));
        if (live.at >= timeline.duration) setPlaying(false);
      }
      const shown = timeline.frameAt(live.at);
      // In the flyover the camera looks far ahead, so its turns are the route's big ones.
      const heading = live.speed === "flyover" ? bearingTo(shown, timeline.pointAhead(live.at, 600)) : shown.heading;
      const camera = live.jumped ? live.camera.snap([shown.lng, shown.lat], heading) : live.camera.step(dt, [shown.lng, shown.lat], heading);
      live.jumped = false;
      live.scenes[live.kind]?.show(shown, camera);
      if (scrubber.current && document.activeElement !== scrubber.current) scrubber.current.value = String(shown.at);
      if (now - readout > READOUT_MS) {
        readout = now;
        setFrame(shown);
      }
    };
    if (recording) {
      let clock = 0;
      Object.assign(window, { __playback: { step: (dt: number) => advance(dt, (clock += dt * 1000)), seek: (at: number) => seek(at) } });
      advance(0, 0);
      return () => void Object.assign(window, { __playback: undefined });
    }
    const tick = (now: number) => {
      advance(Math.min(0.1, (now - last) / 1000), now);
      last = now;
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [timeline]);

  const seek = (at: number) => {
    engine.current.at = Math.min(timeline.duration, Math.max(0, at));
    engine.current.jumped = true;
  };
  const toggle = () => {
    if (!playing && engine.current.at >= timeline.duration) seek(0);
    setPlaying(!playing);
  };

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement && event.target.type !== "range") return;
      if (event.key === " ") {
        event.preventDefault();
        toggle();
      } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        seek(engine.current.at + (event.key === "ArrowRight" ? 10 : -10) * rateOf(engine.current.speed, timeline.duration));
      }
    };
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  });

  const elevation = frame.altitude ?? engine.current.scenes[kind]?.groundAt(frame.lng, frame.lat) ?? engine.current.ground?.(frame.lng, frame.lat) ?? null;
  const way = speedWay(track.family);
  return (
    <div className="pb__player" ref={root}>
      <div className="pb__stage">
        <div ref={boxes.local} className={`pb__scene${kind === "local" ? " pb__scene--shown" : ""}`} />
        {track.photoreal && <div ref={boxes.photoreal} className={`pb__scene pb__scene--photoreal${kind === "photoreal" ? " pb__scene--shown" : ""}`} />}
        {!ready[kind] && <p className="pb__loading">{kind === "photoreal" ? "Loading the photoreal city…" : "Loading the 3D map…"}</p>}
      </div>

      <header className="pb__top">
        <button type="button" className="pb__close" onClick={onClose} aria-label="Close the playback">
          <Icon name="prev" />
        </button>
        <div className="pb__title">
          <h2>{track.title}</h2>
          <span>{track.start.replace("T", " · ")}</span>
        </div>
        {track.photoreal && (
          <div className="pb__kinds" role="group" aria-label="What the route is shown over">
            {sceneKinds(track).map((k) => (
              <button key={k} type="button" className="pb__chip" aria-pressed={kind === k} disabled={k === "photoreal" && ready.photoreal === false} onClick={() => setKind(k)}>
                {KIND_NAMES[k]}
              </button>
            ))}
          </div>
        )}
      </header>

      <dl className="pb__stats" aria-live="off">
        <Stat label="Time" value={clockText(frame.elapsed)} />
        <Stat label="Distance" value={distanceText(frame.distance)} />
        <Stat label={way === "speed" ? "Speed" : "Pace"} value={speedReadout(way, frame.speed)} />
        {track.heartRate && (
          <Stat
            label="Heart rate"
            value={frame.heartRate === null ? "—" : `${frame.heartRate} bpm`}
            extra={frame.zone !== null ? <span className={`pb__zone zone--${frame.zone}`}>Z{frame.zone}</span> : undefined}
          />
        )}
        <Stat label="Elevation" value={elevation === null ? "—" : `${Math.round(elevation)} m`} />
      </dl>

      {note && <p className="pb__note" role="status">{note}</p>}

      <footer className="pb__controls">
        <button type="button" className="pb__play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <PauseGlyph /> : <PlayGlyph />}
        </button>
        <input
          ref={scrubber}
          className="pb__scrub"
          type="range"
          min={0}
          max={timeline.duration}
          step={0.1}
          defaultValue={0}
          aria-label="Where in the activity"
          onInput={(event) => seek(Number(event.currentTarget.value))}
        />
        <div className="pb__speeds" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" className="pb__chip" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
              {s === "flyover" ? "Flyover" : `${s}x`}
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}

function Stat({ label, value, extra }: { label: string; value: string; extra?: ReactNode }) {
  return (
    <div className="pb__stat">
      <dt>{label}</dt>
      <dd>
        {value}
        {extra}
      </dd>
    </div>
  );
}

/** The moment's speed as the sport writes it: km/h on a bike, minutes a kilometre on foot, a 100 m in the water. */
export function speedReadout(way: ReturnType<typeof speedWay>, metresPerSecond: number): string {
  if (way === "speed") return `${(metresPerSecond * 3.6).toFixed(1)} km/h`;
  if (metresPerSecond < 0.3) return "—";
  return way === "pace-100m" ? `${clockText(100 / metresPerSecond)} /100m` : `${clockText(1000 / metresPerSecond)} /km`;
}

/** The bearing from the frame's point to `to`, degrees clockwise from north. */
function bearingTo(from: Frame, to: [number, number]): number {
  const dx = (to[0] - from.lng) * Math.cos((from.lat * Math.PI) / 180);
  const dy = to[1] - from.lat;
  return dx === 0 && dy === 0 ? from.heading : ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

const PlayGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor" /></svg>
);
const PauseGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" /></svg>
);
