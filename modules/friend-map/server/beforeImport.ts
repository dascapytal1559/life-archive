// What must hold before one of friend map's connectors' history imports runs (sdk/server.ts's ModuleConnectors'
// `before`): why it cannot, or null.

import type { Db } from "./db.ts";
import { chatsUnderOldKeys, chatsWithFileNameIds } from "./messengerPhoneChats.ts";

const BEFORE_HISTORY: Record<string, (db: Db) => string | null> = {
  // A phone-export chat still under the key it had before chats were keyed by name would come in again as a new chat,
  // and photos sent together whose ids were made from their file names would come in again as new messages.
  "messenger-export": (db) => {
    const name = (chats: Array<{ conversation: number; title: string | null }>) =>
      `${chats.length} of the archive's Messenger phone-export chats (${chats.slice(0, 5).map((c) => `#${c.conversation} "${c.title ?? ""}"`).join(", ")}${chats.length > 5 ? ", ..." : ""})`;
    const oldKeys = chatsUnderOldKeys(db);
    const fileNames = oldKeys.length > 0 ? [] : chatsWithFileNameIds(db);
    if (oldKeys.length + fileNames.length === 0) return null;
    return (oldKeys.length > 0
      ? `${name(oldKeys)} are still under the keys they had before chats were keyed by name, so this import would bring them in again as new chats. `
      : `${name(fileNames)} hold photos sent together whose ids were made from their file names, which each export names anew, so this import would bring them in again. `) +
      "Repair them first: npm run archive -- repair messenger-phone-chats";
  },
};


/** Why `connector`'s history import into the archive `db` cannot run now, or null. */
export const beforeImport = (connector: string, db: Db): string | null => BEFORE_HISTORY[connector]?.(db) ?? null;
