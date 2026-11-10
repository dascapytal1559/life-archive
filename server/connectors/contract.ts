// The contract between the archive host and a connector.
//
// A connector reads one platform's source (an export file, an app's own
// database, or a live service such as the bridge rig) in its own child process
// and writes one JSON event per line to stdout. It never opens the archive
// database, never reads friend files, and never talks to another connector;
// the host validates every event and owns every write. Events carry no
// platform field: the manifest names it.
//
// It runs in one of two modes:
//   history  reads the source once; the host applies everything it wrote in
//            one transaction when it exits cleanly.
//   sync     runs until stopped, writing batches: the events of a batch are
//            applied in one transaction when the connector ends it with a
//            `checkpoint`, whose cursor the host stores with it and hands back
//            (--cursor) when the connector next starts, so it resumes after
//            the last batch applied. A sync connector also says how its
//            connection is (`state`), and takes commands from the host on
//            stdin, one JSON object per line (`send`, see ConnectorCommand),
//            answering each with a `send-result`. Only the server's send
//            executor issues commands; a connector never sends on its own.
//
// Accounts are referred to by `key`, the strongest identity the platform
// offers: a WhatsApp JID (`keyKind: "id"`), or a Messenger display name
// (`keyKind: "name"`) when the export has nothing better. Conversations and
// messages are referred to by their platform ids (or synthetic ids, see
// `idKind`). Calls in no chat (`call`: the phone's call history, and an app's
// call with several people made in no group chat) are kept apart from
// messages: each names the accounts of the people on it, and no conversation.
//
// A connector whose source is no chat platform (an LLM's session files) feeds
// the event index instead (archive/events.ts): its manifest's `platform` is
// its origin (`claude-code`, `grok-bot`), and it writes `device`, `llm-session` and
// `llm-turn` events, which carry times, sizes and where the content is in the
// source, never the content itself. A workout source (the polar connector, origin `polar`; Strava's or Garmin's export later)
// writes `workout` events: one for each copy of an activity it keeps, with what the copy holds (which sample streams,
// how many, how often) and where the copy is, never a heart rate or a coordinate. (The rituals are no connector's any
// more: the rituals module reads its own store, modules/rituals.)
//
// A connector runs in its own process, whose edge is runtime.ts. Sync is an
// Effect (docs/effect.md) that runs until the host stops the connector, when
// the edge interrupts it: work that must finish once begun (a batch and its
// checkpoint) it makes uninterruptible (`whole`). A history import is a
// promise, or an Effect for a connector written in Effect; the edge runs either.

import { Data, Effect } from "effect";

