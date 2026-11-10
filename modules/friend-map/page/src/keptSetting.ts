// A setting kept on this device, as the app's other settings are: per browser,
// in localStorage, the default never written (so it stays the default as the
// default changes). A store anything can read and listen to, so a setting in
// the menu (viewSettings.ts) and the view it changes stay one. Without storage
// (a private window, blocked site data) a choice lasts until the page is
// reloaded. A setting can be kept somewhere else that reads and writes as
// localStorage does: the Spider web's settings in the real app are kept on
// friend-map's server (savedStore.ts), every choice written, the default too.

import { useSyncExternalStore } from "react";

/** A value that can be read, set and listened to. */
export interface Store<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

export type Kept = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface KeptSetting<T> extends Store<T> {
  /** Reads the setting again from `storageToUse` (by default where it is kept), telling whoever listens if it changed. */
  reload(storageToUse?: Kept | null): void;
}

/** Where a setting is kept, if not in this browser's localStorage, and whether its default is written too. */
export interface KeptWhere {
  storage?: () => Kept | null;
  /** Writes the default as any other choice, so what is kept says what was chosen, even when it is the default. */
  keepDefault?: boolean;
}

function storage(): Kept | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The setting kept under `key`: `parse` turns what is kept (null for nothing)
 * into a value, the fallback for anything it does not know; `write` turns a
 * value back into what is kept.
 */
export function keptSetting<T>(
  key: string,
  fallback: T,
  parse: (kept: string | null) => T,
  write: (value: T) => string = String,
  { storage: keptIn = storage, keepDefault = false }: KeptWhere = {},
): KeptSetting<T> {
  const read = (from: Kept | null): T => {
    try {
      return parse(from?.getItem(key) ?? null);
    } catch {
      return fallback;
    }
  };
  let kept = keptIn();
  let value = read(kept);
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: () => value,
    set(next) {
      const normal = parse(write(next));
      if (Object.is(normal, value)) return;
      value = normal;
      try {
        if (Object.is(normal, fallback) && !keepDefault) kept?.removeItem(key);
        else kept?.setItem(key, write(normal));
      } catch {
        // Not kept: the setting lasts until the page is reloaded.
      }
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload(storageToUse = keptIn()) {
      kept = storageToUse;
      const before = value;
      value = read(kept);
      if (!Object.is(before, value)) changed();
    },
  };
}

/** A store's value, kept up to date. */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
