// A made-up bridge rig for the matrix-bridge and matrix-whatsapp connectors'
// tests: a rig folder laid out as the real one is (config/tuwunel.toml, the
// captain's password in secrets/, the bridge's database in data/bridge/ for
// Telegram or data/whatsapp/ for WhatsApp), and a small homeserver on
// 127.0.0.1 that answers the Matrix client API the connector uses and plays
// the bridge's part when something is sent. Every request it gets is
// recorded, so tests can prove what the connector never asks for.
// A WhatsApp rig (`FakeRig.create(folder, "whatsapp")`) keeps its database as
// mautrix-whatsapp does: chats and people by phone JID or LID, message ids
// "<chat JID>:<sender JID>:<stanza id>", and whatsmeow's LID map and device.
// Everyone and everything in it is invented.

import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MatrixEvent } from "../connectors/matrix-bridge/client.ts";
import { WA_GROUP, WA_PEOPLE } from "./whatsapp.ts";

export const SERVER_NAME = "lab.localhost";
export const CAPTAIN = `@captain:${SERVER_NAME}`;
export const BOT = `@telegrambot:${SERVER_NAME}`;
export const PASSWORD = "sample-password";
/** The captain's own Telegram id. */
export const SELF_ID = "5550001";
export const ghost = (id: string) => `@telegram_${id}:${SERVER_NAME}`;

export const WA_BOT = `@whatsappbot:${SERVER_NAME}`;
/** The captain's own WhatsApp number and LID (digits), as the linked device knows them. */
export const WA_SELF = { phone: "61491570737", lid: "100000000000000" };
/** A WhatsApp ghost by the bridge's user id: a phone number, "lid-<n>" or "bot-<n>". */
export const waGhost = (id: string) => `@whatsapp_${id}:${SERVER_NAME}`;

export type Network = "telegram" | "whatsapp";

/** What differs between the two bridges in the rig. */
const NETWORKS = {
  telegram: { bot: BOT, ghost, database: ["data", "bridge", "mautrix-telegram.db"], selfId: SELF_ID, botName: "Telegram bridge bot" },
  whatsapp: { bot: WA_BOT, ghost: waGhost, database: ["data", "whatsapp", "mautrix-whatsapp.db"], selfId: WA_SELF.phone, botName: "WhatsApp bridge bot" },
} as const;

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
}

interface Logged {
  position: number;
  room: string;
  event: MatrixEvent;
}

export interface RoomSpec {
  /**
   * The bridge's channel id: Telegram's "user:<id>", "chat:<id>", "channel:<id>"; WhatsApp's "<phone>@s.whatsapp.net",
   * "<lid>@lid", "<id>@g.us", "<id>@newsletter"; none for a room that is no chat.
   */
  channel?: string;
  dm?: boolean;
  /** A WhatsApp community: the bridge makes it a space. */
  space?: boolean;
  name?: string;
  channelName?: string;
  /** Ghosts (by the bridge's user id) and their names; `left` for someone no longer in it. */
  members?: Array<{ id: string; name: string; left?: boolean }>;
  /** The bridge invites the captain rather than the captain being in it already. */
  invited?: boolean;
  /** The bridge's metadata for the chat; a "channel:" chat is a supergroup unless this says otherwise. */
  metadata?: Record<string, unknown>;
  /** The bridge records the room as the chat's a moment after making it, rather than at once. */
  recordedLater?: boolean;
}

export interface PostOptions {
  type?: string;
  at?: number;
  /** Whether and when the bridge records it: at once (the default), a moment later, or never. */
  bridged?: "now" | "later" | "never";
  /** The Telegram message id the bridge records; the next free one by default. */
  telegramId?: string;
  /** The WhatsApp stanza id the bridge records; a new one by default. */
  stanza?: string;
  /** The id the bridge records, whole, for a message it made up itself ("fake:..."). */
  bridgeId?: string;
  replyTo?: string;
  unsigned?: Record<string, unknown>;
}

/** What the fake bridge does with a message the captain sends: take it, refuse it, or say nothing. */
export type SendOutcome = "sent" | "refused" | "silent";

