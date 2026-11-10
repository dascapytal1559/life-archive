import { describe, expect, it } from "vitest";
import { lineAndColumn, madeUpNumber, madeUpValue, PrivacyScanner, RULES, scanPatterns, type Dictionary } from "./scan.ts";

// A made-up dictionary: nobody here is real. The captain is "Quinn Xavier Testperson".
const DICT: Dictionary = {
  person_names: ["Ada Sample", "Bruno Placeholder", "Gold Coast", "Dora", "林小雨"],
  self_names: ["Quinn Testperson", "Quinn Xavier Testperson", "测试员", "Q"],
  account_names: ["Cleo Example"],
  account_ids: [
    ["telegram", "dora_fixture_77"],
    ["telegram", "user:9990001234"],
    ["telegram", "channel:1234567"],
    ["imessage", "Bookshop"],
  ],
  self_account_ids: [["discord", "quinn.tester"]],
  group_titles: ["Sample Walkers"],
  tags: ["climbing"],
  locations: ["Gold Coast, Australia"],
  person_text: ["Met at the made-up climbing gym in spring"],
};

// A value that would be real-looking is put together from pieces, so that this file itself holds
// none for the check to stop. Each is still made up: phone numbers from Ofcom's drama ranges (UK
// numbers set aside for fiction, which the check does not know), an email at a domain that does
// not exist, and host names no one gave.
const join = (...parts: string[]) => parts.join("");

const rules = (text: string, options = {}) => new PrivacyScanner(DICT, options).scan(text).map((f) => f.rule);

describe("names", () => {
  it("finds a friend's or an account's full name written as a name, or as a handle or file name", () => {
    expect(rules("Lunch with Ada Sample on Friday")).toEqual([RULES.person]);
    expect(rules("see ada_sample.json and ada-sample")).toEqual([RULES.person, RULES.person]);
    expect(rules("Cleo\nExample")).toEqual([RULES.person]);
    expect(rules("The Sample Walkers met")).toEqual([RULES.group]);
  });

  it("leaves prose, one word alone, a place and a reviewed phrase alone", () => {
    expect(rules("an ada sample of prose")).toEqual([]);
    expect(rules("Dora said hi, and Ada too")).toEqual([]);
    expect(rules("a weekend on the Gold Coast")).toEqual([]);
    expect(rules("Ada Sample and ada_sample", { allowed: ["Ada-Sample"] })).toEqual([]);
    expect(rules("Ada, Sample")).toEqual([]);
  });

  it("finds a name in another script as written", () => {
    expect(rules("和林小雨一起")).toEqual([RULES.person]);
  });

  it("reports where, never what", () => {
    const [finding] = new PrivacyScanner(DICT).scan("one\ntwo Ada Sample");
    expect(finding).toEqual({ rule: RULES.person, start: 8, end: 18 });
    expect(lineAndColumn("one\ntwo Ada Sample", finding.start)).toEqual({ line: 2, column: 5 });
  });
});

describe("the captain's name", () => {
  it("finds it whole, its words together in any order or case, and run together", () => {
    expect(rules("by Quinn Testperson")).toEqual([RULES.captain]);
    expect(rules("testperson quinn")).toEqual([RULES.captain]);
    expect(rules("const quinnTestperson = 1")).toEqual([RULES.captain]);
    expect(rules("Xavier Testperson")).toEqual([RULES.captain]);
    expect(rules("他叫测试员")).toEqual([RULES.captain]);
  });

  it("finds one of its words used as someone's name, even one a reviewed list allows", () => {
    expect(rules("Bruno Testperson")).toEqual([RULES.captain]);
    expect(rules("Quinn Fixture", { allowed: ["quinn fixture"] })).toEqual([RULES.captain]);
    expect(rules('{ name: "Quinn" }')).toEqual([RULES.captain]);
    expect(rules("Testperson Quinn", { allowed: ["testperson quinn"] })).toEqual([RULES.captain]);
  });

  it("leaves one of its words alone in prose", () => {
    expect(rules("a quinn in lower case, and the word xavier")).toEqual([]);
    expect(rules("the Testperson method")).toEqual([]);
  });

  it("finds the captain's own account ids", () => {
    expect(rules("ping quinn.tester")).toEqual([RULES.captainId]);
  });
});

