// Normalising names and handles so the same person can be recognised across
// platforms.

/** Labels platforms give deleted or unknown accounts; they never identify anyone. */
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
export function nameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Text with its typesetting undone, to tell what it is by its shape: format and
 * direction marks dropped, every space a plain space and every dash a hyphen.
 * WhatsApp writes a number as "\u202a+1\u00a0202\u00a0555\u20110143\u202c":
 * wrapped in direction marks, grouped with no-break spaces, with a non-breaking hyphen.
 */
export function plainText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Zs}/gu, " ")
    .replace(/[\p{Pd}\u2212]/gu, "-")
    .trim();
}

/** A name that is only a number, however it is written: "+61 491 571 266", "(03) 7010 0000", "78787". */
export function isNumberName(name: string): boolean {
  const plain = plainText(name);
  return /\d/.test(plain) && /^[+\d\s()[\].\-/]+$/.test(plain);
}

/**
 * A "name" that is data WhatsApp keeps in a name column: a protobuf message
 * written in base64, such as "COC7/7cGIAA=", "CKqC+pYG", "COmDxooG" or "+EAA="
 * (the iPhone app's ZWAMESSAGE.ZPUSHNAME and ZWAGROUPMEMBER.ZFIRSTNAME hold
 * these, the latter with a "+" in front). It is one word of base64, a whole
 * number of four-character groups with a letter in it (so never a phone
 * number), that decodes to a complete protobuf message with a number in it:
 * any number when the word has a digit, "+", "/" or "=", and one of five bytes
 * or more (the time in seconds WhatsApp's carry) when it is letters alone,
 * which by chance only a handful of a quarter of a million dictionary words
 * do. So "Cleo", "Cleo2000" and "+61491571266" are names.
 */
export function isEncodedName(name: string): boolean {
  const text = name.trim().replace(/^\+/, "");
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text) || !/[A-Za-z]/.test(text)) return false;
  const message = protobufOf(Uint8Array.from(atob(text), (char) => char.charCodeAt(0)));
  return message !== null && message.longestNumber >= (/[\d+/=]/.test(text) ? 1 : 5);
}

/**
 * Bytes read as one protobuf message in wire format as an encoder writes it,
 * field after field to the last byte, with the length in bytes of its longest
 * number (a varint field's value); null when they are not one. Field numbers
 * are taken to be under 2048, as WhatsApp's are.
 */
function protobufOf(bytes: Uint8Array): { longestNumber: number } | null {
  let at = 0;
  let longestNumber = 0;
  const varint = (): { value: number; length: number } | null => {
    const from = at;
    let value = 0;
    for (let shift = 0; shift < 70 && at < bytes.length; shift += 7) {
      const byte = bytes[at++];
      value += (byte & 0x7f) * 2 ** shift;
      // An encoder writes no needless zero byte at the end.
      if (byte < 0x80) return byte === 0 && at - from > 1 ? null : { value, length: at - from };
    }
    return null;
  };
  while (at < bytes.length) {
    const tag = varint();
    // A field number from 1 to 2047: a tag of one or two bytes.
    if (tag === null || tag.value < 8 || tag.length > 2) return null;
    const wireType = tag.value % 8;
    if (wireType === 0) {
      const number = varint();
      if (number === null) return null;
      longestNumber = Math.max(longestNumber, number.length);
    } else if (wireType === 1) at += 8;
    else if (wireType === 5) at += 4;
    else if (wireType === 2) {
      const length = varint();
      if (length === null) return null;
      at += length.value;
    } else return null;
    if (at > bytes.length) return null;
  }
  return bytes.length > 0 ? { longestNumber } : null;
}

/**
 * A name as it is compared for joining people: character for character, with
 * only what can't be seen undone, as plainText does: format and direction marks
 * dropped, every space a plain space, spaces at either end taken off, and an
 * accent written as one character or two the same (NFC). Case, accents, dashes
 * and punctuation all count, so unlike plainText there is no NFKC or dash folding.
 */
export function sameName(name: string): string {
  return name.normalize("NFC").replace(/\p{Cf}/gu, "").replace(/\p{Zs}/gu, " ").trim();
}

/**
 * Whether people with this exact name are joined by themselves: a name of two
 * words or more, or one in Chinese characters (which has no spaces). A lone
 * word such as "Cleo" or "Hugo" is too common to join on; it is proposed.
 */
export function joinsByName(name: string): boolean {
  const same = sameName(name);
  return /\s/u.test(same) || /\p{Script=Han}/u.test(same);
}

export function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_NAMES.has(nameKey(name)) || nameKey(name) === "";
}

/** The country calling code local numbers are read in ("61"), from the settings (server/onSettings.ts); null leaves them as written. */
let phoneCountry: string | null = null;

export function setPhoneCountry(code: string | null): void {
  phoneCountry = code;
}

/**
 * A phone number as E.164 (`+61491571266`), or an email in lowercase. A local
 * number (0 and nine digits, `0491 571 266`) is read in the phone country, if any.
 * Either may be written with any spaces, dashes and marks (see plainText).
 * Anything else is returned trimmed.
 */
export function normalizeHandle(handle: string): string {
  const plain = plainText(handle);
  if (plain.includes("@")) return plain.toLowerCase();
  const digits = plain.replace(/[\s()[\].\-/]/g, "");
  if (/^\+\d{6,15}$/.test(digits)) return digits;
  if (/^00\d{6,15}$/.test(digits)) return `+${digits.slice(2)}`;
  if (phoneCountry !== null && /^0\d{9}$/.test(digits)) return `+${phoneCountry}${digits.slice(1)}`;
  return handle.trim();
}

export function isPhone(handle: string): boolean {
  return /^\+\d{6,15}$/.test(handle);
}
