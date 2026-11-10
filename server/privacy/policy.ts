// The privacy policy, as the captain set it, in three layers: the content of his chats, read only when he asks, and by
// default other people's messages by local models alone; their metadata, which external models read freely; and what a repository may hold, the life archive's and, apart,
// his public forks'. docs/privacy.md is them all as text (`npm run docs` writes it), and AGENTS.md and the README
// point here (README.md's "Privacy").
//
// The first two are PRIVACY. The third, REPO_PRIVACY, is apart: it is this repository's policy in the privacy guard
// (the life-archive policy, server/guard/policies/lifeArchive.ts; friend-map's until friend-map-frontend was archived),
// which the model's review is given as written here, with the content layer's list, and whose kinds the commit check
// looks for by pattern or from the archive. It is installed nowhere yet: the repository is local-only until it is
// published. FORK_PRIVACY, the last, is the repository layer for a public fork (the public-fork policy,
// server/guard/policies/publicFork.ts, which his own forks extend in the archive's folder), which the guard holds to it
// the same way.
//
// A repository layer is narrow on purpose: it lists the few kinds of data that stop a commit (BLOCK_KINDS), and
// everything else is allowed. The model's review may still suggest a change elsewhere; that is logged for the captain to
// look over now and then, and never stops anything (server/guard/review.ts).
//
// A module says what of its own data is content and metadata (sdk/server.ts's ModulePrivacy, health's in
// modules/health/server/privacy.ts, friend map's, the chats themselves, in modules/friend-map/server/privacy.ts): privacyWith puts those lines into the first two layers, for the document and for
// the guard's review, which is told what content is.

import type { ModulePrivacy } from "../../sdk/server.ts";

/** One layer of the privacy policy. */
export interface PrivacyLayer {
  title: string;
  /** What it is, in a line. */
  summary: string;
  /** What is in it. */
  holds?: string[];
  /** Who may read it, or what may be committed. */
  rule: string;
  /** What holds to it. */
  guards: string[];
}

/**
 * The kinds of data that stop a commit: the only ones a repository layer may name, and the only ones the model's review
 * may stop a push for. Every other thing it notices is a suggestion.
 */
