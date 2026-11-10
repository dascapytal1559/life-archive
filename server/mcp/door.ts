// The agents' door as the server builds it (serverLayer.ts's Http): the core's part (start_here and calendar_day) and
// each loaded module's (sdk/server.ts's `agents`, given what the module's routes are given), in the order the modules
// load; a tool whose name is not snake_case, does not begin with its module's id, or is taken already is left out, and
// the log says so, so one module's mistake costs that tool and nothing else.

import type { Context } from "effect";
import type { Archive } from "../archive/index.ts";
import { TIME_ZONE, LOCALE } from "../../src/time.ts";
import { calendarDayOf } from "../../src/calendarDay.ts";
import type { ReadyModule } from "../modules/loader.ts";
import type { Tab } from "../viewer/tab.ts";
import { calendarDayTool } from "./calendarDay.ts";
import { McpKeys } from "./keys.ts";
import { startHereTool, type Door, type DoorPart } from "./http.ts";
import { CORE_TOOLS, TOOL_NAME, type AgentTool } from "./tool.ts";

/** What the core's part says it holds. */
export const CORE_ABOUT =
  "The archive's own calendar: every day's messages (how many, with whom), calls, hangouts, conversations with agents, workouts and rituals, as the Events calendar shows them. Days run 06:00 to 06:00 in the archive's time zone.";

/** Each loaded module's part: its tools, those it may have, with a line in the log for each left out. */
export function moduleParts(modules: readonly ReadyModule[], taken: Set<string>, log: (line: string) => void = console.error): DoorPart[] {
  return modules.flatMap((module) => {
    const declared = module.definition.agents?.(module.context);
    if (!declared) return [];
    const prefix = `${module.id.replace(/-/g, "_")}_`;
    const tools = (declared.tools as unknown as readonly AgentTool[]).filter((tool) => {
      const why = !TOOL_NAME.test(tool.name) ? "is not snake_case" : !tool.name.startsWith(prefix) ? `does not begin with ${prefix}` : taken.has(tool.name) ? "is taken already" : null;
      if (why) log(`[mcp] ${module.id}: the tool ${tool.name} ${why}, so it is not offered`);
      else taken.add(tool.name);
      return why === null;
    });
    return [{ id: module.id, about: declared.about, tools }];
  });
}

const clockWords = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, dateStyle: "full", timeStyle: "short" });

/** The door over the archive (or why it is not open), the ready modules, the viewer's tables and the server's services. */
export function buildDoor({ archive, modules, off, tabs, owner, context }: {
  archive: Archive | Error;
  modules: readonly ReadyModule[];
  off: readonly string[];
  tabs: readonly Tab[];
  owner: string | null;
  context: Context.Context<never>;
}): Door {
  const keys = archive instanceof Error ? archive : new McpKeys(archive.coreDb);
  const core: DoorPart = { id: CORE_TOOLS, about: CORE_ABOUT, tools: [startHereTool(() => door), calendarDayTool(tabs) as AgentTool] };
  const door: Door = {
    keys: () => keys,
    contentLog: () => (archive instanceof Error ? archive : archive.contentLog),
    parts: [core, ...moduleParts(modules, new Set(core.tools.map((t) => t.name)))],
    off,
    owner,
    timeZone: TIME_ZONE,
    clock: (ms) => ({ now: clockWords.format(ms), today: calendarDayOf(ms) }),
    context,
  };
  return door;
}
