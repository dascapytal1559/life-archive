import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, beforeEach } from "vitest";
import { Context, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { moduleApi, serve, SettingsProblem, wallClock } from "../../../sdk/server.ts";
import { SHOPPING_API, SHOPPING_FORMAT, type ShoppingAnswer, type ShoppingPull } from "../wire.ts";
import { pullSupplier } from "./fetch.ts";
import { shoppingRoute } from "./http.ts";
import {
  pricedPerKg, shopifyCollectionPage, shopifyProducts, specialsOf, storefrontConfig, storefrontProducts, weightKg, wixProducts, wooProduct, wooVariations, type Product,
} from "./parse.ts";
import { latestPull, mornings, nextMorning, pullsFolder, Shopping } from "./pull.ts";
import { readSuppliers, suppliersFile, type Supplier } from "./suppliers.ts";

const offer = (price: number, was: number | null, more: Partial<Product["offers"][number]> = {}): Product["offers"][number] => ({
  variant: null, url: "https://shop.example/p", image: null, price, was, available: true, weightKg: null, ...more,
});

describe("weights", () => {
  it("reads a pack of several whole, a range's top, and the last weight named", () => {
    expect(weightKg("rump steak 2 x 300g")).toBe(0.6);
    expect(weightKg("sausages 4 x 250-300g")).toBe(1.2);
    expect(weightKg("chops 300g x 2 pieces")).toBe(0.6);
    expect(weightKg("brisket, about 1.5kg")).toBe(1.5);
    expect(weightKg("lamb mince 500 grams")).toBe(0.5);
    expect(weightKg("whole leg 2 kilos")).toBe(2);
    expect(weightKg("marinade jar")).toBeNull();
    expect(weightKg("$12 off 500g")).toBe(0.5);
  });

  it("knows a name priced by the kilogram", () => {
    expect(pricedPerKg("brisket $19.99kg", 19.99)).toBe(true);
    expect(pricedPerKg("brisket $19.99/kg", 19.99)).toBe(true);
    expect(pricedPerKg("brisket $19.99kg", 39.98)).toBe(false);
    expect(pricedPerKg("brisket 1kg", 19.99)).toBe(false);
  });
});

describe("specials", () => {
  it("keeps what is marked down and in stock, each size apart, with its discount and price a kilogram", () => {
    const products: Product[] = [
      { name: "rump steak", offers: [offer(20, 25, { variant: "500g", weightKg: 0.5 }), offer(38, 50, { variant: "1kg", weightKg: 1 }), offer(70, 70, { variant: "2kg", weightKg: 2 })] },
      { name: "sold-out cutlets", offers: [offer(10, 20, { available: false })] },
      { name: "full-price mince", offers: [offer(12, null)] },
    ];
    const specials = specialsOf("shop", products, false);
    expect(specials).toEqual([
      expect.objectContaining({ name: "rump steak", variant: "500g", price: 20, was: 25, discount: 20, basis: "markdown", unitPrice: 40, wasUnitPrice: 50 }),
      expect.objectContaining({ name: "rump steak", variant: "1kg", price: 38, was: 50, discount: 24, unitPrice: 38 }),
    ]);
  });

  it("keeps the cheapest in stock as a listed special where the supplier's page lists only specials and nothing is marked down", () => {
    const products: Product[] = [
      { name: "bulk wings", offers: [offer(30, null, { variant: "plain" }), offer(25, null, { variant: "spicy" }), offer(20, null, { variant: "smoked", available: false })] },
      { name: "chops", offers: [offer(10, 12), offer(9, null)] },
    ];
    expect(specialsOf("shop", products, true)).toEqual([
      expect.objectContaining({ name: "bulk wings", variant: "spicy", price: 25, was: null, discount: null, basis: "listed" }),
      expect.objectContaining({ name: "chops", price: 10, was: 12, basis: "markdown" }),
    ]);
    expect(specialsOf("shop", products, false).map((s) => s.name)).toEqual(["chops"]);
  });

  it("prices a product named by its kilogram price by the kilogram", () => {
    const [special] = specialsOf("shop", [{ name: "brisket $19.99kg", offers: [offer(19.99, 24.99)] }], false);
    expect(special).toMatchObject({ weightKg: null, unitPrice: 19.99, wasUnitPrice: 24.99 });
  });
});

describe("storefronts", () => {
  it("reads Shopify's products.json, a size's weight from its label, the name's, or its shipping weight", () => {
    const [product] = shopifyProducts(
      [{ title: "lamb chops &amp; rub", handle: "lamb-chops", images: [{ src: "https://cdn.example/chops.jpg" }], variants: [
        { id: 1, title: "500g", price: "15.00", compare_at_price: "20.00", available: true, grams: 0 },
        { id: 2, title: "Family", price: "40.00", compare_at_price: null, available: true, grams: 2000 },
      ] }],
      "https://shop.example",
    );
    expect(product).toEqual({
      name: "lamb chops & rub",
      offers: [
        { variant: "500g", url: "https://shop.example/products/lamb-chops?variant=1", image: "https://cdn.example/chops.jpg", price: 15, was: 20, available: true, weightKg: 0.5 },
        { variant: "Family", url: "https://shop.example/products/lamb-chops?variant=2", image: "https://cdn.example/chops.jpg", price: 40, was: null, available: true, weightKg: 2 },
      ],
    });
  });

  it("reads a Shopify collection page's cards when the feed is down", () => {
    const html = `<div class="ProductItem ">
      <img data-src="//cdn.example/{width}/wings.jpg">
      <h2 class="ProductItem__Title Heading"><a href="/collections/specials/products/chicken-wings">chicken wings 1kg</a></h2>
      <span class="ProductItem__Price Price Price--highlight Text--subdued">$8.00</span>
      <span class="ProductItem__Price Price Price--compareAt Text--subdued">$10.00</span>
    </div><div class="ProductItem ">
      <h2 class="ProductItem__Title Heading"><a href="/products/gone">gone</a></h2>
      <span class="ProductItem__Price Price">$5.00</span> SOLD OUT
    </div>`;
    expect(shopifyCollectionPage(html, "https://shop.example")).toEqual([
      { name: "chicken wings 1kg", offers: [{ variant: null, url: "https://shop.example/products/chicken-wings", image: "https://cdn.example/400/wings.jpg", price: 8, was: 10, available: true, weightKg: 1 }] },
      { name: "gone", offers: [{ variant: null, url: "https://shop.example/products/gone", image: null, price: 5, was: null, available: false, weightKg: null }] },
    ]);
  });

  it("finds a headless storefront's Storefront API on its page, and reads its products", () => {
    const page = `<script>window.__NUXT__.config={public:{shopifyCheckoutDomain:"checkout.shop.example",shopifyStorefrontToken:"0123456789abcdef0123456789abcdef"}}</script>`;
    expect(storefrontConfig(page)).toEqual({ domain: "checkout.shop.example", token: "0123456789abcdef0123456789abcdef" });
    expect(storefrontConfig("<html></html>")).toBeNull();
    const [product] = storefrontProducts(
      [{ handle: "pork-belly", title: "pork belly", featuredImage: { url: "https://cdn.example/belly.jpg" }, variants: { nodes: [
        { id: "gid://shopify/ProductVariant/77", title: "Default Title", availableForSale: true, price: { amount: "30.0" }, compareAtPrice: { amount: "40.0" }, weight: 1.2, weightUnit: "KILOGRAMS" },
      ] } }],
      "https://www.shop.example",
    );
    expect(product.offers).toEqual([{ variant: null, url: "https://www.shop.example/products/pork-belly?variant=77", image: "https://cdn.example/belly.jpg", price: 30, was: 40, available: true, weightKg: 1.2 }]);
  });

  it("reads WooCommerce's Store API, and a variable product's sizes by their names", () => {
    const simple = wooProduct({ name: "kangaroo burgers &#8211; 6", permalink: "https://shop.example/p/k/", is_in_stock: true, prices: { price: "1595", regular_price: "2395", currency_minor_unit: 2 } }, null);
    expect(simple.offers).toEqual([{ variant: null, url: "https://shop.example/p/k/", image: null, price: 15.95, was: 23.95, available: true, weightKg: null }]);
    const page = `<form data-product_variations="${JSON.stringify([
      { variation_id: 5, attributes: { "attribute_pa_weight": "1-5kg" }, display_price: 30, display_regular_price: 36, is_in_stock: true, variation_is_active: true },
      { variation_id: 6, attributes: { "attribute_pa_weight": "3kg" }, display_price: 58, display_regular_price: 58, is_in_stock: false },
    ]).replaceAll('"', "&quot;")}">`;
    const variable = wooProduct(
      { name: "lamb leg", permalink: "https://shop.example/p/leg/", type: "variable", variations: [5, 6], is_in_stock: true, attributes: [{ taxonomy: "pa_weight", terms: [{ name: "1.5kg", slug: "1-5kg" }, { name: "3kg", slug: "3kg" }] }] },
      wooVariations(page),
    );
    expect(variable.offers).toEqual([
      { variant: "1.5kg", url: "https://shop.example/p/leg/?variation_id=5", image: null, price: 30, was: 36, available: true, weightKg: 1.5 },
      { variant: "3kg", url: "https://shop.example/p/leg/?variation_id=6", image: null, price: 58, was: 58, available: false, weightKg: 3 },
    ]);
    expect(wooVariations("<form>")).toBeNull();
  });

  it("reads a Wix storefront page's cards", () => {
    const card = (name: string, link: string, prices: string) =>
      `<li data-hook="product-item-root"><img src="https://static.wixstatic.com/media/${link}.jpg"><a href="https://shop.example/product-page/${link}"><p data-hook="product-item-name">${name}</p></a>${prices}</li>`;
    const html = [
      card("2 x eye fillet steaks", "eye", `<span data-hook="product-item-price-before-discount" data-wix-original-price="$30.00"></span><span data-hook="product-item-price-to-pay" data-wix-price="$24.00"></span>`),
      card("beef mince 250g", "mince", `<span data-hook="product-item-price-to-pay" data-wix-price="$6.50"></span>`),
    ].join("");
    expect(wixProducts(html)).toEqual([
      { name: "2 x eye fillet steaks", offers: [{ variant: null, url: "https://shop.example/product-page/eye", image: "https://static.wixstatic.com/media/eye.jpg", price: 24, was: 30, available: true, weightKg: null }] },
      { name: "beef mince 250g", offers: [{ variant: null, url: "https://shop.example/product-page/mince", image: "https://static.wixstatic.com/media/mince.jpg", price: 6.5, was: null, available: true, weightKg: 0.25 }] },
    ]);
  });
});

/** A made-up storefront: each address answers what `pages` says, or 404. */
function storefront(pages: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const page = pages[url];
    return page ? page() : new Response("not here", { status: 404, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
}

const asJson = (body: unknown) => () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const asPage = (body: string) => () => new Response(body, { headers: { "content-type": "text/html" } });

const SHOPIFY: Supplier = { id: "sample-shop", name: "sample butcher", url: "https://shop.example/collections/specials", adapter: "shopify", listsSpecials: false };
const FEED = "https://shop.example/collections/specials/products.json?limit=250&page=1";

describe("a supplier's pull", () => {
  it.effect("is working when it finds a special, and says why not otherwise", () =>
    Effect.gen(function* () {
      const markdown = { products: [{ title: "veal 600g", handle: "veal", variants: [{ id: 1, title: "Default Title", price: "26.40", compare_at_price: "33.00", available: true }] }] };
      const found = yield* pullSupplier(SHOPIFY, { fetch: storefront({ [FEED]: asJson(markdown) }) });
      expect(found.part).toMatchObject({ status: "ok", working: true, note: null, via: null, scanned: 1, specials: 1 });
      expect(found.specials[0]).toMatchObject({ supplier: "sample-shop", price: 26.4, was: 33, discount: 20, unitPrice: 44 });

      const none = yield* pullSupplier(SHOPIFY, { fetch: storefront({ [FEED]: asJson({ products: [{ title: "veal", handle: "veal", variants: [{ price: "26.40", available: true }] }] }) }) });
      expect(none.part).toMatchObject({ status: "ok", working: false, note: "none of its 1 products is on special" });

      const down = yield* pullSupplier(SHOPIFY, { fetch: storefront({}) });
      expect(down.part).toMatchObject({ status: "failed", working: false, scanned: 0 });
      expect(down.part.note).toContain("answered 404");
    }));

  it.effect("falls back to Shopify's collection page when products.json sends a page", () =>
    Effect.gen(function* () {
      const card = `<div class="ProductItem "><h2 class="ProductItem__Title"><a href="/products/wings">wings 1kg</a></h2><span class="ProductItem__Price Price--highlight">$8.00</span><span class="ProductItem__Price Price--compareAt">$10.00</span></div>`;
      const { part, specials } = yield* pullSupplier(SHOPIFY, {
        fetch: storefront({ [FEED]: asPage("<html>"), "https://shop.example/collections/specials?page=1": asPage(card) }),
      });
      expect(part).toMatchObject({ status: "ok", working: true, specials: 1 });
      expect(part.via).toContain("its collection page");
      expect(specials[0]).toMatchObject({ name: "wings 1kg", price: 8, was: 10 });
    }));

  it.effect("reads a headless storefront through the Storefront API its page names", () =>
    Effect.gen(function* () {
      const supplier: Supplier = { ...SHOPIFY, adapter: "shopify-storefront", listsSpecials: true };
      const page = `shopifyCheckoutDomain:"checkout.shop.example",shopifyStorefrontToken:"0123456789abcdef0123456789abcdef"`;
      const answer = { data: { collection: { products: { pageInfo: { hasNextPage: false }, nodes: [
        { handle: "wings", title: "wings 2kg", variants: { nodes: [{ id: "gid://shopify/ProductVariant/9", title: "Default Title", availableForSale: true, price: { amount: "26.0" }, compareAtPrice: null }] } },
      ] } } } };
      const { part, specials } = yield* pullSupplier(supplier, {
        fetch: storefront({ [SHOPIFY.url]: asPage(page), "https://checkout.shop.example/api/2025-01/graphql.json": asJson(answer) }),
      });
      expect(part).toMatchObject({ status: "ok", working: true, specials: 1 });
      expect(specials[0]).toMatchObject({ name: "wings 2kg", price: 26, basis: "listed", unitPrice: 13 });
    }));

  it.effect("reads a WooCommerce supplier's specials category", () =>
    Effect.gen(function* () {
      const supplier: Supplier = { id: "sample-woo", name: "sample woo", url: "https://woo.example/product-category/specials/", adapter: "woocommerce", listsSpecials: true, specialsCategory: "specials" };
      const store = "https://woo.example/wp-json/wc/store/v1";
      const { part, specials } = yield* pullSupplier(supplier, {
        fetch: storefront({
          [`${store}/products/categories?per_page=100`]: asJson([{ id: 7, slug: "meat" }, { id: 9, slug: "specials" }]),
          [`${store}/products?category=9&per_page=100&page=1`]: asJson([
            { name: "chops 1kg", permalink: "https://woo.example/p/chops/", is_in_stock: true, prices: { price: "1500", regular_price: "1500", currency_minor_unit: 2 } },
          ]),
        }),
      });
      expect(part).toMatchObject({ status: "ok", working: true, specials: 1 });
      expect(specials[0]).toMatchObject({ name: "chops 1kg", price: 15, basis: "listed", unitPrice: 15 });
    }));
});

describe("the mornings", () => {
  it("are at 08:00 Melbourne time, today's while still to come, else tomorrow's", () => {
    expect(nextMorning(wallClock("2026-11-02", "07:59"))).toBe(wallClock("2026-11-02", "08:00"));
    expect(nextMorning(wallClock("2026-11-02", "08:00"))).toBe(wallClock("2026-11-03", "08:00"));
    // Across the change to daylight saving (4 October 2026), still 08:00 by the clock.
    expect(nextMorning(wallClock("2026-10-03", "09:00"))).toBe(wallClock("2026-10-04", "08:00"));
  });
});

/** The mornings run over the service, as the server runs the module's work, in a fiber of their own (interrupted to stop them). */
const running = (layer: Layer.Layer<Shopping>) => Effect.forkChild(mornings().pipe(Effect.provide(layer)), { startImmediately: true });

describe("the Shopping service", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "shopping-"));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const markdown = asJson({ products: [{ title: "veal 600g", handle: "veal", variants: [{ id: 1, price: "26.40", compare_at_price: "33.00", available: true }] }] });
  const counted = () => {
    let asked = 0;
    const fetch = storefront({ [FEED]: () => (asked++, markdown()) });
    return { fetch, asked: () => asked };
  };

  it.effect("pulls once at start when today has none and its morning has passed, then each morning, keeping each pull", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wallClock("2026-11-02", "09:30"));
      const { fetch, asked } = counted();
      const fiber = yield* running(Shopping.layer(dataDir, { suppliers: [SHOPIFY], fetch }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(0);
      expect(asked()).toBe(1);
      expect(latestPull(pullsFolder(dataDir))).toMatchObject({ format: SHOPPING_FORMAT, trigger: "catch-up", specials: [expect.objectContaining({ name: "veal 600g" })] });

      yield* TestClock.setTime(wallClock("2026-11-03", "08:00"));
      yield* Effect.yieldNow;
      expect(asked()).toBe(2);
      expect(latestPull(pullsFolder(dataDir))?.trigger).toBe("daily");
      expect(readdirSync(pullsFolder(dataDir)).filter((f) => f.endsWith(".json"))).toHaveLength(2);
      yield* Fiber.interrupt(fiber);
    }));

  it.effect("waits for the morning when started before it, and leaves a day that has its pull alone", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wallClock("2026-11-02", "07:00"));
      const early = counted();
      const fiber = yield* running(Shopping.layer(dataDir, { suppliers: [SHOPIFY], fetch: early.fetch }));
      yield* Effect.yieldNow;
      expect(early.asked()).toBe(0);
      yield* Fiber.interrupt(fiber);

      // Today's pull kept (at 07:00 by hand, say): started at 10:00, no catch-up.
      const kept: ShoppingPull = { format: SHOPPING_FORMAT, startedAt: new Date(wallClock("2026-11-02", "07:00")).toISOString(), finishedAt: new Date(wallClock("2026-11-02", "07:00")).toISOString(), trigger: "refresh", suppliers: [], specials: [] };
      const folder = pullsFolder(dataDir);
      yield* Effect.sync(() => {
        rmSync(folder, { recursive: true, force: true });
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, `${kept.startedAt.replace(/:/g, "-")}.json`), JSON.stringify(kept));
      });
      yield* TestClock.setTime(wallClock("2026-11-02", "10:00"));
      const later = counted();
      const again = yield* running(Shopping.layer(dataDir, { suppliers: [SHOPIFY], fetch: later.fetch }));
      yield* Effect.yieldNow;
      expect(later.asked()).toBe(0);
      yield* Fiber.interrupt(again);
    }));

  it.live("answers the page: the latest pull, and a pull on Refresh, which only the page itself may ask for", () =>
    Effect.gen(function* () {
      const { fetch } = counted();
      const context = yield* Layer.build(Shopping.layer(dataDir, { suppliers: [SHOPIFY], fetch }));
      const server: Server = createServer(serve(Context.make(Shopping, Context.get(context, Shopping)), shoppingRoute));
      yield* Effect.acquireRelease(Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))), () => Effect.sync(() => server.close()));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const base = `${origin}${SHOPPING_API}`;
      const call = (init?: RequestInit, at = base) => Effect.promise(async () => {
        const res = await globalThis.fetch(at, init);
        return { status: res.status, body: (await res.json()) as ShoppingAnswer & { error?: string } };
      });

      const before = yield* call();
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({ pull: null, pulling: false, suppliers: 1 });
      // The module's own address answers the same; no other path does.
      expect((yield* call(undefined, `${origin}${moduleApi("shopping")}`)).body).toMatchObject({ pull: null, suppliers: 1 });
      expect((yield* call(undefined, `${base}/elsewhere`)).status).toBe(404);

      const noOrigin = yield* call({ method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(noOrigin.status).toBe(403);
      const elsewhere = yield* call({ method: "POST", headers: { "content-type": "application/json", origin: "https://elsewhere.example" }, body: "{}" });
      expect(elsewhere.status).toBe(403);

      const pulled = yield* call({ method: "POST", headers: { "content-type": "application/json", origin: new URL(base).origin }, body: "{}" });
      expect(pulled.status).toBe(200);
      expect(pulled.body.pull).toMatchObject({ trigger: "refresh", suppliers: [expect.objectContaining({ working: true })] });
      expect((yield* call()).body.pull?.specials).toHaveLength(1);
    }).pipe(Effect.scoped));

  it.effect("pulls nothing in the mornings with no suppliers, and tells the page so", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wallClock("2026-11-02", "09:30"));
      const { fetch, asked } = counted();
      const answer = yield* Effect.gen(function* () {
        // The mornings end at once rather than wait for a morning.
        yield* mornings();
        return yield* (yield* Shopping).answer;
      }).pipe(Effect.provide(Shopping.layer(dataDir, { suppliers: [], fetch })));
      expect(asked()).toBe(0);
      expect(answer).toMatchObject({ pull: null, suppliers: 0 });
    }));
});

describe("the suppliers", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "shopping-suppliers-"));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
  const shop = { id: "sample-shop", name: "Sampleshop", url: "https://shop.example/specials", adapter: "shopify", listsSpecials: true };

  it("are none with no file", () => {
    expect(readSuppliers(dataDir)).toEqual([]);
  });

  it("are the file's list, and a list that cannot be used stops", () => {
    mkdirSync(join(dataDir, "shopping"));
    writeFileSync(suppliersFile(dataDir), JSON.stringify([shop]));
    expect(readSuppliers(dataDir)).toEqual([shop]);
    writeFileSync(suppliersFile(dataDir), JSON.stringify([{ ...shop, adapter: "carrier-pigeon" }]));
    expect(() => readSuppliers(dataDir)).toThrow(SettingsProblem);
  });
});

