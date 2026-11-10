// The one authority on range: for every test the Health tab knows (catalogue.ts), the interval a result is judged by,
// with the age and sex bands its source gives, and the source itself. A result is judged by the band for the person's
// age on the day it was collected (worked out from the date of birth), never by the range the testing lab printed,
// which is kept beside it as evidence only. So the band moves only where an age band ends, or when this table is
// changed for a new guideline (and RANGES_VERSION with it).
//
// The primary source is the RCPA's harmonised reference intervals for adults (the AACB's, endorsed by the RCPA), as
// published in Koerbin et al. 2019. A test those do not cover is judged by one named source, recorded beside it: an
// Australian guideline or consensus where there is one, else a lab's printed interval (LAB_TESTS): which lab's is the
// archive's owner's choice, kept in the archive's folder, not here (labIntervals.ts), chosen once and kept whichever
// lab later runs the test; without one, the test is not judged. A lab's lower limit of 0 on a count is no limit, so
// those are upper limits alone. A test with no defensible authority says why and is never coloured.
//
// A side's line may come from another named source than the rest of the range, where the primary source sets no limit
// that way and another trusted one does (vitamin D's upper limit, by the IOM): its own source, stars and account
// (Judged.lines). That source's limits are the line, which never moves. Past it a result is graded mildly out, out or far out, by the
// first of: the line's own source, where it publishes grades; a second named source, from the line out (NCEP ATP III,
// the NLA, the Endocrine Society, CTCAE v5.0 with the line as its limit of normal). Where neither grades, a result past
// the line is out, by the line's own source, and nothing finer: no grade no authority backs. The dashboard's own rule
// (PERCENT) is kept but off (PERCENT_RULE). A source gives as many grades as it publishes, never more. Every source has stars by one rubric (STARS), with why,
// so the page can say how far to lean on the grade a result is given. judge.ts turns these into each band's rungs.
//
// Limits are inclusive unless marked open: { high: 5.5 } is "5.5 or under"; { high: 5, highOpen: true } is "under 5".

/** The sources a test's range is from. */
export type PrimarySource =
  | "rcpa" | "aacb-urea" | "aacb-lipids" | "kdigo" | "who-glucose" | "ads-hba1c" | "nowson-vitd" | "eas-lpa" | "nhmrc-lead"
  | "imm-handbook" | "immunocap" | "heart-foundation" | "who-bmi" | "iscd" | "ewgsop2" | "words";
/** The sources that set one side's line, or grade past another's. */
export type FurtherSource = "iom-vitd" | "endo-hypo" | "esc-eas-2019" | "ncep-atp3" | "nla-2015" | "endo-tg" | "ctcae-v5" | "percent";
/** The sources this table names. */
export type TableSource = PrimarySource | FurtherSource;
/** A source's key: the table's own, or a lab's interval the archive's owner chose (labIntervals.ts). */
export type SourceKey = TableSource | (string & {});

/** How far a source can be leaned on, by STARS: 3, a clinical standard made for this; 0, the dashboard's own rule. */
export type Stars = 0 | 1 | 2 | 3;

export interface Source {
  name: string;
  citation: string;
  url: string | null;
  stars: Stars;
  /** Why it has those stars, in a line, by STARS. */
  starsWhy: string;
  /** Further places it was read from, where its figure was read second-hand (HDL's upper limit). */
  links?: { label: string; url: string }[];
}

/** The rubric every source's stars are given by. */
export const STARS: Record<Stars, string> = {
  3: "A national or international clinical standard, made for exactly this use and this population.",
  2: "A respected authority, used outside its exact purpose, population or era, or with coarse grades.",
  1: "A single lab's printed interval, fixed once.",
  0: "No authority: the dashboard's own rule. Judge it yourself.",
};

