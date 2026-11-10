// The Spider web's colour (Orbits.tsx, the Spider web view): Amber, the Spider web's own, or
// a custom colour, from which the whole palette is worked out (webTheme.ts).
// Only the palette differs: the geometry, the motion and the data are the same
// (webLook.ts draws them all). The colour last chosen under Colour in the
// Spider web's settings in the menu (viewSettings.ts) is saved on friend-map's
// server with the web's other settings in the real app, and is the demo's
// default (savedStore.ts); until one is chosen it is the default blue,
// #65a5e2. A plain /spider shows it, and an address can still ask for another
// (addressChoice.ts): /spider?colour=3dff9a that custom colour (its hex,
// without the #), ?colour=amber Amber, until a colour is chosen, which is then
// saved and the address left plain; one it no longer knows (?colour=purple,
// once a preset) is the saved colour. The last custom colour chosen is kept on
// this device, so the Custom swatch offers it again after Amber.

import { demoMode, keptAs } from "../demoMode.ts";
import { keptSetting, useStore } from "../keptSetting.ts";
import { savedSetting } from "../savedStore.ts";
import { addressChoice, useAddressChoice } from "./addressChoice.ts";
import { hexIn, type Hex } from "./themeColour.ts";

export type WebPreset = "amber";
export type WebColour = WebPreset | Hex;

/** The presets, in the order offered, with what each is called, its swatch and a line on it. */
export const COLOURS: readonly { colour: WebPreset; title: string; swatch: string; about: string }[] = [
  { colour: "amber", title: "Amber", swatch: "#ffb347", about: "Amber strands and teal rings: the Spider web's own colours" },
];

/** The address's query parameter: ?colour=3dff9a opens the Spider web in that colour; none, or one it does not know, is the saved colour. */
export const COLOUR_PARAM = "colour";

const isPreset = (value: unknown): value is WebPreset => COLOURS.some((c) => c.colour === value);

/** A preset by its name, or a custom colour (#rrggbb). */
export const presetOf = (colour: WebColour): WebPreset | "custom" => (isPreset(colour) ? colour : "custom");

/** A preset's name or a custom colour (#rrggbb, or its hex alone); null for anything else. */
const colourIs = (raw: string): WebColour | null => (isPreset(raw) ? raw : hexIn(raw));

/** Where the colour chosen is kept. */
export const COLOUR_KEY = "friend-map.web.colour";
/** The colour until one is chosen: a blue. */
export const DEFAULT_COLOUR: WebColour = "#65a5e2";

/** The colour an app (the demo's, `demo`, or the real one's) last chose: what a plain address shows. */
export function makeWebColourChosen(demo: boolean) {
  return savedSetting<WebColour>(COLOUR_KEY, demo, DEFAULT_COLOUR, (kept, fallback) => (kept === null ? null : colourIs(kept)) ?? fallback);
}

/** This page's colour last chosen: the demo's in the demo, the real app's everywhere else. */
export const webColourChosen = makeWebColourChosen(demoMode);

export const webColourStore = addressChoice<WebColour>(
  COLOUR_PARAM,
  { read: colourIs, write: (colour) => (isPreset(colour) ? colour : colour.slice(1)) },
  webColourChosen,
);

/** The colour an address's query asks for (?colour=<colour>), or null for none it knows. */
export const colourIn = (search: string): WebColour | null => webColourStore.inSearch(search);
/** The query with `colour` written in: ?colour=3dff9a set, or, for the colour last chosen, left out; the rest of the query kept. */
export const searchWith = (search: string, colour: WebColour): string => webColourStore.searchWith(search, colour);

export function useWebColour(): WebColour {
  return useAddressChoice(webColourStore);
}

/** The custom colour offered until one is chosen: a neon green, apart from Amber. */
export const DEFAULT_CUSTOM: Hex = "#3dff9a";

/** The last custom colour chosen, kept on this device (apart in the demo). */
export const webCustomStore = keptSetting<Hex>(keptAs("friend-map.web.customColour"), DEFAULT_CUSTOM, (kept) => hexIn(kept) ?? DEFAULT_CUSTOM);

export function useWebCustom(): Hex {
  return useStore(webCustomStore);
}
