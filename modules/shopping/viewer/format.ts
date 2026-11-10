// The Shopping page's arithmetic (ShoppingSection.tsx draws it): a pull's specials gathered into products (a product's
// sizes on one card), narrowed by supplier and words, and sorted; and the words it writes.

import { addDays, dayKey, timeOfDay, LOCALE } from "../../../sdk/wire.ts";
import type { Special } from "../wire.ts";

/** A product on special: one card, its sizes on special within it. */
export interface ProductCard {
  key: string;
  supplier: string;
  name: string;
  image: string | null;
  /** Its specials, one a size, the best first. */
  sizes: Special[];
  /** The size the card leads with: the most off, else the cheapest. */
  best: Special;
}

/** How the cards are ordered. */
export const SORTS = [
  { key: "discount", label: "Most off" },
  { key: "unit", label: "$/kg" },
  { key: "price", label: "Price" },
  { key: "name", label: "Name" },
] as const;

export type SortKey = (typeof SORTS)[number]["key"];

/** Which of two specials leads: the larger discount, then the lower price. */
const better = (a: Special, b: Special) => (b.discount ?? -1) - (a.discount ?? -1) || a.price - b.price;

/** A pull's specials as products: those of one supplier with one name are one product, in the pull's order. */
export function productsOf(specials: readonly Special[]): ProductCard[] {
  const cards = new Map<string, Special[]>();
  for (const special of specials) {
    const key = `${special.supplier}\n${special.name}`;
    cards.set(key, [...(cards.get(key) ?? []), special]);
  }
  return [...cards].map(([key, sizes]) => {
    const sorted = [...sizes].sort(better);
    return { key, supplier: sorted[0].supplier, name: sorted[0].name, image: sorted.find((s) => s.image)?.image ?? null, sizes: sorted, best: sorted[0] };
  });
}

/** Last, whatever the order, for a card without the value sorted on. */
const lastIfNull = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b);

/** A value whose largest sorts first, null kept null. */
const negated = (value: number | null) => (value === null ? null : -value);

/** `cards` in the order `sort` names: the most off first; the cheapest a kilogram or outright first; or by name. */
export function sortProducts(cards: readonly ProductCard[], sort: SortKey): ProductCard[] {
  const byName = (a: ProductCard, b: ProductCard) => a.name.localeCompare(b.name, LOCALE);
  const order: Record<SortKey, (a: ProductCard, b: ProductCard) => number> = {
    discount: (a, b) => lastIfNull(negated(a.best.discount), negated(b.best.discount)) || lastIfNull(a.best.unitPrice, b.best.unitPrice) || byName(a, b),
    unit: (a, b) => lastIfNull(a.best.unitPrice, b.best.unitPrice) || byName(a, b),
    price: (a, b) => a.best.price - b.best.price || byName(a, b),
    name: byName,
  };
  return [...cards].sort(order[sort]);
}

/** The cards from the suppliers in `suppliers` (every one when empty) whose name has every word of `words`. */
export function filterProducts(cards: readonly ProductCard[], suppliers: ReadonlySet<string>, words: string): ProductCard[] {
  const wanted = words.toLowerCase().split(/\s+/).filter(Boolean);
  return cards.filter((card) => {
    if (suppliers.size > 0 && !suppliers.has(card.supplier)) return false;
    const text = `${card.name} ${card.sizes.map((s) => s.variant ?? "").join(" ")}`.toLowerCase();
    return wanted.every((word) => text.includes(word));
  });
}

/** Dollars: "$12.50". */
export const dollars = (amount: number) => `$${amount.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Dollars a kilogram, to the dollar: "$27/kg". */
export const perKg = (amount: number) => `$${Math.round(amount).toLocaleString(LOCALE)}/kg`;

/** A local day as the page says it, from `now`: "today", "yesterday", "tomorrow", or the date. */
function dayWord(at: number, now: number): string {
  const day = dayKey(at);
  const today = dayKey(now);
  return day === today ? "today" : day === addDays(today, -1) ? "yesterday" : day === addDays(today, 1) ? "tomorrow" : day;
}

/** When a pull ran or will, in the archive's clock: "today 08:00", "tomorrow 08:00", or its date and time. */
export function whenText(iso: string, now: number): string {
  const at = Date.parse(iso);
  return `${dayWord(at, now)} ${timeOfDay(at)}`;
}
