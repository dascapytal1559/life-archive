// The backend over the server's routes, under /api/archive: friend-map's server (server/main.ts) passes them to the
// backend, and answers the Table's and the Events chart's scores itself. src/main.tsx provides it as the page's archive
// (see archiveApi.ts); the static demo provides another. Where the contract lets a backend leave a field out (the
// `map` capability's answers, src/contract/schema.ts) the page fills it in here, and what the backend does not serve
// is worked out here where it can be: the query language is run in the page for a backend without `query`.

import { ARCHIVE_TAG, type Contract, type PeopleListing, type PersonSummary, type QueryResult, type RelationshipsReport } from "./archive.ts";
import { ArchiveDown, ArchiveError, ArchiveUnavailable, type ArchiveApi } from "./archiveApi.ts";
import { offers, preContract } from "./contract/handshake.ts";
import { peopleListing, personSummary, relationshipsReport } from "./contract/schema.ts";
import type { Shape } from "./contract/shape.ts";
import { address } from "./mount.ts";
import { answerInPage, groupsOf, queryPerson, vocabularyOf } from "./pageQuery.ts";
import { closenessSettings } from "./settings.ts";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(address(`/api/archive${path}`), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const reason: string = body?.error ?? response.statusText;
    const message = `${init?.method ?? "GET"} ${path} failed (${response.status}): ${reason}`;
    throw response.status === 503
      ? new ArchiveDown(message, reason)
      : response.status === 404 ? new ArchiveUnavailable(message, reason) : new ArchiveError(message, reason);
  }
  return (response.status === 204 ? null : await response.json()) as T;
}

/** A `map` answer, with every field the backend left out filled in. */
async function filled<T>(shape: Shape<T>, path: string): Promise<T> {
  return shape.fill(await request(path));
}

/** A search string from `params`, leaving out empty ones; a list is the name once per item (hide=a&hide=b). */
const query = (params: Record<string, string | number | readonly string[] | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined && item !== "") search.append(key, String(item));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

/** The handshake; a backend with none (404) is one from before it (preContract). One that cannot be reached throws ArchiveDown. */
async function handshake(): Promise<Contract> {
  try {
    return await request<Contract>("/contract");
  } catch (error) {
    if (error instanceof ArchiveUnavailable && !(error instanceof ArchiveDown)) return preContract();
    throw error;
  }
}

/** A query run in the page, for a backend that does not run them: over everyone it lists, and the map's group chats. */
async function queryInPage(q: string, hide: readonly string[]): Promise<QueryResult> {
  const [listing, report] = await Promise.all([filled<PeopleListing>(peopleListing, "/people"), filled<RelationshipsReport>(relationshipsReport, "/relationships")]);
  const people = listing.people.map(queryPerson);
  return answerInPage(q, hide, people, vocabularyOf(people, { groups: groupsOf(report.groups) }), "This backend runs no SQL: it takes the query language.");
}

