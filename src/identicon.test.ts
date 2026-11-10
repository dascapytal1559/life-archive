import { describe, expect, it } from "vitest";
import { BACKGROUND, contrast, identicon, IDENTICON_SIZE, identiconSeedOf, isIdenticonHue, isIdenticonSeed, MAIN, mix, oklab, pickedColour, randomIdenticonSeed, SPOT } from "./identicon.ts";

/** Seeds as People gives them: ids in order, made a few seconds apart. */
const SEEDS = Array.from({ length: 5000 }, (_, i) => identiconSeedOf(i + 1, 1_700_000_000_000 + i * 3_217));

/** The page backgrounds an identicon or its main colour sits on: Orbits' night sky, the Table, the light panel. */
const NIGHT = "#070b16";
const TABLE = "#0b1122";
const PAPER = "#ffffff";

describe("seeds", () => {
  it("are 16 hex digits, the same for the same person and different for each person", () => {
    expect(identiconSeedOf(7, 1_700_000_000_000)).toBe(identiconSeedOf(7, 1_700_000_000_000));
    expect(SEEDS.every(isIdenticonSeed)).toBe(true);
    expect(new Set(SEEDS).size).toBe(SEEDS.length);
    // A person made again with the same id (an id SQLite gave again) is still someone new.
    expect(identiconSeedOf(7, 1_700_000_000_001)).not.toBe(identiconSeedOf(7, 1_700_000_000_000));
  });

  it("are told from anything else", () => {
    for (const bad of [null, undefined, 12, "", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdefa", "0123456789abcdeg"]) {
      expect(isIdenticonSeed(bad), String(bad)).toBe(false);
    }
  });
});

describe("the picture", () => {
  it("is the same for the same seed, and mirrored left to right", () => {
    expect(identicon(SEEDS[0])).toEqual(identicon(SEEDS[0]));
    for (const seed of SEEDS.slice(0, 200)) {
      const { cells } = identicon(seed);
      expect(cells).toHaveLength(IDENTICON_SIZE);
      for (const row of cells) {
        expect(row).toHaveLength(IDENTICON_SIZE);
        expect(row).toEqual([...row].reverse());
        for (const cell of row) expect([BACKGROUND, MAIN, SPOT]).toContain(cell);
      }
    }
  });

  it("is different for every person, and so are its colours", () => {
    const pictures = new Set(SEEDS.map((seed) => JSON.stringify(identicon(seed))));
    expect(pictures.size).toBe(SEEDS.length);
    // Close to one main colour per person, not a palette of a few.
    expect(new Set(SEEDS.map((seed) => identicon(seed).main)).size).toBeGreaterThan(SEEDS.length * 0.9);
  });

  it("spreads the main colours round the colour wheel, none taking more than its share", () => {
    const buckets = new Array<number>(12).fill(0);
    for (const seed of SEEDS) buckets[Math.floor(hueOf(identicon(seed).main) / 30) % 12]++;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(SEEDS.length / 12 * 0.6);
      expect(count).toBeLessThan(SEEDS.length / 12 * 1.4);
    }
  });

  it("never loses a colour in another, nor its main colour on the map or its edge on the panel", () => {
    let worst = { main: Infinity, spot: Infinity, apart: Infinity, night: Infinity, table: Infinity, paper: Infinity };
    for (const seed of SEEDS) {
      const { background, main, spot } = identicon(seed);
      worst = {
        main: Math.min(worst.main, contrast(main, background)),
        spot: Math.min(worst.spot, contrast(spot, background)),
        apart: Math.min(worst.apart, contrast(main, spot)),
        night: Math.min(worst.night, contrast(main, NIGHT)),
        table: Math.min(worst.table, contrast(main, TABLE)),
        paper: Math.min(worst.paper, contrast(background, PAPER)),
      };
    }
    // Main on its background as WCAG asks of large text; the spot, an accent, plainly apart from both.
    expect(worst.main).toBeGreaterThan(4.5);
    expect(worst.spot).toBeGreaterThan(2);
    expect(worst.apart).toBeGreaterThan(1.4);
    // The main colour, what makes an Orbits marker stand out, on the night sky and the Table; the dark background against the light panel.
    expect(worst.night).toBeGreaterThan(7);
    expect(worst.table).toBeGreaterThan(6.5);
    expect(worst.paper).toBeGreaterThan(10);
  });

  it("always has some of the main colour, and never fills with it", () => {
    for (const seed of SEEDS) {
      const main = identicon(seed).cells.flat().filter((cell) => cell === MAIN).length;
      expect(main).toBeGreaterThan(0);
      expect(main).toBeLessThan(IDENTICON_SIZE * IDENTICON_SIZE);
    }
  });
});

