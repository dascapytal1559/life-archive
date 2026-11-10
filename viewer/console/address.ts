// The console's addresses (viewer/console/Console.tsx): the console at /life-archive/dev, an aspect a step below it
// (/life-archive/dev/health) and a view another step below (/life-archive/dev/health/records), so a reload, the
// back button or a link opens the same place. An aspect's address alone is its first view's, as the viewer's pages
// write their first tab (/life-archive/dev/health-record is Health's All); a view's slug is its `section` in the registry
// (registry.ts). Nothing here knows the registry: Console.tsx reads a place from the address with these and the
// registry's lists, and writes one back with consolePath. A demo built for a mount (../mount.ts: the main preview)
// has its console at the mount instead.

import { MOUNT } from "../mount.ts";
import { VIEWER_BASE } from "../wire.ts";

/** The console's own address; everything of it is a step below. */
export const CONSOLE_PATH = MOUNT || `${VIEWER_BASE}/dev`;

/** The console's address until 8 November 2026; the server sends each address under it on to the same place under CONSOLE_PATH. */
export const FORMER_CONSOLE_PATH = `${VIEWER_BASE}/console`;

/** Whether `pathname` is the console, anywhere in it. */
export function isConsolePath(pathname: string): boolean {
  return pathname === CONSOLE_PATH || pathname.startsWith(`${CONSOLE_PATH}/`);
}

/**
 * The address `pathname` names now, when it is one of the console's former ones (/life-archive/console/health is
 * /life-archive/dev/health): the console itself, an aspect or a view, each step a slug. Null for any other, among them
 * the console's own source files, which the page's Vite serves at the same path (/life-archive/console/Console.tsx is
 * viewer/console/Console.tsx).
 */
export function fromFormerConsole(pathname: string): string | null {
  if (pathname !== FORMER_CONSOLE_PATH && !pathname.startsWith(`${FORMER_CONSOLE_PATH}/`)) return null;
  const rest = pathname.slice(FORMER_CONSOLE_PATH.length);
  const steps = rest.split("/").slice(1);
  if (steps.at(-1) === "") steps.pop();
  return steps.length <= 2 && steps.every(isSlug) ? `${CONSOLE_PATH}${rest}` : null;
}

/** The aspect's and the view's slugs an address names, each "" when it does not: /life-archive/dev/health/records is ["health", "records"]. */
export function stepsOf(pathname: string): [aspect: string, section: string] {
  if (!pathname.startsWith(`${CONSOLE_PATH}/`)) return ["", ""];
  const [aspect = "", section = ""] = pathname.slice(CONSOLE_PATH.length + 1).split("/");
  return [aspect, section];
}

/**
 * The address of a place in the console: the console itself with no aspect (its home), an aspect's first view with its slug alone, and
 * any other view with the aspect's slug and its own.
 */
export function consolePath(aspect?: string, section?: string): string {
  if (!aspect) return CONSOLE_PATH;
  return section ? `${CONSOLE_PATH}/${aspect}/${section}` : `${CONSOLE_PATH}/${aspect}`;
}

/** Opens `address` in place, a step back can return from, and tells what follows the address (popstate): the console, and a view keeping its state in the query. Nothing for the address already open. */
export function openAddress(address: string): void {
  if (address === location.pathname + location.search) return;
  history.pushState(null, "", address);
  dispatchEvent(new PopStateEvent("popstate"));
}

/** A slug as the console writes one: lowercase words joined by dashes, nothing else, so an address holds it as it is. */
export function isSlug(text: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text);
}
