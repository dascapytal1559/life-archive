import { describe, expect, it } from "vitest";
import { isEncodedName, isNumberName, normalizeHandle, plainText } from "./names.ts";

// Numbers as WhatsApp typesets them: wrapped in direction marks (U+202A ... U+202C),
// grouped with no-break spaces (U+00A0), with a non-breaking hyphen (U+2011).
const AU = "‪+61 491 570 006‬";
const US = "‪+1 202 555‑0143‬";

describe("plainText", () => {
  it("drops format and direction marks, and makes every space a space and every dash a hyphen", () => {
    expect(plainText(US)).toBe("+1 202 555-0143");
    expect(plainText("‎⁦+61 491 571−266⁩‏")).toBe("+61 491 571-266");
    expect(plainText("— Ada Sample ―")).toBe("- Ada Sample -");
  });
});

describe("isNumberName", () => {
  it("knows a name that is only a number, however it is typeset", () => {
    for (const name of [AU, US, "+61 491 571 266", "(03) 7010 0000", "[03] 7010-0000", "78787", "７８７８７", "0491/571/266"]) {
      expect(isNumberName(name), JSON.stringify(name)).toBe(true);
    }
  });

  it("leaves names with any letter, and punctuation with no digit", () => {
    for (const name of ["Ada Sample", "Flat 4", "CommBank", "+", "‪‬", "-", ""]) {
      expect(isNumberName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("isEncodedName", () => {
  it("knows the base64 protobuf messages WhatsApp keeps in name columns", () => {
    // Made up in the shapes of ZWAMESSAGE.ZPUSHNAME's (a time in seconds, then more fields) and ZWAGROUPMEMBER.ZFIRSTNAME's ("+" in front).
    for (const name of ["CKDw3MYGIAA=", "CJCPsoEG", "CKqC+pYG", "CNC2usQGIABIAZABAA==", "+EAA=", "+GAAgAA==", "+CgAQgOzv1AY=", " CKDw3MYGIAA= "]) {
      expect(isEncodedName(name), JSON.stringify(name)).toBe(true);
    }
  });

  it("leaves names, numbers and base64 that is no protobuf message", () => {
    for (const name of [
      "Ada Sample", "Cleo", "Cleo2000", "+61491571266", "61491571266", "78787", "CommBank", "sam@example.com",
      // Base64 of text, of a message that stops short, and a letters-only word whose message carries no long number.
      btoa("Ada"), "CKDw3MY=", "EAAA", "+", "=", "",
    ]) {
      expect(isEncodedName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("normalizeHandle", () => {
  it("reads a typeset number as E.164", () => {
    expect(normalizeHandle(AU)).toBe("+61491570006");
    expect(normalizeHandle(US)).toBe("+12025550143");
    expect(normalizeHandle("‪0491 571 266‬")).toBe("+61491571266");
  });

  it("reads a typeset email in lowercase, and returns anything else as it was, trimmed", () => {
    expect(normalizeHandle("⁦Sam@Example.com⁩")).toBe("sam@example.com");
    expect(normalizeHandle(" CommBank ")).toBe("CommBank");
  });
});