export const PRIMARY_SOURCES: Record<PrimarySource, Source> = {
  rcpa: {
    name: "RCPA harmonised reference intervals",
    citation:
      "AACB harmonised adult reference intervals, endorsed by the RCPA: Koerbin G, Sikaris K, Jones GRD, Flatman R, Tate JR. An update report on the harmonization of adult reference intervals in Australasia. Clin Chem Lab Med 2019;57(1):38–41, Table 1 (first panel: Tate JR et al. Clin Biochem Rev 2014;35(4):213–235).",
    url: "https://doi.org/10.1515/cclm-2017-0920",
    stars: 3,
    starsWhy: "Australasia's harmonised adult intervals, agreed for every lab here to print.",
  },
  "aacb-urea": {
    name: "AACB harmonised interval for urea",
    citation: "The AACB's recommended age and sex intervals for urea, in Koerbin G et al. Clin Chem Lab Med 2019;57(1):38–41.",
    url: "https://doi.org/10.1515/cclm-2017-0920",
    stars: 3,
    starsWhy: "The AACB's harmonised Australasian intervals for urea, by age and sex.",
  },
  "aacb-lipids": {
    name: "AACB harmonised lipid reporting",
    citation:
      "AACB Harmonisation of Lipids Expert Group. Harmonised Lipid Reporting – Recommendations from the Harmonisation Workshop 2018 (2018 DGD01, August 2018): decision limits, not population intervals.",
    url: "https://aacblm.imiscloud.com/common/Uploaded%20files/aacb/guidelines%20and%20position%20statements/guidelines/AACB-endorsed%20Harmonisation%20Guidelines/20180801%20GPS%20Guideline%20for%20harmonisation%20of%20lipid%20reporting.pdf",
    stars: 3,
    starsWhy: "Australasia's harmonised lipid flag limits, agreed for every lab here to print.",
  },
  kdigo: {
    name: "KDIGO 2012 CKD guideline",
    citation:
      "KDIGO 2012 Clinical Practice Guideline for the Evaluation and Management of Chronic Kidney Disease. Kidney Int Suppl 2013;3:1–150, Table 5, \"GFR categories in CKD\" (p. 27): under 60 is categories G3a to G5.",
    url: "https://kdigo.org/wp-content/uploads/2017/02/KDIGO_2012_CKD_GL.pdf",
    stars: 3,
    starsWhy: "The international kidney guideline's own categories of eGFR.",
  },
  "who-glucose": {
    name: "WHO 2006 diabetes definitions",
    citation: "WHO/IDF. Definition and diagnosis of diabetes mellitus and intermediate hyperglycaemia (2006): fasting plasma glucose under 6.1 mmol/L is normal.",
    url: "https://www.who.int/publications/i/item/definition-and-diagnosis-of-diabetes-mellitus-and-intermediate-hyperglycaemia",
    stars: 3,
    starsWhy: "The WHO's international definitions for diagnosing diabetes.",
  },
  "ads-hba1c": {
    name: "Australian HbA1c position statement",
    citation:
      "Australian Diabetes Society position statement: d'Emden MC, Shaw JE, Jones GRD, Cheung NW. Guidance concerning the use of glycated haemoglobin (HbA1c) for the diagnosis of diabetes mellitus. Med J Aust 2015;203(2):89–90, section 3, \"Repeat assessment of HbA1c levels\": 48 mmol/mol (6.5%) or more diagnoses diabetes, and 42–47 mmol/mol (6.0–6.4%) suggests a higher risk of developing it. (It updates d'Emden et al. 2012, which gives the 6.5% cut-off alone.)",
    url: "https://doi.org/10.5694/mja15.00041",
    stars: 3,
    starsWhy: "An Australian position statement on diagnosing diabetes by HbA1c.",
  },
  "nowson-vitd": {
    name: "ANZ vitamin D position statement",
    citation: "Nowson CA, McGrath JJ, Ebeling PR, et al. Vitamin D and health in adults in Australia and New Zealand: a position statement. Med J Aust 2012;196(11):686–687, under \"Serum 25-OHD status and target values\": adequacy is 50 nmol/L or more; mild deficiency 30–49, moderate 12.5–29, severe under 12.5.",
    url: "https://doi.org/10.5694/mja11.10301",
    stars: 3,
    starsWhy: "The Australian and New Zealand position statement on vitamin D for adults.",
  },
  "eas-lpa": {
    name: "EAS 2022 Lp(a) consensus",
    citation: "Kronenberg F, Mora S, Stroes ESG, et al. Lipoprotein(a) in atherosclerotic cardiovascular disease and aortic stenosis: a European Atherosclerosis Society consensus statement. Eur Heart J 2022;43(39):3925–3946, \"Consequences for risk thresholds\": under 75 nmol/L rules out raised risk, over 125 rules it in; and on very high levels (over 430 nmol/L).",
    url: "https://doi.org/10.1093/eurheartj/ehac361",
    stars: 2,
    starsWhy: "A European consensus statement; no Australian body sets its own Lp(a) limits.",
  },
  "nhmrc-lead": {
    name: "NHMRC statement on blood lead",
    citation: "NHMRC Statement: Evidence on the Effects of Lead on Human Health (2015): a blood lead over 5 µg/dL (0.24 µmol/L) should be investigated.",
    url: "https://www.nhmrc.gov.au/about-us/publications/evidence-effects-lead-human-health",
    stars: 3,
    starsWhy: "Australia's national health research council's statement on blood lead.",
  },
  "imm-handbook": {
    name: "Australian Immunisation Handbook",
    citation: "Australian Immunisation Handbook, Hepatitis B: an anti-HBs level of 10 mIU/mL (IU/L) or more is protective.",
    url: "https://immunisationhandbook.health.gov.au/contents/vaccine-preventable-diseases/hepatitis-b",
    stars: 3,
    starsWhy: "Australia's national immunisation guidance, for exactly this measure.",
  },
  immunocap: {
    name: "ImmunoCAP specific IgE classes",
    citation:
      "Thermo Fisher Scientific, Quick guide to using ImmunoCAP Specific IgE testing (2024), p. 2: \"Results ≥0.1 kUA/l indicate an allergen sensitization\".",
    url: "https://corporate.thermofisher.com/content/dam/phadia/library/en/Quick_guide_to_using_ImmunoCAP_Specific_IgE_testing.pdf",
    stars: 2,
    starsWhy: "The test maker's own reading of its results: respected, but a manufacturer's, not a clinical body's.",
  },
  "heart-foundation": {
    name: "Heart Foundation 2016 hypertension guideline",
    citation: "National Heart Foundation of Australia. Guideline for the diagnosis and management of hypertension in adults (2016), Table 2.1, \"Classification of clinic blood pressure levels in adults\" (p. 12): normal is under 130/85 mmHg, then high-normal 130–139/85–89 and grades 1 to 3 of hypertension.",
    url: "https://www.heartfoundation.org.au/getmedia/c83511ab-835a-4fcf-96f5-88d770582ddc/PRO-167_Hypertension-guideline-2016_WEB.pdf",
    stars: 3,
    starsWhy: "Australia's national guideline for blood pressure in adults.",
  },
  "who-bmi": {
    name: "WHO BMI classes",
    citation:
      "World Health Organization. Obesity: preventing and managing the global epidemic, Technical Report Series 894 (2000), Table 2.1: normal range 18.50–24.99 kg/m², pre-obese 25.00–29.99, obese class I 30.00–34.99, class II 35.00–39.99, class III 40.00 or more. The grades of thinness under 18.50 are the WHO Global Database on Body Mass Index's Table 1 (adapted from WHO 1995, Technical Report Series 854).",
    url: "https://iris.who.int/handle/10665/42330",
    stars: 3,
    starsWhy: "The WHO's international classes of body mass index for adults.",
  },
  iscd: {
    name: "ISCD 2019 official positions",
    citation:
      "International Society for Clinical Densitometry, 2019 Adult Official Positions, \"BMD Reporting in Females Prior to Menopause and in Males Younger Than Age 50\" (p. 6): Z-scores are preferred, and −2.0 or lower is below the expected range for age; from 50, a man's is read by T-score (p. 5).",
    url: "https://iscd.org/wp-content/uploads/2021/09/2019-Official-Positions-Adult-1.pdf",
    stars: 2,
    starsWhy: "An international society's positions on reading bone scans; a Z-score is set against the scanner maker's reference people, not Australians.",
  },
  ewgsop2: {
    name: "EWGSOP2 sarcopenia consensus",
    citation: "Cruz-Jentoft AJ, Bahat G, Bauer J, et al. Sarcopenia: revised European consensus on definition and diagnosis. Age Ageing 2019;48(1):16–31: appendicular lean mass under 7.0 kg/m² (men) or 5.5 kg/m² (women) is low.",
    url: "https://doi.org/10.1093/ageing/afy169",
    stars: 2,
    starsWhy: "A European consensus made for older people's sarcopenia, applied here at every adult age.",
  },
  words: {
    name: "The screen's own result",
    citation: "A screen or culture is read by its result in words: not detected (negative, non-reactive, no pathogens) is the expected result.",
    url: null,
    stars: 3,
    starsWhy: "The lab reports the finding itself in words; no range is involved.",
  },
};

