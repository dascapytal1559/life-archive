// The server's work on inspirations: each item a capture brings (from the share sheet's route, http.ts, or the CLI's
// inspiration add, in any process) waits in the module's database (Inspirations' queue: preview_state, ai_state) until the
// server, which alone runs the AI service and fetches previews, gets to it. One fiber looks every few seconds: first
// every preview waiting (previews.ts), then at most one Instagram post, when its slow pace says one is due
// (instagram.ts: its picture kept by content hash in the module's files/, files.ts), then every item whose AI
// tags are waiting and due (aiTags.ts), one at a time, so the model is told what the preview found. It tells no one
// anything: the archive houses an inspiration, it never reads his words as a request to build it.
// An AI that cannot answer (Codex signed out, say) leaves the item waiting, tried again after a growing wait
// (Inspirations.aiFailed), and given up on after a few tries until asked again.
//
// Written in Effect (docs/effect.md): the loop is a Schedule, its time Effect's Clock, and it runs as the module's work
// (module.ts), interrupted as the server stops, before the AI service and the archive close.

import { Readable } from "node:stream";
import { Clock, Effect, Random, Schedule } from "effect";
import type { Ai } from "../../../sdk/server.ts";
import type { Inspirations, KeptFile } from "./store.ts";
import { askAiTags } from "./aiTags.ts";
import { keepFile } from "./files.ts";
import { INSTAGRAM, INSTAGRAM_PACE, instagramCode, paceAt, settle, tryInstagram, type InstagramPace } from "./instagram.ts";
import { fetchPreview, type PreviewOptions } from "./previews.ts";

/** What the work is done on: the inspirations' store, and the module's folder its files are kept in (files.ts). */
export interface Kept {
  readonly store: Inspirations;
  readonly folder: string;
}

export interface WorkOptions extends PreviewOptions {
  /** How slowly Instagram is asked; INSTAGRAM_PACE unless said (a test's is quicker). */
  instagramPace?: InstagramPace;
  /** How often it looks for work; 5 s unless said. */
  everyMs?: number;
  log?: (line: string) => void;
}

/** One pass: every preview waiting, then every AI tagging due. Returns how many items it worked on. */
export const workOnce = (kept: Kept, ai: Ai, options: WorkOptions = {}): Effect.Effect<number> =>
  Effect.gen(function* () {
    const { store } = kept;
    let done = 0;
    for (let preview = store.nextPreview(); preview; preview = store.nextPreview()) {
      const work = preview;
      const found = yield* Effect.result(fetchPreview(work, options));
      if (found._tag === "Success") store.setPreview(work.id, found.success.state, found.success.preview);
      else {
        options.log?.(`inspiration #${work.id}: no preview (${found.failure.message})`);
        store.setPreview(work.id, "failed");
      }
      done++;
    }
    done += yield* instagramOnce(kept, options);
    for (let item = store.nextAiTags(yield* Clock.currentTimeMillis); item; item = store.nextAiTags(yield* Clock.currentTimeMillis)) {
      const work = item;
      done++;
      const asked = yield* Effect.result(askAiTags(ai, work, store.tags()));
      const now = yield* Clock.currentTimeMillis;
      if (asked._tag === "Failure") {
        options.log?.(`inspiration #${work.id}: no AI tags yet (${asked.failure.message})`);
        store.aiFailed(work.id, asked.failure.message, now);
        continue;
      }
      store.setAiTags(work.id, asked.success.tags, ai.model ?? "unknown", now);
    }
    return done;
  });

/** One Instagram post, when one is waiting and Instagram's pace says it is due (instagram.ts). Returns 1, or 0 for none. */
const instagramOnce = Effect.fnUntraced(function* (kept: Kept, options: WorkOptions) {
  const { store } = kept;
  const pace = options.instagramPace ?? INSTAGRAM_PACE;
  const now = yield* Clock.currentTimeMillis;
  if (!paceAt(store.fetchTimes(INSTAGRAM, now - 86_400_000), store.recentFetches(INSTAGRAM, 1)[0] ?? null, now, pace).due) return 0;
  const work = store.nextInstagram(now);
  if (!work) return 0;
  const code = instagramCode(work.link);
  if (!code) {
    store.setPreview(work.id, "none", {}, { tries: work.tries, retryAt: 0, note: "skipped: not a post's link, so it has no embed page" });
    return 1;
  }
  const tried = yield* tryInstagram(code, { fetch: options.fetch, pace });
  let picture: KeptFile | null = null;
  if (tried.outcome === "found" && tried.picture) {
    const { bytes, mime } = tried.picture;
    const file = yield* Effect.result(Effect.tryPromise(() =>
      keepFile(kept.folder, Readable.from([bytes]), `picture.${mime === "image/jpeg" ? "jpg" : mime.slice(6)}`, mime)));
    if (file._tag === "Success") picture = file.success;
    else tried.note = `its picture could not be kept: ${file.failure.message}`;
  }
  const at = yield* Clock.currentTimeMillis;
  const gap = yield* Random.nextBetween(pace.gapMs, pace.gapMs + pace.jitterMs);
  const settled = settle(work, code, tried, store.recentFetches(INSTAGRAM, 20), at, gap, pace);
  store.settleFetch(work.id, { ...settled, picture });
  options.log?.(`inspiration #${work.id}: Instagram ${settled.record.outcome}${settled.progress.note ? ` (${settled.progress.note})` : ""}`);
  return 1;
});

/** Works on inspirations every few seconds until interrupted; a pass that fails (a bug) is logged and the next goes on. */
export const keepInspirations = (kept: Kept, ai: Ai, options: WorkOptions = {}): Effect.Effect<never> =>
  workOnce(kept, ai, options).pipe(
    Effect.catchDefect((defect) => Effect.sync(() => options.log?.(`a pass failed: ${defect instanceof Error ? defect.message : String(defect)}`))),
    Effect.repeat(Schedule.spaced(options.everyMs ?? 5000)),
    Effect.andThen(Effect.never),
  );
