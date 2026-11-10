// Finds private data in text about to be committed: real people's names,
// account ids and notes from the private dictionary (read from the archive by
// dictionary.ts), the captain's own name, his private infrastructure's terms
// (dictionary.ts's private-terms.json), and real-looking phone numbers,
// emails, account ids, tailnet or LAN host names, IP addresses and street
// addresses: the kinds a repository's policy (policy.ts) never holds that it
// can find by shape or from the archive. A finding names only its rule and
// where it is, never the matched text, so the check itself never prints a real value.
//
// What the policy calls fine is allowed: place names and time zones (the
// dictionary's locations are never looked for, and a name that is also a place
// is skipped), dates, counts, product names and ordinary phrases.

/** The names and ids the archive holds (dictionary.ts): lists of strings, and [platform, id] pairs for ids. */
export interface Dictionary {
  person_names: string[];
  self_names: string[];
  account_names: string[];
  account_ids: [string, string][];
  self_account_ids: [string, string][];
  group_titles: string[];
  tags: string[];
  locations: string[];
  person_text: string[];
}

export interface ScanOptions {
  /** Words or phrases reviewed as not private (the guard's allow.json, "multi"); never covers the captain's name. */
  allowed?: string[];
  /** This machine's user and host names, flagged wherever they appear. */
  machine?: string[];
  /**
   * The captain's private terms (host and machine names, profile names, tailnet names, home paths, personal emails,
   * his family's first names), each found whole however it is cased, never inside a longer word or number (`zq9` is not in
   * `zq90` or `azq9`, but is in `zq9-db` and `zq9.example`, since a host's name runs on with a hyphen or a dot); one
   * that `allowed` lists is let through.
   */
  terms?: string[];
}

export interface Finding {
  rule: string;
  /** Where in the text, as UTF-16 offsets from its start: the first character and just past the last. */
  start: number;
  end: number;
}

export const RULES = {
  captain: "the captain's own name",
  captainId: "the captain's own account id",
  person: "a real person's name",
  group: "a real group chat's title",
  accountId: "a real account id or phone number",
  note: "text from a note about a real person",
  phone: "a real-looking phone number",
  email: "a real-looking email address",
  chatId: "a real-looking WhatsApp or WeChat id",
  tailnet: "a tailnet host name or address",
  lan: "a LAN host name",
  ip: "an IP address",
  street: "a street address",
  machine: "this machine's user or host name",
  term: "one of the captain's private terms (his hosts, profiles, paths, addresses or family's first names)",
} as const;

const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
const isLatin = (s: string) => [...s].every((c) => !/\p{L}/u.test(c) || /\p{Script=Latin}/u.test(c));
const norm = (s: string) => s.normalize("NFC").trim();
const lower = (s: string) => s.toLocaleLowerCase("en");
/** What may stand between the words of one name: a space, a line break, "_", "-" or "." (ada_sample, ada-sample). */
const NAME_GAP = /^[\s_.\-]{1,3}$/;
const capitalised = (s: string) => /^\p{Lu}/u.test(s);

interface Token {
  text: string;
  low: string;
  start: number;
  end: number;
}

function tokens(text: string): Token[] {
  return [...text.matchAll(WORD)].map((m) => ({ text: m[0], low: lower(m[0]), start: m.index, end: m.index + m[0].length }));
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Numbers set aside for fiction or plainly made up: the ACMA's creative-works ranges, 555, 555-01xx and 07700 900, mostly zeros, one digit six times running, 123456. */
export function madeUpNumber(digits: string): boolean {
  return (
    digits.split("0").length - 1 >= digits.length * 0.5 ||
    new Set(digits).size <= 2 ||
    /(\d)\1{5}/.test(digits) ||
    digits.includes("123456") ||
    /^(?:61|0)(?:49157\d|[2378](?:5550|7010))/.test(digits) ||
    /^(?:44|0)7700900/.test(digits) ||
    /^1?555/.test(digits) ||
    /^1?\d{3}55501\d{2}$/.test(digits)
  );
}

const PLACEHOLDER_TAILNET = /^(?:tail\d{4}|tailnet|tailnet-name|your-tailnet|my-tailnet|example|x+)$/i;
const PLACEHOLDER_HOST = /^(?:your-mac|my-mac|mac|your-computer|hostname|host|example|my-host|your-host|x+)$/i;
const ALLOWED_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost|users\.noreply\.github\.com)$/i;
/** An address no one owns: at an example domain or a person's GitHub noreply, or GitHub's own noreply (what it commits as itself). */
const madeUpEmail = (local: string, domain: string) => ALLOWED_EMAIL_DOMAIN.test(domain) || /^noreply@github\.com$/i.test(`${local}@${domain}`);
const GENERIC_MACHINE_NAME = /^(?:localhost|root|admin|user|runner|ubuntu|node|mac|macbook|imac|mac-?mini|mac-?studio|mac-?pro|macbook-?(?:pro|air))(?:-?\d+)?$/i;