export class FakeRig {
  readonly folder: string;
  readonly network: Network;
  readonly bridgeDb: DatabaseSync;
  readonly requests: RecordedRequest[] = [];
  /** The Matrix device each login asked for. */
  readonly logins: string[] = [];
  /** What the fake bridge does with the next sends. */
  sendOutcome: SendOutcome = "sent";
  bridgeUp = true;
  /** The most events a sync answer gives a room; the rest is a gap (`limited`), as a homeserver's timeline limit makes one. */
  timelineLimit = Infinity;
  private server!: Server;
  private readonly log: Logged[] = [];
  private readonly state = new Map<string, MatrixEvent[]>();
  private readonly joined = new Set<string>();
  private readonly invites = new Map<string, MatrixEvent[]>();
  private readonly media = new Map<string, Buffer>();
  private position = 0;
  private nextEvent = 1;
  private nextTelegramId = 1000;
  private clock = Date.UTC(2026, 8, 1, 9, 0, 0);
  private readonly token = "sample-token";

  private constructor(folder: string, network: Network, bridgeDb: DatabaseSync) {
    this.folder = folder;
    this.network = network;
    this.bridgeDb = bridgeDb;
  }

  private get net() {
    return NETWORKS[this.network];
  }

  static async create(folder: string, network: Network = "telegram"): Promise<FakeRig> {
    const { database, selfId } = NETWORKS[network];
    await mkdir(join(folder, "config"), { recursive: true });
    await mkdir(join(folder, "secrets"), { recursive: true });
    await mkdir(join(folder, ...database.slice(0, -1)), { recursive: true });
    const db = new DatabaseSync(join(folder, ...database));
    // The parts of mautrix bridgev2's schema the connector reads.
    db.exec(`
      CREATE TABLE user_login (bridge_id TEXT NOT NULL, user_mxid TEXT NOT NULL, id TEXT NOT NULL, remote_name TEXT NOT NULL, metadata TEXT NOT NULL);
      CREATE TABLE portal (bridge_id TEXT NOT NULL, id TEXT NOT NULL, receiver TEXT NOT NULL, mxid TEXT, room_type TEXT NOT NULL, metadata TEXT NOT NULL);
      CREATE TABLE ghost (bridge_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, identifiers TEXT NOT NULL);
      CREATE TABLE message (
        rowid INTEGER PRIMARY KEY, bridge_id TEXT NOT NULL, id TEXT NOT NULL, part_id TEXT NOT NULL, mxid TEXT NOT NULL,
        room_id TEXT NOT NULL, room_receiver TEXT NOT NULL, sender_id TEXT NOT NULL, sender_mxid TEXT NOT NULL,
        timestamp BIGINT NOT NULL, edit_count INTEGER NOT NULL, reply_to_id TEXT, reply_to_part_id TEXT, metadata TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO user_login VALUES ('', ?, ?, 'Sample Captain', '{}')").run(CAPTAIN, selfId);
    if (network === "whatsapp") {
      // whatsmeow's tables in the same file: the LID map, and the linked device with the captain's own JID and LID.
      db.exec(`
        CREATE TABLE whatsmeow_lid_map (lid TEXT PRIMARY KEY, pn TEXT UNIQUE NOT NULL);
        CREATE TABLE whatsmeow_device (jid TEXT PRIMARY KEY, lid TEXT, registration_id BIGINT NOT NULL);
      `);
      db.prepare("INSERT INTO whatsmeow_device VALUES (?, ?, 1)").run(`${WA_SELF.phone}:12@s.whatsapp.net`, `${WA_SELF.lid}:12@lid`);
    }
    const rig = new FakeRig(folder, network, db);
    rig.server = createServer((req, res) => void rig.answer(req, res));
    await new Promise<void>((resolve) => rig.server.listen(0, "127.0.0.1", resolve));
    const port = (rig.server.address() as AddressInfo).port;
    await writeFile(
      join(folder, "config", "tuwunel.toml"),
      `[global]\nserver_name = "${SERVER_NAME}"\naddress = "127.0.0.1"\nport = ${port}\nallow_federation = false\n`,
    );
    await writeFile(join(folder, "secrets", "captain-matrix-password"), `${PASSWORD}\n`, { mode: 0o600 });
    return rig;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** The connector's settings for this rig. */
  get settings(): Record<string, unknown> {
    return { source: this.folder, bridgeUrl: this.url, healthUrl: `${this.url}/_matrix/client/versions` };
  }

  async close(): Promise<void> {
    this.bridgeDb.close();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** A room as the bridge makes one, with its m.bridge state and members (the captain joined, unless invited, by `inviter` if given). */
  addRoom(roomId: string, spec: RoomSpec & { inviter?: string }): void {
    const { bot, ghost: ghostOf, selfId, botName } = this.net;
    const state: MatrixEvent[] = [];
    const add = (type: string, stateKey: string, content: Record<string, unknown>, sender: string = bot) =>
      state.push(this.event(roomId, type, sender, content, { state_key: stateKey }));
    add("m.room.create", "", { creator: bot });
    if (spec.channel) {
      const telegram = this.network === "telegram";
      const bridge = {
        bridgebot: bot, creator: bot,
        protocol: { id: this.network, displayname: telegram ? "Telegram" : "WhatsApp" },
        channel: { id: spec.channel, ...(spec.channelName ? { displayname: spec.channelName } : {}) },
        ...(spec.dm ? { "com.beeper.room_type": "dm" } : {}),
      };
      add("m.bridge", `fi.mau.${this.network}://${this.network}/${spec.channel}`, bridge);
      add("uk.half-shot.bridge", `fi.mau.${this.network}://${this.network}/${spec.channel}`, bridge);
      const metadata = JSON.stringify(spec.metadata ?? (telegram && spec.channel.startsWith("channel:") ? { is_supergroup: true } : {}));
      // Telegram's channels and WhatsApp's groups are shared by every login; the rest are the captain's own.
      const shared = telegram ? spec.channel.startsWith("channel:") : !spec.dm;
      const record = () => this.bridgeDb.prepare("INSERT INTO portal VALUES ('', ?, ?, ?, ?, ?)")
        .run(spec.channel!, shared ? "" : selfId, roomId, spec.dm ? "dm" : spec.space ? "space" : "", metadata);
      if (spec.recordedLater) setTimeout(record, 300);
      else record();
    }
    if (spec.name) add("m.room.name", "", { name: spec.name });
    add("m.room.member", bot, { membership: "join", displayname: botName });
    for (const member of spec.members ?? []) {
      add("m.room.member", ghostOf(member.id), { membership: member.left ? "leave" : "join", displayname: member.name }, ghostOf(member.id));
      this.bridgeDb.prepare("INSERT INTO ghost VALUES ('', ?, ?, '[]')").run(member.id, member.name);
    }
    if (spec.invited) {
      this.invites.set(roomId, [this.event(roomId, "m.room.member", spec.inviter ?? bot, { membership: "invite" }, { state_key: CAPTAIN })]);
    } else {
      add("m.room.member", CAPTAIN, { membership: "join", displayname: "captain" }, CAPTAIN);
      this.joined.add(roomId);
    }
    this.state.set(roomId, state);
    for (const event of state) this.append(roomId, event);
  }

