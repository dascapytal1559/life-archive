import { describe, expect, it } from "vitest";
import { wallClock } from "../../../sdk/server.ts";
import type { Special } from "../wire.ts";
import { dollars, filterProducts, perKg, productsOf, sortProducts, whenText } from "./format.ts";

const special = (name: string, more: Partial<Special> = {}): Special => ({
  supplier: "shop-a", name, variant: null, url: `https://shop.example/${name}`, image: null, price: 10, was: null, discount: null,
  basis: "listed", weightKg: null, unitPrice: null, wasUnitPrice: null, ...more,
});

describe("the Shopping page's cards", () => {
  const specials = [
    special("rump", { variant: "500g", price: 20, was: 25, discount: 20, basis: "markdown", unitPrice: 40 }),
    special("rump", { variant: "1kg", price: 30, was: 50, discount: 40, basis: "markdown", unitPrice: 30 }),
    special("wings", { price: 12, unitPrice: 6 }),
    special("mince", { supplier: "shop-b", price: 9, was: 10, discount: 10, basis: "markdown" }),
  ];

  it("gather a product's sizes on one card, the most off leading", () => {
    const cards = productsOf(specials);
    expect(cards.map((card) => [card.supplier, card.name, card.sizes.map((s) => s.variant)])).toEqual([
      ["shop-a", "rump", ["1kg", "500g"]],
      ["shop-a", "wings", [null]],
      ["shop-b", "mince", [null]],
    ]);
    expect(cards[0].best.discount).toBe(40);
  });

  it("sort by the most off (those without a discount last), $/kg, price or name", () => {
    const cards = productsOf(specials);
    expect(sortProducts(cards, "discount").map((c) => c.name)).toEqual(["rump", "mince", "wings"]);
    expect(sortProducts(cards, "unit").map((c) => c.name)).toEqual(["wings", "rump", "mince"]);
    expect(sortProducts(cards, "price").map((c) => c.name)).toEqual(["mince", "wings", "rump"]);
    expect(sortProducts(cards, "name").map((c) => c.name)).toEqual(["mince", "rump", "wings"]);
  });

  it("narrow to the suppliers picked and every word typed, sizes included", () => {
    const cards = productsOf(specials);
    expect(filterProducts(cards, new Set(["shop-b"]), "").map((c) => c.name)).toEqual(["mince"]);
    expect(filterProducts(cards, new Set(), "RUMP 1kg").map((c) => c.name)).toEqual(["rump"]);
    expect(filterProducts(cards, new Set(), "rump 2kg")).toEqual([]);
  });

  it("write money and Melbourne days as the page shows them", () => {
    expect(dollars(1234.5)).toBe("$1,234.50");
    expect(perKg(26.6)).toBe("$27/kg");
    const now = wallClock("2026-11-02", "18:40");
    expect(whenText(new Date(wallClock("2026-11-02", "08:00")).toISOString(), now)).toBe("today 08:00");
    expect(whenText(new Date(wallClock("2026-11-03", "08:00")).toISOString(), now)).toBe("tomorrow 08:00");
    expect(whenText(new Date(wallClock("2026-11-01", "08:01")).toISOString(), now)).toBe("yesterday 08:01");
    expect(whenText(new Date(wallClock("2026-10-20", "08:00")).toISOString(), now)).toBe("2026-10-20 08:00");
  });
});
