// Asking each supplier's storefront what it has, through its public feed (no sign-in, nothing but GETs and the
// Storefront API's read-only query), and reading the answers into specials (parse.ts). One adapter a storefront kind:
//
//   shopify             the collection's products.json, a page of 250 at a time; its collection page when the feed
//                       does not answer (the steak watcher's fallback)
//   shopify-storefront  a headless Shopify storefront: the Storefront API, with the public token its own page carries
//   woocommerce         the Store API: the specials category's products, or every product on sale when there is no
//                       such category; a variable product's sizes read from its page
//   wix                 the storefront's page, its product cards

import { Clock, Data, Effect } from "effect";
import { acceptLanguage } from "../../../sdk/server.ts";
import type { Special, SupplierPull } from "../wire.ts";
import {
  hasNextPage, isVariable, shopifyCollectionPage, shopifyProducts, specialsOf, STOREFRONT_QUERY, storefrontConfig, storefrontProducts,
  wixProducts, wooProduct, wooVariations, type Product, type WooProduct,
} from "./parse.ts";
import type { Supplier } from "./suppliers.ts";

/** A storefront that did not answer, or answered with something that could not be read. */
export class FetchFailed extends Data.TaggedError("FetchFailed")<{ readonly message: string }> {}

export interface FetchOptions {
  /** The fetch to use (a test's own). */
  fetch?: typeof globalThis.fetch;
  /** How long one request may take. */
  timeoutMs?: number;
}

const USER_AGENT = "LifeArchiveShopping/1.0 (+personal price monitor)";
const MAX_PAGES = 10;
/** Variable products' pages read at once, for one supplier. */
const PAGES_AT_ONCE = 4;

/** What an adapter read: the supplier's products, and how, when not its usual way. */
interface Read {
  products: Product[];
  via: string | null;
}

/** One supplier's pull: its specials, and its part of the pull's record. Never fails: a failure is its record's. */
export const pullSupplier = (supplier: Supplier, options: FetchOptions = {}): Effect.Effect<{ part: SupplierPull; specials: Special[] }> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const read = yield* Effect.result(ADAPTERS[supplier.adapter](supplier, options));
    const ms = (yield* Clock.currentTimeMillis) - started;
    const base = { id: supplier.id, name: supplier.name, url: supplier.url, adapter: supplier.adapter, ms };
    if (read._tag === "Failure") {
      return { part: { ...base, status: "failed", working: false, note: read.failure.message, via: null, scanned: 0, specials: 0 }, specials: [] };
    }
    const { products, via } = read.success;
    const specials = specialsOf(supplier.id, products, supplier.listsSpecials);
    const note = specials.length > 0 ? null : products.length === 0 ? "its page listed no products" : `none of its ${products.length} products is on special`;
    return { part: { ...base, status: "ok", working: specials.length > 0, note, via, scanned: products.length, specials: specials.length }, specials };
  });

const ADAPTERS: Record<Supplier["adapter"], (supplier: Supplier, options: FetchOptions) => Effect.Effect<Read, FetchFailed>> = {
  shopify: (supplier, options) =>
    shopifyFeed(supplier, options).pipe(
      Effect.catch((feedFailed) =>
        shopifyPages(supplier, options).pipe(
          Effect.map((products) => ({ products, via: `its collection page (products.json: ${feedFailed.message})` })),
          Effect.mapError((pageFailed) => new FetchFailed({ message: `${feedFailed.message}; and its collection page: ${pageFailed.message}` })),
        ),
      ),
    ),
  "shopify-storefront": (supplier, options) => storefront(supplier, options).pipe(Effect.map((products) => ({ products, via: null }))),
  woocommerce: (supplier, options) => woocommerce(supplier, options).pipe(Effect.map((products) => ({ products, via: null }))),
  wix: (supplier, options) => text(supplier.url, "text/html", options).pipe(Effect.map((html) => ({ products: wixProducts(html), via: null }))),
};

// --- Asking ---

/** The answer to a request, once it is a 2xx; anything else is FetchFailed, said with the address. */
const request = (url: string, init: RequestInit, { fetch = globalThis.fetch, timeoutMs = 20_000 }: FetchOptions) =>
  Effect.tryPromise({
    try: (signal) => fetch(url, { ...init, signal, headers: { "user-agent": USER_AGENT, "accept-language": acceptLanguage(), ...init.headers } }),
    catch: (error) => new FetchFailed({ message: `could not reach ${url}: ${(error as Error).message}` }),
  }).pipe(
    Effect.flatMap((res) => (res.ok ? Effect.succeed(res) : Effect.fail(new FetchFailed({ message: `${url} answered ${res.status}` })))),
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new FetchFailed({ message: `${url} took more than ${Math.round(timeoutMs / 1000)} s` })) }),
  );

const text = (url: string, accept: string, options: FetchOptions) =>
  request(url, { headers: { accept } }, options).pipe(
    Effect.flatMap((res) => Effect.tryPromise({ try: () => res.text(), catch: () => new FetchFailed({ message: `could not read ${url}` }) })),
  );

