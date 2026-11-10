// A Matrix client for the rig's homeserver that can make only the requests
// friend-map needs: log in, read (sync, room state, messages, one event,
// media), join a room the bridge invited it to, and send a text message.
//
// Everything goes through `request`, which refuses any other request before
// it leaves the process. So it can never send a read receipt or read marker
// (`/receipt`, `/read_markers`), typing (`/typing`), presence (`/presence`),
// or any event but m.room.message, and every sync says `set_presence=offline`.
// Each of those would reach Telegram or WhatsApp through the bridge: a receipt
// marks the chat read on the captain's phone, typing shows "typing…" to the friend.

export interface AllowedRequest {
  method: "GET" | "POST" | "PUT";
  path: RegExp;
}

const ROOM = "![^/]+|%21[^/]+";
const ID = "[^/]+";

/** Every request the client may make, and nothing else. */
export const ALLOWED_REQUESTS: readonly AllowedRequest[] = [
  { method: "GET", path: /^\/_matrix\/client\/versions$/ },
  { method: "POST", path: /^\/_matrix\/client\/v3\/login$/ },
  { method: "GET", path: /^\/_matrix\/client\/v3\/account\/whoami$/ },
  { method: "GET", path: /^\/_matrix\/client\/v3\/sync$/ },
  { method: "GET", path: new RegExp(`^/_matrix/client/v3/rooms/(${ROOM})/(state|messages)$`) },
  { method: "GET", path: new RegExp(`^/_matrix/client/v3/rooms/(${ROOM})/event/${ID}$`) },
  { method: "POST", path: new RegExp(`^/_matrix/client/v3/rooms/(${ROOM})/join$`) },
  { method: "PUT", path: new RegExp(`^/_matrix/client/v3/rooms/(${ROOM})/send/m\\.room\\.message/${ID}$`) },
  { method: "GET", path: new RegExp(`^/_matrix/client/v1/media/download/${ID}/${ID}$`) },
];

export function isAllowedRequest(method: string, path: string): boolean {
  return ALLOWED_REQUESTS.some((allowed) => allowed.method === method && allowed.path.test(path));
}

export class ForbiddenRequestError extends Error {}

export class MatrixError extends Error {
  readonly status: number;
  readonly errcode: string | null;
  constructor(status: number, errcode: string | null, message: string) {
    super(message);
    this.status = status;
    this.errcode = errcode;
  }
}

export interface MatrixEvent {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  state_key?: string;
  content: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
  room_id?: string;
}

export interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, {
      state?: { events?: MatrixEvent[] };
      timeline?: { events?: MatrixEvent[]; limited?: boolean; prev_batch?: string };
    }>;
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>;
    leave?: Record<string, unknown>;
  };
}

type Query = Record<string, string | number | undefined>;

export class MatrixClient {
  readonly homeserver: string;
  private token: string | null = null;
  userId: string | null = null;

  constructor(homeserver: string) {
    this.homeserver = homeserver.replace(/\/+$/, "");
  }

  /**
   * Logs in with a password as one fixed device, so logging in again replaces its token instead of adding a device
   * (and ends any other session of that device: each bridge's connector has a device of its own).
   */
  async login(user: string, password: string, device = "FRIENDMAP"): Promise<string> {
    const answer = await this.json<{ access_token: string; user_id: string }>("POST", "/_matrix/client/v3/login", {
      body: {
        type: "m.login.password",
        identifier: { type: "m.id.user", user },
        password,
        device_id: device,
        initial_device_display_name: "friend-map (reads only; never sends receipts)",
      },
    });
    this.token = answer.access_token;
    this.userId = answer.user_id;
    return answer.user_id;
  }

  sync(options: { since?: string; timeoutMs: number; filter: object; signal?: AbortSignal }): Promise<SyncResponse> {
    return this.json("GET", "/_matrix/client/v3/sync", {
      query: { since: options.since, timeout: options.timeoutMs, filter: JSON.stringify(options.filter) },
      signal: options.signal,
      timeoutMs: options.timeoutMs + 30_000,
    });
  }

  roomState(room: string): Promise<MatrixEvent[]> {
    return this.json("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state`);
  }

  messages(room: string, options: { from?: string; limit: number; filter: object; signal?: AbortSignal }): Promise<{ chunk: MatrixEvent[]; end?: string }> {
    return this.json("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages`, {
      query: { dir: "f", from: options.from, limit: options.limit, filter: JSON.stringify(options.filter) },
      signal: options.signal,
    });
  }

  event(room: string, eventId: string): Promise<MatrixEvent> {
    return this.json("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/event/${encodeURIComponent(eventId)}`);
  }

  join(room: string): Promise<unknown> {
    return this.json("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/join`, { body: {} });
  }

  /** Sends a plain text message: the only event this client can send. */
  async sendText(room: string, transactionId: string, text: string): Promise<string> {
    const answer = await this.json<{ event_id: string }>(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
      { body: { msgtype: "m.text", body: text } },
    );
    return answer.event_id;
  }

  /** The bytes of an mxc:// URL, as a stream. */
  async download(mxc: string): Promise<ReadableStream<Uint8Array>> {
    const match = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxc);
    if (!match) throw new Error("the media address is not an mxc:// URL");
    const response = await this.request("GET", `/_matrix/client/v1/media/download/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`, {});
    if (!response.body) throw new Error("the media download had no body");
    return response.body;
  }

  private async json<T>(method: AllowedRequest["method"], path: string, options: RequestOptions = {}): Promise<T> {
    return (await (await this.request(method, path, options)).json()) as T;
  }

  /** The one way out: refuses anything not in ALLOWED_REQUESTS, and makes every sync offline. */
  async request(method: AllowedRequest["method"], path: string, { query = {}, body, signal, timeoutMs = 60_000 }: RequestOptions): Promise<Response> {
    if (!isAllowedRequest(method, path)) throw new ForbiddenRequestError(`friend-map never makes the request ${method} ${path.replace(/\/rooms\/[^/]+/, "/rooms/…")}`);
    const url = new URL(this.homeserver + path);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    if (path === "/_matrix/client/v3/sync") url.searchParams.set("set_presence", "offline");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { errcode?: string; error?: string } | null;
      // The homeserver's own words, which name codes and rooms, never message content.
      throw new MatrixError(response.status, error?.errcode ?? null, `${method} ${url.pathname.replace(/\/rooms\/[^/]+/, "/rooms/…")} failed (${response.status} ${error?.errcode ?? ""})`.trim());
    }
    return response;
  }
}

interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}
