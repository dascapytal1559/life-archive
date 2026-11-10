// How each range on the Health page was built from its authority (ranges.ts), told once per source, with what is
// particular to a test told once per test: what the source publishes, what this table took from it and how (bounds,
// units, any conversion, the age and sex bands, the grades past the line), whether it is a decision limit, a
// population interval, grades past another's line or the dashboard's own rule (kept, off), and what the source does not cover and
// what the page does instead. The page's information modal shows it beside the rungs that applied to the result. Each
// account says where its wording came from: most were checked against the source itself (16 Oct 2026), the rest say
// only what ranges.ts, its citations and catalogue.ts support. Where a source could not be checked for a figure (the
// ImmunoCAP classes), the account says so and the figure is not used. A change to a source or its bands in ranges.ts
// is a change here.

import type { RangeKind } from "../wire.ts";
import type { Sex, TableSource } from "./ranges.ts";

export interface SourceAccount {
  kind: RangeKind;
  /** What the source publishes for the tests this table takes from it. */
  publishes: string;
  /** What this table took from it, and how: the bounds, units, any conversion, the bands. */
  taken: string;
  /** What the source does not cover, and what the page does about it. */
  uncovered: string;
  /** Where this account's wording came from. */
  wordingFrom: string;
}

const FROM_TABLE = "ranges.ts's citation and bands for this source";

/**
 * How a lab's printed interval was taken, for a lab the archive's owner chose (labIntervals.ts): `reports` as the
 * account says it after "on" ("its reports of July 2024"), and whether it was the last lab to run its tests.
 */
export function labIntervalAccount({ lab, reports, last, sex }: { lab: string; reports: string; last?: boolean; sex: Sex }): SourceAccount {
  const [person, other] = sex === "male" ? ["man", "woman"] : ["woman", "man"];
  return {
    kind: "lab-interval",
    publishes: `${lab} prints its own reference interval beside each result, for the sex and age of the person tested. This is the interval it printed for an adult ${person} on ${reports}${last ? ", the last to run this test" : ""}.`,
    taken:
      "The interval as printed, in the unit printed, chosen once and kept whichever lab runs the test later: a lab's interval moves with its method, and a range that moved with each report could not be compared over years. A lower limit of 0 on a count is no limit, so it is taken as an upper limit alone.",
    uncovered:
      `Used only for a test no guideline or harmonised interval covers. A lab's interval holds for its own method and the people it was drawn from; it is for an adult ${person}, and is not judged for a ${other}. It gives no grades past it: CTCAE grades a blood count past it where CTCAE grades that count, and past the rest a result is out, nothing finer. The range each lab printed on each report is kept under "As printed" as evidence, and never colours or orders anything.`,
    wordingFrom: "modules/health/lab-intervals.json in the archive's folder, which names the lab and its interval for each test, and ranges.ts's header on why a lab's interval is chosen once.",
  };
}

const CHECKED = (what: string) => `Checked against the source itself on 16 Oct 2026 (${what}).`;

