// The Health page's own tabs, under the archive's: All (everything but the sample's quality), Physical, Cholesterol,
// Allergies, Records (what is no lab result: immunisations, medicines and Medicare's claims; Records.tsx) and Sources
// (how results are judged, the sources, and the sample-quality results), each a slice of the one answer. Which results a tab holds is decided here and only here, by the catalogue's body systems
// (../server/catalogue.ts's SYSTEMS, as the answer names them) and, where a system is wider than the tab, by
// test key: a new test in the Body or Allergy system lands in its tab by itself, a new lipid joins LIPIDS. Each tab is a
// view under the console's Health Record aspect (HealthSection.tsx), All the aspect's address itself.

import type { HealthTest } from "../wire.ts";

/** The lipid tests, by catalogue key: the heart system less what is not a lipid (homocysteine, CRP, blood pressure). */
export const LIPIDS: ReadonlySet<string> = new Set(["cholesterol", "ldl", "hdl", "non-hdl", "triglycerides", "chol-hdl", "apob", "lpa"]);

/** Blood pressure: in the heart system, but measured at the physical assessment, so Physical's too. */
export const BLOOD_PRESSURE: ReadonlySet<string> = new Set(["bp-systolic", "bp-diastolic"]);

/** The systems' names as the answer gives them (catalogue.ts's SYSTEMS). */
export const BODY = "Body";
export const ALLERGY = "Allergy";
/** The sample's own quality (haemolysis), not the person's: parked on Sources. */
export const SAMPLE = "The sample";

export interface HealthTab {
  /** Its step in the address; "" for All. */
  key: string;
  label: string;
  /** Whether it holds the result `test`. */
  holds: (test: HealthTest) => boolean;
  /**
   * Where it shows the highest heart rate recorded and the physical assessment (Everlab's numbers): first, above its
   * results (Physical, where they are the point), last, below them, or not at all.
   */
  fitness: "first" | "last" | null;
  /** Whether it is Sources: how results are judged and the sources, where the other tabs only point to it. */
  sources: boolean;
  /** Whether it is Records: the records that are no lab result, in place of results, where the other tabs only point to it. */
  records: boolean;
}

export const HEALTH_TABS: readonly HealthTab[] = [
  { key: "", label: "All", holds: (test) => test.system !== SAMPLE, fitness: "last", sources: false, records: false },
  { key: "physical", label: "Physical", holds: (test) => test.system === BODY || BLOOD_PRESSURE.has(test.key), fitness: "first", sources: false, records: false },
  { key: "cholesterol", label: "Cholesterol", holds: (test) => LIPIDS.has(test.key), fitness: null, sources: false, records: false },
  { key: "allergies", label: "Allergies", holds: (test) => test.system === ALLERGY, fitness: null, sources: false, records: false },
  { key: "records", label: "Records", holds: () => false, fitness: null, sources: false, records: true },
  { key: "sources", label: "Sources", holds: (test) => test.system === SAMPLE, fitness: null, sources: true, records: false },
];
