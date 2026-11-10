// npm run archive -- inspiration ... and inspiration-tag ...: the captain's inspirations from the terminal, for him and
// for agents (his Grok Bot agent among them: docs/features.md's "Inspirations"). The archive's command (server/archive/
// cli.ts) parses the options and hands them here through the module's `commands` (module.ts).
//
// `inspiration add` is the terminal's door in (the iPhone's share sheet has the server's capture route; both are one
// capture, Inspirations.capture): it reduces the link to its canonical form, finds or makes the item, records the save,
// and leaves its preview and AI tags waiting for the archive's server, which makes them within seconds
// (worker.ts); --wait waits for the AI's tags and prints them. A capture is no changeset, as an import is not.
// Every other command that changes an item or the vocabulary is one changeset,
// after a checked backup, and `inspiration edit` changes many items at once: without --apply it is a dry run.
// Inspirations are metadata, so every command prints them whole.

import { existsSync, statSync, createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import { Effect, Schedule } from "effect";
import { changesCommand, dayKey, type Db, mediaTypeOf, normalizeTag, runPromise, timeOfDay } from "../../../sdk/server.ts";
import type { InspirationDetail, InspirationFilter, InspirationSummary } from "../wire.ts";
import { inspirationsFolder, keepFile } from "./files.ts";
import { INSTAGRAM, INSTAGRAM_PACE, paceAt } from "./instagram.ts";
import { looksLikeLink } from "./links.ts";
import { openInspirations, type InspirationsPart } from "./part.ts";
import type { KeptFile } from "./store.ts";

/** The options cli.ts parsed that these commands read. */
export interface InspirationOptions {
  caption?: string;
  tag?: string[];
  "ai-tag"?: string[];
  title?: string;
  author?: string;
  description?: string;
  origin?: string;
  file?: string[];
  wait?: boolean;
  untagged?: boolean;
  hidden?: boolean;
  search?: string;
  items?: string;
  limit?: string;
  json?: boolean;
  apply?: boolean;
  expect?: string;
  failed?: boolean;
}

/** What a command needs: the inspirations, the module's folder (its kept files'), its options, and its way to make a changeset after a backup. */
export interface InspirationCli {
  part: InspirationsPart;
  folder: string;
  values: InspirationOptions;
  change: <T>(action: string, work: () => T) => Promise<T>;
}

/** The options these commands take, parsed by the archive's command with the core's own and the other modules' (`why`, `into`, `limit`, `json` and `apply` are the core's). */
export const INSPIRATION_OPTIONS = {
  tag: { type: "string", multiple: true },
  expect: { type: "string" },
  caption: { type: "string" },
  "ai-tag": { type: "string", multiple: true },
  title: { type: "string" },
  author: { type: "string" },
  description: { type: "string" },
  origin: { type: "string" },
  file: { type: "string", multiple: true },
  wait: { type: "boolean" },
  untagged: { type: "boolean" },
  hidden: { type: "boolean" },
  search: { type: "string" },
  items: { type: "string" },
  failed: { type: "boolean" },
} as const;

/** What `inspiration` and `inspiration-tag` are lent by the archive's command (sdk/server.ts's `commands`): the archive's folder, the module's database, and a checked backup before a change (its file's name). */
export interface InspirationCommandContext {
  readonly folder: string;
  readonly db: Db;
  readonly backup: (label: string) => Promise<string>;
}

/**
 * Runs `inspiration` or `inspiration-tag` with `args` and the parsed `values`: each change one changeset in the
 * inspirations' change log after a checked backup (--why kept with it, --into adding it to one), its number told at the end.
 */
export async function runInspirationCommand(command: string, args: readonly string[], values: InspirationOptions & { why?: string; into?: string }, context: InspirationCommandContext): Promise<void> {
  const { folder: dataDir, db, backup: backupBefore } = context;
  const part = openInspirations(db);
  const folder = inspirationsFolder(dataDir);
  let made: { changeset: number | null; backup: string; undo: string } | null = null;
  const change = async <T>(action: string, work: () => T): Promise<T> => {
    const backup = await backupBefore(action);
    const recorded = part.changes.record({ surface: "cli", action, description: values.why, backup, into: into(values.into) }, work);
    made = { changeset: recorded.changeset, backup, undo: "inspiration changes" };
    return recorded.value;
  };
  if (command === "inspiration" && args[0] === "changes") {
    await changesCommand(args[1], args.slice(2), { changes: part.changes, command: "inspiration changes", dataDir, values, backupBefore, made: (it) => (made = it) });
  } else if (command === "inspiration" || command === "inspiration-tag") {
    await (command === "inspiration" ? inspirationCommand : inspirationTagCommand)({ part, folder, values, change }, args[0], [...args.slice(1)]);
  } else throw new Error(`the inspirations have no command ${command}`);
  if (made) {
    const { changeset, backup, undo } = made as { changeset: number | null; backup: string; undo: string };
    console.log(changeset === null ? "Nothing changed, so no changeset." : `Changeset #${changeset}, after the backup ${backup}; undo it with: npm run archive -- ${undo} undo ${changeset}`);
  }
}

/** The changeset --into names, to add this change to. */
function into(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const id = value.replace(/^#/, "");
  if (!/^\d+$/.test(id)) throw new Error("--into takes a changeset number, e.g. --into 12");
  return Number(id);
}

export const INSPIRATION_HELP = `Inspirations (the captain's saved things, each with his caption and his tags, and the AI's tags apart; metadata):
  inspiration add <link or file> [--caption <his words>] [--tag <tag,tag>] [--title <...>] [--author <...>]
      [--description <...>] [--origin <where from>] [--file <photo>] [--wait] [--json]
                                        keep a thing: the link reduced to its canonical form (Instagram, X and
                                        YouTube links of one thing are one item), the item found or made, this save
                                        recorded (origin cli unless said: grok-bot for his Grok Bot agent), his words
                                        added to its caption, his tags to its tags, and what the agent saw of it as its
                                        title, author and description where none is known; a file (a photo or
                                        screenshot) is kept by content hash in modules/inspirations/files/. Its
                                        preview and AI tags are made by the archive's server within a minute; --wait
                                        waits for the AI tags (up to 90 s) and prints them. No changeset: it is a capture
  inspiration list [--tag <tag,tag> | --ai-tag <tag,tag>] [--untagged] [--search <words>] [--hidden] [--limit <n>] [--json]
                                        the items, newest first, each with its number: --tag those with every one of his
                                        tags named, --ai-tag those with every AI tag named (never mixed), --untagged
                                        those with none of his, --search words in caption, title, author, description,
                                        link and tags, --hidden the hidden ones instead
  inspiration show <item> [--json]      one item: everything known, his tags, the AI's (with the model and when), every save
  inspiration tag <item> <tag ...> / inspiration untag <item> <tag ...>
                                        his tags (a new one joins the vocabulary, last)
  inspiration caption <item> <text ...> his words for it ("" for none); the AI's tags are made again
  inspiration hide <item> / inspiration unhide <item>
  inspiration ai-tags <item> | --failed ask for the AI's tags again: one item's, or every one given up on (no changeset)
  inspiration changes [show|undo <#>]  the inspirations' own change log (the module's, apart from the people's), as changes is
  inspiration instagram [start | stop]  how Instagram's previews stand (the author, the post's words and one small
                                        picture, read logged out from each post's public embed page by the archive's
                                        server, one post every 15 to 30 s, at most 100 a day, paused for hours when
                                        Instagram refuses); start asks for every Instagram item without a picture (the
                                        back-fill), stop asks for none still waiting
  inspiration edit (tag | untag) <tag ...> (--items <n,n,...> | --tag ... | --ai-tag ... | --untagged | --search ...)
                                        the dry run: which items it would change, before and after; --apply --expect <n>
                                        makes it as one changeset, refused unless it changes exactly <n> items
  inspiration-tag list                  his inspiration tags, in order, with what each covers and how many items have it;
                                        then the AI tags in use
  inspiration-tag add <name> [--description <what it covers>]
  inspiration-tag rename <tag> <new name>   for every item; onto a tag that exists, the two are merged into that one
  inspiration-tag describe <tag> <text ...> what it covers ("" for nothing)
  inspiration-tag move <tag> <position> put it at this place in the order (1 first)
  inspiration-tag delete <tag>          take it from every item, and it is gone
  Every change here but add and ai-tags is a changeset (--why keeps his words with it; inspiration changes undo puts it back).`;

/** `inspiration <sub> ...`. */
export async function inspirationCommand(cli: InspirationCli, sub: string | undefined, rest: string[]): Promise<void> {
  const { part, values } = cli;
  const store = part.store;
  const now = Date.now();
  switch (sub) {
    case "add":
      return add(cli, rest);
    case "list": {
      const limit = values.limit ? Number(values.limit) : 50;
      const list = store.list(filterOf(values), { limit });
      if (values.json) return void console.log(JSON.stringify(list, null, 2));
      for (const item of list.items) console.log(itemLine(item));
      console.log(`${list.items.length} of ${list.total} ${values.hidden ? "hidden " : ""}${list.total === 1 ? "inspiration" : "inspirations"}.`);
      return;
    }
    case "show": {
      const item = store.existing(itemNumber(rest[0]));
      if (values.json) return void console.log(JSON.stringify(item, null, 2));
      printItem(item);
      return;
    }
    case "tag":
    case "untag": {
      const id = itemNumber(rest[0]);
      const tags = splitTags(rest.slice(1));
      if (tags.length === 0) throw new Error(`name the tags: inspiration ${sub} ${rest[0] ?? "<item>"} <tag ...>`);
      store.existing(id);
      await cli.change(`inspiration ${sub} #${id}`, () => (sub === "tag" ? store.tag(id, tags, now) : store.untag(id, tags, now)));
      console.log(itemLine(store.existing(id)));
      return;
    }
    case "caption": {
      const id = itemNumber(rest[0]);
      store.existing(id);
      await cli.change(`inspiration caption #${id}`, () => store.setCaption(id, rest.slice(1).join(" ").replace(/\\n/g, "\n"), now));
      printItem(store.existing(id));
      return;
    }
    case "hide":
    case "unhide": {
      const id = itemNumber(rest[0]);
      store.existing(id);
      await cli.change(`inspiration ${sub} #${id}`, () => store.setHidden(id, sub === "hide", now));
      console.log(itemLine(store.existing(id)));
      return;
    }
    case "ai-tags": {
      if (values.failed) {
        console.log(`Asked again for the AI's tags of ${store.queueFailedAi()} given up on; the archive's server makes them within a minute.`);
        return;
      }
      const id = itemNumber(rest[0]);
      store.existing(id);
      store.queueAi(id);
      console.log(`Asked again for #${id}'s AI tags; the archive's server makes them within a minute (inspiration show ${id}).`);
      return;
    }
    case "instagram":
      return instagram(cli, rest[0]);
    case "edit":
      return edit(cli, rest[0], rest.slice(1));
    default:
      throw new Error("inspiration add | list | show | tag | untag | caption | hide | unhide | ai-tags | instagram | edit; see npm run archive");
  }
}

/** `inspiration-tag <sub> ...`: his vocabulary. */
export async function inspirationTagCommand(cli: InspirationCli, sub: string | undefined, rest: string[]): Promise<void> {
  const store = cli.part.store;
  const now = Date.now();
  const printTags = () => {
    const { tags, aiTags, untagged, total } = store.tags();
    tags.forEach((tag, i) => console.log(`${i + 1}  ${tag.name} (${tag.count})${tag.description ? `: ${tag.description}` : ""}`));
    console.log(`${tags.length} tags; ${total - untagged} of ${total} items tagged.`);
    console.log(`AI tags in use: ${aiTags.map((tag) => `${tag.name} (${tag.count})`).join(", ") || "none yet"}.`);
  };
  switch (sub) {
    case undefined:
    case "list":
      return printTags();
    case "add": {
      if (!rest[0]) throw new Error("name the tag: inspiration-tag add <name> [--description <what it covers>]");
      const name = await cli.change(`inspiration tag add ${rest.join(" ")}`, () => store.createTag(rest.join(" "), cli.values.description ?? "", now));
      console.log(`Added the inspiration tag ${name}.`);
      return;
    }
    case "rename": {
      if (!rest[0] || !rest[1]) throw new Error("inspiration-tag rename <tag> <new name>");
      const done = await cli.change(`inspiration tag rename ${rest[0]}`, () => store.renameTag(rest[0], rest.slice(1).join(" ")));
      console.log(done.merged ? `Merged ${rest[0]} into ${done.name}.` : `Renamed ${rest[0]} to ${done.name}.`);
      return;
    }
    case "describe": {
      if (!rest[0]) throw new Error("inspiration-tag describe <tag> <what it covers ...>");
      await cli.change(`inspiration tag describe ${rest[0]}`, () => store.describeTag(rest[0], rest.slice(1).join(" ")));
      return printTags();
    }
    case "move": {
      if (!rest[0] || !/^\d+$/.test(rest[1] ?? "") || Number(rest[1]) < 1) throw new Error("inspiration-tag move <tag> <position, 1 first>");
      await cli.change(`inspiration tag move ${rest[0]}`, () => store.moveTag(rest[0], Number(rest[1]) - 1));
      return printTags();
    }
    case "delete": {
      if (!rest[0]) throw new Error("inspiration-tag delete <tag>");
      const count = await cli.change(`inspiration tag delete ${rest[0]}`, () => store.deleteTag(rest[0]));
      console.log(`Deleted the inspiration tag ${normalizeTag(rest[0])}, taken from ${count} ${count === 1 ? "item" : "items"}.`);
      return;
    }
    default:
      throw new Error("inspiration-tag list | add | rename | describe | move | delete; see npm run archive");
  }
}

/** `inspiration add`: the capture (see the top). */
async function add(cli: InspirationCli, rest: string[]): Promise<void> {
  const { part, folder, values } = cli;
  const store = part.store;
  const given = rest.join(" ").trim();
  if (!given && !values.file?.length) throw new Error(`give a link or a file: inspiration add <link or file> --caption "<his words>"`);
  const paths = [...(values.file ?? [])];
  let link: string | null = null;
  if (given) {
    if (isFile(given)) paths.unshift(given);
    else if (looksLikeLink(given)) link = given;
    else throw new Error(`"${given}" is neither a link nor a file`);
  }
  const files: KeptFile[] = [];
  for (const path of paths) {
    if (!isFile(path)) throw new Error(`there is no file at ${path}`);
    files.push(await keepFile(folder, createReadStream(resolve(path)), basename(path), mediaTypeOf(path).mime ?? "application/octet-stream"));
  }
  const now = Date.now();
  const input = {
    caption: values.caption,
    tags: splitTags(values.tag ?? []),
    title: values.title,
    author: values.author,
    description: values.description?.replace(/\\n/g, "\n"),
    origin: values.origin ?? "cli",
    savedAt: now,
    now,
  };
  const captured = store.capture({ ...input, link, files });
  let item = store.existing(captured.id);
  if (values.wait && item.aiState === "pending") {
    item = await runPromise(
      Effect.sync(() => store.existing(captured.id)).pipe(
        Effect.repeat({ schedule: Schedule.spaced(1000), while: (now) => now.aiState === "pending" }),
        Effect.timeoutOption(90_000),
        Effect.map((waited) => (waited._tag === "Some" ? waited.value : store.existing(captured.id))),
      ),
    );
  }
  if (values.json) return void console.log(JSON.stringify({ ...captured, item }, null, 2));
  console.log(`Inspiration #${item.id} (${captured.created ? "new" : captured.saved ? "another save of it" : "this save was kept already"}): ${item.link ?? "a kept file"} [${item.platform} ${item.form}]`);
  if (item.title) console.log(`  title: ${item.title}`);
  if (item.author) console.log(`  author: ${item.author}`);
  if (item.caption) console.log(`  caption: ${item.caption.replace(/\n/g, "\n           ")}`);
  console.log(`  tags: ${item.tags.join(", ") || "(none)"}`);
  console.log(`  AI tags: ${aiLine(item, values.wait === true)}`);
  if (item.probe) console.log(`  probe: ${probeLine(item)}`);
  if (item.hidden) console.log("  (it is hidden: inspiration unhide shows it again)");
}

/** The probe an old item carries, in a line: when firstmate was told, and its result. Nothing makes a probe any more. */
function probeLine(item: InspirationDetail): string {
  const when = (ms: number) => `${dayKey(ms)} ${timeOfDay(ms)}`;
  const probe = item.probe!;
  const asked = probe.requestedAt !== null ? `asked of firstmate ${when(probe.requestedAt)}` : "not asked of firstmate (its result set by hand)";
  const result = probe.result ? `result ${probe.result}${probe.resultAt !== null ? ` (${when(probe.resultAt)})` : ""}` : "no result yet";
  return `${asked}; ${result}`;
}

/** `inspiration instagram [start | stop]`: how Instagram's previews stand, and the back-fill started or stopped (no changeset: a preview is not his edit). */
function instagram({ part }: InspirationCli, verb: string | undefined): void {
  const store = part.store;
  const now = Date.now();
  const pace = INSTAGRAM_PACE;
  if (verb === "start") {
    const asked = store.queueInstagram();
    const waiting = store.instagramStatus(now).waiting;
    console.log(asked === 0
      ? "Every Instagram item has its preview, or is waiting for it, already."
      : `Asked for ${asked} Instagram ${asked === 1 ? "preview" : "previews"}. The archive's server fetches them one post at a time, 15 to 30 s apart, at most ${pace.dailyCap} a day: about ${Math.max(1, Math.ceil(waiting / pace.dailyCap))} ${waiting > pace.dailyCap ? "days" : "day"} for the ${waiting} waiting.`);
  } else if (verb === "stop") {
    const stopped = store.stopInstagram();
    console.log(`Stopped: ${stopped} Instagram ${stopped === 1 ? "preview is" : "previews are"} asked for no more (inspiration instagram start asks again).`);
  } else if (verb !== undefined) throw new Error("inspiration instagram | inspiration instagram start | inspiration instagram stop");
  const status = store.instagramStatus(now);
  console.log(`Instagram's previews: ${status.found} found, ${status.waiting} waiting, ${status.skipped} skipped, ${status.failed} given up on, ${status.notAsked} not asked for.`);
  console.log(`  ${status.lastDay} of ${pace.dailyCap} posts fetched in the last 24 hours.`);
  if (status.last) console.log(`  The last, ${dayKey(status.last.at)} ${timeOfDay(status.last.at)}: ${status.last.outcome}${status.last.note ? ` (${status.last.note})` : ""}.`);
  const next = paceAt(store.fetchTimes(INSTAGRAM, now - 86_400_000), status.last, now, pace);
  if (status.waiting === 0) return;
  if (next.due) console.log("  The next is due now: the archive's server fetches it within a few seconds, if it is running.");
  else {
    const when = `${dayKey(next.at)} ${timeOfDay(next.at)}`;
    console.log(next.why === "paused"
      ? `  Paused until ${when}: Instagram refused the last one, so it waits, then goes on with the same post.`
      : next.why === "cap" ? `  At the day's cap: the next at ${when}.` : `  The next at ${when}.`);
  }
}

/** `inspiration edit (tag | untag) <tag ...>`: one edit to many items, a dry run unless --apply. */
async function edit(cli: InspirationCli, verb: string | undefined, rest: string[]): Promise<void> {
  const { part, values } = cli;
  const store = part.store;
  if (verb !== "tag" && verb !== "untag") throw new Error("inspiration edit tag <tag ...> | inspiration edit untag <tag ...>, with the items chosen");
  const tags = splitTags(rest).map(normalizeTag);
  if (tags.length === 0) throw new Error(`name the tags: inspiration edit ${verb} <tag ...>`);
  const choose = () => chosenItems(cli).map((item) => {
    const after = verb === "tag" ? [...new Set([...item.tags, ...tags])] : item.tags.filter((tag) => !tags.includes(tag));
    return { item, after: verb === "tag" ? order(after, store.tags().tags.map((t) => t.name)) : after };
  });
  const plan = choose();
  const changing = plan.filter(({ item, after }) => after.join(",") !== item.tags.join(","));
  const line = ({ item, after }: (typeof plan)[number]) => `  #${item.id}  ${label(item)}: ${item.tags.join(", ") || "(none)"} -> ${after.join(", ") || "(none)"}`;
  if (!values.apply) {
    console.log(`inspiration edit ${verb} ${tags.join(", ")}: ${plan.length} chosen.`);
    console.log(`Would change ${changing.length}:`);
    changing.forEach((p) => console.log(line(p)));
    console.log(`Already so ${plan.length - changing.length}.`);
    console.log(changing.length === 0
      ? "Nothing to change, and nothing written."
      : `Nothing written (a dry run). To make it, run the same with --apply --expect ${changing.length} --why "<the captain's words>".`);
    return;
  }
  if (values.expect === undefined || !/^\d+$/.test(values.expect)) throw new Error("--apply needs --expect <n>: how many items the dry run said it would change");
  const expected = Number(values.expect);
  const check = (count: number) => {
    if (count !== expected) throw new Error(`this would change ${count} ${count === 1 ? "item" : "items"}, not ${expected}: items changed since the dry run, so run it again and show the captain`);
  };
  check(changing.length);
  if (changing.length === 0) return void console.log("Nothing to change: every item chosen is that way already.");
  const now = Date.now();
  // Chosen again inside the changeset, so nothing can change between the check and the edit.
  const done = await cli.change(`inspiration edit ${verb} ${tags.join(" ")}`, () => {
    const again = choose().filter(({ item, after }) => after.join(",") !== item.tags.join(","));
    check(again.length);
    for (const { item, after } of again) store.setTags(item.id, after, now);
    return again;
  });
  console.log(`Changed ${done.length}:`);
  done.forEach((p) => console.log(line(p)));
}

/** The items --items, or the list filters, choose (every one of them, not a page). */
function chosenItems({ part, values }: InspirationCli): InspirationSummary[] {
  const store = part.store;
  if (values.items !== undefined) {
    return values.items.split(",").map((part) => store.existing(itemNumber(part.trim())));
  }
  const filter = filterOf(values);
  if (filter.tags.length === 0 && !filter.untagged && !filter.q && !filter.hidden) {
    throw new Error("choose the items with --items <n,n,...>, or --tag, --ai-tag, --untagged, --search or --hidden");
  }
  return store.list(filter, { limit: 500 }).items;
}

/** The list filters the options give: --tag (his) or --ai-tag (the AI's), never both. */
function filterOf(values: InspirationOptions): InspirationFilter {
  const manual = splitTags(values.tag ?? []);
  const ai = splitTags(values["ai-tag"] ?? []);
  if (manual.length > 0 && ai.length > 0) throw new Error("filter by his tags (--tag) or by the AI's (--ai-tag), not both at once");
  return { tags: ai.length > 0 ? ai : manual, tagKind: ai.length > 0 ? "ai" : "manual", q: values.search ?? "", untagged: values.untagged === true, platform: "", hidden: values.hidden === true };
}

/** Tags given as words or comma lists ("music,art" "parenting"). */
function splitTags(words: readonly string[]): string[] {
  return words.flatMap((word) => word.split(",")).map((tag) => tag.trim()).filter(Boolean);
}

/** `names` in his vocabulary's order, new ones last. */
function order(names: string[], vocabulary: string[]): string[] {
  const at = (name: string) => (vocabulary.includes(name) ? vocabulary.indexOf(name) : Infinity);
  return [...names].sort((a, b) => at(a) - at(b));
}

function itemNumber(value: string | undefined): number {
  const clean = value?.replace(/^#/, "");
  if (!clean || !/^\d+$/.test(clean)) throw new Error("give an inspiration number (inspiration list shows them)");
  return Number(clean);
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** What an item is called in a line: its title, else its caption's first line, else its link. */
function label(item: InspirationSummary): string {
  const text = item.title ?? (item.caption.split("\n")[0] || item.link || "a kept file");
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}

function itemLine(item: InspirationSummary): string {
  const ai = item.aiTags.length > 0 ? `  AI: ${item.aiTags.join(", ")}` : "";
  return `#${item.id}  ${dayKey(item.createdAt)}  ${item.platform}  ${label(item)}  [${item.tags.join(", ") || "untagged"}]${ai}${item.hidden ? "  (hidden)" : ""}`;
}

function aiLine(item: InspirationDetail, waited: boolean): string {
  if (item.ai.state === "failed") return `none: given up on (${item.ai.error}); inspiration ai-tags ${item.id} asks again`;
  if (item.aiState === "pending") {
    const old = item.aiTags.length > 0 ? `${item.aiTags.join(", ")} (being made again)` : "";
    return old || (waited
      ? `still waiting after 90 s${item.ai.error ? ` (${item.ai.error})` : ""}: is the archive's server running? inspiration show ${item.id} has them once made`
      : "on their way: the archive's server makes them within a minute (--wait waits for them)");
  }
  return `${item.aiTags.join(", ") || "(none)"}${item.ai.model ? ` (${item.ai.model})` : ""}`;
}

function printItem(item: InspirationDetail): void {
  console.log(`Inspiration #${item.id}: ${item.link ?? "a kept file"} [${item.platform} ${item.form}]${item.hidden ? " (hidden)" : ""}`);
  if (item.title) console.log(`  title: ${item.title}`);
  if (item.author) console.log(`  author: ${item.author}`);
  if (item.description) console.log(`  description: ${item.description.replace(/\n/g, "\n               ")}`);
  console.log(`  caption: ${item.caption.replace(/\n/g, "\n           ") || "(none)"}`);
  console.log(`  tags: ${item.tags.join(", ") || "(none)"}`);
  console.log(`  AI tags: ${aiLine(item, false)}`);
  if (item.probe) console.log(`  probe: ${probeLine(item)}`);
  console.log(`  preview: ${item.previewState}${item.image && "url" in item.image ? `, picture ${item.image.url}` : ""}${item.previewNote ? ` (${item.previewNote})` : ""}`);
  for (const file of item.files) console.log(`  file #${file.id}: ${file.mime}, ${file.bytes} bytes`);
  console.log(`  saves (${item.saves.length}):`);
  for (const save of item.saves) {
    console.log(`    ${save.savedAt === null ? "(when unknown)" : `${dayKey(save.savedAt)} ${timeOfDay(save.savedAt)}`}  ${save.origin}${save.link ? `  ${save.link}` : ""}${save.caption ? `: ${save.caption.replace(/\n/g, " ")}` : ""}`);
  }
}
