// Each person's identicon: a small mirrored pixel picture, as crypto wallets
// show an address, drawn from a seed kept on the person (person.identicon_seed,
// set when the person is made; see server/archive/people.ts). Only the seed is
// stored, so the picture can be retuned here without touching anyone's record.
// The server and the page both use this file: the server to make seeds, the
// page to draw them. Pure functions, no DOM.
//
// The picture is IDENTICON_SIZE cells square, its left half drawn at random and
// mirrored onto the right, each cell the background, the main colour or a spot
// colour. The three colours are picked in OKLCH, so their lightness is what the
// eye sees whatever the hue, by role (RANGES): a dark, soft background, a
// light, vivid main colour (what makes a person's marker on Orbits stand out,
// and their name there is written in it, so it must read on the night sky)
// and a mid spot colour of another hue. Lightness is fixed by role, so no seed
// gives a picture whose parts disappear into each other, and hue, chroma, the
// picture and which hues go together carry the variety.
//
// You may pick a person's colour (the person panel's icon picker): a
// hue kept beside the seed (person.identicon_hue). Their main colour is then
// that hue at a fixed lightness and chroma, the same as the picker's swatch,
// and the background and spot follow it round the wheel as they would; the
// seed still draws the picture, so a new seed with the same hue is a new
// picture in the same colour.

/** Cells per side. */
export const IDENTICON_SIZE = 8;

/** A seed: 16 lowercase hex digits (64 bits). */
const SEED = /^[0-9a-f]{16}$/;

export function isIdenticonSeed(value: unknown): value is string {
  return typeof value === "string" && SEED.test(value);
}

/**
 * The seed a person is given when they are made: a hash of their id and when
 * they were made, so the same person always gets the same one and a new person
 * (a "Not them" split, say) a new one. Anything later may set another.
 */
export function identiconSeedOf(personId: number, createdAt: number): string {
  return hash64(`person ${personId} ${createdAt}`);
}

/** What a cell holds. */
export type IdenticonCell = 0 | 1 | 2;
export const BACKGROUND = 0;
export const MAIN = 1;
export const SPOT = 2;

/** A hue you picked: whole degrees, 0 to 359. */
export function isIdenticonHue(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < 360;
}

/** A new seed, at random, for a new picture. */
export function randomIdenticonSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A lightness and a chroma a colour is picked between, in OKLCH. */
interface Range {
  l: [number, number];
  c: [number, number];
}

/** The three colours' ranges: a dark background, a light, vivid main colour, a mid spot. */
const RANGES: { background: Range; main: Range; spot: Range } = { background: { l: [0.2, 0.29], c: [0.03, 0.08] }, main: { l: [0.74, 0.84], c: [0.11, 0.17] }, spot: { l: [0.52, 0.6], c: [0.14, 0.2] } };

/** The main colour a picked hue gives: the picker's swatch, and the person's colour everywhere; the middle of what a seed gives. */
export function pickedColour(hue: number): string {
  const mid = ([low, high]: [number, number]) => (low + high) / 2;
  return oklchHex(mid(RANGES.main.l), mid(RANGES.main.c), hue);
}

export interface Identicon {
  /** IDENTICON_SIZE rows of IDENTICON_SIZE cells, top to bottom, left to right. */
  cells: IdenticonCell[][];
  /** Colours as #rrggbb. */
  background: string;
  /** The person's colour: wherever only one fits. */
  main: string;
  spot: string;
  /** The main colour's hue, in degrees: the one picked, or the seed's. */
  hue: number;
}

const cache = new Map<string, Identicon>();

/**
 * The identicon a seed draws, in the hue picked for it if one was (null: the seed's own). The same seed and hue always
 * give the same picture.
 */
