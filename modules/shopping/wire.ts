// What the Shopping page and the module's server half say to each other (GET and POST /life-archive/api/shopping,
// server/http.ts), and the shape of a pull as the archive keeps it (shopping/pulls/ in the archive's folder, one file
// a pull).
//
// A pull asks every supplier (server/suppliers.ts) for what it has on special, each through its own storefront's
// public feed (server/fetch.ts), and keeps every in-stock product that is: marked down (a compare-at, or regular, price
// above the price) or, for a supplier whose page is a specials list of its own, listed there. Each special says where
// it came from, what it costs and cost, and per kilogram when its weight is known.

import { API_BASE } from "../../sdk/wire.ts";

/**
 * The Shopping page's route: under the viewer's /life-archive/, so it is on the tailnet with the rest of the viewer. It
 * is the address the page had while Shopping was a part of the core, kept as the module's mount (module.ts); the
 * module's own address, /life-archive/api/m/shopping, answers the same.
 */
export const SHOPPING_API = `${API_BASE}/shopping`;

/** The shape of a pull this archive writes and reads; a pull of another format is not shown. */
export const SHOPPING_FORMAT = 1;

/** How a supplier's storefront is read. */
export const SHOPPING_ADAPTERS = ["shopify", "shopify-storefront", "woocommerce", "wix"] as const;
export type ShoppingAdapter = (typeof SHOPPING_ADAPTERS)[number];

/** One supplier in one pull: how the pull went, and how many of its products were looked at and kept. */
export interface SupplierPull {
  /** Its key in suppliers.ts, and on each of its specials. */
  id: string;
  name: string;
  /** The page a person would open for its specials. */
  url: string;
  adapter: ShoppingAdapter;
  /** Whether the pull reached it and read what it sent. */
  status: "ok" | "failed";
  /** Read and found at least one special: what the steak watcher called working. */
  working: boolean;
  /** Why not, when it is not working: the error, or that it lists nothing on special today. */
  note: string | null;
  /** How it was read when not the adapter's usual way (Shopify's collection page, when its feed is down). */
  via: string | null;
  /** Products looked at, and specials kept. */
  scanned: number;
  specials: number;
  /** How long it took, in ms. */
  ms: number;
}

/** One thing on special: a product, or one of its sizes when the sizes are priced apart. */
export interface Special {
  /** The supplier's id (SupplierPull's). */
  supplier: string;
  name: string;
  /** The size or option, when the product has more than one ("1kg", "2 x 300g"). */
  variant: string | null;
  url: string;
  image: string | null;
  /** In dollars. */
  price: number;
  /** The price it was before, when the supplier says (a compare-at or regular price); null for one only listed as a special. */
  was: number | null;
  /** How much off, as a whole percentage of `was`; null without one. */
  discount: number | null;
  /** Marked down from `was`, or only listed on the supplier's specials page. */
  basis: "markdown" | "listed";
  /** Its weight in kilograms, when the name, size or the supplier's shipping weight gives one. */
  weightKg: number | null;
  /** Dollars a kilogram, now and before, when the weight is known. */
  unitPrice: number | null;
  wasUnitPrice: number | null;
}

/** One pull: when it ran, each supplier's part, and every special found. */
export interface ShoppingPull {
  format: typeof SHOPPING_FORMAT;
  /** ISO instants. */
  startedAt: string;
  finishedAt: string;
  /** What started it: the morning's schedule, the server starting with no pull today, or the page's Refresh. */
  trigger: "daily" | "catch-up" | "refresh";
  suppliers: SupplierPull[];
  specials: Special[];
}

/** GET /life-archive/api/shopping, and what POST answers once its pull is done. */
export interface ShoppingAnswer {
  /** The latest pull, or null before the first. */
  pull: ShoppingPull | null;
  /** Whether a pull is running now. */
  pulling: boolean;
  /** When the next morning's pull is due, an ISO instant. */
  nextPullAt: string;
  /** How many suppliers the archive names (shopping/suppliers.json); with none there are no pulls, and the page says where they go. */
  suppliers: number;
}
