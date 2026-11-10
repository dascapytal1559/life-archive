// Orbits' find box, in the header: type to list who on the map is called that
// (find.ts finds them as the Table's search does), closest first; pick one
// with a click, or the arrow keys and Enter, and the map picks them out as a
// click on them does (OrbitMap's `find` brings them into view). Escape clears
// it. While names are hidden (No name except…) it finds only those picked,
// and what was typed in it before is cleared as they hide.

import { useEffect, useId, useMemo, useState } from "react";
import { Identicon } from "../Identicon.tsx";
import { useNames } from "../names.ts";
import { findKey, findOnMap } from "./find.ts";
import type { DemoPerson } from "./model.ts";
import { number } from "./view.tsx";

export function FindBox({ people, at, onPick }: { people: readonly DemoPerson[]; at: number; onPick: (person: DemoPerson) => void }) {
  const names = useNames();
  const [search, setSearch] = useState("");
  // The list shows while the box has focus and something is typed, until a pick closes it.
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const { found, more } = useMemo(() => findOnMap(people, search, names, (p) => p.rank[at] ?? 0), [people, search, names, at]);
  const listId = useId();
  // What was typed (a name, as often as not) goes once names are hidden.
  useEffect(() => {
    if (names.hidden) setSearch("");
  }, [names.hidden]);
  const listed = open && search.trim() !== "";
  const current = Math.min(active, found.length - 1);

  const pick = (person: DemoPerson) => {
    setOpen(false);
    onPick(person);
  };

  return (
    <div className="find-box">
      <input
        className="demos__find"
        type="search"
        role="combobox"
        aria-label="Find a person"
        aria-expanded={listed}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={listed && current >= 0 ? `${listId}-${found[current].id}` : undefined}
        placeholder="Find a person"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          const key = findKey(event.key, { listed, found: found.length, active: current });
          if (!key) return;
          event.preventDefault();
          if (key.do === "clear") {
            setSearch("");
            setActive(0);
          } else if (key.do === "open") setOpen(true);
          else if (key.do === "move") setActive(key.to);
          else pick(found[key.index]);
        }}
      />
      {listed && (
        <ul className="find-box__list" id={listId} role="listbox" aria-label="People found">
          {found.map((person, i) => {
            const label = names.label(person);
            const rank = person.rank[at] ?? 0;
            return (
              <li
                key={person.id}
                id={`${listId}-${person.id}`}
                role="option"
                aria-selected={i === current}
                className="find-box__option"
                // Keeps the focus in the box, so the list stays until the click picks.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(person)}
              >
                <Identicon seed={person.identiconSeed} hue={person.identiconHue} size={18} className="find-box__identicon" />
                <span className="find-box__name">
                  {label.primary}
                  {label.secondary && <span className="find-box__secondary"> {label.secondary}</span>}
                </span>
                <span className="find-box__rank">{rank > 0 ? `#${number(rank)}` : "no closeness yet"}</span>
              </li>
            );
          })}
          {found.length === 0 && <li className="find-box__note">Nobody on the map matches</li>}
          {more > 0 && <li className="find-box__note">{number(more)} more: type more of the name</li>}
        </ul>
      )}
    </div>
  );
}
