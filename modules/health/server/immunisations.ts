// What the immunisations protect against: each disease a record names by its everyday name beside the medical one
// ("Pertussis (whooping cough)"), and one row per disease for the Records tab's summary, with its latest dose and how
// long the Australian Immunisation Handbook says protection or a booster interval runs for adults. A combined vaccine's
// record is split into its diseases ("Diphtheria Tetanus Pertussis" is three); a vaccine whose printed diseases are
// none the lookup knows is read by its brand instead. A course the record holds too few doses of is shown as
// incomplete, until its next dose is due. A disease or vaccine the lookup does not know keeps its row, its interval
// left blank rather than guessed. The records themselves (by-hand.json) are never changed.
//
// Every disease cites its Handbook page, read on 2026-10-20 (the pages last updated on 30 September and 1 October
// 2026). Many intervals apply only to some adults (travellers, some workers, an age), and each row's words say so.

import { ageOn, IMMUNISATION_HANDBOOK, type DiseaseName, type ImmunisationRecord, type ProtectionRow, type ProtectionSpan } from "../wire.ts";
import type { Immunisation } from "./store.ts";

/** A disease's page in the Handbook. */
const page = (slug: string) => `${IMMUNISATION_HANDBOOK}contents/vaccine-preventable-diseases/${slug}`;

/** How protection runs from the latest dose, once any course is complete. */
type Lasts =
  /** Until a booster is due this many months on (or fewer from an age). */
  | { every: number; fromAge?: { age: number; every: number } }
  /** Without a booster: lifelong, or no booster set. */
  | { lasting: "lifelong" | "no booster" }
  /** The Handbook sets no one interval for adults (it turns on risk). */
  | { none: true };

interface Disease {
  /** The medical name, as the page shows it. */
  name: string;
  /** The everyday name, where it differs. */
  everyday?: string;
  /** Other names a record may print for it, lower case. */
  aka?: string[];
  /** Its Handbook page. */
  url: string;
  /** The Handbook's words for adults, shortened. */
  says: string;
  lasts: Lasts;
  /** A course of more than one dose: how many, and the months from each dose to the next. */
  course?: { doses: number; gaps: number[] };
}

