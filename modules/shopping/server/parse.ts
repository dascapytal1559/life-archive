// What the storefronts send, read into specials: plain functions, one family a storefront kind, each from the
// steak watcher's adapters without their cut matching. fetch.ts asks the storefronts and hands their answers here.
//
// Every storefront's products become Offers, one a product's size or option; specialsOf keeps a product's in-stock
// offers that are marked down (the price below the price it was), or, for a supplier whose page lists only specials,
// its cheapest in-stock offer when none is marked down.

import { decodeEntities } from "../../../sdk/server.ts";
import type { Special } from "../wire.ts";

/** One size or option of a product, as the storefront prices it. */
export interface Offer {
  /** The size or option's own label, or null for a product with only one. */
  variant: string | null;
  url: string;
  image: string | null;
  price: number;
  /** The compare-at or regular price, when the storefront gives one. */
  was: number | null;
  available: boolean;
  weightKg: number | null;
}

/** A product: its name and its offers. */
export interface Product {
  name: string;
  offers: Offer[];
}

/**
 * The specials among `products` from the supplier `supplier`: each in-stock offer marked down, or, when the supplier's
 * page lists only specials (`listsSpecials`) and none of a product's offers is marked down, its cheapest in stock.
 */
export function specialsOf(supplier: string, products: readonly Product[], listsSpecials: boolean): Special[] {
  const specials: Special[] = [];
  for (const product of products) {
    const inStock = product.offers.filter((offer) => offer.available && offer.price > 0);
    const markedDown = inStock.filter((offer) => offer.was !== null && offer.was > offer.price);
    const kept = markedDown.length > 0 ? markedDown : listsSpecials && inStock.length > 0 ? [cheapest(inStock)] : [];
    for (const offer of kept) specials.push(special(supplier, product, offer, markedDown.length > 0));
  }
  return specials;
}

const cheapest = (offers: readonly Offer[]) => offers.reduce((best, offer) => (offer.price < best.price ? offer : best));

function special(supplier: string, product: Product, offer: Offer, markedDown: boolean): Special {
  const was = markedDown ? offer.was : null;
  // A product named by its price a kilogram ("Brisket $19.99kg") with no weight of its own is priced by the kilogram.
  const kg = offer.weightKg ?? (pricedPerKg(product.name, offer.price) ? 1 : null);
  const perKg = (price: number | null) => (price !== null && kg ? cents(price / kg) : null);
  return {
    supplier,
    name: product.name,
    // A size is named only where there is more than one to tell apart.
    variant: product.offers.length > 1 ? offer.variant : null,
    url: offer.url,
    image: offer.image,
    price: cents(offer.price),
    was: was === null ? null : cents(was),
    discount: was === null ? null : Math.round(((was - offer.price) / was) * 100),
    basis: markedDown ? "markdown" : "listed",
    weightKg: offer.weightKg,
    unitPrice: perKg(offer.price),
    wasUnitPrice: perKg(was),
  };
}

const cents = (value: number) => Math.round(value * 100) / 100;

/** Whether a name gives `price` as its price a kilogram: "$19.99kg", "$19.99/kg", "$19.99 per kg". */
export function pricedPerKg(name: string, price: number): boolean {
  const said = /\$\s*(\d[\d,]*(?:\.\d+)?)\s*(?:\/|per)?\s*kg\b/i.exec(name)?.[1];
  return said !== undefined && Math.abs(money(said) - price) < 0.005;
}

