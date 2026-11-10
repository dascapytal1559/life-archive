import { describe, expect, it } from "vitest";
import type { HealthTest } from "../wire.ts";
import { SYSTEMS, testOf } from "../server/catalogue.ts";
import { ALLERGY, BLOOD_PRESSURE, BODY, HEALTH_TABS, LIPIDS, SAMPLE } from "./tabs.ts";

const test = (key: string, system: string): HealthTest => ({
  key,
  name: key,
  unit: null,
  system,
  kind: "number",
  status: "in",
  margin: 0.5,
  points: [],
  bands: [],
  rungs: [],
  scale: null,
  authority: null,
  noAuthority: null,
  screen: null,
  treatment: null,
});

const TESTS = [
  test("ldl", "Heart and cholesterol"),
  test("lpa", "Heart and cholesterol"),
  test("crp", "Heart and cholesterol"),
  test("bp-systolic", "Heart and cholesterol"),
  test("body-fat", "Body"),
  test("ige-cat", "Allergy"),
  test("ferritin", "Iron and vitamins"),
  test("haemolysis-index", "The sample"),
];

const tab = (label: string) => HEALTH_TABS.find((t) => t.label === label)!;
const held = (label: string) => TESTS.filter(tab(label).holds).map((t) => t.key);

describe("the Health page's tabs", () => {
  it("Sources holds only the sample's quality, and only it shows how results are judged", () => {
    expect(held("Sources")).toEqual(["haemolysis-index"]);
    expect(SAMPLE).toBe(SYSTEMS.sample);
    expect(HEALTH_TABS.filter((t) => t.sources).map((t) => t.label)).toEqual(["Sources"]);
    expect(tab("Sources").fitness).toBe(null);
  });

  it("All holds every result and the physical assessment", () => {
    expect(held("All")).toEqual(TESTS.map((t) => t.key).filter((k) => k !== "haemolysis-index"));
    expect(tab("All").fitness).toBe("last");
  });

  it("Cholesterol holds the lipids alone, not the rest of the heart system", () => {
    expect(held("Cholesterol")).toEqual(["ldl", "lpa"]);
    expect(tab("Cholesterol").fitness).toBe(null);
  });

  it("Physical holds the body scan and blood pressure, with heart rate and the physical assessment first", () => {
    expect(held("Physical")).toEqual(["bp-systolic", "body-fat"]);
    expect(tab("Physical").fitness).toBe("first");
  });

  it("Allergies holds the allergy system", () => {
    expect(held("Allergies")).toEqual(["ige-cat"]);
  });

  it("Records holds no result: its records are drawn in their place, and only it draws them", () => {
    expect(held("Records")).toEqual([]);
    expect(HEALTH_TABS.filter((t) => t.records).map((t) => t.label)).toEqual(["Records"]);
  });

  it("names only tests and systems the catalogue has", () => {
    for (const key of [...LIPIDS, ...BLOOD_PRESSURE]) expect(testOf(key), key).toBeDefined();
    expect(Object.values(SYSTEMS)).toEqual(expect.arrayContaining([BODY, ALLERGY]));
  });

});
