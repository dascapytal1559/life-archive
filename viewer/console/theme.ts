// The console's two looks (console.css): premium white by day and true black at night. The console follows the
// device's setting (Automatic) unless the captain chose Light or Dark in the rail's settings menu (Settings.tsx; kept
// on this device alone, THEME_KEY in localStorage), and
// a board or a link may force one for a page with ?theme=light|dark, which wins while that page is open. A view that
// draws its own colours (the Fitness page's route map) reads the look from LookContext.

import { createContext } from "react";
import type { IconName } from "./icons.tsx";

export type ThemeChoice = "auto" | "light" | "dark";
export type Theme = "light" | "dark";

/** Where the choice is kept on this device. */
export const THEME_KEY = "life-archive.console.theme";

/** The settings menu's choices of look, in its order, each with its name and icon. */
export const THEME_CHOICES: readonly { key: ThemeChoice; label: string; icon: IconName }[] = [
  { key: "auto", label: "Automatic", icon: "auto" },
  { key: "light", label: "Light", icon: "sun" },
  { key: "dark", label: "Dark", icon: "moon" },
];

const isTheme = (text: string | null): text is Theme => text === "light" || text === "dark";

/** The choice a page opens with: the address's ?theme= when it names one, else the one kept on this device, else auto. */
export function readThemeChoice(stored: string | null, search: string): ThemeChoice {
  const asked = new URLSearchParams(search).get("theme");
  if (isTheme(asked)) return asked;
  return isTheme(stored) ? stored : "auto";
}

/** The look a choice gives on a device that prefers dark or not. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): Theme {
  return choice === "auto" ? (prefersDark ? "dark" : "light") : choice;
}

/** The console's look, for a view that draws its own colours; the console provides it. */
export const LookContext = createContext<Theme>("light");

/** The colour the browser paints around the page (its theme-color) in each look: the page's own ground. */
export const THEME_COLOR: Record<Theme, string> = { light: "#ffffff", dark: "#000000" };
