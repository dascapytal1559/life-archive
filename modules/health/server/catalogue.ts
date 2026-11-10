// Every test the Health tab knows: its key (what ranges.ts and the stored readings name it by), its name and unit as
// the page writes them, the body system it belongs to, and the names the labs print it under. An import maps each
// printed row to a test by name (and, for a test printed in two units, by unit: the other unit is kept beside the
// result as "also printed as", never charted). A printed name no test has is kept as an unknown test, shown unjudged,
// and the import says so; adding its alias here is how it joins its test.

export type System =
  | "heart" | "sugar" | "blood" | "iron" | "kidney" | "liver" | "hormones" | "metals" | "body" | "allergy" | "infection" | "sample";

/** Each system's name, in the order the page lists a system's tests when nothing else orders them. */
export const SYSTEMS: Record<System, string> = {
  heart: "Heart and cholesterol",
  sugar: "Blood sugar",
  blood: "Blood count",
  iron: "Iron and vitamins",
  kidney: "Kidneys and salts",
  liver: "Liver and proteins",
  hormones: "Hormones and thyroid",
  metals: "Heavy metals",
  body: "Body",
  allergy: "Allergy",
  infection: "Infection screens",
  sample: "The sample",
};

/** How a printed result is judged when it is words: the words that are the expected result, and those that are not. */
export interface Words {
  expected: string[];
  unexpected: string[];
  /** The word an expected result is shown as: "Clear" (nothing found), "Immune" (a protective antibody found). */
  shown: "Clear" | "Immune";
  /** How the screen is read, in a plain line ("Lab screen: negative is the expected result"). */
  line: string;
}

export interface TestDef {
  key: string;
  name: string;
  /** The unit results are charted in; null for a ratio or a score. */
  unit: string | null;
  system: System;
  /** The names the labs print it under (matched without case, spaces or a trailing colon). */
  printed: string[];
  /** A unit it is also printed in, as the same result written again: kept as "also printed as". */
  otherUnits?: string[];
  /** A result in words (a screen, a culture), judged by them rather than by a range. */
  words?: Words;
}

const NEGATIVE: Words = {
  expected: ["Negative", "Not detected", "Non reactive", "No pathogens isolated", "Culturally negative"],
  unexpected: ["Positive", "Detected", "Reactive"],
  shown: "Clear",
  line: "Lab screen: negative is the expected result",
};

const t = (key: string, name: string, unit: string | null, system: System, printed: string[], more: Partial<TestDef> = {}): TestDef => ({ key, name, unit, system, printed, ...more });

