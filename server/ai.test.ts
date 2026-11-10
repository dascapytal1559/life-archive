// The installation's AI (ai.ts's configuredAi): with no model named, nothing starts and each question is told why; with
// one named, Codex answers with it (codex.test.ts runs Codex itself, on a stand-in).

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { configuredAi, noModel } from "./ai.ts";
import { CodexService } from "./codex.ts";

const question = { instructions: "Answer in JSON.", prompt: "Who codes?" };

describe("the configured AI", () => {
  it("with no model named, starts nothing, says so once, and tells each question why", async () => {
    const lines: string[] = [];
    const ai = await Effect.runPromise(Effect.scoped(configuredAi({ model: null, log: (line) => lines.push(line) })));
    expect(ai).toBe(noModel);
    expect(ai.model).toBeUndefined();
    await expect(ai.ask(question)).rejects.toThrow("no AI model is named: set LIFE_ARCHIVE_MODEL");
    expect(lines).toEqual([expect.stringContaining("no AI model is named")]);
  });

  it("with a model named, is Codex answering with it, stopped as its scope closes", async () => {
    const ai = await Effect.runPromise(Effect.scoped(configuredAi({ model: "sample-model", command: ["/nonexistent/codex"] })));
    expect(ai).toBeInstanceOf(CodexService);
    expect(ai.model).toBe("sample-model");
    await expect(ai.ask(question)).rejects.toThrow("the Codex service is stopped");
  });

  it("takes LIFE_ARCHIVE_MODEL's model when none is given", async () => {
    const ai = await Effect.runPromise(Effect.scoped(configuredAi({ command: ["/nonexistent/codex"] })));
    expect(ai.model).toBe(process.env.LIFE_ARCHIVE_MODEL);
  });
});
