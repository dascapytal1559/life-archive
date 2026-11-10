# Agents: the MCP door

The archive answers agents directly, as an [MCP](https://modelcontextprotocol.io) server, so any agent that speaks MCP
(Claude Code, Codex, Grok's command line, Grok Bot, one written next year) connects with one line: the archive's
address and a key of its own. It needs no path to this checkout and no copy of any instructions: its first call,
`start_here`, answers what the archive holds today, what each tool does, what its key may do and the rules, made fresh
from the modules switched on. Switch a module on, and every agent sees its tools on its next call.

The code is `server/mcp/` (the door, the keys, the guide and the core's own tools) and each module's `agents` in its
`module.ts` (see "How a module adds tools").

## Where it answers

The door is `/life-archive/mcp` on the archive's own server, beside the viewer, so it is reached wherever the viewer is:

- on the machine itself: `http://127.0.0.1:4650/life-archive/mcp` (the port `LIFE_ARCHIVE_URL` names);
- from another of your devices, through Tailscale Serve's mount of `/life-archive`:
  `https://<machine>.<tailnet>.ts.net/life-archive/mcp`, the name in `LIFE_ARCHIVE_ALLOWED_HOSTS` (SETUP.md's "Keep it
  running").

It speaks Streamable HTTP, statelessly, in both the 2026-07-28 protocol and the 2025 ones before it (Grok's command
line connects with the first; a client that has not moved to it yet, with the second), through the official TypeScript SDK
(`@modelcontextprotocol/server` and `@modelcontextprotocol/node`). Each request is answered by a server made for its
key, so one restart of the archive never leaves an agent with a session to lose.

## Two locks

- **The outer lock is the server's own**: it answers only on 127.0.0.1, only to a Host name it admits (localhost and
  `LIFE_ARCHIVE_ALLOWED_HOSTS`), and the tailnet decides who reaches that name. A request with a browser's `Origin` from
  another site is refused (403), so no web page can reach the door from a browser on your network.
- **The inner lock is the key**: every request carries `Authorization: Bearer <key>`, and one without a key, or with a
  key that is not one of the archive's, is refused (401). A key says which agent is calling and what it may do.

## Keys and grants

Each agent has a key of its own, made on the machine with the archive's command, printed once and kept only as its
SHA-256 in the core's database (`core.sqlite`, table `mcp_key`), never in git:

```sh
npm run archive -- mcp key add claude-code                       # facts only
npm run archive -- mcp key add g --grant content:rituals --grant write:rituals
npm run archive -- mcp key list
npm run archive -- mcp key grant codex content:rituals           # and ungrant to take it back
npm run archive -- mcp key replace g                             # a new key; the old one stops at once
npm run archive -- mcp key remove g
npm run archive -- mcp calls --agent g --last 20
```

What a key may do follows the privacy policy's layers (`docs/privacy.md`):

| Access | What | Who |
| --- | --- | --- |
| **facts** | metadata: names, times, durations, counts, statuses, the calendar's titles | every key |
| **content** | what was said and written: a report's words, a check's text, a note, a message | a key granted `content`, or `content:<module>` for one module |
| **write** | a change to a store, such as a habit logged | a key granted `write`, or `write:<module>` |

A key sees only the tools it may call; `start_here` lists the rest, each with the grant it needs. A content tool
takes `why`, the owner's own words for what they asked the agent for, and every content call is kept in the trail of
content reads (`npm run archive -- content-log`: surface `mcp`, the reader the key's agent). A change to a key counts
at once, with no restart.

## Connecting an agent

Every example below uses a made-up key; use the one `mcp key add` printed, and keep it out of any file you commit.

**Claude Code**:

```sh
claude mcp add --transport http life-archive http://127.0.0.1:4650/life-archive/mcp \
  --header "Authorization: Bearer la_mcp_EXAMPLEexampleEXAMPLEexampleEXAMPLE00000"
```

**Codex**, with the key in an environment variable it reads (`~/.codex/config.toml` gets the server):

```sh
codex mcp add life-archive --url http://127.0.0.1:4650/life-archive/mcp --bearer-token-env-var LIFE_ARCHIVE_MCP_KEY
export LIFE_ARCHIVE_MCP_KEY=la_mcp_EXAMPLEexampleEXAMPLEexampleEXAMPLE00000
```

**Grok's command line**:

```sh
grok mcp add --transport http life-archive http://127.0.0.1:4650/life-archive/mcp \
  --header "Authorization: Bearer la_mcp_EXAMPLEexampleEXAMPLEexampleEXAMPLE00000"
grok mcp doctor        # handshake OK, and the tools it found
```

**Grok Bot, or any app with an MCP settings page**: a server of type HTTP (Streamable HTTP) at the address above,
with the header `Authorization: Bearer <key>`. As JSON, for an app that takes one:

```json
{ "mcpServers": { "life-archive": { "type": "http", "url": "http://127.0.0.1:4650/life-archive/mcp", "headers": { "Authorization": "Bearer la_mcp_EXAMPLEexampleEXAMPLEexampleEXAMPLE00000" } } } }
```

**Anything with a shell**, no MCP needed: the door is stateless, so one POST is one call.

```sh
curl -s http://127.0.0.1:4650/life-archive/mcp -H "Authorization: Bearer $LIFE_ARCHIVE_MCP_KEY" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"start_here","arguments":{}}}'
```

From another device, use the tailnet address in place of `http://127.0.0.1:4650`.

## The tools

| Tool | Part | Access | What it answers |
| --- | --- | --- | --- |
| `start_here` | core | facts | the guide: what the archive holds, every tool and what it needs, this key's grants, the rules (also the resource `life-archive://start-here`) |
| `calendar_day` | core | facts | one day, 06:00 to 06:00, as the Events calendar shows it: messages and with whom, agent messages, rituals, and each call, hangout, agent session, workout and habit done |
| `rituals_status` | rituals | facts | a ritual day's standing (today's unless named): each habit's status and how it is known, the required checks by id, whether the ritual is complete |
| `rituals_help` | rituals | facts | ritualctl's requests with templates, and rituals' logging rules |
| `rituals_read` | rituals | content | any read request ritualctl answers, whole (a checklist with its items' words, workouts with their details) |
| `rituals_write` | rituals | write | any write request ritualctl answers (`ritual_put`, `workout_add`, `attachment_check`, ...), with its acknowledgement's facts alone (the record's id or date, its revision, whether it replayed): the record itself is read back through `rituals_read` |
| `exercise_activities` | exercise | facts | the activities over a range of days: when, the sport, how far and long, what recorded it, minutes in zone 2 |
| `exercise_pillars` | exercise | facts | a week's five pillars (Strength Training, Low Intensity Cardio, High Intensity Cardio, Mobility & Flexibility, Balance), as Fitness's Bryan Johnson tab counts them, each against its target |

Rituals' reads and writes go through `bin/ritualctl` itself, run by the server with the store's root named, so its
rules, idempotency, revisions, backups and audit stay rituals' own. Minutes in a heart-rate zone are counts of
minutes, not heart rates, so they are facts here, as on Fitness's Bryan Johnson tab; a heart rate, a route and the owner's own
words about a workout are content, and no facts tool answers them.

What could follow, each from its module: friend map's people and counts (a person by name with their accounts, tags
and last contact; messages and calls per person over a range: facts) and its timeline and search (content, as the
CLI's are); the journal's days with an entry and their lengths (facts) and an entry's text (content); health's results
by test and date, judged against their ranges (facts), and a document's text (content).

## What it keeps

Every tool call is kept in `core.sqlite`'s `mcp_call` table: when (`at`, ms), which `agent`, which `tool` of which
`module`, its `access`, whether it went well (`ok`, and its `error`: the one the agent was told for a facts tool, a
content or write tool's by its kind alone, such as `ToolRefused`, never its words), how long it took (`duration_ms`),
and its arguments (`arguments_json`: a facts tool's whole; a content or write tool's as the tool's own summary of what
the call was about, such as `{"op": "ritual_put", "date": "2026-11-07"}`, never the words it carried). A content
tool's call is kept in the trail of content reads whether it answered or was refused, and while the trail is not open
no content tool answers at all.
It is metadata: the transcript warehouse reads it to tag an agent's calls by agent and time.

## How a module adds tools

A module declares its tools in `module.ts`, beside its routes, pages and tabs, and the core changes nowhere:

```ts
import { defineModule, defineTool, Effect, Schema } from "../../sdk/server.ts";

export default defineModule({
  id: "garden",
  sdk: 1,
  agents: ({ folder }) => ({
    about: "What was planted where, and when it was watered.",
    tools: [
      defineTool({
        name: "garden_beds",                       // snake_case, the module's id first
        title: "The beds",
        description: "Every bed, what grows in it and when it was last watered.",
        access: "facts",                           // facts, content or write
        input: { bed: Schema.optionalKey(Schema.String) },
        run: ({ bed }) => Effect.succeed({ bed: bed ?? null }),
      }),
    ],
  }),
});
```

- `agents` is given what the module's routes are given (its folder, its database, the archive's calendar), and a
  tool's `run` is an Effect program run with the same services as the routes; it fails with `ToolRefused` (or a route's
  error) for what the agent should be told.
- A tool whose name is not snake_case, does not begin with its module's id, or is taken is left out, and the server's
  log says so.
- A content or write tool gives `scope`, what a call is about in facts alone, for the call log and the trail.
- A module switched off offers nothing, and `start_here` names it as switched off.
