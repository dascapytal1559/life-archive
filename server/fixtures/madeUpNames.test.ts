import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CROWD_FIRST, CROWD_LAST, FIRST_NAMES, isMadeUpName, LAST_NAMES, madeUpName, NICKNAMES, PUBLIC_FIGURES, STAND_INS, WHOLE_NAMES } from "./madeUpNames.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// What the tests write that reads like a name but is not a name at all.
const NOT_NAMES = [
  "Audio Message", "Body Mass", "Both Different", "Both Same", "Call Duration", "Captain Pty", "Claude Code", "Climbing Crew",
  "Climbing Sunday", "Comfort Food", "Crowd Member", "Daily News", "Default Title", "Deleted User", "Direct Message", "Edited Name", "Every Instagram", "Example Bot", "File Transfer", "Former Flatmate",
  "Friend Map", "From Messenger", "Gold Coast", "Grok Bot", "Grove Street", "Haemolysis Index", "Health Record", "Hey Cleo", "High Intensity", "Low Intensity", "Strength Training", "Hi Ada", "Hi Cleo", "Instagram User", "Interior Design", "Invited Ada",
  "Lives Only", "Lorem Crew", "Merry Christmas", "Met Only", "Met Too", "My Health", "New York", "Night Owls", "Noto Sans", "Other Anions", "Other Name",
  "Pathology Report", "Pathology Results", "Plumbing Co", "Polar Flow", "Put Dot", "Sample Imaging", "Sample Lab", "Sample Labs", "Sample Pathology", "Sample Person",
  "Sample Server", "Sample Walkers", "Saved Messages", "Since Aug", "Someone Else", "Take Ada", "Take Bea", "Tent Guy", "The Sample",
  "Throat Swab", "Took Dot", "Tokyo City", "Total Body", "Two Words", "Uni Friends", "Unknown Participant", "Voice Memos", "Welcome Cleo", "West End",
  // An activity's name, as the Fitness page names one by the part of the day and the sport.
  "Afternoon Run", "Evening Ride", "Evening Run", "Evening Strength", "Lunch Run", "Morning Run", "Night Run",
  // A workout's title as rituals derives one from its category, and made-up words in rituals' own tests.
  "Gym Legs", "Gym Pull", "Gym Push", "Fictional Checking", "Future Type",
  // Typefaces the page names, and its words to the reader.
  "Book Antiqua", "Iowan Old", "Palatino Linotype", "Press Enter",
  // Diseases and made-up vaccines, as an immunisation record prints them.
  "Diphtheria Tetanus", "Exampleitis Fever", "Samplevax Trio", "Tetanus Exampleitis", "Yellow Fever",
];

/** Each quoted string in the tests, fixtures and testing data, the modules' too, that starts with two capitalised words, with where it is. */
function quotedPairs(): Array<{ pair: string; where: string }> {
  const files = globSync(["**/*.test.ts", "**/*.test.tsx", "server/fixtures/*.ts", "server/*/fixtures/*.ts", "modules/*/fixtures/*.ts", "modules/*/fixtures/data/**/*.json", "modules/*/page/**/*.{ts,tsx}", "testing-data/*.json"], {
    cwd: ROOT,
    // Never into data/, which is private, nor into what is installed or built.
    exclude: (path) => /^(?:data|dist[^/]*)(?:\/|$)|(?:^|\/)node_modules(?:\/|$)/.test(path),
  });
  return files.flatMap((file) =>
    readFileSync(ROOT + file, "utf8").split("\n").flatMap((line, i) =>
      [...line.matchAll(/["'`]([A-Z][a-z]+ [A-Z][a-z]+)\b/g)].map((m) => ({ pair: m[1]!, where: `${file}:${i + 1}` }))));
}

describe("made-up names", () => {
  it("name everyone the tests, fixtures and testing data name, or the pair is a public figure or not a name", () => {
    const known = (pair: string) =>
      isMadeUpName(pair) || WHOLE_NAMES.some((name) => name.startsWith(`${pair} `)) || [...PUBLIC_FIGURES, ...STAND_INS, ...NOT_NAMES].includes(pair);
    const unknown = quotedPairs().filter(({ pair }) => !known(pair)).map(({ pair, where }) => `${where} ${pair}`);
    // A new made-up name goes in madeUpNames.ts first; an ordinary phrase, a public figure or a dictionary stand-in goes in this file's lists.
    expect(unknown).toEqual([]);
  });

  it("hold the testing data's people: their names, aliases and the accounts' names", () => {
    const people = JSON.parse(readFileSync(`${ROOT}modules/friend-map/fixtures/data/people.json`, "utf8")) as Array<{ name: string; aliases?: string[]; accounts?: Array<{ key: string }> }>;
    // An alias may be a made-up name, a made-up first name alone or a made-up nickname; an account's key that reads as a name, a made-up name.
    const madeUpAlias = (alias: string) => isMadeUpName(alias) || FIRST_NAMES.includes(alias) || NICKNAMES.includes(alias);
    for (const person of people) {
      expect(isMadeUpName(person.name), person.name).toBe(true);
      for (const alias of person.aliases ?? []) expect(madeUpAlias(alias), `${person.name}'s alias ${alias}`).toBe(true);
      for (const { key } of person.accounts ?? []) if (/^\p{L}+(?: \p{L}+)+$/u.test(key)) expect(isMadeUpName(key), `${person.name}'s account ${key}`).toBe(true);
    }
  });

  it("keep the crowd's pools first, never the dictionary's stand-in, and none twice", () => {
    expect(FIRST_NAMES.slice(0, CROWD_FIRST.length)).toEqual(CROWD_FIRST);
    expect(LAST_NAMES.slice(0, CROWD_LAST.length)).toEqual(CROWD_LAST);
    for (const name of [...PUBLIC_FIGURES, ...STAND_INS]) expect(isMadeUpName(name)).toBe(false);
    for (const list of [FIRST_NAMES, LAST_NAMES, WHOLE_NAMES]) expect(new Set(list).size).toBe(list.length);
  });

  it("give as many different names as the pools make", () => {
    const count = FIRST_NAMES.length * LAST_NAMES.length;
    const names = Array.from({ length: count }, (_, n) => madeUpName(n));
    expect(new Set(names).size).toBe(count);
    expect(names.every(isMadeUpName)).toBe(true);
    expect(madeUpName(0)).toBe("Ada Sample");
    expect(madeUpName(count)).toBe("Ada Sample");
  });
});
