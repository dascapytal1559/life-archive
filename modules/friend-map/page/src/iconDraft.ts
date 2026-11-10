// The icon picker's draft (IconPicker.tsx): the identicon being tried on
// someone (the one they have still shows in the person panel), saved only by
// Save, as one change. Colour and picture change apart: a colour from the row
// or the slider recolours the draft, keeping its picture; New picture keeps its
// colour; New colour keeps its picture and moves its colour well round the wheel.

import type { PersonSummary } from "./archive.ts";
import { saveIdenticon } from "./changeChip.ts";
import { identicon, randomIdenticonSeed } from "./identicon.ts";

type Drawn = Pick<PersonSummary, "identiconSeed" | "identiconHue">;

/** What a drafted identicon is drawn from: a seed and the hue picked (null for the seed's own). */
export interface IconDraft {
  seed: string;
  hue: number | null;
}

/** The hue someone's identicon is in, whole degrees: the one picked, or the seed's own, rounded. */
export function currentHue(person: Drawn): number {
  return person.identiconHue ?? Math.round(identicon(person.identiconSeed).hue) % 360;
}

/** The hue a draft is in, whole degrees. */
export function draftHue(draft: IconDraft): number {
  return currentHue({ identiconSeed: draft.seed, identiconHue: draft.hue });
}

/** A draft as they are now, to start from. */
export function startDraft(person: Drawn): IconDraft {
  return { seed: person.identiconSeed, hue: person.identiconHue };
}

/** A colour picked from the row or the slider: the draft's picture in it. */
export function recolour(draft: IconDraft, hue: number): IconDraft {
  return { seed: draft.seed, hue };
}

/** How far round the wheel New colour moves at least, so the new colour is clearly another. */
export const NEW_COLOUR_MIN_TURN = 60;

/** New colour: the draft's picture in a hue at random at least NEW_COLOUR_MIN_TURN degrees either way from its own. */
export function newColour(draft: IconDraft, random = Math.random()): IconDraft {
  const turn = NEW_COLOUR_MIN_TURN + Math.floor(random * (361 - 2 * NEW_COLOUR_MIN_TURN));
  return { seed: draft.seed, hue: (draftHue(draft) + turn) % 360 };
}

/** New picture: a new picture in the draft's colour (pinned, if it was the seed's own, so it stays). */
export function newPicture(draft: IconDraft, seed = randomIdenticonSeed()): IconDraft {
  return { seed, hue: draftHue(draft) };
}

/** What saving the draft would do to them: a new colour, a new picture in the colour they have, or nothing (null). */
export function drafted(person: Drawn, draft: IconDraft): "colour" | "picture" | null {
  if (draft.seed === person.identiconSeed && draft.hue === person.identiconHue) return null;
  return draftHue(draft) === currentHue(person) ? "picture" : "colour";
}

/** Saves the draft on them as one change, with its chip; null, saving nothing, when it is what they have. */
export async function saveDraft(person: PersonSummary, draft: IconDraft): Promise<PersonSummary | null> {
  const done = drafted(person, draft);
  return done ? saveIdenticon(person.id, draft.seed, draft.hue, done) : null;
}
