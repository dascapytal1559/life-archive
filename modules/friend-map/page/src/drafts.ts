// Saving a draft as you type it (DraftBox.tsx): a moment after you
// stop (SAVE_AFTER_MS), or at once when you leave the box or the panel goes.
// One save at a time, each of the latest text: a draft with none yet is made
// by the first save with any text, and one emptied is deleted (the server's
// rule, server/archive/drafts.ts), so the next text makes a new one.

import type { Draft } from "./archive.ts";
import { ArchiveError, type ArchiveApi } from "./archiveApi.ts";

/** How long after the last keystroke a draft is saved. */
export const SAVE_AFTER_MS = 700;

/** How the box's text stands: as saved, being saved, waiting to be, or not saved (with why). */
export type DraftState = { state: "saved" | "saving" | "waiting" } | { state: "failed"; error: string };

/** A draft's text as the server keeps it: plain line ends, no space at either end. */
export function draftText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

export class DraftSaver {
  private readonly personId: number;
  private readonly api: Pick<ArchiveApi, "addDraft" | "setDraft">;
  private readonly onState: (state: DraftState) => void;
  private id: number | null;
  /** The text as last saved ("" for no draft). */
  private saved: string;
  /** Typed and not saved yet; null when nothing is waiting. */
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(personId: number, draft: Draft | null, api: Pick<ArchiveApi, "addDraft" | "setDraft">, onState: (state: DraftState) => void = () => {}) {
    this.personId = personId;
    this.api = api;
    this.onState = onState;
    this.id = draft?.id ?? null;
    this.saved = draft?.text ?? "";
  }

  /** You typed: `text` is saved once you stop. */
  type(text: string): void {
    this.pending = text;
    clearTimeout(this.timer);
    if (draftText(text) === this.saved) {
      this.pending = null;
      this.onState({ state: "saved" });
      return;
    }
    this.onState({ state: "waiting" });
    this.timer = setTimeout(() => void this.flush(), SAVE_AFTER_MS);
  }

  /** Saves what is waiting now, after any save under way. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.chain = this.chain.then(() => this.saveLatest());
    return this.chain;
  }

  private async saveLatest(): Promise<void> {
    if (this.pending === null) return;
    const text = this.pending;
    this.pending = null;
    if (draftText(text) === this.saved) return;
    this.onState({ state: "saving" });
    try {
      const draft = this.id === null ? await this.api.addDraft(this.personId, text) : await this.api.setDraft(this.id, text);
      this.id = draft?.id ?? null;
      this.saved = draft?.text ?? "";
      if (this.pending === null) this.onState({ state: "saved" });
    } catch (error) {
      // Kept to try again with the next keystroke or flush.
      this.pending ??= text;
      this.onState({ state: "failed", error: error instanceof ArchiveError ? error.reason : error instanceof Error ? error.message : String(error) });
    }
  }
}