/** A price as text ("12.50", "$1,299.00"), in dollars; 0 when there is none. */
export function money(value: unknown): number {
  const amount = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/** A was-price, or null when there is none (missing, zero, or not a number). */
const wasOf = (value: unknown): number | null => money(value) || null;

// --- Weights, from a name or a size's label (the steak watcher's rules) ---

const NUMBER = String.raw`\d+(?:\.\d+)?`;
/** A unit of weight: kg, kilo(s), kilogram(s), g, gram(s). */
const UNIT = String.raw`(?<unit>kg|kilo(?:gram)?s?|g|grams?)\b`;
/** "2 x 300g", and "4 x 250-300g" (the range's top). */
const RANGE_MULTIPACK = new RegExp(String.raw`(?<![\d.$])(?<count>${NUMBER})\s*[x×]\s*(?:\D{0,40}?)?${NUMBER}\s*[-–]\s*(?<amount>${NUMBER})\s*${UNIT}`, "i");
const MULTIPACK = new RegExp(String.raw`(?<![\d.$])(?<count>${NUMBER})\s*[x×]\s*(?<amount>${NUMBER})\s*${UNIT}`, "i");
/** "300g x 2", "300g x 2 pieces". */
const REVERSE_MULTIPACK = new RegExp(String.raw`(?<![\d.$])(?<amount>${NUMBER})\s*${UNIT}\s*[x×]\s*(?<count>${NUMBER})(?:\s*pieces?)?\b`, "i");
const SINGLE = new RegExp(String.raw`(?<![\d.$])(?<amount>${NUMBER})\s*${UNIT}`, "gi");

/** The weight a name or label gives, in kilograms: a pack of several counted whole, else its last weight; null for none. */
export function weightKg(text: string): number | null {
  const kg = (amount: string, unit: string, count = "1") => {
    const total = Number(count) * Number(amount);
    return unit[0].toLowerCase() === "k" ? total : total / 1000;
  };
  for (const pattern of [RANGE_MULTIPACK, MULTIPACK, REVERSE_MULTIPACK]) {
    const found = pattern.exec(text)?.groups;
    if (found) return positive(kg(found.amount, found.unit, found.count));
  }
  const last = [...text.matchAll(SINGLE)].at(-1)?.groups;
  return last ? positive(kg(last.amount, last.unit)) : null;
}

const positive = (value: number) => (Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : null);

/** A size's label that names nothing (Shopify's "Default Title"), as null. */
const label = (value: unknown): string | null => {
  const text = decodeEntities(String(value ?? "")).trim();
  return text === "" || text.toLowerCase() === "default title" ? null : text;
};

/** An offer's weight: its own label's, else the product name's, else the storefront's shipping weight in grams. */
function offerWeight(variant: string | null, name: string, grams?: unknown): number | null {
  return (variant && weightKg(variant)) || weightKg(name) || (typeof grams === "number" && grams > 0 && grams <= 50_000 ? grams / 1000 : null);
}

// --- Shopify: a collection's products.json, or its page when the feed is down ---

interface ShopifyVariant {
  id?: number | string;
  title?: string;
  price?: string | number;
  compare_at_price?: string | number | null;
  available?: boolean;
  grams?: number;
}

interface ShopifyProduct {
  title?: string;
  handle?: string;
  images?: Array<{ src?: string }>;
  image?: string | null;
  variants?: ShopifyVariant[];
}

/** A collection's products.json `products`, as Products; `shop` is the shop's origin, for each offer's link. */
export function shopifyProducts(products: readonly ShopifyProduct[], shop: string): Product[] {
  return products.map((product) => {
    const name = decodeEntities(String(product.title ?? "")).trim();
    const image = product.images?.[0]?.src ?? product.image ?? null;
    return {
      name,
      offers: (product.variants ?? []).map((variant) => {
        const own = label(variant.title);
        return {
          variant: own,
          url: `${shop}/products/${product.handle}${variant.id ? `?variant=${variant.id}` : ""}`,
          image,
          price: money(variant.price),
          was: wasOf(variant.compare_at_price),
          available: variant.available === true,
          weightKg: offerWeight(own, name, variant.grams),
        };
      }),
    };
  });
}

const CARD = /<div class="ProductItem[^"]*">/i;
const TITLE_LINK = /<h2 class="ProductItem__Title[^"]*">\s*<a href="(?<href>[^"]+)">(?<title>[\s\S]*?)<\/a>/i;
const PRICE_SPAN = /<span class="(?<class>[^"]*ProductItem__Price[^"]*)"[^>]*>(?<text>[\s\S]*?)<\/span>/gi;
const CARD_IMAGE = /<img[^>]*?(?:data-src|src)="(?<src>[^"]+)"/i;
const TAG = /<[^>]+>/g;

/**
 * A Shopify collection page's product cards (the theme the steak watcher read: ProductItem cards), as Products, each
 * with one offer: what the card shows. The fallback when products.json does not answer.
 */
