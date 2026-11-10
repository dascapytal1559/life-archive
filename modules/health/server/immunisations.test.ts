// What the immunisations protect against (immunisations.ts), on made-up doses only: splitting a combined vaccine into
// its diseases, everyday names, a brand read when the print names nothing known, an unknown disease kept without an
// interval, each disease's latest dose and how long it runs, and a course short of its doses.

import { describe, expect, it } from "vitest";
import { DISEASES, diseasesIn, diseasesOf, immunisationRecord, monthsOn, protectionOf, VACCINES } from "./immunisations.ts";
import type { Immunisation } from "./store.ts";

const dose = (date: string, against: string, vaccine = "Samplevax"): Immunisation => ({ date, against, vaccine, sources: ["made-up/statement.pdf"] });

describe("the diseases a record names", () => {
  it("splits a combined vaccine's print into its diseases, by the longest name the lookup knows", () => {
    expect(diseasesIn("Diphtheria Tetanus Pertussis").map((n) => n.key)).toEqual(["diphtheria", "tetanus", "pertussis"]);
    expect(diseasesIn("Hepatitis A and Hepatitis B").map((n) => n.key)).toEqual(["hepatitisA", "hepatitisB"]);
    expect(diseasesIn("Measles, Mumps, Rubella, Varicella").map((n) => n.key)).toEqual(["measles", "mumps", "rubella", "varicella"]);
    expect(diseasesIn("diphtheria-tetanus").map((n) => n.key)).toEqual(["diphtheria", "tetanus"]);
    expect(diseasesIn("COVID-19").map((n) => n.key)).toEqual(["covid19"]);
    expect(diseasesIn("Whooping cough").map((n) => [n.key, n.printed])).toEqual([["pertussis", "Whooping cough"]]);
  });

  it("keeps the words it does not know as one unknown disease, and names each disease once", () => {
    expect(diseasesIn("Tetanus Exampleitis Fever")).toEqual([{ key: "tetanus", printed: "Tetanus" }, { key: null, printed: "Exampleitis Fever" }]);
    expect(diseasesIn("Tetanus tetanus").map((n) => n.key)).toEqual(["tetanus"]);
  });

  it("reads the brand only where the print names nothing the lookup knows", () => {
    expect(diseasesOf({ against: "Booster", vaccine: "Adacel" }).map((n) => n.key)).toEqual(["diphtheria", "tetanus", "pertussis"]);
    expect(diseasesOf({ against: "Tetanus", vaccine: "Adacel" }).map((n) => n.key)).toEqual(["tetanus"]);
    expect(diseasesOf({ against: "Exampleitis", vaccine: "Samplevax" })).toEqual([{ key: null, printed: "Exampleitis" }]);
  });

  it("gives a dose's diseases as printed, with the everyday name where it differs", () => {
    expect(immunisationRecord(dose("2024-05-01", "Diphtheria Tetanus Pertussis")).diseases).toEqual([
      { name: "Diphtheria", everyday: null }, { name: "Tetanus", everyday: null }, { name: "Pertussis", everyday: "whooping cough" },
    ]);
    expect(immunisationRecord(dose("2024-05-01", "Whooping cough")).diseases).toEqual([{ name: "Whooping cough", everyday: null }]);
  });

  it("has every vaccine name only diseases it knows, and every disease a Handbook page", () => {
    for (const keys of Object.values(VACCINES)) for (const key of keys) expect(DISEASES[key]).toBeDefined();
    for (const d of Object.values(DISEASES)) expect(d.url).toMatch(/^https:\/\/immunisationhandbook\.health\.gov\.au\/contents\/vaccine-preventable-diseases\//);
  });
});

describe("what the immunisations protect against", () => {
  const born = "1976-01-10";
  const today = "2026-10-20";

  it("gives each disease its latest dose and its booster interval, the soonest to end first", () => {
    const rows = protectionOf([dose("2016-02-01", "Diphtheria Tetanus Pertussis"), dose("2021-08-30", "Tetanus"), dose("2026-04-01", "Influenza")], born, today);
    expect(rows.map((r) => [r.disease.name, r.latest.date, r.doses, r.span])).toEqual([
      ["Diphtheria", "2016-02-01", 1, { kind: "until", until: "2026-02-01", interval: "10 years" }],
      ["Pertussis", "2016-02-01", 1, { kind: "until", until: "2026-02-01", interval: "10 years" }],
      ["Influenza", "2026-04-01", 1, { kind: "until", until: "2027-04-01", interval: "1 year" }],
      ["Tetanus", "2021-08-30", 2, { kind: "until", until: "2031-08-30", interval: "10 years" }],
    ]);
    expect(rows[1].disease.everyday).toBe("whooping cough");
    expect(rows[1].handbook?.url).toBe("https://immunisationhandbook.health.gov.au/contents/vaccine-preventable-diseases/pertussis-whooping-cough");
  });

  it("shows a course short of its doses as incomplete until its next dose, and a full one as lasting", () => {
    expect(protectionOf([dose("2026-03-31", "Hepatitis A")], born, today)[0].span).toEqual({ kind: "course", until: "2026-09-30", doses: 1, of: 2 });
    expect(protectionOf([dose("2026-01-05", "Hepatitis B"), dose("2026-02-05", "Hepatitis B")], born, today)[0].span).toEqual({
      kind: "course", until: "2026-07-05", doses: 2, of: 3,
    });
    expect(protectionOf([dose("2025-01-05", "Hepatitis A"), dose("2025-08-05", "Hepatitis A")], born, today)[0].span).toEqual({ kind: "lasting", label: "no booster" });
    expect(protectionOf([dose("2024-07-01", "Yellow fever")], born, today)[0].span).toEqual({ kind: "lasting", label: "lifelong" });
  });

  it("counts one day's doses once, and takes COVID-19's shorter interval from 75", () => {
    expect(protectionOf([dose("2026-03-31", "Hepatitis A"), dose("2026-03-31", "Hepatitis A", "Examplehep")], born, today)[0].doses).toBe(1);
    expect(protectionOf([dose("2026-05-01", "COVID-19")], born, today)[0].span).toMatchObject({ until: "2027-05-01" });
    expect(protectionOf([dose("2026-05-01", "COVID-19")], "1950-01-10", today)[0].span).toMatchObject({ until: "2026-11-01", interval: "6 months" });
  });

  it("keeps an unknown disease's row with no interval or source, and a known one the Handbook sets no interval for", () => {
    const rows = protectionOf([dose("2025-06-01", "Exampleitis"), dose("2025-06-01", "Pneumococcal")], born, today);
    expect(rows.map((r) => [r.disease.name, r.span, r.handbook === null])).toEqual([
      ["Exampleitis", null, true],
      ["Pneumococcal disease", null, false],
    ]);
  });

  it("counts months on to the month's last day where the day is past it", () => {
    expect(monthsOn("2026-08-31", 6)).toBe("2027-02-28");
    expect(monthsOn("2026-01-15", 120)).toBe("2036-01-15");
  });
});