/** JSON from `url`, and the answer's headers; an answer that is not JSON (a page in its place) is FetchFailed. */
const json = (url: string, options: FetchOptions, init: RequestInit = {}) =>
  request(url, { ...init, headers: { accept: "application/json", ...init.headers } }, options).pipe(
    Effect.flatMap((res) =>
      /json/i.test(res.headers.get("content-type") ?? "")
        ? Effect.tryPromise({ try: async () => ({ body: (await res.json()) as unknown, headers: res.headers }), catch: () => new FetchFailed({ message: `${url} sent JSON that could not be read` }) })
        : Effect.fail(new FetchFailed({ message: `${url} sent a page, not JSON` })),
    ),
  );

// --- Shopify ---

const SHOPIFY_PAGE = 250;

const shopifyFeed = Effect.fnUntraced(function* (supplier: Supplier, options: FetchOptions) {
  const collection = new URL(supplier.url);
  const products: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { body } = yield* json(`${collection.origin}${collection.pathname.replace(/\/$/, "")}/products.json?limit=${SHOPIFY_PAGE}&page=${page}`, options);
    const batch = (body as { products?: unknown[] }).products;
    if (!Array.isArray(batch)) return yield* new FetchFailed({ message: `${supplier.name}'s products.json has no products` });
    products.push(...batch);
    if (batch.length < SHOPIFY_PAGE) break;
  }
  return { products: shopifyProducts(products as Parameters<typeof shopifyProducts>[0], collection.origin), via: null };
});

const shopifyPages = Effect.fnUntraced(function* (supplier: Supplier, options: FetchOptions) {
  const collection = new URL(supplier.url);
  const products: Product[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const at = new URL(supplier.url);
    at.searchParams.set("page", String(page));
    const html = yield* text(at.toString(), "text/html", options);
    for (const product of shopifyCollectionPage(html, collection.origin)) {
      if (seen.has(product.offers[0].url)) continue;
      seen.add(product.offers[0].url);
      products.push(product);
    }
    if (!hasNextPage(html, page)) break;
  }
  return products;
});

const storefront = Effect.fnUntraced(function* (supplier: Supplier, options: FetchOptions) {
  const site = new URL(supplier.url);
  const handle = /\/collections\/([^/?#]+)/.exec(site.pathname)?.[1];
  if (!handle) return yield* new FetchFailed({ message: `${supplier.url} is not a collection's page` });
  const config = storefrontConfig(yield* text(supplier.url, "text/html", options));
  if (!config) return yield* new FetchFailed({ message: `${supplier.name}'s page no longer says where its Storefront API is (shopifyStorefrontToken, shopifyCheckoutDomain)` });
  const api = `https://${config.domain}/api/2025-01/graphql.json`;
  const nodes: unknown[] = [];
  let after: string | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { body } = yield* json(api, options, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-storefront-access-token": config.token },
      body: JSON.stringify({ query: STOREFRONT_QUERY, variables: { handle, after } }),
    });
    const answer = body as { data?: { collection?: { products?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } } | null }; errors?: Array<{ message?: string }> };
    if (answer.errors?.length) return yield* new FetchFailed({ message: `${supplier.name}'s Storefront API: ${answer.errors.map((e) => e.message).join("; ")}` });
    const products = answer.data?.collection?.products;
    if (!products) return yield* new FetchFailed({ message: `${supplier.name}'s Storefront API has no collection ${handle}` });
    nodes.push(...(products.nodes ?? []));
    if (!products.pageInfo?.hasNextPage) break;
    after = products.pageInfo.endCursor ?? null;
  }
  return storefrontProducts(nodes as Parameters<typeof storefrontProducts>[0], site.origin);
});

// --- WooCommerce ---

const WOO_PAGE = 100;

const woocommerce = Effect.fnUntraced(function* (supplier: Supplier, options: FetchOptions) {
  const origin = new URL(supplier.url).origin;
  const store = `${origin}/wp-json/wc/store/v1`;
  let filter = "on_sale=true";
  if (supplier.specialsCategory) {
    const { body } = yield* json(`${store}/products/categories?per_page=100`, options);
    const category = (body as Array<{ id?: number; slug?: string }>).find?.((c) => c.slug === supplier.specialsCategory);
    if (!category?.id) return yield* new FetchFailed({ message: `${supplier.name} has no product category ${supplier.specialsCategory}` });
    filter = `category=${category.id}`;
  }
  const products: WooProduct[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { body, headers } = yield* json(`${store}/products?${filter}&per_page=${WOO_PAGE}&page=${page}`, options);
    if (!Array.isArray(body)) return yield* new FetchFailed({ message: `${supplier.name}'s Store API sent no list of products` });
    products.push(...(body as WooProduct[]));
    if (page >= Number(headers.get("x-wp-totalpages") ?? 1) || body.length < WOO_PAGE) break;
  }
  // A variable product's sizes are on its page; one that cannot be read is shown at its own (lowest) price.
  return yield* Effect.forEach(
    products,
    (product) =>
      isVariable(product) && product.is_in_stock && product.permalink
        ? text(product.permalink, "text/html", options).pipe(
            Effect.map((html) => wooProduct(product, wooVariations(html))),
            Effect.orElseSucceed(() => wooProduct(product, null)),
          )
        : Effect.succeed(wooProduct(product, null)),
    { concurrency: PAGES_AT_ONCE },
  );
});
