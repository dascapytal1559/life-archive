// Loading archive data into a component, and reloading it whenever anything in
// the page changes the archive (a tag, a merge), so every open view stays in step.
// New messages alone (a live chat) reload only the views that show what they add
// up to, and ask for it.

import { useCallback, useEffect, useRef, useState } from "react";
import { archiveApi, ArchiveUnavailable } from "./archiveApi.ts";

const CHANGED = "friend-map:archive-changed";
const MESSAGES = "friend-map:messages-changed";

/**
 * What changed: "people" (anyone's name, tags, links or archiving; anything may
 * differ), or "messages" (new messages, and so only counts and dates).
 */
export type ArchiveChange = "people" | "messages";

/** Tells every view that uses useArchive to reload; for "messages", only those that follow messages. */
export function archiveChanged(change: ArchiveChange = "people"): void {
  document.dispatchEvent(new Event(change === "people" ? CHANGED : MESSAGES));
}

/**
 * Calls `listener` whenever people change and, with `messages`, when only new
 * messages came in. Returns a function that stops it.
 */
export function onArchiveChanged(listener: () => void, { messages = false } = {}): () => void {
  document.addEventListener(CHANGED, listener);
  if (messages) document.addEventListener(MESSAGES, listener);
  return () => {
    document.removeEventListener(CHANGED, listener);
    document.removeEventListener(MESSAGES, listener);
  };
}

/** A load and the archive version it was made at (bumped by every change the hook follows). */
export interface Loaded {
  load: unknown;
  version: number;
}

/** Whether a hook loads now: only while enabled, and not when it already holds (or is fetching) this very load. */
export function needsLoad(enabled: boolean, last: Loaded | null, next: Loaded): boolean {
  return enabled && (last === null || last.load !== next.load || last.version !== next.version);
}

export interface ArchiveState<T> {
  data?: T;
  /** The archive has nothing for this, or is not running: views show nothing rather than an error. */
  unavailable: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Loads `load` now and again whenever `deps` change and, unless `follow` is
 * false, whenever people change (a view that says false reloads itself), and
 * with `messages` also when only new messages came in (for what shows counts
 * or dates). While `enabled` is false it loads nothing and keeps what it had;
 * once enabled again it loads only if `deps` or the archive changed meanwhile.
 */
export function useArchive<T>(
  load: () => Promise<T>,
  deps: unknown[],
  { follow = true, messages = false, enabled = true } = {},
): ArchiveState<T> {
  const [state, setState] = useState<{ data?: T; unavailable: boolean; error: string | null }>({ unavailable: false, error: null });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const stableLoad = useCallback(load, deps);
  /** What was last loaded (or is loading), so enabling again does not load the same thing twice. */
  const loaded = useRef<Loaded | null>(null);

  useEffect(() => {
    const next = { load: stableLoad, version };
    if (!needsLoad(enabled, loaded.current, next)) return;
    loaded.current = next;
    let cancelled = false;
    let settled = false;
    stableLoad().then(
      (data) => {
        settled = true;
        if (!cancelled) setState({ data, unavailable: false, error: null });
      },
      (error: unknown) => {
        settled = true;
        if (!cancelled) {
          setState({
            unavailable: error instanceof ArchiveUnavailable,
            error: error instanceof ArchiveUnavailable ? null : String(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
      // Abandoned before it answered (disabled meanwhile, say): load it again when next enabled.
      if (!settled) loaded.current = null;
    };
  }, [stableLoad, version, enabled]);

  useEffect(() => (follow ? onArchiveChanged(reload, { messages }) : undefined), [reload, follow, messages]);

  return { ...state, reload };
}

/**
 * Reloads every view whenever people change anywhere, the CLI included, and
 * the views that follow messages when only new messages came in, as the page's
 * archive tells it (the server's event stream; nothing in demo mode). Returns a function that stops it.
 */
export function followArchive(): () => void {
  return archiveApi.follow(archiveChanged);
}
