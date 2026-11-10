// The AI's tags for an inspiration: the archive's AI service (the SDK's AiService, the core's server/ai.ts: Codex on the owner's ChatGPT plan, where a model is named) is
// told what is known of the item, the captain's own words about it and his tags on it, his vocabulary (each tag with
// what it covers and how many items have it) and the AI tags most used so far, and answers with a few topic tags,
// best first. They are free words, written as tags are, kept apart from his and never made his (Inspirations.setAiTags),
// so he can try them out and compare; his vocabulary only steers them. Inspirations are metadata, so the model reads
// them freely (docs/features.md's "Inspirations"). The archive only houses an inspiration: his words are captioned and
// tagged, never read as a request to build anything.

import { Effect } from "effect";
import { type Ai, UnavailableError } from "../../../sdk/server.ts";
import type { AiWork } from "./store.ts";
import type { InspirationTagsAnswer } from "../wire.ts";

/** The answer's shape: the tags, best first. */
const ANSWER = {
  type: "object",
  properties: { tags: { type: "array", items: { type: "string" } } },
  required: ["tags"],
  additionalProperties: false,
} as const;

/** What the model answered: its tags. */
export interface AiAnswer {
  tags: string[];
}

export const AI_TAG_INSTRUCTIONS = `You tag the captain's inspirations: things he keeps (a post, a reel, a video, a page, a photo) for the ideas in them. He sorts them by what they are about, and one thing can be about several at once (parenting and art; architecture and cooking).

Answer with 2 to 5 tags for the item, best first, each a topic it is about: lowercase, words joined by hyphens, at most 40 characters (music, art, architecture, cooking, parenting, interior-design).
- His own words about it say why he kept it: weigh them most, then what is known of it (its title, author and description).
- Where one of his own tags fits, use it exactly as written; where none does, use a plain new word of the same kind. Reuse the AI tags already in use rather than a near twin (not "recipe" beside "cooking").
- Never a platform, a form or a mood alone: no "instagram", "video", "reel", "post", "inspiration", "cool".
- When too little is known to say what it is about, answer with the one or two tags you are sure of.`;

/** The request the model sees for `work`. */
export function aiTagPrompt(work: AiWork, vocabulary: InspirationTagsAnswer): string {
  const lines = [
    `Platform: ${work.platform}; form: ${work.form}`,
    ...(work.link ? [`Link: ${work.link}`] : ["Link: none (a photo or file he kept)"]),
    `Title: ${work.title ?? "(not known)"}`,
    `Author: ${work.author ?? "(not known)"}`,
    `Description: ${work.description ?? "(not known)"}`,
    `His words about it: ${work.caption || "(none)"}`,
    `His tags on it: ${work.tags.join(", ") || "(none yet)"}`,
    `His tags, in his order, with what each covers and how many items have it:`,
    ...(vocabulary.tags.length > 0 ? vocabulary.tags.map((tag) => `- ${tag.name} (${tag.count})${tag.description ? `: ${tag.description}` : ""}`) : ["- (none yet)"]),
    `AI tags in use, the most used first: ${vocabulary.aiTags.slice(0, 40).map((tag) => `${tag.name} (${tag.count})`).join(", ") || "(none yet)"}`,
  ];
  return lines.join("\n");
}

/**
 * The AI's tags for `work`, as it wrote them (Inspirations.setAiTags writes them as tags); or why it could not say.
 */
export const askAiTags = (ai: Ai, work: AiWork, vocabulary: InspirationTagsAnswer): Effect.Effect<AiAnswer, UnavailableError> =>
  Effect.tryPromise({
    try: () => ai.ask({ instructions: AI_TAG_INSTRUCTIONS, prompt: aiTagPrompt(work, vocabulary), schema: ANSWER }),
    catch: (error) => (error instanceof UnavailableError ? error : new UnavailableError((error as Error).message)),
  }).pipe(
    Effect.flatMap((text) => {
      let answer: unknown;
      try {
        answer = JSON.parse(text);
      } catch {
        answer = null;
      }
      const tags = (answer as { tags?: unknown } | null)?.tags;
      return Array.isArray(tags) && tags.every((tag) => typeof tag === "string")
        ? Effect.succeed({ tags: tags as string[] })
        : Effect.fail(new UnavailableError(`the model's answer could not be read: ${text.slice(0, 200)}`));
    }),
  );
