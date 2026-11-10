// What an agent's tool is (docs/agents.md): the core's own (coreTools.ts) and each module's, which a module declares
// beside its routes, pages and tabs (sdk/server.ts's `agents`), so a new module brings its tools with no change here.
//
// A tool has a name, the words an agent reads (its title and description, which start_here lists too), its input as
// Effect Schema fields (the SDK checks a call against them, and lists them as JSON Schema), what it needs (`access`)
// and an Effect program that answers. Access is one of three, the privacy policy's layers (server/privacy/policy.ts):
//
//   facts     metadata, open to every key: names, times, counts, statuses, the calendar's titles
//   content   what was said and written (a report's words, a note, a check's text): only for a key granted it, and every
//             call kept in the trail of content reads with the captain's words for it (the core adds a `why` to the input)
//   write     a change to a store (a habit logged): only for a key granted it
//
// A grant is the access alone (`content`, every module's) or the access for one module (`write:rituals`); facts need
// none. What a key is granted is keys.ts's to keep.

import { Data, Schema, type Effect } from "effect";
import type { ReadScope } from "../archive/contentLog.ts";
import type { RouteError } from "../errors.ts";

export const ACCESS = ["facts", "content", "write"] as const;
export type Access = (typeof ACCESS)[number];

/** The module the core's own tools are filed under: the archive itself. */
export const CORE_TOOLS = "core";

/** Who is calling: the agent its key is for, and what that key was granted beyond facts. */
export interface ToolCall {
  readonly agent: string;
  readonly grants: readonly string[];
}

/** A tool's expected refusal, said to the agent as it is ("no rituals store in this archive", "to is before from"). */
export class ToolRefused extends Data.TaggedError("ToolRefused")<{ readonly message: string }> {}

/** One tool, as the core holds it whatever its input: what defineTool makes. */
export interface AgentTool<R = never> {
  /** Unique across the archive, snake_case, the module's id first (rituals_status); the core's own have none. */
  readonly name: string;
  readonly title: string;
  /** What it does and answers, for the agent: a sentence or a few. */
  readonly description: string;
  readonly access: Access;
  /** Its input, as Effect Schema fields: a Struct's, so the core can add `why` to a content tool's. */
  readonly input: Schema.Struct.Fields;
  readonly run: (input: never, call: ToolCall) => Effect.Effect<unknown, ToolRefused | RouteError, R>;
  /**
   * For a content or write tool: what a call is about, in facts alone (`{"op": "ritual_checklist", "date": "2026-11-07"}`),
   * kept in the call log in place of its arguments (which are otherwise kept with every text as its length), and for
   * content in the trail of content reads.
   */
  readonly scope?: (input: never) => ReadScope;
}

/** A tool, its `run` and `scope` given its input as its fields decode it. */
export function defineTool<const F extends Schema.Struct.Fields, R = never>(tool: {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly access: Access;
  readonly input: F;
  readonly run: (input: Schema.Struct.Type<F>, call: ToolCall) => Effect.Effect<unknown, ToolRefused | RouteError, R>;
  readonly scope?: (input: Schema.Struct.Type<F>) => ReadScope;
}): AgentTool<R> {
  return tool as unknown as AgentTool<R>;
}

/** What a module offers agents (sdk/server.ts's `agents`): what it holds, in a sentence or two for start_here, and its tools. */
export interface ModuleAgents<R = never> {
  readonly about: string;
  readonly tools: readonly AgentTool<R>[];
}

/** A tool's name: lower-case words joined by underscores. */
export const TOOL_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** A grant as written (`content`, `write:rituals`); null when it is not one. */
export function readGrant(text: string): { access: Exclude<Access, "facts">; module: string | null } | null {
  const match = /^(content|write)(?::([a-z0-9][a-z0-9-]*))?$/.exec(text.trim());
  return match ? { access: match[1] as Exclude<Access, "facts">, module: match[2] ?? null } : null;
}

/** Whether `grants` let a key call a tool of `module` that needs `access`: facts always, else the access or the access for that module. */
export function allows(grants: readonly string[], access: Access, module: string): boolean {
  return access === "facts" || grants.includes(access) || grants.includes(`${access}:${module}`);
}

/** The grant a key needs for a tool of `module` that needs `access`, as start_here names it; null for facts. */
export const neededGrant = (access: Access, module: string): string | null => (access === "facts" ? null : `${access}:${module}`);

/**
 * The tool's input as the SDK takes it: a Struct of its fields as a standard schema, which checks a call (`validate`)
 * and lists it as JSON Schema (`jsonSchema`): the second wrapping the first, since each adds its own part alone.
 */
export const inputSchema = (fields: Schema.Struct.Fields) =>
  // A tool's fields need no services to decode (they are plain values), which a Struct of any fields cannot say.
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(Schema.Struct(fields) as unknown as Schema.Struct<{}>));
