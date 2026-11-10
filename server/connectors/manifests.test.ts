import { describe, expect, it } from "vitest";
import { isPlatform } from "./contract.ts";
import { loadRegistry } from "./host.ts";
import { MANIFESTS } from "./manifests.ts";

describe("the connectors' manifests, listed by hand", () => {
  it("are every connector's own manifest, as the host finds them", async () => {
    const registry = await loadRegistry();
    expect(registry.filter((c) => c.loadError)).toEqual([]);
    expect([...MANIFESTS].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      registry.map((c) => c.manifest!).sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it("say something of every connector's calls and encrypted chats, which have none on no chat platform", () => {
    for (const manifest of MANIFESTS) {
      expect(manifest.calls.how, manifest.id).toMatch(/\w/);
      if (manifest.platform !== "phone" && isPlatform(manifest.platform)) expect(manifest.encrypted, manifest.id).toMatch(/\w/);
      if (!isPlatform(manifest.platform)) expect([manifest.calls.lengths, manifest.encrypted], manifest.id).toEqual([null, null]);
    }
  });
});
