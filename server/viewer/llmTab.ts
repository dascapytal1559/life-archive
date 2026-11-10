// The viewer's LLM tab: the conversations with an LLM, one row for each session, prompt and reply, as the core pushed
// them into the calendar from the event index (server/calendar/eventIndex.ts): when, what kind, how it was run or what
// started it, the app, the project folder, the model, how many characters (a session's, all its prompts' and replies'
// together) and how long. Never the words: they stay in the session files, and only the content path reads them
// (archive/llmContent.ts); the drawer, which the core's owner adds to, says where, not what.

import { folderName, LLM_APPS } from "../calendar/eventIndex.ts";
import { CORE } from "../calendar/rows.ts";
import { sourceTab, type SourceRow } from "./sourceTab.ts";

/** Each LLM event from the calendar: its kind, how, app, project, model, characters, length, and its session (by the session's own id, named by its folder and day). */
const SOURCE = `
  SELECT e.id, e.origin, e.native_id, e.kind, e.at, e.at_end, coalesce(e.subkind, '') AS how, e.origin AS app,
    e.facts ->> '$.session' AS session, e.facts ->> '$.session_name' AS session_name, e.facts ->> '$.project' AS project,
    e.facts ->> '$.model' AS model, e.facts ->> '$.chars' AS chars,
    CASE WHEN e.at_end IS NULL THEN NULL ELSE (e.at_end - e.at) / 1000.0 END AS seconds
  FROM event e WHERE e.kind IN ('llm_session', 'llm_prompt', 'llm_reply')`;

const KINDS: Record<string, string> = { llm_session: "Session", llm_prompt: "Prompt", llm_reply: "Reply" };
/** How a session was run, or what started a reply's turn, in the tool's words. */
const HOW: Record<string, string> = {
  cli: "In a terminal", "claude-desktop": "In the desktop app", "sdk-cli": "Run by a program",
  chat: "In the chat window", call: "On a call", backstage: "Backstage on a call",
  human: "To a prompt", "task-notification": "To a notification", agent: "To another agent", unseen: "To what came before",
  "call-start": "Opening a call", "": "—",
};
const name = (names: Record<string, string>) => (value: string) => names[value] ?? value;

export const LLM = sourceTab({
  kind: "llm",
  label: "LLM",
  noun: ["LLM event", "LLM events"],
  module: CORE,
  columns: [
    { key: "when", label: "When", kind: "time", width: 175, sortable: true },
    { key: "kind", label: "Kind", kind: "text", width: 85 },
    { key: "how", label: "How", kind: "text", width: 150 },
    { key: "project", label: "Project", kind: "text", width: 140 },
    { key: "model", label: "Model", kind: "text", width: 160 },
    { key: "chars", label: "Characters", kind: "count", width: 105, numeric: true, sortable: true },
    { key: "length", label: "Length", kind: "duration", width: 100, numeric: true, sortable: true },
    { key: "session", label: "Session", kind: "link", width: 210 },
  ],
  sort: "when",
  splits: ["kind", "how", "model", "project"],
  sorts: { when: "at", chars: "chars", length: "seconds" },
  source: SOURCE,
  filters: [
    { key: "kind", label: "Kind", kind: "choice", expr: "kind", name: name(KINDS), order: Object.keys(KINDS) },
    { key: "how", label: "How", kind: "choice", expr: "how", name: name(HOW), order: Object.keys(HOW) },
    { key: "app", label: "App", kind: "choice", expr: "app", name: name(LLM_APPS), order: Object.keys(LLM_APPS) },
    { key: "project", label: "Project", kind: "choice", expr: "project", name: folderName },
    { key: "model", label: "Model", kind: "choice", expr: "model", name: (value) => value || "Not known" },
    { key: "session", label: "Session", kind: "choice", expr: "session", labelExpr: "session_name", name: (value) => `Session ${value}` },
  ],
  measures: [
    { key: "events", label: "Events", unit: "count", expr: "count(r.id)" },
    // A session's characters are its turns', so only the turns are added up.
    { key: "characters", label: "Characters", unit: "characters", expr: "coalesce(sum(CASE WHEN r.kind != 'llm_session' THEN r.chars END), 0)" },
  ],
  row: (raw: SourceRow) => ({
    id: String(raw.id),
    cells: {
      when: raw.at,
      kind: KINDS[String(raw.kind)] ?? String(raw.kind),
      how: HOW[String(raw.how)] ?? String(raw.how),
      project: raw.project === null ? null : folderName(String(raw.project)),
      model: raw.model || null,
      chars: raw.chars,
      length: raw.seconds,
      session: raw.session === null ? null : { filter: "session", value: String(raw.session), label: String(raw.session_name) },
    },
  }),
});