// A lab's printed interval comes between these two (labIntervals.ts's sourcesWith).
export const FURTHER_SOURCES: Record<FurtherSource, Source> = {
  // A side's line where the primary source sets none that way (Judged.lines).
  "iom-vitd": {
    name: "IOM 2011 vitamin D report",
    citation:
      "Ross AC, Manson JE, Abrams SA, et al. The 2011 report on dietary reference intakes for calcium and vitamin D from the Institute of Medicine: what clinicians need to know. J Clin Endocrinol Metab 2011;96(1):53–58: \"serum 25OHD levels above 50 ng/ml (125 nmol/liter) should raise concerns among clinicians about potential adverse effects\".",
    url: "https://doi.org/10.1210/jc.2010-2704",
    stars: 2,
    starsWhy: "The US and Canadian standards body's report, written for intake requirements rather than for flagging a result, and not Australian.",
    links: [{ label: "Full text (NATAP's copy)", url: "https://natap.org/2011/HIV/012711_03.htm" }],
  },
  "endo-hypo": {
    name: "Endocrine Society 2009 hypoglycaemia guideline",
    citation:
      "Cryer PE, Axelrod L, Grossman AB, et al. Evaluation and management of adult hypoglycemic disorders: an Endocrine Society clinical practice guideline. J Clin Endocrinol Metab 2009;94(3):709–728: a plasma glucose under 55 mg/dL (3.0 mmol/L) is the low value in diagnosing hypoglycaemia in adults, with or without diabetes. The same 3.0 mmol/L is the International Hypoglycaemia Study Group's level 2 (\"clinically significant\", used by the ADA's Standards of Care) and CTCAE v5.0's start of grade 2.",
    url: "https://europepmc.org/article/MED/19088155",
    stars: 2,
    starsWhy: "An international clinical guideline for exactly this population, but American, from 2009, and its figure is one part of a three-part diagnosis.",
  },
  "esc-eas-2019": {
    name: "ESC/EAS 2019 dyslipidaemia guidelines, as quoted",
    citation:
      "Mach F, Baigent C, Catapano AL, et al. 2019 ESC/EAS Guidelines for the management of dyslipidaemias. Eur Heart J 2020;41(1):111–188: the risk of atherosclerotic heart disease may increase when HDL cholesterol exceeds 90 mg/dL (2.3 mmol/L). Read second-hand: the guideline's own text could not be opened; the figure and its wording are as two independent sources quote it, Franczyk B et al. Is a high HDL-cholesterol level always beneficial? Biomedicines 2021;9(9):1083, and the ESC's E-Journal of Cardiology Practice, vol. 19 (2020), for which no link was found.",
    url: "https://doi.org/10.1093/eurheartj/ehz455",
    stars: 2,
    starsWhy: "A respected international guideline, but European, phrased as a possibility (\"may increase\"), and read here only as two sources quote it.",
    links: [{ label: "Franczyk et al. 2021, which quotes it (full text)", url: "https://europepmc.org/article/PMC/PMC8466913" }],
  },
  // Grading past the line, where the source of the line gives no grades of its own.
  "ncep-atp3": {
    name: "NCEP ATP III classification",
    citation:
      "National Cholesterol Education Program. Executive Summary of the Third Report of the Expert Panel on Detection, Evaluation, and Treatment of High Blood Cholesterol in Adults (Adult Treatment Panel III), NIH Publication 01-3670 (2001), Table 2, \"ATP III Classification of LDL, Total, and HDL Cholesterol (mg/dL)\". Also JAMA 2001;285(19):2486–2497.",
    url: "https://www.nhlbi.nih.gov/files/docs/guidelines/atp3xsum.pdf",
    stars: 2,
    starsWhy: "A respected clinical standard, but American and of 2002, and in mg/dL: used here only to grade past the AACB's line.",
  },
  "nla-2015": {
    name: "National Lipid Association recommendations",
    citation:
      "Jacobson TA, Ito MK, Maki KC, et al. National Lipid Association recommendations for patient-centered management of dyslipidemia: Part 1 – full report. J Clin Lipidol 2015;9(2):129–169, Table 1, \"Classifications of cholesterol and triglyceride levels in mg/dL\" (p. 138).",
    url: "https://doi.org/10.1016/j.jacl.2015.02.003",
    stars: 2,
    starsWhy: "A respected American society's recommendations, in mg/dL: used here only to grade past the AACB's line.",
  },
  "endo-tg": {
    name: "Endocrine Society 2012 hypertriglyceridaemia guideline",
    citation:
      "Berglund L, Brunzell JD, Goldberg AC, et al. Evaluation and treatment of hypertriglyceridemia: an Endocrine Society clinical practice guideline. J Clin Endocrinol Metab 2012;97(9):2969–2989, Table 1, the column \"The Endocrine Society 2010\" (mg/dL and mmol/L).",
    url: "https://doi.org/10.1210/jc.2011-3213",
    stars: 2,
    starsWhy: "An American clinical practice guideline of 2012: used here only to grade past the AACB's line.",
  },
  "ctcae-v5": {
    name: "NCI CTCAE v5.0",
    citation:
      "National Cancer Institute. Common Terminology Criteria for Adverse Events (CTCAE) version 5.0, 27 November 2017: grades of a laboratory result past the upper or lower limit of normal (Blood and lymphatic system disorders, pp. 3–4; Investigations, pp. 78–83; Metabolism and nutrition disorders, pp. 84–86).",
    url: "https://dctd.cancer.gov/research/ctep-trials/for-sites/adverse-events/ctcae-v5-8x11.pdf",
    stars: 2,
    starsWhy: "The standard grading of a lab result past its limits, but made to report side effects in drug trials, and its first grade is coarse.",
  },
  percent: {
    name: "The dashboard's own rule",
    citation:
      "No authority grades this test past its line. This dashboard's own rule, by how far past the line a result is, as a share of the interval's width (or of its one limit): mildly out up to 10%, out from 10% to 25%, far out beyond.",
    url: null,
    stars: 0,
    starsWhy: "No authority grades this: it is the dashboard's rule of thumb, a guide to how far past the line, not what that means. Judge these grades yourself.",
  },
};

