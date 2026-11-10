// The privacy policy (server/privacy/policy.ts) as text, for docs/privacy.md: what anyone reads the policy in, written
// by `npm run docs` (docs.ts) and held to the policy by docs.test.ts. The modules' lines (sdk/server.ts's ModulePrivacy)
// are written into the first two layers with the core's (policy.ts's privacyWith). The policy and its enforcement are
// the core's; only its rendering as a document is a tool.

import type { ModulePrivacy } from "../../sdk/server.ts";
import { FORK_PRIVACY, privacyWith, REPO_PRIVACY, type PrivacyLayer, type RepoLayer } from "../../server/privacy/policy.ts";

/** The whole policy, its three layers in order, as Markdown, the modules' lines among the first two. */
export function privacyMarkdown(modules: readonly ModulePrivacy[]): string {
  const { content, metadata } = privacyWith(modules);
  const lines = [
    "# Privacy",
    "",
    "The captain's privacy policy, in three layers: content, read only when he asks, and by default other people's messages by local models alone; metadata, which they read freely; and what a repository may hold, the life archive's and, apart, his public forks'.",
    "",
    "Written from `server/privacy/policy.ts` by `npm run docs`, with each module's lines (`modules/<id>/server/privacy.ts`); change the policy there, never here.",
    "",
    ...layer(content),
    ...layer(metadata),
    ...repoLayer(REPO_PRIVACY),
    ...repoLayer(FORK_PRIVACY),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function layer(layer: PrivacyLayer): string[] {
  return [
    `## ${layer.title}`,
    "",
    layer.summary,
    "",
    ...(layer.holds?.length ? ["It holds:", "", ...layer.holds.map((item) => `- ${item}`), ""] : []),
    `**Rule.** ${layer.rule}`,
    "",
    ...(layer.guards.length ? ["What holds to it:", "", ...layer.guards.map((item) => `- ${item}`), ""] : []),
  ];
}

function repoLayer(repo: RepoLayer): string[] {
  const [head, ...rest] = layer({ ...repo, guards: [] });
  return [
    head,
    ...rest,
    "Never:",
    "",
    ...repo.never.map(({ kind, what }) => `- ${what} (\`${kind}\`)`),
    "",
    "Fine:",
    "",
    ...repo.fine.map((item) => `- ${item}`),
    "",
    ...(repo.guards.length ? ["What holds to it:", "", ...repo.guards.map((item) => `- ${item}`), ""] : []),
  ];
}
