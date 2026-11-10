// What the tag rules (rules.ts) know beyond the index, read fresh at each retag and only read, never changed:
//
//   T3 Code's own database (T3_CODE_STATE, .env.example; none when unset; opened read-only, in one read transaction through its
//   write-ahead log, so what is read is what T3 had committed): each thread (who made it and from where: createdBy, creationSource; the thread it is a
//   crew of, crewOf; the decision it asks, decisionOf), the provider session each of its threads runs (Claude Code's
//   session id, Codex's thread id: nativeThreadRef.nativeId), each run (its user message and when it started) and each
//   user message: who sent it and from where (createdBy user or agent; creationSource web, mobile, mcp, provider,
//   server, the last also T3's import of its older history), the thread that sent it (senderThreadId), whether it is a
//   notice (notification), and the device stamp T3 puts on what it accepts from a client (origin: { surface,
//   deviceType, appVersion }), when it has one. Never a message's text.
//   An agent orchestrator's records, where the installation configures one (provenance.ts; FirstMate's, firstmate.ts,
//   by FIRSTMATE_HOME): none when it configures none.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readOnlyAddress } from "../archive/db.ts";
import { pathSetting } from "../dataHome.ts";
import { configuredProvenance, type Orchestrator, type Provenance } from "./provenance.ts";

export interface T3Message {
  id: string;
  thread: string;
  /** When its run started: when its prompt reached the agent. */
  at: number;
  createdBy: string;
  creationSource: string;
  senderThread?: string;
  notification: boolean;
  /** T3's device stamp (origin.deviceType, origin.surface), when it has one. */
  deviceType?: string;
  surface?: string;
}

export interface T3Thread {
  id: string;
  createdBy: string;
  creationSource: string;
  crewOf?: string;
  decisionOf?: string;
}

export interface RuleContext {
  t3: {
    /** The thread each provider session (by its own id: a Claude Code session's, a Codex thread's) runs in. */
    threadOfSession: Map<string, string>;
    threads: Map<string, T3Thread>;
    /** Each provider session's runs' user messages, in the order they started. */
    messagesOfSession: Map<string, T3Message[]>;
    /** Why T3's database could not be read, when it could not: the rules then run without it. */
    problem?: string;
  };
  /** The configured orchestrator's records, as the rules ask them (provenance.ts), or null when none is configured. */
  orchestrator: Orchestrator | null;
}

export const EMPTY_CONTEXT: RuleContext = {
  t3: { threadOfSession: new Map(), threads: new Map(), messagesOfSession: new Map() },
  orchestrator: null,
};

const parse = (text: string | null): Record<string, unknown> => {
  try {
    const value = JSON.parse(text ?? "") as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * T3's threads, sessions, runs and messages from its database at `file` (see the top of this file); none when it is
 * not there, and none, with why, when it cannot be read (a T3 without these tables). Opened read-only, through its
 * write-ahead log, as T3 keeps writing it: a consistent read of what T3 has committed.
 */
export function readT3(file: string): RuleContext["t3"] {
  const t3: RuleContext["t3"] = { threadOfSession: new Map(), threads: new Map(), messagesOfSession: new Map() };
  if (!existsSync(file)) return t3;
  try {
    readT3Into(t3, file);
  } catch (error) {
    return { threadOfSession: new Map(), threads: new Map(), messagesOfSession: new Map(), problem: `T3's database (${file}) could not be read: ${(error as Error).message}` };
  }
  return t3;
}

function readT3Into(t3: RuleContext["t3"], file: string): void {
  const db = new DatabaseSync(readOnlyAddress(file), { readOnly: true, timeout: 5_000 });
  try {
    db.exec("BEGIN");
    for (const row of db.prepare("SELECT thread_id, payload_json FROM orchestration_v2_projection_threads").all() as Array<{ thread_id: string; payload_json: string }>) {
      const p = parse(row.payload_json);
      t3.threads.set(row.thread_id, {
        id: row.thread_id, createdBy: str(p.createdBy) ?? "unknown", creationSource: str(p.creationSource) ?? "unknown",
        ...(str(p.crewOf) ? { crewOf: str(p.crewOf) } : {}), ...(str(p.decisionOf) ? { decisionOf: str(p.decisionOf) } : {}),
      });
    }
    const sessionOfProvider = new Map<string, string>();
    for (const row of db.prepare("SELECT provider_thread_id, thread_id, payload_json FROM orchestration_v2_projection_provider_threads").all() as Array<{ provider_thread_id: string; thread_id: string; payload_json: string }>) {
      const native = str((parse(row.payload_json).nativeThreadRef as { nativeId?: unknown } | undefined)?.nativeId);
      if (!native) continue;
      sessionOfProvider.set(row.provider_thread_id, native);
      t3.threadOfSession.set(native, row.thread_id);
    }
    const messages = new Map<string, Record<string, unknown>>();
    for (const row of db.prepare("SELECT message_id, payload_json FROM orchestration_v2_projection_messages WHERE role = 'user'").all() as Array<{ message_id: string; payload_json: string }>) {
      messages.set(row.message_id, parse(row.payload_json));
    }
    for (const row of db.prepare("SELECT thread_id, provider_thread_id, payload_json FROM orchestration_v2_projection_runs").all() as Array<{ thread_id: string; provider_thread_id: string | null; payload_json: string }>) {
      const run = parse(row.payload_json);
      const session = row.provider_thread_id ? sessionOfProvider.get(row.provider_thread_id) : undefined;
      const message = str(run.userMessageId) ? messages.get(run.userMessageId as string) : undefined;
      const at = Date.parse(str(run.startedAt) ?? str(run.requestedAt) ?? "");
      if (!session || !message || !Number.isFinite(at)) continue;
      const origin = (message.origin ?? run.origin) as { deviceType?: unknown; surface?: unknown } | undefined;
      const list = t3.messagesOfSession.get(session) ?? [];
      list.push({
        id: run.userMessageId as string, thread: row.thread_id, at,
        createdBy: str(message.createdBy) ?? "unknown", creationSource: str(message.creationSource) ?? "unknown",
        ...(str(message.senderThreadId) ? { senderThread: str(message.senderThreadId) } : {}),
        notification: message.notification !== undefined && message.notification !== null,
        ...(str(origin?.deviceType) ? { deviceType: str(origin?.deviceType) } : {}),
        ...(str(origin?.surface) ? { surface: str(origin?.surface) } : {}),
      });
      t3.messagesOfSession.set(session, list);
    }
    for (const list of t3.messagesOfSession.values()) list.sort((a, b) => a.at - b.at);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/**
 * The context on this machine: T3 Code's database (T3_CODE_STATE, as archive/transcripts.ts takes it; none unless named)
 * and the configured orchestrator's records (provenance.ts: FirstMate's when FIRSTMATE_HOME names its home), none unless
 * one is configured.
 */
export function readContext({ t3File = pathSetting("T3_CODE_STATE") ?? null, provenance = configuredProvenance() }: { t3File?: string | null; provenance?: Provenance | null } = {}): RuleContext {
  const none = (): RuleContext["t3"] => ({ threadOfSession: new Map(), threads: new Map(), messagesOfSession: new Map() });
  return { t3: t3File === null ? none() : readT3(t3File), orchestrator: provenance?.read() ?? null };
}
