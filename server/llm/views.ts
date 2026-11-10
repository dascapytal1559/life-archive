// The warehouse's rows as the views read them (the viewer's Prompts and Agent sessions tables, server/viewer/
// llmWarehouseTabs.ts, and `npm run llm -- summary`): one SELECT each over the core's database, each row with its
// families' chosen tags (tags.ts) as columns, a prompt's own (who, device, channel) and its session's (tool, app,
// session, task, project). Structure only: never a word of content.

/** The chosen value of `family` on the session `id` (an llm_session.id). */
const sessionTag = (family: string, id: string) =>
  `(SELECT value FROM llm_tag WHERE target = 'session' AND target_id = ${id} AND family = '${family}' AND chosen = 1)`;
const turnTag = (family: string, id: string) =>
  `(SELECT value FROM llm_tag WHERE target = 'turn' AND target_id = ${id} AND family = '${family}' AND chosen = 1)`;

/** Each prompt: its event, session, time, length, pictures, and its and its session's chosen tags. */
export const PROMPTS_SQL = `
  SELECT e.id, e.origin, e.native_id, e.kind, e.at, e.size AS chars, t.images, t.model, se.native_id AS session, se.id AS session_event, s.project AS folder,
    coalesce(${turnTag("who", "t.id")}, '') AS who, coalesce(${turnTag("device", "t.id")}, '') AS device, coalesce(${turnTag("channel", "t.id")}, '') AS channel,
    coalesce(${sessionTag("tool", "s.id")}, '') AS tool, coalesce(${sessionTag("app", "s.id")}, '') AS app, coalesce(${sessionTag("session", "s.id")}, '') AS session_kind,
    coalesce(${sessionTag("task", "s.id")}, '') AS task, coalesce(${sessionTag("project", "s.id")}, '') AS project
  FROM event e
  JOIN llm_turn t ON e.detail = 'llm_turn' AND t.id = e.detail_id AND t.role = 'prompt'
  JOIN llm_session s ON s.id = t.session_id
  JOIN event se ON se.detail = 'llm_session' AND se.detail_id = s.id
  WHERE e.kind = 'llm_prompt'`;

/** Each session: its event, time, length, measures, prompt and reply counts, and its chosen tags. */
export const SESSIONS_SQL = `
  SELECT e.id, e.origin, e.native_id, e.kind, e.at, e.at_end, coalesce(e.subkind, '') AS how, s.project AS folder, s.model,
    CASE WHEN e.at_end IS NULL THEN NULL ELSE (e.at_end - e.at) / 1000.0 END AS seconds,
    (SELECT count(*) FROM llm_turn x WHERE x.session_id = s.id AND x.role = 'prompt') AS prompts,
    (SELECT count(*) FROM llm_turn x WHERE x.session_id = s.id AND x.role = 'reply') AS replies,
    s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cost_usd, s.images, s.tool_calls,
    coalesce(${sessionTag("tool", "s.id")}, '') AS tool, coalesce(${sessionTag("app", "s.id")}, '') AS app, coalesce(${sessionTag("session", "s.id")}, '') AS session_kind,
    coalesce(${sessionTag("task", "s.id")}, '') AS task, coalesce(${sessionTag("project", "s.id")}, '') AS project
  FROM event e JOIN llm_session s ON e.detail = 'llm_session' AND s.id = e.detail_id
  WHERE e.kind = 'llm_session'`;

/** Each tag: what it is on (the session's or turn's event), its family and value, its rule, and whether it is a guess, chosen or the captain's. */
export const TAGS_SQL = `
  SELECT g.id, ev.origin, ev.native_id, ev.kind, ev.at, ev.id AS event, g.target, g.family, g.value, g.rule,
    CASE WHEN g.rule = 'hand' THEN 'by hand' WHEN g.guess = 1 THEN 'guess' ELSE 'fact' END AS strength, g.chosen
  FROM llm_tag g
  JOIN event ev ON ev.detail = CASE g.target WHEN 'session' THEN 'llm_session' ELSE 'llm_turn' END AND ev.detail_id = g.target_id`;
