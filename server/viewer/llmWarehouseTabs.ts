// The LLM warehouse's tables (server/llm/; docs/events.md's "The LLM warehouse"), which the Events page's Tables lists after
// LLM: Prompts (every prompt of every LLM tool's sessions, with who sent it, from which device, how, and its
// session's tool, app, kind, task and project: the chart counts them over time, split by any of those, phone against
// desktop, the captain against firstmate's delegation), Agent sessions (every session, with its measures: prompts,
// replies, tokens, cost) and LLM tags (every tag, its rule and whether it is a guess, chosen or his own). Each is one
// SELECT over the core's database (server/llm/views.ts), whose rows the calendar does not hold; structure only,
// never a word of content. A row's drawer is its event's, as the LLM table's is.

import { LOCALE } from "../../src/time.ts";
import { LLM_APPS } from "../calendar/eventIndex.ts";
import { CORE } from "../calendar/rows.ts";
import { PROMPTS_SQL, SESSIONS_SQL, TAGS_SQL } from "../llm/views.ts";
import { sourceTab, type ChoiceFilter, type SourceRow } from "./sourceTab.ts";

/** What a tag's value is called on the page; one not named here is shown as it is. */
const VALUE_NAMES: Record<string, string> = {
  "": "Not known",
  human: "The captain", firstmate: "firstmate", worker: "A worker", agent: "Another agent", system: "System",
  desktop: "Desktop", phone: "Phone", tablet: "Tablet", terminal: "Terminal", unknown: "Not known",
  typed: "Typed", voice: "Voice", command: "Slash command", "initial-instructions": "Launch brief", "inbox-note": "Inbox note", steer: "Steer",
  "decision-reply": "Decision reply", "wake-up": "Wake-up", hook: "Hook", notification: "Notice", "agent-message": "Agent message", continuation: "Continued session",
  claude: "Claude Code", codex: "Codex", grok: "Grok CLI", pi: "Pi", g: "G (Grok Bot)",
  t3: "T3", "claude-desktop": "Claude desktop app", "codex-desktop": "Codex desktop app", vscode: "VS Code", chrome: "Chrome", "g-app": "Grok Bot app", program: "A program",
  own: "His own", "firstmate-main": "firstmate's own", secondmate: "A secondmate", decision: "A decision", "review-pipeline": "Review pipeline", helper: "A helper",
  "app-internal": "An app's own",
};
/** A tag's value as the page names it: a Claude Code profile's tool tag (claude-<profile>, rules.ts) by its profile's name. */
const named = (value: string) => VALUE_NAMES[value] ?? (value.startsWith("claude-") ? `Claude Code (${value.slice("claude-".length)})` : value);

const tagFilter = (key: string, label: string, expr = key, order?: readonly string[]): ChoiceFilter => ({ key, label, kind: "choice", expr, name: named, ...(order ? { order } : {}) });
const WHO = ["human", "firstmate", "worker", "agent", "system", ""];
const DEVICE = ["desktop", "phone", "tablet", "terminal", "unknown", ""];

export const PROMPTS = sourceTab({
  kind: "prompts",
  label: "Prompts",
  noun: ["prompt", "prompts"],
  module: CORE,
  over: "core",
  columns: [
    { key: "when", label: "When", kind: "time", width: 175, sortable: true },
    { key: "who", label: "Who", kind: "text", width: 120 },
    { key: "device", label: "Device", kind: "text", width: 100 },
    { key: "channel", label: "How", kind: "text", width: 130 },
    { key: "tool", label: "Tool", kind: "text", width: 150 },
    { key: "app", label: "App", kind: "text", width: 130 },
    { key: "kind", label: "Session", kind: "text", width: 130 },
    { key: "project", label: "Project", kind: "text", width: 130 },
    { key: "task", label: "Task", kind: "text", width: 170 },
    { key: "chars", label: "Characters", kind: "count", width: 105, numeric: true, sortable: true },
  ],
  sort: "when",
  splits: ["who", "device", "channel", "tool", "app", "kind", "project"],
  sorts: { when: "at", chars: "chars" },
  source: PROMPTS_SQL,
  filters: [
    tagFilter("who", "Who", "who", WHO),
    tagFilter("device", "Device", "device", DEVICE),
    tagFilter("channel", "How"),
    tagFilter("tool", "Tool"),
    tagFilter("app", "App"),
    tagFilter("kind", "Session", "session_kind"),
    tagFilter("project", "Project"),
    tagFilter("task", "Task"),
    { key: "origin", label: "Origin", kind: "choice", expr: "origin", name: (value) => LLM_APPS[value] ?? value },
  ],
  measures: [
    { key: "prompts", label: "Prompts", unit: "count", expr: "count(r.id)" },
    { key: "characters", label: "Characters", unit: "characters", expr: "coalesce(sum(r.chars), 0)" },
  ],
  row: (raw: SourceRow) => ({
    id: String(raw.id),
    cells: {
      when: raw.at, who: named(String(raw.who)), device: raw.device ? named(String(raw.device)) : null, channel: raw.channel ? named(String(raw.channel)) : null,
      tool: raw.tool ? named(String(raw.tool)) : null, app: raw.app ? named(String(raw.app)) : null, kind: raw.session_kind ? named(String(raw.session_kind)) : null,
      project: raw.project || null, task: raw.task || null, chars: raw.chars,
    },
  }),
});