/** The sources this table names. */
export const SOURCES: Record<TableSource, Source> = { ...PRIMARY_SOURCES, ...FURTHER_SOURCES };

/** When this table last changed: a change to any interval or source is a new version. */
export const RANGES_VERSION = "2026-11-08.1";

export type Sex = "male" | "female";

/** One band of an interval: its limits for a sex (both when none) and ages [from, to) in whole years (to null: no end). */
export interface Band {
  sex?: Sex;
  ages?: [number, number | null];
  low?: number;
  high?: number;
  lowOpen?: boolean;
  highOpen?: boolean;
}

/** How far past the line a result is: a little (mildly out), out, or far out. */
export type OutGrade = "mild" | "out" | "far";

/**
 * Where a grade starts, going outward from the line: at a value; at a multiple of the line (CTCAE's "× ULN"); at an
 * amount past the line (CTCAE's rise in haemoglobin); or at a share of the interval's width (or of its one limit) past
 * the line (the dashboard's own rule).
 */
export type Start = { value: number } | { times: number } | { past: number } | { share: number };

/**
 * One grade past the line, as its source names it. The first grade starts at the line itself and has no start. A grade
 * whose start is open leaves the start itself to the grade before it: CTCAE's ">5.5–6.0" starts at 5.5, open.
 */
export interface Step {
  grade: OutGrade;
  start?: Start;
  open?: boolean;
  /** The source's own name for it: "Grade 2: over 5.5 to 6.0", "High: 160 to 189 mg/dL". */
  label: string;
}

/** The grades past one side of the line, from one source, with how they were taken from it (units, conversions). */
export interface Grading {
  source: TableSource;
  steps: Step[];
  note?: string;
}

/**
 * A test's authority: the source of its line and its bands, with a note; the source of a side's line where another
 * source sets it (lines; lineSource); and its grades past the line above and below, where a source gives them (else
 * out, by that side's line's source alone; gradingFor). Or none, and why.
 */
export type Authority = Judged | { none: string };

export interface Judged {
  source: SourceKey;
  bands: Band[];
  /** A side whose line (every band's limit that way) another source sets, by that source. */
  lines?: Partial<Record<"above" | "below", TableSource>>;
  note?: string;
  above?: Grading;
  below?: Grading;
}

/** What a test's entry holds besides its source and bands: a note, another source's line on a side, grades past it. */
export type More = Pick<Judged, "note" | "lines" | "above" | "below">;

