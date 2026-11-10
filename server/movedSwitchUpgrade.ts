// The switches of the core's pages that became modules (docs/settings.md): a page that was the core's was switched by
// settings.json's `aspects.<page>`, and a module is switched by `modules.<id>`, so when a page leaves the core its
// switch moves with it. Every page that had one has left (Baby, then Shopping, then Inspirations), so `aspects` is no
// setting any more. Baby left for a private module, which a checkout may not have, while settings.json is every
// checkout's: its switch moves to `modules.baby` only from a checkout where a module baby is installed, and is left as
// it is in the file everywhere else, ignored there with a warning (withoutAbsentSwitches). loadSettings reads the
// archive's own settings.json with its switches moved (moveSwitches), in memory, so its owner's choice carries over
// without a word from them, and the `aspects` left with nothing in it goes; only the archive's server writes that back
// into the file (settings.ts's writeMovedSwitches, upgradeMovedSwitches), since settings.json is every checkout's and an
// older checkout's server would refuse a switch of a module it does not have yet. A file named by LIFE_ARCHIVE_SETTINGS
// is left alone, and loadSettings refuses `aspects` in it, saying where it went (movedSwitchProblem).

import { readFileSync, writeFileSync } from "node:fs";

/** The core's pages that became modules: each old `aspects` key, and the module that is that page now. */
export const PAGES_NOW_MODULES: Readonly<Record<string, string>> = { shopping: "shopping", inspirations: "inspirations" };

/** The core's pages that became private modules, by the id that is both their old `aspects` key and their module's, with their names. */
export const PAGES_NOW_PRIVATE: Readonly<Record<string, string>> = { baby: "Baby" };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Where each old `aspects` key goes with the modules `installed` (by id): its module's, a private module's only where it is installed. */
const movesWith = (installed: readonly string[]): Record<string, string> => ({
  ...PAGES_NOW_MODULES,
  ...Object.fromEntries(Object.keys(PAGES_NOW_PRIVATE).filter((id) => installed.includes(id)).map((id) => [id, id])),
});

/**
 * `aspects` (settings.json's, as parsed) without the switches of the private modules not `installed` (by id), which a
 * checkout without the module leaves to the checkouts that have it, and their keys; undefined when nothing else was in it.
 */
export function withoutAbsentSwitches(aspects: unknown, installed: readonly string[]): { aspects: unknown; absent: string[] } {
  if (!isObject(aspects)) return { aspects, absent: [] };
  const absent = Object.keys(PAGES_NOW_PRIVATE).filter((id) => id in aspects && !installed.includes(id));
  if (absent.length === 0) return { aspects, absent };
  const left = Object.fromEntries(Object.entries(aspects).filter(([key]) => !absent.includes(key)));
  return { aspects: Object.keys(left).length > 0 ? left : undefined, absent };
}

/**
 * Moves each moved page's switch in `written` (settings.json as parsed) from `aspects` to `modules`, with the modules
 * `installed` (by id); a module already switched there keeps its own switch, the old one dropped; a private module's
 * not installed is left in `aspects` as it is; `aspects` goes once nothing is left in it. Null when there is nothing to
 * move, or `written` is not a shape loadSettings would take.
 */
export function moveSwitches(written: unknown, installed: readonly string[]): { settings: Record<string, unknown>; moved: string[] } | null {
  if (!isObject(written) || !isObject(written.aspects) || (written.modules !== undefined && !isObject(written.modules))) return null;
  const moves = movesWith(installed);
  const moved = Object.keys(moves).filter((page) => page in (written.aspects as Record<string, unknown>));
  if (moved.length === 0 && Object.keys(written.aspects).length > 0) return null;
  const aspects = { ...written.aspects };
  const modules: Record<string, unknown> = { ...(written.modules as Record<string, unknown> | undefined) };
  for (const page of moved) {
    const id = moves[page]!;
    if (!(id in modules)) modules[id] = aspects[page];
    delete aspects[page];
  }
  const { aspects: _, ...rest } = written;
  const left = Object.keys(aspects).length > 0 ? { aspects } : {};
  return { settings: { ...rest, ...left, ...(moved.length > 0 || written.modules !== undefined ? { modules } : {}) }, moved };
}

/** Moves the switches of `file` (the archive's settings.json) as moveSwitches says, with the modules `installed` (by id); true when it did. A file missing, or one that cannot be read or parsed, is left for loadSettings. */
export function upgradeMovedSwitches(file: string, installed: readonly string[]): boolean {
  let written: unknown;
  try {
    written = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  const upgraded = moveSwitches(written, installed);
  if (!upgraded) return false;
  // Written in place, as the upgrade to ready pages writes it, so a settings.json that is a link stays one.
  writeFileSync(file, `${JSON.stringify(upgraded.settings, null, 2)}\n`);
  const words = upgraded.moved.map((page) => `"aspects": {"${page}"} is now "modules": {"${PAGES_NOW_MODULES[page] ?? page}"}`).join(", ");
  console.error(`${file}: ${words ? `${words}, as that page is a module now` : `"aspects", empty, is no setting any more, so it went`} (docs/settings.md)`);
  return true;
}

/** Why `aspects` in a settings file loadSettings reads, with the modules `installed` (by id), is refused: where the page it names went, or that it is no setting any more. */
export function movedSwitchProblem(aspects: unknown, installed: readonly string[]): string | null {
  if (aspects === undefined) return null;
  const moves = movesWith(installed);
  const page = isObject(aspects) ? Object.keys(moves).find((key) => key in aspects) : undefined;
  if (page !== undefined) return `"aspects": {"${page}"} is a module's switch now: write "modules": {"${moves[page]}": ${JSON.stringify((aspects as Record<string, unknown>)[page])}} instead (docs/settings.md)`;
  return `"aspects" is no setting any more: every page it switched is a module now, switched in "modules" (docs/settings.md)`;
}
