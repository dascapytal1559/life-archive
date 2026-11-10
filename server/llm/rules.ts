// The tag rules (docs/events.md's "The LLM warehouse"): each a function from one session of the index, with its prompts, and
// what the rules know beyond the index (context.ts: T3's records, and an agent orchestrator's where one is configured,
// provenance.ts), to the tags it proposes, every tag naming its rule and whether it is a guess. They read only the
// index's rows and facts (llm_session.facts, llm_turn.facts: what the tools' files say and what each prompt's text was
// classified as, markers.ts), never a file, so `retag` (tags.ts) runs them over the whole history at once, and gives
// the same tags each time.
//
// The families, on a session:
//   tool     which tool and account: claude (~/.claude), claude-<profile> (a Claude profile, CLAUDE_PROFILES_DIR), codex, grok
//            (the Grok CLI), pi, g (Grok Bot)
//   app      what ran it: t3, claude-desktop, codex-desktop, vscode, chrome, terminal, g-app, program (nobody at it)
//   session  what kind of session: own (one the captain opened), worker (a T3 crew's, or an orchestrator's task's),
//            decision (a T3 thread asking the captain a decision), review-pipeline (no-mistakes), helper (a subagent
//            another agent started), app-internal (an app's own call, nobody at it), and the orchestrator's own kinds
//            (FirstMate's: firstmate-main, secondmate)
//   task     a worker's task, from the orchestrator's own records only, never from what the prompt's text says
//   project  the project it ran in, by its folder
// and on a prompt:
//   who      human, worker, agent (another agent: G's talk, a parent agent), system (notices, hook feedback, wake-ups,
//            scheduled jobs, an app's own calls), and the orchestrator (FirstMate's: firstmate)
//   device   a human's prompt: desktop, phone, tablet, terminal, unknown
//   channel  typed, voice, command, decision-reply, wake-up, hook, notification, agent-message, continuation, and the
//            orchestrator's (FirstMate's: initial-instructions, a launch brief; inbox-note, its steering inbox; steer,
//            its words sent straight to the thread)
// A family's chosen value (tags.ts) is a hand tag's, else a fact's over a guess's, else the earliest rule's in RULES.

import { homedir } from "node:os";
import type { RuleContext, T3Message } from "./context.ts";
import type { Orchestrator, Said } from "./provenance.ts";
import type { ToolMarker } from "./markers.ts";
import type { SessionFacts, TurnFacts } from "./types.ts";

/** A session as the rules read it: its rows' columns and facts, and its prompts. */
export interface SessionRecord {
  /** llm_session.id */
  id: number;
  origin: string;
  nativeId: string;
  /** How it was run (its event's subkind). */
  entrypoint: string;
  project: string;
  /** When it began. */
  at: number;
  facts: SessionFacts;
  prompts: PromptRecord[];
}

export interface PromptRecord {
  /** llm_turn.id */
  id: number;
  at: number;
  facts: TurnFacts;
}

export interface Proposal {
  target: "session" | "turn";
  targetId: number;
  family: string;
  value: string;
  rule: string;
  guess: boolean;
}

export interface Rule {
  id: string;
  /** What it reads, in a line, for the docs and `npm run llm -- rules`. */
  about: string;
  tag(session: SessionRecord, context: RuleContext, kind: SessionKind): Proposal[];
}

/** A session's kind as the session-kind rule finds it, which the prompt rules read too. */
export interface SessionKind {
  kind: string;
  task?: string;
  guess: boolean;
}

