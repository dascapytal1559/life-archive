// The AI service: every AI request in the archive goes through here (ask it a question, get an answer): friend map's
// Query bar's Generate, and the AI's tags for an inspiration. A module reaches it through the SDK (sdk/server.ts's
// `AiService`, the interface alone); what answers is the installation's adapter, chosen as the server starts
// (configuredAi):
//
//   Codex    (codex.ts) where a model is named, LIFE_ARCHIVE_MODEL (the environment, then .env.local): the Codex CLI
//            signed in on this Mac, on the owner's ChatGPT plan
//   none     where no model is named: nothing starts, the server's log says so once, and each question is answered
//            with why (NO_MODEL), so a page that asks says what to set rather than failing
//
// Another provider is another adapter beside codex.ts, chosen here.

import { Context, Effect, Layer, type Scope } from "effect";
import { CodexService, type CodexServiceOptions } from "./codex.ts";
import { envSetting } from "./dataHome.ts";
import { UnavailableError } from "./errors.ts";

/** A question for the AI: its instructions, the request, and, for an answer in JSON, the schema it follows. */
export interface Question {
  instructions: string;
  prompt: string;
  schema?: object;
}

/** What answers questions: the installation's adapter (configuredAi), or a stand-in in tests. */
export interface Ai {
  ask(question: Question): Promise<string>;
  /** The model that answers, as an answer records it (an inspiration's AI tags); none for a stand-in or no model. */
  readonly model?: string;
}

/** What each question is told when no model is named. */
export const NO_MODEL = "no AI model is named: set LIFE_ARCHIVE_MODEL in .env.local";

/** The adapter where no model is named: every question answered with why. */
export const noModel: Ai = { ask: () => Promise.reject(new UnavailableError(NO_MODEL)) };

export interface AiOptions extends Omit<CodexServiceOptions, "model"> {
  /** The model that answers: LIFE_ARCHIVE_MODEL (the environment, then .env.local) unless given; null is none. */
  model?: string | null;
}

/** The installation's AI, held for the scope: Codex where a model is named (stopped as the scope closes), else noModel. */
export const configuredAi = (options: AiOptions = {}): Effect.Effect<Ai, never, Scope.Scope> => {
  const model = options.model === undefined ? envSetting("LIFE_ARCHIVE_MODEL") : (options.model ?? undefined);
  if (!model) return Effect.sync(() => (options.log?.(NO_MODEL), noModel));
  return Effect.acquireRelease(
    Effect.sync(() => {
      const service = new CodexService({ ...options, model });
      service.start();
      return service;
    }),
    (service) => service.halt,
  );
};

/** The AI service the server runs (serverLayer.ts): the installation's adapter, started with the server and stopped as it stops. */
export class AiService extends Context.Service<AiService, Ai>()("life-archive/AiService") {
  static readonly layer = (options: AiOptions = {}) => Layer.effect(AiService, configuredAi(options));
}
