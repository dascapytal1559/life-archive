// The Query bar's examples in the static demo (QueryBar's `examples`):
// what you might say, and the query it becomes, since there is no model
// behind a static page to write one. Each names only tags, values and group
// chats the made-up crowd has (words.ts), and matches someone in it;
// examples.test.ts holds it to that.

import type { TranscriptExample } from "../demos/queryBar.ts";

export const EXAMPLES: readonly TranscriptExample[] = [
  { transcript: "everyone I climb with", query: "climbing" },
  { transcript: "who should I reach out to?", query: "should-reach-out" },
  { transcript: "people from uni I haven't spoken to since 2024", query: "uni AND last-spoke<2024" },
  { transcript: "the book club, and anyone in the footy tips chat", query: 'group:"Book club" OR group:"Footy tips"' },
  { transcript: "friends on Telegram or WhatsApp who live in Sydney", query: "(platform:telegram OR platform:whatsapp) AND location:sydney" },
  { transcript: "people I've swapped more than 500 messages with, not family", query: "messages>500 AND NOT family" },
  { transcript: "anyone in Melbourne I haven't tagged yet", query: "location:melbourne AND untagged" },
];
