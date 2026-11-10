// The people's faces on the calendar: their initials in a quiet tint from their id (the archive keeps no pictures of
// anyone), in the day's people and whom he messaged (a call's or hangout's card names its people instead).

import type { CSSProperties } from "react";
import { hueOf, initials } from "./calendar.ts";

/** A person's face: their initials in their tint, their name on hover. */
export function Face({ id, name }: { id: number; name: string }) {
  return (
    <i className="cal-face" style={{ "--face-h": hueOf(id) } as CSSProperties} title={name}>
      {initials(name)}
    </i>
  );
}
