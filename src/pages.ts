// Which pages a life archive offers (docs/modules.md's "Ready pages"). Every page this repository ships carries a ready
// mark: a ready page is on in a fresh install, an unfinished one is off and out of the rail until its owner switches it
// on by name, or turns every page on with settings.json's `"pages": "all"`. A page is a module's, and its mark is its
// package.json's `lifeArchiveReady` (server/modules/loader.ts reads it); the core's one page, Events, the home, is
// always on and has none. Promoting a page is one line.
//
// A private module, one its owner added under modules/ and this repository does not ship, carries no mark and is on,
// as it always was: the mark is for this repository's pages, not theirs.
//
// The server decides what is on (the modules it loads) and tells the page; the public demo reads the same marks
// through pageOn, so it offers what a fresh install offers.

/** settings.json's `pages`: only the ready pages unless one is switched on by name (the default), or every page. */
export const PAGE_CHOICES = ["ready", "all"] as const;
export type PageChoice = (typeof PAGE_CHOICES)[number];

/** Whether a page is on: its switch when settings.json names it, else on when ready or when every page is asked for. */
export const pageOn = (ready: boolean, switched: boolean | undefined, pages: PageChoice): boolean => switched ?? (pages === "all" || ready);
