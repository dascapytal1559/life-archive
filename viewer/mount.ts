// Where the page sits on its host. As the archive's server serves it, and in the public demo (docs/demo.md), nowhere
// but its own paths: the console at /life-archive/dev, the routes under /life-archive/api, friend-map's page at
// /friend-map/. A demo built for a mount (`npm run build:demo -- --mount <path>`, the main preview at /life-archive/main,
// docs/demo.md's "The main preview") is served under another server's path instead: its console at the mount itself,
// and the rest of the demo's site (its pages' files, their routes, its data) a step below, under the mount's SITE_STEP,
// whose name is no slug, so no aspect's address is ever one of the site's paths.
//
// The build says the mount (tools/demo/vite.ts defines import.meta.env.LIFE_ARCHIVE_MOUNT); anywhere else (the server's
// own code, its Vite, the tests) it is "".

/** The step below a mount the demo's site sits at: not a slug (viewer/console/address.ts's isSlug), so never an aspect's. */
export const SITE_STEP = "_site";

/** Whether `path` can be a mount: a path of slugs (/life-archive/main), no slash at its end. */
export const isMount = (path: string): boolean => /^(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(path);

/** Where the demo's site sits for a demo mounted at `mount`: "" (the host's root) for none. */
export const siteOf = (mount: string): string => (mount ? `${mount}/${SITE_STEP}` : "");

/** The path this page was built to be served under: "" for none. */
export const MOUNT: string = import.meta.env?.LIFE_ARCHIVE_MOUNT ?? "";

/** Where this page's site sits: every path of the demo's site (the pages, their routes, its data) is under it. */
export const SITE: string = siteOf(MOUNT);
