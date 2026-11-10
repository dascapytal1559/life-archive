// --redacted on timeline and search (redact.ts): every text as its length.

import { describe, expect, it } from "vitest";
import type { SearchHit, TimelineMessage } from "../../../sdk/server.ts";
import { redactHits, redactPage, redactText } from "./redact.ts";

describe("--redacted", () => {
  const message: TimelineMessage = {
    id: 7, platform: "messenger", conversation: { id: 3, type: "group", title: "Climbing crew", marketplace: false },
    sentAt: 1_000, fromSelf: false, sender: "Ada Sample", type: "text", text: "See you at the crag 🧗", unsent: false,
    callSeconds: null, callLengthGiven: false, callNote: "", callAnswer: null,
    attachments: [{ id: 9, type: "photo", mime: "image/jpeg", size: 52_000, missing: false, like: null }],
    reactions: [{ emoji: "👍", actor: "Bruno Placeholder" }],
  };

  it("answers the same shape with every text as its length in characters, and the rest as it was", () => {
    expect(redactText("See you at the crag 🧗")).toBe("[redacted: 21 characters]");
    const page = redactPage({ messages: [message, { ...message, id: 6, text: null, unsent: true }], nextBefore: "1000:6", total: 2 });
    expect(page).toEqual({
      messages: [{ ...message, text: "[redacted: 21 characters]" }, { ...message, id: 6, text: null, unsent: true }],
      nextBefore: "1000:6",
      total: 2,
    });
    const hit: SearchHit = { ...message, snippet: "…at the [crag] 🧗" };
    expect(redactHits([hit])).toEqual([{ ...message, text: "[redacted: 21 characters]", snippet: "[redacted: 16 characters]" }]);
    expect(message.text).toBe("See you at the crag 🧗");
  });
});
