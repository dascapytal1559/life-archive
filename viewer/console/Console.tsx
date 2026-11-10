// The console (/life-archive/dev): the life archive's front end, a frame every view hangs on (P3,
// "Console", of the October 2026 worlds round): a rail at the left, and the surface, the whole height of the screen
// beside it with nothing above it, drawn with the console's blocks (blocks.tsx). The rail holds the aspects, its pages,
// one level and nothing under them, and at its foot Jump to and the settings gear (Settings.tsx: the look); a page with several views has its own
// tabs at the top of its surface, one a view. A
// phone is laid out from the bottom up: a bar along the foot with the life archive's mark at the left (home) and, at
// the right, the current page's name, which opens the rail as a list of every page rising over the surface; above the
// bar the page's tabs in one row that scrolls sideways; and the surface above them. Premium white by day,
// true black at night (theme.ts, console.css). The views are the registry's (registry.ts): adding one is one entry
// there. The place shown is the address (address.ts), so a reload, the back button or a link opens the same view; the
// console's own address, and any it does not know, open its home: Events' Calendar, wherever the rail's order puts it (registry.ts's HOME). Keyboard: ↑↓ move along the rail, ←→ along a page's tabs, Enter opens, and ⌘K (Ctrl+K) opens Jump to
// (Jump.tsx), a list of every place and every table the archive keeps, narrowed by typing. On a desk the aspects can be dragged into an order of the
// captain's own (reorder.ts), or moved with Option+↑↓; the order is
// kept on this device (order.ts) and the phone's list and Jump to follow it. On a phone the order is only shown.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon } from "./icons.tsx";
import { Jump, jumpEntries, type JumpEntry } from "./Jump.tsx";
import { ORDER_KEY, orderAspects, orderToStore, storedKeys } from "./order.ts";
import { openAddress, stepsOf } from "./address.ts";
import { kindsOnce } from "../api.ts";
import { pageSettings } from "../pageSettings.ts";
import type { KindSpec } from "../wire.ts";
import { editsAddress, tableAddress, TABLES_AT } from "./EventsSection.tsx";
import { aspectsOn, homeOf, pathOf, placeOf, titleOf, viewsOf, viewsOn, type Aspect, type View } from "./registry.ts";
import { useReorder } from "./reorder.ts";
import { ViewBoundary } from "./ViewFailed.tsx";
import { Settings } from "./Settings.tsx";
import { LookContext, readThemeChoice, resolveTheme, THEME_COLOR, THEME_KEY, type Theme, type ThemeChoice } from "./theme.ts";
import "./console.css";
import "./phone.css";

/** A click that should open in place: a plain left click, no modifier (those open a new tab, as a link does). */
const plain = (event: MouseEvent) => !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);

/** The aspects and views this archive has, as the server told the page before this loaded (viewer/main.tsx). */
const ASPECTS = aspectsOn(pageSettings());
const VIEWS = viewsOn(pageSettings());

