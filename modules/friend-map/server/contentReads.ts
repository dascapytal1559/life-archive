// What the content routes answer for a read, as plain code over the archive's content path (content.ts's
// ArchiveContent): a person's timeline, a chat's messages and one day of them, a search (http.ts's content routes, under
// /api/archive/content/), and the chat a Messages row's drawer opens (chat.ts, under CONTENT_API/messages/). The routes
// keep each read in the trail of content reads before they answer it; the static demo answers the same questions in
// its page with this same code, over its made-up archive (../demo.ts), where nothing real is read and nothing is kept.
// A wrong question throws a route error (InvalidInputError, NotFoundError), which the routes answer with its status.

import { type ChatPage, CONVERSATION_PAGE, InvalidInputError, isDay, NotFoundError, type ReadScope } from "../../../sdk/server.ts";
import type { ArchiveContent } from "./content.ts";
import type { Db } from "./db.ts";
import { APPS as MESSAGE_APPS } from "./tabs/messagesTab.ts";

/** An answer, and the read it is kept in the trail as (contentLog.ts's what and scope). */
export interface ContentRead {
  answer: unknown;
  what: string;
  scope: ReadScope;
}

const param = (url: URL, name: string): string | undefined => url.searchParams.get(name) || undefined;

function numberParam(url: URL, name: string): number | undefined {
  const value = param(url, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new InvalidInputError(`${name} must be a whole number`);
  return Number(value);
}

/**
 * The answer to a GET of the content route at `path` (under /api/archive/content, as `/people/7/timeline`), with the
 * read it is; null when `path` is none of the reads answered here (an attachment's file, a send).
 */
export function contentRead(content: ArchiveContent, path: string, url: URL): ContentRead | null {
  const page = { before: param(url, "before"), after: param(url, "after"), limit: numberParam(url, "limit"), platform: param(url, "platform") };
  /** A timeline's or chat's page, which starts at one end: before= or after=. */
  const chatPage = () => {
    if (page.before !== undefined && page.after !== undefined) throw new InvalidInputError("a page is either before= or after=, not both");
    return page;
  };
  let match: RegExpExecArray | null;
  if ((match = /^\/people\/(\d+)\/timeline$/.exec(path))) {
    const options = { groups: param(url, "groups") === "1", marketplace: param(url, "marketplace") === "1", account: numberParam(url, "account") };
    const timeline = content.timeline(Number(match[1]), { ...chatPage(), ...options, count: param(url, "count") === "1" });
    if (!timeline) throw new NotFoundError(`no person ${match[1]}${url.searchParams.has("account") ? ` with account ${param(url, "account")}` : ""}`);
    return { answer: timeline, what: "timeline", scope: { person: Number(match[1]), account: options.account, platform: page.platform, groups: options.groups || undefined, marketplace: options.marketplace || undefined } };
  }
  if ((match = /^\/conversations\/(\d+)\/days\/([^/]+)$/.exec(path))) {
    const day = decodeURIComponent(match[2]);
    if (!isDay(day)) throw new InvalidInputError(`a day is written YYYY-MM-DD, not ${JSON.stringify(day)}`);
    return { answer: content.conversationDay(Number(match[1]), day, { after: param(url, "after"), limit: page.limit }), what: "day", scope: { conversation: Number(match[1]), day } };
  }
  if ((match = /^\/conversations\/(\d+)\/messages$/.exec(path))) {
    return { answer: content.conversation(Number(match[1]), { ...chatPage(), count: param(url, "count") === "1" }), what: "conversation", scope: { conversation: Number(match[1]) } };
  }
  if (path === "/search") {
    const scope = { words: param(url, "q") ?? "", person: numberParam(url, "person"), platform: page.platform };
    // Even with no hits: whether words are in the archive is content.
    return { answer: content.search(scope.words, { personId: scope.person, platform: scope.platform, limit: page.limit }), what: "search", scope };
  }
  return null;
}

/** A page's cursor (`<ms>:<id>`, a ChatPage's before or after), or undefined when not given. */
function cursor(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  if (!/^-?\d+:\d+$/.test(value)) throw new InvalidInputError(`${key} is a page's cursor, <ms>:<id>, not ${JSON.stringify(value)}`);
  return value;
}

/**
 * A page of the chat message `id` is in (chat.ts), as `url` asks: around the message at first, then older (before=)
 * or newer (after=) pages, each oldest first; with the read it is.
 */
export function chatRead(db: Db, content: ArchiveContent, id: number, url: URL): ContentRead {
  const message = db
    .prepare("SELECT m.conversation_id, m.sent_at, m.platform, c.type, c.title FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE m.id = ?")
    .get(id) as { conversation_id: number; sent_at: number; platform: string; type: "direct" | "group"; title: string | null } | undefined;
  if (!message) throw new NotFoundError(`there is no message ${id}`);
  const before = cursor(url, "before");
  const after = cursor(url, "after");
  if (before && after) throw new InvalidInputError("a page is either before= or after=, not both");
  const conversation = message.conversation_id;
  const page = (options: { before?: string; after?: string; limit: number }) => content.conversation(conversation, options);
  let answer: ChatPage;
  const base = { conversation: { id: conversation, platform: message.platform, app: MESSAGE_APPS[message.platform] ?? message.platform, type: message.type, title: message.title } };
  if (before) {
    const older = page({ before, limit: CONVERSATION_PAGE });
    answer = { ...base, messages: older.messages.reverse(), before: older.nextBefore, after: null, focus: null };
  } else if (after) {
    const newer = page({ after, limit: CONVERSATION_PAGE });
    answer = { ...base, messages: newer.messages.reverse(), before: null, after: newer.nextAfter ?? null, focus: null };
  } else {
    // Around it: the half before it, then it and those after (a cursor just before it at its time), both oldest first.
    const older = page({ before: `${message.sent_at}:${id}`, limit: CONVERSATION_PAGE / 2 });
    const newer = page({ after: `${message.sent_at}:${id - 1}`, limit: CONVERSATION_PAGE / 2 });
    answer = { ...base, messages: [...older.messages.reverse(), ...newer.messages.reverse()], before: older.nextBefore, after: newer.nextAfter ?? null, focus: id };
  }
  return { answer, what: "conversation", scope: { conversation, message: id } };
}
