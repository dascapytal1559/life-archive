// What the archive holds that each of friend map's connectors first brought, for the Events page's Sources tab
// (sdk/server.ts's ModuleConnectors' `brought`): its messages and its calls, by the connector whose run first brought
// each, as the Sources tab counts them (server/sources/sources.ts's BROUGHT_MESSAGES and BROUGHT_CALLS).

import type { Db } from "./db.ts";

export function broughtChats(db: Db): Array<{ connector: string; kind: string; count: number }> {
  return [
    ...(db.prepare("SELECT s.connector, 'message' AS kind, count(*) AS count FROM message m JOIN source s ON s.id = m.first_source_id GROUP BY s.connector").all() as Array<{ connector: string; kind: string; count: number }>),
    ...(db.prepare("SELECT s.connector, 'call' AS kind, count(*) AS count FROM call c JOIN source s ON s.id = c.first_source_id GROUP BY s.connector").all() as Array<{ connector: string; kind: string; count: number }>),
  ];
}
