// A file answered a byte range at a time (HTTP Range, RFC 9110 §14), so a browser's player can seek in a recording or
// a video without fetching it whole: friend map's attachments (modules/friend-map/server/http.ts) and the journal's
// recordings and pictures (modules/journal/server/http.ts) are both answered here. One range a request; a request for
// several is answered with the whole file, which every browser accepts.

import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

/**
 * One byte range from a Range header: null for none (or several, which are
 * answered with the whole file), "unsatisfiable" for one outside the file.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * Answers the file at `path`, `size` bytes long, whole (200) or the one range the request asks for (206), 416 for a
 * range outside it, with `headers` (its type, how it may be cached) and the range's own; a HEAD gets the headers alone.
 * A player that stops mid-stream closes the connection, which is not an error.
 */
export async function sendRanged(req: IncomingMessage, res: ServerResponse, path: string, size: number, headers: Record<string, string | number>): Promise<void> {
  const all = { ...headers, "accept-ranges": "bytes" };
  const range = parseRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...all, "content-range": `bytes */${size}` }).end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  res.writeHead(range ? 206 : 200, {
    ...all,
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    "content-length": Math.max(0, end - start + 1),
  });
  if (req.method === "HEAD" || end < start) {
    res.end();
    return;
  }
  await pipeline(createReadStream(path, { start, end }), res).catch(() => res.destroy());
}
