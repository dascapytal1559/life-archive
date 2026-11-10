// friend-map's contract (src/archive.ts): the shapes the friend map module's routes answer under /api/archive and its
// page (modules/friend-map/page/) renders and writes back, its version and capabilities. Both halves of the module
// import it, the page through its own src/archive.ts, so there is one copy. Nothing here runs anywhere in particular.

export * from "../src/archive.ts";
