// Calls from the phone's call history (server/connectors/call-history), as
// the person panel and the CLI write them: "Call · 3 h 12 min", "Missed
// FaceTime video call"; the other apps' call records among the messages
// the same way (messageCallLabel); and the calls you log yourself
// (Add event's Call): the platforms they may be on and how a length is typed. Shared by the
// page and the server.

import type { PersonCall, TimelineMessage } from "./archive.ts";

/** What each service's call is called: as a call's label starts, and as one never answered says it ("Missed video call"). */
const SERVICE_NAMES: Record<NonNullable<PersonCall["service"]>, { name: string; missed: string }> = {
  phone: { name: "Call", missed: "call" },
  "facetime-audio": { name: "FaceTime audio", missed: "FaceTime audio" },
  "facetime-video": { name: "FaceTime video", missed: "FaceTime video" },
  voice: { name: "Call", missed: "call" },
  video: { name: "Video call", missed: "video call" },
};

/** The longest you may give a call whose app does not say how long it was, in minutes: a day. */
export const CALL_LENGTH_MOST_MINUTES = 24 * 60;

/** How long a call was, as people say it: "45 s", "12 min", "3 h 12 min", "2 h". */
export function callDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/**
 * What a call was: "Call · 3 h 12 min", "FaceTime video · 12 min", "Video call · 40 min"; one never answered, "Missed
 * call" when it came in and "Unanswered FaceTime audio" when it went out. Another app's in a chat (no service) is a
 * call, as a phone call is.
 */
export function callLabel(call: Pick<PersonCall, "service" | "answered" | "direction" | "durationSeconds">): string {
  const { name, missed } = SERVICE_NAMES[call.service ?? "phone"];
  if (call.answered) return `${name} · ${callDuration(call.durationSeconds)}`;
  return call.direction === "incoming" ? `Missed ${missed}` : `Unanswered ${missed}`;
}

/**
 * What a call record among the messages was, as callLabel says a phone call: "Call · 1 h 12 min", "Missed call" when
 * it came in and was never answered, "Unanswered call" when it went out; just "Call" when its app does not say how
 * long it was (WeChat, Signal, a WhatsApp call answered on another device).
 */
export function messageCallLabel(message: Pick<TimelineMessage, "callSeconds" | "fromSelf">): string {
  if (message.callSeconds === null) return "Call";
  return callLabel({
    service: null, answered: message.callSeconds > 0, direction: message.fromSelf ? "outgoing" : "incoming", durationSeconds: message.callSeconds,
  });
}

/**
 * The platforms whose accounts carry calls, so a call you log can be on one of a person's accounts there:
 * the phone's (a number or Apple ID), iMessage's (FaceTime, to the same) and the apps that call. X's never do.
 */
export const CALL_PLATFORMS: readonly string[] = ["phone", "imessage", "whatsapp", "messenger", "instagram", "signal", "telegram", "wechat", "discord"];

/** Whether an account on `platform` carries calls (CALL_PLATFORMS). */
export function carriesCalls(platform: string): boolean {
  return CALL_PLATFORMS.includes(platform);
}

/**
 * The account a new call with someone is on unless you say otherwise: of their `accounts` that carry calls,
 * the one their latest call was on (`calls`, any order), else their phone one, else the first; null with none.
 */
export function defaultCallAccount<A extends { id: number; platform: string }>(accounts: readonly A[], calls: readonly Pick<PersonCall, "accountId" | "at">[]): A | null {
  const callable = accounts.filter((account) => carriesCalls(account.platform));
  const latest = calls.filter((call) => callable.some((account) => account.id === call.accountId)).sort((a, b) => b.at - a.at)[0];
  return callable.find((account) => account.id === latest?.accountId) ?? callable.find((account) => account.platform === "phone") ?? callable[0] ?? null;
}

/**
 * What each platform a call may be on is called: an account's (iMessage's being FaceTime), or the app a call logged
 * on no account was on (a ManualCallApp).
 */
const CALL_PLATFORM_NAMES: Record<string, string> = {
  phone: "Phone",
  imessage: "FaceTime",
  facetime: "FaceTime",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  signal: "Signal",
  telegram: "Telegram",
  wechat: "WeChat",
  discord: "Discord",
  other: "another app",
};

/** "FaceTime": the platform a call was on, by its stored name ("another app" for other, or one this code does not know). */
export function callPlatformName(platform: string): string {
  return CALL_PLATFORM_NAMES[platform] ?? "another app";
}

/**
 * A call's length as typed: whole minutes ("25") or hours and minutes ("1:30", "0:45"), with space around it
 * ignored; null for anything else, or for no time at all.
 */
export function parseCallLength(text: string): number | null {
  const clean = text.trim();
  const minutes = /^\d+$/.test(clean) ? Number(clean) : null;
  const hours = /^(\d+):([0-5]\d)$/.exec(clean);
  const total = minutes ?? (hours ? Number(hours[1]) * 60 + Number(hours[2]) : null);
  return total === null || total < 1 ? null : total;
}

/** A length in whole minutes as the form shows it to change: "25", or "1:30" from an hour. */
export function callLengthText(minutes: number): string {
  return minutes < 60 ? String(minutes) : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** A person's calls added up: how many were answered and for how long in all, and how many were not. */
export function callTotals(calls: readonly Pick<PersonCall, "answered" | "durationSeconds">[]): { answered: number; seconds: number; unanswered: number } {
  let answered = 0;
  let seconds = 0;
  for (const call of calls) {
    if (!call.answered) continue;
    answered++;
    seconds += call.durationSeconds;
  }
  return { answered, seconds, unanswered: calls.length - answered };
}