describe("account ids, numbers and notes", () => {
  it("finds an account id with letters, alone or after @ or a kind", () => {
    expect(rules("handle dora_fixture_77")).toEqual([RULES.accountId]);
    expect(rules("@dora_fixture_77, or DORA_FIXTURE_77")).toEqual([RULES.accountId, RULES.accountId]);
  });

  it("finds a number from the archive however it is written", () => {
    expect(rules("user:9990001234")).toEqual([RULES.accountId]);
    expect(rules("call 999 000 1234")).toEqual([RULES.accountId]);
  });

  it("leaves made-up ids and an iMessage sender that is a word", () => {
    expect(rules("channel:1234567 and 1234567")).toEqual([]);
    expect(rules("dora_fixture_77", { allowed: ["dora_fixture_77"] })).toEqual([]);
    expect(rules("the Bookshop down the road")).toEqual([]);
  });

  it("finds a note's text", () => {
    expect(rules("// Met at the made-up climbing gym in spring")).toEqual([RULES.note]);
  });
});

describe("patterns", () => {
  const found = (text: string) => scanPatterns(text).map((f) => f.rule);

  it("finds a real-looking phone number, and leaves those set aside for fiction", () => {
    expect(found(join("call +44 20 79", "46 0958"))).toEqual([RULES.phone]);
    expect(found("+61 491 570 006, 0491 570 110, (02) 5550 1234, +61 8 7010 4321, +1 202 555 0143, +44 7700 900123, 61491571266")).toEqual([]);
    expect(madeUpNumber("61491570006")).toBe(true);
    expect(madeUpNumber(join("44113", "4960123"))).toBe(false);
  });

  it("finds a real-looking email, and leaves example domains, GitHub's noreply addresses, git@ and chat ids", () => {
    expect(found(join("ada.sample@", "post.zz"))).toEqual([RULES.email]);
    expect(found(join("ada.sample@", "github.com"))).toEqual([RULES.email]);
    expect(found("sam@example.com, a@b.example, git@github.com:x/y, 1@users.noreply.github.com, noreply@github.com, 61491571266@s.whatsapp.net")).toEqual([]);
  });

  it("finds a real-looking WhatsApp or WeChat id, and leaves made-up ones", () => {
    expect(found(join("4411349", "60123@s.whatsapp.net"))).toEqual([RULES.chatId]);
    expect(found(join("wxid_k3j9", "x8a7q2m1z0"))).toEqual([RULES.chatId]);
    expect(found("wxid_ada0001 61491571266@s.whatsapp.net")).toEqual([]);
  });

  it("finds a tailnet's host names and addresses, and leaves placeholders", () => {
    expect(found(join("https://studio.tail", "9f3c2a.ts.net:8443/"))).toEqual([RULES.tailnet]);
    expect(found(join("100.", "101.7.12"))).toEqual([RULES.tailnet]);
    expect(found("your-mac.tail1234.ts.net mac.tail1234.ts.net *.ts.net 100.100.100.100 100.64.0.0/10 100.64.0.0")).toEqual([]);
  });

  it("finds a LAN host name, and leaves placeholders and .env.local", () => {
    expect(found(join("ssh studio-mini.lo", "cal"))).toEqual([RULES.lan]);
    expect(found(join("http://media", "box.lan:8080 and pi@garden", "pi.local"))).toEqual([RULES.lan, RULES.lan]);
    expect(found("your-mac.local, /.env.local, localhost, RULES.lan, this.local, options.internal")).toEqual([]);
  });

  it("finds an IP address, and leaves those no machine has, networks and versions", () => {
    expect(found(join("served from 45.76.", "12.201:4600"))).toEqual([RULES.ip]);
    expect(found(join("100.", "5.6.7"))).toEqual([RULES.ip]);
    expect(found("127.0.0.1 0.0.0.0 10.1.2.3 172.20.0.5 192.168.1.5 169.254.1.1 192.0.2.7 198.51.100.7 203.0.113.7 224.0.0.251 255.255.255.255")).toEqual([]);
    expect(found(join("45.76.", "12.0 45.76.", "0.0/16 v4.5.6.7 1.2.3.4.5 999.1.1.1"))).toEqual([]);
  });

  it("finds a street address, and leaves made-up ones and numbers in prose", () => {
    expect(found(join("lives at 14 Wattle ", "Grove Street"))).toEqual([RULES.street]);
    expect(found(join("4/27 Banksia ", "Rd, Fitzroy"))).toEqual([RULES.street]);
    expect(found("12 Example Street, 3 Sample Ave, 2 drive, the 3 Sample Walkers, Step 2 Road")).toEqual([]);
  });

  it("finds this machine's user and host names as whole words, but not generic ones", () => {
    const machine = ["qtester", "mbp7", "MacBook-Pro"];
    expect(rules("/Users/qtester/Projects and mbp7:4600", { machine })).toEqual([RULES.machine, RULES.machine]);
    expect(rules("qtesters mbp77 MacBook-Pro", { machine })).toEqual([]);
  });
});

