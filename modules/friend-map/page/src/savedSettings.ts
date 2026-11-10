// What friend-map's server keeps of your view settings: the Spider web's,
// and the Reach-out glow every glowing view shares (reachGlow.ts), in
// data/view-settings.json (server/viewSettings.ts), so every browser and the
// phone share one set (savedStore.ts keeps the page's stores on it).
// The names choice (Name format), which the Spider web's settings offer with
// its own, is among them, as it is one choice for every page, and so are the
// map views' Names settings (nameFade.ts), one set for every view. Each is
// kept as the page keeps it in localStorage, as text, under its key without
// "friend-map."; nothing but these names, each value one of the setting's own
// choices or a number, is ever saved, so the set is fit to be served into the
// page and built into the demo as its defaults (server/savedSettingsPlugin.ts).
// No browser code here: the server reads it too.

/** The settings saved on the server, as named in the file: each is its localStorage key without "friend-map.". */
export const SAVED_SETTINGS = ["names", "web.colour", "web.curve", "web.spokes", "web.strength", "web.top-names", "web.name-padding", "web.shadow", "reach-glow",
  "name-fade.top", "name-fade.bottom", "name-fade.faintest"] as const;

export type SavedName = (typeof SAVED_SETTINGS)[number];

/** The saved set: each setting chosen, as kept; a setting never chosen is missing. */
export type SavedSettings = Partial<Record<SavedName, string>>;

/** The names choice's values (names.ts; a test keeps them the same). */
export const NAME_STYLE_VALUES = ["first", "initial", "full", "hide", "except"] as const;

const NUMBER = /^\d{1,3}(\.\d{1,6})?$/;
const allowed: Record<SavedName, (value: string) => boolean> = {
  names: (value) => (NAME_STYLE_VALUES as readonly string[]).includes(value),
  "web.colour": (value) => value === "amber" || /^#[0-9a-f]{6}$/.test(value),
  "web.curve": (value) => NUMBER.test(value),
  "web.spokes": (value) => NUMBER.test(value),
  "web.strength": (value) => NUMBER.test(value),
  "web.top-names": (value) => value === "all" || NUMBER.test(value),
  "web.name-padding": (value) => NUMBER.test(value),
  "web.shadow": (value) => value === "on" || value === "off",
  "reach-glow": (value) => NUMBER.test(value),
  "name-fade.top": (value) => NUMBER.test(value),
  "name-fade.bottom": (value) => NUMBER.test(value),
  "name-fade.faintest": (value) => NUMBER.test(value),
};

/** The saved setting a page's key is (friend-map.web.spokes is web.spokes), or null for one not saved. */
export function savedName(key: string): SavedName | null {
  const name = key.replace(/^friend-map\./, "");
  return (SAVED_SETTINGS as readonly string[]).includes(name) && key !== name ? (name as SavedName) : null;
}

/** Whether `value` may be kept as the saved setting `name`: one of its choices, or a number. */
export function savedAllowed(name: SavedName, value: unknown): value is string {
  return typeof value === "string" && allowed[name](value);
}

/** Of `input`, the saved settings it holds, each one allowed; anything else is left out. */
export function cleanSaved(input: unknown): SavedSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const saved: SavedSettings = {};
  for (const name of SAVED_SETTINGS) {
    const value = (input as Record<string, unknown>)[name];
    if (savedAllowed(name, value)) saved[name] = value;
  }
  return saved;
}

/** The id of the element the page is served the saved set in, as JSON (server/savedSettingsPlugin.ts). */
export const SAVED_SETTINGS_ID = "friend-map-saved-settings";

/** The saved set as JSON fit to go inside a <script> element: no "<" can close it. */
export function savedSettingsJson(saved: SavedSettings): string {
  return JSON.stringify(cleanSaved(saved)).replace(/</g, "\\u003c");
}

/** The saved set the page `doc` was served (none without one: a test, or a page served without it). */
export function savedSettingsIn(doc: { getElementById(id: string): { textContent: string | null } | null } | undefined): SavedSettings {
  try {
    return cleanSaved(JSON.parse(doc?.getElementById(SAVED_SETTINGS_ID)?.textContent ?? "{}"));
  } catch {
    return {};
  }
}