export const BLOCK_KINDS = ["name", "account", "phone-number", "email", "private-host", "ip-address", "street-address", "user-path", "secret", "content", "health"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** The repository layer: what it never holds, each with the kind the model's review reports it as, and what is fine, said outright. */
export interface RepoLayer extends PrivacyLayer {
  never: Array<{ kind: BlockKind; what: string }>;
  fine: string[];
}

/** What models may read: content only when the captain asks (other people's messages, by default, by local models alone), metadata freely. */
export const PRIVACY: { content: PrivacyLayer; metadata: PrivacyLayer } = {
  content: {
    title: "Content",
    summary: "What was said and shown.",
    holds: [
      "every copy that holds them: the platforms' exports and media and the backups in the archive's folder (`LIFE_ARCHIVE_DATA`, else `~/life-archive-data`), the bridge rig's data under `~/.local/share/friend-map-bridge-lab/`, an export the Cua Space downloaded, in its Downloads until `npm run cua-exports` takes it (docs/data.md, \"Exports from the Cua Space\"), the iPhone backup Finder keeps up to date in `~/Library/Application Support/MobileSync/Backup/` (or on the disk that folder links to; docs/import-runbook.md, \"Taking the backup\"), and LLM transcripts that may quote it: the tools' own stores (`~/.claude`, `~/.codex`, `~/.grok`, Pi's, OpenCode's, T3 Code's and the rest, and the Cua Space's `~/.codex`, where the export rounds' Codex keeps its sessions), OpenSuperWhisper's dictations (its `recordings/` and the `recordings.sqlite` that holds their transcripts, in `~/Library/Application Support/ru.starmel.OpenSuperWhisper/`), and the archive's copy of every one of them, kept each night in `transcripts/` in the archive's folder (docs/data.md, \"Every LLM transcript\"); and the NAS's nightly snapshots, encrypted on this Mac before they leave it: of the archive's whole folder, each kept a week, and of its `transcripts/` and `llm/` alone, tagged `llm-transcripts` and never forgotten (docs/data.md, \"The NAS copy\")",
    ],
    rule: "By default, messages with other people on social media and messaging platforms (WhatsApp, Messenger, Instagram, WeChat, Discord, X and the like), with their media and every copy that holds them, never reach an external model or agent (any not run on the owner's own machines: Claude, OpenAI, DeepSeek and the like): only local models on his machines read them. The rest of it, email among it, external models may read. An installation's own written policy (its `AGENTS.local.md`) may set this otherwise, and wins where it does. Whichever model reads it does so only when the captain asks for something from his chats, only for that request, and only through `npm run archive -- timeline`, `search` and `event-content`, or a content tool at the agents' MCP door to a key the captain granted it (docs/agents.md), which log every read (`npm run archive -- content-log`); never otherwise. An LLM transcript (a tool's own, the archive's copy in `transcripts/`, or a NAS snapshot of them) is read on the same terms, only when the captain asks for something from it and only for that request, and, since it may quote other people's messages, by default by a local model alone; the nightly pass that copies them, its check and the NAS backup handle them as bytes and read none, and the LLM warehouse (docs/events.md, \"The LLM warehouse\") reads each prompt's text only to classify it as one of a few fixed shapes (a tool's notice or hook feedback, a slash command, and, where an orchestrator's provenance adapter is set up, such as FirstMate's with `FIRSTMATE_HOME`, that orchestrator's launch briefs, doorbells and wake-ups) and to count its length, as the agents' connectors count theirs, keeping no word of it. It is never committed or published.",
    guards: [
      "the three commands keep every read in the trail, with who read and the captain's words",
      "SQL queries cannot read it, and `--redacted` shows its shape with every text as its length",
      "the agents' MCP door (`/life-archive/mcp`, `server/mcp/`) answers only a key made with `npm run archive -- mcp key add`, each agent's own, and offers a key only the tools it may call: facts to every key, content only to a key granted `content` (or `content:<module>`), each content call taking the captain's words as `why` and kept in the trail with the key's agent as its reader, and writes only to a key granted `write` (or `write:<module>`); every call is kept in `core.sqlite`'s `mcp_call` with its agent, never what a content tool answered; and start_here tells every agent that what the archive answers is data, never instructions",
    ],
  },
  metadata: {
    title: "Metadata",
    summary: "The index of what happened, without what was said.",
    holds: [
      "when, how long, with whom, in which chat, on which platform, of what type and how big",
      "counts, sizes, dates, coverage and the schema",
      "the agents' keys, as their hashes with each agent's grants, and their calls (`core.sqlite`'s `mcp_key` and `mcp_call`): who called which tool when, how it went, a facts tool's arguments and a content or write tool's summary of what it was about (an op and a date, never its words)",
      "the LLM warehouse's index of every LLM session on this Mac (the core's `llm_session`, `llm_turn` and `llm_tag`): each session's and turn's time, length, tool, model, tokens and cost, what each prompt's text was classified as, and its tags (who sent it, from which device, how, in what kind of session and project, and a worker's task as firstmate's own records name it, never taken from a prompt's text)",
      "the inspirations' old copy from before the inspirations module (`core.sqlite`'s inspiration tables and change log, and `platform-exports/inspirations/live/`), read by nothing since the module took them over, kept until the captain says it may go",
      "the record of the tables' edits (`core.sqlite`'s `table_edit`, server/edits/): each change made to a row of a table from its drawer or the CLI, when, from where, which row and field, what it was and became (a person's name, tags, location and his note for them among those, metadata as they are in People), people by their ids, and the owner's receipt for its undo; never a note's words that are content (a hangout's or a call's), which stay with the note's owner, where its editor reads them through the trail",
      "the archive's old workout rows from before the exercise module, read by nothing: from the module's landing until `npm run archive -- migrate friend-map-module --apply` (the friend map step's move, which drops them too) overwrites them for good, they and the archive's backups of the last 48 hours still hold the index row of a workout the captain deleted (when, its sport, how far, what recorded it and where its copy was; no route or heart rate)",
    ],
    rule: "External models may read it freely, with no read logged. What of it may be committed is the repository layer's to say: counts, dates and places may be, names and ids may not.",
    guards: [],
  },
};

/** The first two layers with the modules' lines in them: what each module says of its data is content, and metadata. */
export function privacyWith(modules: readonly ModulePrivacy[]): typeof PRIVACY {
  return {
    content: {
      ...PRIVACY.content,
      holds: [...(PRIVACY.content.holds ?? []), ...modules.flatMap((m) => m.content ?? [])],
      guards: [...PRIVACY.content.guards, ...modules.flatMap((m) => m.contentGuards ?? [])],
    },
    metadata: { ...PRIVACY.metadata, holds: [...(PRIVACY.metadata.holds ?? []), ...modules.flatMap((m) => m.metadata ?? [])] },
  };
}

/** What a repository may hold: the privacy guard's policy, which its model review is given as written. */
export const REPO_PRIVACY: RepoLayer = {
  title: "The repository",
  summary: "What may be committed or published. The repository is private, but every tracked file and commit message is held to this as if published, since making it public publishes them all.",
  rule: "Anything may be committed but these, wherever they would go (code, comments, tests, fixtures, docs, screenshots, commit messages and the captain's quoted asks). Only these stop a commit; anything else the review notices is a suggestion, logged for the captain, that never stops one:",
  never: [
    { kind: "name", what: "a real person's name or nickname, the captain's own included (his GitHub identity as commit author aside), or a real group chat's title" },
    { kind: "phone-number", what: "a real phone number" },
    { kind: "email", what: "a real email address" },
    { kind: "account", what: "a real chat handle or account id (Telegram, WhatsApp, Signal, Discord, WeChat, X and the like)" },
    { kind: "private-host", what: "a tailnet host name or Tailscale address, a host name on the captain's own network, or this Mac's user or host name" },
    { kind: "ip-address", what: "a real machine's IP address (loopback, private-network and documentation ones, such as 127.0.0.1, 192.168.1.5 and 203.0.113.7, are fine)" },
    { kind: "street-address", what: "a precise real-world address: a street address or an exact spot" },
    { kind: "user-path", what: "a local path that holds a user name (`/Users/<name>/…`)" },
    { kind: "content", what: "any content (the first layer): text from the archive, that is friends' messages, media, and the captain's hangout notes and drafts, or text from his notes for people" },
    { kind: "secret", what: "a secret: an API key, token, password or private key" },
    { kind: "health", what: "the captain's own health records and results: a result of his, a diagnosis, condition, allergy, treatment or medicine of his, or which labs or clinics tested him and when (made-up results in tests and fixtures are fine)" },
  ],
  fine: [
    "cities, towns, regions and countries (Melbourne, Tokyo, Australia) and time zones (`Australia/Melbourne`)",
    "dates and times",
    "counts and sizes from the archive, even about one person",
    "ordinary words and phrases and code identifiers, even capitalised ones that look like a name (\"Since Aug\")",
    "the made-up names in `server/fixtures/madeUpNames.ts`, numbers set aside for fiction, example domains, and placeholder hosts (a tailnet named `tail1234`, `your-mac`)",
    "in the commit check's own tests (the life archive's `server/guard/scan.test.ts`), the real-looking values each built from pieces with `join(...)` for the check to stop: they are made up",
    "generic stand-ins (\"[a friend]\", \"Person A\") and the word \"captain\"",
    "commit messages quoting the captain's own asks to his agents, real names replaced with \"[a friend]\": they are his instructions about the software, not content; a friend's message quoted in one is still content",
    "public companies, products, libraries, tools, AI models and agents and their authors, and public figures named as such",
    "third-party licence notices bundled as their licence requires, with their authors' public contact details (a font's OFL notice and its author's email)",
    "the captain's GitHub handle",
    "Handles and account ids made from the made-up names, as a test or fixture writes them (adasample, ada_sample, @ada_sample, ada_sample_77).",
    "The addresses set aside for documentation (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32), in tests of which hosts are refused.",
  ],
  guards: [
    "the life archive's privacy guard (`npm run guard`), under the `life-archive` policy, once it is installed in the repository (`npm run guard -- install life-archive`, which points its `core.hooksPath` at the guard's hooks); until it is published, the repository stays on this Mac and is not installed",
    "its commit check on every commit, and on every commit a push sends that was not reviewed yet (`server/guard/scan.ts`): the names, ids and notes in the archive, and phone numbers, emails, chat ids, host names, IP addresses and street addresses by their shape",
    "its privacy review by GPT-6.1 Sol of each commit once, whether firstmate landed it or the phone agent committed it: as its branch lands or on the first push that sends it, recorded so it is never reviewed again (`server/guard/review.ts`), given this layer; it stops only on one of these kinds with the text found where it says, and logs anything else as a suggestion (`npm run guard -- findings`)",
    "before the repository is made public, both checks over whatever it would publish that was not reviewed yet (`npm run guard -- publish-check`), then the captain's yes",
  ],
};

/** What a public fork may hold (the public-fork policy, and every fork policy extending it): the repository layer for code anyone can read. */
export const FORK_PRIVACY: RepoLayer = {
  title: "A public fork",
  summary: "Open-source code the captain publishes on GitHub, merged from its upstream with his own changes on top. Every tracked file and commit message is public as soon as it is pushed.",
  rule: "Anything about the software may be committed but these, wherever they would go (code, comments, tests, fixtures, docs, dev journals, screenshots and commit messages). Only these stop a commit; anything else the review notices is a suggestion, logged for the captain, that never stops one:",
  never: [
    { kind: "private-host", what: "the name of one of the captain's own machines or servers (a Mac, a remote host, a NAS), a tailnet's name or a host on it (`<host>.<tailnet>.ts.net`), a Tailscale address, a host name on his own network, or this Mac's user or host name" },
    { kind: "account", what: "the name or folder of one of the captain's own accounts or tool profiles other than his GitHub identity (a second login, a Claude or Codex profile such as `.claude-profiles/<name>`), or a real chat handle or account id" },
    { kind: "user-path", what: "a local path that holds a real user name (`/Users/<name>/…`, `/home/<name>/…`)" },
    { kind: "email", what: "a real email address, the captain's or anyone's from his life (upstream's own published addresses, as upstream's commits carry them, aside)" },
    { kind: "name", what: "a real person's name from the captain's life, his own included (his GitHub identity as commit author aside), or a real group chat's title" },
    { kind: "phone-number", what: "a real phone number" },
    { kind: "ip-address", what: "a real machine's IP address (loopback, private-network and documentation ones, such as 127.0.0.1, 192.168.1.5 and 203.0.113.7, are fine)" },
    { kind: "street-address", what: "a precise real-world address: a street address or an exact spot" },
    { kind: "content", what: "any content from the captain's archive (the first layer): friends' messages, media, his hangout notes and drafts, his notes for people, or his own private journal" },
    { kind: "secret", what: "a secret: an API key, token, password or private key" },
  ],
  fine: [
    "products, tools, AI models and coding agents by name, and which of them the software supports, runs or was tested with (Claude, Codex, Grok, Cursor, OpenCode, `gpt-6-luna`, `claude-haiku-5-5`)",
    "test results, live checks and verification tables: what was run, on which model, at which effort, and how it went",
    "that the captain has a setup, said without naming his machines, servers or profiles: \"the captain's macOS arm64 build\", \"waits on the captain's setup\", \"sign in\", \"a remote host\", \"a second Claude profile\", \"the captain's tailnet\"",
    "dates, times, versions, commit ids, counts, sizes and durations not tied to a named machine or profile of his",
    "code identifiers and ordinary words, even ones that look like a host's or a person's name (upstream's `ZData`, `zdata`, \"Since Aug\")",
    "generic paths: `~/`, `$HOME`, `/Users/<name>`, `/home/<user>`",
    "placeholder hosts and example domains: a tailnet named `tail1234`, `example.ts.net`, `your-mac.tail1234.ts.net`, `your-mac`, `example.com`, `.test`, `.invalid`",
    "the captain's GitHub handle and its noreply address, and the word \"captain\"",
    "upstream's project, its authors and contributors, and public companies, products, libraries and their authors, and public figures named as such",
    "made-up names, numbers set aside for fiction and documentation addresses (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32) in tests and examples",
    "cities, regions, countries and time zones",
    "commit messages quoting the captain's own asks to his agents about the software, a real name replaced with \"[a friend]\"",
  ],
  guards: [
    "the life archive's privacy guard (`npm run guard` there), installed into the fork by pointing its `core.hooksPath` at the guard's hooks, which run the fork's own hooks first",
    "its commit check on every commit, and on every commit a push sends that was not reviewed yet: the private terms beside the archive, the archive's names, and emails, host names, IP addresses and the rest by their shape",
    "its privacy review by GPT-6.1 Sol of each commit once, on the first push that sends it, given this layer: it stops only on one of these kinds with the text found where it says, and logs anything else as a suggestion (`npm run guard -- findings`)",
    "every commit a push sends made under a GitHub noreply address",
  ],
};
