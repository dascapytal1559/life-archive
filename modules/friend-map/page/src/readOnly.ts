// Whether the page can change anything. The app's page can, except the demo's
// (the static demo's, demoMode.ts): its archive refuses every
// write, and its person panel shows what an editor would edit (name, aliases,
// tags, location, note, reaching out, accounts) as plain text, with no button,
// box or switch to change it. The static demo's entry (src/demo/main.tsx) wraps
// everything in the provider, as the app's (src/main.tsx) does where its backend takes no edits;
// the pieces of the person panel (PersonParts.tsx, PersonFields.tsx,
// PeoplePanel.tsx) ask useReadOnly.

import { createContext, useContext } from "react";

export const ReadOnly = createContext(false);

export function useReadOnly(): boolean {
  return useContext(ReadOnly);
}
