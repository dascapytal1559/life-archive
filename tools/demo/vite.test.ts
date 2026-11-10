// The demo's pages leave out the modules git does not track (vite.ts's trackedModulesOnly): each glob of the modules'
// files names them as left out, and a file of theirs asked for any other way stops the build. Built for a mount, they
// sit under the demo's site and are told the mount.

import { describe, expect, it } from "vitest";
import { REPO } from "../../server/dataHome.ts";
import { consoleDemoConfig, pageDemoConfig, trackedModulesOnly } from "./vite.ts";

type Hooks = {
  transform: (code: string, id: string) => { code: string } | null;
  load: (this: { error: (message: string) => never }, id: string) => void;
};

describe("the demo's tracked modules alone", () => {
  const plugin = trackedModulesOnly(["private-one"]) as unknown as Hooks;

  it("leaves an untracked module out of every glob of the modules' files, by name", () => {
    const code = 'const found = import.meta.glob<ModuleDemo>("../../modules/*/demo.ts", { eager: true, import: "default" });';
    expect(plugin.transform(code, "viewer/demo/backend.ts")?.code).toBe(
      'const found = import.meta.glob<ModuleDemo>(["../../modules/*/demo.ts","!../../modules/private-one/demo.ts"], { eager: true, import: "default" });',
    );
    expect(plugin.transform('import.meta.glob("./pages/*.tsx")', "viewer/x.ts")).toBeNull();
    expect((trackedModulesOnly([]) as unknown as Hooks).transform(code, "viewer/demo/backend.ts")).toBeNull();
  });

  it("stops the build on a file of an untracked module, and lets a tracked one's through", () => {
    const stop = { error: (message: string): never => { throw new Error(message); } };
    expect(() => plugin.load.call(stop, `${REPO}modules/private-one/viewer.tsx`)).toThrow(/a module git does not track \(modules\/private-one\/viewer\.tsx\)/);
    expect(plugin.load.call(stop, `${REPO}modules/friend-map/viewer.tsx`)).toBeUndefined();
  });
});

describe("the demo's pages built for a mount", () => {
  it("are built under the demo's site, and told the mount", () => {
    const page = { path: "/friend-map", root: `${REPO}modules/friend-map/page`, plugins: [] };
    expect(consoleDemoConfig("/out", []).base).toBe("/life-archive/");
    expect(consoleDemoConfig("/out", []).define?.["import.meta.env.LIFE_ARCHIVE_MOUNT"]).toBe('""');
    expect(pageDemoConfig(page, "/out", []).base).toBe("/friend-map/");
    const mounted = consoleDemoConfig("/out", [], "/life-archive/main");
    expect(mounted.base).toBe("/life-archive/main/_site/life-archive/");
    expect(mounted.define?.["import.meta.env.LIFE_ARCHIVE_MOUNT"]).toBe('"/life-archive/main"');
    expect(pageDemoConfig(page, "/out", [], "/life-archive/main").base).toBe("/life-archive/main/_site/friend-map/");
  });
});
