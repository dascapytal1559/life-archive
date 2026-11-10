// The Journal page's one player: a single audio element for the whole page, so one recording plays at a time, and
// what is loaded, where it is and whether it plays, for every card, section button and the phone's mini player to
// draw. A recording is fetched from the module's route a range at a time as it plays and seeks (each read kept in the
// trail, the ranges folding into one row).

import { useCallback, useEffect, useRef, useState } from "react";

/** What a play button plays: a recording of the day, by its address, with a name to show. */
export interface Playable {
  /** Unique on the page: the source's id, or the recording's path. */
  key: string;
  src: string;
  label: string;
}

export interface PlayerState {
  /** What is loaded, or null before anything is. */
  now: Playable | null;
  playing: boolean;
  /** Seconds in, and how long it is (null until the recording says). */
  time: number;
  duration: number | null;
  /** Why it will not play, when it will not. */
  problem: string | null;
}

export interface Player extends PlayerState {
  /** Plays `item`, or pauses it when it is the one playing, or plays on when it is the one paused. */
  toggle(item: Playable): void;
  /** Moves to `seconds` in what is loaded. */
  seek(seconds: number): void;
  /** Stops and unloads (a day closed). */
  stop(): void;
}

const IDLE: PlayerState = { now: null, playing: false, time: 0, duration: null, problem: null };

export function usePlayer(): Player {
  const audio = useRef<HTMLAudioElement | null>(null);
  // What is loaded, kept apart from the state so a toggle acts once (React's StrictMode runs a state updater twice).
  const loaded = useRef<string | null>(null);
  const [state, setState] = useState<PlayerState>(IDLE);

  useEffect(() => {
    const element = new Audio();
    element.preload = "metadata";
    audio.current = element;
    const set = (patch: Partial<PlayerState>) => setState((was) => ({ ...was, ...patch }));
    const onTime = () => set({ time: element.currentTime });
    const onMeta = () => set({ duration: Number.isFinite(element.duration) ? element.duration : null });
    const onPlay = () => set({ playing: true, problem: null });
    const onPause = () => set({ playing: false });
    const onError = () => set({ playing: false, problem: "This recording would not play here." });
    element.addEventListener("timeupdate", onTime);
    element.addEventListener("loadedmetadata", onMeta);
    element.addEventListener("durationchange", onMeta);
    element.addEventListener("play", onPlay);
    element.addEventListener("pause", onPause);
    element.addEventListener("ended", onPause);
    element.addEventListener("error", onError);
    return () => {
      element.pause();
      element.removeAttribute("src");
      element.load();
      audio.current = null;
      loaded.current = null;
      setState(IDLE);
    };
  }, []);

  const toggle = useCallback((item: Playable) => {
    const element = audio.current;
    if (!element) return;
    if (loaded.current === item.key) {
      if (element.paused) void element.play().catch(() => undefined);
      else element.pause();
      return;
    }
    loaded.current = item.key;
    element.src = item.src;
    void element.play().catch(() => undefined);
    setState({ ...IDLE, now: item });
  }, []);

  const seek = useCallback((seconds: number) => {
    const element = audio.current;
    if (!element || !Number.isFinite(seconds)) return;
    element.currentTime = seconds;
    setState((was) => ({ ...was, time: seconds }));
  }, []);

  const stop = useCallback(() => {
    loaded.current = null;
    const element = audio.current;
    if (element) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    setState(IDLE);
  }, []);

  return { ...state, toggle, seek, stop };
}

/** Seconds as the player shows them: 4:12, or 1:02:05 past an hour. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}
