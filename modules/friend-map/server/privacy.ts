// Friend map's lines of the privacy policy (sdk/server.ts's ModulePrivacy; the core's server/privacy/policy.ts holds
// the layers and puts these into them): what of the chats is content, and what is metadata. The commands that read
// content (`npm run archive -- timeline` and `search`, the module's, server/commands.ts), the drawer's conversations
// and the Events calendar's day of chats (server/routes.ts) keep every read in the core's trail of content reads.

import type { ModulePrivacy } from "../../../sdk/server.ts";

export const FRIEND_MAP_PRIVACY: ModulePrivacy = {
  content: [
    "message text, earlier texts and original records, and the search index",
    "photos, videos, voice notes and other files",
    "the captain's notes on hangouts and calls, and his drafts",
  ],
  contentGuards: [
    "the Events tables' drawers read a hangout's or a call's note only when he opens it to edit, each read kept in the trail; the tables, the calendar and the record of edits never hold its words",
    "the Events calendar's day lists who was messaged and how many, and reads a chat only when he opens it, one at a time, each page kept in the trail as a day read of that person or chat",
  ],
  metadata: [
    "people's names, aliases, accounts, tags and locations, and the captain's notes for people",
  ],
};
