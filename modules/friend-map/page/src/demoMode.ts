// The demo: the app's map views (DEMO_VIEWS in views.ts) over a made-up crowd
// (src/demo/), for showing friend-map to someone without showing them anyone
// real. It is its own app beside the real one: its own header and view
// switcher, and no way into the real map from inside it. It lives in one place:
// the static demo (npm run build:demo), plain files at the root of a site of
// their own with no server behind them at all, published as the public demo
// (PUBLIC_DEMO in views.ts), which the real app's switcher links to. The app
// holds no demo of its own (an old /demo address leads to the public one,
// server/oldDemo.ts).
//
// Which app a page is comes from how it was built: the static demo's build
// (vite.demo.config.ts) says so, and its entry (src/demo/main.tsx) gives it the
// made-up crowd held in the page. The demo is read-only and asks for nothing:
// no archive, no media, no live updates, no settings, no model and no usage
// record. The one thing of yours it has is your saved view settings
// (savedSettings.ts, the Spider web's as numbers and choices) as they were
// when it was built, which its own start at (savedStore.ts).

/**
 * Where the old Demo switch kept demo mode on, per browser, before the demo
 * moved to an address of its own. It means nothing now and is cleared (forgetOldDemoMode), so
 * a browser that left it on opens the real app as the real app.
 */
export const OLD_DEMO_MODE_KEY = "friend-map.demo";

type Storage = Pick<globalThis.Storage, "removeItem">;

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** Whether this page is the demo's: built as the static demo (vite.demo.config.ts), the demo alone at the root of its own site. */
export const demoMode: boolean = import.meta.env?.MODE === "static-demo";

/** Clears the old Demo switch's choice, if it was ever made in this browser. */
export function forgetOldDemoMode(storage: () => Storage | undefined = browserStorage): void {
  try {
    storage()?.removeItem(OLD_DEMO_MODE_KEY);
  } catch {
    // Nothing kept, so nothing to forget.
  }
}

/**
 * Where a choice you make in the page is kept: apart in the demo, for
 * the ones that hold your own words (the Query bar's query and the
 * words it came from, Hide's tags), so the demo never shows them and leaves
 * them as they were.
 */
export function keptAs(key: string, demo: boolean = demoMode): string {
  return demo ? `${key}@demo` : key;
}
