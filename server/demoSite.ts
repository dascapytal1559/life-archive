// How a built demo's site is served (docs/demo.md), wherever it is: on Cloudflare Pages (tools/demo/site.ts writes its
// _headers), on this machine to look at (tools/demo/serve.ts) and by the archive's server as the main preview
// (mainPreview.ts): the types of its files, and what a browser may load in its pages.

/** The types of a demo's files, by their extension. */
export const FILE_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
  ".pbf": "application/x-protobuf", ".mvt": "application/vnd.mapbox-vector-tile", ".gz": "application/gzip",
};

/**
 * What a browser may load in a demo's pages: their own files (`own`: 'self' for a site of its own, the mount's address
 * for one served under another server's path, so nothing of that server is reachable from it), SQLite's WebAssembly,
 * and the console's frame of friend-map's page.
 */
export function demoCsp(own: string): string {
  return [
    `default-src ${own}`,
    `script-src ${own} 'wasm-unsafe-eval'`,
    `style-src ${own} 'unsafe-inline'`,
    `img-src ${own} data: blob:`,
    `font-src ${own} data:`,
    `connect-src ${own} data: blob:`,
    `worker-src ${own} blob:`,
    `frame-src ${own}`,
    // Browsers match the pages framing one by their origin alone, so this one is the site's, never a path.
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** The rest of a demo page's headers: no referrer, no devices, nothing guessed of a file's type. */
export const DEMO_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"],
];