export function Console() {
  const [pathname, setPathname] = useState(() => location.pathname);
  // The rail's order: the captain's, kept on this device (and followed when another tab of it changes it).
  const [aspects, setAspects] = useState(() => orderAspects(storedKeys(stored(ORDER_KEY)), ASPECTS));
  useEffect(() => {
    const follow = (event: StorageEvent) => event.key === ORDER_KEY && setAspects(orderAspects(storedKeys(event.newValue), ASPECTS));
    addEventListener("storage", follow);
    return () => removeEventListener("storage", follow);
  }, []);
  const named = useMemo(() => placeOf(pathname, ASPECTS, VIEWS), [pathname]);
  const place = named ?? homeOf(aspects, VIEWS);
  const scroll = useRef<HTMLElement>(null);

  // An address the console does not know (its own, an old Overview or Architecture one) is written again as its home's;
  // one naming an aspect by a key it had before a rename (…/exercise, Fitness's), a view by a section it had before, or an
  // aspect's first view by its section (…/fitness/activities) as the place's own (…/fitness), so a view keeping its
  // state in the address (a day, a week) finds the address it writes.
  useEffect(() => {
    const [aspectKey, section] = stepsOf(pathname);
    const path =
      named && (section || aspectKey !== named.aspect.key) ? pathOf(named, VIEWS) : named ? pathname : pathOf({ aspect: place.aspect, view: viewsOf(place.aspect.key, VIEWS)[0] }, VIEWS);
    if (path === pathname) return;
    history.replaceState(history.state, "", path + location.search + location.hash);
    setPathname(path);
  }, [pathname, named, place]);

  useEffect(() => {
    const back = () => setPathname(location.pathname);
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);

  // The phone's list of pages: the rail rising from the bar's page button, closed by any place opened, by Esc (the
  // focus back on the button) or by a tap beside it. Opened from the keyboard, the focus moves to the current page;
  // opened by a tap, it stays where it was, so no focus ring shows.
  const [menu, setMenu] = useState<false | "tap" | "keys">(false);
  const pageButton = useRef<HTMLButtonElement>(null);
  /** Opens a place in the console, its own address with nothing after it: a new address, the surface back at its top. */
  const go = useCallback((path: string) => {
    openAddress(path);
    scroll.current?.scrollTo(0, 0);
    setMenu(false);
  }, []);
  useEffect(() => {
    scroll.current?.scrollTo(0, 0);
    setMenu(false);
  }, [pathname]);
  useEffect(() => {
    if (!menu) return;
    if (menu === "keys") document.querySelector<HTMLElement>("#console-rail .is-current")?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenu(false);
      pageButton.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [menu]);

  /** A link's click, opening it in place. */
  const open = (path: string) => (event: MouseEvent) => {
    if (!plain(event)) return;
    event.preventDefault();
    go(path);
  };

  // The look: the device's, or the one chosen in the settings menu, or the one the address forces.
  const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice(stored(), location.search));
  const prefersDark = useMedia("(prefers-color-scheme: dark)");
  const theme = resolveTheme(choice, prefersDark);
  const choose = (next: ThemeChoice) => {
    setChoice(next);
    keep(THEME_KEY, next === "auto" ? null : next);
  };
  useThemeColor(theme);

  useEffect(() => {
    document.title = titleOf(place, VIEWS);
  }, [place]);

  // Jump to: ⌘K or Ctrl+K anywhere in the console (not inside the embedded page, which has its own keys).
  const [jumping, setJumping] = useState(false);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setJumping((was) => !was);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  const arrange = (keys: readonly string[]) => {
    const next = orderAspects(keys, ASPECTS);
    setAspects(next);
    keep(ORDER_KEY, orderToStore(next, ASPECTS));
  };
  // The phone's layout is console.css's under 900 px; the same query here, so the two never disagree.
  const phone = useMedia("(max-width: 899px)");
  const desk = !phone;
  const [said, setSaid] = useState("");
  const keys = useMemo(() => aspects.map((aspect) => aspect.key), [aspects]);
  const reorder = useReorder({
    keys,
    label: (key) => aspects.find((aspect) => aspect.key === key)?.label ?? key,
    commit: arrange,
    announce: setSaid,
    enabled: desk,
  });

  // The tables the archive keeps, for Jump to: asked once for the whole page (the Events page's Tables and Calendar
  // ask the same), and none when the server has none to give.
  const [tables, setTables] = useState<readonly KindSpec[]>([]);
  useEffect(() => {
    kindsOnce().then(setTables, () => undefined);
  }, []);
  const entries = useMemo<JumpEntry[]>(
    () =>
      jumpEntries(
        aspects.map((aspect) => ({
          label: aspect.label,
          path: pathOf({ aspect, view: viewsOf(aspect.key, VIEWS)[0] }, VIEWS),
          views: viewsOf(aspect.key, VIEWS).map((view) => ({ label: view.label, path: pathOf({ aspect, view }, VIEWS) })),
        })),
        [...(tables.some((spec) => spec.edits?.length) ? [{ label: "Edits", path: editsAddress() }] : []), ...tables.map((spec) => ({ label: spec.label, path: tableAddress(spec) }))],
        TABLES_AT,
      ),
    [aspects, tables],
  );

  const homePath = pathOf(homeOf(aspects, VIEWS), VIEWS);
  const current = (aspect: Aspect) => place.aspect.key === aspect.key;
  const aspectLink = (aspect: Aspect, className: string, children: ReactNode, moves = false) => {
    const path = pathOf({ aspect, view: viewsOf(aspect.key, VIEWS)[0] }, VIEWS);
    return (
      <a
        key={aspect.key}
        className={`${className}${current(aspect) ? " is-current" : ""}`}
        href={path}
        aria-current={current(aspect) ? "page" : undefined}
        title={aspect.blurb}
        onClick={open(path)}
        data-nav
        {...(moves && desk ? { ...reorder.handle(aspect.key), "aria-describedby": "console-reorder-hint", "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown" } : {})}
      >
        {children}
      </a>
    );
  };
  return (
    <div className={`console console--${theme}${menu ? " console--menu" : ""}`} data-theme={theme}>
      <nav ref={reorder.rail} className="console__rail" id="console-rail" aria-label="Aspects" onKeyDown={arrows("vertical")}>
        <div className="console__brand">
          <i className="console__mark" aria-hidden="true" />
          <span>Life archive</span>
        </div>
        {aspects.map((aspect) => (
          <div key={aspect.key} className="console__aspect" data-aspect={aspect.key}>
            {aspectLink(aspect, "console__item", (
              <>
                <Icon name={aspect.icon} />
                <span className="console__item-name">{aspect.label}</span>
                {desk && <Icon name="grip" className="console__grip" />}
              </>
            ), true)}
          </div>
        ))}
        <div ref={reorder.slot} className="console__slot" aria-hidden="true" />
        {desk && (
          <>
            <span id="console-reorder-hint" hidden>Drag, or Option (Alt) with the up or down arrow, to move it.</span>
            <span className="console__said" role="status" aria-live="polite">{said}</span>
          </>
        )}
        <div className="console__rail-foot">
          <button type="button" className="console__jump" onClick={() => (setMenu(false), setJumping(true))} aria-keyshortcuts="Meta+K Control+K" data-nav>
            <Icon name="search" />
            <span>Jump to</span>
            <kbd>⌘K</kbd>
          </button>
          <Settings choice={choice} onChoose={choose} />
        </div>
      </nav>
      {menu && <div className="console__scrim" aria-hidden="true" onClick={() => setMenu(false)} />}

      <main ref={scroll} className={`console__scroll${place.view.fill ? " console__scroll--fill" : ""}`}>
        <LookContext value={theme}>
          {desk && <Tabs aspect={place.aspect} view={place.view} open={open} />}
          <div className={`console__content${place.view.fill ? " console__content--fill" : ""}`}>
            <div className={`console__view${place.view.fill ? " console__view--fill" : ""}`}>
              <ViewBoundary at={`${place.aspect.key}/${place.view.key}`} what={place.view.label}>
                <Drawn view={place.view} aspect={place.aspect} />
              </ViewBoundary>
            </div>
          </div>
        </LookContext>
      </main>

      {phone && (
        <>
          <Tabs aspect={place.aspect} view={place.view} open={open} />
          <div className="console__bar">
            <a className="console__bar-brand" href={homePath} aria-label="Life archive, home" onClick={open(homePath)}>
              <i className="console__mark" aria-hidden="true" />
              <span>Life archive</span>
            </a>
            <button
              ref={pageButton}
              type="button"
              className="console__page"
              aria-expanded={menu !== false}
              aria-controls="console-rail"
              aria-label={`Page: ${place.aspect.label}. Every page`}
              // A click from Enter or Space has no pointer's count (detail 0).
              onClick={(event) => setMenu((was) => (was ? false : event.detail === 0 ? "keys" : "tap"))}
            >
              <Icon name={place.aspect.icon} />
              <span>{place.aspect.label}</span>
              <Icon name="chevron" className="console__page-chevron" />
            </button>
          </div>
        </>
      )}

      {jumping && <Jump entries={entries} onGo={(path) => (setJumping(false), go(path))} onClose={() => setJumping(false)} />}
    </div>
  );
}

/** Draws a view, inside its ViewBoundary, so a view that throws as it is drawn fails its own place alone. */
function Drawn({ view, aspect }: { view: View; aspect: Aspect }) {
  return view.component({ aspect });
}

/** A page's own tabs, one a view, in a strip of their own across the top of its surface, above the content's padding,
 * so every page and every tab has the same bar (on a phone, in a row of their own above the bottom bar, fixed while
 * the surface scrolls); none for a page of one view. The current one is scrolled into sight, for a phone's strip too
 * narrow for them all. */
function Tabs({ aspect, view, open }: { aspect: Aspect; view: View; open: (path: string) => (event: MouseEvent) => void }) {
  const strip = useRef<HTMLElement>(null);
  useEffect(() => {
    const tab = strip.current?.querySelector<HTMLElement>(".is-current");
    if (tab && strip.current) strip.current.scrollLeft = tab.offsetLeft - (strip.current.clientWidth - tab.offsetWidth) / 2;
  }, [view]);
  const under = viewsOf(aspect.key, VIEWS);
  const links = aspect.links?.() ?? [];
  if (under.length + links.length < 2) return null;
  return (
    <nav ref={strip} className="console__tabs" aria-label={`${aspect.label}'s views`} onKeyDown={arrows("horizontal")}>
      {under.map((v) => {
        const path = pathOf({ aspect, view: v }, VIEWS);
        return (
          <a key={v.key} className={`console__tab${v === view ? " is-current" : ""}`} href={path} aria-current={v === view ? "page" : undefined} title={v.blurb} onClick={open(path)} data-nav>
            {v.label}
          </a>
        );
      })}
      {links.map((link) => (
        <a key={link.label} className="console__tab console__tab--out" href={link.href()} target="_blank" rel="noopener" title={link.blurb} data-nav>
          {link.label}
          <Icon name="out" />
          <span className="console__sr"> (opens in a new tab)</span>
        </a>
      ))}
    </nav>
  );
}

/** ↑↓ (or ←→) move the focus along the container's `data-nav` items, wrapping, Home and End to the ends. */
function arrows(orientation: "vertical" | "horizontal") {
  const [next, prev] = orientation === "vertical" ? (["ArrowDown", "ArrowUp"] as const) : (["ArrowRight", "ArrowLeft"] as const);
  return (event: KeyboardEvent<HTMLElement>) => {
    // Option with an arrow is an aspect's move (reorder.ts), never a step.
    if (event.defaultPrevented || event.altKey || ![next, prev, "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-nav]")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (items.length === 0 || at === -1) return;
    event.preventDefault();
    const to = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === next ? 1 : -1) + items.length) % items.length;
    items[to].focus();
  };
}

/** The browser's own colour around the page (the iPhone's bars) follows the look, and goes back to the viewer's as the console closes. */
function useThemeColor(theme: Theme) {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const scheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    const was = { color: meta?.content, scheme: scheme?.content };
    if (meta) meta.content = THEME_COLOR[theme];
    if (scheme) scheme.content = theme;
    return () => {
      if (meta && was.color) meta.content = was.color;
      if (scheme && was.scheme) scheme.content = was.scheme;
    };
  }, [theme]);
}

/** Whether the window matches `query`, following it as it changes. */
function useMedia(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const follow = () => setMatches(media.matches);
    follow();
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [query]);
  return matches;
}

function stored(key = THEME_KEY): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Keeps `value` under `key` on this device, or forgets it (null). */
function keep(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not kept; the page still changes.
  }
}
