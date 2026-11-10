// Places of the console that moved to another place: a module's tab folded into another page, as Friend Map's Messages
// tab into the Events page's Tables. The module says so in its viewer.tsx (sdk/viewer.ts's `moved`), by the steps of its
// old address ("friend-map/messages") to the steps of an address that opens it now ("events/messages"), and an old
// address, a bookmark or a link kept somewhere, opens the new place with its query as it was. The registry reads a
// place through this (registry.ts's placeOf), and so does Events' Tables for the table an address names
// (EventsSection.tsx's tableNamed); registryProblems holds each to an old place no view is at and a new one that is there.

import { moduleViewers } from "../modules.ts";

/**
 * Every loaded module's moved places, by the old address's steps, each to the steps it moved to. A module that is off is
 * never loaded (viewer/modules.ts), so its old addresses open the console's home, as what they held is gone with it.
 */
export const MOVED: Readonly<Record<string, string>> = Object.assign({}, ...moduleViewers().map(({ viewer }) => viewer?.moved ?? {}));

/** The steps an address names now: `steps` (address.ts's stepsOf) as they are, or for a place that moved, the steps it moved to. */
export function stepsNow(steps: readonly [aspect: string, section: string], moved: Readonly<Record<string, string>> = MOVED): [aspect: string, section: string] {
  const from = steps.join("/");
  if (!Object.hasOwn(moved, from)) return [steps[0], steps[1]];
  const [aspect = "", section = ""] = moved[from]!.split("/");
  return [aspect, section];
}
