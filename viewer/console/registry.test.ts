import { describe, expect, it, vi } from "vitest";
import { moduleViewers } from "../modules.ts";
import { CONSOLE_PATH, consolePath, isConsolePath, isSlug, stepsOf } from "./address.ts";
import { CALENDAR_PATH } from "./calendar/calendar.ts";
import { CALENDAR_VIEW, EVENTS_PATH, eventsViews, SOURCES_VIEW, TABLE_VIEW } from "./EventsSection.tsx";
import { MOVED, stepsNow } from "./moved.ts";
import { ASPECTS, aspectNamed, aspectsOn, HOME, homeOf, aspectOf, MODULE_PAGES, moduleStandIn, pathOf, placeOf, RAIL, railOrder, registryProblems, titleOf, VIEWS, viewsOf, viewsOn, type Aspect, type View } from "./registry.ts";
import { pageSettings } from "../pageSettings.ts";
import { moduleFailed } from "./ViewFailed.tsx";
import { readThemeChoice, resolveTheme, THEME_CHOICES } from "./theme.ts";

// The registry reads the modules' page halves as it loads, as the page loads them first (viewer/main.tsx): here every
// installed one, on, before any import below.
await vi.hoisted(async () => {
  const { installedViewers, loadModuleViewers } = await import("../modules.ts");
  await loadModuleViewers(Object.fromEntries(installedViewers().map((id) => [id, true])));
});
const MODULE_VIEWERS = moduleViewers().map(({ id, viewer }) => ({ id, viewer: viewer! }));

/** A made-up registry: a view under two aspects, and an aspect with two views. */
const aspect = (key: string): Aspect => ({ key, label: key, blurb: "", icon: "events" });
const view = (key: string, aspects: string[], section = key): View => ({ key, label: key, aspects, section, blurb: "", component: () => null });
const TWO: Aspect[] = [aspect("health"), aspect("events")];
const SHARED: View[] = [view("results", ["health"]), view("workouts", ["health", "events"]), view("messages", ["events"])];

/** Every module on, as the server tells the page of a module it loaded. */
const EVERY_MODULE = Object.fromEntries(MODULE_VIEWERS.map(({ id }) => [id, true]));
/** The modules this repository holds (the rest of .gitignore's exceptions): a private module cloned in may add a page, or a tab to any page, and fails no test of them. */
const TRACKED_MODULES = ["health", "exercise", "rituals", "friend-map", "shopping", "inspirations", "journal"];
/** The views this repository holds. */
const OURS = VIEWS.filter((v) => !MODULE_VIEWERS.some(({ id, viewer }) => !TRACKED_MODULES.includes(id) && viewer.views.includes(v)));

