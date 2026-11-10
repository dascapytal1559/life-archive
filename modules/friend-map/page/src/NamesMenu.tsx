// Name format, the name choice: how the page shows names (names.ts), kept in this
// browser, first in the open view's settings in the menu at the top left
// (ViewSettings.tsx) on every page that shows names, a couple of clicks away so
// the header stays clean for a screenshot. One choice for every page, not one
// per view. It is a toggle, as the view's other settings are: First name,
// First L., Full name and No name, and in the real app No name except… too,
// which also lists everyone it names, each with a × to stop naming them, and a
// box to pick someone else by name or alias (shownNames.ts keeps them, as a
// tag in the archive), and that their connections, everyone they share a group
// chat with, are named too. While No name except… is on, a small dot beside
// the settings' title says so (ViewSettings.tsx), in the menu alone, never on
// the page itself.

import { useId, useState } from "react";
import { archiveApi } from "./archiveApi.ts";
import { demoMode } from "./demoMode.ts";
import { joinCandidates, nameStylesFor, nameStyleStore, useNameStyle, type NameStyle } from "./names.ts";
import { setShowName, usePickedPeople } from "./shownNames.ts";
import { useArchive } from "./useArchive.ts";
import { Toggle } from "./ViewSettings.tsx";
import type { ToggleSetting } from "./viewSettings.ts";

/** The choice as a toggle over the page's own store: the demo's four, or the real app's five (`demo`). */
export function namesSetting(demo: boolean): ToggleSetting<NameStyle> {
  return {
    kind: "toggle",
    label: "Name format",
    choices: nameStylesFor(demo).map((s) => ({ value: s.style, title: s.title, about: s.about })),
    store: nameStyleStore,
    wrap: true,
  };
}

/** The name choice in the view's settings, with whom No name except… names under it in the real app. */
export function NamesSetting({ demo = demoMode }: { demo?: boolean }) {
  const style = useNameStyle();
  const id = useId();
  return (
    <div className="view-switcher__setting view-switcher__names">
      <span className="view-switcher__label" id={id}>Name format</span>
      <Toggle setting={namesSetting(demo) as ToggleSetting<unknown>} labelledBy={id} />
      {style === "except" && !demo && <PickedPicker />}
    </div>
  );
}

/** Whom No name except… names: everyone picked, each with a × to stop naming them, and a box to pick someone else. */
function PickedPicker() {
  const picked = usePickedPeople();
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  // Everyone, to pick from: a big download, so only once you start typing.
  const everyone = useArchive(() => archiveApi.people(), [], { enabled: query.trim() !== "" });
  const pickedIds = new Set(picked?.map((p) => p.id));
  const offered = everyone.data ? joinCandidates(-1, everyone.data.people.filter((p) => !pickedIds.has(p.id)), query) : [];
  const save = async (work: () => Promise<unknown>) => {
    setSaving(true);
    await work();
    setSaving(false);
  };
  return (
    <div className="view-switcher__picked">
      {picked === null ? (
        <span className="view-switcher__dim">Loading…</span>
      ) : picked.length === 0 ? (
        <span className="view-switcher__dim">Nobody yet: everyone is unnamed</span>
      ) : (
        <>
          <ul aria-label="Named">
            {picked.map((p) => (
              <li key={p.id}>
                <span className="view-switcher__chosen">{p.name}</span>
                <button type="button" aria-label={`Stop naming ${p.name}`} title="Stop naming them" disabled={saving} onClick={() => void save(() => setShowName(p, false))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <span className="view-switcher__dim">and everyone they share a group chat with</span>
        </>
      )}
      <input
        type="search"
        aria-label="Name someone"
        placeholder="Type a name"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {query.trim() !== "" && !everyone.data && <span className="view-switcher__dim">Loading everyone…</span>}
      {offered.length > 0 && (
        <ul aria-label="People called that" className="view-switcher__offered">
          {offered.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={saving}
                onClick={() => void save(async () => {
                  await setShowName(p, true);
                  setQuery("");
                })}
              >
                {[p.name, ...p.aliases].join(" / ")}
                {p.archived !== null && <span className="view-switcher__dim">, archived</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
