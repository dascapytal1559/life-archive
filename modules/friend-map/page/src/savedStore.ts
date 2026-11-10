// The Spider web's settings (savedSettings.ts), kept on friend-map's server in
// the real app and as the demo's defaults. In the real app each is read from
// the set the page was served (so a page opens with them, on any browser or
// the phone), and every choice is sent back to the server (PUT
// /api/view-settings) a moment after it is made, the default too; a page
// coming back into view asks for the set again, so a choice made on another
// device shows there too. The demo keeps its visitor's choices in the browser,
// apart (keptAs), as it keeps its other settings, and asks the server for
// nothing: until its visitor chooses, each is the demo's own choice
// (DEMO_SAVED in src/demo/defaults.ts), else your saved choice, as it was
// built into the static demo, else the
// setting's own default.

import { DEMO_SAVED } from "./demo/defaults.ts";
import { keptAs } from "./demoMode.ts";
import { keptSetting, type Kept, type KeptSetting } from "./keptSetting.ts";
import { address } from "./mount.ts";
import { cleanSaved, savedName, savedSettingsIn, type SavedName, type SavedSettings } from "./savedSettings.ts";

/** The saved set this page was served. */
export const servedSettings: SavedSettings = savedSettingsIn(globalThis.document);

let saved: SavedSettings = { ...servedSettings };
/** Choices not yet sent, and those sent and not yet answered: neither is undone by a set asked for meanwhile. */
const unsent = new Map<SavedName, string | null>();
const sending = new Map<SavedName, string | null>();
/** Asks for the unsent to be sent, once saving has started (the real app's page). */
let sendSoon: (() => void) | null = null;
/** The real app's saved stores, read again when the set is. */
const stores = new Set<KeptSetting<unknown>>();

function change(key: string, value: string | null): void {
  const name = savedName(key);
  if (!name) return;
  saved = { ...saved };
  if (value === null) delete saved[name];
  else saved[name] = value;
  unsent.set(name, value);
  sendSoon?.();
}

/** The saved set, read and written as a setting's storage (keptSetting.ts). */
export const savedStorage: Kept = {
  getItem: (key) => {
    const name = savedName(key);
    return name ? (saved[name] ?? null) : null;
  },
  setItem: (key, value) => change(key, value),
  removeItem: (key) => change(key, null),
};

/**
 * The setting under `key` (one of SAVED_SETTINGS', friend-map.<name>) in an app (the demo's, `demo`, or the real
 * one's): `builtIn` until it is chosen, `parse` reading what is kept, anything it does not know being `fallback`. In
 * the real app it is kept on the server; in the demo in the browser, its default the demo's own (DEMO_SAVED), else
 * your saved choice, where there is one `demoTakes`.
 */
export function savedSetting<T>(
  key: string,
  demo: boolean,
  builtIn: T,
  parse: (kept: string | null, fallback: T) => T,
  { write, demoTakes = () => true }: { write?: (value: T) => string; demoTakes?: (value: T) => boolean } = {},
): KeptSetting<T> {
  if (demo) {
    const name = savedName(key);
    const served = parse((name && DEMO_SAVED[name]) ?? savedStorage.getItem(key), builtIn);
    const fallback = demoTakes(served) ? served : builtIn;
    return keptSetting(keptAs(key, true), fallback, (kept) => parse(kept, fallback), write);
  }
  const store = keptSetting(key, builtIn, (kept) => parse(kept, builtIn), write, { storage: () => savedStorage, keepDefault: true });
  stores.add(store as KeptSetting<unknown>);
  return store;
}

/** Puts the saved set back to `next` (by default as the page was served) with nothing unsent; for tests. */
export function resetSaved(next: SavedSettings = servedSettings): void {
  saved = { ...next };
  unsent.clear();
  sending.clear();
  for (const store of stores) store.reload();
}

/**
 * Keeps the real app's saved settings on the server: sends each choice `delay` ms after the last (at once as the
 * page is hidden or left), and asks for the set again whenever the page comes back into view. Returns how to stop.
 */
export function startSaving({ fetch = globalThis.fetch, target = globalThis as unknown as EventTarget & { document?: Document }, delay = 300 } = {}): () => void {
  const url = address("/api/view-settings");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = (keepalive = false) => {
    clearTimeout(timer);
    timer = undefined;
    if (unsent.size === 0) return;
    const body = Object.fromEntries(unsent);
    for (const [name, value] of unsent) sending.set(name, value);
    unsent.clear();
    const done = () => {
      for (const [name, value] of Object.entries(body)) if (sending.get(name as SavedName) === value) sending.delete(name as SavedName);
    };
    void fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive })
      .then((response) => {
        if (!response.ok) throw new Error(`PUT /api/view-settings failed (${response.status})`);
      })
      .catch(() => {
        // Not saved: kept to send with the next choice.
        for (const [name, value] of Object.entries(body)) if (!unsent.has(name as SavedName)) unsent.set(name as SavedName, value);
      })
      .finally(done);
  };
  const refresh = async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) return;
      const fresh = cleanSaved(((await response.json()) as { settings?: unknown }).settings);
      // What this page chose and the server has not answered yet stays as chosen.
      for (const [name, value] of [...sending, ...unsent]) {
        if (value === null) delete fresh[name];
        else fresh[name] = value;
      }
      saved = fresh;
      for (const store of stores) store.reload();
    } catch {
      // The server is away: the page keeps what it has.
    }
  };
  const onVisibility = () => (target.document?.visibilityState === "hidden" ? send(true) : void refresh());
  const onHide = () => send(true);
  sendSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(send, delay);
  };
  target.document?.addEventListener("visibilitychange", onVisibility);
  target.addEventListener("pagehide", onHide);
  target.addEventListener("focus", onVisibility);
  return () => {
    send(true);
    sendSoon = null;
    target.document?.removeEventListener("visibilitychange", onVisibility);
    target.removeEventListener("pagehide", onHide);
    target.removeEventListener("focus", onVisibility);
  };
}