  /** Something the bridge (or someone) writes into a room; returns its event id. */
  post(roomId: string, sender: string, content: Record<string, unknown>, options: PostOptions = {}): string {
    const event = this.event(roomId, options.type ?? "m.room.message", sender, content, options.unsigned ? { unsigned: options.unsigned } : {}, options.at);
    const bridged = options.bridged ?? "now";
    if (bridged === "now") this.record(roomId, event, options);
    else if (bridged === "later") setTimeout(() => this.record(roomId, event, options), 300);
    this.append(roomId, event);
    return event.event_id;
  }

  /** WhatsApp: the bridge learns the phone number behind a LID (both digits). */
  addLid(lid: string, phone: string): void {
    this.bridgeDb.prepare("INSERT INTO whatsmeow_lid_map VALUES (?, ?)").run(lid, phone);
  }

  /** Another chat's m.bridge state in a room, first in its state, as when the homeserver gave two chats one room. */
  addClashingBridgeState(roomId: string, channel: string): void {
    const bridge = { bridgebot: BOT, creator: BOT, protocol: { id: "telegram", displayname: "Telegram" }, channel: { id: channel, displayname: "Someone else (sample)" }, "com.beeper.room_type": "dm" };
    const event = this.event(roomId, "m.bridge", BOT, bridge, { state_key: `fi.mau.telegram://telegram/${channel}` });
    this.state.set(roomId, [event, ...this.state.get(roomId)!]);
    this.append(roomId, event);
  }

