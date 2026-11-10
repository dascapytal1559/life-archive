// node:os for the static demo's pages (tools/demo/vite.ts aliases it; nodePath.ts says why): the server's code the
// demo runs in the page names the home folder as it loads, and there is none in a page.

export const homedir = (): string => "/demo";
export const tmpdir = (): string => "/tmp";
export const hostname = (): string => "demo";
export const platform = (): string => "browser";
export const EOL = "\n";

export default { homedir, tmpdir, hostname, platform, EOL };
