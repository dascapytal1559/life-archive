// The Inspirations page's door to its server (/life-archive/api/inspirations/..., server/http.ts): reads,
// and its writes, each sent as JSON from this page (the server refuses any other), each answered with the changeset
// it made for Undo.

import type { ChangesetInfo } from "../../../sdk/contract.ts";
import { ApiError } from "../../../sdk/viewer.ts";
import {
  INSPIRATIONS_API,
  inspirationParams,
  type InspirationDetail,
  type InspirationFilter,
  type InspirationList,
  type InspirationSaved,
  type InspirationTagsAnswer,
  type InspirationTagsSaved,
} from "../wire.ts";

async function call<T>(path: string, { method = "GET", body, signal }: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`${INSPIRATIONS_API}${path}`, {
    method,
    signal,
    cache: "no-store",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const answer = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, answer.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function fetchItems(filter: InspirationFilter, offset: number, limit: number, signal?: AbortSignal): Promise<InspirationList> {
  const params = inspirationParams(filter);
  params.set("offset", String(offset));
  params.set("limit", String(limit));
  return call(`?${params}`, { signal });
}

export const fetchItem = (id: number, signal?: AbortSignal) => call<InspirationDetail>(`/items/${id}`, { signal });
export const fetchTags = (signal?: AbortSignal) => call<InspirationTagsAnswer>("/tags", { signal });
export const fetchChanges = (signal?: AbortSignal) => call<ChangesetInfo[]>("/changes?limit=40", { signal });

/** Where a kept file is served. */
export const fileUrl = (fileId: number): string => `${INSPIRATIONS_API}/files/${fileId}`;

export const saveCaption = (id: number, caption: string) => call<InspirationSaved>(`/items/${id}/caption`, { method: "PUT", body: { caption } });
export const saveTags = (id: number, tags: string[]) => call<InspirationSaved>(`/items/${id}/tags`, { method: "PUT", body: { tags } });
export const saveHidden = (id: number, hidden: boolean) => call<InspirationSaved>(`/items/${id}/hidden`, { method: "PUT", body: { hidden } });
export const askAiTagsAgain = (id: number) => call<InspirationDetail>(`/items/${id}/ai-tags`, { method: "POST", body: {} });

export const addTag = (name: string, description: string) => call<InspirationTagsSaved>("/tags", { method: "POST", body: { name, description } });
export const changeTag = (name: string, change: { name?: string; description?: string; position?: number }) =>
  call<InspirationTagsSaved>(`/tags/${encodeURIComponent(name)}`, { method: "PUT", body: change });
export const deleteTag = (name: string) => call<InspirationTagsSaved>(`/tags/${encodeURIComponent(name)}`, { method: "DELETE" });

export const undoChange = (id: number) => call<ChangesetInfo>(`/changes/${id}/undo`, { method: "POST", body: {} });