/** Adults: the RCPA's intervals, and a lab's printed ones, are for 18 and over unless a band says otherwise. */
export const ADULT: [number, null] = [18, null];
const m = (low: number | undefined, high: number | undefined, more: Partial<Band> = {}): Band => ({ sex: "male", ages: ADULT, low, high, ...more });
const f = (low: number | undefined, high: number | undefined, more: Partial<Band> = {}): Band => ({ sex: "female", ages: ADULT, low, high, ...more });
const both = (low: number | undefined, high: number | undefined, more: Partial<Band> = {}): Band => ({ ages: ADULT, low, high, ...more });
const from = (source: TableSource, bands: Band[], more: string | More = {}): Judged => ({ source, bands, ...(typeof more === "string" ? { note: more } : more) });

/** A grade, its start and the source's name for it. */
const step = (grade: OutGrade, label: string, start?: Start, open = false): Step => (start ? { grade, start, open, label } : { grade, label });
const at = (value: number): Start => ({ value });
const times = (n: number): Start => ({ times: n });

/**
 * Whether the dashboard's own rule grades a side with a line no source grades. Off: no authority backs it, so the page
 * shows no grade by it (the captain's word, 2026-10-16). Kept, with PERCENT and its source, to turn back on.
 */
export const PERCENT_RULE = false;

/** The dashboard's own rule, on a side with a line no source grades: mildly out to 10% past it, out to 25%, far out beyond. */
export const PERCENT: Grading = {
  source: "percent",
  steps: [
    step("mild", "Up to 10% of the interval's width past the line"),
    step("out", "From 10% to 25% past it", { share: 0.1 }, true),
    step("far", "More than 25% past it", { share: 0.25 }, true),
  ],
};

// CTCAE v5.0's grades: grade 1 is mildly out, grade 2 out, grades 3 and 4 far out, each from the line as its limit of
// normal. A grade it gives by symptoms alone (potassium's grade 2) cannot be told from a number, so it is left to the
// grade its numbers fall in.
const ctcae = (steps: Step[], note?: string): Grading => (note ? { source: "ctcae-v5", steps, note } : { source: "ctcae-v5", steps });
const CTCAE_ULN = (two: number, three: number, name: string): Grading =>
  ctcae([
    step("mild", `${name}, grade 1: over the upper limit to ${two} × it`),
    step("out", `Grade 2: over ${two} to ${three} × the upper limit`, times(two), true),
    step("far", `Grades 3 and 4: over ${three} × the upper limit`, times(three), true),
  ]);

/** Why a test LAB_TESTS lists is not judged, while no lab's interval is chosen for it. */
export const NO_LAB_INTERVAL =
  "No guideline or harmonised interval covers this test, and no lab's printed interval is chosen for it (modules/health/lab-intervals.json in the archive's folder), so nothing judges it.";

/**
 * The tests no guideline or harmonised interval covers, judged by a lab's printed interval for an adult, chosen once
 * and kept in the archive's folder (labIntervals.ts); each with the grades CTCAE gives past it, where it grades the
 * test, else none: past the line it is out, nothing finer.
 */
export const LAB_TESTS: Record<string, More> = {
  haemoglobin: {
    above: ctcae([
      step("mild", "Haemoglobin increased, grade 1: up to 20 g/L over the upper limit"),
      step("out", "Grade 2: over 20 to 40 g/L over it", { past: 20 }, true),
      step("far", "Grade 3: over 40 g/L over it", { past: 40 }, true),
    ], "CTCAE gives the rise in g/dL (over 0 to 2, over 2 to 4, over 4), here in g/L, without saying from what; its definition is of haemoglobin above normal, so the rise is counted from the line."),
    below: ctcae([
      step("mild", "Anaemia, grade 1: under the lower limit to 100"),
      step("out", "Grade 2: under 100 to 80", at(100), true),
      step("far", "Grades 3 and 4: under 80", at(80), true),
    ]),
  },
  haematocrit: {},
  "red-cells": {},
  mcv: {},
  mch: {},
  mchc: {},
  rdw: {},
  platelets: {
    below: ctcae([
      step("mild", "Platelet count decreased, grade 1: under the lower limit to 75"),
      step("out", "Grade 2: under 75 to 50", at(75), true),
      step("far", "Grades 3 and 4: under 50", at(50), true),
    ]),
  },
  "white-cells": {
    below: ctcae([
      step("mild", "White blood cell decreased, grade 1: under the lower limit to 3.0"),
      step("out", "Grade 2: under 3.0 to 2.0", at(3.0), true),
      step("far", "Grades 3 and 4: under 2.0", at(2.0), true),
    ]),
  },
  neutrophils: {
    below: ctcae([
      step("mild", "Neutrophil count decreased, grade 1: under the lower limit to 1.5"),
      step("out", "Grade 2: under 1.5 to 1.0", at(1.5), true),
      step("far", "Grades 3 and 4: under 1.0", at(1.0), true),
    ]),
  },
  lymphocytes: {
    above: ctcae(
      [step("out", "Lymphocyte count increased, grade 2: over 4 to 20"), step("far", "Grade 3: over 20", at(20), true)],
      "CTCAE gives no grade 1 for a high lymphocyte count: its first grade starts at 4, this line.",
    ),
    below: ctcae([
      step("mild", "Lymphocyte count decreased, grade 1: under the lower limit to 0.8"),
      step("out", "Grade 2: under 0.8 to 0.5", at(0.8), true),
      step("far", "Grades 3 and 4: under 0.5", at(0.5), true),
    ]),
  },
  ...Object.fromEntries(
    [
      "monocytes", "eosinophils", "basophils", "iron", "transferrin", "transferrin-saturation", "ferritin", "active-b12", "folate", "zinc", "urate",
      "homocysteine", "crp", "apob", "insulin-fasting", "testosterone", "free-testosterone", "shbg", "tsh", "psa", "mercury", "tibc", "esr", "b12",
    ].map((key) => [key, {}]),
  ),
};