export const TESTS: readonly TestDef[] = [
  // Heart and cholesterol
  t("cholesterol", "Total cholesterol", "mmol/L", "heart", ["Cholesterol", "S Cholesterol"]),
  t("triglycerides", "Triglycerides", "mmol/L", "heart", ["Triglycerides", "S Triglycerides"]),
  t("hdl", "HDL cholesterol", "mmol/L", "heart", ["S HDL-Cholesterol", "HDL Cholesterol"]),
  t("ldl", "LDL cholesterol", "mmol/L", "heart", ["S LDL-Cholesterol", "LDL Cholesterol"]),
  t("non-hdl", "Non-HDL cholesterol", "mmol/L", "heart", ["Non HDL Cholesterol"]),
  t("chol-hdl", "Cholesterol to HDL ratio", null, "heart", ["Chol/HDLC"]),
  t("apob", "Apolipoprotein B", "g/L", "heart", ["Apoliprotein B", "Apolipoprotein B"]),
  t("lpa", "Lipoprotein(a)", "nmol/L", "heart", ["Lipoprotein (a)"]),
  t("homocysteine", "Homocysteine", "µmol/L", "heart", ["Serum Homocysteine", "Homocysteine"]),
  t("crp", "C-reactive protein (sensitive)", "mg/L", "heart", ["S Sensitive CRP", "CRP"]),
  t("bp-systolic", "Blood pressure, systolic", "mmHg", "heart", ["Systolic blood pressure"]),
  t("bp-diastolic", "Blood pressure, diastolic", "mmHg", "heart", ["Diastolic blood pressure"]),
  // Blood sugar
  t("glucose-fasting", "Glucose, fasting", "mmol/L", "sugar", ["Fasting S Glucose", "Glucose (fasting)"]),
  t("glucose-random", "Glucose, not fasting", "mmol/L", "sugar", ["Glucose random"]),
  t("hba1c", "HbA1c", "%", "sugar", ["B Glycosylated Haemoglobin (Hb A1c)", "HBA1c (IFCC)"], { otherUnits: ["mmol/mol"] }),
  t("insulin-fasting", "Insulin, fasting", "mU/L", "sugar", ["S Insulin (Fasting)"]),
  // Blood count
  t("haemoglobin", "Haemoglobin", "g/L", "blood", ["Haemoglobin"]),
  t("haematocrit", "Haematocrit", "L/L", "blood", ["Haematocrit"]),
  t("red-cells", "Red cell count", "×10¹²/L", "blood", ["Red cell count"]),
  t("mcv", "Mean cell volume (MCV)", "fL", "blood", ["MCV", "M.C.V.", "Mean Cell Volume"]),
  t("mch", "Mean cell haemoglobin (MCH)", "pg", "blood", ["M.C.H.", "Mean Cell Haemoglobin"]),
  t("mchc", "Mean cell haemoglobin concentration (MCHC)", "g/L", "blood", ["M.C.H.C."]),
  t("rdw", "Red cell distribution width (RDW)", "%", "blood", ["RDW"]),
  t("platelets", "Platelets", "×10⁹/L", "blood", ["Platelets", "Platelet Count"]),
  t("white-cells", "White cell count", "×10⁹/L", "blood", ["White cell count"]),
  t("neutrophils", "Neutrophils", "×10⁹/L", "blood", ["Neutrophils"]),
  t("lymphocytes", "Lymphocytes", "×10⁹/L", "blood", ["Lymphocytes"]),
  t("monocytes", "Monocytes", "×10⁹/L", "blood", ["Monocytes"]),
  t("eosinophils", "Eosinophils", "×10⁹/L", "blood", ["Eosinophils"]),
  t("basophils", "Basophils", "×10⁹/L", "blood", ["Basophils"]),
  t("esr", "Erythrocyte sedimentation rate (ESR)", "mm/h", "blood", ["ESR"]),
  // Iron and vitamins
  t("iron", "Iron", "µmol/L", "iron", ["Iron", "S Iron", "Serum Iron"]),
  t("transferrin", "Transferrin", "g/L", "iron", ["Transferrin", "S Transferrin"]),
  t("tibc", "Total iron-binding capacity", "µmol/L", "iron", ["TIBC", "Transferrin IBC"]),
  t("transferrin-saturation", "Transferrin saturation", "%", "iron", ["Saturation", "Transferrin Saturation"]),
  t("ferritin", "Ferritin", "µg/L", "iron", ["Ferritin", "S Ferritin", "Serum Ferritin Assay"]),
  t("b12", "Vitamin B12", "pmol/L", "iron", ["Vitamin B12"]),
  t("active-b12", "Active B12 (holotranscobalamin)", "pmol/L", "iron", ["Active B12", "Holo-transcobalamin"]),
  t("folate", "Folate", "nmol/L", "iron", ["Folate (Serum)", "S Folate"]),
  t("vitamin-d", "Vitamin D", "nmol/L", "iron", ["25-Hydroxy Vitamin D"]),
  t("zinc", "Zinc", "µmol/L", "iron", ["Zinc-plasma"]),
  // Kidneys and salts
  t("sodium", "Sodium", "mmol/L", "kidney", ["Sodium", "S Sodium"]),
  t("potassium", "Potassium", "mmol/L", "kidney", ["Potassium", "S Potassium"]),
  t("chloride", "Chloride", "mmol/L", "kidney", ["Chloride", "S Chloride"]),
  t("bicarbonate", "Bicarbonate", "mmol/L", "kidney", ["Bicarbonate", "S Bicarbonate"]),
  t("anion-gap", "Anion gap", "mmol/L", "kidney", ["Anion Gap", "Other Anions"]),
  t("urea", "Urea", "mmol/L", "kidney", ["Urea", "S Urea"]),
  t("creatinine", "Creatinine", "µmol/L", "kidney", ["Creatinine", "S Creatinine"]),
  t("egfr", "eGFR (kidney filtering)", "mL/min/1.73m²", "kidney", ["eGFR"]),
  t("urate", "Uric acid", "mmol/L", "kidney", ["Urate", "S Uric Acid", "Uric Acid"]),
  t("calcium", "Calcium", "mmol/L", "kidney", ["Calcium"]),
  t("calcium-adjusted", "Calcium, adjusted for albumin", "mmol/L", "kidney", ["Calcium (Corrected)", "Adjusted for Albumin"]),
  t("phosphate", "Phosphate", "mmol/L", "kidney", ["Phosphate"]),
  t("magnesium", "Magnesium", "mmol/L", "kidney", ["S Magnesium", "Magnesium"]),
  // Liver and proteins
  t("bilirubin", "Bilirubin", "µmol/L", "liver", ["Bilirubin", "S Bilirubin", "Total Bilirubin"]),
  t("alp", "Alkaline phosphatase (ALP)", "U/L", "liver", ["ALP", "S Alkaline Phosphatase", "Alk. Phos."]),
  t("alt", "ALT", "U/L", "liver", ["ALT", "S ALT"]),
  t("ast", "AST", "U/L", "liver", ["AST", "S AST"]),
  t("ggt", "GGT", "U/L", "liver", ["GGT", "S Gamma-GT", "Gamma G.T."]),
  t("ld", "Lactate dehydrogenase (LD)", "U/L", "liver", ["LD"]),
  t("total-protein", "Total protein", "g/L", "liver", ["Total Protein", "S Total Protein"]),
  t("albumin", "Albumin", "g/L", "liver", ["Albumin", "S Albumin"]),
  t("globulin", "Globulin", "g/L", "liver", ["Globulin", "S Globulin", "Globulins"]),
  // Hormones and thyroid
  t("testosterone", "Testosterone", "nmol/L", "hormones", ["Testosterone", "S Testosterone"]),
  t("free-testosterone", "Free testosterone", "pmol/L", "hormones", ["Free Test (VC)"]),
  t("shbg", "SHBG", "nmol/L", "hormones", ["SHBG"]),
  t("tsh", "TSH (thyroid)", "mU/L", "hormones", ["TSH", "TSH (Roche)"]),
  t("psa", "PSA (prostate)", "µg/L", "hormones", ["PSA"]),
  // Heavy metals
  t("lead", "Lead", "µmol/L", "metals", ["Lead-blood"], { otherUnits: ["µg/dL"] }),
  t("mercury", "Mercury", "nmol/L", "metals", ["Mercury-blood"]),
  // Body (the DEXA scan)
  t("weight", "Weight", "kg", "body", ["Weight"]),
  t("bmi", "Body mass index", "kg/m²", "body", ["Body Mass Index (BMI)"]),
  t("body-fat", "Body fat", "%", "body", ["Total Body % Fat"]),
  t("lean-mass", "Lean mass", "kg", "body", ["Lean Mass"]),
  t("vat-mass", "Visceral fat (estimated)", "g", "body", ["Est. VAT Mass (g)"]),
  t("android-gynoid", "Android to gynoid fat ratio", null, "body", ["Android/Gynoid Ratio"]),
  t("almi", "Limb lean mass for height", "kg/m²", "body", ["Appen. Lean/Height² (kg/m²)"]),
  t("bmd-z-spine", "Bone density, spine (L1–L4), Z-score", null, "body", ["AP Spine L1-L4"]),
  t("bmd-z-neck-left", "Bone density, left femoral neck, Z-score", null, "body", ["Neck Left"]),
  t("bmd-z-neck-right", "Bone density, right femoral neck, Z-score", null, "body", ["Neck Right"]),
  t("bmd-z-hip-left", "Bone density, left total hip, Z-score", null, "body", ["Total Left"]),
  t("bmd-z-hip-right", "Bone density, right total hip, Z-score", null, "body", ["Total Right"]),
  t("bmd-z-total", "Bone density, whole body, Z-score", null, "body", ["Total Body BMD"]),
  // Allergy (specific IgE)
  t("ige-cat", "Cat (specific IgE)", "kU/L", "allergy", ["Cat epithelium"]),
  t("ige-dust-mite", "Dust mite (specific IgE)", "kU/L", "allergy", ["Dust Mite (D. pteronyssinus)", "Dustmite"]),
  t("ige-rye-grass", "Perennial rye grass (specific IgE)", "kU/L", "allergy", ["Perennial rye grass"]),
  t("ige-alternaria", "Alternaria mould (specific IgE)", "kU/L", "allergy", ["Alternaria alternata"]),
  // Infection screens
  t("hbsab-level", "Hepatitis B surface antibody level", "IU/L", "infection", ["HBsAb level"]),
  t("hbsab", "Hepatitis B surface antibody", null, "infection", ["HepB surface antibody"], {
    words: { expected: ["Detected"], unexpected: ["Not detected"], shown: "Immune", line: "Lab screen: detected means immune (10 IU/L or more protects)" },
  }),
  t("hbsag", "Hepatitis B surface antigen", null, "infection", ["Hep B surface Antigen", "Hepatitis B surface antigen (HBsAg)"], { words: NEGATIVE }),
  t("hcv-ab", "Hepatitis C antibody", null, "infection", ["Hepatitis C IgG antibody (HCVIgG)"], { words: NEGATIVE }),
  t("hiv", "HIV antigen and antibody", null, "infection", ["HIV antigen / HIV 1 HIV 2 antibody"], { words: NEGATIVE }),
  t("syphilis", "Syphilis (treponemal antibody)", null, "infection", ["Treponemal antibody screen"], { words: NEGATIVE }),
  t("chlamydia", "Chlamydia (urine)", null, "infection", ["CHLAMYDIA TRACHOMATIS (NAT)"], { words: NEGATIVE }),
  t("gonorrhoea", "Gonorrhoea (urine)", null, "infection", ["NEISSERIA GONORRHOEAE (NAT)"], { words: NEGATIVE }),
  t("urine-mycoplasma", "Mycoplasma and ureaplasma culture (urine)", null, "infection", ["Org 1"], { words: NEGATIVE }),
  t("swab-culture", "Swab culture", null, "infection", ["Culture"], { words: NEGATIVE }),
  // The sample
  t("haemolysis-index", "Haemolysis index", "mg/dL", "sample", ["Haemolysis Index"]),
];

