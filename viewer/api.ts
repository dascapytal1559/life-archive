// The page's one door to its server: GET /life-archive/api/... (server/viewer/http.ts), the filters in the query string,
// the conversations a drawer opens (server/viewer/content.ts), each asked only when the captain asks, and the tables'
// edits (server/edits/http.ts: a row's fields, an edit and its undo, a POST of JSON each).

import {
  API_BASE, CALENDAR_DAYS_API, filterParams, type CalendarDaysAnswer, type ChatPage, type DayChatPage, type DayChatsAnswer, type FacetsAnswer, type Filters, type Grain, type KindsAnswer, type KindSpec, type RowDetail, type RowsAnswer,
  type SessionPage, type SortDirection, type VolumeAnswer,
} from "./wire.ts";
import { EDITS_API, type AddAsk, type EditAsk, type EditDone, type EditState, type EditsAnswer, type EditValue, type LocksAnswer, type NoteAnswer, type OptionsAnswer } from "./editWire.ts";
import { moduleViewers } from "./modules.ts";
import { tellSaved } from "./savedEdits.ts";

/** An answer that was not 200, with the server's words for why. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const query = params.toString();
  const res = await fetch(`${API_BASE}${path}${query ? `?${query}` : ""}`, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** The server's tables, asked once for everything on the page that needs them (Events' Tables, its Calendar, Jump to), and again after a failure. */
let kinds: Promise<KindSpec[]> | null = null;
export const kindsOnce = (): Promise<KindSpec[]> =>
  (kinds ??= getJson<KindsAnswer>("/kinds", new URLSearchParams()).then((answer) => answer.kinds, (error: Error) => ((kinds = null), Promise.reject(error))));

export interface RowsAsk {
  offset: number;
  limit: number;
  sort: string;
  direction: SortDirection;
  /** Where the page before ended (its RowsAnswer.next), for a tab that pages by key. */
  after?: string | null;
}

export function fetchRows(kind: string, filters: Filters, ask: RowsAsk, signal?: AbortSignal): Promise<RowsAnswer> {
  const params = filterParams(filters);
  params.set("offset", String(ask.offset));
  params.set("limit", String(ask.limit));
  params.set("sort", ask.sort);
  params.set("dir", ask.direction);
  if (ask.after) params.set("after", ask.after);
  return getJson(`/${kind}/rows`, params, signal);
}

/** The chart: `begins` (HH:MM) when its days begin later than midnight (the Events calendar's, at 06:00). */
export function fetchVolume(kind: string, filters: Filters, grain: Grain | null, measure: string, split: string | null, signal?: AbortSignal, begins?: string): Promise<VolumeAnswer> {
  const params = filterParams(filters);
  params.set("grain", grain ?? "auto");
  params.set("measure", measure);
  if (split) params.set("split", split);
  if (begins && begins !== "00:00") params.set("begins", begins);
  return getJson(`/${kind}/volume`, params, signal);
}

export function fetchFacets(kind: string, filters: Filters, signal?: AbortSignal): Promise<FacetsAnswer> {
  return getJson(`/${kind}/facets`, filterParams(filters), signal);
}

export function fetchRow(kind: string, id: string, signal?: AbortSignal): Promise<RowDetail> {
  return getJson(`/${kind}/row`, new URLSearchParams({ id }), signal);
}

/** A page of the chat message `id` is in: around it, or older than `page.before`, or newer than `page.after`. */
export function fetchChat(id: number, page: { before?: string; after?: string }, signal?: AbortSignal): Promise<ChatPage> {
  const params = new URLSearchParams();
  if (page.before) params.set("before", page.before);
  if (page.after) params.set("after", page.after);
  return getJson(`/content/messages/${id}/chat`, params, signal);
}

/** A page of the LLM session event `id` is in: around it at first, or from `offset`. */
export function fetchSession(id: number, offset: number | null, signal?: AbortSignal): Promise<SessionPage> {
  return getJson(`/content/llm/${id}/session`, offset === null ? new URLSearchParams() : new URLSearchParams({ offset: String(offset) }), signal);
}

/** A calendar day's chats by count and who is in them, never a message. */
export function fetchDayChats(day: string, signal?: AbortSignal): Promise<DayChatsAnswer> {
  return getJson(`/content/messages/days/${day}`, new URLSearchParams(), signal);
}

