// What a prompt's text says it is, without keeping a word of it: the warehouse reads each prompt's text only to
// pass it through a classifier (`classifierOf`), which gives a marker, or null for words a person or an agent wrote.
// Only the marker is kept (llm_turn.facts), so the tag rules (rules.ts) can run again over the whole history without
// reading a file.
//
// The markers here are the shapes the tools give their own lines and notices, as their own code writes them:
//   - Claude Code's: a background task's notice (<task-notification>), a Stop hook's feedback, a reminder alone,
//     a slash command (<command-name>), what a local command printed, an interruption, a compacted session's summary
//   - Codex's: the context and instructions it sends as the user (<environment_context>, AGENTS.md's), a subagent's
//     notice, an aborted turn's
// An agent orchestrator's own shapes (its launch briefs, doorbells and wake-ups) are its provenance adapter's
// (provenance.ts; FirstMate's in firstmate.ts), checked first where one is configured.

import type { Provenance } from "./provenance.ts";

/** What a prompt's text can say it is, by a tool's own shapes. */
export const MARKERS = [
  "task-notification", // a background task's notice
  "stop-hook", // a Stop hook's feedback
  "reminder", // a system reminder and nothing else
  "command", // a slash command someone typed
  "command-output", // what a local command printed: the tool's, not a prompt
  "interrupted", // the tool's note that a turn was interrupted: not a prompt
  "continuation", // a compacted session's summary, carried on
  "tool-context", // the context or instructions a tool sends as the user (Codex's): not a prompt
  "subagent-notice", // a subagent's notice to its parent
] as const;
export type ToolMarker = (typeof MARKERS)[number];

/** A marker as a turn's facts keep it: a tool's own, or an orchestrator's (its provenance adapter's). */
export type Marker = string;

/** How a prompt's text is classified: its marker, or null for words someone wrote. */
export type Classify = (text: string) => Marker | null;

/** The markers that are a tool's own lines, never a prompt anyone sent: their turns are left out of the prompts. */
export const NOT_PROMPTS: ReadonlySet<Marker> = new Set<ToolMarker>(["command-output", "interrupted", "tool-context"]);

const INVISIBLE = /^[⁣​‌‍﻿\s]+/;

/** A prompt's text without the invisible characters and spaces some programs put before their shapes. */
export const visible = (text: string) => text.replace(INVISIBLE, "");

/** What `text` (a prompt's, whole) says it is by a tool's own shapes, or null. */
export function markerOf(text: string): ToolMarker | null {
  const t = visible(text);
  if (t.startsWith("<task-notification>")) return "task-notification";
  if (t.startsWith("Stop hook feedback:")) return "stop-hook";
  if (t.startsWith("<command-name>") || t.startsWith("<command-message>") || t.startsWith("<bash-input>")) return "command";
  if (t.startsWith("<local-command-") || t.startsWith("<bash-stdout>") || t.startsWith("<bash-stderr>")) return "command-output";
  if (t.startsWith("[Request interrupted by user")) return "interrupted";
  if (t.startsWith("This session is being continued from a previous conversation")) return "continuation";
  if (t.startsWith("<environment_context>") || t.startsWith("<user_instructions>") || t.startsWith("# AGENTS.md instructions") || t.startsWith("<permissions instructions>") || t.startsWith("<turn_aborted>") || t.startsWith("<user_shell_command>")) {
    return "tool-context";
  }
  if (t.startsWith("<subagent_notification>")) return "subagent-notice";
  if (t.startsWith("<system-reminder>") && t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() === "") return "reminder";
  return null;
}

/** The classifier: the orchestrator's shapes first, where one is configured, then the tools' own. */
export const classifierOf = (provenance: Provenance | null): Classify =>
  provenance ? (text) => provenance.markerOf(text) ?? markerOf(text) : markerOf;
