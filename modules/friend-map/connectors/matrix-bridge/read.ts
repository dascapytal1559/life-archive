// The matrix-bridge connector: reads the chats a mautrix bridge writes into
// the rig's local homeserver, logged in as the captain's Matrix user, and
// sends text into them when the host asks and its manifest allows. It speaks
// only the Matrix client API (client.ts) and reads the bridge's database for
// ids (bridgeDb.ts); it holds no protocol code of its own. Each bridge is its
// own connector with its own profile (rig.ts) and Matrix device: matrix-bridge
// reads Telegram's, matrix-whatsapp WhatsApp's; each leaves the other's rooms
// and invitations alone.
//
// History walks each bridged room from its first event forward with
// /messages. Sync first describes every room (its conversation and
// accounts), walks the rooms it has not walked yet (all of them on the first
// run), then follows a long /sync, whose `next_batch` is the cursor:
//   - a checkpoint after each page of a walk and after each sync answer, so a
//     restart resumes there;
//   - a room the bridge invites the captain to (a new chat) is joined and
//     walked; a room whose sync answer leaves a gap (more came than the answer
//     holds, as while the bridge fills a chat) is read forward from the last
//     answer's token, so the gap costs what is new, not the whole room again
//     (walks are idempotent: every write is keyed on platform ids);
//   - an event the bridge has not recorded yet (it records a message just
//     after sending it to Matrix) waits, is looked at again after each sync,
//     and is dropped after two minutes (a send that failed never gets
//     recorded); waiting events go into the cursor, so a restart keeps them.
// Which chat a room is comes from the bridge's database (its portal), never
// the room's own m.bridge state alone: a bridged room the bridge has not
// recorded yet waits (looked at again after each sync answer, for up to ten
// minutes), and one it records as a group of more than twelve or a broadcast
// channel is not read at all (see notRead in map.ts), each counted once.
// Deletions are counted, not applied (the archive keeps what it has), and so
// are reactions taken back.
//
// Sending: a `send` command puts one m.room.message into the chat's room,
// then waits for the bridge's message status event (the rig's bridge has
// `matrix.message_status_events` on) to say whether the platform took it.
// The message itself then arrives through sync like any other, once.
//
// History and sync are Effects (docs/effect.md): sync runs until the
// connector's process stops it, letting a long poll go at once and finishing
// a sync answer or a room's walk, with its checkpoints, once begun.

import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Clock, Deferred, Effect, Option, Schedule } from "effect";
import { type CommandOutcome, type Connector, type ConnectorCommand, type ConnectorError, connectorError, type ConnectorManifest, type Emit, type HistoryOptions, MediaLedger, type SyncOptions, whole } from "../../../../sdk/connector.ts";
import { BridgeDb } from "./bridgeDb.ts";
import { MatrixClient, type MatrixEvent, type SyncResponse } from "./client.ts";
import {
  describeRoom,
  editedText,
  isBridgedRoom,
  isRedacted,
  mapMessage,
  notRead,
  personAccount,
  platformIds,
  relation,
  selfAccount,
  senderOf,
  type Identity,
  type Room,
  type Sender,
} from "./map.ts";
import { PROFILES, readRig, type BridgeProfile, type Rig } from "./rig.ts";

const MESSAGE_TYPES = ["m.room.message", "m.sticker", "m.reaction", "m.room.redaction"];
const STATE_TYPES = ["m.room.member", "m.room.name", "m.bridge", "uk.half-shot.bridge"];
const STATUS_TYPE = "com.beeper.message_send_status";
const WALK_PAGE = 200;
/** How long an event may wait for the bridge to record it. */
const PENDING_MAX_MS = 120_000;
const MAX_PENDING = 500;
/** How long a bridged room the bridge has not recorded as a chat yet is looked at again. */
const UNSETTLED_MAX_MS = 600_000;
const LONG_POLL_MS = 30_000;
const SEND_WAIT_MS = 60_000;
const STATE_CHECK_MS = 60_000;

const LISTING_FILTER = {
  presence: { types: [] },
  account_data: { types: [] },
  room: { timeline: { limit: 0 }, state: { types: [] }, ephemeral: { types: [] }, account_data: { types: [] } },
};
const LIVE_FILTER = {
  presence: { types: [] },
  account_data: { types: [] },
  room: {
    ephemeral: { types: [] },
    account_data: { types: [] },
    state: { types: STATE_TYPES },
    timeline: { limit: 100, types: [...MESSAGE_TYPES, STATUS_TYPE, ...STATE_TYPES] },
  },
};