/** A printed name as it is matched: no case, no spaces, no trailing colon. */
export function printedKey(name: string): string {
  return name.replace(/:\s*$/, "").replace(/\s+/g, "").toLowerCase();
}

const BY_PRINTED = new Map<string, TestDef>();
for (const test of TESTS) {
  for (const name of test.printed) {
    const key = printedKey(name);
    if (BY_PRINTED.has(key)) throw new Error(`two tests are printed as ${name}`);
    BY_PRINTED.set(key, test);
  }
}

/** The test a printed name is, or undefined. */
export function testPrinted(name: string): TestDef | undefined {
  return BY_PRINTED.get(printedKey(name));
}

/** The test keyed `key`, or undefined. */
export function testOf(key: string): TestDef | undefined {
  return TESTS.find((test) => test.key === key);
}

/** The key an unknown printed name is kept under: "unknown:" and the name as it is matched. */
export function unknownKey(name: string): string {
  return `unknown:${printedKey(name)}`;
}

/** A unit as the labs print it, written one way: umol/L is µmol/L, 10*9/L is ×10⁹/L, mIU/L is mU/L. */
export function unitOf(printed: string | null): string | null {
  if (printed === null) return null;
  const unit = printed.replace(/\s+/g, "");
  const known: Record<string, string> = {
    "umol/L": "µmol/L",
    "ug/L": "µg/L",
    "ug/dL": "µg/dL",
    "mIU/L": "mU/L",
    "10*9/L": "×10⁹/L",
    "x10*9/L": "×10⁹/L",
    "x10^9/L": "×10⁹/L",
    "10*12/L": "×10¹²/L",
    "x10*12/L": "×10¹²/L",
    "x10^12/L": "×10¹²/L",
    "mL/min": "mL/min/1.73m²",
  };
  return known[unit] ?? unit;
}
