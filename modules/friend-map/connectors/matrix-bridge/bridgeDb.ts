// The bridge's own database, opened read-only. Every mautrix "bridgev2"
// bridge (Telegram, WhatsApp, Signal...) keeps the same tables; friend-map
// reads four, and never writes:
//   portal      which chat each room is (`mxid` -> `id`, and whether it is a
//               one-to-one chat or a WhatsApp community, a space), with what
//               the bridge knows of it (its metadata: for Telegram, its member
//               count and whether a channel is a supergroup). A room's own
//               m.bridge state says the same, except when the homeserver gave
//               two chats one room: then only the bridge's record is right.
//   message     which Matrix event is which platform message (`mxid` -> `id`,
//               `part_id`, `room_id`), and what it replies to. Most Matrix
//               events carry no platform id, so this is how a message gets
//               the id it has on the platform, the id an export of the same
//               chat (Telegram Desktop's, say) would give it.
//   user_login  the platform login the bridge holds for the captain's Matrix
//               user (its id is the captain's own platform id), or none when
//               the bridge is logged out.
//   ghost       each platform user's name as the bridge knows it.
// The WhatsApp bridge's database also holds whatsmeow's tables, of which it
// reads two, for the phone number behind a LID (WhatsApp's privacy id, by
// which the bridge keys most people and one-to-one chats):
//   whatsmeow_lid_map  (lid, pn): each LID's phone number, as far as WhatsApp
//                      has told the bridge (digits only).
//   whatsmeow_device   (jid, lid): the linked device's own phone JID and LID,
//                      so the captain's own LID is known even when the map
//                      has no row for it.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { IdLookup } from "./rig.ts";

export interface BridgedMessage {
  id: string;
  partId: string;
  roomId: string;
  replyToId: string | null;
  replyToPartId: string | null;
}

/** A chat as the bridge records it. */
export interface Portal {
  /** The chat's id: "user:777000", "chat:900000002", "channel:1000000001". */
  id: string;
  /** A one-to-one chat (or your chat with yourself). */
  direct: boolean;
  /** A space: a WhatsApp community, which holds groups and no messages of its own. */
  space: boolean;
  /** What the bridge's network keeps about the chat (see BridgeProfile). */
  metadata: Record<string, unknown>;
}

export class BridgeDb implements IdLookup {
  private readonly db: DatabaseSync;
  /** whatsmeow's LID map and device tables, in a WhatsApp bridge's database only. */
  private readonly lids: { map: StatementSync; devices: StatementSync } | null;

  constructor(file: string) {
    try {
      this.db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
      this.db.prepare("SELECT 1 FROM message LIMIT 1").get();
    } catch (error) {
      throw new Error(`the bridge's database could not be read at ${file}: ${(error as Error).message}`);
    }
    const tables = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
    this.lids = tables.has("whatsmeow_lid_map") && tables.has("whatsmeow_device")
      ? { map: this.db.prepare("SELECT pn FROM whatsmeow_lid_map WHERE lid = ?"), devices: this.db.prepare("SELECT jid, lid FROM whatsmeow_device") }
      : null;
  }

  /** The phone number behind a WhatsApp LID (both digits), if the bridge has learned it; the linked device's own LID is always known. */
  phoneOfLid(lid: string): string | null {
    if (!this.lids) return null;
    const row = this.lids.map.get(lid) as { pn: string } | undefined;
    if (row?.pn) return row.pn;
    for (const device of this.lids.devices.all() as { jid: string; lid: string | null }[]) {
      if (device.lid && userOf(device.lid) === lid) return userOf(device.jid);
    }
    return null;
  }

  /** The platform message a Matrix event is, if the bridge has recorded it (it does once the message is bridged). */
  message(eventId: string): BridgedMessage | null {
    const row = this.db
      .prepare("SELECT id, part_id, room_id, reply_to_id, reply_to_part_id FROM message WHERE mxid = ?")
      .get(eventId) as { id: string; part_id: string; room_id: string; reply_to_id: string | null; reply_to_part_id: string | null } | undefined;
    return row ? { id: row.id, partId: row.part_id, roomId: row.room_id, replyToId: row.reply_to_id, replyToPartId: row.reply_to_part_id } : null;
  }

  /** The chat a room is, if the bridge has recorded it (it does just after making the room). */
  portal(roomId: string): Portal | null {
    const row = this.db.prepare("SELECT id, room_type, metadata FROM portal WHERE mxid = ?").get(roomId) as
      { id: string; room_type: string; metadata: string | null } | undefined;
    if (!row) return null;
    let metadata: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.metadata ?? "{}");
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch {
      // Unreadable metadata is none.
    }
    return { id: row.id, direct: row.room_type === "dm", space: row.room_type === "space", metadata };
  }

  /** The captain's own platform id: their login's, or else the receiver of their direct chats (kept after a logout). */
  selfId(userMxid: string): { id: string | null; loggedIn: boolean } {
    const login = this.db.prepare("SELECT id FROM user_login WHERE user_mxid = ? ORDER BY id LIMIT 1").get(userMxid) as { id: string } | undefined;
    if (login) return { id: login.id, loggedIn: true };
    const receiver = this.db.prepare("SELECT receiver FROM portal WHERE receiver != '' GROUP BY receiver ORDER BY count(*) DESC LIMIT 1").get() as
      { receiver: string } | undefined;
    return { id: receiver?.receiver ?? null, loggedIn: false };
  }

  /** A platform user's name as the bridge knows it, if it does. */
  ghostName(id: string): string | null {
    const row = this.db.prepare("SELECT name FROM ghost WHERE id = ?").get(id) as { name: string } | undefined;
    return row?.name || null;
  }

  close(): void {
    this.db.close();
  }
}

/** The user part of a JID: "61491570737:12@s.whatsapp.net" -> "61491570737". */
function userOf(jid: string): string {
  return jid.split("@")[0].split(":")[0];
}