export const SOURCE_ACCOUNTS: Record<TableSource, SourceAccount> = {
  rcpa: {
    kind: "reference-interval",
    publishes:
      "Harmonised adult reference intervals: one interval for each common chemistry test, agreed by the AACB and endorsed by the RCPA, for every lab in Australasia to print in place of its own. A reference interval is where healthy adults' results fall; it is not a level of risk. Some intervals are split by sex, and some start at an age where the children's intervals end.",
    taken:
      "Each test's interval as the update report's Table 1 gives it, in the unit given (no conversion), with its sex split and the age it starts or ends at. Limits are inclusive.",
    uncovered:
      "It gives no grades past its intervals. CTCAE grades sodium, potassium, adjusted calcium, magnesium, creatinine, ALP, ALT, AST, GGT and bilirubin past them; past the rest (chloride, bicarbonate, uncorrected calcium, phosphate, LD, total protein, and any low side CTCAE does not grade) a result is out, nothing finer, as no authority grades it. Tests the harmonised table has no interval for (albumin and globulin, whose methods differ too much between labs; creatinine from 60) are judged by another named source, by a lab's printed interval, or not at all, and say so.",
    wordingFrom: `${FROM_TABLE} (Koerbin et al. 2019, Table 1) and the notes on its tests; not re-read against the paper for this text.`,
  },
  "aacb-urea": {
    kind: "reference-interval",
    publishes: "The AACB's recommended reference intervals for urea, by sex and by age: under 50, 50 to 69, and 70 and over.",
    taken: "All six bands (three for men, three for women) in mmol/L as published. Each result is judged by the band for the age on the day it was collected, so a chart's rungs step where an age band ends.",
    uncovered: "Under 18 is not covered, and nothing there is judged. Neither it nor CTCAE grades urea past its interval, so a result past it is out, nothing finer.",
    wordingFrom: `${FROM_TABLE} (Koerbin et al. 2019).`,
  },
  "aacb-lipids": {
    kind: "decision-limit",
    publishes:
      "Harmonised lipid reporting: the limits labs are asked to print beside lipid results, a result past which is flagged (above, or for HDL below). The document says they are neither population reference intervals nor clinical action limits: not where most people's results fall, so many healthy people sit outside them.",
    taken:
      "Its flag limits, in mmol/L, with a result at the limit itself not flagged: total cholesterol 5.5 or under, triglycerides 2.0 or under, LDL 3.0 or under, non-HDL 4.0 or under, HDL 1.0 or more for men and 1.2 or more for women (its upper limit, 2.3, is the ESC/EAS guideline's, told under its own source). The cholesterol to HDL ratio is optional in it (\"if a cut-off value is required 4.5 may be used\"); 4.5 or under is taken. One band for all adults.",
    uncovered:
      "It flags; it does not grade. Past its lines, LDL and total cholesterol are graded by NCEP ATP III, non-HDL by the National Lipid Association, triglycerides by the Endocrine Society, while past these lines HDL and the ratio, which none of them grades, are out, nothing finer. Lp(a) is judged by the EAS consensus, and ApoB by a lab's printed interval.",
    wordingFrom: CHECKED("the AACB's 2018 DGD01 PDF: its flag wording, the limits and the ratio's optional cut-off"),
  },
  kdigo: {
    kind: "decision-limit",
    publishes:
      "Categories of chronic kidney disease by eGFR, Table 5: G1 90 or more (normal or high), G2 60–89 (mildly decreased), G3a 45–59 (mildly to moderately decreased), G3b 30–44 (moderately to severely decreased), G4 15–29 (severely decreased), G5 under 15 (kidney failure). Under 60 is the kidney-disease range. KDIGO's 2024 guideline has since replaced the 2012 one, with the same categories.",
    taken: "The line at 60 or more, in mL/min/1.73m², for all adults; and its own categories under it as the grades: G3a mildly out, G3b out, G4 and G5 far out.",
    uncovered: "G1 and G2 are both in range. Labs print a high eGFR as \">90\", the top of their scale, read as 90 or more.",
    wordingFrom: CHECKED("the 2012 guideline's PDF, Table 5, p. 27"),
  },
  "who-glucose": {
    kind: "decision-limit",
    publishes:
      "The WHO and IDF's definitions for diagnosing diabetes and intermediate hyperglycaemia. It sets no \"normal\" cut-off as such: normoglycaemia is below the levels that define intermediate hyperglycaemia. A fasting plasma glucose of 6.1 to 6.9 mmol/L is impaired fasting glucose, and 7.0 or more is diabetes.",
    taken: "Under 6.1 mmol/L, below impaired fasting glucose, for a fasting glucose only; and its own categories past it as the grades: impaired fasting glucose mildly out, diabetes out.",
    uncovered: "No far out: the definitions stop at diabetes. They set no lower limit; the lower limit, 3.0 mmol/L, is the Endocrine Society's, told under its own source. A glucose taken without fasting depends on the last meal; no interval applies to it, and it is not judged.",
    wordingFrom: CHECKED("the 2006 report's PDF") + " ranges.ts for not judging a glucose taken without fasting.",
  },
  "ads-hba1c": {
    kind: "decision-limit",
    publishes:
      "The Australian Diabetes Society's guidance on HbA1c for diagnosing diabetes (2015): 48 mmol/mol (6.5%) or more diagnoses it, and 42–47 mmol/mol (6.0–6.4%) suggests a higher risk of developing it than the AUSDRISK score alone. It recommends against labelling that higher-risk group prediabetic.",
    taken:
      "Under 6.0%, in %, as the line; and its own two categories past it as the grades: 6.0–6.4% (higher risk) mildly out, 6.5% or more (diabetes) out. A result also printed in mmol/mol is kept as \"also printed as\" and not judged again.",
    uncovered: "No far out: the guidance stops at diabetes. An earlier statement (d'Emden et al. 2012), which this table cited before, gives the 6.5% cut-off alone, not the higher-risk band.",
    wordingFrom: CHECKED("the MJA 2015 article, section 3, and the 2012 article for what it lacks") + " catalogue.ts for the second unit.",
  },
  "nowson-vitd": {
    kind: "decision-limit",
    publishes:
      "A position statement on vitamin D for adults in Australia and New Zealand, under \"Serum 25-OHD status and target values\": adequacy is 50 nmol/L or more at the end of winter (and may need to be 10–20 nmol/L higher at the end of summer); mild deficiency is 30–49, moderate 12.5–29 and severe under 12.5 nmol/L.",
    taken: "50 nmol/L or more as the lower limit, whatever the season; and its grades of deficiency under it: mild as mildly out, moderate as out, severe as far out.",
    uncovered: "The season is not taken into account. It sets no upper limit (it puts the onset of toxicity far higher, at about 220 nmol/L for hypercalcaemia); the upper limit is the IOM's, 125 nmol/L, told under its own source.",
    wordingFrom: CHECKED("the MJA article"),
  },
  "eas-lpa": {
    kind: "decision-limit",
    publishes:
      "The European Atherosclerosis Society's consensus on lipoprotein(a) and heart disease: under 75 nmol/L (30 mg/dL) rules out raised risk, over 125 nmol/L (50 mg/dL) rules it in, and between is a grey zone; very high levels, over 430 nmol/L (180 mg/dL), carry a lifetime risk like untreated heterozygous familial hypercholesterolaemia's.",
    taken: "Under 75 nmol/L as the line, in nmol/L as the labs print it; and its own levels past it as the grades: the grey zone mildly out, over 125 out, over 430 far out.",
    uncovered:
      "Lp(a) is not among the AACB's lipid limits this table takes, so this consensus covers it alone. The consensus's recommendations box writes rule-in as 50 mg/dL (125 nmol/L) or more where its text says over; the text's is taken.",
    wordingFrom: CHECKED("the full text on PubMed Central: \"Consequences for risk thresholds\" and the section on whether risk rises in steps or in a line"),
  },
  "nhmrc-lead": {
    kind: "decision-limit",
    publishes: "The NHMRC's statement on lead and health (2015): if a blood lead level is greater than 5 µg/dL, the source of exposure should be investigated and reduced.",
    taken:
      "5 µg/dL converted to µmol/L, the unit the labs print it in: 50 µg/L ÷ 207.2 g/mol (lead's molar mass) = 0.24 µmol/L, so 0.24 µmol/L or under is in range. A result also printed in µg/dL is kept as \"also printed as\".",
    uncovered:
      "No lower limit: less lead is better. It gives one limit and no grades past it, so a result past it is out, nothing finer. (Australia's work health and safety rules set levels for removing a worker from lead work, 10 and 30 µg/dL; they are for workplaces, and are not used.)",
    wordingFrom: CHECKED("the statement's PDF; the conversion is arithmetic on its figure"),
  },
  "imm-handbook": {
    kind: "decision-limit",
    publishes: "The Australian Immunisation Handbook on hepatitis B: if the anti-HBs level is 10 mIU/mL or more, the person is considered immune.",
    taken: "10 IU/L or more (mIU/mL is the same number).",
    uncovered:
      "Immune or not: it gives no grades under 10, so a result under 10 is out, nothing finer. The other hepatitis B screens (the antibody's presence, the surface antigen) are read by their words instead.",
    wordingFrom: CHECKED("the Handbook's hepatitis B page") + " catalogue.ts for the screens.",
  },
  immunocap: {
    kind: "decision-limit",
    publishes:
      "Thermo Fisher's current guidance on ImmunoCAP specific IgE, in kUA/L: a result of 0.1 or more indicates sensitisation to the allergen. Its guides add that no standard amount tells how severe a reaction would be, and print no classes.",
    taken: "Under 0.1 kU/L as the line, for every allergen (it was the older class table's 0.35 before).",
    uncovered:
      "The classes labs print beside a result (0.35, 0.70, 3.50, 17.5, 50 and 100 kU/L, from class 1 to class 6, with words such as moderate or high) were not found in any of Thermo Fisher's own documents, so they do not grade it here: a sensitised result is out, nothing finer. The class the lab printed is kept under \"As printed\". A result out of range that a treatment answers is shown as under treatment.",
    wordingFrom:
      CHECKED("Thermo Fisher's quick guide, p. 2; its respiratory results interpretation guide; and its testing-algorithm pocket guide, p. 7") + " judge.ts for treatment.",
  },
  "heart-foundation": {
    kind: "decision-limit",
    publishes:
      "The Heart Foundation's guideline for hypertension in adults (2016), Table 2.1: optimal is under 120/80 mmHg, normal 120–129/80–84, high-normal 130–139/85–89, then grade 1 (mild) hypertension 140–159/90–99, grade 2 (moderate) 160–179/100–109 and grade 3 (severe) 180/110 or more. When the two numbers fall in different categories, the higher applies.",
    taken:
      "Under 130 mmHg systolic and under 85 mmHg diastolic as the lines, optimal and normal together, each judged as its own test rather than by the higher of the two; and its own categories past them as the grades: high-normal mildly out, grade 1 out, grades 2 and 3 far out.",
    uncovered: "No lower limit: low blood pressure is not judged.",
    wordingFrom: CHECKED("the guideline's PDF, Table 2.1, p. 12"),
  },
  "who-bmi": {
    kind: "decision-limit",
    publishes:
      "The World Health Organization's classes of body mass index for adults: under 18.50 underweight (mild thinness 17.00–18.49, moderate 16.00–16.99, severe under 16.00), 18.50–24.99 the normal range, 25.00–29.99 pre-obese, then obese classes I (30.00–34.99), II (35.00–39.99) and III (40.00 or more).",
    taken: "18.50 to under 25.00 kg/m² as the range; and its own classes past it as the grades: pre-obese and mild thinness mildly out, obese class I and moderate thinness out, obese classes II and III and severe thinness far out.",
    uncovered: "Body mass index does not tell fat from muscle. The body scan's fat and lean mass are shown beside it, not judged (no guideline sets a healthy body-fat percentage).",
    wordingFrom: CHECKED("Technical Report Series 894's Table 2.1, and the WHO Global Database on BMI's Table 1 in its archived copy for the grades of thinness"),
  },
  iscd: {
    kind: "decision-limit",
    publishes:
      "The International Society for Clinical Densitometry's 2019 adult positions: for women before menopause and men under 50, Z-scores are preferred, and a Z-score of −2.0 or lower is \"below the expected range for age\"; for women after menopause and men from 50, T-scores are. Its 2023 positions keep the same wording.",
    taken: "Over −2.0, for every site the scan reports (spine, each femoral neck, each hip, whole body), for men under 50.",
    uncovered:
      "From 50 a man's bone density is read by T-score, which the archive does not keep, so a Z-score from then is not judged; nor is a woman's, as the rule turns on menopause, which the archive does not know. It gives one limit and no grades past it, so a result past it is out, nothing finer.",
    wordingFrom: CHECKED("the 2019 adult positions' PDF, pp. 5–6, and the 2023 positions"),
  },
  ewgsop2: {
    kind: "decision-limit",
    publishes: "The revised European consensus on sarcopenia (EWGSOP2), Table 3: appendicular skeletal muscle mass for height under 7.0 kg/m² for men, or 5.5 kg/m² for women, is low.",
    taken: "7.0 kg/m² or more for men, 5.5 kg/m² or more for women, using the scan's limb lean mass for height.",
    uncovered: "This is the consensus's limit for muscle quantity alone; the page has no measure of strength or performance to go with it. It gives no grades under the limit, so a result under it is out, nothing finer.",
    wordingFrom: CHECKED("Table 3, on PubMed Central"),
  },
  words: {
    kind: "words",
    publishes: "No outside source: a screen or a culture reports its result in words, not a number.",
    taken:
      "Each screen's expected words, as catalogue.ts lists them: negative, not detected, non-reactive, no pathogens isolated, culturally negative; for the hepatitis B surface antibody, detected. Positive, detected or reactive is out of range; words neither list knows are not judged.",
    uncovered: "There are no bounds to show, and no grades.",
    wordingFrom: "catalogue.ts's expected and unexpected words, and ranges.ts's citation for the screens.",
  },
  "iom-vitd": {
    kind: "decision-limit",
    publishes:
      "The Institute of Medicine's 2011 report on calcium and vitamin D, as its committee summarised it for clinicians: \"serum 25OHD levels above 50 ng/ml (125 nmol/liter) should raise concerns among clinicians about potential adverse effects\", and risks \"have been identified for some outcomes\" above it. A level to be cautious above, not one where toxicity begins.",
    taken: "125 nmol/L or under as vitamin D's upper limit, for all adults (the paper prints both units: 50 ng/mL is 124.8 nmol/L). The lower limit stays the ANZ statement's, 50.",
    uncovered:
      "It gives no grades above 125, so a result above it is out, nothing finer. The ANZ statement puts hypercalcaemia from about 220 nmol/L, which could grade further; it is not used. The Endocrine Society's 2011 upper level (250 nmol/L) was set aside: its 2024 guideline sets no thresholds.",
    wordingFrom: "The research report of 16 Oct 2026, which read the paper's full text (NATAP's copy); the quotation is the paper's.",
  },
  "endo-hypo": {
    kind: "decision-limit",
    publishes:
      "The Endocrine Society's 2009 guideline on hypoglycaemia in adults, with or without diabetes: hypoglycaemia is diagnosed by Whipple's triad (symptoms, a low plasma glucose, relief when it is raised), with a plasma glucose under 55 mg/dL (3.0 mmol/L) as the low value. The International Hypoglycaemia Study Group's level 2, \"clinically significant\" hypoglycaemia, used by the ADA, is under 54 mg/dL (3.0 mmol/L), and CTCAE v5.0's grade 2 starts under 3.0.",
    taken:
      "3.0 mmol/L or more as fasting glucose's lower limit, for all adults (55 mg/dL ÷ 18.0 is 3.05, quoted as 3.0). The upper limit stays the WHO's, under 6.1. Under it, CTCAE v5.0 grades: under 3.0 to 2.2 out (grade 2), under 2.2 far out (grades 3 and 4).",
    uncovered:
      "The guideline's figure is one part of a three-part diagnosis; a glucose alone cannot show symptoms. The ADA's 3.9 mmol/L (level 1) is an alert for people on glucose-lowering treatment and is not used: a fasting 3.5 to 3.8 is common and harmless without diabetes.",
    wordingFrom:
      "The research report of 16 Oct 2026: the guideline's abstract was read (Europe PMC); its 55 mg/dL figure is as summaries of its body give it (labmed.org.uk, Endotext), the publisher's text being blocked; CTCAE's grades from its PDF, p. 86.",
  },
  "esc-eas-2019": {
    kind: "decision-limit",
    publishes:
      "As quoted, not read: the 2019 ESC/EAS guidelines for dyslipidaemias are reported to say that the risk of atherosclerotic heart disease \"may increase when HDL-C levels exceed 90 mg/dL (2.3 mmol/L)\", and to recommend not using HDL cholesterol as a risk measure above it. The guideline's own text could not be opened (its publisher returned a web page in place of the PDF), so this is what two independent sources say it says: Franczyk et al. 2021 (read in full) and the ESC's own E-Journal of Cardiology Practice (vol. 19, 2020).",
    taken: "2.3 mmol/L or under as HDL's upper limit, for men and women alike (90 mg/dL ÷ 38.67 is 2.33). The lower limits stay the AACB's.",
    uncovered:
      "A caution, not a reference or decision limit: risk \"may\" rise. It gives no grades above 2.3, so a result above it is out, nothing finer. A large Copenhagen cohort found the lowest mortality nearer 1.9 (men) and 2.4 (women), so this single figure is a simplification. Until someone reads the guideline's own section, treat it as second-hand.",
    wordingFrom: "The research report of 16 Oct 2026, from Franczyk et al. 2021 (full text, Europe PMC) and the ESC's E-Journal of Cardiology Practice; not checked against the guideline itself.",
  },
  "ncep-atp3": {
    kind: "grading",
    publishes:
      "ATP III's classification of cholesterol in mg/dL (Executive Summary, Table 2). LDL: under 100 optimal, 100–129 near optimal/above optimal, 130–159 borderline high, 160–189 high, 190 or more very high. Total cholesterol: under 200 desirable, 200–239 borderline high, 240 or more high. HDL: under 40 low.",
    taken:
      "Its categories past the AACB's line, the line kept where the AACB puts it, converted to mmol/L by dividing by 38.67 (cholesterol's factor, 1 mmol/L = 38.67 mg/dL) and rounded to two decimals. LDL: from the line (3.0) to 4.13 mildly out, high from 4.14 (160 mg/dL) out, very high from 4.91 (190) far out. Total cholesterol: from the line (5.5) mildly out, high from 6.21 (240) out; it has no grade further.",
    uncovered: "ATP III's categories below the AACB's line are all in range here. Its HDL \"low\" is under 40 mg/dL (1.03 mmol/L), near the AACB's line, with no grades under it, so a low HDL is out, nothing finer.",
    wordingFrom: CHECKED("the NIH Executive Summary's PDF, Table 2"),
  },
  "nla-2015": {
    kind: "grading",
    publishes:
      "The National Lipid Association's classification of cholesterol and triglycerides in mg/dL (Table 1). Non-HDL cholesterol: under 130 desirable, 130–159 above desirable, 160–189 borderline high, 190–219 high, 220 or more very high.",
    taken:
      "Its non-HDL categories past the AACB's line (4.0), converted to mmol/L by dividing by 38.67 and rounded to two decimals: from the line to 4.90 mildly out, high from 4.91 (190 mg/dL) out, very high from 5.69 (220) far out.",
    uncovered: "Used for non-HDL alone. ATP III (2002) does not classify non-HDL; the NLA's (2015) is the classification of a respected body that does.",
    wordingFrom: CHECKED("the full report's PDF, Table 1, p. 138"),
  },
  "endo-tg": {
    kind: "grading",
    publishes:
      "The Endocrine Society's levels of fasting triglycerides (Table 1, printed in both units): normal under 1.7 mmol/L, mild 1.7–2.3, moderate 2.3–11.2, severe 11.2–22.4, very severe 22.4 or more.",
    taken: "Its levels past the AACB's line (2.0), in mmol/L as printed: from the line to 2.3 mildly out, moderate from 2.3 out, severe and very severe from 11.2 far out.",
    uncovered: "Its levels are for fasting triglycerides; the page does not know whether a sample was fasting.",
    wordingFrom: CHECKED("the guideline on PubMed Central, Table 1"),
  },
  "ctcae-v5": {
    kind: "grading",
    publishes:
      "The National Cancer Institute's grades of an adverse event, for reporting side effects in drug trials. For a lab result, grade 1 is just past the limit of normal and grades 2 to 4 further past it, by a set value (potassium over 5.5, then over 6.0) or a multiple of the limit (ALT over 3 × the upper limit, then over 5 ×).",
    taken:
      "Its grades as the page's: grade 1 mildly out, grade 2 out, grades 3 and 4 far out, with the line of this table's primary source as its limit of normal, so the line never moves. For ALT, AST, ALP, GGT and bilirubin, the grades for a normal starting level. A grade told only by symptoms (potassium's grade 2) cannot be told from a number, so the numbers fall to the grade they share.",
    uncovered:
      "Made to report side effects in trials, not to judge a healthy person, and its first grade is coarse: everything from the limit to the next value is grade 1. Where it gives no numbers (phosphate, bicarbonate, uric acid, eosinophils) or no grade on a side, a result past the line is out, nothing finer.",
    wordingFrom: CHECKED("the official v5.0 PDF, pp. 3–4 and 78–86"),
  },
  percent: {
    kind: "own-rule",
    publishes: "Nothing: no authority grades this side of this test's line.",
    taken:
      "The dashboard's own rule of thumb, by how far past the line a result is, as a share of the interval's width (or, with one limit, of the limit itself): up to 10% past it mildly out, 10% to 25% out, beyond 25% far out. Under 0 there is nothing.",
    uncovered: "No authority stands behind these grades; they only say how far past the line, not what it means. Come to your own judgement.",
    wordingFrom: "ranges.ts's PERCENT; not taken from any source.",
  },
};

/** What is particular to one test, beyond its source's account and its note in ranges.ts. */
export const TEST_ACCOUNTS: Record<string, string> = {
  hdl: "Too little HDL is the main risk, so its first limit is a floor, the AACB's; its ceiling, 2.3, is the ESC/EAS guideline's as two sources quote it (the guideline's own text was not read).",
  apob: "A lipid, but judged by a lab's printed population interval, not a decision limit like the other lipids'.",
  "bp-systolic": "The top number of a reading; the bottom number is judged on its own as diastolic.",
  "bp-diastolic": "The bottom number of a reading; the top number is judged on its own as systolic.",
  folate: "A lower limit alone: the lab prints a floor and no ceiling.",
  b12: "A lower limit alone: the lab prints a floor and no ceiling.",
};