export const DISEASES = {
  diphtheria: {
    name: "Diphtheria",
    url: page("diphtheria"),
    says: "A booster at 50; every 10 years for travel where health services are hard to reach (5 in some higher-risk areas).",
    lasts: { every: 120 },
  },
  tetanus: {
    name: "Tetanus",
    url: page("tetanus"),
    says: "A booster at 50 and 65 if the last dose was more than 10 years before; for travel where health services are hard to reach, after 10 years (5 for high-risk travel or a tetanus-prone wound).",
    lasts: { every: 120 },
  },
  pertussis: {
    name: "Pertussis",
    everyday: "whooping cough",
    aka: ["whooping cough"],
    url: page("pertussis-whooping-cough"),
    says: "Recommended at 50 and 65, in each pregnancy, and every 10 years for healthcare workers, early childhood educators and people in close contact with infants, as protection wanes.",
    lasts: { every: 120 },
  },
  polio: {
    name: "Poliomyelitis",
    everyday: "polio",
    aka: ["polio", "poliovirus"],
    url: page("poliomyelitis"),
    says: "Every 10 years for adults at higher risk of exposure: some healthcare and laboratory workers, and travel where polio is found.",
    lasts: { every: 120 },
  },
  influenza: {
    name: "Influenza",
    everyday: "flu",
    aka: ["flu", "influenza tetravalent", "influenza trivalent"],
    url: page("influenza-flu"),
    says: "Every year.",
    lasts: { every: 12 },
  },
  covid19: {
    name: "COVID-19",
    aka: ["covid", "sars-cov-2"],
    url: page("covid-19"),
    says: "One dose a year can be considered from 18 to 64, is recommended from 65 to 74, and two a year from 75.",
    lasts: { every: 12, fromAge: { age: 75, every: 6 } },
  },
  hepatitisA: {
    name: "Hepatitis A",
    aka: ["hep a"],
    url: page("hepatitis-a"),
    says: "Two doses at least 6 months apart; booster doses are not required after them.",
    lasts: { lasting: "no booster" },
    course: { doses: 2, gaps: [6] },
  },
  hepatitisB: {
    name: "Hepatitis B",
    aka: ["hep b"],
    url: page("hepatitis-b"),
    says: "Three doses, at 0, 1 and 6 months; a booster only for some people who are immunocompromised.",
    lasts: { lasting: "no booster" },
    course: { doses: 3, gaps: [1, 5] },
  },
  typhoid: {
    name: "Typhoid",
    aka: ["typhoid fever", "salmonella typhi"],
    url: page("typhoid-fever"),
    says: "With ongoing exposure, revaccination every 3 years after the injected vaccine (the oral one: 3 years after 3 doses, 5 after 4).",
    lasts: { every: 36 },
  },
  yellowFever: {
    name: "Yellow fever",
    url: page("yellow-fever"),
    says: "A single dose should give lifelong immunity in most healthy adults; some travellers need a booster after 10 years.",
    lasts: { lasting: "lifelong" },
  },
  measles: {
    name: "Measles",
    url: page("measles"),
    says: "Two doses at least 4 weeks apart are evidence of immunity; no booster is set.",
    lasts: { lasting: "no booster" },
    course: { doses: 2, gaps: [1] },
  },
  mumps: {
    name: "Mumps",
    url: page("mumps"),
    says: "Two doses at least 4 weeks apart are evidence of immunity; no booster is set.",
    lasts: { lasting: "no booster" },
    course: { doses: 2, gaps: [1] },
  },
  rubella: {
    name: "Rubella",
    everyday: "German measles",
    aka: ["german measles"],
    url: page("rubella"),
    says: "Two doses at least 4 weeks apart are evidence of immunity; no booster is set.",
    lasts: { lasting: "no booster" },
    course: { doses: 2, gaps: [1] },
  },
  varicella: {
    name: "Varicella",
    everyday: "chickenpox",
    aka: ["chickenpox", "chicken pox"],
    url: page("varicella-chickenpox"),
    says: "Two doses at least 4 weeks apart from 14 years of age; no booster is set.",
    lasts: { lasting: "no booster" },
    course: { doses: 2, gaps: [1] },
  },
  zoster: {
    name: "Herpes zoster",
    everyday: "shingles",
    aka: ["zoster", "shingles"],
    url: page("zoster-herpes-zoster"),
    says: "Two doses of Shingrix 2 to 6 months apart; no booster is recommended yet, and protection is good 10 years after both.",
    lasts: { lasting: "no booster" },
    course: { doses: 2, gaps: [2] },
  },
  pneumococcal: {
    name: "Pneumococcal disease",
    aka: ["pneumococcal", "pneumococcus"],
    url: page("pneumococcal-disease"),
    says: "One dose at 65, or earlier with a risk condition; the need for further doses has not yet been established.",
    lasts: { none: true },
  },
  meningococcal: {
    name: "Meningococcal disease",
    aka: ["meningococcal", "meningococcal acwy", "meningococcal b", "meningococcal c", "meningococcal a c w y"],
    url: page("meningococcal-disease"),
    says: "No booster after a primary course at standard risk; regular boosters for some medical conditions, travellers and laboratory workers.",
    lasts: { none: true },
  },
  japaneseEncephalitis: {
    name: "Japanese encephalitis",
    url: page("japanese-encephalitis"),
    says: "People at ongoing risk may need booster doses, depending on the vaccine and their age.",
    lasts: { none: true },
  },
  rabies: {
    name: "Rabies",
    aka: ["rabies and other lyssaviruses", "lyssavirus", "australian bat lyssavirus"],
    url: page("rabies-and-other-lyssaviruses"),
    says: "Boosters only with ongoing exposure, by the Handbook's schedule for that exposure.",
    lasts: { none: true },
  },
  cholera: {
    name: "Cholera",
    url: page("cholera"),
    says: "With an ongoing risk, a booster 6 months to 2 years after the primary course, by the vaccine.",
    lasts: { none: true },
  },
  hpv: {
    name: "Human papillomavirus",
    everyday: "HPV",
    aka: ["hpv", "human papillomavirus hpv"],
    url: page("human-papillomavirus-hpv"),
    says: "One dose from 9 to 25 years of age, three from 26; no booster is set.",
    lasts: { none: true },
  },
  rsv: {
    name: "Respiratory syncytial virus",
    everyday: "RSV",
    aka: ["rsv"],
    url: page("respiratory-syncytial-virus-rsv"),
    says: "A single dose for older adults; the need for further doses is not yet known.",
    lasts: { none: true },
  },
  hib: {
    name: "Haemophilus influenzae type b",
    everyday: "Hib",
    aka: ["hib"],
    url: page("haemophilus-influenzae-type-b-hib"),
    says: "Given in childhood; adults only with some medical conditions.",
    lasts: { none: true },
  },
  qFever: {
    name: "Q fever",
    url: page("q-fever"),
    says: "A single dose; booster doses are not recommended.",
    lasts: { lasting: "no booster" },
  },
} satisfies Record<string, Disease>;

