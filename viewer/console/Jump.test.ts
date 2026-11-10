import { describe, expect, it } from "vitest";
import { jumpEntries } from "./Jump.tsx";

describe("the places Jump to lists", () => {
  /** A made-up console: a page of three views, a page of one, and two tables. */
  const PAGES = [
    { label: "Events", path: "/c/events", views: [{ label: "Calendar", path: "/c/events" }, { label: "Tables", path: "/c/events/tables" }, { label: "Sources", path: "/c/events/sources" }] },
    { label: "Garden", path: "/c/garden", views: [{ label: "garden", path: "/c/garden" }] },
  ];
  const TABLES = [{ label: "Beds", path: "/c/events/tables?table=beds" }, { label: "Visits", path: "/c/events/tables?table=visits" }];

  it("lists each page, each view of a page that has several, and each table, said to be where tables are", () => {
    expect(jumpEntries(PAGES, TABLES, "Events · Tables")).toEqual([
      { label: "Events", detail: "Aspect", path: "/c/events" },
      { label: "Calendar", detail: "Events", path: "/c/events" },
      { label: "Tables", detail: "Events", path: "/c/events/tables" },
      { label: "Sources", detail: "Events", path: "/c/events/sources" },
      { label: "Garden", detail: "Aspect", path: "/c/garden" },
      { label: "Beds", detail: "Events · Tables", path: "/c/events/tables?table=beds" },
      { label: "Visits", detail: "Events · Tables", path: "/c/events/tables?table=visits" },
    ]);
  });

  it("lists a page of one view once, as itself: its view has no tab to be known by", () => {
    const garden = jumpEntries(PAGES, [], "Events · Tables").filter((entry) => entry.path === "/c/garden");
    expect(garden).toEqual([{ label: "Garden", detail: "Aspect", path: "/c/garden" }]);
  });

  it("lists the pages alone while the server has given no tables", () => {
    expect(jumpEntries(PAGES, [], "Events · Tables").map((entry) => entry.label)).toEqual(["Events", "Calendar", "Tables", "Sources", "Garden"]);
  });
});
