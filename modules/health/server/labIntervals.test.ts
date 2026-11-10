// The labs' printed intervals, on made-up labs only (../fixtures/health.ts's MADE_UP_LABS): the table names no lab of
// its own, so without health/lab-intervals.json the tests no guideline covers are not judged and say why; with it, each
// is judged by its lab's interval, with CTCAE's grades past it where CTCAE grades the test; the file is checked as it
// is read, and the route reads it.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MADE_UP_LABS, madeUpByHand } from "../fixtures/health.ts";
import { healthAnswer } from "./judge.ts";
import { accountsWith, labIntervalsProblem, rangesWith, readLabIntervals, sourcesWith, type LabInterval, type LabIntervalsFile } from "./labIntervals.ts";
import { LAB_TESTS, NO_LAB_INTERVAL, RANGES, SOURCES, type Judged } from "./ranges.ts";
import { SOURCE_ACCOUNTS } from "./rangeAccounts.ts";
import health from "../module.ts";
import { healthDir, LAB_INTERVALS_FILE } from "./store.ts";

const lab = (more: Partial<LabInterval> = {}): LabInterval => ({ key: "made-up-2020", lab: "Sample Pathology", year: 2020, reports: "its report of June 2020", sex: "male", tests: { iron: { low: 5, high: 30 } }, ...more });
const problem = (...labs: LabInterval[]) => labIntervalsProblem({ version: 1, labs });

describe("the table without a lab of its own", () => {
  it("names no lab: every source it names is a guideline, a consensus, a screen's words or a grading", () => {
    for (const [key, account] of Object.entries(SOURCE_ACCOUNTS)) expect(account.kind, key).not.toBe("lab-interval");
    expect(Object.keys(SOURCES).sort()).toEqual(Object.keys(SOURCE_ACCOUNTS).sort());
  });

  it("does not judge a test no guideline covers, and says where a lab's interval would go", () => {
    for (const key of Object.keys(LAB_TESTS)) expect(RANGES[key], key).toEqual({ none: NO_LAB_INTERVAL });
    expect(NO_LAB_INTERVAL).toMatch(/lab-intervals\.json/);
    const answer = healthAnswer({ byHand: madeUpByHand(), imported: null, labs: [], today: "2026-10-16", peak: null, exercise: false });
    expect(answer.tests.length).toBeGreaterThan(0);
    for (const test of answer.tests.filter((t) => t.key in LAB_TESTS)) expect(test).toMatchObject({ status: "unjudged", authority: null, noAuthority: NO_LAB_INTERVAL });
  });
});

