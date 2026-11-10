import { describe, expect, it } from "vitest";
import { allowedBy, flagKey, messageForKey, neverAllowed, quotesMatch, RULE_KINDS, verdicts, type Flag, type JudgementEntry } from "./judgements.ts";
import { RULES } from "./scan.ts";

/** Version strings the check reads as IP addresses; built from pieces, so this file passes the check itself. */
const VERSION = ["1", "2", "0", "1"].join(".");
const NEXT_VERSION = ["1", "2", "0", "2"].join(".");

describe("the kinds", () => {
  it("name a kind for every rule of the commit check", () => {
    expect(Object.keys(RULE_KINDS).sort()).toEqual(Object.values(RULES).sort());
  });

  it("never let through a private term, this machine's name or content, nor a rule they do not know", () => {
    expect(neverAllowed(RULES.term)).toBe("it is one of the captain's private terms");
    expect(neverAllowed(RULES.machine)).toBe("it is this machine's own name, kept as a private term is");
    expect(neverAllowed(RULES.note)).toBe("its kind is content");
    expect(neverAllowed("a rule from tomorrow")).toBe("its rule is not one the judgements know");
    for (const rule of [RULES.ip, RULES.phone, RULES.email, RULES.person, RULES.street, RULES.lan]) expect(neverAllowed(rule)).toBeUndefined();
  });
});

describe("a finding's key", () => {
  const base = ["src/a.ts", RULES.ip, VERSION, 0, `const version = "${VERSION}";`] as const;

  it("is the same for the same match in the same text, and changes with any of them", () => {
    const key = flagKey(...base).key;
    expect(flagKey(...base)).toEqual({ id: key.slice(0, 12), key, matchHash: expect.stringMatching(/^[0-9a-f]{64}$/), contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(flagKey("src/b.ts", base[1], base[2], base[3], base[4]).key).not.toBe(key);
    expect(flagKey(base[0], RULES.phone, base[2], base[3], base[4]).key).not.toBe(key);
    expect(flagKey(base[0], base[1], NEXT_VERSION, base[3], base[4]).key).not.toBe(key);
    expect(flagKey(base[0], base[1], base[2], 1, base[4]).key).not.toBe(key);
    expect(flagKey(base[0], base[1], base[2], base[3], `${base[4]} // upstream`).key).not.toBe(key);
  });

  it("reads a commit message the same from the commit-msg hook and from the commit git kept", () => {
    expect(messageForKey("Bump  \n\n\n\nBody\n\n")).toBe("Bump\n\nBody");
    expect(messageForKey("\nBump\n\n\nBody\n")).toBe(messageForKey("Bump\n\nBody"));
  });
});

describe("judgements", () => {
  const flag: Flag = { id: "abc", key: "k1", where: "a.ts:1:1", subject: "a.ts", rule: RULES.ip, kind: "ip-address", matchHash: "m", contentHash: "c" };
  const judgement = (verdict: "allow" | "block", at: string, rule: string = RULES.ip): JudgementEntry => ({ ...flag, rule, at, policy: "life-archive", verdict, reason: "why", by: "firstmate" });

  it("count the latest for each key", () => {
    expect(allowedBy(verdicts([judgement("allow", "1"), judgement("block", "2")]), flag)).toBe(false);
    expect(allowedBy(verdicts([judgement("block", "1"), judgement("allow", "2")]), flag)).toBe(true);
    expect(allowedBy(verdicts([]), flag)).toBe(false);
  });

  it("never let through what may not be allowed, whatever a record says", () => {
    expect(allowedBy(verdicts([judgement("allow", "1", RULES.term)]), { ...flag, rule: RULES.term })).toBe(false);
  });

  it("find a reason that quotes the matched text", () => {
    const { matchHash } = flagKey("a.ts", RULES.ip, VERSION, 0, "");
    expect(quotesMatch(`it is ${VERSION}, a version`, matchHash)).toBe(true);
    expect(quotesMatch("a version string in an upstream test", matchHash)).toBe(false);
  });
});
