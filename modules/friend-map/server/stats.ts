// What each import person did, counted from the messages into
// import_person_stats: the one scan of every message that people and the
// automatic archive rules need, run with the rules (after an import, when the
// rules change, or when the captain's own accounts change), never at load.
//
// Counts, as the person panel and People show them:
//   direct_count       every message in a one-to-one chat with them, either way
//                      (none for the captain's own accounts)
//   group_count        what they sent in group chats
//   marketplace_count  every message in a Marketplace chat with them, apart
//   last_message_at    their last one-to-one or group message
// And for the archive rules (archiving.ts):
//   they_direct        what they sent in one-to-one chats
//   you_direct         what the captain sent in one-to-one chats they are in
//   you_direct_self_only   what he sent in those of them whose source holds
//                      only his side (conversation.is_self_only: Discord's
//                      data package), where their silence is not known
//   in_direct, in_group, in_marketplace   which kinds of chat they are in
//   in_small_group     in a small group the captain wrote in: one of
//                      SMALL_GROUP_MAX people or fewer, the captain included,
//                      where he sent at least one message (a small group he
//                      never wrote in, such as a spam group he was added to,
//                      counts as any group)
// Marketplace chats count in none but marketplace_count and in_marketplace,
// and system messages ("security code changed") and group chats the captain
// dropped (conversation.dropped_at, see People.dropGroup) in nothing. Someone
// the captain took out of a group they never wrote in
// (conversation_member.removed_at, see People.removeFromGroup) is no member of it.
//
// A group's people are its members as the imports listed them, with anyone who
// wrote in it. Every connector lists members: iMessage the chat's handles,
// WhatsApp its group member rows, Telegram the room's joined and invited
// members, X everyone its archive's joins and leaves name, Signal the group's
// members and invited members, Discord a group DM's recipients (a server
// channel names only the captain), and Messenger the participants (so someone who
// left and never wrote is missing, and a Messenger or Signal group's size may
// be a little low). A deleted or unknown account keyed on its name ("Facebook
// user" in Messenger, "Deleted User" in Discord) counts as one person, though
// it may stand for several.

import type { Db } from "../../../sdk/server.ts";

/**
 * The most people, the captain included, a group chat may have to be small:
 * the archive rules keep everyone in one the captain wrote in, and the live
 * bridges read only these
 * (see notRead in connectors/matrix-bridge/map.ts).
 */
export const SMALL_GROUP_MAX = 12;

export function refreshStats(db: Db): void {
  db.exec(`
    DELETE FROM import_person_stats;
    WITH self_account AS (
      SELECT ip.id FROM import_person ip JOIN person p ON p.id = ip.person_id WHERE ip.is_self = 1 OR p.is_self = 1
    ),
    chat AS (
      SELECT m.conversation_id AS id, count(*) AS n, max(m.sent_at) AS last,
        sum(m.is_from_self = 1 OR m.sender_account_id IN (SELECT id FROM self_account)) AS mine
      FROM message m WHERE m.type != 'system' GROUP BY m.conversation_id
    ),
    group_chat AS (SELECT id FROM conversation WHERE type = 'group' AND is_marketplace = 0 AND dropped_at IS NULL),
    group_person AS (
      SELECT cm.conversation_id, cm.account_id FROM conversation_member cm JOIN group_chat g ON g.id = cm.conversation_id
      WHERE cm.removed_at IS NULL
      UNION
      SELECT m.conversation_id, m.sender_account_id FROM message m JOIN group_chat g ON g.id = m.conversation_id
      WHERE m.sender_account_id IS NOT NULL AND m.type != 'system'
    ),
    small_group AS (
      SELECT gp.conversation_id AS id
      FROM group_person gp JOIN chat ON chat.id = gp.conversation_id AND chat.mine > 0
      WHERE gp.account_id NOT IN (SELECT id FROM self_account)
      GROUP BY gp.conversation_id
      HAVING count(*) + 1 <= ${SMALL_GROUP_MAX}
    ),
    small AS (SELECT DISTINCT gp.account_id AS id FROM group_person gp JOIN small_group sg ON sg.id = gp.conversation_id),
    member AS (
      SELECT cm.account_id AS id,
        sum(CASE WHEN c.is_marketplace = 0 AND c.type = 'direct' THEN coalesce(chat.n, 0) ELSE 0 END) AS direct_count,
        sum(CASE WHEN c.is_marketplace = 1 THEN coalesce(chat.n, 0) ELSE 0 END) AS marketplace_count,
        max(CASE WHEN c.is_marketplace = 0 AND c.type = 'direct' THEN chat.last END) AS direct_last,
        sum(CASE WHEN c.is_marketplace = 0 AND c.type = 'direct' THEN coalesce(chat.mine, 0) ELSE 0 END) AS you_direct,
        sum(CASE WHEN c.is_marketplace = 0 AND c.type = 'direct' AND c.is_self_only = 1 THEN coalesce(chat.mine, 0) ELSE 0 END) AS you_direct_self_only,
        max(c.is_marketplace = 0 AND c.type = 'direct') AS in_direct,
        max(c.is_marketplace = 0 AND c.type = 'group') AS in_group,
        max(c.is_marketplace = 1) AS in_marketplace
      FROM conversation_member cm JOIN conversation c ON c.id = cm.conversation_id AND c.dropped_at IS NULL LEFT JOIN chat ON chat.id = c.id
      WHERE cm.removed_at IS NULL
      GROUP BY cm.account_id
    ),
    sent AS (
      SELECT m.sender_account_id AS id,
        sum(c.type = 'direct') AS they_direct,
        sum(c.type = 'group') AS they_group,
        max(CASE WHEN c.type = 'group' THEN m.sent_at END) AS group_last
      FROM message m JOIN conversation c ON c.id = m.conversation_id AND c.is_marketplace = 0 AND c.dropped_at IS NULL
      WHERE m.sender_account_id IS NOT NULL AND m.type != 'system'
      GROUP BY m.sender_account_id
    )
    INSERT INTO import_person_stats (import_person_id, direct_count, group_count, marketplace_count, last_message_at,
      they_direct, you_direct, you_direct_self_only, in_direct, in_group, in_marketplace, in_small_group)
    SELECT ip.id,
      CASE WHEN ip.is_self THEN 0 ELSE coalesce(member.direct_count, 0) END,
      coalesce(sent.they_group, 0),
      CASE WHEN ip.is_self THEN 0 ELSE coalesce(member.marketplace_count, 0) END,
      nullif(max(CASE WHEN ip.is_self THEN 0 ELSE coalesce(member.direct_last, 0) END, coalesce(sent.group_last, 0)), 0),
      coalesce(sent.they_direct, 0), coalesce(member.you_direct, 0), coalesce(member.you_direct_self_only, 0),
      coalesce(member.in_direct, 0), coalesce(member.in_group, 0), coalesce(member.in_marketplace, 0),
      ip.id IN (SELECT id FROM small)
    FROM import_person ip LEFT JOIN member ON member.id = ip.id LEFT JOIN sent ON sent.id = ip.id;
  `);
}
