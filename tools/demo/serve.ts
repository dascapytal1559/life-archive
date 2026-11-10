// npm run serve:demo [-- --out <dir>] [--port <port>]: a built demo (build.ts) served on this machine as Cloudflare
// Pages serves it, to look at before it is published: its _redirects (a rule followed before any file, a rewrite with
// 200 answered with the file it names, a redirect's :splat what its /* matched, the query kept), its _headers, its files, and the nearest 404.html for anything else. On
// 127.0.0.1 alone, at port 4680 unless --port names another.

import "../../server/onPinnedNode.ts";
import "../../server/onSettings.ts";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FILE_TYPES as TYPES } from "../../server/demoSite.ts";
import { DEMO_OUT } from "./build.ts";

/** A _redirects rule: from (an exact path, or a prefix before /*), to and its status. */
interface Rule {
  from: string;
  splat: boolean;
  to: string;
  status: number;
}

const rulesOf = (text: string): Rule[] =>
  text.split("\n").map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2 && !parts[0].startsWith("#")).map(([from, to, status]) => ({
    from: from.endsWith("/*") ? from.slice(0, -1) : from,
    splat: from.endsWith("/*"),
    to,
    status: Number(status ?? 302),
  }));

/** _headers' blocks: a path pattern (* for anything) and its headers. */
const headersOf = (text: string): Array<{ pattern: RegExp; headers: Array<[string, string]> }> => {
  const blocks: Array<{ pattern: RegExp; headers: Array<[string, string]> }> = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) blocks.push({ pattern: new RegExp(`^${line.trim().split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`), headers: [] });
    else {
      const at = line.indexOf(":");
      blocks.at(-1)?.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
  }
  return blocks;
};

/** Serves the demo at `out` on `port` (see the top). */
export async function serveDemo(out: string, port: number): Promise<void> {
  const rules = existsSync(join(out, "_redirects")) ? rulesOf(await readFile(join(out, "_redirects"), "utf8")) : [];
  const headers = existsSync(join(out, "_headers")) ? headersOf(await readFile(join(out, "_headers"), "utf8")) : [];
  const fileAt = (path: string): string | null => {
    const file = normalize(join(out, decodeURIComponent(path)));
    if (!file.startsWith(out)) return null;
    if (existsSync(file) && statSync(file).isFile()) return file;
    const index = join(file, "index.html");
    return existsSync(index) ? index : null;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = url.pathname;
    let status = 200;
    const rule = rules.find((r) => (r.splat ? path.startsWith(r.from) : path === r.from));
    if (rule && rule.status !== 200) {
      res.writeHead(rule.status, { location: `${rule.splat ? rule.to.replace(":splat", path.slice(rule.from.length)) : rule.to}${url.search}` }).end();
      return;
    }
    if (rule) path = rule.to;
    let file = fileAt(path);
    if (file && !path.endsWith("/") && file.endsWith("index.html") && !path.endsWith("index.html")) {
      res.writeHead(308, { location: `${path}/${url.search}` }).end();
      return;
    }
    if (!file) {
      status = 404;
      for (let dir = dirname(join(out, path)); dir.startsWith(out); dir = dirname(dir)) {
        if (existsSync(join(dir, "404.html"))) {
          file = join(dir, "404.html");
          break;
        }
        if (dir === out) break;
      }
    }
    const extra = headers.filter((block) => block.pattern.test(url.pathname)).flatMap((block) => block.headers);
    if (!file) {
      res.writeHead(404, Object.fromEntries(extra)).end("Not found");
      return;
    }
    res.writeHead(status, { ...Object.fromEntries(extra), "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(file));
  });
  await new Promise<void>((listening) => server.listen(port, "127.0.0.1", listening));
  console.log(`The demo in ${out}, as Cloudflare Pages serves it: http://127.0.0.1:${port}/`);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" }, port: { type: "string" } } });
  await serveDemo(resolve(values.out ?? DEMO_OUT), Number(values.port ?? 4680));
}