export interface Cursor {
  /** The sync token to go on from. */
  since: string;
  /** Rooms still to walk, the first perhaps part-way (`from`, a /messages token). */
  walks: Array<{ room: string; from?: string }>;
  /** Events waiting for the bridge to record them. */
  pending: Array<{ room: string; event: string; seenAt: number }>;
  /** Rooms walked to the end. */
  walked: string[];
}

export function matrixBridge(manifest: ConnectorManifest, profile: BridgeProfile): Connector {
  return {
    manifest,
    history: ({ sources, config, mediaDir, emit }: HistoryOptions) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { reader, client } = yield* connected(manifest, sources, config, mediaDir, emit, profile);
          const listing = yield* whole(() => client.sync({ timeoutMs: 0, filter: LISTING_FILTER }));
          const rooms = Object.keys(listing.rooms?.join ?? {});
          let done = 0;
          for (const room of rooms) {
            yield* whole(async () => {
              if (await reader.describe(room)) await reader.walk(room, undefined, async () => {});
              await emit({ kind: "progress", done: ++done, total: rooms.length, note: "chats read" });
            });
          }
          // The bridge records a message just after it reaches Matrix: give the newest a moment.
          if (reader.waiting > 0) yield* Effect.sleep(3000);
          yield* whole(() => reader.retryPending(true));
          yield* whole(() => reader.flushTallies());
        }),
      ),

    // Until interrupted: a long poll is let go at once, and an answer begun is taken in whole, with its checkpoint.
    sync: ({ sources, config, mediaDir, emit, cursor, onCommand }: SyncOptions) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* whole(() => emit({ kind: "state", state: "connecting", detail: "logging in to the homeserver" }));
          const { reader, client, rig } = yield* connected(manifest, sources, config, mediaDir, emit, profile);
          const listing = yield* Effect.tryPromise({ try: (signal) => client.sync({ timeoutMs: 0, filter: LISTING_FILTER, signal }), catch: connectorError });
          const chats: string[] = [];
          yield* whole(async () => {
            for (const room of Object.keys(listing.rooms?.join ?? {})) if (await reader.describe(room)) chats.push(room);
          });
          // The first run walks every chat; later ones go on from where the last left off, and walk any
          // chat not walked yet. A cursor none of whose rooms exist any more is from a rig since wiped
          // (to fill its chats deeper): its sync token means nothing here, so that is a first run too.
          const saved = parseCursor(cursor);
          const wiped = saved !== null && saved.walked.length > 0 && !saved.walked.some((room) => chats.includes(room));
          const at: Cursor = saved && !wiped ? saved : { since: listing.next_batch, walks: [], pending: [], walked: [] };
          for (const room of chats) if (!at.walked.includes(room) && !at.walks.some((w) => w.room === room)) at.walks.push({ room });
          const checkpoint = async () => {
            await reader.flushTallies();
            at.pending = reader.pendingForCursor();
            await emit({ kind: "checkpoint", cursor: at });
          };
          yield* whole(async () => {
            for (const waiting of at.pending) await reader.restorePending(waiting);
            await checkpoint();
          });
          onCommand((command) => reader.send(command));

          if (at.walks.length > 0) yield* whole(() => emit({ kind: "state", state: "connecting", detail: `reading ${at.walks.length} chats' history` }));
          yield* walkAll(reader, at, checkpoint);
          let lastState = "";
          let checkedAt = 0;
          const checkState = Effect.gen(function* () {
            const now = yield* whole(() => reader.bridgeState(rig));
            checkedAt = yield* Clock.currentTimeMillis;
            if (JSON.stringify(now) === lastState) return;
            lastState = JSON.stringify(now);
            yield* whole(() => emit({ kind: "state", ...now }));
          });
          yield* checkState;

          return yield* Effect.forever(
            Effect.gen(function* () {
              const timeoutMs = reader.waiting > 0 || reader.unsettledRooms > 0 ? 2000 : LONG_POLL_MS;
              const answer = yield* Effect.tryPromise({ try: (signal) => client.sync({ since: at.since, timeoutMs, filter: LIVE_FILTER, signal }), catch: connectorError });
              yield* whole(async () => {
                at.walks.push(...(await reader.apply(answer, at.since)), ...(await reader.settle()));
                at.since = answer.next_batch;
                await reader.retryPending(false);
                await checkpoint();
              });
              yield* walkAll(reader, at, checkpoint);
              if ((yield* Clock.currentTimeMillis) - checkedAt > STATE_CHECK_MS) yield* checkState;
            }),
          );
        }),
      ),
  };
}