/** A page of a person's (`{ person }`) or a chat's (`{ chat }`) messages on a calendar day, from `after`: read only when the captain opens it, each page kept in the trail. */
export function fetchDayChat(day: string, of: { person: number } | { chat: number }, after: string | null, signal?: AbortSignal): Promise<DayChatPage> {
  const which = "person" in of ? `people/${of.person}` : `chats/${of.chat}`;
  return getJson(`/content/messages/days/${day}/${which}`, after ? new URLSearchParams({ after }) : new URLSearchParams(), signal);
}

/** The calendar's day summaries over the days [from, to) (YYYY-MM-DD), each day's messages those with `person` while one is picked. */
export function fetchCalendarDays(from: string, to: string, person: number | null, signal?: AbortSignal): Promise<CalendarDaysAnswer> {
  const params = new URLSearchParams({ from, to });
  if (person !== null) params.set("person", String(person));
  return getJson(CALENDAR_DAYS_API.slice(API_BASE.length), params, signal);
}

/** A JSON POST to the viewer's routes (its writes come from its own page alone), its answer or ApiError. */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const answer = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, answer.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

const EDITS = EDITS_API.slice(API_BASE.length);

/** Row `id` of table `kind`'s editable fields as they stand (server/edits/): ApiError 403 or 404 for a table or row that cannot be edited. */
export function fetchEditState(kind: string, id: string, signal?: AbortSignal): Promise<EditState> {
  return getJson(`${EDITS}/row`, new URLSearchParams({ kind, id }), signal);
}

/** Changes `field` of row `id` of table `kind` to `value`, through its owner; kept in the record, and told to the modules' page halves (savedEdits.ts). */
export async function postEdit(kind: string, id: string, field: string, value: EditValue): Promise<EditDone> {
  const done = await postJson<EditDone>(EDITS, { kind, id, field, value } satisfies EditAsk);
  void tellSaved(kind, done, { viewers: moduleViewers, record: fetchRecord });
  return done;
}

/** Adds a row of the captain's own to table `kind` (its `own`), from each field Add asks; kept in the record. */
export function postAdd(kind: string, values: Record<string, EditValue>, anyway = false): Promise<EditDone> {
  return postJson(`${EDITS}/add`, { kind, values, ...(anyway && { anyway }) } satisfies AddAsk);
}

/** Deletes row `id` of table `kind`, one of the captain's own (never an imported row); kept in the record. */
export function postDelete(kind: string, id: string): Promise<EditDone> {
  return postJson(`${EDITS}/delete`, { kind, id });
}

/** Puts edit `edit` back, as an edit of its own, told to the modules' page halves as postEdit's are. */
export async function postUndo(edit: number): Promise<EditDone> {
  const done = await postJson<EditDone>(`${EDITS}/${edit}/undo`, {});
  void tellSaved(undefined, done, { viewers: moduleViewers, record: fetchRecord });
  return done;
}

/** The record of row `id` of table `kind`'s edits, newest first. */
export function fetchEdits(kind: string, id: string, signal?: AbortSignal): Promise<EditsAnswer> {
  return getJson(EDITS, new URLSearchParams({ kind, id, limit: "20" }), signal);
}

/** The whole record, every table's or table `kind`'s, newest first: `limit` of it, older than edit `before` when given (the Edits table). */
export function fetchRecord(ask: { kind?: string; limit: number; before?: number }, signal?: AbortSignal): Promise<EditsAnswer> {
  const params = new URLSearchParams({ limit: String(ask.limit) });
  if (ask.kind) params.set("kind", ask.kind);
  if (ask.before !== undefined) params.set("before", String(ask.before));
  return getJson(EDITS, params, signal);
}

/** Which fields of each of rows `ids` of table `kind` stay as they are (a page of the grid's): a row left out cannot be edited. */
export function fetchLocks(kind: string, ids: readonly string[], signal?: AbortSignal): Promise<LocksAnswer> {
  return getJson(`${EDITS}/locks`, new URLSearchParams({ kind, ids: ids.join(",") }), signal);
}

/** Who a people field can take, by name. */
export function fetchOptions(kind: string, field: string, q: string, signal?: AbortSignal): Promise<OptionsAnswer> {
  return getJson(`${EDITS}/options`, new URLSearchParams({ kind, field, q }), signal);
}

/** A note's words, to edit them: content, so the read is kept in the trail of content reads. */
export function fetchNote(kind: string, id: string, field: string): Promise<NoteAnswer> {
  return getJson(`${EDITS}/note`, new URLSearchParams({ kind, id, field }));
}