export function shopifyCollectionPage(html: string, shop: string): Product[] {
  const products: Product[] = [];
  const seen = new Set<string>();
  for (const card of html.split(CARD).slice(1)) {
    const title = TITLE_LINK.exec(card)?.groups;
    const handle = title && /\/products\/([^/?#]+)/.exec(decodeEntities(title.href))?.[1];
    if (!title || !handle || seen.has(handle)) continue;
    seen.add(handle);
    let price = 0;
    let was: number | null = null;
    for (const span of card.matchAll(PRICE_SPAN)) {
      const amount = money(/\$(\d[\d,]*(?:\.\d+)?)/.exec(decodeEntities(span.groups!.text.replace(TAG, "")))?.[1]);
      const kind = span.groups!.class.toLowerCase();
      if (kind.includes("compareat")) was = amount || null;
      else if (kind.includes("highlight") || price === 0) price = amount;
    }
    const name = decodeEntities(title.title.replace(TAG, "")).trim();
    const src = CARD_IMAGE.exec(card)?.groups?.src;
    products.push({
      name,
      offers: [{ variant: null, url: `${shop}/products/${handle}`, image: src ? absolute(decodeEntities(src).replace("{width}", "400")) : null, price, was, available: !/SOLD OUT/i.test(card), weightKg: weightKg(name) }],
    });
  }
  return products;
}

/** A protocol-relative address ("//cdn…") made whole. */
const absolute = (src: string) => (src.startsWith("//") ? `https:${src}` : src);

/** Whether a collection page links its next page. */
export function hasNextPage(html: string, page: number): boolean {
  return new RegExp(`(?:\\?|&amp;|&)page=${page + 1}(?:["&])`).test(html);
}

// --- Shopify's Storefront API, for a headless storefront ---

/** Where a headless Shopify storefront's own page says its Storefront API is, and the public token it uses. */
export function storefrontConfig(html: string): { domain: string; token: string } | null {
  const token = /shopifyStorefrontToken\s*:\s*"([0-9a-f]{32})"/.exec(html)?.[1] ?? /"shopifyStorefrontToken"\s*:\s*"([0-9a-f]{32})"/.exec(html)?.[1];
  const domain = /shopifyCheckoutDomain\s*:\s*"([a-z0-9.-]+)"/.exec(html)?.[1] ?? /"shopifyCheckoutDomain"\s*:\s*"([a-z0-9.-]+)"/.exec(html)?.[1];
  return token && domain ? { domain, token } : null;
}

/** The Storefront API's query for a page of a collection's products, after `cursor`. */
export const STOREFRONT_QUERY = `query Specials($handle: String!, $after: String) {
  collection(handle: $handle) {
    products(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        handle title featuredImage { url }
        variants(first: 50) { nodes { id title availableForSale price { amount } compareAtPrice { amount } weight weightUnit } }
      }
    }
  }
}`;

interface StorefrontProduct {
  handle?: string;
  title?: string;
  featuredImage?: { url?: string } | null;
  variants?: {
    nodes?: Array<{
      id?: string;
      title?: string;
      availableForSale?: boolean;
      price?: { amount?: string } | null;
      compareAtPrice?: { amount?: string } | null;
      weight?: number | null;
      weightUnit?: string | null;
    }>;
  };
}

/** The Storefront API's collection products, as Products; `site` is the storefront's origin, for each offer's link. */
export function storefrontProducts(nodes: readonly StorefrontProduct[], site: string): Product[] {
  return nodes.map((node) => {
    const name = decodeEntities(String(node.title ?? "")).trim();
    return {
      name,
      offers: (node.variants?.nodes ?? []).map((variant) => {
        const own = label(variant.title);
        const grams = variant.weight && variant.weightUnit ? toGrams(variant.weight, variant.weightUnit) : undefined;
        const id = String(variant.id ?? "").split("/").at(-1);
        return {
          variant: own,
          url: `${site}/products/${node.handle}${id ? `?variant=${id}` : ""}`,
          image: node.featuredImage?.url ?? null,
          price: money(variant.price?.amount),
          was: wasOf(variant.compareAtPrice?.amount),
          available: variant.availableForSale === true,
          weightKg: offerWeight(own, name, grams),
        };
      }),
    };
  });
}

const toGrams = (weight: number, unit: string) => ({ GRAMS: weight, KILOGRAMS: weight * 1000, POUNDS: weight * 453.592, OUNCES: weight * 28.3495 })[unit];

// --- WooCommerce's Store API, and a variable product's page for its sizes ---

export interface WooProduct {
  id?: number;
  name?: string;
  permalink?: string;
  type?: string;
  is_in_stock?: boolean;
  images?: Array<{ src?: string; thumbnail?: string }>;
  prices?: { price?: string; regular_price?: string; currency_minor_unit?: number };
  variations?: unknown[];
  attributes?: Array<{ taxonomy?: string | null; terms?: Array<{ name?: string; slug?: string }> }>;
}

/** A Store API price, in its minor units ("1995" with 2 of them), in dollars. */
export function wooMoney(prices: WooProduct["prices"], field: "price" | "regular_price"): number {
  const minor = Number(prices?.currency_minor_unit ?? 2);
  const amount = Number(prices?.[field] ?? 0) / 10 ** (Number.isFinite(minor) ? minor : 2);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/** Whether a Store API product has sizes priced apart, to be read from its page. */
export const isVariable = (product: WooProduct) => product.type === "variable" && (product.variations?.length ?? 0) > 0;

/**
 * A Store API product as a Product: one offer from its own prices, or, for a variable product, one a size from its
 * page's variations (wooVariations), when they were read.
 */
export function wooProduct(product: WooProduct, variations: readonly WooVariation[] | null): Product {
  const name = decodeEntities(String(product.name ?? "")).trim();
  const url = String(product.permalink ?? "");
  const image = product.images?.[0]?.thumbnail ?? product.images?.[0]?.src ?? null;
  if (variations && variations.length > 0) {
    // A variation names a global attribute's term by its slug ("1-5kg"); the product's attributes give its name ("1.5kg").
    const termNames = new Map<string, string>((product.attributes ?? []).flatMap((attribute) => (attribute.terms ?? []).map((term) => [`attribute_${attribute.taxonomy}\n${term.slug}`, term.name ?? ""] as const)));
    return {
      name,
      offers: variations.map((variation) => {
        const own =
          Object.entries(variation.attributes ?? {})
            .filter(([, value]) => value)
            .map(([key, value]) => decodeEntities(termNames.get(`${key}\n${value}`) || String(value)))
            .join(" · ")
            .trim() || null;
        return {
          variant: own,
          url: variation.variation_id ? `${url}?variation_id=${variation.variation_id}` : url,
          image: variation.image?.thumb_src ?? variation.image?.src ?? image,
          price: money(variation.display_price),
          was: wasOf(variation.display_regular_price),
          available: variation.is_in_stock !== false && variation.variation_is_active !== false && variation.is_purchasable !== false,
          weightKg: offerWeight(own, name),
        };
      }),
    };
  }
  return {
    name,
    offers: [{ variant: null, url, image, price: wooMoney(product.prices, "price"), was: wooMoney(product.prices, "regular_price") || null, available: product.is_in_stock === true, weightKg: weightKg(name) }],
  };
}

export interface WooVariation {
  variation_id?: number;
  attributes?: Record<string, string>;
  display_price?: number | string;
  display_regular_price?: number | string;
  is_in_stock?: boolean;
  is_purchasable?: boolean;
  variation_is_active?: boolean;
  image?: { src?: string; thumb_src?: string };
}

/** A variable product's page's sizes (its form's data-product_variations), or null when the page has none. */
export function wooVariations(html: string): WooVariation[] | null {
  const payload = /data-product_variations="([^"]+)"/i.exec(html)?.[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(decodeEntities(payload));
    return Array.isArray(parsed) ? (parsed as WooVariation[]) : null;
  } catch {
    return null;
  }
}