describe("a lab's printed intervals", () => {
  it("judge each test they are chosen for, by the lab's key, for the sex they were printed for, with CTCAE's grades kept", () => {
    const ranges = rangesWith(MADE_UP_LABS);
    expect(ranges.transferrin).toEqual({ source: "spl-2024", bands: [{ sex: "male", ages: [18, null], low: 2.0, high: 3.2 }] });
    expect((ranges.haemoglobin as Judged).above).toBe(LAB_TESTS.haemoglobin.above);
    expect((ranges.esr as Judged).source).toBe("sample-lab-2019");
    expect(rangesWith([lab({ sex: "female" })]).iron).toMatchObject({ bands: [{ sex: "female" }] });
    // Every test no guideline covers has a made-up lab's interval, so the testing data judges them all.
    expect(Object.keys(LAB_TESTS).filter((key) => "none" in ranges[key])).toEqual([]);
  });

  it("are a source of one star each, between the table's primary sources and those that grade past a line", () => {
    const keys = Object.keys(sourcesWith(MADE_UP_LABS));
    expect(keys.indexOf("spl-2024")).toBe(keys.indexOf("words") + 1);
    expect(keys.indexOf("sample-lab-2019")).toBe(keys.indexOf("iom-vitd") - 1);
    expect(sourcesWith(MADE_UP_LABS)["spl-2024"]).toMatchObject({
      name: "Sample Pathology's interval (2024)",
      citation: "Sample Pathology's printed reference interval for an adult man, as on its reports of July 2024: used, unchanged, for a test no guideline or harmonised interval covers.",
      url: null,
      stars: 1,
    });
    expect(sourcesWith(MADE_UP_LABS)["sample-lab-2019"].citation).toMatch(/covers that Sample Lab was the last to run\.$/);
  });

  it("tell how each was taken, for the sex they were printed for", () => {
    const accounts = accountsWith([...MADE_UP_LABS, lab({ sex: "female", tests: { zinc: { low: 9, high: 19 } } })]);
    expect(accounts["spl-2024"]).toMatchObject({ kind: "lab-interval", publishes: expect.stringMatching(/for an adult man on its reports of July 2024\.$/) });
    expect(accounts["sample-lab-2019"].publishes).toMatch(/on its report of May 2019, the last to run this test\.$/);
    expect(accounts["made-up-2020"].uncovered).toMatch(/it is for an adult woman, and is not judged for a man/);
  });

  it("are checked as they are read: each lab named once by a key of its own, each test of LAB_TESTS taking one lab's interval", () => {
    expect(labIntervalsProblem({ version: 1, labs: MADE_UP_LABS })).toBeNull();
    expect(labIntervalsProblem({ version: 2, labs: [] } as unknown as LabIntervalsFile)).toMatch(/version/);
    expect(problem(lab({ key: "Sample Lab" }))).toMatch(/lower-case letters/);
    expect(problem(lab({ key: "rcpa" }))).toMatch(/the table's own source/);
    expect(problem(lab(), lab({ tests: { zinc: { low: 9, high: 19 } } }))).toMatch(/named twice/);
    expect(problem(lab({ sex: "other" as "male" }))).toMatch(/sex is male or female/);
    expect(problem(lab({ reports: "" }))).toMatch(/reports names/);
    expect(problem(lab({ tests: {} }))).toMatch(/at least one test/);
    expect(problem(lab({ tests: { sodium: { low: 135, high: 145 } } }))).toMatch(/authority of its own/);
    expect(problem(lab({ tests: { "made-up-test": { low: 1 } } }))).toMatch(/not a test judged by a lab's interval/);
    expect(problem(lab(), lab({ key: "made-up-2021" }))).toMatch(/iron takes one lab's interval/);
    expect(problem(lab({ tests: { iron: {} } }))).toMatch(/gives a low or a high limit/);
    expect(problem(lab({ tests: { iron: { low: 30, high: 5 } } }))).toMatch(/low limit is under its high/);
  });
});

describe("health/lab-intervals.json", () => {
  let dataDir: string;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "health-labs-"));
    await mkdir(healthDir(dataDir), { recursive: true });
  });
  afterAll(() => rm(dataDir, { recursive: true, force: true }));

  it("is none when it is not there, the labs when it is, and an error naming the file and what is wrong otherwise", async () => {
    expect(await readLabIntervals(dataDir)).toEqual([]);
    const file = join(healthDir(dataDir), LAB_INTERVALS_FILE);
    await writeFile(file, JSON.stringify({ version: 1, labs: MADE_UP_LABS }));
    expect(await readLabIntervals(dataDir)).toEqual(MADE_UP_LABS);
    await writeFile(file, JSON.stringify({ version: 1, labs: [lab({ tests: { sodium: { low: 135 } } })] }));
    await expect(readLabIntervals(dataDir)).rejects.toThrow(/lab-intervals\.json: made-up-2020: sodium is not a test judged by a lab's interval/);
  });

  it("is read from health/ of the archive's folder while an archive keeps its records there still, and from modules/health/ once they are moved, whatever stray file is there before", async () => {
    const old = await mkdtemp(join(tmpdir(), "health-labs-old-"));
    try {
      expect(healthDir(old)).toBe(join(old, "modules", "health"));
      await mkdir(join(old, "health"));
      await writeFile(join(old, "health", LAB_INTERVALS_FILE), JSON.stringify({ version: 1, labs: MADE_UP_LABS }));
      expect(healthDir(old)).toBe(join(old, "health"));
      expect(await readLabIntervals(old)).toEqual(MADE_UP_LABS);
      await mkdir(join(old, "modules", "health"), { recursive: true });
      await writeFile(join(old, "modules", "health", ".DS_Store"), "made-up Finder bytes");
      expect(healthDir(old)).toBe(join(old, "health"));
      expect(await readLabIntervals(old)).toEqual(MADE_UP_LABS);
      await writeFile(join(old, "modules", "health", LAB_INTERVALS_FILE), JSON.stringify({ version: 1, labs: [] }));
      expect(await readLabIntervals(old)).toEqual([]);
      expect(health.moves).toEqual([{ from: "health", to: "." }]);
    } finally {
      await rm(old, { recursive: true, force: true });
    }
  });
});