const dollars = (value: string | number | null) => (value === null ? null : `$${Number(value).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export const AGENT_SESSIONS = sourceTab({
  kind: "agent-sessions",
  label: "Agent sessions",
  noun: ["agent session", "agent sessions"],
  module: CORE,
  over: "core",
  columns: [
    { key: "when", label: "When", kind: "time", width: 175, sortable: true },
    { key: "kind", label: "Session", kind: "text", width: 130 },
    { key: "tool", label: "Tool", kind: "text", width: 150 },
    { key: "app", label: "App", kind: "text", width: 130 },
    { key: "project", label: "Project", kind: "text", width: 130 },
    { key: "task", label: "Task", kind: "text", width: 170 },
    { key: "model", label: "Model", kind: "text", width: 160 },
    { key: "prompts", label: "Prompts", kind: "count", width: 90, numeric: true, sortable: true },
    { key: "replies", label: "Replies", kind: "count", width: 90, numeric: true },
    { key: "tokens", label: "Tokens", kind: "count", width: 120, numeric: true, sortable: true },
    { key: "cost", label: "Cost", kind: "text", width: 90, numeric: true },
    { key: "length", label: "Length", kind: "duration", width: 100, numeric: true, sortable: true },
  ],
  sort: "when",
  splits: ["kind", "tool", "app", "project"],
  sorts: { when: "at", prompts: "prompts", tokens: "coalesce(input_tokens, 0) + coalesce(output_tokens, 0)", length: "seconds" },
  source: SESSIONS_SQL,
  filters: [
    tagFilter("kind", "Session", "session_kind"),
    tagFilter("tool", "Tool"),
    tagFilter("app", "App"),
    tagFilter("project", "Project"),
    tagFilter("task", "Task"),
    { key: "model", label: "Model", kind: "choice", expr: "coalesce(model, '')", name: (value) => value || "Not known" },
    { key: "origin", label: "Origin", kind: "choice", expr: "origin", name: (value) => LLM_APPS[value] ?? value },
  ],
  measures: [
    { key: "sessions", label: "Sessions", unit: "count", expr: "count(r.id)" },
    { key: "prompts", label: "Prompts", unit: "count", expr: "coalesce(sum(r.prompts), 0)" },
    { key: "tokens", label: "Tokens", unit: "count", expr: "coalesce(sum(coalesce(r.input_tokens, 0) + coalesce(r.output_tokens, 0)), 0)" },
    { key: "output", label: "Tokens written", unit: "count", expr: "coalesce(sum(r.output_tokens), 0)" },
  ],
  row: (raw: SourceRow) => ({
    id: String(raw.id),
    cells: {
      when: raw.at, kind: raw.session_kind ? named(String(raw.session_kind)) : null, tool: raw.tool ? named(String(raw.tool)) : null,
      app: raw.app ? named(String(raw.app)) : null, project: raw.project || null, task: raw.task || null, model: raw.model || null,
      prompts: raw.prompts, replies: raw.replies,
      tokens: raw.input_tokens === null && raw.output_tokens === null ? null : Number(raw.input_tokens ?? 0) + Number(raw.output_tokens ?? 0),
      cost: dollars(raw.cost_usd), length: raw.seconds,
    },
  }),
});

const TARGETS: Record<string, string> = { session: "Session", turn: "Prompt" };
const STRENGTHS = ["fact", "guess", "by hand"];

export const LLM_TAGS = sourceTab({
  kind: "llm-tags",
  label: "LLM tags",
  noun: ["LLM tag", "LLM tags"],
  module: CORE,
  over: "core",
  columns: [
    { key: "when", label: "When", kind: "time", width: 175, sortable: true },
    { key: "target", label: "On", kind: "text", width: 90 },
    { key: "family", label: "Family", kind: "text", width: 100 },
    { key: "value", label: "Value", kind: "text", width: 170 },
    { key: "rule", label: "Rule", kind: "text", width: 140 },
    { key: "strength", label: "Strength", kind: "text", width: 90 },
    { key: "chosen", label: "Chosen", kind: "text", width: 80 },
  ],
  sort: "when",
  splits: ["family", "rule", "strength"],
  sorts: { when: "at" },
  source: TAGS_SQL,
  filters: [
    { key: "target", label: "On", kind: "choice", expr: "target", name: (value) => TARGETS[value] ?? value },
    { key: "family", label: "Family", kind: "choice", expr: "family", name: (value) => value },
    { key: "value", label: "Value", kind: "choice", expr: "value", name: named },
    { key: "rule", label: "Rule", kind: "choice", expr: "rule", name: (value) => value },
    { key: "strength", label: "Strength", kind: "choice", expr: "strength", name: (value) => value, order: STRENGTHS },
    { key: "chosen", label: "Chosen", kind: "choice", expr: "CAST(chosen AS TEXT)", name: (value) => (value === "1" ? "Chosen" : "Passed over") },
  ],
  measures: [{ key: "tags", label: "Tags", unit: "count", expr: "count(r.id)" }],
  row: (raw: SourceRow) => ({
    id: String(raw.id),
    cells: {
      when: raw.at, target: TARGETS[String(raw.target)] ?? String(raw.target), family: String(raw.family), value: named(String(raw.value)),
      rule: String(raw.rule), strength: String(raw.strength), chosen: raw.chosen === 1 ? "Chosen" : "—",
    },
  }),
});