export const RANGES: Record<string, Authority> = {
  // The RCPA's harmonised intervals, graded past them by CTCAE where it grades the test, else by the dashboard's rule.
  sodium: from("rcpa", [both(135, 145)], {
    above: ctcae([
      step("mild", "Hypernatraemia, grade 1: over the upper limit to 150"),
      step("out", "Grade 2: over 150 to 155", at(150), true),
      step("far", "Grades 3 and 4: over 155", at(155), true),
    ]),
    below: ctcae(
      [
        step("mild", "Hyponatraemia, grade 1: under the lower limit to 130"),
        step("out", "Grade 2: 125 to 129", at(130), true),
        step("far", "Grades 3 and 4: under 125", at(125), true),
      ],
      "CTCAE also puts 125 to 129 at grade 3 with symptoms, which a number cannot show.",
    ),
  }),
  potassium: from("rcpa", [both(3.5, 5.2)], {
    above: ctcae([
      step("mild", "Hyperkalaemia, grade 1: over the upper limit to 5.5"),
      step("out", "Grade 2: over 5.5 to 6.0", at(5.5), true),
      step("far", "Grades 3 and 4: over 6.0", at(6.0), true),
    ]),
    below: ctcae(
      [step("mild", "Hypokalaemia, grades 1 and 2: under the lower limit to 3.0"), step("far", "Grades 3 and 4: under 3.0", at(3.0), true)],
      "CTCAE's grade 2 is the same numbers as grade 1 with symptoms, so there is no \"out\" between mildly and far out.",
    ),
  }),
  chloride: from("rcpa", [both(95, 110)]),
  bicarbonate: from("rcpa", [both(22, 32)]),
  creatinine: from("rcpa", [m(60, 110, { ages: [18, 60] }), f(45, 90, { ages: [18, 60] })], {
    note: "Harmonised up to 60; from 60 there is no harmonised interval.",
    above: CTCAE_ULN(1.5, 3, "Creatinine increased"),
  }),
  calcium: from("rcpa", [both(2.1, 2.6)]),
  "calcium-adjusted": from("rcpa", [both(2.1, 2.6)], {
    above: ctcae([
      step("mild", "Hypercalcaemia, grade 1: over the upper limit to 2.9"),
      step("out", "Grade 2: over 2.9 to 3.1", at(2.9), true),
      step("far", "Grades 3 and 4: over 3.1", at(3.1), true),
    ]),
    below: ctcae([
      step("mild", "Hypocalcaemia, grade 1: under the lower limit to 2.0"),
      step("out", "Grade 2: under 2.0 to 1.75", at(2.0), true),
      step("far", "Grades 3 and 4: under 1.75", at(1.75), true),
    ]),
  }),
  phosphate: from("rcpa", [both(0.75, 1.5, { ages: [20, null] })], "From 20, to meet the children's intervals."),
  magnesium: from("rcpa", [both(0.7, 1.1)], {
    above: ctcae(
      [step("mild", "Hypermagnesaemia, grade 1: over the upper limit to 1.23"), step("far", "Grades 3 and 4: over 1.23", at(1.23), true)],
      "CTCAE gives no grade 2 for a high magnesium.",
    ),
    below: ctcae([
      step("mild", "Hypomagnesaemia, grade 1: under the lower limit to 0.5"),
      step("out", "Grade 2: under 0.5 to 0.4", at(0.5), true),
      step("far", "Grades 3 and 4: under 0.4", at(0.4), true),
    ]),
  }),
  ld: from("rcpa", [both(120, 250)]),
  alp: from("rcpa", [both(30, 110, { ages: [22, null] })], { note: "From 22, to meet the children's intervals.", above: CTCAE_ULN(2.5, 5, "Alkaline phosphatase increased") }),
  "total-protein": from("rcpa", [both(60, 80)]),
  bilirubin: from("rcpa", [both(1, 20)], { above: CTCAE_ULN(1.5, 3, "Blood bilirubin increased") }),
  alt: from("rcpa", [m(5, 40), f(5, 35)], { note: "For methods without pyridoxal 5-phosphate.", above: CTCAE_ULN(3, 5, "ALT increased") }),
  ast: from("rcpa", [m(5, 35), f(5, 30)], { note: "For methods without pyridoxal 5-phosphate.", above: CTCAE_ULN(3, 5, "AST increased") }),
  ggt: from("rcpa", [m(5, 50), f(5, 35)], { above: CTCAE_ULN(2.5, 5, "GGT increased") }),
  urea: from("aacb-urea", [
    m(3.5, 8.0, { ages: [18, 50] }), m(4.0, 9.0, { ages: [50, 70] }), m(4.5, 10.0, { ages: [70, null] }),
    f(3.0, 7.0, { ages: [18, 50] }), f(3.5, 8.0, { ages: [50, 70] }), f(4.0, 9.0, { ages: [70, null] }),
  ]),
  albumin: { none: "No harmonised interval: the AACB found albumin methods differ too much between labs for one (Koerbin 2019), and a lab's own interval holds only for its method." },
  globulin: { none: "Worked out from albumin, which has no harmonised interval, so it has none either (Koerbin 2019)." },
  "anion-gap": { none: "Worked out from the salts by a formula that differs between labs (with or without potassium), so no one interval holds." },
  egfr: from("kdigo", [both(60, undefined)], {
    note: "60 or more is outside the kidney-disease range; 90 or more is the top of the scale.",
    below: {
      source: "kdigo",
      steps: [
        step("mild", "G3a, mildly to moderately decreased: 45 to 59"),
        step("out", "G3b, moderately to severely decreased: 30 to 44", at(45), true),
        step("far", "G4, severely decreased (15 to 29), and G5, kidney failure (under 15)", at(30), true),
      ],
    },
  }),

  // Lipids: the AACB's harmonised decision limits, graded past them by NCEP ATP III, the NLA and the Endocrine Society.
  cholesterol: from("aacb-lipids", [both(undefined, 5.5)], {
    above: {
      source: "ncep-atp3",
      steps: [step("mild", "Borderline high: 200 to 239 mg/dL (5.17 to 6.20)"), step("out", "High: 240 mg/dL (6.21) or more", at(6.21))],
      note: "ATP III's mg/dL in mmol/L, divided by 38.67 (cholesterol's factor) and rounded to two decimals: 240 is 6.21. The AACB's line, 5.5, falls inside ATP III's borderline high, which grades from there.",
    },
  }),
  triglycerides: from("aacb-lipids", [both(undefined, 2.0)], {
    above: {
      source: "endo-tg",
      steps: [
        step("mild", "Mild hypertriglyceridaemia: 1.7 to 2.3 mmol/L"),
        step("out", "Moderate: 2.3 to 11.2 mmol/L", at(2.3)),
        step("far", "Severe (11.2 to 22.4) and very severe (22.4 mmol/L or more)", at(11.2)),
      ],
      note: "In mmol/L as the guideline prints them beside mg/dL; where two printed bands meet (2.3, 11.2), the higher takes the value. The AACB's line, 2.0, falls inside the guideline's mild band, which grades from there.",
    },
  }),
  ldl: from("aacb-lipids", [both(undefined, 3.0)], {
    above: {
      source: "ncep-atp3",
      steps: [
        step("mild", "Near optimal/above optimal (100 to 129 mg/dL) and borderline high (130 to 159 mg/dL): up to 4.13"),
        step("out", "High: 160 to 189 mg/dL (4.14 to 4.90)", at(4.14)),
        step("far", "Very high: 190 mg/dL (4.91) or more", at(4.91)),
      ],
      note: "ATP III's mg/dL in mmol/L, divided by 38.67 (cholesterol's factor) and rounded to two decimals: 160 is 4.14, 190 is 4.91.",
    },
  }),
  hdl: from("aacb-lipids", [m(1.0, 2.3), f(1.2, 2.3)], { lines: { above: "esc-eas-2019" } }),
  "non-hdl": from("aacb-lipids", [both(undefined, 4.0)], {
    above: {
      source: "nla-2015",
      steps: [
        step("mild", "Above desirable (130 to 159 mg/dL) and borderline high (160 to 189 mg/dL): up to 4.90"),
        step("out", "High: 190 to 219 mg/dL (4.91 to 5.68)", at(4.91)),
        step("far", "Very high: 220 mg/dL (5.69) or more", at(5.69)),
      ],
      note: "The NLA's mg/dL in mmol/L, divided by 38.67 (cholesterol's factor) and rounded to two decimals: 190 is 4.91, 220 is 5.69.",
    },
  }),
  "chol-hdl": from("aacb-lipids", [both(undefined, 4.5)], "The guideline's cut-off where one is wanted; it says the ratio is not to be read alone."),
  lpa: from("eas-lpa", [both(undefined, 75, { highOpen: true })], {
    above: {
      source: "eas-lpa",
      steps: [
        step("mild", "Grey zone: 75 to 125 nmol/L (30 to 50 mg/dL)"),
        step("out", "Rules in raised risk: over 125 nmol/L (50 mg/dL)", at(125), true),
        step("far", "Very high: over 430 nmol/L (180 mg/dL), a lifetime risk like untreated familial hypercholesterolaemia's", at(430), true),
      ],
    },
  }),

  // Blood sugar.
  "glucose-fasting": from("who-glucose", [both(3.0, 6.1, { highOpen: true })], {
    lines: { below: "endo-hypo" },
    below: ctcae(
      [step("out", "Hypoglycaemia, grade 2: under 3.0 to 2.2"), step("far", "Grades 3 and 4: under 2.2", at(2.2), true)],
      "CTCAE's grade 1 runs from the lower limit of normal to 3.0, so with the line at 3.0 its grades start at grade 2.",
    ),
    above: {
      source: "who-glucose",
      steps: [step("mild", "Impaired fasting glucose: 6.1 to 6.9"), step("out", "Diabetes: 7.0 or more", at(7.0))],
    },
  }),
  "glucose-random": { none: "A glucose taken without fasting depends on the last meal; no interval applies to it." },
  hba1c: from("ads-hba1c", [both(undefined, 6.0, { highOpen: true })], {
    above: {
      source: "ads-hba1c",
      steps: [step("mild", "Higher risk of developing diabetes: 6.0 to 6.4% (42 to 47 mmol/mol)"), step("out", "Diabetes: 6.5% (48 mmol/mol) or more", at(6.5))],
    },
  }),

  // Others with a guideline of their own.
  "vitamin-d": from("nowson-vitd", [both(50, 125)], {
    lines: { above: "iom-vitd" },
    below: {
      source: "nowson-vitd",
      steps: [
        step("mild", "Mild deficiency: 30 to 49"),
        step("out", "Moderate deficiency: 12.5 to 29", at(30), true),
        step("far", "Severe deficiency: under 12.5", at(12.5), true),
      ],
    },
  }),
  lead: from("nhmrc-lead", [both(undefined, 0.24)]),
  "hbsab-level": from("imm-handbook", [both(10, undefined)]),
  "bp-systolic": from("heart-foundation", [both(undefined, 130, { highOpen: true })], {
    above: {
      source: "heart-foundation",
      steps: [
        step("mild", "High-normal: 130 to 139"),
        step("out", "Grade 1 (mild) hypertension: 140 to 159", at(140)),
        step("far", "Grade 2 (moderate, 160 to 179) and grade 3 (severe, 180 or more) hypertension", at(160)),
      ],
    },
  }),
  "bp-diastolic": from("heart-foundation", [both(undefined, 85, { highOpen: true })], {
    above: {
      source: "heart-foundation",
      steps: [
        step("mild", "High-normal: 85 to 89"),
        step("out", "Grade 1 (mild) hypertension: 90 to 99", at(90)),
        step("far", "Grade 2 (moderate, 100 to 109) and grade 3 (severe, 110 or more) hypertension", at(100)),
      ],
    },
  }),
  bmi: from("who-bmi", [both(18.5, 25, { highOpen: true })], {
    above: {
      source: "who-bmi",
      steps: [step("mild", "Pre-obese: 25.00 to 29.99"), step("out", "Obese class I: 30.00 to 34.99", at(30)), step("far", "Obese classes II (35.00 to 39.99) and III (40.00 or more)", at(35))],
    },
    below: {
      source: "who-bmi",
      steps: [
        step("mild", "Mild thinness: 17.00 to 18.49"),
        step("out", "Moderate thinness: 16.00 to 16.99", at(17), true),
        step("far", "Severe thinness: under 16.00", at(16), true),
      ],
    },
  }),
  almi: from("ewgsop2", [m(7.0, undefined), f(5.5, undefined)]),
  // ISCD reads Z-scores for men under 50 (and women before menopause, which the archive does not know); from 50 a man's
  // bone density is read by T-score, which the archive does not keep, so it is not judged.
  ...Object.fromEntries(
    ["bmd-z-spine", "bmd-z-neck-left", "bmd-z-neck-right", "bmd-z-hip-left", "bmd-z-hip-right", "bmd-z-total"].map((key) => [
      key,
      from("iscd", [m(-2.0, undefined, { lowOpen: true, ages: [18, 50] })], { note: "For men under 50; from 50 the T-score is read instead." }),
    ]),
  ),
  "ige-cat": immunocap(),
  "ige-dust-mite": immunocap(),
  "ige-rye-grass": immunocap(),
  "ige-alternaria": immunocap(),

  // Screens and cultures, read by their words.
  hbsab: from("words", []),
  hbsag: from("words", []),
  "hcv-ab": from("words", []),
  hiv: from("words", []),
  syphilis: from("words", []),
  chlamydia: from("words", []),
  gonorrhoea: from("words", []),
  "urine-mycoplasma": from("words", []),
  "swab-culture": from("words", []),

  // No guideline or harmonised interval: a lab's printed interval, where one is chosen (LAB_TESTS).
  ...Object.fromEntries(Object.keys(LAB_TESTS).map((key) => [key, { none: NO_LAB_INTERVAL }])),

  // No defensible authority.
  weight: { none: "A weight is judged with height; see body mass index." },
  "body-fat": { none: "No Australian guideline or consensus sets a healthy body-fat percentage." },
  "lean-mass": { none: "Lean mass is judged for height; see limb lean mass for height." },
  "vat-mass": { none: "No guideline sets a limit for the scanner's estimate of visceral fat." },
  "android-gynoid": { none: "No guideline sets a limit for the android to gynoid fat ratio." },
  "haemolysis-index": { none: "A measure of the blood sample's quality, not of you." },
};

