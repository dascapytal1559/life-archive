// How the page labels a person: by their name, the first of the names they go
// by (the person panel's chips), with their next name beneath where they have one.
//
// How it shows names is one choice, Name format, first in the view's settings in the
// menu at the top left (NamesMenu.tsx), saved on friend-map's server with the
// Spider web's settings, so every browser and the phone share it, and the
// demo's default (nameStyleStore, savedStore.ts). Four of its choices are
// for the map views alone (Orbits, Circles, Orbits 3D, the Spider web and the City):
// First name, First L., Full name or No name decide how the names drawn on the
// map read ("Ada", "Ada S." or "Ada Sample" for Ada Sample, never changing a
// stored one; shortened) or that there are none (a screenshot of the map's
// shape, say; the h key switches No name on and back), and change nothing
// else: the hover card, the person panel, search, the Table, the Calendar and
// chats name everyone as ever (label). The fifth, in the real app alone, is a
// privacy mode: No name except… (a demo of the real map for someone: their own
// name and a few others) keeps every name off every screen but those of the
// people you picked, tagged "show-name" in the archive (SHOW_NAME_TAG,
// shownNames.ts), and of their connections (everyone the map links them to, as
// sharing a group chat), named by their name alone. Everyone else's name is drawn as
// nothing, or as a neutral shape where something must be there to click
// (HiddenName in PersonParts.tsx), and so is any other name that may be
// someone's (an account, a sender, a group chat's title); aliases, the next
// name beneath a label, notes and draft openers hide, the name fields lock,
// search finds only those named, and the map views draw no reach-out glow
// (glowsOf in demos/reachGlow.ts). Each view's own rule for whom it names
// still holds (Show top names on the map; while someone is held, everyone linked to
// them), so it only ever leaves names out. Pages read the choice
// through useNames, so anything labelled that way follows it. The demo (the static
// demo, demoMode.ts), whose people are all made up and stored by their full names,
// offers the first four for its map, starting at your choice where it
// shows names (First L. as the real app starts), and keeps its visitor's choice
// apart from the real app's; off the map it names everyone, and their
// aliases and accounts, as First L. ("Ada S."), whatever the choice.

import { useMemo, useSyncExternalStore } from "react";
import { demoMode } from "./demoMode.ts";
import type { Kept } from "./keptSetting.ts";
import { savedSetting } from "./savedStore.ts";

/** How the page shows names: the first name, it and the last name's first letter, in full, none, or only those picked and their connections. */
export type NameStyle = "first" | "initial" | "full" | "hide" | "except";

/** The choices, in the order offered, with what each is called and a line on it. */
export const NAME_STYLES: readonly { style: NameStyle; title: string; about: string }[] = [
  { style: "first", title: "First name", about: "The map names everyone by their first name" },
  { style: "initial", title: "First L.", about: "The map names everyone by their first name and the first letter of their last" },
  { style: "full", title: "Full name", about: "The map names everyone by their name as it is" },
  { style: "hide", title: "No name", about: "The map names nobody (h)" },
  { style: "except", title: "No name except…", about: "Every name on every screen hidden, but those of the people you pick and of everyone they share a group chat with" },
];

/** The choices an app offers: the demo's people are all made up, so it has nobody to pick for No name except…. */
export function nameStylesFor(demo: boolean): readonly { style: NameStyle; title: string; about: string }[] {
  return demo ? NAME_STYLES.filter((s) => s.style !== "except") : NAME_STYLES;
}

/** What the page shows until another choice is made: First L.. */
export const DEFAULT_NAME_STYLE: NameStyle = "initial";

/** Nobody: who No name except… names before anyone is picked, or while those picked are loading. */
export const NOBODY: ReadonlySet<number> = new Set();

/** A word of a name that counts when it is shortened: one with a letter in it, not an emoji or a number on its own. */
const LETTER = /\p{L}/u;

/** Names platforms give deleted or unknown accounts; they never say who anyone is. */
const PLACEHOLDER_NAMES = new Set([
  "facebook user",
  "instagram user",
  "messenger user",
  "unknown user",
  "deleted user",
  "whatsapp user",
  "telegram user",
  "meta user",
]);

/** Lowercase, accents and punctuation removed, single-spaced: "Esmé  O'Sample" -> "esme osample". */
function nameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whether a name is a platform's for an account it no longer knows ("Facebook user"), or none at all. The archive's
 * own check (server/archive/names.ts), which this copies so the page needs none of the archive's code; the demo
 * parity test (server/archive/demoParity.test.ts) holds the two together.
 */
export function isPlaceholderName(name: string): boolean {
  const key = nameKey(name);
  return key === "" || PLACEHOLDER_NAMES.has(key);
}

/**
 * `name` as `style` draws it: with First name its first word, with First L. that and the first letter of its last
 * word with a full stop ("Ada S."), and with any other choice as it is. Only words with a letter in them count, so
 * an emoji or a number beside a name is no word of it, and a name with fewer than two such words stays as it is (as
 * does one in Chinese, Japanese or Korean, spaced or not, whose first word would be the family name), and so do an
 * email and a platform's name for an account it no longer knows ("Facebook user").
 */