describe("the console's registry", () => {
  it("is sound: every view under an aspect it has, keys and sections unique, every aspect with a view, every place that moved now somewhere", () => {
    expect(registryProblems(ASPECTS, VIEWS, MOVED)).toEqual([]);
    for (const aspect of ASPECTS) expect(viewsOf(aspect.key).length, aspect.key).toBeGreaterThan(0);
  });

  it("has the captain's rail: Events, Journal, Friend Map, Health Record, Fitness, Inspirations, Shopping, and no People, Rituals or Don't Die", () => {
    const rail = ASPECTS.filter((a) => RAIL.includes(a.key));
    expect(rail.map((a) => a.label)).toEqual(["Events", "Journal", "Friend Map", "Health Record", "Fitness", "Inspirations", "Shopping"]);
    expect(rail.map((a) => a.key)).toEqual(["events", "journal", "friend-map", "health-record", "fitness", "inspirations", "shopping"]);
    expect(ASPECTS.map((a) => a.key)).not.toContain("dont-die");
    expect(ASPECTS.map((a) => a.key)).not.toContain("rituals");
    expect(VIEWS.filter((v) => /people/i.test(`${v.key} ${v.label}`))).toEqual([]);
  });

  it("makes Events the home, at its Calendar, wherever an order of his own puts it", () => {
    expect(HOME).toBe("events");
    expect(homeOf()).toEqual({ aspect: aspectOf("events"), view: CALENDAR_VIEW });
    expect(homeOf([...ASPECTS].reverse())).toEqual({ aspect: aspectOf("events"), view: CALENDAR_VIEW });
  });

  it("names no place at an old Architecture address, as at any aspect it no longer has, so the console opens its home", () => {
    for (const path of ["/life-archive/dev/architecture", "/life-archive/dev/architecture/platforms", "/life-archive/dev/architecture/privacy"]) {
      expect(placeOf(path), path).toBeUndefined();
    }
  });

  it("opens Fitness, the exercise module's page, on its activities, then Bryan Johnson's pillars, then rituals' weekly targets; its old Exercise and Rituals addresses open it", () => {
    const fitness = aspectOf("fitness")!;
    expect(viewsOf("fitness", OURS).map((v) => [v.label, v.section])).toEqual([["Activities", "activities"], ["Bryan Johnson", "bryan-johnson"], ["Habits", "habits"]]);
    expect(placeOf("/life-archive/dev/fitness")?.view?.key).toBe("exercise-activities");
    expect(pathOf({ aspect: fitness, view: viewsOf("fitness", OURS)[2] })).toBe("/life-archive/dev/fitness/habits");
    // The old Exercise page, and the Rituals page that folded into Fitness: its Weekly targets and Previous open Habits.
    expect(placeOf("/life-archive/dev/exercise")).toEqual({ aspect: fitness, view: viewsOf("fitness", OURS)[0] });
    expect(placeOf("/life-archive/dev/rituals")).toEqual({ aspect: fitness, view: viewsOf("fitness", OURS)[0] });
    for (const path of ["/life-archive/dev/rituals/weekly", "/life-archive/dev/rituals/previous"]) {
      expect(placeOf(path)?.view?.key, path).toBe("rituals-fitness");
    }
  });

  it("opens the Bryan Johnson tab at the old Don't Die page's addresses, which it folded into", () => {
    const fitness = aspectOf("fitness")!;
    const tab = viewsOf("fitness", OURS)[1];
    expect(pathOf({ aspect: fitness, view: tab })).toBe("/life-archive/dev/fitness/bryan-johnson");
    for (const path of ["/life-archive/dev/dont-die", "/life-archive/dev/dont-die/pillars"]) expect(placeOf(path), path).toEqual({ aspect: fitness, view: tab });
  });

  it("opens Shopping, the shopping module's page, on its pilot, what is on special", () => {
    expect(MODULE_VIEWERS.find((m) => m.id === "shopping")?.viewer.aspects.map((a) => a.key)).toEqual(["shopping"]);
    expect(viewsOf("shopping", OURS).map((v) => [v.label, v.section])).toEqual([["On special", "specials"]]);
    expect(placeOf("/life-archive/dev/shopping")?.view?.key).toBe("shopping-specials");
  });

  it("opens Journal, the journal module's page, second in the rail, on its Days", () => {
    const journal = MODULE_VIEWERS.find((m) => m.id === "journal")!.viewer;
    expect(journal.aspects.map((a) => a.key)).toEqual(["journal"]);
    expect(ASPECTS[1]).toBe(journal.aspects[0]);
    expect(RAIL[1]).toBe("journal");
    expect(viewsOf("journal", OURS).map((v) => [v.label, v.section])).toEqual([["Days", "days"]]);
    expect(placeOf("/life-archive/dev/journal")?.view?.key).toBe("journal-days");
  });

  it("holds Health Record as the health module's aspect, fourth in the rail by RAIL, its views the module's own tabs, All first", () => {
    expect(MODULE_VIEWERS.map((m) => m.id)).toContain("health");
    const health = MODULE_VIEWERS.find((m) => m.id === "health")!.viewer;
    expect(health.aspects.map((a) => a.key)).toEqual(["health-record"]);
    expect(ASPECTS[3]).toBe(health.aspects[0]);
    expect(RAIL[3]).toBe("health-record");
    expect(viewsOf("health-record", OURS)).toEqual(health.views);
    expect(viewsOf("health-record", OURS).map((v) => [v.label, v.section])).toEqual([["All", "all"], ["Physical", "physical"], ["Cholesterol", "cholesterol"], ["Allergies", "allergies"], ["Records", "records"], ["Sources", "sources"]]);
    expect(placeOf("/life-archive/dev/health-record")?.view?.label).toBe("All");
  });

  it("places a module's aspect by RAIL, and one RAIL does not name after the named ones, in the modules' order", () => {
    const made = ["events", "new-module", "friend-map", "another"].map(aspect);
    expect(railOrder(made).map((a) => a.key)).toEqual(["events", "friend-map", "new-module", "another"]);
  });

  it("lets a module add a tab to another page: its view under a core aspect is that page's last tab, at its own address", () => {
    const extra: View = { key: "sample-events-tab", label: "Sample", aspects: ["events"], section: "sample", blurb: "A module's tab on the Events page.", component: () => null };
    const views = [...OURS, extra];
    expect(registryProblems(ASPECTS.filter((a) => RAIL.includes(a.key)), views)).toEqual([]);
    expect(viewsOf("events", views).map((v) => v.label)).toEqual(["Calendar", "Daily rituals", "Tables", "Sources", "Sample"]);
    expect(placeOf("/life-archive/dev/events/sample", ASPECTS, views)).toEqual({ aspect: aspectOf("events"), view: extra });
    expect(pathOf({ aspect: aspectOf("events")!, view: extra }, views)).toBe("/life-archive/dev/events/sample");
    // The Events page's own address still opens its Calendar.
    expect(placeOf("/life-archive/dev/events", ASPECTS, views)).toEqual({ aspect: aspectOf("events"), view: CALENDAR_VIEW });
  });

  it("holds friend-map, embedded and filling the area, as Friend Map's one view (the friend map module's), so the page has no tabs", () => {
    const friendMap = viewsOf("friend-map", OURS);
    expect(friendMap.map((v) => v.label)).toEqual(["friend-map"]);
    expect(friendMap[0].fill).toBe(true);
    expect(aspectOf("friend-map")?.label).toBe("Friend Map");
    expect(pathOf({ aspect: aspectOf("friend-map")!, view: friendMap[0] })).toBe("/life-archive/dev/friend-map");
    // No view of the console is a module's own table: tables are the Events page's Tables' alone.
    expect(OURS.filter((v) => /messages/i.test(`${v.key} ${v.label} ${v.section}`))).toEqual([]);
  });

  it("opens Friend Map's old Messages tab's address as Events' Tables, where the table is now", () => {
    expect(MOVED).toMatchObject({ "friend-map/messages": "events/messages" });
    expect(placeOf("/life-archive/dev/friend-map/messages")).toEqual({ aspect: aspectOf("events"), view: TABLE_VIEW });
    // Friend Map's own address, and any other step under it, is still the map.
    expect(placeOf("/life-archive/dev/friend-map")?.view.key).toBe("friend-map");
    expect(placeOf("/life-archive/dev/friend-map/calls")?.view.key).toBe("friend-map");
    // With the module off nothing of it is loaded, its moved places among them: the address names no place, so the console opens its home.
    const off = { ...pageSettings(), modules: { ...EVERY_MODULE, "friend-map": false } };
    expect(placeOf("/life-archive/dev/friend-map/messages", aspectsOn(off), viewsOn(off), {})).toBeUndefined();
  });

  it("reads a place that moved as the place it moved to, and says what is wrong with a move", () => {
    const aspects = [aspect("events"), aspect("garden")];
    const beds = { ...view("beds", ["events"]), formerSections: ["plots"] };
    const views = [view("home", ["events"]), beds, view("map", ["garden"])];
    expect(placeOf("/life-archive/dev/garden/beds", aspects, views, { "garden/beds": "events/beds" })).toEqual({ aspect: aspects[0], view: beds });
    // To a section the view answered to before, too.
    expect(placeOf("/life-archive/dev/garden/beds", aspects, views, { "garden/beds": "events/plots" })).toEqual({ aspect: aspects[0], view: beds });
    expect(stepsNow(["garden", "beds"], { "garden/beds": "events/beds" })).toEqual(["events", "beds"]);
    expect(stepsNow(["garden", ""], { "garden/beds": "events/beds" })).toEqual(["garden", ""]);
    expect(registryProblems(aspects, views, { "garden/beds": "events/beds" })).toEqual([]);
    expect(registryProblems(aspects, views, { "garden/map": "events/beds" })).toEqual(["moved garden/map: a view is still at that address, which would never be reached"]);
    expect(registryProblems(aspects, views, { "garden/beds": "events/sheds" })).toEqual(["moved garden/beds to events/sheds: no view answers to that address"]);
    expect(registryProblems(aspects, views, { "garden/beds": "orchard/beds" })).toEqual(["moved garden/beds to orchard/beds: no view answers to that address"]);
    expect(registryProblems(aspects, views, { "garden/beds": "events" })).toEqual(["moved garden/beds to events: each is an aspect's slug and a section's, joined by a slash"]);
    expect(registryProblems(aspects, views, { "garden/beds": "garden/old", "garden/old": "events/beds" })).toContain("moved garden/beds to garden/old: that place moved too; name where it is now");
  });

  it("titles a place by its view, its page and the archive, and a page of one view by the page alone", () => {
    expect(titleOf(placeOf("/life-archive/dev/events/tables")!)).toBe("Tables · Events · Life archive");
    expect(titleOf(placeOf("/life-archive/dev/friend-map")!, OURS)).toBe("Friend Map · Life archive");
  });

  it("still opens a renamed aspect at its old key and a view at its old section, the old key's tabs under it", () => {
    // A made-up page renamed, one of whose tabs took another's place: what a module's aspect may declare.
    const garden: Aspect = { ...aspect("garden"), formerKeys: ["garden-project"], links: () => [{ label: "Plot", blurb: "", href: () => "https://garden.example/plot/" }] };
    const aspects = [aspect("events"), garden];
    const views = [view("events-home", ["events"], "home"), view("beds", ["garden"]), view("threads", ["garden"])];
    views[2] = { ...views[2]!, formerSections: ["todo"] };
    expect(registryProblems(aspects, views)).toEqual([]);
    expect(aspectOf("garden-project", aspects)).toBeUndefined();
    expect(aspectNamed("garden-project", aspects)).toBe(garden);
    expect(placeOf("/life-archive/dev/garden-project", aspects, views)).toEqual({ aspect: garden, view: views[1] });
    expect(placeOf("/life-archive/dev/garden/todo", aspects, views)).toEqual({ aspect: garden, view: views[2] });
    expect(placeOf("/life-archive/dev/garden-project/todo", aspects, views)).toEqual({ aspect: garden, view: views[2] });
    // A section the aspect does not have (a tab since retired) opens its first.
    expect(placeOf("/life-archive/dev/garden/timeline", aspects, views)).toEqual({ aspect: garden, view: views[1] });
    expect(pathOf({ aspect: garden, view: views[2]! }, views)).toBe("/life-archive/dev/garden/threads");
    expect(garden.links!().map((l) => l.href())).toEqual(["https://garden.example/plot/"]);
  });

  it("refuses a former key that is not a slug or is another aspect's key", () => {
    const renamed = { ...aspect("events"), formerKeys: ["health", "old name"] };
    expect(registryProblems([aspect("health"), renamed], SHARED)).toEqual([
      "aspect events: its former key health is another aspect's key",
      'aspect events: its former key "old name" is not a slug',
    ]);
  });

  it("opens a view at the address of the page it was, and refuses a former page an aspect still answers to", () => {
    const moved: View = { ...view("pillars", ["health"]), formerAspects: ["old-page", "events", "Old"] };
    const aspects = [aspect("health"), { ...aspect("events"), formerKeys: ["old-home"] }];
    expect(placeOf(`${CONSOLE_PATH}/old-page`, aspects, [view("first", ["health"]), moved])).toEqual({ aspect: aspects[0], view: moved });
    expect(registryProblems(aspects, [view("home", ["events"]), { ...moved, formerAspects: ["old-page", "events", "old-home", "Old"] }])).toEqual([
      "view pillars: its former aspect events still names an aspect, so its address never reaches the view",
      "view pillars: its former aspect old-home still names an aspect, so its address never reaches the view",
      'view pillars: its former aspect "Old" is not a slug',
    ]);
  });

  it("shows Events' own three views, the Calendar first at the aspect's address, Tables and the Calendar filling the area, Sources last", () => {
    const events = viewsOf("events", OURS).filter((v) => eventsViews().includes(v));
    expect(events).toEqual([CALENDAR_VIEW, TABLE_VIEW, SOURCES_VIEW]);
    expect(eventsViews()).toEqual(expect.arrayContaining(events));
    expect([TABLE_VIEW, CALENDAR_VIEW].every((v) => v.fill)).toBe(true);
    expect(pathOf({ aspect: aspectOf("events")!, view: SOURCES_VIEW })).toBe("/life-archive/dev/events/sources");
    expect(pathOf({ aspect: aspectOf("events")!, view: CALENDAR_VIEW })).toBe(CALENDAR_PATH);
    expect(CALENDAR_PATH).toBe("/life-archive/dev/events");
    for (const path of [CALENDAR_PATH, `${CALENDAR_PATH}/calendar`, `${CALENDAR_PATH}/nothing`]) {
      expect(placeOf(path), path).toEqual({ aspect: aspectOf("events"), view: CALENDAR_VIEW });
    }
  });

  it("orders Events' tabs Calendar, Daily rituals, Tables, Sources (the captain's), by View.order, rituals' tab between the core's", () => {
    const daily = VIEWS.find((v) => v.key === "rituals-daily")!;
    expect(daily.aspects).toEqual(["events"]);
    expect(viewsOf("events", OURS).map((v) => v.label)).toEqual(["Calendar", "Daily rituals", "Tables", "Sources"]);
    expect(viewsOf("events", OURS)[1]).toBe(daily);
    // A fresh install without rituals reads Calendar, Tables, Sources.
    expect(viewsOf("events", [CALENDAR_VIEW, TABLE_VIEW, SOURCES_VIEW]).map((v) => v.label)).toEqual(["Calendar", "Tables", "Sources"]);
    expect(placeOf("/life-archive/dev/events/daily")).toEqual({ aspect: aspectOf("events"), view: daily });
    expect(pathOf({ aspect: aspectOf("events")!, view: daily })).toBe("/life-archive/dev/events/daily");
  });

  it("orders a page's tabs by View.order, a view with none after every ordered one in the registry's order, and leaves a page nobody orders as it was", () => {
    const ordered = (key: string, order?: number): View => ({ ...view(key, ["events"]), order });
    const views = [view("a", ["events"]), ordered("b", 2), view("c", ["events"]), ordered("d", 1), ordered("e", 2)];
    expect(viewsOf("events", views).map((v) => v.key)).toEqual(["d", "b", "e", "a", "c"]);
    expect(viewsOf("events", [view("a", ["events"]), view("b", ["events"])]).map((v) => v.key)).toEqual(["a", "b"]);
    // The aspect's address opens its first tab by order.
    expect(homeOf([aspect("events")], views).view.key).toBe("d");
  });

  it("calls Events' list of tables Tables, at …/events/tables, its old addresses (…/events/table, …/events/all, each kind's own view) still opening it", () => {
    expect(TABLE_VIEW).toMatchObject({ key: "events-table", label: "Tables", section: "tables" });
    expect(pathOf({ aspect: aspectOf("events")!, view: TABLE_VIEW })).toBe(EVENTS_PATH);
    expect(EVENTS_PATH).toBe("/life-archive/dev/events/tables");
    const old = ["table", "all", "messages", "calls", "hangouts", "llm", "workouts"].map((section) => `/life-archive/dev/events/${section}`);
    for (const path of [EVENTS_PATH, ...old]) {
      expect(placeOf(path), path).toEqual({ aspect: aspectOf("events"), view: TABLE_VIEW });
    }
  });

  it("gives rituals no page of its own: its two views are tabs on Events and Fitness", () => {
    const ritualsViews = MODULE_VIEWERS.find(({ id }) => id === "rituals")!.viewer;
    expect(ritualsViews.aspects).toEqual([]);
    expect(ritualsViews.views.map((v) => [v.label, v.aspects, v.section])).toEqual([
      ["Daily rituals", ["events"], "daily"],
      ["Habits", ["fitness"], "habits"],
    ]);
  });

  it("shows Inspirations' own tabs, the inspirations module's, as views under it, in their order, the first the aspect's address", () => {
    const inspirations = MODULE_VIEWERS.find((m) => m.id === "inspirations")!.viewer;
    expect(viewsOf("inspirations", OURS)).toEqual(inspirations.views);
    expect(viewsOf("inspirations").map((v) => v.label)).toEqual(["Platforms", "Recent", "By tag", "Search", "Untagged", "Tags", "Changes"]);
    // Platforms is the aspect's address; Recent, its address until Platforms came, its own step below it.
    expect(placeOf("/life-archive/dev/inspirations")?.view?.label).toBe("Platforms");
    expect(placeOf("/life-archive/dev/inspirations/recent")?.view?.label).toBe("Recent");
    expect(pathOf({ aspect: aspectOf("inspirations")!, view: viewsOf("inspirations")[1]! })).toBe("/life-archive/dev/inspirations/recent");
  });

  it("lets a view sit under several aspects, and an aspect hold several views", () => {
    expect(registryProblems(TWO, SHARED)).toEqual([]);
    expect(viewsOf("health", SHARED).map((v) => v.key)).toEqual(["results", "workouts"]);
    expect(viewsOf("events", SHARED).map((v) => v.key)).toEqual(["workouts", "messages"]);
    expect(placeOf(`${CONSOLE_PATH}/events/workouts`, TWO, SHARED)).toEqual({ aspect: TWO[1], view: SHARED[1] });
    expect(placeOf(`${CONSOLE_PATH}/health/workouts`, TWO, SHARED)).toEqual({ aspect: TWO[0], view: SHARED[1] });
  });

  it("says what is wrong with a registry", () => {
    const problems = registryProblems(
      [aspect("health"), aspect("health"), aspect("not a slug"), aspect("empty")],
      [view("a", ["health"], "x"), view("a", ["health"], "x"), view("b", []), view("c", ["gone"]), view("d", ["health"], "bad slug")],
    );
    expect(problems).toEqual([
      "aspect health: two aspects have this key",
      'aspect "not a slug": its key is not a slug (lowercase words joined by dashes)',
      "aspect not a slug: no view sits under it",
      "aspect empty: no view sits under it",
      "view a: two views have this key",
      "view a: another view is already at health/x",
      "view b: under no aspect",
      "view c: no aspect gone",
      'view d: its section "bad slug" is not a slug',
    ]);
  });
});