describe("a picked hue", () => {
  it("is whole degrees, 0 to 359", () => {
    for (const good of [0, 15, 359]) expect(isIdenticonHue(good), String(good)).toBe(true);
    for (const bad of [null, undefined, -1, 360, 12.5, "15"]) expect(isIdenticonHue(bad), String(bad)).toBe(false);
  });

  it("makes the main colour the picker's swatch, and leaves the picture as the seed draws it", () => {
    for (const seed of SEEDS.slice(0, 200)) {
      const own = identicon(seed);
      const picked = identicon(seed, 200);
      expect(picked.main).toBe(pickedColour(200));
      expect(picked.hue).toBe(200);
      expect(picked.cells).toEqual(own.cells);
      // The background and spot go round with it.
      const turn = (hueOf(picked.background) - 200) - (hueOf(own.background) - own.hue);
      expect(Math.abs(((turn % 360) + 540) % 360 - 180)).toBeLessThan(8);
    }
    // Without one, as ever: the seed's own colour.
    expect(identicon(SEEDS[0], null)).toEqual(identicon(SEEDS[0]));
    expect(identicon(SEEDS[0]).main).not.toBe(identicon(SEEDS[0], Math.round(identicon(SEEDS[0]).hue + 180) % 360).main);
  });

  it("in any hue, never loses a colour in another nor its main colour on the map", () => {
    let worst = { main: Infinity, spot: Infinity, apart: Infinity, night: Infinity };
    for (let hue = 0; hue < 360; hue++) {
      for (const seed of SEEDS.slice(hue * 10, hue * 10 + 10)) {
        const { background, main, spot } = identicon(seed, hue);
        worst = {
          main: Math.min(worst.main, contrast(main, background)),
          spot: Math.min(worst.spot, contrast(spot, background)),
          apart: Math.min(worst.apart, contrast(main, spot)),
          night: Math.min(worst.night, contrast(main, NIGHT)),
        };
      }
    }
    expect(worst.main).toBeGreaterThan(4.5);
    expect(worst.spot).toBeGreaterThan(2);
    expect(worst.apart).toBeGreaterThan(1.4);
    expect(worst.night).toBeGreaterThan(7);
  });

  it("with a new seed at random, is a new picture in the same colour", () => {
    const seeds = Array.from({ length: 50 }, randomIdenticonSeed);
    expect(seeds.every(isIdenticonSeed)).toBe(true);
    expect(new Set(seeds).size).toBe(seeds.length);
    const [one, two] = seeds.map((seed) => identicon(seed, 120));
    expect(two.main).toBe(one.main);
    expect(two.cells).not.toEqual(one.cells);
  });
});

describe("mixing colours", () => {
  it("runs from the one colour to the other, evenly as the eye sees it", () => {
    expect(mix("#3a7bd5", "#e8eefc", 0)).toBe("#3a7bd5");
    expect(mix("#3a7bd5", "#e8eefc", 1)).toBe("#e8eefc");
    // Halfway from black to white in OKLab is lightness 0.5, a darker grey than sRGB's halfway (#808080).
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#636363");
    expect(oklab(mix("#000000", "#ffffff", 0.5))[0]).toBeCloseTo(0.5, 2);
  });
});

/** The hue of a #rrggbb colour, 0 to 360, in OKLCH, where equal steps of hue look equal. */
function hueOf(hex: string): number {
  const [, a, b] = oklab(hex);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}