export type DiseaseKey = keyof typeof DISEASES;

/** The diseases each vaccine brand protects against (lower case), for a record whose printed diseases the lookup does not know. */
export const VACCINES: Record<string, DiseaseKey[]> = {
  boostrix: ["diphtheria", "tetanus", "pertussis"],
  adacel: ["diphtheria", "tetanus", "pertussis"],
  "boostrix-ipv": ["diphtheria", "tetanus", "pertussis", "polio"],
  "adacel polio": ["diphtheria", "tetanus", "pertussis", "polio"],
  "adt booster": ["diphtheria", "tetanus"],
  ipol: ["polio"],
  havrix: ["hepatitisA"],
  "havrix 1440": ["hepatitisA"],
  vaqta: ["hepatitisA"],
  "engerix-b": ["hepatitisB"],
  "h-b-vax ii": ["hepatitisB"],
  twinrix: ["hepatitisA", "hepatitisB"],
  "typhim vi": ["typhoid"],
  vivotif: ["typhoid"],
  vivaxim: ["typhoid", "hepatitisA"],
  stamaril: ["yellowFever"],
  comirnaty: ["covid19"],
  spikevax: ["covid19"],
  nuvaxovid: ["covid19"],
  fluad: ["influenza"],
  "fluarix tetra": ["influenza"],
  afluria: ["influenza"],
  flucelvax: ["influenza"],
  vaxigrip: ["influenza"],
  influvac: ["influenza"],
  efluelda: ["influenza"],
  "m-m-r ii": ["measles", "mumps", "rubella"],
  priorix: ["measles", "mumps", "rubella"],
  varivax: ["varicella"],
  varilrix: ["varicella"],
  shingrix: ["zoster"],
  prevenar: ["pneumococcal"],
  vaxneuvance: ["pneumococcal"],
  capvaxive: ["pneumococcal"],
  pneumovax: ["pneumococcal"],
  nimenrix: ["meningococcal"],
  menquadfi: ["meningococcal"],
  menveo: ["meningococcal"],
  bexsero: ["meningococcal"],
  "gardasil 9": ["hpv"],
  imojev: ["japaneseEncephalitis"],
  jespect: ["japaneseEncephalitis"],
  rabipur: ["rabies"],
  verorab: ["rabies"],
  dukoral: ["cholera"],
  vaxchora: ["cholera"],
  arexvy: ["rsv"],
  abrysvo: ["rsv"],
  "q-vax": ["qFever"],
};

/** A disease a record names: one the lookup knows, by key, or one it does not, by the words printed. */
type Named = { key: DiseaseKey; printed: string } | { key: null; printed: string };

/** Lower case, with every separator a record may print between diseases (commas, "and", slashes, a hyphen between words) a space. */
const words = (text: string) =>
  text
    .replace(/(?<=\p{L})-(?=\p{L})/gu, " ")
    .replace(/[,;/&+()]/g, " ")
    .split(/\s+/)
    .filter((w) => w && w.toLowerCase() !== "and");

/** Each name the lookup knows, as words, longest first, with the disease it names. */
const NAMES: ReadonlyArray<{ words: string[]; key: DiseaseKey }> = (Object.entries(DISEASES) as Array<[DiseaseKey, Disease]>)
  .flatMap(([key, d]) => [d.name, ...(d.aka ?? [])].map((name) => ({ words: words(name.toLowerCase()), key })))
  .sort((a, b) => b.words.length - a.words.length);

/**
 * The diseases a printed "against" names, in its order: each longest name the lookup knows, and the words between them
 * that it does not as one unknown disease each ("Diphtheria Tetanus Pertussis" is three known; "Tetanus Exampleitis"
 * a known and an unknown). Each named once.
 */
export function diseasesIn(against: string): Named[] {
  const ws = words(against);
  const found: Named[] = [];
  let unknown: string[] = [];
  const flush = () => {
    if (unknown.length) found.push({ key: null, printed: unknown.join(" ") });
    unknown = [];
  };
  for (let i = 0; i < ws.length; ) {
    const hit = NAMES.find((n) => n.words.every((w, j) => ws[i + j]?.toLowerCase() === w));
    if (hit) {
      flush();
      found.push({ key: hit.key, printed: ws.slice(i, i + hit.words.length).join(" ") });
      i += hit.words.length;
    } else {
      unknown.push(ws[i]);
      i += 1;
    }
  }
  flush();
  return found.filter((n, i) => found.findIndex((m) => (m.key ?? m.printed.toLowerCase()) === (n.key ?? n.printed.toLowerCase())) === i);
}