describe("the console's addresses", () => {
  it("are the console, an aspect a step below and a view a step below that", () => {
    expect(CONSOLE_PATH).toBe("/life-archive/dev");
    expect(consolePath()).toBe("/life-archive/dev");
    expect(consolePath("health")).toBe("/life-archive/dev/health");
    expect(consolePath("health", "records")).toBe("/life-archive/dev/health/records");
    expect(stepsOf("/life-archive/dev")).toEqual(["", ""]);
    expect(stepsOf("/life-archive/dev/")).toEqual(["", ""]);
    expect(stepsOf("/life-archive/dev/health")).toEqual(["health", ""]);
    expect(stepsOf("/life-archive/dev/health/records/")).toEqual(["health", "records"]);
    expect(isConsolePath("/life-archive/dev")).toBe(true);
    expect(isConsolePath("/life-archive/dev/health")).toBe(true);
    expect(isConsolePath("/life-archive/devs")).toBe(false);
    expect(isConsolePath("/life-archive/health")).toBe(false);
    for (const slug of ["health", "friend-map", "all", "a1"]) expect(isSlug(slug), slug).toBe(true);
    for (const slug of ["", "Health", "friend map", "-a", "a-", "a--b", "a/b"]) expect(isSlug(slug), slug).toBe(false);
  });

  it("read every place back as they write it, an aspect's first view as the aspect itself", () => {
    expect(placeOf(consolePath())).toBeUndefined();
    for (const aspect of ASPECTS) {
      const [first, ...rest] = viewsOf(aspect.key);
      expect(pathOf({ aspect, view: first })).toBe(consolePath(aspect.key));
      expect(placeOf(consolePath(aspect.key))).toEqual({ aspect, view: first });
      expect(placeOf(consolePath(aspect.key, first.section))).toEqual({ aspect, view: first });
      for (const view of rest) {
        const path = pathOf({ aspect, view });
        expect(path).toBe(consolePath(aspect.key, view.section));
        expect(placeOf(path)).toEqual({ aspect, view });
      }
    }
  });

  it("name no place (the home) for an aspect they do not know, and an aspect's first view for a section it has not", () => {
    expect(placeOf(`${CONSOLE_PATH}/nothing`)).toBeUndefined();
    expect(placeOf(`${CONSOLE_PATH}/nothing/at-all`)).toBeUndefined();
    expect(placeOf(`${CONSOLE_PATH}/health-record/gone`)).toEqual({ aspect: aspectOf("health-record"), view: viewsOf("health-record")[0] });
    expect(placeOf(`${CONSOLE_PATH}/health-record/records/deeper`)).toEqual({ aspect: aspectOf("health-record"), view: viewsOf("health-record").find((v) => v.section === "records") });
    // The first slice's names, since renamed.
    expect(placeOf(`${CONSOLE_PATH}/social`)).toBeUndefined();
    expect(placeOf(`${CONSOLE_PATH}/health/records`)).toBeUndefined();
  });
});

