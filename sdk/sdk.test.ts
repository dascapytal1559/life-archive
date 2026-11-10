// The SDK is the modules' only way into the core, and the loaders the core's only way into the modules: every import a
// module makes of a file outside its own folder is one of the SDK's files (server.ts, viewer.ts, wire.ts, contract.ts, command.ts, demo.ts,
// connector.ts, and testing.ts for its tests and their helpers in its testing/ folder alone), and no file of the core's imports modules/ by name
// (server/modules/loader.ts and viewer/modules.ts find them by place). Held here as vendor.test.ts holds the pinned
// files, so a module stays one that can be split out (M7 of the plan).
//
// An exception to reading behaviour rather than source, as vendor.test.ts and fixtures/madeUpNames.test.ts are: the
// boundary is the source's own text, the imports it is written with, so its text is what is held. A specifier that is
// not a literal is not seen.

import { globSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "../server/dataHome.ts";
import { installedModules, loadModules } from "../server/modules/loader.ts";
import { SDK_VERSION } from "./server.ts";

/** The SDK's files, from the repository's root: what a module may import of the core; testing.ts its tests alone. */
const SDK = ["sdk/server.ts", "sdk/viewer.ts", "sdk/wire.ts", "sdk/contract.ts", "sdk/command.ts", "sdk/connector.ts", "sdk/demo.ts", "sdk/testing.ts"];
const TESTS_ONLY = "sdk/testing.ts";

const sources = (patterns: string[]) =>
  globSync(patterns, { cwd: REPO, exclude: (path) => /(?:^|\/)node_modules(?:\/|$)/.test(path) }).sort();

/**
 * Every module specifier `text` imports: static imports and re-exports, side-effect imports, and dynamic imports in a
 * statement, the first of a line. An import shown in a comment or a string is none.
 */
function importsIn(text: string): string[] {
  const code = text.split("\n").filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line)).join("\n");
  return [
    ...code.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm),
    ...code.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
    ...code.matchAll(/^(?:(?!\/\/)[^"'`\n])*?\bimport\(\s*["']([^"']+)["']\s*\)/gm),
  ].map((match) => match[1]!);
}

const importsOf = (file: string) => importsIn(readFileSync(resolve(REPO, file), "utf8"));

/** Where a relative specifier from `file` lands, from the repository's root. */
const target = (file: string, specifier: string) => relative(REPO, resolve(dirname(resolve(REPO, file)), specifier));

describe("the SDK", () => {
  it("reads what a file imports, and not what a comment or a string shows", () => {
    const text = [
      `import { a } from "./static.ts";`,
      `import type {`,
      `  B,`,
      `} from "./multiline.ts";`,
      `export { c } from "./reexport.ts";`,
      `import "./side-effect.ts";`,
      `const d = await import("./dynamic.ts");`,
      `// import("./line-comment.ts");`,
      `/** import { e } from "./doc-comment.ts"; */`,
      ` * const f = await import("./block-comment.ts");`,
      `const g = "await import('./string.ts')";`,
      `run(); // import("./trailing-comment.ts")`,
    ].join("\n");
    expect(importsIn(text).toSorted()).toEqual(["./dynamic.ts", "./multiline.ts", "./reexport.ts", "./side-effect.ts", "./static.ts"]);
  });

  it("is all a module imports of the core: its own files, the packages, and the SDK's files alone, the testing SDK in its tests alone", () => {
    const files = sources(["modules/*/**/*.ts", "modules/*/**/*.tsx"]);
    expect(files.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const file of files) {
      const own = file.split("/").slice(0, 2).join("/");
      // A test, or a module's test helpers (its testing/ folder), which only its tests import.
      const test = /\.test\.tsx?$/.test(file) || file.startsWith(`${own}/testing/`);
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith(".")) continue;
        const to = target(file, specifier);
        if (to.startsWith(`${own}/`) || (SDK.includes(to) && (test || to !== TESTS_ONLY))) continue;
        wrong.push(`${file} imports ${specifier} (${to}): a module imports the core through the SDK alone${to === TESTS_ONLY ? ", and the testing SDK in its tests alone" : ""}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("is the core's only door into the modules: no file of the core's imports a file under modules/", () => {
    const files = sources(["server/**/*.ts", "viewer/**/*.ts", "viewer/**/*.tsx", "src/**/*.ts", "sdk/*.ts", "tools/**/*.ts"]);
    const wrong = files.flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier.startsWith(".") && target(file, specifier).startsWith("modules/"))
        .map((specifier) => `${file} imports ${specifier}: the core finds a module by its place (the loaders), never by name`),
    );
    expect(wrong).toEqual([]);
  });

  it("names its files as this test holds them", () => {
    expect(sources(["sdk/*.ts"]).filter((file) => !file.endsWith(".test.ts"))).toEqual(SDK.toSorted());
  });

  it("loads every installed module, none broken, each written for this SDK", async () => {
    const installed = installedModules();
    expect(installed.map((m) => m.id)).toEqual(expect.arrayContaining(["exercise", "health", "journal", "rituals"]));
    const modules = await loadModules({ all: true });
    expect(modules.broken).toEqual([]);
    expect(modules.on.map((m) => m.id)).toEqual(installed.map((m) => m.id));
    for (const module of modules.on) expect(module.definition).toMatchObject({ id: module.id, sdk: SDK_VERSION });
  });
});
