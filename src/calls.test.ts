import { describe, expect, it } from "vitest";
import { callDuration, callLabel, callPlatformName, callTotals, carriesCalls, defaultCallAccount, messageCallLabel } from "./calls.ts";

describe("calls", () => {
  it("says how long a call was as people say it", () => {
    expect([0, 45, 60, 89, 90, 59 * 60, 3600, 3 * 3600 + 12 * 60 + 10].map(callDuration)).toEqual(["0 s", "45 s", "1 min", "1 min", "2 min", "59 min", "1 h", "3 h 12 min"]);
  });

  it("says what a call was, answered or not, and over what", () => {
    const call = { service: "phone", answered: true, direction: "incoming", durationSeconds: 3 * 3600 + 12 * 60 } as const;
    expect(callLabel(call)).toBe("Call · 3 h 12 min");
    expect(callLabel({ ...call, service: "facetime-video", durationSeconds: 720 })).toBe("FaceTime video · 12 min");
    expect(callLabel({ ...call, answered: false, durationSeconds: 0 })).toBe("Missed call");
    expect(callLabel({ ...call, answered: false, direction: "outgoing", durationSeconds: 0 })).toBe("Unanswered call");
    expect(callLabel({ ...call, service: "facetime-audio", answered: false })).toBe("Missed FaceTime audio");
  });

  it("says what another app's call record was as it says a phone call, or just Call when the app does not say how long", () => {
    expect(messageCallLabel({ callSeconds: 72 * 60, fromSelf: false })).toBe("Call · 1 h 12 min");
    expect(messageCallLabel({ callSeconds: 45, fromSelf: true })).toBe("Call · 45 s");
    expect(messageCallLabel({ callSeconds: 0, fromSelf: false })).toBe("Missed call");
    expect(messageCallLabel({ callSeconds: 0, fromSelf: true })).toBe("Unanswered call");
    expect(messageCallLabel({ callSeconds: null, fromSelf: false })).toBe("Call");
    expect(callLabel({ service: null, answered: true, direction: "outgoing", durationSeconds: 600 })).toBe("Call · 10 min");
  });

  it("adds up the answered calls and counts the rest", () => {
    expect(callTotals([{ answered: true, durationSeconds: 100 }, { answered: false, durationSeconds: 0 }, { answered: true, durationSeconds: 20 }]))
      .toEqual({ answered: 2, seconds: 120, unanswered: 1 });
  });
});

describe("the account a logged call is on", () => {
  const accounts = [{ id: 1, platform: "x" }, { id: 2, platform: "messenger" }, { id: 3, platform: "phone" }, { id: 4, platform: "telegram" }];

  it("carries calls on every platform but X's, named as calls name them", () => {
    expect(accounts.map((a) => carriesCalls(a.platform))).toEqual([false, true, true, true]);
    expect(["imessage", "facetime", "phone", "whatsapp", "other", "somewhere"].map(callPlatformName)).toEqual(["FaceTime", "FaceTime", "Phone", "WhatsApp", "another app", "another app"]);
  });

  it("is, unless said, the one their latest call was on, else their phone one, else the first; none with none that carries calls", () => {
    expect(defaultCallAccount(accounts, [{ accountId: 2, at: 10 }, { accountId: 4, at: 30 }, { accountId: 1, at: 50 }, { accountId: null, at: 60 }])?.id).toBe(4);
    expect(defaultCallAccount(accounts, [])?.id).toBe(3);
    expect(defaultCallAccount(accounts.filter((a) => a.id !== 3), [])?.id).toBe(2);
    expect(defaultCallAccount([accounts[0]], [{ accountId: 1, at: 5 }])).toBeNull();
  });
});
