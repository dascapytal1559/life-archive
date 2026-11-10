// Shopping in the console: the pilot, "On special", every supplier's specials today in one layout, so no supplier's
// own site needs visiting. Above, the pull in KPIs (how many specials, from how many suppliers, the most off, when it
// was pulled and when the next is due) and Refresh, which pulls now; then each supplier, whether it is working, when
// it was pulled and why not when it is not, each a filter; then the specials, a card a product (its sizes on special
// within it), narrowed by words and suppliers, sorted by the most off (or $/kg, price, name), and grouped by supplier
// or not. Everything is the latest pull's (GET /life-archive/api/shopping, wire.ts); the server pulls each morning at
// 08:00 local time (server/pull.ts). An archive that names no suppliers is told where they go.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Kpi, Kpis, LOCALE, type View } from "../../../sdk/viewer.ts";
import { SHOPPING_API, type ShoppingAnswer, type SupplierPull } from "../wire.ts";
import { dollars, filterProducts, perKg, productsOf, whenText, SORTS, sortProducts, type ProductCard, type SortKey } from "./format.ts";
import "./shopping.css";

/** The Shopping aspect's key in the registry. */
export const SHOPPING_ASPECT = "shopping";

/** The Shopping views: the pilot, what is on special today. */
export function shoppingViews(): View[] {
  return [
    {
      key: "shopping-specials",
      label: "On special",
      aspects: [SHOPPING_ASPECT],
      section: "specials",
      blurb: "Every supplier's specials today, in one layout: the most off first.",
      component: () => <ShoppingSpecials />,
    },
  ];
}

/** How often to look again while a pull is running elsewhere (the morning's, or another tab's Refresh). */
const WHILE_PULLING_MS = 4_000;

/** The latest pull, asked for on opening and on coming back into view (and every few seconds while one runs); Refresh pulls now. */
function useShopping() {
  const [answer, setAnswer] = useState<ShoppingAnswer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const ask = useCallback((init?: RequestInit) => {
    return fetch(SHOPPING_API, { cache: "no-store", ...init })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as ShoppingAnswer & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        setAnswer(body);
        setProblem(null);
      })
      .catch((error: Error) => setProblem(error.message));
  }, []);

  useEffect(() => {
    void ask();
    const back = () => document.hidden || void ask();
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [ask]);

  useEffect(() => {
    if (!answer?.pulling || refreshing) return;
    const again = setTimeout(() => void ask(), WHILE_PULLING_MS);
    return () => clearTimeout(again);
  }, [answer, refreshing, ask]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void ask({ method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).finally(() => setRefreshing(false));
  }, [ask]);

  return { answer, problem, refreshing: refreshing || answer?.pulling === true, refresh };
}