/** Walks each room waiting to be walked, each in whole with its checkpoints; it may be interrupted between rooms. */
const walkAll = (reader: Reader, at: Cursor, checkpoint: () => Promise<void>) =>
  Effect.gen(function* () {
    while (at.walks.length > 0) {
      yield* whole(async () => {
        const walk = at.walks[0];
        if (reader.knows(walk.room)) {
          await reader.walk(walk.room, walk.from, async (from) => {
            walk.from = from;
            await checkpoint();
          });
          if (!at.walked.includes(walk.room)) at.walked.push(walk.room);
        }
        at.walks.shift();
        await checkpoint();
      });
    }
  });

function parseCursor(value: unknown): Cursor | null {
  if (typeof value !== "object" || value === null) return null;
  const cursor = value as Partial<Cursor>;
  if (typeof cursor.since !== "string") return null;
  return {
    since: cursor.since,
    walks: Array.isArray(cursor.walks) ? cursor.walks.filter((w) => typeof w?.room === "string") : [],
    pending: Array.isArray(cursor.pending) ? cursor.pending.filter((p) => typeof p?.room === "string" && typeof p.event === "string") : [],
    walked: Array.isArray(cursor.walked) ? cursor.walked.filter((room) => typeof room === "string") : [],
  };
}

/** Logged in to the homeserver with the bridge's database open, for as long as the scope lasts. */
const connected = (manifest: ConnectorManifest, sources: string[], config: Record<string, unknown>, mediaDir: string, emit: Emit, profile: BridgeProfile) =>
  Effect.acquireRelease(whole(() => connect(manifest, sources, config, mediaDir, emit, profile)), ({ reader }) => Effect.sync(() => reader.close()));

async function connect(manifest: ConnectorManifest, sources: string[], config: Record<string, unknown>, mediaDir: string, emit: Emit, profile: BridgeProfile) {
  const rig = await readRig(sources[0], config, profile);
  const client = new MatrixClient(rig.homeserver);
  const userId = await client.login(rig.user, rig.password, profile.device);
  const db = new BridgeDb(rig.bridgeDatabase);
  const self = db.selfId(userId);
  if (!self.id) {
    db.close();
    throw new Error(`the bridge has never been logged in to ${profile.name}: log in with the rig's ${profile.loginScript} first`);
  }
  const who = { profile, userId, selfId: self.id, selfKey: profile.selfKey ?? self.id, ids: db };
  const reader = new Reader(client, db, who, emit, await MediaLedger.open(mediaDir, manifest.id), manifest, rig);
  return { rig, client, reader };
}

type Handled = "done" | "waiting";
type Status = { status: string; error: string | null };

class Reader {
  private readonly client: MatrixClient;
  private readonly db: BridgeDb;
  private readonly who: Identity;
  private readonly emit: Emit;
  private readonly ledger: MediaLedger;
  private readonly platform: string;
  /** Whether this connector may send (its manifest says). */
  private readonly canSend: boolean;
  private readonly rig: Rig;
  private readonly rooms = new Map<string, Room>();
  /** Rooms that are not chats to read: the bridge bot's management room, say, or a chat not read (see notRead). */
  private readonly ignored = new Set<string>();
  /** Bridged rooms the bridge has not recorded as chats yet, and since when. */
  private readonly unsettled = new Map<string, number>();
  /** Chats not read, each tallied once. */
  private readonly notRead = new Set<string>();
  private readonly byConversation = new Map<string, string>();
  private readonly announced = new Set<string>();
  private readonly pending = new Map<string, { room: string; event: MatrixEvent; seenAt: number }>();
  private readonly tallies = new Map<string, number>();
  private readonly statuses = new Map<string, Status>();
  private readonly statusWaiters = new Map<string, Deferred.Deferred<Status>>();

  constructor(client: MatrixClient, db: BridgeDb, who: Identity, emit: Emit, ledger: MediaLedger, manifest: ConnectorManifest, rig: Rig) {
    this.client = client;
    this.db = db;
    this.who = who;
    this.emit = emit;
    this.ledger = ledger;
    this.platform = manifest.platform;
    this.canSend = manifest.capabilities.send;
    this.rig = rig;
  }

  get waiting(): number {
    return this.pending.size;
  }

  /** Bridged rooms waiting for the bridge to record them as chats. */
  get unsettledRooms(): number {
    return this.unsettled.size;
  }