  /** A room member's name or membership changing, as the bridge writes it. */
  setMember(roomId: string, id: string, name: string, membership = "join"): void {
    const member = this.net.ghost(id);
    const event = this.event(roomId, "m.room.member", member, { membership, displayname: name }, { state_key: member });
    this.state.set(roomId, [...this.state.get(roomId)!.filter((e) => !(e.type === "m.room.member" && e.state_key === member)), event]);
    this.bridgeDb.prepare("INSERT INTO ghost VALUES ('', ?, ?, '[]')").run(id, name);
    this.append(roomId, event);
  }

  /** A file the homeserver holds, at mxc://lab.localhost/<id>. */
  addMedia(id: string, bytes: Buffer): string {
    this.media.set(id, bytes);
    return `mxc://${SERVER_NAME}/${id}`;
  }

  /** The bridge's database row for an event, as the connector reads it. */
  bridged(eventId: string): { id: string; room_id: string } | undefined {
    return this.bridgeDb.prepare("SELECT id, room_id FROM message WHERE mxid = ?").get(eventId) as { id: string; room_id: string } | undefined;
  }

  /** Events the captain's user sent, by type. */
  sentByCaptain(): MatrixEvent[] {
    return this.log.filter((l) => l.event.sender === CAPTAIN && l.event.state_key === undefined).map((l) => l.event);
  }

  private record(roomId: string, event: MatrixEvent, options: PostOptions): void {
    const channel = (this.state.get(roomId) ?? []).find((e) => e.type === "m.bridge")?.content.channel as { id: string } | undefined;
    if (!channel) return;
    if (this.network === "whatsapp") return this.recordWhatsApp(channel.id, event, options);
    const own = options.telegramId ?? String(this.nextTelegramId++);
    const channelNumber = /^channel:(\d+)$/.exec(channel.id)?.[1];
    const id = channelNumber ? `${channelNumber}.${own}` : own;
    const senderId = event.sender === CAPTAIN ? SELF_ID : (/^@telegram_(\d+):/.exec(event.sender)?.[1] ?? "");
    const reply = options.replyTo ? this.bridged(options.replyTo) : undefined;
    this.bridgeDb
      .prepare(`INSERT INTO message (bridge_id, id, part_id, mxid, room_id, room_receiver, sender_id, sender_mxid, timestamp, edit_count, reply_to_id, reply_to_part_id, metadata)
        VALUES ('', ?, '', ?, ?, ?, ?, ?, ?, 0, ?, ?, '{}')`)
      .run(id, event.event_id, channel.id, channelNumber ? "" : SELF_ID, senderId, event.sender, event.origin_server_ts * 1_000_000, reply?.id ?? null, reply ? "" : null);
  }

  /** As mautrix-whatsapp records a message: "<chat JID>:<sender JID>:<stanza id>", the captain by their phone JID. */
  private recordWhatsApp(chat: string, event: MatrixEvent, options: PostOptions): void {
    const user = event.sender === CAPTAIN ? WA_SELF.phone : (/^@whatsapp_([^:]+):/.exec(event.sender)?.[1] ?? "");
    const lid = /^lid-(\d+)$/.exec(user)?.[1];
    const senderJid = lid ? `${lid}@lid` : `${user}@s.whatsapp.net`;
    const id = options.bridgeId ?? `${chat}:${senderJid}:${options.stanza ?? `3EB0${String(this.nextTelegramId++).padStart(16, "0")}`}`;
    const reply = options.replyTo ? this.bridged(options.replyTo) : undefined;
    this.bridgeDb
      .prepare(`INSERT INTO message (bridge_id, id, part_id, mxid, room_id, room_receiver, sender_id, sender_mxid, timestamp, edit_count, reply_to_id, reply_to_part_id, metadata)
        VALUES ('', ?, '', ?, ?, ?, ?, ?, ?, 0, ?, ?, '{}')`)
      .run(id, event.event_id, chat, chat.endsWith("@g.us") ? "" : WA_SELF.phone, user, event.sender, event.origin_server_ts * 1_000_000, reply?.id ?? null, reply ? "" : null);
  }

  private event(roomId: string, type: string, sender: string, content: Record<string, unknown>, extra: Partial<MatrixEvent> = {}, at?: number): MatrixEvent {
    this.clock += 60_000;
    return { event_id: `$sample${this.nextEvent++}`, room_id: roomId, type, sender, origin_server_ts: at ?? this.clock, content, ...extra };
  }