/**
 * An allergen's specific IgE: sensitised from ImmunoCAP's current cut-off. Its classes (0.35, 0.70, 3.50 and on) are
 * printed by labs but were not found in any of Thermo Fisher's own documents, so they do not grade it: past the cut-off
 * it is out, nothing finer.
 */
function immunocap(): Judged {
  return from("immunocap", [both(undefined, 0.1, { highOpen: true })]);
}

/** The band of `authority` for a person of `sex` aged `age` (whole years), or null when none covers them. */
export function bandFor(authority: Authority, sex: Sex, age: number): Band | null {
  if ("none" in authority) return null;
  return authority.bands.find((band) => (band.sex === undefined || band.sex === sex) && (band.ages === undefined || (age >= band.ages[0] && (band.ages[1] === null || age < band.ages[1])))) ?? null;
}

/** The source of `authority`'s line on one side: its own, unless another sets that side (Judged.lines). */
export function lineSource(authority: Judged, side: "above" | "below"): SourceKey {
  return authority.lines?.[side] ?? authority.source;
}

/**
 * The grades past `authority`'s line on one side: a source's; else, with the dashboard's own rule on (PERCENT_RULE, off),
 * that rule's; else none, and a result past the line is out by the line's own source.
 */
export function gradingFor(authority: Judged, side: "above" | "below", percentRule = PERCENT_RULE): Grading | null {
  return authority[side] ?? (percentRule ? PERCENT : null);
}
