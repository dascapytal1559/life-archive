import { describe, expect, it } from "vitest";
import { BRIDGE_PORT, bridgePlist, bridgeUrl, cuaBin, plist, roundPrompt, volumeFolder } from "./live.ts";

describe("the Cua side's wiring", () => {
  it("finds the agent's folder in the Space's part of the Cua Volume, and words the round's prompt with it", () => {
    expect(volumeFolder("local:space-sample")).toBe("spaces/local-space-sample/friend-map-exports");
    expect(roundPrompt("local:space-sample")).toBe(
      'read "~/Cua Volume/spaces/local-space-sample/friend-map-exports/PLAYBOOK.md" and do the round it describes, with plan.json and settings.json beside it.',
    );
  });

  it("takes the cua command CUA_BIN names", () => {
    expect(cuaBin({ CUA_BIN: "/opt/cua/bin/cua" })).toBe("/opt/cua/bin/cua");
  });

  it("runs a round every 15 minutes, with ~/.local/bin (where cua is) on launchd's PATH", () => {
    const text = plist({ node: "/opt/node/bin/node", repo: "/opt/life-archive", logFile: "/tmp/cua-exports.log", home: "/home/sample" });
    expect(text).toContain("<key>Label</key><string>local.life-archive-cua-exports</string>");
    expect(text).toContain("<array><string>/opt/node/bin/node</string><string>--no-warnings</string><string>modules/friend-map/jobs/cua-exports.ts</string><string>run</string></array>");
    expect(text).toContain("<key>StartInterval</key><integer>900</integer>");
    expect(text).toContain("<string>/opt/node/bin:/home/sample/.local/bin:/opt/homebrew/bin");
  });

  it("keeps the rounds' browser bridge running, at an address with its token, as the round's Codex reaches it from the Space", () => {
    const text = bridgePlist({ node: "/opt/node/bin/node", repo: "/opt/life-archive", logFile: "/tmp/cua-bridge.log", home: "/home/sample" });
    expect(text).toContain("<key>Label</key><string>local.life-archive-cua-bridge</string>");
    expect(text).toContain("<array><string>/opt/node/bin/node</string><string>--no-warnings</string><string>modules/friend-map/jobs/cua-exports.ts</string><string>bridge</string></array>");
    expect(text).toContain("<key>KeepAlive</key><true/>\n<key>RunAtLoad</key><true/>");
    expect(text).not.toContain("StartInterval");
    expect(bridgeUrl("192.168.64.1", "sample-token")).toBe(`http://192.168.64.1:${BRIDGE_PORT}/sample-token/mcp`);
  });
});