/** A record's diseases: from its printed "against", or, where that names none the lookup knows, from its vaccine's brand. */
export function diseasesOf(record: Pick<Immunisation, "against" | "vaccine">): Named[] {
  const printed = diseasesIn(record.against);
  if (printed.some((n) => n.key)) return printed;
  const byBrand = VACCINES[record.vaccine.trim().toLowerCase()];
  return byBrand ? byBrand.map((key) => ({ key, printed: DISEASES[key].name })) : printed;
}

/**
 * A disease's name as the page shows it: as printed (a dose's own row), or by the lookup's name (the summary, where
 * "Hep A" and "Hepatitis A" are one row); with its everyday name where the lookup has one that differs.
 */
function nameOf(named: Named, as: "printed" | "lookup"): DiseaseName {
  if (!named.key) return { name: named.printed, everyday: null };
  const d: Disease = DISEASES[named.key];
  const name = as === "printed" ? named.printed : d.name;
  return { name, everyday: d.everyday && d.everyday.toLowerCase() !== name.toLowerCase() ? d.everyday : null };
}

/** `day` (YYYY-MM-DD) and `months` on, on the same day of the month or the month's last. */
export function monthsOn(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

/** "10 years", "6 months", "1 year 6 months". */
const monthsText = (months: number) => {
  const [y, m] = [Math.floor(months / 12), months % 12];
  return [y && `${y} year${y === 1 ? "" : "s"}`, m && `${m} month${m === 1 ? "" : "s"}`].filter(Boolean).join(" ");
};

/** How a known disease's protection runs from its latest dose, given how many doses the record holds and the age today. */
function spanOf(d: Disease, latest: string, doses: number, age: number): ProtectionSpan {
  if (d.course && doses < d.course.doses) {
    return { kind: "course", until: monthsOn(latest, d.course.gaps[doses - 1]), doses, of: d.course.doses };
  }
  const lasts = d.lasts;
  if ("every" in lasts) {
    const every = lasts.fromAge && age >= lasts.fromAge.age ? lasts.fromAge.every : lasts.every;
    return { kind: "until", until: monthsOn(latest, every), interval: monthsText(every) };
  }
  if ("lasting" in lasts) return { kind: "lasting", label: lasts.lasting };
  return null;
}

/** Where a span sorts: the soonest to end first, then those that last, then those with no interval. */
const spanOrder = (span: ProtectionSpan) => (span === null ? "3" : span.kind === "lasting" ? "2" : `1${span.until}`);

/**
 * One row per disease the records name: its latest dose, how many doses name it, how long protection runs from that
 * dose, and the Handbook's words and page (none for a disease the lookup does not know). For someone born `born`, on
 * `today`; the soonest to end first.
 */
export function protectionOf(records: readonly Immunisation[], born: string, today: string): ProtectionRow[] {
  const byDisease = new Map<string, { named: Named; doses: Immunisation[] }>();
  for (const record of records) {
    for (const named of diseasesOf(record)) {
      const id = named.key ?? named.printed.toLowerCase();
      const entry = byDisease.get(id) ?? { named, doses: [] };
      entry.doses.push(record);
      byDisease.set(id, entry);
    }
  }
  const age = ageOn(born, today);
  return [...byDisease.values()]
    .map(({ named, doses }): ProtectionRow => {
      const latest = doses.reduce((a, b) => (b.date > a.date ? b : a));
      const count = new Set(doses.map((r) => r.date)).size;
      const d: Disease | null = named.key ? DISEASES[named.key] : null;
      return {
        disease: nameOf(named, "lookup"),
        latest: { date: latest.date, vaccine: latest.vaccine },
        doses: count,
        span: d ? spanOf(d, latest.date, count, age) : null,
        handbook: d ? { says: d.says, url: d.url } : null,
      };
    })
    .sort((a, b) => spanOrder(a.span).localeCompare(spanOrder(b.span)) || a.disease.name.localeCompare(b.disease.name));
}

/** A record as the page shows it: with each disease it names, by its everyday name too. */
export function immunisationRecord(record: Immunisation): Omit<ImmunisationRecord, "transcribed"> {
  return { ...record, diseases: diseasesOf(record).map((n) => nameOf(n, "printed")) };
}