function ShoppingSpecials() {
  const { answer, problem, refreshing, refresh } = useShopping();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [words, setWords] = useState("");
  const [sort, setSort] = useState<SortKey>("discount");
  const [grouped, setGrouped] = useState(false);
  const pull = answer?.pull ?? null;
  const now = Date.now();

  const products = useMemo(() => productsOf(pull?.specials ?? []), [pull]);
  const shown = useMemo(() => sortProducts(filterProducts(products, picked, words), sort), [products, picked, words, sort]);
  const names = useMemo(() => new Map(pull?.suppliers.map((s) => [s.id, s.name]) ?? []), [pull]);

  const toggle = (id: string) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!answer) return <p className="shop__message">{problem ? `The specials are not available: ${problem}` : "Asking for the specials…"}</p>;
  // A server older than the page tells no count; it had suppliers, or it showed no Shopping page.
  if (answer.suppliers === 0 && !pull) {
    return (
      <p className="shop__message">
        This archive names no suppliers yet, so nothing is pulled. List them in <code>shopping/suppliers.json</code> in the archive's folder (the Shopping module's README says how), then start the archive's server again.
      </p>
    );
  }

  const working = pull?.suppliers.filter((s) => s.working) ?? [];
  const top = sortProducts(products, "discount")[0];

  return (
    <div className="shop">
      <Kpis label="Today's specials">
        <Kpi label="On special" value={pull ? products.length.toLocaleString(LOCALE) : "–"} note={pull ? `${pull.specials.length} with their sizes` : "no pull yet"} tone="accent" />
        <Kpi label="Suppliers working" value={pull ? `${working.length} / ${pull.suppliers.length}` : "–"} note={pull && working.length < pull.suppliers.length ? "see below for why" : "every one"} tone={pull && working.length < pull.suppliers.length ? "mild" : "text"} />
        <Kpi label="Most off" value={top?.best.discount != null ? `${top.best.discount}%` : "–"} note={top ? `${top.name}, ${names.get(top.supplier) ?? top.supplier}` : undefined} />
        <Kpi
          label="Pulled"
          value={pull ? whenText(pull.finishedAt, now) : "never"}
          note={
            <>
              next {whenText(answer.nextPullAt, now)}
              {" · "}
              <button type="button" className="shop__refresh" onClick={refresh} disabled={refreshing}>
                {refreshing ? "Pulling…" : "Refresh now"}
              </button>
            </>
          }
        />
      </Kpis>
      {problem && <p className="shop__message shop__message--problem">Could not reach the archive's server: {problem}. Showing the last answer.</p>}

      {pull && <Suppliers suppliers={pull.suppliers} picked={picked} toggle={toggle} clear={() => setPicked(new Set())} now={now} />}

      {pull && (
        <section className="shop__specials" aria-label="Specials">
          <div className="shop__bar">
            <input className="shop__search" type="search" name="find" placeholder="Find (steak, lamb, 1kg…)" value={words} onChange={(e) => setWords(e.target.value)} aria-label="Find in the specials" />
            <div className="shop__segmented" role="radiogroup" aria-label="Sort by">
              {SORTS.map((s) => (
                <button key={s.key} type="button" role="radio" aria-checked={sort === s.key} onClick={() => setSort(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
            <label className="shop__toggle">
              <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> By supplier
            </label>
            <span className="shop__count">{shown.length === products.length ? `${shown.length} products` : `${shown.length} of ${products.length} products`}</span>
          </div>
          {shown.length === 0 && <p className="shop__message">Nothing on special matches.</p>}
          {grouped
            ? pull.suppliers
                .filter((s) => shown.some((card) => card.supplier === s.id))
                .map((s) => (
                  <div key={s.id} className="shop__group">
                    <h3 className="shop__group-head">
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.name}
                      </a>
                      <span>{shown.filter((card) => card.supplier === s.id).length}</span>
                    </h3>
                    <Cards cards={shown.filter((card) => card.supplier === s.id)} names={names} />
                  </div>
                ))
            : <Cards cards={shown} names={names} />}
        </section>
      )}
    </div>
  );
}

/** Each supplier's part of the pull, each a filter of the specials. */
function Suppliers({ suppliers, picked, toggle, clear, now }: { suppliers: readonly SupplierPull[]; picked: ReadonlySet<string>; toggle: (id: string) => void; clear: () => void; now: number }) {
  return (
    <section className="card card--flush shop__suppliers" aria-label="Suppliers">
      <div className="card__head">
        <h3>Suppliers</h3>
        <span className="card__aside">
          {picked.size > 0 ? (
            <button type="button" className="shop__clear" onClick={clear}>
              Show every supplier
            </button>
          ) : (
            <span className="shop__hint">choose one or more to narrow the specials</span>
          )}
        </span>
      </div>
      <ul className="shop__supplier-list">
        {suppliers.map((s) => (
          <li key={s.id} className={`shop__supplier${picked.has(s.id) ? " shop__supplier--picked" : ""}${s.working ? "" : " shop__supplier--down"}`}>
            <button type="button" aria-pressed={picked.has(s.id)} onClick={() => toggle(s.id)} title={s.via ? `Read from ${s.via}` : undefined}>
              <span className={`shop__dot shop__dot--${s.working ? "up" : "down"}`} aria-label={s.working ? "working" : "not working"} />
              <span className="shop__supplier-name">{s.name}</span>
              <span className="shop__supplier-count">{s.specials}</span>
            </button>
            <span className="shop__supplier-meta">
              {s.working ? `${s.scanned} looked at · ${(s.ms / 1000).toFixed(1)} s` : s.note}
              {" · "}
              <a href={s.url} target="_blank" rel="noreferrer">
                site
              </a>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Cards({ cards, names }: { cards: readonly ProductCard[]; names: ReadonlyMap<string, string> }) {
  return (
    <ul className="shop__cards">
      {cards.map((card) => (
        <li key={card.key} className="shop__card">
          <a className="shop__card-link" href={card.best.url} target="_blank" rel="noreferrer">
            <span className="shop__image">{card.image && <img src={card.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}</span>
            {card.best.discount !== null && <span className="shop__badge">−{card.best.discount}%</span>}
            <span className="shop__supplier-tag">{names.get(card.supplier) ?? card.supplier}</span>
            <span className="shop__name">{card.name}</span>
          </a>
          <ul className="shop__sizes">
            {card.sizes.map((size, i) => (
              <li key={`${size.url}-${i}`}>
                {size.variant && (
                  <a className="shop__variant" href={size.url} target="_blank" rel="noreferrer">
                    {size.variant}
                  </a>
                )}
                <span className="shop__price">{dollars(size.price)}</span>
                {size.was !== null && <s className="shop__was">{dollars(size.was)}</s>}
                {size.basis === "listed" && <span className="shop__listed" title="On the supplier's specials list, with no earlier price given">listed special</span>}
                {size.unitPrice !== null && <span className="shop__unit">{perKg(size.unitPrice)}</span>}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