  knows(room: string): boolean {
    return this.rooms.has(room);
  }

  close(): void {
    this.db.close();
  }

  /** Reads a room's state and announces its accounts and conversation; null for a room that is not a chat to read. */
  async describe(roomId: string): Promise<Room | null> {
    const state = await this.client.roomState(roomId);
    const portal = this.db.portal(roomId);
    if (!portal) {
      // The bridge records a chat's room just after making it: a bridged room it has not recorded yet is looked at again.
      if (isBridgedRoom(state, this.who) && !this.unsettled.has(roomId)) this.unsettled.set(roomId, Date.now());
      return this.ignore(roomId);
    }
    this.unsettled.delete(roomId);
    const room = describeRoom(roomId, state, portal, this.who, (id) => this.db.ghostName(id));
    const why = notRead(room, portal, this.who.profile);
    if (why) {
      if (!this.notRead.has(portal.id)) this.tally(why);
      this.notRead.add(portal.id);
      return this.ignore(roomId);
    }
    this.ignored.delete(roomId);
    for (const account of room.accounts) {
      await this.emit(account);
      this.announced.add(account.key);
    }
    await this.emit(room.conversation);
    this.rooms.set(roomId, room);
    this.byConversation.set(room.conversation.id, roomId);
    return room;
  }

  private ignore(roomId: string): null {
    this.ignored.add(roomId);
    const room = this.rooms.get(roomId);
    if (room && this.byConversation.get(room.conversation.id) === roomId) this.byConversation.delete(room.conversation.id);
    this.rooms.delete(roomId);
    return null;
  }

  /** Looks again at bridged rooms the bridge had not recorded; returns those now chats to read, to walk. */
  async settle(): Promise<Cursor["walks"]> {
    const walks: Cursor["walks"] = [];
    for (const [roomId, since] of [...this.unsettled]) {
      if (await this.describe(roomId)) walks.push({ room: roomId });
      else if (this.unsettled.has(roomId) && Date.now() - since > UNSETTLED_MAX_MS) this.unsettled.delete(roomId);
    }
    return walks;
  }

  /** Walks a room forward from `from` (its start, without), calling `onPage` with the token after each page. */
  async walk(roomId: string, from: string | undefined, onPage: (from: string) => Promise<void>): Promise<void> {
    const room = this.rooms.get(roomId)!;
    let token = from;
    let first: number | null = null;
    let previous = new Set<string>();
    for (;;) {
      const page = await this.client.messages(roomId, { from: token, limit: WALK_PAGE, filter: { types: [...MESSAGE_TYPES, STATUS_TYPE], lazy_load_members: false } });
      const ids = new Set<string>();
      for (const event of page.chunk) {
        ids.add(event.event_id);
        // A page may begin with the event the last one ended on.
        if (previous.has(event.event_id)) continue;
        if (event.type === "m.room.message" || event.type === "m.sticker") first ??= event.origin_server_ts;
        await this.consider(roomId, event);
      }
      previous = ids;
      if (page.chunk.length === 0 || !page.end || page.end === token) break;
      token = page.end;
      await onPage(token);
    }
    if (first !== null) await this.emit({ kind: "coverage", conversation: room.conversation.id, from: first, to: Math.max(first, Date.now()) });
  }

  /** Takes in one sync answer to a sync from `since`; returns the rooms to walk (new chats, and timelines with a gap). */
  async apply(answer: SyncResponse, since: string): Promise<Cursor["walks"]> {
    const walks: Cursor["walks"] = [];
    for (const [roomId, invite] of Object.entries(answer.rooms?.invite ?? {})) {
      const inviter = this.inviter(invite.invite_state?.events ?? []);
      if (inviter !== this.who.profile) {
        // Another bridge's new chat is its own connector's to join.
        if (!inviter) this.tally("invites-not-from-the-bridge");
        continue;
      }
      await this.client.join(roomId);
      if (await this.describe(roomId)) walks.push({ room: roomId });
    }
    for (const [roomId, data] of Object.entries(answer.rooms?.join ?? {})) {
      const timeline = data.timeline?.events ?? [];
      const stateChanged = [...(data.state?.events ?? []), ...timeline].some((e) => e.state_key !== undefined && STATE_TYPES.includes(e.type));
      const known = this.rooms.has(roomId);
      if (!known && this.ignored.has(roomId) && !stateChanged) continue;
      if (!known || stateChanged) {
        if (!(await this.describe(roomId))) continue;
        if (!known) {
          walks.push({ room: roomId });
          continue;
        }
      }
      if (data.timeline?.limited) {
        // A sync token is a place in every room's timeline: read on from there.
        walks.push({ room: roomId, from: since });
        continue;
      }
      for (const event of timeline) if (event.state_key === undefined) await this.consider(roomId, event);
    }
    return walks;
  }