export class PrivacyScanner {
  /** Multi-word Latin names, by word count: words joined by " " -> rule. */
  private multi = new Map<number, Map<string, string>>();
  /** Names in other scripts, matched as they are written. */
  private script = new Map<string, string>();
  private selfWords = new Set<string>();
  /** The captain's name words run together (givenSurname, surnamegiven). */
  private selfJoined = new Set<string>();
  /** Account ids with letters in them, lower case -> rule. */
  private textIds = new Map<string, string>();
  /** Account ids and phone numbers as bare digits -> rule. */
  private digitIds = new Map<string, string>();
  private notes: string[] = [];
  private allowed: Set<string>;
  private machine: Set<string>;
  /** The private terms, longest first, as one pattern; none without terms. */
  private terms?: RegExp;

  constructor(dict: Dictionary, options: ScanOptions = {}) {
    // Each reviewed term as words (for names) and as written (for ids).
    this.allowed = new Set((options.allowed ?? []).flatMap((s) => [tokens(norm(s)).map((t) => t.low).join(" "), lower(norm(s))]));
    this.machine = new Set(
      (options.machine ?? []).map((s) => lower(norm(s))).filter((s) => s.length >= 3 && !GENERIC_MACHINE_NAME.test(s)),
    );
    const terms = [...new Set((options.terms ?? []).map((s) => lower(norm(s))).filter((s) => s.length >= 2))].sort((a, b) => b.length - a.length);
    if (terms.length > 0) this.terms = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${terms.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])`, "giu");

    const places = new Set<string>();
    for (const location of dict.locations ?? []) {
      for (const part of [location, ...location.split(",")]) places.add(tokens(norm(part)).map((t) => t.low).join(" "));
    }

    // The captain's names first, so a name the captain shares with a friend counts as theirs.
    for (const raw of dict.self_names ?? []) {
      const name = norm(raw ?? "");
      if (!name) continue;
      if (!isLatin(name)) {
        if ([...name].filter((c) => /\p{L}/u.test(c)).length >= 2) this.script.set(name, RULES.captain);
        continue;
      }
      const words = tokens(name).map((t) => t.low).filter((w) => w.length >= 3);
      for (const word of words) this.selfWords.add(word);
      if (words.length >= 2) this.addMulti(words, RULES.captain);
    }
    const self = [...this.selfWords];
    for (const a of self) {
      for (const b of self) {
        if (a === b) continue;
        this.selfJoined.add(a + b);
        for (const c of self) if (c !== a && c !== b) this.selfJoined.add(a + b + c);
      }
    }

    const names: [string[], string][] = [
      [dict.person_names ?? [], RULES.person],
      [dict.account_names ?? [], RULES.person],
      [dict.group_titles ?? [], RULES.group],
    ];
    for (const [list, rule] of names) {
      for (const raw of list) {
        const name = norm(raw ?? "");
        if (!name) continue;
        if (!isLatin(name)) {
          if ([...name].filter((c) => /\p{L}/u.test(c)).length >= 2 && !this.script.has(name)) this.script.set(name, rule);
          continue;
        }
        const words = tokens(name).map((t) => t.low);
        // One word alone is too often an ordinary word; two or more, with at least two of two letters or more.
        if (words.length < 2 || words.length > 6 || words.filter((w) => w.length >= 2).length < 2) continue;
        if (places.has(words.join(" "))) continue;
        this.addMulti(words, rule);
      }
    }

    const ids: [[string, string][], string][] = [
      [dict.self_account_ids ?? [], RULES.captainId],
      [dict.account_ids ?? [], RULES.accountId],
    ];
    for (const [list, rule] of ids) {
      for (const [platform, raw] of list) {
        const id = norm(String(raw ?? ""));
        if (!id) continue;
        const runs: string[] = id.match(/\d{7,}/g) ?? [];
        if (/^[\d+\-\s().\u00a0]+$/.test(id)) runs.push(digitsOf(id));
        for (const run of runs) {
          if (run.length < 7 || madeUpNumber(run)) continue;
          this.addDigits(run, rule);
          // The same number written nationally: 61 4.. as 04.., 86 1.. as 1.., 1 xxx as xxx.
          if (run.startsWith("61") && run.length === 11) this.addDigits("0" + run.slice(2), rule);
          if (run.startsWith("86") && run.length === 13) this.addDigits(run.slice(2), rule);
          if (run.startsWith("1") && run.length === 11) this.addDigits(run.slice(1), rule);
        }
        // Not an iMessage sender that is a plain word (a business's text messages), nor a kind and a
        // number that looks made up (channel:1234567, Telegram's own user:777000), as tests write them.
        const word = platform === "imessage" && /^\p{L}+$/u.test(id);
        const madeUp = /^\p{L}+:\d+$/u.test(id) && madeUpNumber(digitsOf(id));
        if (id.length >= 5 && /[^\d+\-\s().]/.test(id) && !word && !madeUp && !this.textIds.has(lower(id))) {
          this.textIds.set(lower(id), rule);
        }
      }
    }

    this.notes = (dict.person_text ?? []).map(norm).filter((t) => t.length >= 12);
  }

  private addMulti(words: string[], rule: string) {
    const key = words.join(" ");
    let table = this.multi.get(words.length);
    if (!table) this.multi.set(words.length, (table = new Map()));
    if (!table.has(key)) table.set(key, rule);
  }

  private addDigits(digits: string, rule: string) {
    if (!this.digitIds.has(digits)) this.digitIds.set(digits, rule);
  }

  /** Every place in the text that holds private data, in order. */
  scan(text: string): Finding[] {
    const found: Finding[] = [];
    const hit = (start: number, end: number, rule: string) => found.push({ rule, start, end });
    const toks = tokens(text);
    const gap = (i: number) => text.slice(toks[i].end, toks[i + 1].start);

    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i];
      // Names of two to six words, the words in a row with only a space, line break, "_", "-" or "." between.
      // A friend's name or a group's title counts written as a name (every word capitalised) or as
      // a handle or file name (ada_sample, ada-sample), so prose such as "a group call" never does;
      // the captain's name counts however it is written.
      for (const [n, table] of this.multi) {
        if (i + n > toks.length) continue;
        const run = toks.slice(i, i + n);
        const gaps = run.slice(0, -1).map((_, k) => gap(i + k));
        if (!gaps.every((g) => NAME_GAP.test(g))) continue;
        const key = run.map((t) => t.low).join(" ");
        const rule = table.get(key);
        if (!rule) continue;
        const asName = run.every((t) => capitalised(t.text)) || gaps.every((g) => !/\s/.test(g));
        if (rule === RULES.captain || (asName && !this.allowed.has(key))) hit(tok.start, run[n - 1].end, rule);
      }

      if (this.selfJoined.has(tok.low)) hit(tok.start, tok.end, RULES.captain);
      if (this.selfWords.has(tok.low)) {
        const next = toks[i + 1];
        const prev = toks[i - 1];
        const nextGap = next ? gap(i) : "";
        const prevGap = prev ? gap(i - 1) : "";
        if (next && NAME_GAP.test(nextGap) && this.selfWords.has(next.low)) hit(tok.start, next.end, RULES.captain);
        // As a person's name: capitalised beside another capitalised word ("Given Placeholder",
        // "Ada Surname"), or a whole quoted string ("Given").
        else if (capitalised(tok.text)) {
          const besideName = (t: Token | undefined, g: string) => t !== undefined && /^[ \t]$/.test(g) && capitalised(t.text) && isLatin(t.text);
          const before = text[tok.start - 1];
          const quoted = before !== undefined && `"'\``.includes(before) && text[tok.end] === before;
          if (besideName(next, nextGap) || besideName(prev, prevGap) || quoted) hit(tok.start, tok.end, RULES.captain);
        }
      }
    }

    if ([...text].some((c) => /\p{L}/u.test(c) && !/\p{Script=Latin}/u.test(c))) {
      for (const [name, rule] of this.script) {
        for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) hit(at, at + name.length, rule);
      }
    }

    for (const m of text.matchAll(/[\w.+@:-]{5,}/gu)) {
      const tok = lower(m[0]);
      for (const candidate of new Set([tok, tok.replace(/^[.:@-]+|[.:-]+$/g, ""), ...tok.split(":"), ...tok.split("@")])) {
        const rule = this.textIds.get(candidate);
        if (rule && !this.allowed.has(candidate)) hit(m.index, m.index + m[0].length, rule);
      }
    }
    for (const m of text.matchAll(/\d[\d\s\-().]{5,}\d/g)) {
      for (const run of new Set([digitsOf(m[0]), ...(m[0].match(/\d{7,}/g) ?? [])])) {
        const rule = this.digitIds.get(run);
        if (rule) hit(m.index, m.index + m[0].length, rule);
      }
    }
    for (const name of this.machine) {
      for (const m of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`, "giu"))) {
        hit(m.index, m.index + m[0].length, RULES.machine);
      }
    }
    for (const m of this.terms ? text.matchAll(this.terms) : []) {
      if (!this.allowed.has(lower(m[0]))) hit(m.index, m.index + m[0].length, RULES.term);
    }
    for (const note of this.notes) {
      for (let at = text.indexOf(note); at !== -1; at = text.indexOf(note, at + 1)) hit(at, at + note.length, RULES.note);
    }

    found.push(...scanPatterns(text));
    // One finding for each thing found: the first rule to find it, and nothing inside it again.
    const order = Object.values(RULES) as string[];
    found.sort((a, b) => a.start - b.start || b.end - a.end || order.indexOf(a.rule) - order.indexOf(b.rule));
    const kept: Finding[] = [];
    for (const f of found) if (f.start >= (kept.at(-1)?.end ?? 0)) kept.push(f);
    return kept;
  }
}

/** The checks that need no dictionary: real-looking phone numbers, emails, chat ids, host names, IP addresses and street addresses. */
export function scanPatterns(text: string): Finding[] {
  const found: Finding[] = [];
  const hit = (m: RegExpMatchArray, rule: string) => found.push({ rule, start: m.index!, end: m.index! + m[0].length });
  // Shapes: +61 4xx xxx xxx, +1 (xxx) xxx-xxxx, 04xx xxx xxx, 04xxxxxxxx, (0x) xxxx xxxx
  for (const m of text.matchAll(/(?<![\w.+])(?:\+\d[\d \-().]{6,18}\d|\(?0\d\)?[ -]?\d{4}[ -]?\d{4}|04\d{2}[ -]?\d{3}[ -]?\d{3})(?![\w.])/g)) {
    const digits = digitsOf(m[0]);
    if (digits.length >= 9 && digits.length <= 15 && !madeUpNumber(digits)) hit(m, RULES.phone);
  }
  for (const m of text.matchAll(/(?<![\w.+-])([\w.+-]+)@((?:[\w-]+\.)+[A-Za-z]{2,})(?![\w-])/g)) {
    const [, local, domain] = m;
    // Not a chat id, git@host, or user@machine on the local network (the next check's).
    if (/^(?:s\.whatsapp\.net|g\.us|c\.us)$|\.(?:local|lan|home\.arpa|internal)$/i.test(domain) || local === "git") continue;
    if (!madeUpEmail(local, domain)) hit(m, RULES.email);
  }
  for (const m of text.matchAll(/(?<!\d)(\d{6,})@(?:s\.whatsapp\.net|g\.us|c\.us)/g)) {
    if (!madeUpNumber(m[1])) hit(m, RULES.chatId);
  }
  for (const m of text.matchAll(/\bwxid_([a-z0-9]{10,})/gi)) {
    if ((m[1].match(/\d/g) ?? []).length >= 2 && !madeUpNumber(digitsOf(m[1]))) hit(m, RULES.chatId);
  }
  for (const m of text.matchAll(/(?<![\w-])((?:[\w-]+\.)*)([\w-]+)\.ts\.net\b/gi)) {
    if (m[1] !== "" && !PLACEHOLDER_TAILNET.test(m[2])) hit(m, RULES.tailnet);
  }
  // A device's address on a tailnet (Tailscale's 100.64.0.0/10), not a network (one ending in .0 or
  // written with its /prefix) nor Tailscale's well-known resolver, 100.100.100.100.
  for (const m of text.matchAll(/(?<![\d.])100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d/]|\.\d)/g)) {
    const second = Number(m[1]);
    if (second >= 64 && second <= 127 && m[3] !== "0" && m[0] !== "100.100.100.100") hit(m, RULES.tailnet);
  }
  // A machine on the local network: name.local, name.lan, name.home.arpa or name.internal, where the
  // name has a hyphen or a digit, as machines' names do (studio-mini, pi4), or follows // or @ (an
  // address); so code such as RULES.lan or this.local is not one.
  for (const m of text.matchAll(/(?<=^|[^\w.\/-]|\/\/)([\w-]+)\.(?:local|lan|home\.arpa|internal)(?![\w-])/g)) {
    const address = /(?:\/\/|@)$/.test(text.slice(0, m.index));
    if ((address || /[-\d]/.test(m[1])) && !PLACEHOLDER_HOST.test(m[1])) hit(m, RULES.lan);
  }
  // An IPv4 address, not one any machine has (loopback, private networks, link-local, the tailnet's, which the
  // tailnet check has, the documentation ranges, multicast and above) nor a network (ending in .0 or written with its
  // /prefix), nor part of a longer dotted number (a version, 1.2.3.4.5).
  for (const m of text.matchAll(/(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w/]|\.\d)/g)) {
    const [a, b, c, d] = m.slice(1, 5).map(Number);
    if ([a, b, c, d].some((n) => n > 255) || d === 0 || !publicAddress(a, b, c)) continue;
    hit(m, RULES.ip);
  }
  // A street address: a number (a unit's too, 4/12), then one to three capitalised words and a street's kind, not one
  // plainly made up (12 Example Street).
  for (const m of text.matchAll(STREET)) {
    if (!PLACEHOLDER_STREET.test(m[1])) hit(m, RULES.street);
  }
  return found;
}

/**
 * Whether one value, as the model's review quotes it, is plainly a stand-in by this check's own conventions: a number
 * set aside for fiction or plainly patterned (and a chat id made of one), an address at an example domain or GitHub's
 * noreply, a placeholder or example host, or an IP address no real machine has (a tailnet's is a real machine's).
 */
export function madeUpValue(text: string): boolean {
  const value = text.trim();
  const chatId = /^(\d{6,})@(?:s\.whatsapp\.net|g\.us|c\.us)$/i.exec(value);
  if (chatId) return madeUpNumber(chatId[1]!);
  const email = /^([\w.+-]+)@((?:[\w-]+\.)+[A-Za-z]{2,})$/.exec(value);
  if (email) return madeUpEmail(email[1]!, email[2]!);
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ip) {
    const [a, b, c] = ip.slice(1, 4).map(Number) as [number, number, number];
    return !(a === 100 && b >= 64 && b <= 127) && !publicAddress(a, b, c);
  }
  const tailnet = /^(?:[\w-]+\.)*([\w-]+)\.ts\.net$/i.exec(value);
  if (tailnet) return PLACEHOLDER_TAILNET.test(tailnet[1]!);
  if (PLACEHOLDER_HOST.test(value) || /^(?:[\w-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid)$/i.test(value)) return true;
  const digits = digitsOf(value);
  return /^[\d+\-\s().]+$/.test(value) && digits.length >= 6 && madeUpNumber(digits);
}

/** Whether an IPv4 address's first three numbers put it on the public internet, outside every range set aside. */
function publicAddress(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if ((a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // a tailnet's (and carrier NAT): the tailnet check's
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // set aside for benchmarks
  return true;
}

const STREET_KINDS = "Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Court|Ct|Crescent|Cres|Parade|Pde|Boulevard|Blvd|Terrace|Tce|Highway|Hwy|Place|Pl|Close|Grove|Way|Esplanade|Circuit|Cct";
const STREET = new RegExp(`(?<![\\w/.-])\\d{1,5}[A-Za-z]?(?:\\/\\d{1,5}[A-Za-z]?)?,? ((?:\\p{Lu}[\\p{L}'’-]+ ){1,3})(?:${STREET_KINDS})\\b\\.?`, "gu");
const PLACEHOLDER_STREET = /\b(?:Example|Sample|Placeholder|Fake|Test|Nowhere|Fictional)\b/;

/** 1-based line and column of an offset. */
export function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}
