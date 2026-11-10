// node:path for the static demo's pages (tools/demo/vite.ts aliases it): the server's code the demo runs in the page
// (sdk/demo.ts) names some paths as it loads (rituals' store's file, the content path's folder) without ever opening
// one there, so POSIX path arithmetic is all it needs.

export const sep = "/";

export function normalize(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

export const join = (...paths: string[]): string => normalize(paths.filter((path) => path !== "").join("/"));

export const isAbsolute = (path: string): boolean => path.startsWith("/");

export const resolve = (...paths: string[]): string => {
  let resolved = "";
  for (const path of [...paths].reverse()) {
    resolved = resolved === "" ? path : `${path}/${resolved}`;
    if (isAbsolute(path)) break;
  }
  return normalize(isAbsolute(resolved) ? resolved : `/${resolved}`);
};

export const dirname = (path: string): string => {
  const at = normalize(path).lastIndexOf("/");
  return at <= 0 ? (path.startsWith("/") ? "/" : ".") : normalize(path).slice(0, at);
};

export const basename = (path: string, suffix = ""): string => {
  const base = normalize(path).split("/").at(-1) ?? "";
  return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
};

export const extname = (path: string): string => {
  const base = basename(path);
  const at = base.lastIndexOf(".");
  return at <= 0 ? "" : base.slice(at);
};

export const relative = (from: string, to: string): string => {
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  return [...a.slice(same).map(() => ".."), ...b.slice(same)].join("/");
};

export const delimiter = ":";

export const parse = (path: string) => {
  const base = basename(path);
  const ext = extname(path);
  return { root: path.startsWith("/") ? "/" : "", dir: dirname(path), base, ext, name: ext ? base.slice(0, -ext.length) : base };
};

/** Named by server code the demo bundles but never runs in the page (the backups' globs). */
export const matchesGlob = (): boolean => {
  throw new Error("the demo's page matches no globs");
};

export const posix = { sep, delimiter, normalize, join, isAbsolute, resolve, dirname, basename, extname, relative, parse, matchesGlob };

export default posix;
