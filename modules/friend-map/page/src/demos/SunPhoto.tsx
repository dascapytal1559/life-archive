// The sun on Orbits, and your photo in place of it (the user's ask:
// "when you hover over it, it should see a plus button that allows you to
// upload a photo ... And then it should show instead of the sun"). With no
// photo the sun is drawn as it always was, "you" on it; with one, the photo,
// round, no text, with the sun's glow still round it and a ring in
// your colour, so it still reads as the middle. Hovering the sun (or
// tapping it on a phone) shows "+" to choose a photo, or to change it, and
// with a photo a small "×" to remove it. The photo is kept in data/me/ by the
// server (server/mePhoto.ts); demo mode and the static demo never have one,
// and being read-only offer neither button. The Spider web, Orbits' map as a spider's
// web, never has one either, nor its buttons (the user's ask: "We need to
// remove the profile picture in the web view. The profile picture should only
// apply to the orbit view.").

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { appApi } from "../appApi.ts";
import { useReadOnly } from "../readOnly.ts";

/** The photo's radius, as a share of the closest orbit's: over the sun's bright middle, inside whoever you live with (HEARTH). */
export const PHOTO_SHARE = 0.5;
/** The sun's radius, as a share of the closest orbit's. */
export const SUN_SHARE = 0.95;
/** As the server takes it (server/mePhoto.ts): what the picker offers, and the largest file. */
const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";
const MAX_BYTES = 15 * 1024 * 1024;

/** The sun, or your photo (`photo`, where it is shown from) in place of it; drawn about (0, 0). */
export function Sun({ inner, photo, onBroken }: { inner: number; photo: string | null; onBroken?: () => void }) {
  const glow = <circle r={inner * SUN_SHARE} fill="url(#orbits-sun)" className="orbits__sun" />;
  if (!photo) {
    return (
      <>
        {glow}
        <text className="orbits__you" y={4.5} textAnchor="middle">you</text>
      </>
    );
  }
  const r = inner * PHOTO_SHARE;
  return (
    <>
      {glow}
      <clipPath id="orbits-photo-clip">
        <circle r={r} />
      </clipPath>
      <image
        href={photo}
        x={-r}
        y={-r}
        width={2 * r}
        height={2 * r}
        preserveAspectRatio="xMidYMid slice"
        clipPath="url(#orbits-photo-clip)"
        className="orbits__photo"
        onError={onBroken}
      />
      <circle r={r} className="orbits__photo-ring" />
    </>
  );
}

/**
 * Your photo: where it is shown from, or null for the sun. Asked once
 * as the map opens, unless the view does not show it (`shown` false: the Spider web,
 * whose sun is always the sun), which then never asks; a photo that will not
 * load counts as none.
 */
export function useMePhoto(shown = true): { photo: string | null; setPhoto: (photo: string | null) => void; broken: () => void } {
  const [photo, setPhoto] = useState<string | null>(null);
  useEffect(() => {
    if (!shown) return;
    let live = true;
    appApi.mePhoto().then(
      (url) => live && setPhoto(url),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [shown]);
  return { photo: shown ? photo : null, setPhoto, broken: () => setPhoto(null) };
}

/**
 * "+" over the sun at (x, y) in the map, and "×" with a photo, shown while
 * `shown` (the pointer over the sun, or a tap on it), and while the pointer or
 * focus is on them.
 */
export function SunControls({ x, y, inner, photo, shown, onPhoto }: {
  x: number;
  y: number;
  inner: number;
  photo: string | null;
  shown: boolean;
  onPhoto: (photo: string | null) => void;
}) {
  const readOnly = useReadOnly();
  const picker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!problem) return;
    const timer = setTimeout(() => setProblem(null), 5000);
    return () => clearTimeout(timer);
  }, [problem]);
  if (readOnly) return null;

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setProblem(null);
    try {
      onPhoto(await work());
    } catch (error) {
      setProblem((error as { reason?: string }).reason ?? (error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const chosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_BYTES) return setProblem(`That photo is over ${MAX_BYTES / 1024 / 1024} MB.`);
    void run(() => appApi.setMePhoto(file));
  };
  const visible = shown || over || busy || problem !== null;
  const edge = inner * PHOTO_SHARE * Math.SQRT1_2;
  return (
    <div
      className={`orbits-me${visible ? " orbits-me--shown" : ""}`}
      style={{ left: x, top: y }}
      onPointerEnter={() => setOver(true)}
      onPointerLeave={() => setOver(false)}
    >
      <button
        type="button"
        className="orbits-me__add"
        aria-label={photo ? "Change your photo" : "Add a photo of you"}
        title={photo ? "Change your photo" : "Add a photo of you"}
        disabled={busy}
        onClick={() => picker.current?.click()}
      >
        {busy ? "…" : "+"}
      </button>
      {photo && (
        <button
          type="button"
          className="orbits-me__remove"
          style={{ left: edge, top: -edge }}
          aria-label="Remove your photo"
          title="Remove your photo: back to the sun"
          disabled={busy}
          onClick={() => void run(() => appApi.removeMePhoto())}
        >
          ×
        </button>
      )}
      {problem && <div className="orbits-me__problem" role="alert">{problem}</div>}
      <input ref={picker} type="file" accept={ACCEPT} hidden onChange={chosen} />
    </div>
  );
}