describe("the console's look", () => {
  it("follows the device unless chosen here, and the address's ?theme= wins", () => {
    expect(readThemeChoice(null, "")).toBe("auto");
    expect(readThemeChoice("dark", "")).toBe("dark");
    expect(readThemeChoice("odd", "")).toBe("auto");
    expect(readThemeChoice("dark", "?theme=light")).toBe("light");
    expect(readThemeChoice(null, "?theme=odd")).toBe("auto");
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("offers Automatic, Light and Dark in the settings menu, in that order", () => {
    expect(THEME_CHOICES.map((choice) => [choice.key, choice.label])).toEqual([
      ["auto", "Automatic"],
      ["light", "Light"],
      ["dark", "Dark"],
    ]);
  });
});

describe("a module whose page did not load (viewer/modules.ts)", () => {
  it("is a page of its own at its id, its one view saying why, and the registry stays sound around it", () => {
    const failed = moduleFailed("sample-module", "made-up failure");
    const aspects = [...ASPECTS, ...failed.aspects];
    const views = [...VIEWS, ...failed.views];
    expect(registryProblems(aspects, views)).toEqual([]);
    expect(failed.aspects.map((a) => [a.key, a.label])).toEqual([["sample-module", "Sample module"]]);
    expect(placeOf("/life-archive/dev/sample-module", aspects, views)?.view).toBe(failed.views[0]);
    // The rest of the console is as it was.
    expect(placeOf("/life-archive/dev/health-record", aspects, views)?.view?.label).toBe("All");
  });

  /** The registry with the module `id`'s page half as it is when it did not load: its stand-in where its views were. */
  const without = (id: string) => {
    const own = MODULE_VIEWERS.find((module) => module.id === id)!.viewer;
    const failed = moduleStandIn(id, "made-up failure");
    const aspects = [...ASPECTS.filter((a) => !own.aspects.includes(a)), ...failed.aspects];
    const views = VIEWS.flatMap((v) => (v === own.views[0] ? failed.views : own.views.includes(v) ? [] : [v]));
    return { failed, aspects, views };
  };

  it("knows the pages of each module this repository holds, as their viewer.tsx declare them", () => {
    for (const { id, viewer } of MODULE_VIEWERS.filter(({ id }) => TRACKED_MODULES.includes(id))) {
      expect(MODULE_PAGES[id], id).toEqual(viewer.aspects.map((a) => a.key));
    }
  });

  it("says so at its own page's address: Fitness for exercise, its other tabs there as before", () => {
    const { failed, aspects, views } = without("exercise");
    expect(registryProblems(aspects, views)).toEqual([]);
    expect(placeOf("/life-archive/dev/fitness", aspects, views)?.view).toBe(failed.views[0]);
    expect(placeOf("/life-archive/dev/fitness/habits", aspects, views)?.view?.label).toBe("Habits");
  });

  it("says so as a tab on Events for rituals, which has no page, its old address still opening Fitness", () => {
    const { failed, aspects, views } = without("rituals");
    expect(registryProblems(aspects, views)).toEqual([]);
    expect(failed.aspects).toEqual([]);
    expect(placeOf("/life-archive/dev/events/rituals-failed", aspects, views)?.view).toBe(failed.views[0]);
    expect(placeOf("/life-archive/dev/rituals", aspects, views)?.aspect.key).toBe("fitness");
  });
});

describe("the aspects this archive shows", () => {
  it("has Shopping only while its module is on", () => {
    const told = { ...pageSettings(), modules: { ...EVERY_MODULE, shopping: false } };
    expect(aspectsOn(told)).toEqual(ASPECTS.filter((a) => a.key !== "shopping"));
    expect(aspectsOn({ ...told, modules: EVERY_MODULE })).toEqual(ASPECTS);
    // An address under an aspect this archive does not have opens the home, as any address the console does not know.
    expect(placeOf("/life-archive/dev/shopping", aspectsOn(told))).toBeUndefined();
  });

  it("leaves out a module switched off or broken (Inspirations, a core page once, among them), its views with it", () => {
    const all = { ...pageSettings(), modules: EVERY_MODULE };
    expect(aspectsOn(all)).toEqual(ASPECTS);
    expect(viewsOn(all)).toEqual(VIEWS);
    const noInspirations = { ...all, modules: { ...EVERY_MODULE, inspirations: false } };
    expect(aspectsOn(noInspirations).map((a) => a.key)).toEqual(ASPECTS.map((a) => a.key).filter((key) => key !== "inspirations"));
    // A module the server said is off (switched off, or broken) is not in the rail, and none of its views is a tab anywhere.
    const noHealth = { ...all, modules: { ...EVERY_MODULE, health: false } };
    expect(aspectsOn(noHealth).map((a) => a.key)).toEqual(ASPECTS.map((a) => a.key).filter((key) => key !== "health-record"));
    expect(viewsOn(noHealth).length).toBe(VIEWS.length - viewsOf("health-record").length);
    expect(viewsOn(noHealth).some((v) => v.aspects.includes("health-record"))).toBe(false);
    expect(placeOf("/life-archive/dev/health-record", aspectsOn(noHealth), viewsOn(noHealth))).toBeUndefined();
    // A module the server did not name is off: it found no such module, whatever the page found.
    const { health: _named, ...unnamed } = EVERY_MODULE;
    expect(aspectsOn({ ...all, modules: unnamed }).map((a) => a.key)).toEqual(ASPECTS.map((a) => a.key).filter((key) => key !== "health-record"));
    expect(viewsOn({ ...all, modules: unnamed }).some((v) => v.aspects.includes("health-record"))).toBe(false);
  });

  it("shows a fresh install's pages alone, as its server tells them (src/pages.ts): Events and Friend Map, a module's tabs going with it", () => {
    const fresh = {
      ...pageSettings(),
      modules: Object.fromEntries(Object.keys(EVERY_MODULE).map((id) => [id, id === "friend-map"])),
    };
    expect(aspectsOn(fresh).map((a) => a.key)).toEqual(["events", "friend-map"]);
    const some = fresh;
    const shown = viewsOn(some);
    // The core's tabs of Events stay; friend map's own pages' tabs too; another module's tab on Events goes with its pages.
    expect(shown.filter((v) => v.aspects.includes("events")).map((v) => v.key)).toEqual(["events-calendar", "events-table", "events-sources"]);
    expect(shown.some((v) => v.key === "friend-map")).toBe(true);
    expect(shown.some((v) => v.aspects.includes("events") && /daily/.test(v.section))).toBe(false);
    expect(placeOf("/life-archive/dev/fitness", aspectsOn(some), shown)).toBeUndefined();
  });
});
