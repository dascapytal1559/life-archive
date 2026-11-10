// The shapes WeChat keeps inside its database fields, each read as structure:
//
// - A contact's dbContactRemark is a protobuf message: 1 their nickname, 2 the
//   WeChat ID they chose, 3 the captain's remark for them (4 and 5 its pinyin).
// - A group's dbContactChatRoom is one too: 1 its members' ids joined by ";",
//   6 XML with a <Member UserName="..."> for each (the only list some groups have).
// - A message's Message is text, or, where WCDB compressed it (WCDB_CT_Message
//   not 0), a zstd frame. WeChat compresses with a dictionary that the app
//   holds and the backup does not, whose id the frame's header gives: such a
//   frame is read only when that dictionary is given (the `dictionary` setting).
// - A group message from anyone but the captain starts with its sender's id:
//   "<id>:\n<content>".
// - An app message (Type 49: a link, a file, a reply, a mini program) is XML,
//   <msg><appmsg><type>5</type><title>..</title><url>..</url>..</appmsg></msg>;
//   a reply holds the message it answers in <refermsg>, with that one's <svrid>.
// - A call record (Type 50) is XML, <voipmsg type="VoIPBubbleMsg"><VoIPBubbleMsg>
//   <msg>..</msg>..</VoIPBubbleMsg></voipmsg>, whose <msg> holds the words the
//   app shows for the call in the phone's language: how long it was connected
//   ("通话时长 00:31", "Duration 01:02:03"), or that it was cancelled, declined,
//   not answered, busy or failed ("已取消", "对方已拒绝", "Canceled", "No answer").

import { zstdDecompressSync } from "node:zlib";
import type { SQLOutputValue } from "node:sqlite";
import { protobufMessage } from "../protobuf.ts";

/** Top-level fields of a protobuf message, the first of each: length-delimited ones as UTF-8, varints as numbers. Null if it is not one. */
export function protobufFields(bytes: Uint8Array): Map<number, string | number> | null {
  const message = protobufMessage(bytes);
  if (!message) return null;
  return new Map([...message].map(([field, [first]]) => [field, typeof first === "number" ? first : Buffer.from(first).toString("utf8")]));
}

export interface Remark {
  nickname: string;
  /** The WeChat ID they chose, if any (their wxid is fixed; this they can set once). */
  alias: string;
  /** The captain's own name for them. */
  remark: string;
}

/** A contact's names, from its dbContactRemark. */
export function contactRemark(bytes: SQLOutputValue): Remark {
  const fields = bytes instanceof Uint8Array ? protobufFields(bytes) : null;
  const text = (field: number) => {
    const value = fields?.get(field);
    return typeof value === "string" ? value.trim() : "";
  };
  return { nickname: text(1), alias: text(2), remark: text(3) };
}

