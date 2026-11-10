// The page's start: it asks what it needs to know of its archive (server/viewer/pageSettings.ts), loads the page half
// of each module the server says is on (modules.ts), and only then loads the console, whose modules build their date
// and number formats as they load, from the clock set here, and whose registry reads the modules loaded here. The server may be
// restarting as the page opens, so it asks until it is answered.

import { setClock } from "../src/time.ts";
import { loadModuleViewers } from "./modules.ts";
import { setPageSettings } from "./pageSettings.ts";
import { SETTINGS_API, type PageSettings } from "./wire.ts";

const root = document.getElementById("root")!;

async function ask(): Promise<PageSettings> {
  for (;;) {
    try {
      const res = await fetch(SETTINGS_API);
      if (res.ok) return (await res.json()) as PageSettings;
    } catch {
      // The server is away; asked again below.
    }
    root.textContent = "Waiting for the archive's server…";
    await new Promise((resume) => setTimeout(resume, 1000));
  }
}

const settings = await ask();
root.textContent = "";
setClock(settings);
setPageSettings(settings);
document.documentElement.lang = settings.locale;
await loadModuleViewers(settings.modules);
await import("./app.tsx");