  /** Handles an event, or keeps it to look at again if the bridge has not recorded what it needs yet. */
  private async consider(roomId: string, event: MatrixEvent): Promise<void> {
    if ((await this.handle(roomId, event)) === "waiting") {
      if (this.pending.size >= MAX_PENDING) this.tally("not-bridged");
      else this.pending.set(event.event_id, { room: roomId, event, seenAt: Date.now() });
    }
  }

  private async handle(roomId: string, event: MatrixEvent): Promise<Handled> {
    const room = this.rooms.get(roomId);
    if (!room) return "done";
    if (event.type === STATUS_TYPE) {
      this.noteStatus(event);
      return "done";
    }
    if (event.type === "m.room.redaction") {
      this.tally("deletions-not-applied");
      return "done";
    }
    if (event.type !== "m.room.message" && event.type !== "m.sticker" && event.type !== "m.reaction") return "done";
    const sender = senderOf(event.sender, this.who);
    if (sender.kind === "other") {
      // The bridge bot's notices and anyone else who is no platform user.
      this.tally("not-from-a-platform-user");
      return "done";
    }
    if (isRedacted(event)) {
      this.tally("deleted");
      return "done";
    }
    const related = relation(event);
    if (event.type === "m.reaction") {
      if (related?.type !== "m.annotation" || !related.key) return "done";
      const target = this.db.message(related.eventId);
      if (!target) return "waiting";
      await this.announce(sender);
      await this.emit({ kind: "reaction", message: platformIds(target, this.who.profile).id, actor: sender.key, emoji: related.key, addedAt: event.origin_server_ts });
      return "done";
    }
    if (related?.type === "m.replace") {
      const target = this.db.message(related.eventId);
      if (!target) return "waiting";
      const text = editedText(event);
      if (text === null) return "done";
      await this.emit({ kind: "edit", message: platformIds(target, this.who.profile).id, text, editedAt: event.origin_server_ts });
      return "done";
    }
    const row = this.db.message(event.event_id);
    if (!row) return "waiting";
    await this.announce(sender);
    const { message, attachment } = mapMessage(event, room.conversation.id, sender, row, this.who.profile);
    await this.emit(message);
    if (attachment) {
      let stored;
      if (attachment.url) {
        const url = attachment.url;
        try {
          stored = await this.ledger.store(url, this.platform, attachment.filename, async () =>
            Readable.fromWeb((await this.client.download(url)) as NodeReadableStream<Uint8Array>));
        } catch {
          this.tally("media-not-copied");
        }
      }
      await this.emit({
        kind: "attachment",
        message: message.id,
        ordinal: 0,
        type: attachment.type,
        filename: attachment.filename,
        ...(attachment.mime ? { mime: attachment.mime } : {}),
        ...(attachment.url ? { platformAttachmentId: attachment.url } : {}),
        ...(stored ? { stored } : {}),
      });
    }
    return "done";
  }

  /** An account a message or reaction names but no room state announced (someone who has left, say). */
  private async announce(sender: Exclude<Sender, { kind: "other" }>): Promise<void> {
    if (this.announced.has(sender.key)) return;
    await this.emit(sender.kind === "self" ? selfAccount(this.who) : personAccount(sender.key, this.db.ghostName(sender.user), this.who));
    this.announced.add(sender.key);
  }

  /** Looks again at waiting events; drops those that waited too long (or all left, at the end of a history walk). */
  async retryPending(final: boolean): Promise<void> {
    for (const [id, waiting] of [...this.pending]) {
      if ((await this.handle(waiting.room, waiting.event)) === "done") this.pending.delete(id);
      else if (final || Date.now() - waiting.seenAt > PENDING_MAX_MS) {
        this.pending.delete(id);
        this.tally("not-bridged");
      }
    }
  }

  pendingForCursor(): Cursor["pending"] {
    return [...this.pending.values()].map(({ room, event, seenAt }) => ({ room, event: event.event_id, seenAt }));
  }

