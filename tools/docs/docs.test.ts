import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { ModulePrivacy } from "../../sdk/server.ts";
import { REPO } from "../../server/dataHome.ts";
import { installedPrivacy } from "../../server/modules/loader.ts";
import { FORK_PRIVACY, PRIVACY, privacyWith, REPO_PRIVACY } from "../../server/privacy/policy.ts";
import { documentedPrivacy, writtenDocs } from "./docs.ts";

let modules: ModulePrivacy[];
beforeAll(async () => {
  modules = await documentedPrivacy();
});
const WRITTEN_DOCS = await writtenDocs();

describe("the documents written from the code", () => {
  it("are the privacy policy and the modules' own, friend map's platforms among them", () => {
    expect(WRITTEN_DOCS.map((d) => d.file)).toEqual(["docs/privacy.md", "docs/platforms.md"]);
  });

  for (const { file, text } of WRITTEN_DOCS) {
    it(`${file} is as the code writes it: npm run docs writes it again`, () => {
      const written = readFileSync(join(REPO, file), "utf8");
      expect(written === text(modules), `${file} is stale: run npm run docs, and commit it`).toBe(true);
    });
  }

  it("docs/privacy.md holds every rule of every layer, and each module's lines", () => {
    const text = WRITTEN_DOCS.find((d) => d.file === "docs/privacy.md")!.text(modules);
    for (const layer of [PRIVACY.content, PRIVACY.metadata, REPO_PRIVACY, FORK_PRIVACY]) {
      expect(text).toContain(`## ${layer.title}`);
      expect(text).toContain(layer.rule);
    }
    for (const { what } of [...REPO_PRIVACY.never, ...FORK_PRIVACY.never]) expect(text).toContain(what);
    expect(modules.length).toBeGreaterThan(0);
    for (const line of modules.flatMap((m) => [...(m.content ?? []), ...(m.contentGuards ?? []), ...(m.metadata ?? [])])) expect(text).toContain(`- ${line}`);
    const { content, metadata } = privacyWith(modules);
    expect(content.holds!.length).toBe((PRIVACY.content.holds?.length ?? 0) + modules.flatMap((m) => m.content ?? []).length);
    expect(metadata.holds!.length).toBe((PRIVACY.metadata.holds?.length ?? 0) + modules.flatMap((m) => m.metadata ?? []).length);
  });

  it("hold a module git tracks and never a private one, whose lines the guard's review is told all the same", async () => {
    const root = mkdtempSync(join(tmpdir(), "life-archive-docs-"));
    try {
      const sdk = pathToFileURL(join(REPO, "sdk/server.ts")).href;
      for (const id of ["shared", "private"]) {
        mkdirSync(join(root, "modules", id), { recursive: true });
        writeFileSync(join(root, "modules", id, "package.json"), JSON.stringify({ name: id, private: true, lifeArchive: true }));
        writeFileSync(join(root, "modules", id, "module.ts"), `import { defineModule } from ${JSON.stringify(sdk)};\nexport default defineModule({ id: "${id}", sdk: 1, privacy: { content: ["the ${id} line"] } });\n`);
      }
      writeFileSync(join(root, ".gitignore"), "/modules/*\n!/modules/shared/\n");
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      expect(await documentedPrivacy(root)).toEqual([{ content: ["the shared line"] }]);
      expect(await installedPrivacy({ root })).toEqual([{ content: ["the private line"] }, { content: ["the shared line"] }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
