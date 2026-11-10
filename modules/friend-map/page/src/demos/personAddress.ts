// A person named in the page's address: /spider?person=7 opens the map with person 7's panel open, the way the life
// archive's Events calendar opens someone in Friend Map (its console's frame passes ?person= on). Read once as the
// page opens; the address then drops it, so closing the panel and reloading does not open it again.

/** The person ?person= names, or null for none (or anything but an id). */
export function personAsked(search: string): number | null {
  const text = new URLSearchParams(search).get("person");
  return text !== null && /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}

/** The address `at` without its ?person=, everything else kept. */
export function withoutPerson(at: { pathname: string; search: string; hash: string }): string {
  const params = new URLSearchParams(at.search);
  params.delete("person");
  const query = params.toString();
  return `${at.pathname}${query ? `?${query}` : ""}${at.hash}`;
}