  async restorePending(waiting: Cursor["pending"][number]): Promise<void> {
    if (!this.rooms.has(waiting.room)) return;
    try {
      const event = await this.client.event(waiting.room, waiting.event);
      this.pending.set(event.event_id, { room: waiting.room, event, seenAt: waiting.seenAt });
    } catch {
      this.tally("not-bridged");
    }
  }

  private tally(name: string): void {
    this.tallies.set(name, (this.tallies.get(name) ?? 0) + 1);
  }

  async flushTallies(): Promise<void> {
    for (const [name, count] of this.tallies) await this.emit({ kind: "tally", name, count });
    this.tallies.clear();
  }

  /** The bridge in the rig that invited the captain (its bot or one of its ghosts), if one did. */
  private inviter(events: MatrixEvent[]): BridgeProfile | null {
    const invite = events.find((e) => e.type === "m.room.member" && e.state_key === this.who.userId);
    const localpart = invite ? /^@([^:]+):(.+)$/.exec(invite.sender) : null;
    if (!localpart || localpart[2] !== this.rig.serverName) return null;
    const bridges = [this.who.profile, ...PROFILES.filter((profile) => profile !== this.who.profile)];
    return bridges.find((profile) => localpart[1] === profile.bot || localpart[1].startsWith(profile.ghostPrefix)) ?? null;
  }

  private noteStatus(event: MatrixEvent): void {
    const target = relation(event)?.eventId;
    const status = typeof event.content.status === "string" ? event.content.status : null;
    if (!target || !status || status === "PENDING") return;
    const words = [event.content.message, event.content.error, event.content.reason].find((w) => typeof w === "string" && w) as string | undefined;
    const noted = { status, error: status === "SUCCESS" ? null : (words ?? status) };
    this.statuses.set(target, noted);
    if (this.statuses.size > 200) this.statuses.delete(this.statuses.keys().next().value!);
    const waiter = this.statusWaiters.get(target);
    if (waiter) Deferred.doneUnsafe(waiter, Effect.succeed(noted));
  }

  /** Sends one text message into a chat, and waits for the bridge to say whether the platform took it. */
  send(command: ConnectorCommand): Effect.Effect<CommandOutcome, ConnectorError> {
    return Effect.gen({ self: this }, function* () {
      if (!this.canSend) return { status: "failed", error: `friend-map does not send on ${this.who.profile.name}` } as const;
      const roomId = this.byConversation.get(command.conversation);
      if (!roomId) return { status: "failed", error: "there is no bridged room for this chat" } as const;
      const eventId = yield* whole(() => this.client.sendText(roomId, `friend-map-${command.request}`, command.text));
      const known = this.statuses.get(eventId);
      const status = known ?? Option.getOrNull(yield* this.statusOf(eventId));
      if (!status) return { status: "unconfirmed", error: `the bridge did not say within ${SEND_WAIT_MS / 1000} seconds whether it went` } as const;
      if (status.status !== "SUCCESS") return { status: "failed", error: status.error ?? status.status } as const;
      // The bridge records the message as it reports success; give it a moment.
      const row = yield* Effect.sync(() => this.db.message(eventId)).pipe(
        Effect.repeat({ schedule: Schedule.spaced(200).pipe(Schedule.upTo({ times: 9 })), until: (row) => !!row }),
      );
      return row ? { status: "sent", messageId: platformIds(row, this.who.profile).id } as const : { status: "sent" } as const;
    });
  }

  /** The bridge's word on a message sent, once it gives it, or none within SEND_WAIT_MS. */
  private statusOf(eventId: string): Effect.Effect<Option.Option<Status>> {
    const noted = Deferred.makeUnsafe<Status>();
    this.statusWaiters.set(eventId, noted);
    return Deferred.await(noted).pipe(
      Effect.timeoutOption(SEND_WAIT_MS),
      Effect.ensuring(Effect.sync(() => this.statusWaiters.delete(eventId))),
    );
  }

  /** Whether the bridge holds a platform login and answers. */
  async bridgeState(rig: Rig): Promise<{ state: "connected" | "logged-out" | "bridge-offline"; detail?: string }> {
    if (!this.db.selfId(this.who.userId).loggedIn) {
      return { state: "logged-out", detail: `the bridge has no ${this.who.profile.name} login; log in with the rig's ${this.who.profile.loginScript}` };
    }
    try {
      const response = await fetch(`${rig.bridgeUrl}/_matrix/mau/live`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      return { state: "bridge-offline", detail: `the bridge does not answer at ${rig.bridgeUrl}` };
    }
    return { state: "connected" };
  }
}
