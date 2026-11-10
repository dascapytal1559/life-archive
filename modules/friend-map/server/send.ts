// The send executor: the one place a message is sent from. Sending is turned
// off for now (SENDING): every send is refused, and the person panel has no
// composer (src/Composer.tsx is kept, unused, for when it is back; the panel
// has a draft box in its place). Turned on, it answers the person panel's
// composer, and nothing else calls it; nothing is ever sent on its own.
//
// A send goes to a direct chat on a platform whose sync connector can send
// (Telegram, through matrix-bridge) and is connected. It is recorded in
// outgoing_message (where to, when, and how it went; never the text), handed to
// the connector as a `send` command, and finished with the connector's answer:
// sent, failed (with the platform's reason), or unconfirmed (it went to the
// bridge, which did not say in time whether the platform took it). The sent
// message then arrives through sync like any other, so it is archived once.
// A send still marked as sending when the server starts again is unconfirmed.

import { type Db, InvalidInputError, type ModuleHost, NotConnectedError, NotFoundError, type SendResult, type SendTarget, UnavailableError } from "../../../sdk/server.ts";

/** Telegram's longest text message. */
export const MAX_SEND_LENGTH = 4096;

/** Whether friend-map sends messages at all: not for now, so every send is refused (409), whatever is connected. */
export const SENDING = false;

export class SendExecutor {
  private readonly db: Db;
  private readonly host: ModuleHost;
  /** Whether this one sends: SENDING, unless a test turns it on to exercise the code kept for later. */
  sending = SENDING;

  constructor(db: Db, host: ModuleHost) {
    this.db = db;
    this.host = host;
  }

  /** Marks sends left unfinished by a server that stopped as unconfirmed. */
  recover(): number {
    return Number(
      this.db
        .prepare("UPDATE outgoing_message SET status = 'unconfirmed', finished_at = ?, error = 'the server stopped before the platform answered' WHERE status = 'sending'")
        .run(Date.now()).changes,
    );
  }

  /**
   * Where the composer in a person's panel can send: their direct chats (for
   * the captain, their chats with themselves, such as Telegram's Saved
   * Messages) on each platform a sync connector can send on, with how that
   * connector is doing.
   */
  targets(personId: number): SendTarget[] {
    const person = this.db.prepare("SELECT is_self FROM person WHERE id = ?").get(personId) as { is_self: number } | undefined;
    if (!person) throw new NotFoundError(`no person ${personId}`);
    const out: SendTarget[] = [];
    for (const { platform, connector, state } of this.host.sendingPlatforms()) {
      const chats = this.db
        .prepare(
          `SELECT c.id, c.title FROM conversation c
           WHERE c.platform = ? AND c.type = 'direct' AND c.is_marketplace = 0
             AND EXISTS (SELECT 1 FROM conversation_member cm JOIN import_person ip ON ip.id = cm.account_id
                         WHERE cm.conversation_id = c.id AND ip.person_id = ?)
             AND (? = 1) = NOT EXISTS (
               SELECT 1 FROM conversation_member cm JOIN import_person ip ON ip.id = cm.account_id
               LEFT JOIN person p ON p.id = ip.person_id
               WHERE cm.conversation_id = c.id AND ip.is_self = 0 AND coalesce(p.is_self, 0) = 0)
           ORDER BY c.id`,
        )
        .all(platform, personId, person.is_self) as { id: number; title: string | null }[];
      for (const chat of chats) out.push({ conversationId: chat.id, platform, title: chat.title, connector, state });
    }
    return out;
  }

  /** Sends `text` into a conversation and says how it went; see the top of this file. Refused while SENDING is off. */
  async send(conversationId: number, text: unknown): Promise<SendResult> {
    if (!this.sending) throw new UnavailableError("sending is turned off in friend-map for now; draft the message in their panel and send it from the app");
    if (typeof text !== "string" || text.trim() === "") throw new InvalidInputError("text must be a message to send");
    if (text.length > MAX_SEND_LENGTH) throw new InvalidInputError(`a message can be at most ${MAX_SEND_LENGTH} characters`);
    const chat = this.db.prepare("SELECT platform, platform_conversation_id AS platformId, type FROM conversation WHERE id = ?").get(conversationId) as
      { platform: string; platformId: string; type: string } | undefined;
    if (!chat) throw new NotFoundError(`no conversation ${conversationId}`);
    if (chat.type !== "direct") throw new InvalidInputError("friend-map sends only into one-to-one chats");
    const runner = this.host.sender(chat.platform);
    if (!runner) throw new InvalidInputError(`friend-map cannot send on ${chat.platform}`);
    if (runner.state.state !== "connected") throw new UnavailableError(`${runner.entry.id} is not connected (${runner.describe()})`);
    const id = Number(
      this.db
        .prepare("INSERT INTO outgoing_message (connector, conversation_id, requested_at, status) VALUES (?, ?, ?, 'sending')")
        .run(runner.entry.id, conversationId, Date.now()).lastInsertRowid,
    );
    let result: { status: SendResult["status"]; error?: string; messageId?: string };
    try {
      result = await runner.command({ command: "send", conversation: chat.platformId, text });
    } catch (error) {
      result = { status: "failed", error: error instanceof NotConnectedError ? error.message : `it could not be handed on: ${(error as Error).message}` };
    }
    this.db
      .prepare("UPDATE outgoing_message SET status = ?, finished_at = ?, error = ?, platform_message_id = ? WHERE id = ?")
      .run(result.status, Date.now(), result.error ?? null, result.messageId ?? null, id);
    return { id, status: result.status, error: result.error ?? null, messageId: result.messageId ?? null };
  }
}
