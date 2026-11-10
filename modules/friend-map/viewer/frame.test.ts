// Where the Friend Map view finds friend-map's page (frame.ts): the same origin's path the archive's server serves the
// page at (the module's `page`), opened in the console's look, each flip of the look posted to the frame alone.

import { describe, expect, it } from "vitest";
import friendMap from "../module.ts";
import { atPerson, FRIEND_MAP_PATH, postTheme, withTheme } from "./frame.ts";

describe("where the Friend Map view finds friend-map", () => {
  it("is where the archive's own server serves the module's page, on this Mac and on the tailnet alike", () => {
    expect(friendMap.page).toBeDefined();
    expect(FRIEND_MAP_PATH).toBe(`${friendMap.page!.path}/`);
    expect(new URL(FRIEND_MAP_PATH, "http://127.0.0.1:4650").origin).toBe("http://127.0.0.1:4650");
  });

  it("opens friend-map in the console's look and posts each flip to its frame alone", () => {
    expect(withTheme(FRIEND_MAP_PATH, "light")).toBe(`${FRIEND_MAP_PATH}?theme=light`);
    expect(withTheme(`${FRIEND_MAP_PATH}?theme=dark`, "light")).toBe(`${FRIEND_MAP_PATH}?theme=light`);
    expect(withTheme("http://127.0.0.1:4650/friend-map/#spider", "dark")).toBe("http://127.0.0.1:4650/friend-map/?theme=dark#spider");
    const sent: unknown[][] = [];
    const frame = { postMessage: (...args: unknown[]) => sent.push(args) } as Pick<Window, "postMessage">;
    postTheme(frame, "dark", "http://127.0.0.1:4650");
    postTheme(frame, "light", "http://127.0.0.1:4650");
    postTheme(null, "dark", "http://127.0.0.1:4650");
    expect(sent).toEqual([
      [{ type: "friend-map:theme", theme: "dark" }, "http://127.0.0.1:4650"],
      [{ type: "friend-map:theme", theme: "light" }, "http://127.0.0.1:4650"],
    ]);
  });

  it("opens friend-map at the person the console's address names, and as it is for nobody", () => {
    expect(atPerson(FRIEND_MAP_PATH, "?person=7")).toBe(`${FRIEND_MAP_PATH}?person=7`);
    expect(withTheme(atPerson(FRIEND_MAP_PATH, "?person=7"), "dark")).toBe(`${FRIEND_MAP_PATH}?person=7&theme=dark`);
    expect(atPerson(FRIEND_MAP_PATH, "")).toBe(FRIEND_MAP_PATH);
    expect(atPerson(FRIEND_MAP_PATH, "?person=someone")).toBe(FRIEND_MAP_PATH);
  });
});
