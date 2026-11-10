// friend-map's own server as the page sees it, apart from any backend (the data contract is archiveApi.ts's): your
// settings and the photo drawn in place of the sun on Orbits, kept in friend-map's own data folder (server/api.ts).
// The entry provides it once, as it provides the archive: the server's (appHttp.ts), or the demo's (src/demo/app.ts).

import type { SettingsReport } from "./settings.ts";

export interface AppApi {
  /** Your settings (data/settings.json, see settings.ts), which the map's model needs beside the backend's data. */
  settings(): Promise<SettingsReport>;
  /** Your photo, drawn in place of the sun on Orbits (data/me/, server/mePhoto.ts): where it is shown from, or null for none. */
  mePhoto(): Promise<string | null>;
  /** Keeps `photo` (a JPEG, PNG, WebP or HEIC image, up to 15 MB) as your photo, in place of any before it; answers where it is shown from. */
  setMePhoto(photo: Blob): Promise<string>;
  /** Removes it, so the sun is drawn again. */
  removeMePhoto(): Promise<null>;
}

let provided: AppApi | null = null;

/** Names friend-map's server for the page. The entry (src/main.tsx, src/demo/main.tsx) calls it once, before anything draws. */
export function provideApp(api: AppApi): void {
  provided = api;
}

/** The server the entry provided; asking before it has is a mistake in the entry, and says so. */
export const appApi: AppApi = new Proxy({} as AppApi, {
  get(_target, key: string | symbol) {
    if (!provided) throw new Error(`appApi.${String(key)} was used before provideApp() named friend-map's server`);
    return provided[key as keyof AppApi];
  },
});
