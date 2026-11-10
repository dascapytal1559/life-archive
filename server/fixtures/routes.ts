// The routes as tests serve them: each with the services the server's Layer gives it (serverLayer.ts), made from
// what a test has at hand (an open archive, a stub model, the viewer's connection).

import { Context } from "effect";
import { AiService, type Ai } from "../ai.ts";
import type { Archive } from "../archive/index.ts";
import { OpenArchive } from "../archive/index.ts";
import { UnavailableError } from "../errors.ts";
import { serve, type ApiHandler } from "../jsonApi.ts";
import { ViewerDb } from "../viewer/connection.ts";
import { contentRoute } from "../viewer/content.ts";
import type { TableEdits } from "../edits/edits.ts";
import { editsRoute } from "../edits/http.ts";
import { viewerRoute } from "../viewer/http.ts";
import type { Reads, Tab } from "../viewer/tab.ts";

/** An AI service with no model behind it: every question is refused, as a stopped Codex refuses it. */
const NO_MODEL: Ai = { ask: () => Promise.reject(new UnavailableError("no model is set up to write queries")) };

/** An AI service answering what `model` writes (friend map's aiQueryModel's shape: JSON of what it answers). */
export function aiAnswering(model: (question: { system: string; prompt: string }) => Promise<unknown>): Ai {
  return { ask: async ({ instructions, prompt }) => JSON.stringify(await model({ system: instructions, prompt })) };
}

/** An AI service with no model behind it, for a test that never asks. */
export const NO_AI: Ai = NO_MODEL;

/** The viewer's routes, the core's tables and `tabs` (a module's, as moduleTabs stamps them), over the reads `reads` gives (tab.ts's Reads: the archive, the calendar and the owners). */
export function viewerHandler(reads: () => Reads | Error, tabs: readonly Tab[] = []): ApiHandler {
  return serve(Context.make(ViewerDb, { reads }), viewerRoute(tabs));
}

/** The tables' edits (server/edits/http.ts) over a registry, or the archive's error. */
export function editsHandler(edits: TableEdits | Error): ApiHandler {
  return serve(Context.empty(), editsRoute(edits));
}

/** The agents' conversations a drawer opens, read through the core's content paths. */
export function contentHandler(archive: Archive | Error): ApiHandler {
  return serve(Context.make(OpenArchive, { archive }), contentRoute());
}
