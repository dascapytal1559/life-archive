// A choice the address decides: ?<param>=<value> in the query, or the
// fallback when it says nothing it knows. With a fixed fallback nothing is
// remembered anywhere else, so a plain address always shows it, however the
// page was last seen, and a copied address reopens the same choice. Choosing
// writes the value into the address in place (replaceState, no new history
// entry), so the address bar always matches what is on screen; going back or
// forward to another address shows that address's choice. The fallback can
// instead be a kept choice (a Store): then choosing keeps it there, and the
// address, which needs say nothing of the choice kept, is left plain, so a
// plain address shows the last choice made and one carrying another shows
// that one until another is chosen. The values are a short list, or any a
// codec reads and writes (the Spider web's custom colour, ?colour=3dff9a). The
// Spider web's colour (webColour.ts) is made of this, its fallback saved with
// the web's other settings.

import { useSyncExternalStore } from "react";
import type { Store } from "../keptSetting.ts";

/** How a choice is read from the address and written into it: `read` is null for anything it does not know. */
export interface AddressCodec<T extends string> {
  read(raw: string): T | null;
  write(value: T): string;
}

export interface AddressChoice<T extends string> {
  param: string;
  /** What a plain address shows: fixed, or the kept choice now. */
  readonly fallback: T;
  /** The value an address's query asks for, or null for none it knows. */
  inSearch(search: string): T | null;
  /** The query with `value` written in, or, for the fallback, the parameter left out; the rest of the query kept. */
  searchWith(search: string, value: T): string;
  /** Whatever the address says now, the fallback when it says nothing. */
  get(): T;
  /** Writes the value into the address in place (with a kept fallback, keeps it there instead), and tells whoever listens. */
  set(value: T): void;
  /** Hears choices made here, the address changing under the page (back and forward), and a kept fallback changing. */
  subscribe(listener: () => void): () => void;
}

/** The address as it is now, if there is one (none in a test unless stubbed). */
function address(): { search: string; pathname: string; hash: string } | null {
  const l = globalThis.location;
  return l ? { search: l.search, pathname: l.pathname, hash: l.hash } : null;
}

/**
 * The choice in `param`: one of `values`, as written, or whatever `values`, a codec, reads; `fallback` for anything
 * else, a value, or a kept choice that choosing keeps.
 */
export function addressChoice<T extends string>(param: string, values: readonly T[] | AddressCodec<T>, fallback: T | Store<T>): AddressChoice<T> {
  const codec: AddressCodec<T> = Array.isArray(values)
    ? { read: (raw) => (values.includes(raw as T) ? (raw as T) : null), write: (value) => value }
    : (values as AddressCodec<T>);
  const kept = typeof fallback === "object" ? fallback : null;
  const plain = (): T => (kept ? kept.get() : (fallback as T));
  const listeners = new Set<() => void>();
  const inSearch = (search: string): T | null => {
    const raw = new URLSearchParams(search).get(param);
    return raw === null ? null : codec.read(raw);
  };
  const searchWith = (search: string, value: T): string => {
    const params = new URLSearchParams(search);
    if (value === plain()) params.delete(param);
    else params.set(param, codec.write(value));
    const query = params.toString();
    return query ? `?${query}` : "";
  };
  return {
    param,
    get fallback() {
      return plain();
    },
    inSearch,
    searchWith,
    get: () => inSearch(address()?.search ?? "") ?? plain(),
    set(value) {
      kept?.set(value);
      const at = address();
      if (!at) return;
      const search = searchWith(at.search, value);
      if (search !== at.search && globalThis.history?.replaceState) globalThis.history.replaceState(null, "", `${at.pathname}${search}${at.hash}`);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      globalThis.addEventListener?.("popstate", listener);
      const unkept = kept?.subscribe(listener);
      return () => {
        listeners.delete(listener);
        globalThis.removeEventListener?.("popstate", listener);
        unkept?.();
      };
    },
  };
}

/** The choice as the address says it now: read on every render, so a page opened at another address shows its choice; the same outside a browser. */
export function useAddressChoice<T extends string>(choice: AddressChoice<T>): T {
  return useSyncExternalStore(choice.subscribe, choice.get, choice.get);
}