export function shortened(name: string, style: NameStyle): string {
  if (style !== "first" && style !== "initial") return name;
  const text = name.trim();
  if (text.includes("@") || isPlaceholderName(text)) return text;
  const words = text.replace(UNSPACED_GAP, "").split(/\s+/).filter((word) => LETTER.test(word));
  if (words.length < 2) return text;
  if (style === "first") return words[0];
  const initial = [...words.at(-1)!].find((c) => LETTER.test(c))!;
  return `${words[0]} ${initial}.`;
}

/**
 * A person's label, `primary`: their name, the first of the names they go by; with their next name, their first
 * alias, as `secondary` where they have one and it reads differently (null where not). With First name and First L.
 * both are shortened, and with No name the label is empty (the map's choices: see mapLabel in namesFor). With No name
 * except… it is their name, alone, if they are among those `named`, and empty if not.
 */
export function displayName(
  person: { id: number; name: string },
  aliases: readonly string[],
  style: NameStyle = "full",
  named: ReadonlySet<number> = NOBODY,
): { primary: string; secondary: string | null } {
  if (style === "hide" || (style === "except" && !named.has(person.id))) return { primary: "", secondary: null };
  if (style === "except") return { primary: person.name.trim(), secondary: null };
  const primary = shortened(person.name.trim(), style);
  const next = aliases[0] === undefined ? "" : shortened(aliases[0].trim(), style);
  return { primary, secondary: next && next !== primary ? next : null };
}

// Every search box (Join person, People, the Table) matches through `holds`:
// what is typed anywhere inside the text, after both are put in `searchForm`.

/**
 * A character of a script written without spaces, where one character is a
 * whole syllable or word: Chinese, Japanese and Korean (Script_Extensions, so
 * the marks those scripts share, such as "ー", count too).
 */
const UNSPACED = String.raw`[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]`;
const UNSPACED_CHAR = new RegExp(UNSPACED, "u");
/** Spaces between two such characters: "周 伟" is the name 周伟. */
const UNSPACED_GAP = new RegExp(String.raw`(?<=${UNSPACED})\s+(?=${UNSPACED})`, "gu");

/**
 * Text as a search compares it: compatibility forms undone and syllables taken
 * apart (NFKD), so full-width "ＲＹＡＮ" is "ryan" and a Korean syllable still
 * being typed, 기, is found inside the one it becomes, 김; lower case; and no
 * spaces between Chinese, Japanese or Korean characters.
 */
export function searchForm(text: string): string {
  return text.normalize("NFKD").toLowerCase().replace(UNSPACED_GAP, "");
}

/** Whether `text` holds the search's `words` (as typed, or already lower case). */
export function holds(text: string | null | undefined, words: string): boolean {
  return !!text && searchForm(text).includes(searchForm(words));
}

/**
 * Whether `query` says enough to search by: two characters, or one that is a
 * syllable or word on its own, such as the surname 周, さ or 김.
 */
export function enoughToSearch(query: string): boolean {
  const words = query.trim();
  return [...words].length >= 2 || UNSPACED_CHAR.test(words);
}

/** Whether a person is called this, by name or alias. */
export function goesBy(name: string, aliases: readonly string[], words: string): boolean {
  return [name, ...aliases].some((n) => holds(n, words));
}

/**
 * Who "Join person" offers for `query`: anyone called that by name or alias,
 * never the person being joined (`self`); archived people too, but after
 * everyone else, so they never crowd out the shown; at most `limit`.
 */
export function joinCandidates<P extends { id: number; name: string; aliases: readonly string[]; archived: string | null }>(
  self: number,
  everyone: readonly P[],
  query: string,
  limit = 6,
): P[] {
  if (!enoughToSearch(query)) return [];
  const matches = everyone.filter((p) => p.id !== self && goesBy(p.name, p.aliases, query));
  return [...matches.filter((p) => p.archived === null), ...matches.filter((p) => p.archived !== null)].slice(0, limit);
}

/** Where the name choice is kept: on the server in the real app, the demo's apart in its visitor's browser (savedStore.ts). */
export const NAME_STYLE_KEY = "friend-map.names";

/**
 * The choice as kept (null for none) in the app that offers `styles`. An older one carries over: "none" (an old name
 * for No name) is No name, and the two that kept every real name off the page, "demo" (Demo names, a made-up first
 * name for everyone) and "one" (One person's circle, one person and their group chats' people), are No name except…,
 * which names nobody until someone is picked; anything else not a choice there is the app's default.
 */
function parseStyle(kept: string | null, demo: boolean, fallback: NameStyle): NameStyle {
  const styles = nameStylesFor(demo).map((s) => s.style);
  const style = kept === "none" ? "hide" : kept === "demo" || kept === "one" ? "except" : kept;
  return styles.find((s) => s === style) ?? fallback;
}

