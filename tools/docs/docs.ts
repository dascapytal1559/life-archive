// The documents written from the code: docs/privacy.md from the privacy policy (server/privacy/policy.ts, with the
// lines of each module git tracks; privacyDoc.ts), and each tracked module's own (sdk/server.ts's `documents`: friend
// map's docs/platforms.md, from its connectors' manifests). docs.test.ts fails while any is not what this writes. A
// private module, which git ignores, is never in them: they are the same in every checkout.
//   npm run docs

import "../../server/onSettings.ts";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModulePrivacy } from "../../sdk/server.ts";
import { REPO } from "../../server/dataHome.ts";
import { installedPrivacy, loadModules, trackedModules } from "../../server/modules/loader.ts";
import { privacyMarkdown } from "./privacyDoc.ts";

/** Each written document, from the repository's root, with what it holds, given the tracked modules' privacy lines: the core's, then each tracked module's own. */
export async function writtenDocs(root = REPO): Promise<Array<{ file: string; text: (modules: readonly ModulePrivacy[]) => string }>> {
  const tracked = trackedModules(root);
  const { on } = await loadModules({ root, all: true });
  return [
    { file: "docs/privacy.md", text: privacyMarkdown },
    ...on.filter((m) => tracked.has(m.id)).flatMap((m) => (m.definition.documents ?? []).map((doc) => ({ file: doc.file, text: () => doc.text() }))),
  ];
}

/** The privacy lines the documents hold: every tracked module's, switched off or not, as they say what the archive may hold. */
export const documentedPrivacy = (root = REPO): Promise<ModulePrivacy[]> => installedPrivacy({ root, only: trackedModules(root) });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const modules = await documentedPrivacy();
  for (const { file, text } of await writtenDocs()) {
    await writeFile(join(REPO, file), text(modules));
    console.log(`Wrote ${file}`);
  }
}
