// --redacted on timeline and search (cli/chats.ts): the same answer with every text replaced by how long it was (the
// core's redactText), so an agent can learn the shape of content without reading any. A file is already given only by
// its type, MIME type and size there, never its bytes or name.

import { redactText, type SearchHit, type TimelineMessage, type TimelinePage } from "../../../sdk/server.ts";

export { redactText };

function redactMessage<T extends TimelineMessage>(message: T): T {
  return { ...message, text: message.text === null ? null : redactText(message.text), callNote: message.callNote && redactText(message.callNote) };
}

export function redactPage(page: TimelinePage): TimelinePage {
  return { ...page, messages: page.messages.map(redactMessage) };
}

export function redactHits(hits: readonly SearchHit[]): SearchHit[] {
  return hits.map((hit) => ({ ...redactMessage(hit), snippet: redactText(hit.snippet) }));
}
