// The page around the map views: the main view (Orbits, at /orbits), the same sky
// as a solar system (Orbits 3D, at /orbits-3d), the same map in
// friend circles (Circles, at /circles) and as a spider's web (the Spider web, at
// /spider, which the app opens on: DEFAULT_VIEW in views.ts), the City (/city, the same closeness
// as a cyberspace city, with everything the main view has but Methodology), the Time
// river (/time-river: messages, calls or hangouts over time in the river's look,
// with the same), and the frozen views (the river, Reciprocity), each at its
// path in src/views.ts; the
// Table and the Calendar folded into the Events page's Tables and Calendar (movedToEvents.ts). An
// address with ?person=<id> opens that person's panel on a live view (personAsked:
// the Events calendar's and People table's Friend Map, which the console's frame passes on). Every
// view reads the archive's structure only (GET /api/archive/relationships);
// clicking a person opens the person panel, where archiving them takes them
// off every map view (Events' People table still lists them).
//
// This file owns the route, the header (the title, which is the view switcher,
// whose menu holds the name choice (Names) on the live views, how many people
// are shown, the main view's find box, Changes (every edit to people, with Undo) on the live views where people
// can be changed, Methodology, People on the frozen views
// alone, and under them the main view's Query bar with Hide at its end, which the Table held until it folded), the
// hover card, the person panel (docked beside the live views, or over the ones
// that keep their size, Orbits, Circles and the Spider web; floating over the
// frozen ones, which also open the People list); Circles has everything the main view has, following changes to people made
// elsewhere (the CLI), and the usage record. On the demo's pages (the static
// demo's, demoMode.ts) the archive is the made-up crowd's,
// only the demo's views are offered (DEMO_VIEWS in views.ts: Orbits, the solar
// system at /orbits-3d, and the Spider web), the name choice is the demo's own
// (First L. to start with, and no No name except…), and the Query bar's box offers examples. Each view lives in its own
// file and is listed in DEMOS.

import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useState, type CSSProperties } from "react";
import "../app.css";
import { SHOWN_LIMIT } from "../archive.ts";
import { EXAMPLES } from "../demo/examples.ts";
import { DemoModeMark } from "../DemoMode.tsx";
import { demoMode } from "../demoMode.ts";
import { PeoplePanel } from "../PeoplePanel.tsx";
import { useReadOnly } from "../readOnly.ts";
import { useShownNames } from "../shownNames.ts";
import { followArchive } from "../useArchive.ts";
import { address, appPath } from "../mount.ts";
import { useUsage } from "../usage.ts";
import { ViewSwitcher, type Navigate } from "../ViewSwitcher.tsx";
import { DEFAULT_VIEW, VIEWS, viewAt, viewsFor } from "../views.ts";
import "./demos.css";
import { AddAspiring } from "./AddAspiring.tsx";
import { ChangesPanel } from "./ChangesPanel.tsx";
import { FindBox } from "./FindBox.tsx";
import { Methodology } from "./Methodology.tsx";
import type { DemoPerson } from "./model.ts";
import { circles, orbits, PHONE, web } from "./Orbits.tsx";
import { useMedia } from "./orbitsSky.ts";
import { city } from "./City.tsx";
import { ChangeChip, Dock, ErrorNotice, useHideNamesKey, useSidePanel } from "./page.tsx";
import { usePanelGlow } from "./panelGlow.ts";
import { personAsked, withoutPerson } from "./personAddress.ts";
import { QueryBar, useQueryBar } from "./QueryBar.tsx";
import { reciprocity } from "./Reciprocity.tsx";
import { river } from "./River.tsx";
import { timeRiver } from "./TimeRiver.tsx";
import { HidePanel, useHideChoices } from "./HidePanel.tsx";
import { uncountedEntries } from "./hideChoices.ts";
import { useTopNamesOf } from "./topNames.ts";
import { useMapSize } from "./mapSize.ts";
import { HoverCard, number, useDemoModel, useSize, type Demo, type Find, type Tip } from "./view.tsx";

/**
 * Orbits 3D (Orbits3D.tsx), loaded only when it is opened: its WebGL drawing
 * is a chunk of its own, so no other view carries it.
 */
