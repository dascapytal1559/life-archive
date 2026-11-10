import { describe, expect, it } from "vitest";
import { axisLabels } from "./VolumeChart.tsx";
import { bucketAt, freshView, isFiltered, rangeOf, viewOf, viewQuery } from "./viewState.ts";
import { filterParams, NO_FILTERS, readFilters, type KindSpec } from "./wire.ts";

const CALLS: KindSpec = {
  kind: "calls",
  label: "Calls",
  noun: ["call", "calls"],
  columns: [
    { key: "when", label: "When", kind: "time", width: 100, sortable: true },
    { key: "app", label: "App", kind: "text", width: 100 },
    { key: "length", label: "Length", kind: "duration", width: 100, sortable: true },
  ],
  filters: [{ key: "app", label: "App", kind: "choice" }, { key: "person", label: "Person", kind: "person" }],
  measures: [{ key: "calls", label: "Calls", unit: "count" }, { key: "minutes", label: "Minutes", unit: "minutes" }],
  sort: "when",
  splits: ["app"],
};

describe("the filters on the wire", () => {
  it("read back as written", () => {
    const filters = { from: 10, to: 20, choices: { app: ["phone", "whatsapp"] }, person: 7, search: "Ada S" };
    expect(readFilters(filterParams(filters), ["app"])).toEqual(filters);
    expect(readFilters(filterParams(NO_FILTERS), ["app"])).toEqual(NO_FILTERS);
  });

  it("refuse what is not a time, a person or in order", () => {
    expect(() => readFilters(new URLSearchParams("from=1.5"), [])).toThrow(/from/);
    expect(() => readFilters(new URLSearchParams("to=9000000000000000"), [])).toThrow(/to/);
    expect(() => readFilters(new URLSearchParams("from=9&to=9"), [])).toThrow(/after/);
    expect(() => readFilters(new URLSearchParams("person=-1"), [])).toThrow(/person/);
    expect(() => readFilters(new URLSearchParams(`q=${"a".repeat(101)}`), [])).toThrow(/search/);
    expect(readFilters(new URLSearchParams("q=%20%20"), []).search).toBeNull();
  });
});

describe("the view in the address", () => {
  it("reads the table's filters, order, measure, grain, split and open row, and writes them back leaving out the defaults", () => {
    const view = viewOf(CALLS, "?app=phone&person=3&sort=length&dir=asc&measure=minutes&grain=week&split=app&open=call%3A7");
    expect(view).toEqual({
      kind: "calls", filters: { from: null, to: null, choices: { app: ["phone"] }, person: 3, search: null }, sort: "length", direction: "asc", measure: "minutes",
      grain: "week", split: "app", open: "call:7",
    });
    expect(viewQuery(view, CALLS)).toBe("?person=3&app=phone&sort=length&dir=asc&measure=minutes&grain=week&split=app&open=call%3A7");
    expect(viewQuery(freshView(CALLS), CALLS)).toBe("");
  });

  it("writes what it is given to put first before the view", () => {
    expect(viewQuery(freshView(CALLS), CALLS, { table: "calls" })).toBe("?table=calls");
    expect(viewQuery({ ...freshView(CALLS), open: "7" }, CALLS, { table: "calls" })).toBe("?table=calls&open=7");
  });

  it("keeps a search only for a table with a search box", () => {
    const people: KindSpec = { ...CALLS, kind: "people", search: "Find by name" };
    expect(viewOf(people, "?q=ada").filters.search).toBe("ada");
    expect(viewQuery(viewOf(people, "?q=ada"), people)).toBe("?q=ada");
    expect(viewOf(CALLS, "?q=ada").filters.search).toBeNull();
  });

  it("falls back to the table's defaults for what it cannot read", () => {
    expect(viewOf(CALLS, "?sort=app&measure=hours&grain=hour&from=soon&split=person")).toEqual(freshView(CALLS));
  });

  it("starts a table sorted the way it says (the tags, in their order), and writes only the other way", () => {
    const tags: KindSpec = { ...CALLS, kind: "tags", sort: "length", direction: "asc" };
    expect(freshView(tags).direction).toBe("asc");
    expect(viewQuery(freshView(tags), tags)).toBe("");
    expect(viewOf(tags, "").direction).toBe("asc");
    const turned = { ...freshView(tags), direction: "desc" as const };
    expect(viewQuery(turned, tags)).toBe("?dir=desc");
    expect(viewOf(tags, "?dir=desc").direction).toBe("desc");
  });

  it("says whether anything narrows it", () => {
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, to: 5 })).toBe(true);
    expect(isFiltered({ ...NO_FILTERS, choices: { app: [] } })).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, search: "ada" })).toBe(true);
  });
});

describe("the chart's arithmetic", () => {
  const buckets = [10, 20, 30, 40].map((start) => ({ start, day: "2026-01-01", value: 1 }));

  it("finds the bucket under a point, within the bars", () => {
    expect(bucketAt(0, 400, 4)).toBe(0);
    expect(bucketAt(150, 400, 4)).toBe(1);
    expect(bucketAt(399, 400, 4)).toBe(3);
    expect(bucketAt(-20, 400, 4)).toBe(0);
    expect(bucketAt(900, 400, 4)).toBe(3);
  });

  it("turns a drag either way into the time from its first bucket's start to its last's end", () => {
    expect(rangeOf(buckets, 50, 1, 2)).toEqual({ from: 20, to: 40 });
    expect(rangeOf(buckets, 50, 3, 1)).toEqual({ from: 20, to: 50 });
    expect(rangeOf(buckets, 50, 0, 0)).toEqual({ from: 10, to: 20 });
  });

  it("labels the axis where a month or year begins, never two labels too close", () => {
    const days = ["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02", "2026-03-01"].map((day) => ({ start: 0, day, value: 0 }));
    expect(axisLabels(days, "day", 30)).toEqual([{ at: 0, text: "Jan 2026" }, { at: 2, text: "Feb" }, { at: 4, text: "Mar" }]);
    expect(axisLabels(days, "day", 15)).toEqual([{ at: 0, text: "Jan 2026" }, { at: 4, text: "Mar" }]);
    const months = ["2025-11-01", "2025-12-01", "2026-01-01"].map((day) => ({ start: 0, day, value: 0 }));
    expect(axisLabels(months, "month", 60)).toEqual([{ at: 0, text: "2025" }, { at: 2, text: "2026" }]);
  });
});
