// When the captain and each person were first in touch (TableRow.firstContactAt), across every platform: the earliest
// of their messages as messageCount counts them (stats.ts: every message in a one-to-one chat with them, either way,
// and what they sent in group chats; none in a Marketplace or dropped chat, and no system message), their calls of
// any source (the call table's, answered or not, and those the captain logged; an app's call record in a one-to-one
// chat is among that chat's messages), and the hangouts they were at (a hangout's local day and time, or its
// day's start without one). Dates only, never text.
//
// It reads the indexes, never scans the messages: each one-to-one chat's first message is the first of its
// message_conversation_time entries, and an account's group messages are looked for in message_sender_time only when
// it wrote in a group chat (its stored group_count, counted when messageCount is) and only before the first of its
// one-to-one chats, where their own messages there cannot be, so the walk stops at once for anyone who has one.

import { type Db, wallClock } from "../../../sdk/server.ts";

/** Each person's first contact (ms), by person id; nobody without one. The captain's own accounts are left out. */
export function firstContacts(db: Db): Map<number, number> {
  const rows = db
    .prepare(
      `WITH direct_chat AS MATERIALIZED (
         SELECT c.id, (SELECT m.sent_at FROM message m WHERE m.conversation_id = c.id AND m.type != 'system' ORDER BY m.sent_at LIMIT 1) AS first
         FROM conversation c WHERE c.type = 'direct' AND c.is_marketplace = 0 AND c.dropped_at IS NULL
       ),
       direct AS (
         SELECT cm.account_id AS id, min(d.first) AS first
         FROM direct_chat d CROSS JOIN conversation_member cm ON cm.conversation_id = d.id AND cm.removed_at IS NULL
         GROUP BY cm.account_id
       ),
       account AS (
         SELECT ip.person_id AS id, coalesce(CASE WHEN s.group_count > 0 THEN (
           SELECT m.sent_at FROM message m JOIN conversation c ON c.id = m.conversation_id
           WHERE m.sender_account_id = ip.id AND m.sent_at < coalesce(d.first, 9e15) AND m.type != 'system'
             AND c.type = 'group' AND c.is_marketplace = 0 AND c.dropped_at IS NULL
           ORDER BY m.sent_at LIMIT 1
         ) END, d.first) AS first
         FROM import_person ip JOIN import_person_stats s ON s.import_person_id = ip.id LEFT JOIN direct d ON d.id = ip.id
         WHERE ip.person_id IS NOT NULL AND ip.is_self = 0 AND (s.group_count > 0 OR d.first IS NOT NULL)
       ),
       call_first AS (
         SELECT a.person_id AS id, min(c.at) AS first FROM call c JOIN import_person a ON a.id = c.import_person_id
         WHERE a.person_id IS NOT NULL AND a.is_self = 0 GROUP BY a.person_id
         UNION ALL
         SELECT coalesce(a.person_id, mc.person_id), min(mc.at) FROM manual_call mc LEFT JOIN import_person a ON a.id = mc.account_id
         WHERE coalesce(a.is_self, 0) = 0 GROUP BY coalesce(a.person_id, mc.person_id)
       )
       SELECT id, min(first) AS first FROM (SELECT * FROM account UNION ALL SELECT * FROM call_first) GROUP BY id HAVING min(first) IS NOT NULL`,
    )
    .all() as { id: number; first: number }[];
  const first = new Map(rows.map((row) => [row.id, row.first]));
  for (const row of db
    .prepare(
      `SELECT cp.person_id AS id, min(c.day || ' ' || coalesce(c.time, '00:00')) AS at
       FROM catch_up_person cp JOIN catch_up c ON c.id = cp.catch_up_id GROUP BY cp.person_id`,
    )
    .all() as { id: number; at: string }[]) {
    const at = wallClock(...(row.at.split(" ") as [string, string]));
    if (at < (first.get(row.id) ?? Infinity)) first.set(row.id, at);
  }
  return first;
}