describe("private terms", () => {
  // Made up: they play the captain's private hosts, profiles, tailnet and home path (guard/private-terms.json).
  const terms = ["vexcorp-zdata", "qz7", "qz7-claudeq", "ClaudeQ", ".claude-profiles/q", "tailf00d1", "/Users/vexowner"];

  it("finds each whole however it is cased, a host's name run on by a hyphen or a dot too, longest first", () => {
    const text = "Tokens by host: VexCorp-ZData 1.2M, qz7-claudeq 3.1M, qz7-db and qz7.tailf00d1 too; dropped claudeq (~/.claude-profiles/q) from /Users/vexowner/x";
    const found = new PrivacyScanner(DICT, { terms }).scan(text);
    expect(found.map((f) => text.slice(f.start, f.end).toLowerCase())).toEqual(["vexcorp-zdata", "qz7-claudeq", "qz7", "qz7", "tailf00d1", "claudeq", ".claude-profiles/q", "/users/vexowner"]);
    expect(new Set(found.map((f) => f.rule))).toEqual(new Set([RULES.term]));
  });

  it("never finds one inside a longer word or number, so code that shares a piece of one passes", () => {
    for (const text of ["const zdata = inflate(ZData); // vexcorp", "qz70 aqz7 qz7_x claudeqs .claude-profiles/quinn /Users/vexowner2"]) {
      expect(rules(text, { terms }), text).toEqual([]);
    }
  });

  it("lets through a term reviewed as ordinary, matched whole, but not a longer term that holds it", () => {
    expect(rules("ZData and zdata", { terms: ["zdata", "vexcorp-zdata"], allowed: ["zdata"] })).toEqual([]);
    expect(rules("vexcorp-zdata", { terms: ["zdata", "vexcorp-zdata"], allowed: ["zdata"] })).toEqual([RULES.term]);
  });
});

describe("the privacy policy's repository layer", () => {
  const scanner = new PrivacyScanner(DICT);

  it("leaves what the policy calls fine: ordinary phrases, cities, time zones and dates", () => {
    for (const text of ['label: "Since Aug"', "Since Aug 2026", "Melbourne", "time zone Australia/Melbourne", "2026-08-26", "26 August 2026, 14:05", "Tokyo, Queensland", "412 calls with a friend"]) {
      expect(scanner.scan(text), text).toEqual([]);
    }
  });

  it("stops each kind it lists that a pattern can find: a tailnet host, an IP address, a street address, a phone number and an email", () => {
    const stopped: Array<[string, string]> = [
      [join("https://studio.tail", "9f3c2a.ts.net/"), RULES.tailnet],
      [join("ssh 45.76.", "12.201"), RULES.ip],
      [join("14 Wattle ", "Grove Street"), RULES.street],
      [join("+44 20 79", "46 0958"), RULES.phone],
      [join("ada.sample@", "post.zz"), RULES.email],
    ];
    for (const [text, rule] of stopped) expect(scanner.scan(text).map((f) => f.rule), rule).toEqual([rule]);
  });
});

describe("madeUpValue", () => {
  it("knows the conventions' stand-ins, as the model's review quotes them", () => {
    const madeUp = ["+61 491 570 006", "0491 571 266", "61491571266@s.whatsapp.net", "ada.sample@example.com", "0+test@users.noreply.github.com", "noreply@github.com", "your-mac.tail1234.ts.net", "example.ts.net", "your-mac", "api.example.com", "host.test", "192.168.1.5", "127.0.0.1", "203.0.113.7"];
    for (const value of madeUp) expect(madeUpValue(value), value).toBe(true);
  });

  it("takes anything else as possibly real: a real-looking number, address, host or name, and a tailnet's address", () => {
    const real = [join("+61 4", "38 917 263"), join("ada.sample@", "post.zz"), join("ada.sample@", "github.com"), join("qz7.", "tailf00d1.ts.net"), join("100.", "101.102.103"), join("8.8.", "4.4"), "brightbox-7", "Bruno Placeholder", ""];
    for (const value of real) expect(madeUpValue(value), value).toBe(false);
  });
});