  private append(room: string, event: MatrixEvent): void {
    this.log.push({ position: ++this.position, room, event });
  }

  private async answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    this.requests.push({ method: req.method ?? "GET", path, query: Object.fromEntries(url.searchParams) });
    const body = await new Promise<string>((resolve) => {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => resolve(text));
    });
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/_matrix/mau/live") return this.bridgeUp ? send(200, {}) : send(502, {});
    if (path === "/_matrix/client/versions") return send(200, { versions: ["v1.11"] });
    if (path === "/_matrix/client/v3/login" && req.method === "POST") {
      const login = JSON.parse(body) as { identifier?: { user?: string }; password?: string; device_id?: string };
      if (login.identifier?.user !== "captain" || login.password !== PASSWORD) return send(403, { errcode: "M_FORBIDDEN", error: "Wrong username or password." });
      this.logins.push(login.device_id ?? "");
      return send(200, { access_token: this.token, user_id: CAPTAIN, device_id: login.device_id });
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { errcode: "M_MISSING_TOKEN", error: "Missing access token." });
    if (path === "/_matrix/client/v3/account/whoami") return send(200, { user_id: CAPTAIN });
    if (path === "/_matrix/client/v3/sync" && req.method === "GET") return this.sync(url, send);
    let match: RegExpExecArray | null;
    if ((match = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state$/.exec(path)) && req.method === "GET") {
      const state = this.state.get(decodeURIComponent(match[1]));
      return state ? send(200, state) : send(404, { errcode: "M_NOT_FOUND" });
    }
    if ((match = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/messages$/.exec(path)) && req.method === "GET") {
      const room = decodeURIComponent(match[1]);
      const from = Number(url.searchParams.get("from") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const types = (JSON.parse(url.searchParams.get("filter") ?? "{}") as { types?: string[] }).types;
      const chunk = this.log.filter((l) => l.room === room && l.position > from && (!types || types.includes(l.event.type))).slice(0, limit);
      return send(200, { start: String(from), chunk: chunk.map((l) => l.event), ...(chunk.length ? { end: String(chunk.at(-1)!.position) } : {}) });
    }
    if ((match = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/event\/([^/]+)$/.exec(path)) && req.method === "GET") {
      const found = this.log.find((l) => l.room === decodeURIComponent(match![1]) && l.event.event_id === decodeURIComponent(match![2]));
      return found ? send(200, found.event) : send(404, { errcode: "M_NOT_FOUND" });
    }
    if ((match = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/join$/.exec(path)) && req.method === "POST") {
      const room = decodeURIComponent(match[1]);
      if (!this.invites.delete(room)) return send(403, { errcode: "M_FORBIDDEN" });
      const joined = this.event(room, "m.room.member", CAPTAIN, { membership: "join" }, { state_key: CAPTAIN });
      this.state.get(room)!.push(joined);
      this.joined.add(room);
      this.append(room, joined);
      return send(200, { room_id: room });
    }
    if ((match = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m\.room\.message\/([^/]+)$/.exec(path)) && req.method === "PUT") {
      const room = decodeURIComponent(match[1]);
      const id = this.post(room, CAPTAIN, JSON.parse(body) as Record<string, unknown>, { bridged: "never" });
      const event = this.log.at(-1)!.event;
      // The bridge's part: send it on, record it, then say how it went.
      setTimeout(() => {
        if (this.sendOutcome === "silent") return;
        if (this.sendOutcome === "sent") this.record(room, event, {});
        this.post(room, this.net.bot, {
          "m.relates_to": { rel_type: "m.reference", event_id: id },
          network: this.network,
          status: this.sendOutcome === "sent" ? "SUCCESS" : "FAIL_PERMANENT",
          ...(this.sendOutcome === "refused" ? { reason: "m.foreign_network_error", message: "Telegram refused the message (sample)" } : {}),
        }, { type: "com.beeper.message_send_status", bridged: "never" });
      }, 100);
      return send(200, { event_id: id });
    }
    if ((match = /^\/_matrix\/client\/v1\/media\/download\/([^/]+)\/([^/]+)$/.exec(path)) && req.method === "GET") {
      const bytes = this.media.get(decodeURIComponent(match[2]));
      if (!bytes) return send(404, { errcode: "M_NOT_FOUND" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(bytes);
      return;
    }
    send(404, { errcode: "M_UNRECOGNIZED", error: "Unrecognized request" });
  }

  private async sync(url: URL, send: (status: number, value: unknown) => void): Promise<void> {
    const since = url.searchParams.get("since");
    if (since === null) {
      return send(200, {
        next_batch: String(this.position),
        rooms: {
          join: Object.fromEntries([...this.joined].map((room) => [room, { timeline: { events: [], limited: false } }])),
          invite: Object.fromEntries([...this.invites].map(([room, events]) => [room, { invite_state: { events } }])),
        },
      });
    }
    const from = Number(since);
    const deadline = Date.now() + Number(url.searchParams.get("timeout") ?? 0);
    const fresh = () => this.log.some((l) => l.position > from && this.joined.has(l.room)) || this.invites.size > 0;
    while (!fresh() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const join: Record<string, { timeline: { events: MatrixEvent[]; limited: boolean } }> = {};
    for (const l of this.log) {
      if (l.position <= from || !this.joined.has(l.room)) continue;
      (join[l.room] ??= { timeline: { events: [], limited: false } }).timeline.events.push(l.event);
    }
    for (const { timeline } of Object.values(join)) {
      if (timeline.events.length <= this.timelineLimit) continue;
      timeline.events = timeline.events.slice(-this.timelineLimit);
      timeline.limited = true;
    }
    send(200, {
      next_batch: String(this.position),
      rooms: { join, invite: Object.fromEntries([...this.invites].map(([room, events]) => [room, { invite_state: { events } }])) },
    });
  }
}

const ADA = "5550002";
const BEA = "5550003";
const CAL = "5550004";
const DM = "!dm-ada:lab.localhost";
const GROUP = "!book-club:lab.localhost";
const SUPERGROUP = "!walkers:lab.localhost";
const SAVED = "!saved:lab.localhost";
/** The sample chats' people and rooms. */
export const SAMPLE = { ADA, BEA, CAL, DM, GROUP, SUPERGROUP, SAVED };

/** Three chats and Saved Messages, with a bit of everything the connector maps. */
export function addSampleChats(rig: FakeRig): { hello: string; question: string } {
  rig.addRoom("!management:lab.localhost", { members: [] });
  rig.addRoom(DM, { channel: `user:${ADA}`, dm: true, channelName: "Ada Sample", members: [{ id: ADA, name: "Ada Sample" }] });
  rig.addRoom(GROUP, {
    channel: "chat:9990001", name: "Book club (sample)",
    members: [{ id: ADA, name: "Ada Sample" }, { id: BEA, name: "Bea Example" }, { id: CAL, name: "Deleted account 5550004", left: true }],
  });
  rig.addRoom(SUPERGROUP, { channel: "channel:1234567", name: "Sample walkers", members: [{ id: BEA, name: "Bea Example" }] });
  rig.addRoom(SAVED, { channel: `user:${SELF_ID}`, dm: true, members: [{ id: SELF_ID, name: "Sample Captain" }] });
  const hello = rig.post(DM, ghost(ADA), { msgtype: "m.text", body: "hello from Ada" }, { telegramId: "124233" });
  rig.post(DM, ghost(SELF_ID), { msgtype: "m.text", body: "hi Ada, from my phone" });
  const photo = rig.addMedia("photo1", Buffer.from("not really a jpeg"));
  rig.post(DM, ghost(ADA), { msgtype: "m.image", body: "look at this", filename: "beach.jpg", url: photo, info: { mimetype: "image/jpeg" } });
  rig.post(DM, ghost(ADA), { msgtype: "m.text", body: "* hello from Ada!", "m.new_content": { msgtype: "m.text", body: "hello from Ada!" }, "m.relates_to": { rel_type: "m.replace", event_id: hello } }, { bridged: "never" });
  rig.post(DM, ghost(SELF_ID), { "m.relates_to": { rel_type: "m.annotation", event_id: hello, key: "👍" } }, { type: "m.reaction", bridged: "never" });
  rig.post(DM, BOT, { msgtype: "m.notice", body: "a notice from the bridge" }, { bridged: "never" });
  rig.post(DM, ghost(ADA), {}, { unsigned: { redacted_because: {} }, bridged: "never" });
  const question = rig.post(GROUP, ghost(ADA), { msgtype: "m.text", body: "who has read chapter two?" });
  rig.post(GROUP, ghost(BEA), { msgtype: "m.text", body: "I have", "m.relates_to": { "m.in_reply_to": { event_id: question } } }, { replyTo: question });
  rig.post(GROUP, ghost(CAL), { msgtype: "m.text", body: "an old message from someone who left" });
  const sticker = rig.addMedia("sticker1", Buffer.from("sticker bytes"));
  rig.post(SUPERGROUP, ghost(BEA), { body: "sticker", url: sticker, info: { mimetype: "image/webp" } }, { type: "m.sticker", telegramId: "42" });
  return { hello, question };
}

// WhatsApp: the people of fixtures/whatsapp.ts, so a whatsapp-db import of that copy and this rig overlap.
const lidOf = (jid: string) => jid.split("@")[0];
const WA = {
  ada: { phone: WA_PEOPLE.ada.phone, lid: lidOf(WA_PEOPLE.ada.lid) },
  bruno: { phone: WA_PEOPLE.bruno.phone },
  cleo: { phone: WA_PEOPLE.cleo.phone },
  /** Known to the bridge only by LID, as to whatsapp-db. */
  stranger: { lid: lidOf(WA_PEOPLE.stranger.lid) },
};
const WA_ROOMS = {
  /** Ada's chat, keyed by her LID, as the bridge keys most one-to-one chats. */
  ADA: "!wa-ada:lab.localhost",
  /** Bruno's chat, keyed by his number: the bridge has not learned his LID. */
  BRUNO: "!wa-bruno:lab.localhost",
  GROUP: "!wa-climbing:lab.localhost",
  SELF: "!wa-self:lab.localhost",
};
/** The sample WhatsApp chats' people, rooms and stanza ids; the stanzas marked imported are also in fixtures/whatsapp.ts's iPhone copy. */
export const WA_SAMPLE = {
  ...WA_ROOMS,
  people: WA,
  imported: {
    adaDinner: "3A00000000000000A009", groupAda: "3A00000000000000G003", groupStranger: "3A00000000000000G005",
    adaPhoto: "3A00000000000000A003", adaContact: "3A00000000000000A011", adaUnknown: "3A00000000000000A015",
  },
  groupJid: WA_GROUP.jid,
};

/** Three chats and the captain's chat with themselves, as mautrix-whatsapp bridges them, with a bit of everything the connector maps. */
export function addWhatsAppSampleChats(rig: FakeRig): { dinner: string } {
  const at = (iso: string) => Date.parse(iso);
  rig.addLid(WA.ada.lid, WA.ada.phone);
  rig.addRoom("!wa-management:lab.localhost", { members: [] });
  rig.addRoom(WA_ROOMS.ADA, { channel: `${WA.ada.lid}@lid`, dm: true, channelName: "Ada Sample", members: [{ id: `lid-${WA.ada.lid}`, name: "Ada Sample" }] });
  // The bridge knows Bruno only by his number, so that is the name it gives him.
  rig.addRoom(WA_ROOMS.BRUNO, { channel: `${WA.bruno.phone}@s.whatsapp.net`, dm: true, members: [{ id: WA.bruno.phone, name: "+61 491 571 491" }] });
  rig.addRoom(WA_ROOMS.GROUP, {
    channel: WA_GROUP.jid, name: WA_GROUP.title,
    members: [
      { id: `lid-${WA.ada.lid}`, name: "Ada Sample" }, { id: WA.cleo.phone, name: "Cleo Example" },
      { id: `lid-${WA.stranger.lid}`, name: "WhatsApp user" }, { id: `lid-${WA_SELF.lid}`, name: "Sample Captain" },
    ],
  });
  rig.addRoom(WA_ROOMS.SELF, { channel: `${WA_SELF.phone}@s.whatsapp.net`, dm: true, members: [{ id: WA_SELF.phone, name: "Sample Captain" }] });

  const dinner = rig.post(WA_ROOMS.ADA, waGhost(`lid-${WA.ada.lid}`), { msgtype: "m.text", body: "Dinner at mine next week?" },
    { stanza: WA_SAMPLE.imported.adaDinner, at: at("2026-09-20T19:30:00+10:00") });
  // The captain from their phone, under their own LID.
  rig.post(WA_ROOMS.ADA, waGhost(`lid-${WA_SELF.lid}`), { msgtype: "m.text", body: "Yes please, Thursday?" }, { stanza: "3A00000000000000L001", replyTo: dinner });
  const photo = rig.addMedia("wa-photo1", Buffer.from("not really a jpeg either"));
  rig.post(WA_ROOMS.ADA, waGhost(`lid-${WA.ada.lid}`), { msgtype: "m.image", body: "the view", filename: "view.jpg", url: photo, info: { mimetype: "image/jpeg" } },
    { stanza: "3A00000000000000L002" });
  rig.post(WA_ROOMS.ADA, waGhost(`lid-${WA.ada.lid}`), { msgtype: "m.text", body: "* Dinner at mine on Thursday?", "m.new_content": { msgtype: "m.text", body: "Dinner at mine on Thursday?" }, "m.relates_to": { rel_type: "m.replace", event_id: dinner } }, { bridged: "never" });
  // The captain reacts from their phone, under their number.
  rig.post(WA_ROOMS.ADA, waGhost(WA_SELF.phone), { "m.relates_to": { rel_type: "m.annotation", event_id: dinner, key: "❤️" } }, { type: "m.reaction", bridged: "never" });
  // A call: the bridge writes a notice of its own, with an id it made up.
  rig.post(WA_ROOMS.ADA, waGhost(`lid-${WA.ada.lid}`), { msgtype: "m.text", body: "Incoming voice call. Use the WhatsApp app to answer." },
    { bridgeId: `fake:${WA.ada.lid}@lid:${WA.ada.lid}@lid:call-SAMPLE1` });
  rig.post(WA_ROOMS.ADA, waGhost(`lid-${WA.ada.lid}`), {}, { unsigned: { redacted_because: {} }, bridged: "never" });

  rig.post(WA_ROOMS.BRUNO, waGhost(WA.bruno.phone), { msgtype: "m.text", body: "Coffee on Friday instead?" }, { stanza: "3A00000000000000L003" });

  rig.post(WA_ROOMS.GROUP, waGhost(`lid-${WA.ada.lid}`), { msgtype: "m.text", body: "Me too." }, { stanza: WA_SAMPLE.imported.groupAda, at: at("2026-08-01T09:06:00+10:00") });
  rig.post(WA_ROOMS.GROUP, waGhost(`lid-${WA.stranger.lid}`), { msgtype: "m.text", body: "Who is this?" }, { stanza: WA_SAMPLE.imported.groupStranger, at: at("2026-08-01T09:12:00+10:00") });
  rig.post(WA_ROOMS.GROUP, waGhost(WA.cleo.phone), { msgtype: "m.text", body: "Same crag Sunday?" }, { stanza: "3A00000000000000L004" });

  rig.post(WA_ROOMS.SELF, waGhost(WA_SELF.phone), { msgtype: "m.text", body: "note to self" }, { stanza: "3A00000000000000L005" });

  // What the bridge writes in place of what it cannot bridge, for messages the made-up import also has: a photo whose file
  // WhatsApp no longer has (the notice carries the message it would have been), a contact card, and an unsupported message.
  rig.post(WA_ROOMS.ADA, waGhost(`lid-${WA.ada.lid}`), {
    msgtype: "m.notice", body: "Media is no longer available (sample)",
    "fi.mau.whatsapp.failed_media": { type: "image", content: { msgtype: "m.image", body: "The crag", filename: "crag-view.jpg", info: { mimetype: "image/jpeg" } } },
  }, { stanza: WA_SAMPLE.imported.adaPhoto, at: at("2025-10-05T18:02:00+11:00") });
  const card = rig.addMedia("wa-card1", Buffer.from("BEGIN:VCARD (sample)"));
  rig.post(WA_ROOMS.ADA, waGhost(`lid-${WA.ada.lid}`), {
    msgtype: "m.file", body: "Bruno Placeholder.vcf", filename: "Bruno Placeholder.vcf", url: card, info: { mimetype: "text/vcard" },
  }, { stanza: WA_SAMPLE.imported.adaContact, at: at("2026-09-21T09:05:00+10:00") });
  rig.post(WA_ROOMS.ADA, waGhost(`lid-${WA.ada.lid}`), { msgtype: "m.notice", body: "Unsupported message (sample)" },
    { stanza: WA_SAMPLE.imported.adaUnknown, at: at("2026-09-21T09:25:00+10:00") });
  return { dinner };
}
