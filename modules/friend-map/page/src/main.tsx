import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { provideApp } from "./appApi.ts";
import { httpApp } from "./appHttp.ts";
import { archiveApi, provideArchive } from "./archiveApi.ts";
import { httpArchive } from "./archiveHttp.ts";
import { BackendRefused } from "./BackendRefused.tsx";
import { NoBackend } from "./NoBackend.tsx";
import { shakeHands, takesEdits } from "./contract/handshake.ts";
import { forgetOldDemoMode } from "./demoMode.ts";
import { address, appPath } from "./mount.ts";
import { ReadOnly } from "./readOnly.ts";
import { startSaving } from "./savedStore.ts";
import { movedToEvents } from "./demos/movedToEvents.ts";
import { movedAddress } from "./views.ts";

// The app's page, on the server's archive (src/demo/main.tsx is the static
// demo's entry, the only demo; the app holds none, demoMode.ts).

// The map views (the Spider web at /, which leads to /spider, Orbits at
// /orbits, and the rest; see views.ts).
// Addresses from before the views moved (/demos/..., /web, now /spider, and
// the canvas, since retired) are rewritten to where they are now.
const { pathname, search, hash } = window.location;
const moved = movedAddress({ pathname: appPath(pathname), search, hash });
if (moved) window.history.replaceState(null, "", address(moved));
// The Table folded into the life archive's Events page's Tables, and the Calendar into its Calendar: an old address
// naming one (/demos/table, as the line above has it, now /table) opens its new place, in the whole window (the
// console's frame too, whose top is the same server's), and draws nothing here.
const left = movedToEvents({ pathname: appPath(window.location.pathname), search: window.location.search });
if (left) {
  (window.top ?? window).location.replace(left);
  await new Promise(() => undefined);
}
// Held in an object, not a capitalized name of its own, which React Refresh would take for a component: that would
// make this entry take hot updates itself, running createRoot again on every edit beneath it, not reloading the page.
const views = { Demos: lazy(() => import("./demos/Demos.tsx").then((m) => ({ default: m.Demos }))) };

provideArchive(httpArchive);
provideApp(httpApp);
// The backend's handshake, before anything is drawn or counted: what it serves, and its time zone (src/contract/).
const shaken = await shakeHands(archiveApi);
// The old Demo switch's choice (demo mode kept per browser) is gone: the demo is the public one.
forgetOldDemoMode();
// The Spider web's settings are kept on the server (the static demo keeps its visitor's in the browser).
startSaving();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {shaken !== null ? (
      "refused" in shaken ? <BackendRefused why={shaken.refused} /> : <NoBackend why={shaken.down} />
    ) : (
      <ReadOnly.Provider value={!takesEdits()}>
        <Suspense>
          <views.Demos />
        </Suspense>
      </ReadOnly.Provider>
    )}
  </StrictMode>,
);
