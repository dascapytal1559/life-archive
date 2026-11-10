// Aspiring friends: people you think about a lot and have never really met, kept
// on the map to gather what you would say to them, in their note. It is a plain
// tag the views read, so a backend needs nothing new: tagging someone "aspiring"
// sets them far out at the edge of Orbits and the Spider web in a big bubble
// (aspiringPlaces in src/demos/orbitsLayout.ts), and taking the tag off brings them
// in by their closeness like anyone else. Added by hand they have no messages,
// and a backend's rules leave anyone edited by hand on the map. The tag is not
// one of BUILT_IN_TAGS: it comes and goes like any tag of yours.

/** Tagging someone this makes them an aspiring friend. */
export const ASPIRING_TAG = "aspiring";

/** Whether someone with these tags is an aspiring friend (ASPIRING_TAG). */
export function isAspiring(person: { tags: readonly string[] }): boolean {
  return person.tags.includes(ASPIRING_TAG);
}