const orbits3d: Demo = {
  slug: "orbits-3d",
  title: "Orbits",
  View: lazy(() => import("./Orbits3D.tsx").then((m) => ({ default: m.Orbits3DMap }))),
};

/**
 * Every view, or on the static demo's site its own alone (DEMO_VIEWS in views.ts), so its files carry no other view's
 * code: the build knows it is the static demo (demoMode), and leaves the rest out.
 */
export const DEMOS: Demo[] = demoMode ? [orbits3d, web] : [orbits, orbits3d, circles, web, city, timeRiver, river, reciprocity];
/** Orbits, Orbits 3D, Circles and the Spider web: one sky, each with Methodology (which explains its marks); the City has everything else of the main view's. */
const MAIN: Demo[] = [orbits, orbits3d, circles, web];

/** The header drawn over the top of every view, until it has been measured. */
const INSET = 76;
/** Room left under the header: for the line under the Query bar's boxes on the main view, a little on the others. */
const BELOW_HEADER = { main: 30, frozen: 17 };
/** How long the stage's size must hold before the map is drawn smaller: past the dock's slide (--dock-move in demos.css). */
const SETTLE_MS = 150;

export function Demos() {
  const [path, setPath] = useState(() => appPath(window.location.pathname));
  useEffect(() => {
    const onPop = () => setPath(appPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const slug = viewAt(path, viewsFor(demoMode))?.slug;
  const demo = DEMOS.find((d) => d.slug === slug) ?? DEMOS.find((d) => d.slug === DEFAULT_VIEW)!;
  useEffect(() => {
    // The view's name as the switcher gives it (views.ts): Orbits 2D for the flat sky, Orbits for the solar system.
    const name = VIEWS.find((view) => view.slug === demo.slug)?.title ?? demo.title;
    const title = demo.slug === DEFAULT_VIEW ? "Friend map" : `${name} · Friend map`;
    document.title = demoMode ? `${title} · demo` : title;
  }, [demo]);
  const navigate: Navigate = (to) => (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    window.history.pushState(null, "", address(to));
    // `to` may carry a query: the view is the path's.
    setPath(appPath(window.location.pathname));
  };
  return <ViewPage demo={demo} navigate={navigate} />;
}

function ViewPage({ demo, navigate }: { demo: Demo; navigate: Navigate }) {
  const [hide, setHide] = useHideChoices("table");
  const frozen = VIEWS.find((view) => view.slug === demo.slug)?.frozen ?? false;
  const isMain = MAIN.includes(demo);
  // The live views (Orbits, Circles, the City, the Time river): the Query bar and its Hide narrow who they show, the find box finds, the
  // panel docks beside them, and they hold whoever's panel is open. The frozen views stay as they were.
  const live = !frozen;
  // The map draws at most SHOWN_LIMIT people: a query, or a change of Hide, that would show more is refused before it
  // loads, and the map keeps what it shows (queryBar.hide is the Hide it was counted under).
  const queryBar = useQueryBar("map", { hide, limit: SHOWN_LIMIT });
  // Only the main view leaves out people the query, then Hide, leave out; the frozen views stay as they were.
  const { model, status, settingsProblems } = useDemoModel(live ? { hide: queryBar.hide, query: queryBar.state.applied.query, only: queryBar.only } : null);
  // Refused before anything has shown, the stage says why, as the line under the box does.
  const refusal = live && !model && queryBar.state.failed !== null ? queryBar.state.status?.text ?? null : null;
  // A view that keeps its size (Orbits, Circles, the Spider web) is never drawn again for the docked panel: its stage
  // stays the window's size and slides aside, under the panel, by half the panel, so what the panel leaves of it (the
  // room, `seen`) is centred; only the compositor moves it (demos.css). Any other is drawn at a new size once a slide
  // of the docked panel, not a frame at a time, and never narrower than its stage: at the size it is headed for as
  // soon as the panel starts to close, and at the smaller size only once the panel has finished opening, so the panel
  // draws first. Meanwhile the drawing, centred, slides with it (mapSize.ts).
  const [stageRef, roomRef, size, seen] = useMapSize<HTMLDivElement>(SETTLE_MS);
  // The map starts under the header, however tall the Query bar makes it.
  const [headerRef, header] = useSize<HTMLElement>({ border: true });
  const inset = header.height ? header.height + BELOW_HEADER[live ? "main" : "frozen"] : INSET;
  const [tip, setTip] = useState<Tip | null>(null);
  // Methodology, over the main view, and how many of the closest the view names, which it tells.
  const [method, setMethod] = useState(false);
  const named = useTopNamesOf(demo.slug);
  // On the live views the panel is docked: it takes its own column and the map
  // narrows to the rest, or, on a view that keeps its size, slides aside under
  // it. The frozen views keep it floating over the map.
  const docked = live;
  const keepsSize = docked && demo.keepsSize === true;
  const { panel, setPanel, shown, closed } = useSidePanel(docked, { open: method, close: () => setMethod(false) });
  // Opened at ?person=<id> (the Events calendar's Friend Map): their panel, once, the address then left without it.
  useEffect(() => {
    const asked = personAsked(window.location.search);
    if (asked === null) return;
    setPanel({ person: asked });
    window.history.replaceState(null, "", withoutPerson(window.location));
  }, [setPanel]);
  // The panel is a dark card on every map view (demos.css), in the view's own colours (panelGlow.ts); on the Spider
  // web, in its monospaced type too.
  const glow = usePanelGlow(demo.slug);
  useUsage(demo.slug);
  useEffect(() => setTip(null), [demo]);
  useHideNamesKey(live);
  useShownNames(!demoMode);

  // People changed elsewhere (the CLI, another tab) reload every view.
  useEffect(() => followArchive(), []);

  // The map draws again only when what it draws changes (its model or size, or who is
  // held), not when the hover card follows the pointer: on a big map that is seconds of
  // work the person panel would otherwise wait behind. Whoever's panel is open is held
  // on the main view (picked out with their links until it closes), drawn just after
  // the panel, so opening a panel never waits for the map; the frozen views never get it,
  // so they are not drawn again for it.
  const View = useMemo(() => memo(demo.View), [demo.View]);
  const held = useDeferredValue(live ? (panel?.person ?? null) : null);
  // The group chat open in their panel, if any: the main view then links them only to its members.
  const [panelGroup, setPanelGroup] = useState<number | null>(null);
  const heldGroup = useDeferredValue(live && panel?.person != null ? panelGroup : null);
  const openPerson = useCallback((person: DemoPerson) => {
    setTip(null);
    setPanel({ person: person.id });
  }, [setPanel]);
  const closePanel = useCallback(() => setPanel(null), [setPanel]);
  // Someone picked in the find box: their panel opens, as a click on them does, and the map brings them into view.
  const [find, setFind] = useState<Find | null>(null);
  useEffect(() => setFind(null), [demo]);
  const findPerson = useCallback((person: DemoPerson) => {
    openPerson(person);
    setFind((last) => ({ id: person.id, count: (last?.count ?? 0) + 1 }));
  }, [openPerson]);

  // Add an aspiring friend, folded in the menu of Orbits, flat or not, and the Spider web, never on a phone or a page that takes no edits.
  const readOnly = useReadOnly();
  const phone = useMedia(PHONE);
  const addsAspiring = !demoMode && !readOnly && !phone && (demo === orbits || demo === orbits3d || demo === web);
  const addAspiring = (closeMenu: () => void) => (
    <AddAspiring
      onOpen={(person) => {
        closeMenu();
        setPanel({ person });
      }}
    />
  );

  const peoplePanel = (at: { person: number | null }, className: string) => (
    <PeoplePanel
      className={className}
      openId={at.person}
      onOpen={(person) => setPanel({ person })}
      onClose={() => setPanel(null)}
      onGroup={setPanelGroup}
      preview={model ? (id) => model.people.find((p) => p.id === id) : undefined}
    />
  );

  return (
    <div className={`demos${docked && panel ? " demos--docked" : ""}${keepsSize ? " demos--keeps-size" : ""}${!docked && shown ? " demos--drawer" : ""}${demo === web ? " demos--web" : ""}`} style={glow}>
      <div className="demos__room" ref={roomRef} aria-hidden />
      <div className="demos__map" style={{ "--header": `${inset}px` } as CSSProperties}>
        <div className="demos__stage" ref={stageRef}>
          {model && size.width > 0 && (
            <Suspense fallback={null}>
              <View
                key={demo.slug}
                model={model}
                width={size.width}
                height={size.height}
                inset={inset}
                seen={keepsSize && seen.width > 0 ? seen.width : undefined}
                hover={setTip}
                open={openPerson}
                close={live ? closePanel : undefined}
                held={held}
                heldGroup={heldGroup}
                find={live ? find : null}
                requery={live ? queryBar.requery : 0}
              />
            </Suspense>
          )}
          {(refusal ?? status) && <p className="demos__status">{refusal ?? status}</p>}
        </div>
        <header className="demos__header" ref={headerRef}>
          {/* Each view's own settings are in the switcher's menu (viewSettings.ts), in the app and the demo alike. */}
          <ViewSwitcher current={demo.slug} crumb={demoMode ? "Friend map · demo" : frozen ? "Frozen view, kept as it is" : "Friend map"} navigate={navigate} more={addsAspiring ? addAspiring : undefined} names={live} />
          <div className="demos__controls">
            {/* The live views say how many they show on the Query bar's line instead. */}
            {!live && model && (
              <span title={model.archivedCount > 0 ? `${number(model.archivedCount)} archived people are never shown` : undefined}>
                {number(model.people.length)}
                {model.hiddenCount > 0 && <> of {number(model.people.length + model.hiddenCount)}</>} people
                {model.archivedCount > 0 && <> · {number(model.archivedCount)} archived</>}
              </span>
            )}
            {live && model && <FindBox people={model.people} at={model.months.length - 1} onPick={findPerson} />}
            {/* Every edit to people, here or anywhere, with Undo; a page that takes no edits has nothing to undo. */}
            {live && !readOnly && !demoMode && !phone && <ChangesPanel onOpen={(person) => setPanel({ person })} />}
            {isMain && model && (
              <button
                type="button"
                className="demos__method"
                aria-expanded={method}
                title="Methodology: how this map works, the closeness score, and what size, glow and trails mean"
                onClick={() => setMethod((open) => !open)}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
                  <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
                  <path d="M8 7.2 V11.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                Methodology
              </button>
            )}
            {/* The live views have no People list: a person's panel opens from the map, and Events' People table lists everyone. */}
            {!live && (
              <button type="button" className="demos__people" onClick={() => setPanel(panel && panel.person === null ? null : { person: null })}>
                People
              </button>
            )}
          </div>
          {live && (
            <QueryBar
              bar={queryBar}
              examples={demoMode ? EXAMPLES : undefined}
              count={model?.people.length}
              hide={<HidePanel entries={model?.hideEntries.length ? model.hideEntries : uncountedEntries(hide)} choices={hide} onChange={setHide} />}
            />
          )}
        </header>
        {demo.line && <p className="demos__line">{demo.line}</p>}
        {isMain && model && method && <Methodology model={model} onClose={() => setMethod(false)} demo={demoMode} order={demo === circles ? "circles" : "name"} named={named} />}
        {tip && <HoverCard tip={tip} bounds={seen} identicon={live} />}
        <ErrorNotice />
        <ChangeChip />
        {/* In the map, so it is centred on the map, beside the panel and not under it. */}
        {demoMode && <DemoModeMark />}
        {live && settingsProblems.length > 0 && (
          <div className="app__problems demos__settings-problems" role="alert">
            {settingsProblems.map((problem) => <p key={problem}><code>data/settings.json</code> {problem}</p>)}
          </div>
        )}
      </div>
      {docked ? (
        <Dock open={panel !== null} onClosed={closed}>{shown && peoplePanel(shown, "demos__docked")}</Dock>
      ) : (
        shown && peoplePanel(shown, "demos__drawer")
      )}
    </div>
  );
}