const HOME = homedir();
/** Whether `path` is `folder` or inside it. */
export const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder.replace(/\/+$/, "")}/`);
const HEADLESS = new Set(["sdk-cli", "sdk-ts", "sdk-py", "codex_exec", "exec", "headless"]);
const isHeadless = (s: SessionRecord) => HEADLESS.has(s.entrypoint) || s.facts.source === "exec";

/** The session's T3 thread, by its tool's id (a subagent's is none). */
const threadOf = (s: SessionRecord, c: RuleContext) => c.t3.threadOfSession.get(s.nativeId);

/** What kind of session it is (see the top of this file), from the orchestrator's records, T3's, and where and how it ran. */
export function sessionKindOf(s: SessionRecord, c: RuleContext): SessionKind {
  if (s.origin === "grok-bot") return { kind: "own", guess: false };
  if (s.facts.subagent) return { kind: "helper", guess: false };
  const thread = threadOf(s, c);
  const recorded = c.orchestrator?.recordedKind(s, thread);
  if (recorded) return recorded;
  const t3 = thread ? c.t3.threads.get(thread) : undefined;
  if (t3?.decisionOf) return { kind: "decision", guess: false };
  if (/^\/(?:Users|home)\/[^/]+\/\.no-mistakes\//.test(s.project)) return { kind: "review-pipeline", guess: false };
  const placed = c.orchestrator?.placedKind(s);
  if (placed) return placed;
  if (t3?.createdBy === "agent" && t3.crewOf) return { kind: "worker", guess: true };
  // T3 runs its threads through the tools' SDKs: a T3 thread is someone's conversation, however its tool says it ran.
  const home = c.orchestrator?.homeKind(s);
  if (t3) return { kind: home ?? "own", guess: t3.createdBy !== "user" };
  if (isHeadless(s)) return { kind: "app-internal", guess: true };
  if (home && (s.origin === "claude-code" || s.origin === "codex")) return { kind: home, guess: true };
  return { kind: "own", guess: !(["cli", "claude-desktop", "codex-tui", "Codex Desktop", "codex_work_desktop", "interactive", "pi"].includes(s.entrypoint)) };
}

/** A project's name from the folder a session ran in (the orchestrator's own folders by its word), or null when the folder does not say. */
export function projectOf(path: string, orchestrator: Orchestrator | null): string | null {
  const treehouse = /\/\.treehouse\/[^/]+-[0-9a-f]{6}\/\d+\/([^/]+)/.exec(path);
  if (treehouse) return treehouse[1];
  const scratch = /-treehouse-(.+?)-[0-9a-f]{6}-\d+-/.exec(path);
  if (path.startsWith("/private/tmp/") && scratch) return scratch[1];
  const own = orchestrator?.projectOf(path);
  if (own !== undefined) return own;
  const projects = /^\/(?:Users|home)\/[^/]+\/Projects\/([^/]+)/.exec(path);
  if (projects) return projects[1];
  if (path === HOME) return "home";
  return null;
}

const session = (s: SessionRecord, rule: string, family: string, value: string, guess = false): Proposal => ({ target: "session", targetId: s.id, family, value, rule, guess });
const turn = (p: PromptRecord, rule: string, family: string, value: string, guess = false): Proposal => ({ target: "turn", targetId: p.id, family, value, rule, guess });

/** A T3 device stamp's deviceType (desktop, mobile, tablet, bot, unknown: the fork's README) as a device tag. */
export function deviceOfStamp(deviceType: string): string {
  if (/tablet/i.test(deviceType)) return "tablet";
  if (/phone|mobile|ios|android/i.test(deviceType)) return "phone";
  if (/desktop|computer|mac|windows|linux|laptop/i.test(deviceType)) return "desktop";
  if (/terminal|cli/i.test(deviceType)) return "terminal";
  return "unknown";
}

/** Each prompt's T3 message: the one whose run started nearest it, within two minutes, each message once. */
export function matchMessages(prompts: PromptRecord[], messages: T3Message[]): Map<number, T3Message> {
  const matched = new Map<number, T3Message>();
  const used = new Set<string>();
  for (const p of [...prompts].sort((a, b) => a.at - b.at)) {
    let best: T3Message | undefined;
    for (const m of messages) {
      if (used.has(m.id) || Math.abs(m.at - p.at) > 120_000) continue;
      if (!best || Math.abs(m.at - p.at) < Math.abs(best.at - p.at)) best = m;
    }
    if (best) {
      used.add(best.id);
      matched.set(p.id, best);
    }
  }
  return matched;
}

/** What each of a tool's markers says of who sent a prompt and how, and whether that is a guess. */
const MARKED: Record<ToolMarker, Said | null> = {
  "task-notification": { who: "system", channel: "notification" },
  "stop-hook": { who: "system", channel: "hook" },
  reminder: { who: "system", channel: "notification" },
  command: { who: "human", channel: "command", guess: true },
  continuation: { who: "system", channel: "continuation" },
  "subagent-notice": { who: "agent", channel: "notification" },
  "command-output": null,
  interrupted: null,
  "tool-context": null,
};

/**
 * What a session's `index`th prompt's marker says: the orchestrator's for its own, else the tool's; undefined for no
 * marker, or one neither knows (which marks the prompt, but says nothing of it).
 */
function saidOf(p: PromptRecord, index: number, c: RuleContext): Said | null | undefined {
  const marker = p.facts.marker;
  if (!marker) return undefined;
  return c.orchestrator?.said(marker, index) ?? (Object.hasOwn(MARKED, marker) ? MARKED[marker as ToolMarker] : undefined);
}

/** Where someone sat to type into a session, by how the session ran. */
const AT: Record<string, string> = {
  cli: "terminal", "claude-desktop": "desktop", "codex-tui": "terminal", "Codex Desktop": "desktop", codex_work_desktop: "desktop", codex_vscode: "desktop",
  "codex-chrome-extension-sidepanel": "desktop", interactive: "terminal", pi: "terminal",
};

/** Who sent a prompt the tool cannot say, by the kind of session it is in (an orchestrator's workers' are its to say, workerPrompt). */
const whoByKind = (kind: SessionKind): string =>
  kind.kind === "app-internal" || kind.kind === "review-pipeline" ? "system" : kind.kind === "helper" || kind.kind === "worker" ? "agent" : "human";

export const RULES: Rule[] = [
  {
    id: "t3-message",
    about: "a prompt T3 sent: who sent it and from which device, from T3's own record of the message (its device stamp, else the client it came from)",
    tag(s, c, kind) {
      const messages = c.t3.messagesOfSession.get(s.nativeId);
      if (!messages) return [];
      const out: Proposal[] = [];
      const thread = threadOf(s, c);
      const decision = thread ? c.t3.threads.get(thread)?.decisionOf : undefined;
      for (const [id, m] of matchMessages(s.prompts, messages)) {
        const p = s.prompts.find((x) => x.id === id)!;
        const add = (family: string, value: string, guess = false) => out.push(turn(p, "t3-message", family, value, guess));
        if (m.createdBy === "user") {
          add("who", "human");
          if (m.deviceType) add("device", deviceOfStamp(m.deviceType));
          else if (m.creationSource === "mobile") add("device", "phone");
          else if (m.creationSource === "web") add("device", "desktop", true);
          else add("device", "unknown");
          add("channel", decision ? "decision-reply" : "typed", !decision);
          continue;
        }
        if (m.notification || m.creationSource === "server") {
          add("who", "system");
          if (!p.facts.marker) add("channel", m.notification ? "notification" : "wake-up", !m.notification);
          continue;
        }
        if (m.senderThread) {
          const sender = m.senderThread;
          const known = c.orchestrator?.senderOf(sender);
          add("who", known?.who ?? (c.t3.threads.get(sender)?.crewOf ? "worker" : "agent"), known?.guess ?? true);
          if (!p.facts.marker) add("channel", "agent-message");
          continue;
        }
        if (m.creationSource === "mcp" && c.orchestrator) {
          const steer = c.orchestrator.steererOf(kind);
          add("who", steer.who, steer.guess);
          if (!p.facts.marker) add("channel", steer.channel);
          continue;
        }
        add("who", "agent", true);
      }
      return out;
    },
  },
  {
    id: "prompt-marker",
    about: "a prompt whose text is another program's known shape (markers.ts): a tool's notices and hook feedback, a slash command, and the orchestrator's own (FirstMate's launch brief, steering doorbell and wake-ups)",
    tag(s, c) {
      return s.prompts.flatMap((p, i) => {
        const said = saidOf(p, i, c);
        if (!said) return [];
        return [turn(p, "prompt-marker", "who", said.who, said.guess), turn(p, "prompt-marker", "channel", said.channel, said.guess && said.who !== "human")];
      });
    },
  },
  {
    id: "tool-record",
    about: "a prompt as its tool's file records it: Claude Code's prompt source and how the session ran, Codex's app, the Grok CLI's session kind, Grok Bot's surface; else who by the session's kind",
    tag(s, c, kind) {
      const out: Proposal[] = [];
      for (const [i, p] of s.prompts.entries()) {
        const add = (family: string, value: string, guess = false) => out.push(turn(p, "tool-record", family, value, guess));
        const human = (device: string | null, deviceGuess = false, channel = "typed", channelGuess = false) => {
          add("who", "human");
          add("device", device ?? "unknown", device === null ? false : deviceGuess);
          add("channel", channel, channelGuess);
        };
        const source = p.facts.source;
        // Who sent a marked prompt is the marker's to say (prompt-marker).
        if (p.facts.marker && saidOf(p, i, c)?.who !== "human") continue;
        if (s.origin === "grok-bot") {
          if (s.entrypoint === "chat") human("desktop", true, "typed", true);
          else human(null, false, "voice");
          continue;
        }
        if (source === "agent") {
          add("who", "agent");
          add("channel", "agent-message");
          continue;
        }
        // Claude Code's own turn (promptSource or turnOrigin "system"), in whatever session: nobody typed it.
        if (source === "system") {
          add("who", "system");
          add("channel", "notification", true);
          continue;
        }
        // An orchestrator types into its workers' terminals too, as a person would.
        if (kind.kind === "worker" && c.orchestrator) {
          const { who, channel, guess = false } = c.orchestrator.workerPrompt;
          add("who", who, guess);
          add("channel", channel, guess);
          continue;
        }
        const typed = source === "typed" || source === "queued" || source === "human" || source === "user";
        const at = AT[s.entrypoint];
        if (typed && at) {
          human(at);
          continue;
        }
        // A prompt in an app someone sits at that does not say how it came (an older Claude Code's, the desktop app's).
        if (at) {
          human(at, true, "typed", true);
          continue;
        }
        const who = whoByKind(kind);
        add("who", who, true);
        if (who === "human") add("device", "unknown", true);
      }
      return out;
    },
  },
  {
    id: "session-kind",
    about: "what kind of session it is: the orchestrator's by its records (FirstMate's: a task's worker, by its launch brief or its T3 thread, its own thread, a secondmate's), a decision thread, no-mistakes' review, a T3 crew's worker, a subagent, an app's own call, or one the captain opened",
    tag(s, _c, kind) {
      return [session(s, "session-kind", "session", kind.kind, kind.guess), ...(kind.task ? [session(s, "session-kind", "task", kind.task)] : [])];
    },
  },
  {
    id: "tool-home",
    about: "which tool and account: the origin, and the Claude Code home the session file is in",
    tag(s) {
      const value = s.origin === "grok-bot" ? "g" : s.origin === "codex" ? "codex" : s.origin === "grok-cli" ? "grok" : s.origin === "pi" ? "pi"
        : s.facts.account && s.facts.account !== "claude" ? `claude-${s.facts.account}` : "claude";
      return [session(s, "tool-home", "tool", value)];
    },
  },
  {
    id: "app-runner",
    about: "what ran the session: T3 (its thread, or the tool's word for T3), the tool's own app, a terminal, or a program with nobody at it",
    tag(s, c) {
      if (s.origin === "grok-bot") return [session(s, "app-runner", "app", "g-app")];
      if (threadOf(s, c) || s.entrypoint === "t3-code" || s.entrypoint === "t3code_desktop" || s.entrypoint === "T3 Code") return [session(s, "app-runner", "app", "t3")];
      const app = { "claude-desktop": "claude-desktop", cli: "terminal", "codex-tui": "terminal", "Codex Desktop": "codex-desktop", codex_work_desktop: "codex-desktop", codex_vscode: "vscode", "codex-chrome-extension-sidepanel": "chrome", interactive: "terminal", pi: "terminal" }[s.entrypoint];
      if (app) return [session(s, "app-runner", "app", app)];
      if (isHeadless(s)) return [session(s, "app-runner", "app", "program")];
      return [];
    },
  },
  {
    id: "project-path",
    about: "the project, from the folder the session ran in (a treehouse worktree's, the orchestrator's projects, ~/Projects)",
    tag(s, c) {
      const project = projectOf(s.project, c.orchestrator);
      return project ? [session(s, "project-path", "project", project)] : [];
    },
  },
];

/**
 * Every rule's tags for one session; a device only on a prompt a person sent (its who, as the rules rank it: a fact
 * before a guess, then by RULES' order, as tags.ts chooses).
 */
export function tagsOf(s: SessionRecord, c: RuleContext): Proposal[] {
  const kind = sessionKindOf(s, c);
  const all = RULES.flatMap((rule) => rule.tag(s, c, kind));
  const rank = (p: Proposal) => Number(p.guess) * RULES.length + RULES.findIndex((r) => r.id === p.rule);
  const who = new Map<number, Proposal>();
  for (const p of all) if (p.family === "who" && (!who.has(p.targetId) || rank(p) < rank(who.get(p.targetId)!))) who.set(p.targetId, p);
  return all.filter((p) => p.family !== "device" || who.get(p.targetId)?.value === "human");
}