export const PLATFORMS = ["messenger", "instagram", "whatsapp", "imessage", "telegram", "x", "signal", "discord", "wechat", "phone"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Where an event comes from: a chat platform, or a source of the event index that is none (see the top of this file). */
export const ORIGINS = [...PLATFORMS, "claude-code", "grok-bot", "polar"] as const;
export type Origin = (typeof ORIGINS)[number];

export function isPlatform(origin: string): origin is Platform {
  return (PLATFORMS as readonly string[]).includes(origin);
}

export const MESSAGE_TYPES = [
  "text", "media", "link", "sticker", "call", "location", "contact", "system", "other",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const ATTACHMENT_TYPES = ["image", "video", "audio", "gif", "sticker", "file"] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

export interface ConnectorManifest {
  id: string;
  /** What it is, in a few words, for the Events page's Sources tab ("Telegram, live through the bridge rig"). */
  label: string;
  /** The chat platform it reads, or for a source of the event index that is none, its origin. */
  platform: Origin;
  /** How often a sync connector looks while the server runs it (the Sources tab's "how often"); none for the rest. */
  cadence?: LiveCadence;
  /** What it reads: an export file, an app's own database, or a live service (see `companion`). */
  sourceKind: "export" | "app-db" | "live";
  capabilities: { history: boolean; sync: boolean; send: boolean };
  needs: Array<"export-file" | "full-disk-access" | "app-data-access" | "app-running" | "companion">;
  /** One line for people reading `npm run archive -- connectors`. */
  description: string;
  /** Where a history import (or sync) reads from when none is named, if the connector has a usual place. */
  defaultSource?: string;
  /**
   * A service that runs beside friend-map and that this connector reads, such
   * as the bridge rig. The host starts sync only while `healthUrl` answers
   * (the connector's `healthUrl` setting can name another), and otherwise
   * waits quietly, looking again now and then.
   */
  companion?: { name: string; healthUrl: string };
  /**
   * How the captain gets a fresh source to import, for `npm run archive -- import-status`; every
   * history connector has one, and its section in docs/import-runbook.md, headed by its id, has the
   * steps. A live connector has none: there is nothing to fetch.
   */
  obtain?: ObtainStep;
  /**
   * Whether it keeps the archive's own copies of the files it reads (an LLM's session files, which their app deletes
   * after a while; see sessionCopies.ts): the host then hands it data/llm/<platform>/ as `copiesDir`.
   */
  keepsCopies?: boolean;
  /** What its source says of calls. */
  calls: CallsInSource;
  /**
   * How it treats end-to-end-encrypted chats, in a few words: which it reads and which it
   * cannot. Null where the source holds no chats (the phone's calls).
   */
  encrypted: string | null;
}

/**
 * How often a sync connector looks: as files change (a watcher), as messages come (a stream it keeps open), or every
 * so many milliseconds, which the connector's settings may set in hours under `settingHours` (data/connectors/<id>.json).
 */
export type LiveCadence =
  | { as: "files-change" }
  | { as: "messages-come" }
  | { everyMs: number; settingHours?: string };

export interface CallsInSource {
  /**
   * Whether its call records say how long each call was connected: "all"; "some", the rest being calls of no known
   * length, which the captain can give one (Add length, in a one-to-one chat); "none"; or null when it brings no
   * call records at all.
   */
  lengths: "all" | "some" | "none" | null;
  /** How, in a few words. */
  how: string;
}

export interface ObtainStep {
  /**
   * Where a fresh copy comes from: an app's own database on this Mac, a local iPhone backup, or the
   * platform itself, which sends its own export when asked (after minutes, hours or days).
   */
  from: "mac" | "iphone-backup" | "platform";
  /**
   * The first thing to do, as an instruction in a few words. `{since}` stands for the last day its
   * imports reach ("the start" before the first), where the step can be limited to what came after it
   * (an export's date range, or the files newer than it): `request ... in JSON, from {since}`.
   */
  step: string;
}

export interface AccountEvent {
  kind: "account";
  key: string;
  keyKind: "id" | "name";
  displayName: string;
  /**
   * Where the connector found the name, when it can say, as a short word of its
   * own: "addressBook", "chat", "pushName", "member", "export", "phone",
   * "email", "handle", "settings", or "none" (a placeholder such as "WhatsApp user").
   */
  nameSource?: string;
  /** Phone number in E.164 (`+61...`), email or username. */
  handle?: string;
  isSelf?: boolean;
  /** Only for adding the account when the archive has none; one it has is left as it is (see MessageEvent.fallback). */
  fallback?: boolean;
}

export interface ConversationEvent {
  kind: "conversation";
  id: string;
  type: "direct" | "group";
  title?: string;
  /** Account keys, the captain's own included. */
  members: string[];
  /** A chat about something for sale on Facebook Marketplace; the archive leaves these out of counts and timelines by default. */
  marketplace?: boolean;
  /**
   * The source holds only the captain's own messages in this chat (Discord's
   * data package), so whether anyone else wrote in it is not known: the archive
   * rules never read their silence in it as one-sided (see archiving.ts).
   */
  selfOnly?: boolean;
  /** Only for adding the chat when the archive has none: one it has keeps its kind and title, and gains any members named. */
  fallback?: boolean;
}

export interface MessageEvent {
  kind: "message";
  id: string;
  /** "synthetic" when the platform gives messages no id and the connector derived one from the content. */
  idKind: "platform" | "synthetic";
  conversation: string;
  /** Account key; null only for system events that no person sent. */
  sender: string | null;
  isFromSelf: boolean;
  /** Milliseconds since the epoch. */
  sentAt: number;
  type: MessageType;
  text?: string;
  /** Retracted by its sender; carries no text. */
  unsent?: boolean;
  editedAt?: number;
  /** Platform id of the message this one replies to. */
  replyTo?: string;
  /**
   * A call record's (type "call") length, when the source says how long the call was connected: whole seconds, 0
   * for one never answered. Absent when the source does not say (and for anything not a call).
   */
  callSeconds?: number;
  /**
   * A lesser record that only stands in for the message's own, which this source lacks (a WhatsApp call only the
   * Calls tab lists, whose own record is in a chat): it adds the message when the archive has none, and changes one
   * it has only by giving a call record a length it had none of.
   */
  fallback?: boolean;
  /** The original record, so a better mapping can be replayed later without the source. */
  raw: unknown;
}

export interface ReactionEvent {
  kind: "reaction";
  message: string;
  actor: string;
  emoji: string;
  addedAt?: number;
}

export interface AttachmentEvent {
  kind: "attachment";
  message: string;
  /** Position among the message's attachments; with the message it identifies the attachment. */
  ordinal: number;
  type: AttachmentType;
  filename?: string;
  mime?: string;
  platformAttachmentId?: string;
  /** The copy in the platform's live folder (media with no export behind them); absent when the source did not have the file, or it is kept in place. */
  stored?: StoredMedia;
  /** The file itself, kept where it is in an export unpacked under data/platform-exports/ (never with stored). */
  inPlace?: InPlaceMedia;
}

export interface InPlaceMedia {
  sha256: string;
  size: number;
  /** Absolute; the archive refuses a file outside data/platform-exports/. */
  path: string;
}

export interface StoredMedia {
  sha256: string;
  size: number;
  /** Relative to data/platform-exports: <platform>/live/<xx>/<sha256>.<ext>. */
  path: string;
}

/** Over what a call was: a phone call or FaceTime, from the phone's call history, or an app's voice or video call. */
export const CALL_SERVICES = ["phone", "facetime-audio", "facetime-video", "voice", "video"] as const;
export type CallService = (typeof CALL_SERVICES)[number];

/**
 * A call in no chat: one with one other party, from a phone's call history, or an app's call with several people
 * made in no group chat (a WhatsApp three-way call): when, how long, which way, whether it was answered, over what,
 * and who was on it. Kept apart from messages: it has no conversation and no content.
 */
export interface CallEvent {
  kind: "call";
  /** The source's own id for the call, so a newer copy of the history adds only new calls. */
  id: string;
  /** The other party's account key; on a call with several people, the first of them the source names. */
  with: string;
  /** On a call with several people, the rest of those the source names, each by account key, once (never `with`). */
  alsoWith?: string[];
  /** How many more were on it whom the source cannot name (it knows no account of theirs): counted, never named. */
  others?: number;
  /** When it started, in milliseconds since the epoch. */
  at: number;
  /**
   * How long it was connected, in whole seconds; 0 for one never answered. Absent when the source does not say (one
   * answered on another of the captain's devices, which alone knows).
   */
  durationSeconds?: number;
  direction: "incoming" | "outgoing";
  /** Connected: picked up when it came in, or answered at the other end (which a voicemail is too) when it went out. */
  answered: boolean;
  service: CallService;
  /** The original record, without its binary fields. */
  raw: unknown;
}

export const DEVICE_KINDS = ["computer", "phone", "other"] as const;

/** The device something happened on (this Mac, the phone), announced before an event names it. */
export interface DeviceEvent {
  kind: "device";
  /** The connector's name for it, the same every import: `computer:<host name>`. */
  key: string;
  name: string;
  deviceKind: (typeof DEVICE_KINDS)[number];
}

/**
 * One conversation with an LLM, as its tool keeps it in a session file. Its
 * content stays in that file: the event says where, never what.
 */
export interface LlmSessionEvent {
  kind: "llm-session";
  /** The tool's own id for the session, the same every import. */
  id: string;
  /**
   * How it was run, in the tool's word: Claude Code's `cli` (a terminal) or `claude-desktop`; for Grok Bot, the
   * surface: `chat` (the chat window), `call` (a call's transcript) or `backstage` (the bot's talk with a call).
   */
  entrypoint: string;
  /** The device's key, from a device event. */
  device?: string;
  /** The folder it ran in, absolute; for an agent that runs in none (Grok Bot), the bot's name. */
  project: string;
  /** The archive's copy of its conversation, absolute: where its content is. */
  file: string;
  /** The tool's version, as the session last wrote it. */
  version?: string;
  /** The model most of its replies came from. */
  model?: string;
  /** Its first and last entries, in milliseconds since the epoch. */
  startedAt: number;
  endedAt: number;
  /** The bytes of the file read: its whole lines. */
  bytes: number;
}

/**
 * One turn of a session: a prompt the captain wrote, or the reply the LLM
 * gave to what started its turn (a prompt, or a notification its tool passed
 * on). Never its text: how long it is, and where in the session file its
 * lines are, so the content path can read it there.
 */
export interface LlmTurnEvent {
  kind: "llm-turn";
  /** The tool's own id for the turn's first line, the same every import. */
  id: string;
  /** The session's id, from an llm-session event. */
  session: string;
  role: "prompt" | "reply";
  /** A reply: what started its turn, in the tool's word (`human` for the captain's prompt, `task-notification`, ...). */
  answers?: string;
  /** A reply to a prompt: the prompt's id. */
  replyTo?: string;
  /** When it was written; a reply's first and last lines. */
  at: number;
  endAt?: number;
  /** The model that wrote the reply (for a prompt, the one that answered it). */
  model?: string;
  /** How long its text is, in characters. */
  chars: number;
  /** Pictures in a prompt. */
  images?: number;
  /** Tools a reply used on its way. */
  toolCalls?: number;
  /** Its first line in the session file, from 1, and where its lines are, in bytes. */
  line: number;
  offset: number;
  length: number;
}

/** Families of sport that the same activity keeps in any source, so its copies can be matched (modules/exercise/server/workouts.ts). */
export const SPORT_FAMILIES = ["run", "walk", "ride", "swim", "other"] as const;
export type SportFamily = (typeof SPORT_FAMILIES)[number];

/** The sample streams a workout's copy can hold. */
export const WORKOUT_STREAMS = ["heartRate", "rr", "gps", "speed", "distance", "cadence", "altitude", "power", "temperature"] as const;
export type WorkoutStream = (typeof WORKOUT_STREAMS)[number];

/** One stream a copy holds: how many samples (a sensor's gaps not counted) and how often, in seconds (null when it has no fixed rate, as RR intervals). */
export interface StreamInfo {
  samples: number;
  everySeconds: number | null;
}

/**
 * One source's copy of a workout (a run, a ride): when, what sport, how far, what recorded it, and which sample
 * streams its copy holds, never their values: a heart rate or a coordinate stays in the copy, which `file` names.
 * Every source of workouts (a hardware maker's connection, an aggregator's export) writes the same shape, so its copies
 * are matched and chosen between alike (modules/exercise/server/workouts.ts).
 */
export interface WorkoutEvent {
  kind: "workout";
  /** The source's own id for it, the same every import (Polar's exercise id). */
  id: string;
  /** The sport in the source's own word (Polar's RUNNING). */
  sport: string;
  /** Its family, which copies of one activity share in every source. */
  family: SportFamily;
  /** When it started and ended, in milliseconds since the epoch. */
  at: number;
  endAt: number;
  /** How far, in metres, when the source says. */
  distanceMeters?: number;
  /** What recorded it, in the source's word ("Polar Flow app", a watch's name), when the source says. */
  recorder?: string;
  /** The streams its copy holds; one it lacks is absent. */
  streams: Partial<Record<WorkoutStream, StreamInfo>>;
  /** The archive's copy of it, absolute: where its content is. */
  file: string;
  /** The source's own recording beside it (a FIT file), absolute, when kept. */
  rawFile?: string;
  /** The bytes of the copy. */
  bytes: number;
}

/** What the source claims to cover, so gaps can be computed. No conversation means the whole platform. */
export interface CoverageEvent {
  kind: "coverage";
  conversation?: string;
  from: number;
  to: number;
}

/** A count the connector keeps itself, such as records it skipped and why. Names only, never content. */
export interface TallyEvent {
  kind: "tally";
  name: string;
  count: number;
}

export interface ProgressEvent {
  kind: "progress";
  done: number;
  total?: number;
  note?: string;
}

/** A message's text changed after it was sent: live sources see an edit as an event of its own. */
export interface EditEvent {
  kind: "edit";
  message: string;
  text: string;
  editedAt: number;
}

/** Sync mode only: ends a batch. The host applies the batch and stores `cursor` (any JSON) in one transaction. */
export interface CheckpointEvent {
  kind: "checkpoint";
  cursor: unknown;
}

export const CONNECTION_STATES = ["connecting", "connected", "logged-out", "bridge-offline", "error"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** Sync mode only: how the connection to the platform is, written whenever it changes. */
export interface StateEvent {
  kind: "state";
  state: ConnectionState;
  /** A short reason, in words that never quote message content. */
  detail?: string;
}

/** Sync mode only: the answer to a command. */
export interface SendResultEvent {
  kind: "send-result";
  /** The command's `request`. */
  request: string;
  /** "unconfirmed": handed on, but the platform did not say in time whether it went. */
  status: "sent" | "failed" | "unconfirmed";
  /** The sent message's platform id, when known. */
  messageId?: string;
  error?: string;
}

/** What goes into the archive. */
export type ArchiveEvent =
  | AccountEvent
  | ConversationEvent
  | MessageEvent
  | ReactionEvent
  | AttachmentEvent
  | EditEvent
  | CallEvent
  | DeviceEvent
  | LlmSessionEvent
  | LlmTurnEvent
  | WorkoutEvent
  | CoverageEvent
  | TallyEvent
  | ProgressEvent;

/** What only a sync connector writes: never archive data, handled by the host as it arrives. */
export type SyncEvent = CheckpointEvent | StateEvent | SendResultEvent;

export type ConnectorEvent = ArchiveEvent | SyncEvent;

export function isSyncEvent(event: ConnectorEvent): event is SyncEvent {
  return event.kind === "checkpoint" || event.kind === "state" || event.kind === "send-result";
}

export type Emit = (event: ConnectorEvent) => Promise<void>;

/**
 * What the host asks of a sync connector, one per line on its stdin. Only
 * `send` exists so far; edit, delete and react are to come, each answered
 * the same way. `request` is the host's id for it, echoed in the result.
 */
export type ConnectorCommand = SendCommand;

export interface SendCommand {
  command: "send";
  request: string;
  /** The conversation's platform id, as the connector gave it. */
  conversation: string;
  text: string;
}

/** What a connector's command handler answers; the runtime writes it as the command's `send-result`. */
export interface CommandOutcome {
  status: SendResultEvent["status"];
  messageId?: string;
  error?: string;
}

export interface HistoryOptions {
  /** What to read: an export file or app data folder, or several files that together are one export (the parts of a split download). */
  sources: string[];
  /** The connector's settings from data/connectors/<id>.json. */
  config: Record<string, unknown>;
  /** data/platform-exports: a live connector copies media into <platform>/live/ there by content hash (storeMedia); an export keeps its media in place (keepInPlace; see media.ts). */
  mediaDir: string;
  /** data/llm/<platform>, for a connector that keeps copies of its source's files (`keepsCopies`), and only for one. */
  copiesDir?: string;
  emit: Emit;
}

export interface SyncOptions extends HistoryOptions {
  /** The cursor of the last batch the host applied, or null on the first run. */
  cursor: unknown;
  /**
   * Sets what runs each command from the host. Its outcome, or the message of
   * how it failed, becomes the command's `send-result`; a command that
   * arrives before there is a handler is refused.
   */
  onCommand(handler: (command: ConnectorCommand) => Effect.Effect<CommandOutcome, Error>): void;
}

/**
 * A connector does what its manifest's capabilities say: `history` for history, `sync` for sync and send.
 * Sync runs until it is interrupted (the host stopping it; see the top of this file). What either fails with is a
 * tagged error (ConnectorError, say), whose message the host keeps as the connector's error.
 */
export interface Connector {
  manifest: ConnectorManifest;
  history?(options: HistoryOptions): Promise<void> | Effect.Effect<void, Error>;
  sync?(options: SyncOptions): Effect.Effect<void, Error>;
}

/** Why a connector's run failed, in words for the host's log that never quote content. */
export class ConnectorError extends Data.TaggedError("ConnectorError")<{ readonly message: string }> {}

/** What went wrong, as a ConnectorError. */
export const connectorError = (cause: unknown): ConnectorError =>
  new ConnectorError({ message: cause instanceof Error ? cause.message : String(cause) });

/** A step of a connector's work that returns a promise, as an Effect that finishes once begun; its rejection is a ConnectorError. */
export const whole = <A>(work: () => Promise<A>): Effect.Effect<A, ConnectorError> =>
  Effect.uninterruptible(Effect.tryPromise({ try: work, catch: connectorError }));

/**
 * Checks an event from a connector. Returns what is wrong in words that name
 * fields but never quote their values, since values can be message content.
 */
export function validateEvent(value: unknown): { event: ConnectorEvent } | { error: string } {
  if (!isObject(value)) return { error: "is not a JSON object" };
  const check = CHECKS[value.kind as ConnectorEvent["kind"]];
  if (!check) return { error: "has an unknown kind" };
  const problem = check(value);
  return problem ? { error: `(${String(value.kind)}) ${problem}` } : { event: value as unknown as ConnectorEvent };
}

type Check = (event: Record<string, unknown>) => string | null;

const CHECKS: Record<ConnectorEvent["kind"], Check> = {
  account: (e) =>
    text(e, "key") ?? oneOf(e, "keyKind", ["id", "name"]) ?? text(e, "displayName", { empty: true }) ??
    optional(e, "nameSource", text) ?? optional(e, "handle", text) ?? optional(e, "isSelf", bool) ?? optional(e, "fallback", bool),
  conversation: (e) =>
    text(e, "id") ?? oneOf(e, "type", ["direct", "group"]) ?? optional(e, "title", (e, k) => text(e, k, { empty: true })) ??
    (Array.isArray(e.members) && e.members.every((m) => typeof m === "string" && m !== "")
      ? null
      : "members must be a list of account keys") ?? optional(e, "marketplace", bool) ?? optional(e, "selfOnly", bool) ??
    optional(e, "fallback", bool),
  message: (e) =>
    text(e, "id") ?? oneOf(e, "idKind", ["platform", "synthetic"]) ?? text(e, "conversation") ??
    (e.sender === null ? null : text(e, "sender")) ?? bool(e, "isFromSelf") ?? time(e, "sentAt") ??
    oneOf(e, "type", MESSAGE_TYPES) ?? optional(e, "text", (e, k) => text(e, k, { empty: true })) ??
    optional(e, "unsent", bool) ?? optional(e, "editedAt", time) ?? optional(e, "replyTo", text) ??
    optional(e, "callSeconds", count) ?? optional(e, "fallback", bool) ?? ("raw" in e ? null : "raw is missing"),
  reaction: (e) => text(e, "message") ?? text(e, "actor") ?? text(e, "emoji") ?? optional(e, "addedAt", time),
  attachment: (e) =>
    text(e, "message") ?? count(e, "ordinal") ?? oneOf(e, "type", ATTACHMENT_TYPES) ??
    optional(e, "filename", text) ?? optional(e, "mime", text) ?? optional(e, "platformAttachmentId", text) ??
    optional(e, "stored", (e, k) => {
      const stored = e[k];
      if (!isObject(stored)) return `${k} must be an object`;
      if (typeof stored.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(stored.sha256)) return `${k}.sha256 must be a sha256 hex digest`;
      if (typeof stored.path !== "string" || stored.path.startsWith("/") || stored.path.split("/").includes("..")) {
        return `${k}.path must be a path inside the media folder`;
      }
      return count(stored, "size");
    }) ??
    optional(e, "inPlace", (e, k) => {
      const file = e[k];
      if (!isObject(file)) return `${k} must be an object`;
      if (e.stored !== undefined) return `an attachment is stored or in place, not both`;
      if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) return `${k}.sha256 must be a sha256 hex digest`;
      if (typeof file.path !== "string" || !file.path.startsWith("/")) return `${k}.path must be an absolute path`;
      return count(file, "size");
    }),
  call: (e) =>
    text(e, "id") ?? text(e, "with") ??
    optional(e, "alsoWith", (e, k) => {
      const keys = e[k];
      if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string" && key !== "")) return `${k} must be a list of account keys`;
      return new Set([e.with, ...keys]).size === keys.length + 1 ? null : `${k} must name each account once, and not with's`;
    }) ??
    optional(e, "others", count) ?? time(e, "at") ?? optional(e, "durationSeconds", count) ??
    oneOf(e, "direction", ["incoming", "outgoing"]) ?? bool(e, "answered") ?? oneOf(e, "service", CALL_SERVICES) ??
    ("raw" in e ? null : "raw is missing"),
  device: (e) => text(e, "key") ?? text(e, "name") ?? oneOf(e, "deviceKind", DEVICE_KINDS),
  "llm-session": (e) =>
    contentFree(e) ?? text(e, "id") ?? text(e, "entrypoint") ?? optional(e, "device", text) ?? text(e, "project") ??
    absolute(e, "file") ?? optional(e, "version", text) ?? optional(e, "model", text) ?? time(e, "startedAt") ??
    time(e, "endedAt") ?? ordered(e, "startedAt", "endedAt") ?? count(e, "bytes"),
  "llm-turn": (e) =>
    contentFree(e) ?? text(e, "id") ?? text(e, "session") ?? oneOf(e, "role", ["prompt", "reply"]) ??
    (e.role === "reply" ? text(e, "answers") : e.answers === undefined ? null : "answers is only for a reply") ??
    (e.role === "reply" ? optional(e, "replyTo", text) : e.replyTo === undefined ? null : "replyTo is only for a reply") ??
    time(e, "at") ?? optional(e, "endAt", time) ?? (e.endAt === undefined ? null : ordered(e, "at", "endAt")) ??
    optional(e, "model", text) ?? count(e, "chars") ?? optional(e, "images", count) ?? optional(e, "toolCalls", count) ??
    count(e, "line") ?? ((e.line as number) >= 1 ? null : "line counts from 1") ?? count(e, "offset") ?? count(e, "length"),
  workout: (e) =>
    contentFree(e) ?? text(e, "id") ?? text(e, "sport") ?? oneOf(e, "family", SPORT_FAMILIES) ?? time(e, "at") ?? time(e, "endAt") ??
    ordered(e, "at", "endAt") ?? optional(e, "distanceMeters", (e, k) => (typeof e[k] === "number" && Number.isFinite(e[k]) && (e[k] as number) >= 0 ? null : `${k} must be a number of metres`)) ??
    optional(e, "recorder", text) ?? streams(e, "streams") ?? absolute(e, "file") ?? optional(e, "rawFile", absolute) ?? count(e, "bytes"),
  coverage: (e) =>
    optional(e, "conversation", text) ?? time(e, "from") ?? time(e, "to") ??
    ((e.from as number) <= (e.to as number) ? null : "from must not be after to"),
  tally: (e) => text(e, "name") ?? count(e, "count"),
  progress: (e) => count(e, "done") ?? optional(e, "total", count) ?? optional(e, "note", text),
  edit: (e) => text(e, "message") ?? text(e, "text", { empty: true }) ?? time(e, "editedAt"),
  checkpoint: (e) => (e.cursor === undefined ? "cursor is missing" : null),
  state: (e) => oneOf(e, "state", CONNECTION_STATES) ?? optional(e, "detail", text),
  "send-result": (e) =>
    text(e, "request") ?? oneOf(e, "status", ["sent", "failed", "unconfirmed"]) ??
    optional(e, "messageId", text) ?? optional(e, "error", text),
};

/** Checks a command from the host, as validateEvent checks events, never quoting its values. */
export function validateCommand(value: unknown): { command: ConnectorCommand } | { error: string } {
  if (!isObject(value)) return { error: "is not a JSON object" };
  if (value.command !== "send") return { error: "has an unknown command" };
  const problem = text(value, "request") ?? text(value, "conversation") ?? text(value, "text");
  return problem ? { error: `(send) ${problem}` } : { command: value as unknown as SendCommand };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(e: Record<string, unknown>, key: string, { empty = false } = {}): string | null {
  return typeof e[key] === "string" && (empty || e[key] !== "") ? null : `${key} must be ${empty ? "a" : "a non-empty"} string`;
}

function bool(e: Record<string, unknown>, key: string): string | null {
  return typeof e[key] === "boolean" ? null : `${key} must be true or false`;
}

function time(e: Record<string, unknown>, key: string): string | null {
  return Number.isSafeInteger(e[key]) ? null : `${key} must be milliseconds since the epoch`;
}

function count(e: Record<string, unknown>, key: string): string | null {
  return Number.isSafeInteger(e[key]) && (e[key] as number) >= 0 ? null : `${key} must be a whole number`;
}

function oneOf(e: Record<string, unknown>, key: string, allowed: readonly string[]): string | null {
  return allowed.includes(e[key] as string) ? null : `${key} must be one of ${allowed.join(", ")}`;
}

function optional(e: Record<string, unknown>, key: string, check: (e: Record<string, unknown>, key: string) => string | null) {
  return e[key] === undefined ? null : check(e, key);
}

function absolute(e: Record<string, unknown>, key: string): string | null {
  return typeof e[key] === "string" && (e[key] as string).startsWith("/") ? null : `${key} must be an absolute path`;
}

function ordered(e: Record<string, unknown>, from: string, to: string): string | null {
  return (e[from] as number) <= (e[to] as number) ? null : `${from} must not be after ${to}`;
}

/** A workout's streams: each one known, with a count of samples and a rate in seconds (or none). */
function streams(e: Record<string, unknown>, key: string): string | null {
  const value = e[key];
  if (!isObject(value)) return `${key} must be an object`;
  for (const [name, info] of Object.entries(value)) {
    if (!(WORKOUT_STREAMS as readonly string[]).includes(name)) return `${key} has an unknown stream`;
    if (!isObject(info) || count(info, "samples") !== null) return `${key}.${name}.samples must be a whole number`;
    if (info.everySeconds !== null && !(typeof info.everySeconds === "number" && info.everySeconds > 0)) return `${key}.${name}.everySeconds must be seconds or null`;
    if (Object.keys(info).some((k) => k !== "samples" && k !== "everySeconds")) return `${key}.${name} holds only samples and everySeconds`;
  }
  return null;
}

/** An event that points at content, never carries it: one with a text, or a raw record that could hold one, is refused. */
function contentFree(e: Record<string, unknown>): string | null {
  return "text" in e || "raw" in e ? "must carry no text or raw record, only where the content is" : null;
}
