// The contract between friend-map's page and the archive (the core's src/archive.ts, through the SDK): the shapes the
// friend map module's routes answer under /api/archive, which the page renders and writes back. One copy, the core's;
// the page imports it from here as it always has.

export * from "../../../../sdk/contract.ts";
