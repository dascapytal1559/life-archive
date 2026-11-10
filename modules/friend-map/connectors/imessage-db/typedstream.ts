// The text inside a message's attributedBody: an NSAttributedString archived in
// Apple's old "typedstream" format, which is where newer iOS and macOS keep
// what someone wrote when the `text` column is empty (edited messages, and
// many others). Only the string itself is read; the formatting runs after it
// are not.
//
// An archive starts "\x04\x0bstreamtyped", then the class chain
// (NSAttributedString, NSObject), then the string's own class chain ending in
// "NSString", then "\x84\x01+" (a byte string follows) and its length: one byte
// below 0x80, or 0x81 and two bytes, or 0x82 and four bytes, little-endian. Then
// the UTF-8 bytes.

const HEADER = Buffer.from("streamtyped");
const STRING_CLASS = Buffer.from("NSString");
const BYTE_STRING = Buffer.from([0x84, 0x01, 0x2b]);
/** How far after "NSString" the byte string may start (the class chain's version and end markers). */
const MAX_GAP = 16;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The string an attributedBody holds, or null when it is not one this reads. */
export function attributedBodyText(blob: Uint8Array): string | null {
  const bytes = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (bytes.indexOf(HEADER) !== 2) return null;
  const classAt = bytes.indexOf(STRING_CLASS);
  if (classAt < 0) return null;
  const marker = bytes.indexOf(BYTE_STRING, classAt + STRING_CLASS.length);
  if (marker < 0 || marker > classAt + STRING_CLASS.length + MAX_GAP) return null;
  let at = marker + BYTE_STRING.length;
  if (at >= bytes.length) return null;
  let length = bytes[at++];
  if (length === 0x81) {
    if (at + 2 > bytes.length) return null;
    length = bytes.readUInt16LE(at);
    at += 2;
  } else if (length === 0x82) {
    if (at + 4 > bytes.length) return null;
    length = bytes.readUInt32LE(at);
    at += 4;
  } else if (length >= 0x80) {
    return null;
  }
  if (at + length > bytes.length) return null;
  try {
    return utf8.decode(bytes.subarray(at, at + length));
  } catch {
    return null;
  }
}