/**
 * Which names an app shows (the demo's, `demo`, or the real one's), and whom No name except… names: as last chosen,
 * on any browser in the real app; the demo's starts at your choice when it is one that shows names.
 */
export function makeNameStyleStore(demo: boolean) {
  const choice = savedSetting<NameStyle>(NAME_STYLE_KEY, demo, DEFAULT_NAME_STYLE, (kept, fallback) => parseStyle(kept, demo, fallback), {
    demoTakes: (style) => style !== "hide",
  });
  /** Who No name except… names: those picked and their connections (shownNames.ts), once loaded; nobody until then. */
  let named: ReadonlySet<number> = NOBODY;
  /** The choice "h" brings back from No name: the last other one chosen. */
  const shownBefore = () => (choice.get() === "hide" ? DEFAULT_NAME_STYLE : choice.get());
  let lastShown = shownBefore();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  choice.subscribe(changed);
  const store = {
    get: choice.get,
    set(next: NameStyle): void {
      if (next !== "hide") lastShown = next;
      choice.set(next);
    },
    /** Who No name except… names now: everyone picked and their connections, once loaded. */
    named: (): ReadonlySet<number> => named,
    /** Whom shownNames.ts loaded as picked, with their connections. */
    setNamed(next: ReadonlySet<number>): void {
      if (next === named) return;
      named = next;
      changed();
    },
    /** No name, or back to the choice before it. */
    toggleHidden(): void {
      store.set(choice.get() === "hide" ? lastShown : "hide");
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Reads the choice again from `storage` (by default where it is kept), as a page opening would; for tests. */
    reload(storage?: Kept | null): void {
      choice.reload(storage);
      named = NOBODY;
      lastShown = shownBefore();
    },
  };
  return store;
}

export type NameStyleStore = ReturnType<typeof makeNameStyleStore>;

/** This page's: the demo's in the demo, the real app's everywhere else. */
export const nameStyleStore: NameStyleStore = makeNameStyleStore(demoMode);

export function useNameStyle(): NameStyle {
  // The same choice when drawn outside a browser (a test rendering a view to markup).
  return useSyncExternalStore(nameStyleStore.subscribe, nameStyleStore.get, nameStyleStore.get);
}

/** Who No name except… names now, those picked and their connections (nobody until those picked are loaded). */
export function useNamed(): ReadonlySet<number> {
  return useSyncExternalStore(nameStyleStore.subscribe, nameStyleStore.named, nameStyleStore.named);
}

/**
 * What useNames gives for one choice, with No name except… who is named (nobody by default), and in the demo
 * (`demo`) its own way off the map; apart from React, so a test can make one.
 */
export function namesFor(style: NameStyle, named: ReadonlySet<number> = NOBODY, demo = false) {
  /** No name except…: the one choice that keeps names off every screen, not the map alone. */
  const hidden = style === "except";
  /** How names read off the map: as they are, or in the demo, whose people are all made up, always as First L.. */
  const offMap: NameStyle = hidden ? style : demo ? "initial" : "full";
  return {
    style,
    /**
     * Whether real names are kept off the page, all but those named (No name except…: those picked and their connections). An empty label is then a
     * name kept off the page (drawn as a neutral shape, and never named on the map), and aliases, notes, draft
     * openers and any other name that may be someone's are hidden too.
     */
    hidden,
    /** A person's label anywhere but drawn on a map view: as it is (First L. in the demo), unless No name except… keeps it off the page. */
    label: (person: { id: number; name: string; aliases: readonly string[] }) => displayName(person, person.aliases, offMap, named),
    /** A person's name as a map view draws it: as the choice has it (the first name, with the last's first letter, in full, or none). */
    mapLabel: (person: { id: number; name: string; aliases: readonly string[] }) => displayName(person, person.aliases, style, named),
    /** Whether someone is left unnamed by No name except…, so never named, nor found by any search. */
    outside: (id: number) => hidden && !named.has(id),
    /** Any other name that may be someone's (an account's, a sender's, an alias) as a label reads off the map: nothing while names are hidden. */
    shown: (name: string) => (hidden ? "" : shortened(name, offMap)),
    /** What is no one's name but may say who (a group chat's title, a Marketplace chat's): as it is, or nothing while names are hidden. */
    titled: (title: string) => (hidden ? "" : title),
  };
}

export type Names = ReturnType<typeof namesFor>;

/**
 * Every name the page shows goes through here, so it follows the name choice:
 * `label(person)` for a person, `mapLabel(person)` for one drawn on a map view,
 * `shown(name)` for any other name that may be someone's (an account, a
 * message's sender, an alias), and `titled(title)` for a group chat's title.
 */
export function useNames(): Names {
  const style = useNameStyle();
  const named = useNamed();
  // The same functions until the choice (or who it names) changes, so a view can memoise on them.
  return useMemo(() => namesFor(style, named, demoMode), [style, named]);
}
