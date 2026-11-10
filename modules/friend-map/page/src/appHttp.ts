// friend-map's own server over its routes (server/api.ts): GET /api/settings and /api/me, and the photo under
// /api/me/photo. src/main.tsx provides it (see appApi.ts); the demo provides its own (src/demo/app.ts).

import { ArchiveError } from "./archiveApi.ts";
import type { AppApi } from "./appApi.ts";
import { address } from "./mount.ts";
import { DEFAULT_SETTINGS, type SettingsReport } from "./settings.ts";

/** The settings from the server; the defaults, with a problem, when it can't be reached. */
async function loadSettings(): Promise<SettingsReport> {
  try {
    const response = await fetch(address("/api/settings"));
    if (!response.ok) throw new Error(`GET /api/settings failed (${response.status})`);
    return (await response.json()) as SettingsReport;
  } catch (error) {
    return { settings: { ...DEFAULT_SETTINGS }, problems: [`could not load the settings (${(error as Error).message}); using the defaults`] };
  }
}

/** Your photo (server/api.ts, /api/me): where it is shown from (under the page's mount), or null for none. */
async function mePhoto(path: string, init?: RequestInit): Promise<string | null> {
  const response = await fetch(address(`/api${path}`), init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const reason: string = body?.error ?? response.statusText;
    throw new ArchiveError(`${init?.method ?? "GET"} /api${path} failed (${response.status}): ${reason}`, reason);
  }
  const { photo } = (await response.json()) as { photo: string | null };
  return photo === null ? null : address(photo);
}

export const httpApp: AppApi = {
  settings: loadSettings,
  mePhoto: () => mePhoto("/me"),
  setMePhoto: async (photo) => (await mePhoto("/me/photo", { method: "PUT", body: photo, headers: { "content-type": "application/octet-stream" } }))!,
  removeMePhoto: async () => {
    await mePhoto("/me/photo", { method: "DELETE" });
    return null;
  },
};