export const httpArchive: ArchiveApi = {
  contract: handshake,
  people: (filter = {}) => filled<PeopleListing>(peopleListing, `/people${query(filter)}`),
  person: (id) => filled<PersonSummary>(personSummary, `/people/${id}`),
  addPerson: (person) => request("/people", { method: "POST", body: JSON.stringify(person) }),
  setNames: (id, names) => request(`/people/${id}/names`, { method: "PUT", body: JSON.stringify({ names }) }),
  setTags: (id, tags) => request(`/people/${id}/tags`, { method: "PUT", body: JSON.stringify({ tags }) }),
  setNote: (id, note) => request(`/people/${id}/note`, { method: "PUT", body: JSON.stringify({ note }) }),
  setShouldReachOut: (id, shouldReachOut) =>
    request(`/people/${id}/should-reach-out`, { method: "PUT", body: JSON.stringify({ shouldReachOut }) }),
  drafts: (personId) => request(`/people/${personId}/drafts`),
  addDraft: (personId, text) => request(`/people/${personId}/drafts`, { method: "POST", body: JSON.stringify({ text }) }),
  setDraft: (id, text) => request(`/drafts/${id}`, { method: "PUT", body: JSON.stringify({ text }) }),
  setLocation: (id, location) => request(`/people/${id}/location`, { method: "PUT", body: JSON.stringify({ location }) }),
  setIdenticon: (id, seed, hue) => request(`/people/${id}/identicon`, { method: "PUT", body: JSON.stringify({ seed, hue }) }),
  join: (id, into) => request(`/people/${into}/merge`, { method: "POST", body: JSON.stringify({ with: id }) }),
  detach: (id, accountId) => request(`/people/${id}/accounts/${accountId}/detach`, { method: "POST" }),
  tags: () => request("/tags"),
  createTag: (name) => request("/tags", { method: "POST", body: JSON.stringify({ name }) }),
  renameTag: (from, to) => request(`/tags/${encodeURIComponent(from)}`, { method: "PUT", body: JSON.stringify({ name: to }) }),
  moveTag: (name, position) => request(`/tags/${encodeURIComponent(name)}/position`, { method: "PUT", body: JSON.stringify({ position }) }),
  deleteTag: (name) => request(`/tags/${encodeURIComponent(name)}`, { method: "DELETE" }),
  locations: () => request("/locations"),
  proposals: () => request("/merge-proposals"),
  confirm: (id) => request(`/merge-proposals/${id}/confirm`, { method: "POST" }),
  reject: (id) => request(`/merge-proposals/${id}/reject`, { method: "POST" }),
  changes: (limit) => request(`/changes${query({ limit })}`),
  changeset: (id) => request(`/changes/${id}`),
  undoChange: (id) => request(`/changes/${id}/undo`, { method: "POST", body: "{}" }),
  // Only a backend that runs queries can reveal the archived people one matches.
  relationships: (q = "", reveal = false) =>
    filled<RelationshipsReport>(relationshipsReport, `/relationships${reveal && offers("query") ? query({ q, reveal: ARCHIVE_TAG }) : ""}`),
  messageApps: () => request("/message-apps"),
  table: (settings) => request(`/table${query({ ...closenessSettings(settings) })}`),
  catchUps: (personId) => request(`/catch-ups${query({ person: personId })}`),
  addCatchUp: (input) => request("/catch-ups", { method: "POST", body: JSON.stringify(input) }),
  setCallLength: (messageId, minutes) => request(`/messages/${messageId}/call-length`, { method: "PUT", body: JSON.stringify({ minutes }) }),
  listCalls: () => request("/calls"),
  setCallNote: (call, note) => request("/call-notes", { method: "PUT", body: JSON.stringify({ call, note }) }),
  setCallAnswered: (call, answered) => request("/call-answered", { method: "PUT", body: JSON.stringify({ call, answered }) }),
  changeCatchUp: (id, input) => request(`/catch-ups/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteCatchUp: (id) => request(`/catch-ups/${id}`, { method: "DELETE" }),
  addCall: (input) => request("/calls", { method: "POST", body: JSON.stringify(input) }),
  loggedCall: (id) => request(`/calls/${id}`),
  changeCall: (id, input) => request(`/calls/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteCall: (id) => request(`/calls/${id}`, { method: "DELETE" }),
  callToCatchUp: (id, input) => request(`/calls/${id}/catch-up`, { method: "POST", body: JSON.stringify(input) }),
  catchUpToCall: (id, input) => request(`/catch-ups/${id}/call`, { method: "POST", body: JSON.stringify(input) }),
  calendarMonth: (month) => request(`/calendar/${encodeURIComponent(month)}`),
  calendarDay: (day) => request(`/calendar/${encodeURIComponent(day)}`),
  sendTargets: (personId) => request(`/people/${personId}/send-targets`),
  activity: (personId, settings) => request(`/people/${personId}/activity${query({ ...closenessSettings(settings) })}`),
  calls: (personId, accountId) => request(`/people/${personId}/calls${query({ account: accountId })}`),
  groups: (personId) => request(`/people/${personId}/groups`),
  setGroupUnlinked: (personId, groupId, unlinked) =>
    request(`/people/${personId}/groups/${groupId}/unlinked`, { method: "PUT", body: JSON.stringify({ unlinked }) }),
  group: (groupId) => request(`/groups/${groupId}`),
  archiveUntouched: (groupId, shown) => request(`/groups/${groupId}/archive-untouched`, { method: "POST", body: JSON.stringify({ people: shown }) }),
  query: (q, hide = []) => (offers("query") ? request(`/query${query({ q, hide })}`) : queryInPage(q, hide)),
  generateQuery: (current, transcript) =>
    request("/query/generate", { method: "POST", body: JSON.stringify({ query: current, transcript }) }),
  // The server's event stream, GET /api/archive/events; a backend without `events` has none, and nothing is followed.
  follow: (onChange) => {
    if (!offers("events")) return () => {};
    const events = new EventSource(address("/api/archive/events"));
    events.addEventListener("people", () => onChange("people"));
    events.addEventListener("messages", () => onChange("messages"));
    return () => events.close();
  },

  timeline: (personId, page = {}) =>
    request(`/content/people/${personId}/timeline${query({
      ...page,
      groups: page.groups ? 1 : undefined,
      marketplace: page.marketplace ? 1 : undefined,
      count: page.count ? 1 : undefined,
    })}`),
  conversation: (conversationId, page = {}) =>
    request(`/content/conversations/${conversationId}/messages${query({ ...page, count: page.count ? 1 : undefined })}`),
  dayMessages: (conversationId, day, page = {}) => request(`/content/conversations/${conversationId}/days/${encodeURIComponent(day)}${query(page)}`),
  send: (conversationId, text) => request(`/content/conversations/${conversationId}/send`, { method: "POST", body: JSON.stringify({ text }) }),
  attachmentUrl: (id) => address(`/api/archive/content/attachments/${id}`),
};
