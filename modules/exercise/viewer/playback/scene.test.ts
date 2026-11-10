// Which scenes a playback offers and which it opens on (scene.ts's sceneKinds, Playback.tsx's first look): the
// archive's own 3D first, the photoreal city only when the owner chooses it.

import { describe, expect, it } from "vitest";
import { sceneKinds } from "./scene.ts";

describe("a playback's scenes", () => {
  it("open on This Mac's 3D even when the photoreal city's credentials are there, the city a button after it", () => {
    expect(sceneKinds({ photoreal: { ionToken: "made-up-token" } })).toEqual(["local", "photoreal"]);
  });

  it("are This Mac's 3D alone without the city's credentials", () => {
    expect(sceneKinds({})).toEqual(["local"]);
    expect(sceneKinds({ photoreal: null })).toEqual(["local"]);
  });
});
