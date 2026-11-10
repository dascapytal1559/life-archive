// `npm run archive -- mcp ...` (server/archive/cli.ts hands it on): the agents' keys and their calls (keys.ts). A key is
// printed once, as it is made, and kept nowhere but as its hash; give it to the agent the way docs/agents.md says, and
// never commit it. A key added, granted or removed counts at the agents' door at once, with no restart.

import { when as localWhen } from "../archive/changesCli.ts";
import { InvalidInputError } from "../errors.ts";
import { MCP_PATH } from "./http.ts";
import type { McpKeys, ToolCallRecord } from "./keys.ts";

export const MCP_HELP = `Agents (the archive's MCP door at ${MCP_PATH}; docs/agents.md):
  mcp key add <agent> [--grant <grant> ...]
                                        a key for an agent (claude-code, codex, g), printed once: it reads facts, and
                                        each grant adds content or writes, for every module (content, write) or one
                                        (content:rituals, write:rituals)
  mcp key list                          every agent's key: its grants, when it was made and last used
  mcp key grant <agent> <grant ...>     what a key may do, added to; mcp key ungrant <agent> <grant ...> takes it away
  mcp key replace <agent>               a new key for the agent, its grants kept; the old one stops working at once
  mcp key remove <agent>                the agent's key gone, at once; its calls stay in the log
  mcp calls [--agent <agent>] [--last <n>]
                                        the agents' calls, the latest first (50 unless said): when, who, which tool,
                                        how it went (never what a content tool answered)`;

/** A time in the archive's zone, as the change log prints one; "never" for none. */
const when = (ms: number | null) => (ms === null ? "never" : localWhen(ms));

/** One call, as `mcp calls` prints it. */
export const callLine = (call: ToolCallRecord): string =>
  `${when(call.at)}  ${call.agent}  ${call.tool} (${call.module}, ${call.access})  ${call.ok ? "ok" : `failed: ${call.error}`}  ${call.durationMs} ms  ${JSON.stringify(call.arguments)}`;

/** Runs `mcp <args>` over `keys`, printing with `print`. */
export function mcpCommand(keys: McpKeys, args: readonly string[], values: { grant?: string[]; agent?: string; last?: string }, now: number, print: (line: string) => void = console.log): void {
  const [what, verb, agent, ...rest] = args;
  if (what === "calls") {
    const last = values.last === undefined ? 50 : Number(values.last);
    if (!Number.isSafeInteger(last) || last < 1) throw new InvalidInputError("--last takes a number of calls, 1 or more");
    const calls = keys.calls({ agent: values.agent ?? null, last });
    for (const call of calls) print(callLine(call));
    print(calls.length === 0 ? "No agent has called a tool yet." : `${calls.length} shown, the latest first.`);
    return;
  }
  if (what !== "key") throw new InvalidInputError(`mcp takes key or calls\n\n${MCP_HELP}`);
  if (verb === "list") {
    const all = keys.list();
    for (const key of all) print(`${key.agent}  ${key.grants.length ? key.grants.join(", ") : "facts only"}  made ${when(key.createdAt)}, last used ${when(key.lastUsedAt)}`);
    print(all.length === 0 ? "No agent has a key yet: mcp key add <agent> makes one." : `${all.length} ${all.length === 1 ? "key" : "keys"}.`);
    return;
  }
  if (!agent) throw new InvalidInputError(`name the agent: mcp key ${verb ?? "add"} <agent>`);
  switch (verb) {
    case "add": {
      const key = keys.add(agent, values.grant ?? [], now);
      const made = keys.find(agent)!;
      print(`A key for ${agent} (${made.grants.length ? `facts, and ${made.grants.join(", ")}` : "facts only"}). It is shown this once and kept nowhere; give it to the agent and never commit it:`);
      print("");
      print(key);
      return;
    }
    case "replace": {
      const key = keys.replace(agent, now);
      print(`A new key for ${agent}; the old one no longer works. It is shown this once:`);
      print("");
      print(key);
      return;
    }
    case "grant":
    case "ungrant": {
      if (rest.length === 0) throw new InvalidInputError(`name a grant: mcp key ${verb} ${agent} content:rituals`);
      const grants = verb === "grant" ? keys.grant(agent, rest) : keys.ungrant(agent, rest);
      print(`${agent} may now read facts${grants.length ? `, and ${grants.join(", ")}` : ", and nothing more"}.`);
      return;
    }
    case "remove":
      keys.remove(agent);
      print(`${agent}'s key is removed and no longer works; its calls stay in the log.`);
      return;
    default:
      throw new InvalidInputError(`mcp key takes add, list, grant, ungrant, replace or remove\n\n${MCP_HELP}`);
  }
}
