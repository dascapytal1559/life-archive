// An agent orchestrator's provenance: what an orchestrator that runs agents' sessions (its own, its workers', its
// peers') knows of them beyond the tools' files and T3's records, for the tag rules (rules.ts). It is optional and
// configured by the installation: none unless one is named, and then the rules give only the tools' and T3's tags.
//
// It answers two things. At the import, what a prompt's text is by the orchestrator's own shapes (its launch briefs,
// doorbells and wake-ups), of which the warehouse keeps only the marker (markers.ts). At each retag, from its records
// read fresh, the narrow questions the rules ask it (Orchestrator): what one of its markers says, which sessions are
// its workers' and its own, which of a session's senders it knows, and which folders are its projects'.
//
// The one adapter is FirstMate's (firstmate.ts), configured by FIRSTMATE_HOME (.env.example, in .env.local).

import { pathSetting } from "../dataHome.ts";
import { firstmateProvenance } from "./firstmate.ts";
import type { SessionKind, SessionRecord } from "./rules.ts";

/** What a prompt's marker says of who sent it and how, and whether that is a guess; null for a tool's own line, which is no prompt. */
export interface Said {
  who: string;
  channel: string;
  guess?: boolean;
}

export interface Provenance {
  /** What a prompt's text is by the orchestrator's own shapes, or null; read at the import, only the marker kept. */
  markerOf(text: string): string | null;
  /** Its records, read fresh for one retag, as the rules ask them. */
  read(): Orchestrator;
}

/** What the rules ask an orchestrator, from its records. */
export interface Orchestrator {
  /** What one of its markers says, on a session's `index`th prompt; undefined for a marker not its own. */
  said(marker: string, index: number): Said | undefined;
  /** The kind its records give a session (its workers', with their task, and its own thread's), asked before anything else. */
  recordedKind(session: SessionRecord, thread: string | undefined): SessionKind | undefined;
  /** The kind where a session ran gives it (one of its peers' homes), asked after T3's decision threads and the review pipeline. */
  placedKind(session: SessionRecord): SessionKind | undefined;
  /** Its own sessions' kind, for a session run in its home (asked of a T3 thread there, and of a terminal session); undefined elsewhere. */
  homeKind(session: SessionRecord): string | undefined;
  /** Who sent a T3 message from another thread, when its records know that thread. */
  senderOf(thread: string): { who: string; guess: boolean } | undefined;
  /** Who sent a T3 message through MCP into a session of this kind (its way of steering a thread), whether that is a guess, and by which channel. */
  steererOf(kind: SessionKind): { who: string; guess: boolean; channel: string };
  /** What a prompt in one of its workers' sessions is, by guess, when nothing else says (it types into their terminals too). */
  readonly workerPrompt: Said;
  /** The project a folder of its own is (null when the folder does not say), or undefined for a folder not its own. */
  projectOf(path: string): string | null | undefined;
}

/** The provenance this installation configures: FirstMate's when FIRSTMATE_HOME names its home, else none. */
export function configuredProvenance({ firstmateHome = pathSetting("FIRSTMATE_HOME") ?? null }: { firstmateHome?: string | null } = {}): Provenance | null {
  return firstmateHome === null ? null : firstmateProvenance(firstmateHome);
}
