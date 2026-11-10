import { describe, expect, it } from "vitest";
import { nodeVersionFile, pinnedNode, wrongNode } from "./nodeVersion.ts";

describe("the pinned Node", () => {
  it("is an exact version, and the one these tests run on", () => {
    expect(pinnedNode()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(wrongNode(process.versions.node, pinnedNode())).toBeNull();
  });

  it("is the version .node-version names, for the version managers that read it", () => {
    expect(nodeVersionFile()).toBe(pinnedNode());
  });

  it("accepts the pinned version, with or without its v", () => {
    expect(wrongNode("24.21.0", "24.21.0")).toBeNull();
    expect(wrongNode("v24.21.0", "24.21.0")).toBeNull();
  });

  it("names the pinned version, the running one and how to get the pinned one", () => {
    for (const running of ["26.7.0", "22.23.2", "24.20.0"]) {
      const problem = wrongNode(running, "24.21.0", "/opt/homebrew/bin/node");
      expect(problem).toContain("Node 24.21.0");
      expect(problem).toContain(`Node ${running} at /opt/homebrew/bin/node`);
      expect(problem).toContain('export PATH="$HOME/.vite-plus/bin:$PATH"');
      expect(problem).toContain("vp env install");
    }
  });
});