/** A group's members' ids, from its dbContactChatRoom: the ";" list and the XML's members, together. */
export function roomMembers(bytes: SQLOutputValue): string[] {
  const fields = bytes instanceof Uint8Array ? protobufFields(bytes) : null;
  if (!fields) return [];
  const list = fields.get(1);
  const xml = fields.get(6);
  const members = new Set(typeof list === "string" ? list.split(";").map((id) => id.trim()).filter(Boolean) : []);
  if (typeof xml === "string") for (const [, id] of xml.matchAll(/<Member\s[^>]*?UserName="([^"]+)"/g)) members.add(decodeXml(id));
  return [...members];
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** What a message's Message holds. */
export type Content =
  | { kind: "text"; text: string; decompressed: boolean }
  /** A zstd frame that could not be read: it needs a dictionary not given (`dictionaryId`), or is damaged. */
  | { kind: "compressed"; dictionaryId: number | null };

/** A message's content: its text, decompressed when it is a zstd frame this import can read. */
export function messageContent(message: SQLOutputValue, dictionary: Uint8Array | null): Content {
  if (typeof message === "string") return { kind: "text", text: message, decompressed: false };
  if (!(message instanceof Uint8Array)) return { kind: "text", text: "", decompressed: false };
  const header = zstdHeader(message);
  if (!header) return { kind: "text", text: Buffer.from(message).toString("utf8"), decompressed: false };
  const unread: Content = { kind: "compressed", dictionaryId: header.dictionaryId };
  try {
    const bytes = zstdDecompressSync(message, dictionary ? { dictionary } : {});
    // A frame cut short decompresses to what it holds, without an error: its header says how much there should be.
    if (header.contentSize !== null && bytes.length !== header.contentSize) return unread;
    return { kind: "text", text: bytes.toString("utf8"), decompressed: true };
  } catch {
    return unread;
  }
}

/** What a zstd frame's header says: the dictionary it was made with and its content's size, each null when it does not say. Null for no frame. */
export function zstdHeader(frame: Uint8Array): { dictionaryId: number | null; contentSize: number | null } | null {
  if (frame.length < 6 || !ZSTD_MAGIC.every((byte, i) => frame[i] === byte)) return null;
  const descriptor = frame[4];
  const singleSegment = (descriptor >> 5) & 1;
  const dictionarySize = [0, 1, 2, 4][descriptor & 3];
  const sizeFlag = descriptor >> 6;
  const contentSizeSize = sizeFlag === 0 ? singleSegment : [0, 2, 4, 8][sizeFlag];
  // A window descriptor byte comes first unless the frame is a single segment.
  const at = 5 + (singleSegment ? 0 : 1);
  if (at + dictionarySize + contentSizeSize > frame.length) return null;
  const number = (from: number, size: number) => {
    let value = 0;
    for (let i = size - 1; i >= 0; i--) value = value * 256 + frame[from + i];
    return value;
  };
  return {
    dictionaryId: dictionarySize > 0 ? number(at, dictionarySize) : null,
    // A two-byte size counts from 256.
    contentSize: contentSizeSize > 0 ? number(at + dictionarySize, contentSizeSize) + (contentSizeSize === 2 ? 256 : 0) : null,
  };
}

/** A group message from someone else: its sender's id and the content after it; null when it starts with none. */
export function splitSender(content: string): { sender: string; body: string } | null {
  const match = content.match(/^([A-Za-z0-9_@.-]+):\n/);
  return match ? { sender: match[1], body: content.slice(match[0].length) } : null;
}

export interface AppMessage {
  /** What kind of app message: 5 a link, 6 a file, 57 a reply, and many more. */
  subtype: number | null;
  title: string;
  url: string;
  /** For a reply, the WeChat id (svrid) of the message it answers. */
  replyTo: string;
}

/** The parts of an app message's XML that say what it is. */
export function appMessage(xml: string): AppMessage {
  const quoted = xml.match(/<refermsg>([\s\S]*?)<\/refermsg>/);
  // What a reply quotes has a type, title and url of its own: read the reply's own outside it.
  const own = quoted ? xml.replace(quoted[0], "") : xml;
  const subtype = Number(element(own, "type"));
  return {
    subtype: Number.isSafeInteger(subtype) && element(own, "type") !== "" ? subtype : null,
    title: element(own, "title"),
    url: element(own, "url"),
    replyTo: quoted ? element(quoted[1], "svrid") : "",
  };
}

/** How a call ended: connected for a while, or never connected, and why, as far as the app's words say. */
export type CallOutcome = "answered" | "cancelled" | "declined" | "missed";

/** Words in a call's <msg> that say it never connected, each with what they say. Lower case: matched on lower-cased words. */
const UNCONNECTED: Array<[RegExp, Exclude<CallOutcome, "answered">]> = [
  [/取消|cancel/, "cancelled"],
  [/拒绝|declin|reject/, "declined"],
  [/无应答|未应答|未接|忙线|失败|no answer|unanswered|missed|busy|fail|not answered/, "missed"],
];

/**
 * A call record's outcome and, for one that connected, its length in whole seconds, from the words its <msg> holds
 * (see above): a time ("mm:ss" or "h:mm:ss") is how long it was connected; words saying it never connected make its
 * length 0. Null when the words say neither, so its length stays unknown.
 */
export function voipCall(content: string): { outcome: CallOutcome; seconds: number } | null {
  const words = (element(content, "msg") || content).toLowerCase();
  const time = words.match(/(?:^|[^\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?![\d:])/);
  if (time) {
    const [, hours, minutes, seconds] = time;
    return { outcome: "answered", seconds: Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) };
  }
  for (const [pattern, outcome] of UNCONNECTED) if (pattern.test(words)) return { outcome, seconds: 0 };
  return null;
}

/** The text of the first <name> element, unescaped; "" when there is none. */
function element(xml: string, name: string): string {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!match) return "";
  const cdata = match[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (cdata ? cdata[1] : decodeXml(match[1])).trim();
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#")) {
      const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : Number(lower.slice(1));
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[lower] ?? whole;
  });
}
