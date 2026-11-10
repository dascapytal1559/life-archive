// Reads Instagram's "Download your information" export of messages (Accounts
// Center, Messages, JSON): Meta's download format, read by metaDyi.ts,
// with Instagram's folders. Inbox chats and message requests are read
// (a request the captain never answered is a chat only they wrote in, which
// the archive rules archive); reported_conversations.json, which lists chats
// reported, holds no messages and is not read.
//
// Media are kept where they are: the export is unpacked into
// data/platform-exports/instagram/<export date>/ and imported as that folder, and each
// attachment points at its file there.

import type { Connector, HistoryOptions } from "../../../../sdk/connector.ts";
import { readMetaDyi, type MetaDyiFlavour } from "../metaDyi.ts";
import { manifest } from "./manifest.ts";

export const INSTAGRAM: MetaDyiFlavour = {
  connector: manifest.id,
  platform: "instagram",
  activityFolder: "your_instagram_activity",
  folders: ["inbox", "message_requests"],
  marketplace: false,
};

export const instagramDyi: Connector = { manifest, history: readInstagramDyi };

export function readInstagramDyi(options: HistoryOptions): Promise<void> {
  return readMetaDyi(INSTAGRAM, options);
}
