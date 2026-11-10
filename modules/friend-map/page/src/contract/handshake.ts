// The handshake (GET /api/archive/contract): which contract a backend serves, what of it, and in which time zone. The
// page's entry asks before anything draws (src/main.tsx, src/demo/main.tsx), and friend-map's server as it scores
// (server/methodology.ts); each then counts days in the backend's zone (time.ts) and asks only for what it offers.
//
// A backend with no GET /contract (it answers 404) is taken to be one from before the handshake: the life archive's,
// until it serves one, which serves every capability, in this machine's time zone (preContract). That fallback goes
// in contract 2.0.

import { CAPABILITIES, CONTRACT_VERSION, type Capability, type Contract } from "../archive.ts";
import { ArchiveDown, type ArchiveApi } from "../archiveApi.ts";
import { machineTimeZone, setLocale, setTimeZone } from "../time.ts";
import { contractShape } from "./schema.ts";
import { problemsOf } from "./shape.ts";

/** Every capability the page knows, `scores` (friend-map's own) among them. */
export const KNOWN_CAPABILITIES = Object.keys(CAPABILITIES) as Capability[];

/** The capability friend-map's server adds to its backend's: it scores the Table and the Events chart itself. */
export const OWN_CAPABILITY: Capability = "scores";

/** The contract a backend with no handshake is taken to serve: everything a backend may, in this machine's time zone. */
export function preContract(): Contract {
  return { version: CONTRACT_VERSION, capabilities: KNOWN_CAPABILITIES.filter((c) => c !== OWN_CAPABILITY), timeZone: machineTimeZone() };
}

/** A contract version's major number (1 for "1.4.0"); NaN for no version. */
export function majorOf(version: string): number {
  const match = /^(\d+)\.\d+\.\d+$/.exec(version);
  return match ? Number(match[1]) : NaN;
}

/**
 * Why the page cannot use `answer` as a handshake, in a sentence: not a Contract, a major version other than
 * CONTRACT_VERSION's, no `map` capability, or a time zone that is none; null when it can.
 */
export function refusal(answer: unknown): string | null {
  const problems = problemsOf(contractShape, answer);
  if (problems.length > 0) return `its handshake is not a contract (${problems.map((p) => `${p.path} ${p.problem}`).join("; ")})`;
  const contract = answer as Contract;
  if (majorOf(contract.version) !== majorOf(CONTRACT_VERSION)) {
    return `it serves contract ${contract.version}, and this friend-map reads contract ${majorOf(CONTRACT_VERSION)}.x (${CONTRACT_VERSION})`;
  }
  if (!contract.capabilities.includes("map")) return "it does not serve the map (the `map` capability), which every backend must";
  try {
    new Intl.DateTimeFormat("en", { timeZone: contract.timeZone });
  } catch {
    return `its time zone, ${JSON.stringify(contract.timeZone)}, is not one (an IANA name such as "Europe/Berlin")`;
  }
  if (contract.locale !== undefined && Intl.DateTimeFormat.supportedLocalesOf([contract.locale]).length === 0) {
    return `its locale, ${JSON.stringify(contract.locale)}, is not one this browser writes (a BCP 47 tag such as "de-DE")`;
  }
  return null;
}

let current: Contract = { ...preContract(), capabilities: [...KNOWN_CAPABILITIES] };

/** Takes `contract` as the backend's (one refusal finds nothing wrong with): its capabilities, and its time zone and locale from now on. */
export function takeContract(contract: Contract): void {
  setTimeZone(contract.timeZone);
  if (contract.locale !== undefined) setLocale(contract.locale);
  current = contract;
}

/** The backend's contract, as last taken (takeContract); before any, every capability, in this machine's time zone. */
export function contract(): Contract {
  return current;
}

/** Whether the backend serves `capability`. */
export function offers(capability: Capability): boolean {
  return current.capabilities.includes(capability);
}

/** Whether the backend takes any change at all (an `edit.` capability): without one, the page is read-only (readOnly.ts). */
export function takesEdits(): boolean {
  return current.capabilities.some((capability) => capability.startsWith("edit."));
}

/**
 * Asks `archive` for its handshake and takes it (takeContract): null when the page can use this backend; else why it
 * cannot, in a sentence (`refused`), or, when no backend answers at all, friend-map's server's words for it (`down`).
 */
export async function shakeHands(archive: Pick<ArchiveApi, "contract">): Promise<{ refused: string } | { down: string } | null> {
  let answer: unknown;
  try {
    answer = await archive.contract();
  } catch (error) {
    if (error instanceof ArchiveDown) return { down: error.reason };
    return { refused: `its handshake failed (${(error as Error).message})` };
  }
  const why = refusal(answer);
  if (why !== null) return { refused: why };
  takeContract(answer as Contract);
  return null;
}