// --- Wix: the storefront's page, its product cards ---

const WIX_CARD = 'data-hook="product-item-root"';
const WIX_NAME = /data-hook="product-item-name"[^>]*>([\s\S]*?)<\//;
const WIX_LINK = /<a href="(https?:\/\/[^"]+\/product-page\/[^"]+)"/;
const WIX_BEFORE = /data-hook="product-item-price-before-discount"[^>]*data-wix-original-price="\$?([\d,.]+)"/;
const WIX_SALE = /data-hook="product-item-price-to-pay"[^>]*data-wix-price="\$?([\d,.]+)"/;
const WIX_PRICE = /data-hook="(?:formatted-primary-price|product-item-price)"[^>]*data-wix-price="\$?([\d,.]+)"/;
const WIX_IMAGE = /<img[^>]*src="(https:\/\/static\.wixstatic\.com\/media\/[^"]+)"/;
const WIX_OUT = /data-hook="product-item-out-of-stock"|Out of stock/i;

/** A Wix storefront page's product cards, as Products of one offer each. */
export function wixProducts(html: string): Product[] {
  const products: Product[] = [];
  const seen = new Set<string>();
  for (const whole of html.split(WIX_CARD).slice(1)) {
    const card = whole.slice(0, 50_000);
    const name = WIX_NAME.exec(card)?.[1];
    const link = WIX_LINK.exec(card)?.[1];
    if (name === undefined || !link) continue;
    const url = decodeEntities(link);
    if (seen.has(url)) continue;
    const before = WIX_BEFORE.exec(card)?.[1];
    const sale = WIX_SALE.exec(card)?.[1] ?? WIX_PRICE.exec(card)?.[1];
    if (!sale) continue;
    seen.add(url);
    const title = decodeEntities(name.replace(TAG, "")).trim();
    products.push({
      name: title,
      offers: [{ variant: null, url, image: WIX_IMAGE.exec(card)?.[1] ?? null, price: money(sale), was: before ? wasOf(before) : null, available: !WIX_OUT.test(card), weightKg: weightKg(title) }],
    });
  }
  return products;
}
