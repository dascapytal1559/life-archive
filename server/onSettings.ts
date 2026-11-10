// Imported early by each entry point, before anything that reads the clock as it loads (a module's Intl formatter is
// built when the module is), so the whole process runs on the archive's time zone, locale and phone country
// (settings.ts). A settings file that cannot be used stops it here, saying why. onSettings.test.ts holds every entry point to it.

import { setClock } from "../src/time.ts";
import { setPhoneCountry } from "./archive/names.ts";
import { settings, SettingsProblem } from "./settings.ts";

try {
  const { timeZone, locale, phoneCountry } = settings();
  setClock({ timeZone, locale });
  setPhoneCountry(phoneCountry);
} catch (error) {
  if (!(error instanceof SettingsProblem)) throw error;
  console.error(error.message);
  process.exit(1);
}
