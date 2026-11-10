// node:url for the static demo's pages (tools/demo/vite.ts aliases it; nodePath.ts says why): the server's code the
// demo runs in the page names its own folders as it loads (dataHome.ts's REPO), and never opens them there.

export const fileURLToPath = (url: string | URL): string => decodeURIComponent(new URL(url).pathname);

export const pathToFileURL = (path: string): URL => new URL(`file://${encodeURI(path)}`);

export default { fileURLToPath, pathToFileURL };