export function identicon(seed: string, picked: number | null = null): Identicon {
  const key = picked === null ? seed : `${seed}@${picked}`;
  const kept = cache.get(key);
  if (kept) return kept;
  const random = generator(seed);
  const between = (low: number, high: number) => low + (high - low) * random();

  // Every number is drawn whether a hue was picked or not, so the seed draws the same picture either way.
  const seedHue = 360 * random();
  const hue = picked ?? seedHue;
  // The background sits a quarter to three quarters of the way round from the main hue; the spot on the other side of it.
  const backgroundHue = hue + between(90, 270);
  const spotHue = hue + (random() < 0.5 ? -1 : 1) * between(100, 160);
  const [lightness, chroma] = [between(...RANGES.main.l), between(...RANGES.main.c)];
  const main = picked === null ? oklchHex(lightness, chroma, hue) : pickedColour(hue);
  const background = oklchHex(between(...RANGES.background.l), between(...RANGES.background.c), backgroundHue);
  const spot = oklchHex(between(...RANGES.spot.l), between(...RANGES.spot.c), spotHue);

  const half = IDENTICON_SIZE / 2;
  const cells: IdenticonCell[][] = [];
  for (let y = 0; y < IDENTICON_SIZE; y++) {
    const left: IdenticonCell[] = [];
    // As blockies weights them: about two in five each the background and the main colour, one in seven the spot.
    for (let x = 0; x < half; x++) left.push(Math.floor(random() * 2.3) as IdenticonCell);
    cells.push([...left, ...[...left].reverse()]);
  }

  const made = { cells, background, main, spot, hue };
  if (cache.size > 5000) cache.clear();
  cache.set(key, made);
  return made;
}

/** A 64-bit hash of a string as 16 hex digits: two independent 32-bit lanes (cyrb53's mixing, kept to 32 bits each). */
function hash64(text: string): string {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** Numbers in [0, 1) from a seed (sfc32, started from the seed's two halves). */
function generator(seed: string): () => number {
  const hex = isIdenticonSeed(seed) ? seed : hash64(seed);
  let a = parseInt(hex.slice(0, 8), 16) | 0;
  let b = parseInt(hex.slice(8), 16) | 0;
  let c = a ^ b;
  let d = 1;
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

/** An OKLCH colour as #rrggbb, its chroma lowered as far as it must be to fit in sRGB. */
export function oklchHex(lightness: number, chroma: number, hue: number): string {
  let low = 0;
  let high = chroma;
  let rgb = oklchToLinear(lightness, chroma, hue);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 20; i++) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinear(lightness, mid, hue))) low = mid;
      else high = mid;
    }
    rgb = oklchToLinear(lightness, low, hue);
  }
  return `#${rgb.map((v) => Math.round(255 * encode(Math.min(1, Math.max(0, v)))).toString(16).padStart(2, "0")).join("")}`;
}

function oklchToLinear(lightness: number, chroma: number, hue: number): [number, number, number] {
  const radians = (hue * Math.PI) / 180;
  const A = chroma * Math.cos(radians);
  const B = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (lightness - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (lightness - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut(rgb: number[]): boolean {
  return rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);
}

/** Linear light to sRGB's encoding. */
function encode(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** WCAG's contrast ratio between two #rrggbb colours, 1 to 21. */
export function contrast(one: string, two: string): number {
  const [x, y] = [luminance(one), luminance(two)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function luminance(hex: string): number {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The colour `t` of the way from `one` to `two` (#rrggbb), mixed in OKLab, so the steps between look even. */
export function mix(one: string, two: string, t: number): string {
  const [l1, a1, b1] = oklab(one);
  const [l2, a2, b2] = oklab(two);
  const [l, a, b] = [l1 + (l2 - l1) * t, a1 + (a2 - a1) * t, b1 + (b2 - b1) * t];
  return oklchHex(l, Math.hypot(a, b), (Math.atan2(b, a) * 180) / Math.PI);
}

/** A #rrggbb colour in OKLab: lightness, then the two colour axes. */
export function oklab(hex: string): [number, number, number] {
  const [r, g, b] = linear(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** A #rrggbb colour in linear light. */
function linear(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}
