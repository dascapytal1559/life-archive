// Reads Facebook's "Download your information" export of messages: Meta's
// download format, read by metaDyi.ts, with Facebook's folders,
// Marketplace chats. Media are kept where they are, as Instagram's are: the
// zip parts are unpacked into data/platform-exports/messenger/<export date>/
// (`npm run archive -- exports unpack`) and that folder imported.

import type { Connector, HistoryOptions } from "../../../../sdk/connector.ts";
import { readMetaDyi, type MetaDyiFlavour } from "../metaDyi.ts";
import { manifest } from "./manifest.ts";

export const FACEBOOK: MetaDyiFlavour = {
  connector: manifest.id,
  platform: "messenger",
  activityFolder: "your_facebook_activity",
  folders: ["inbox", "e2ee_cutover", "archived_threads", "filtered_threads", "message_requests"],
  marketplace: true,
};

export const facebookDyi: Connector = { manifest, history: readFacebookDyi };

export function readFacebookDyi(options: HistoryOptions): Promise<void> {
  return readMetaDyi(FACEBOOK, options);
}
