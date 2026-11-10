// Made-up Polar workouts, in the two shapes the archive reads, and a made-up AccessLink to fetch them from. Every value
// is invented: the heart rates are a curve, the routes loops around 0°, 0° (in the sea, nowhere anyone runs) or, for
// the testing data's recent runs, around the middle of the testing settings' region (SAMPLE_CITY, shifted by the seed),
// so a testing folder with that region's map shows routes on it; the pace a wave, and the
// runs no one's. For the polar connector's tests (../connectors/polar.test.ts), the Fitness page's and the
// Health tab's, and the testing data (module.ts's fixtures), whose Fitness page shows an activity from every source (writeMadeUpPolar).
//
//   madeUpExercise  an exercise as AccessLink gives it (GET /v3/exercises/{id}?samples=true&zones=true&route=true)
//   madeUpSession   a training session as Polar's account export holds it (training-session_*.json)
//   madeUpFit       the smallest FIT file there is: a header, no records, its checksums right
//   fakeAccessLink  a made-up AccessLink (and Polar's authorisation and token endpoints) on 127.0.0.1, recording what it is asked

import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dayKey, EXPORTS_FOLDER, runPromise, transaction, wallClock, type Run } from "../../../sdk/server.ts";
import { workoutEvents, type PolarSession } from "../connectors/polar-export/session.ts";
import { copiedEvents, COPIES } from "../connectors/polar/read.ts";
import type { PolarExercise } from "../connectors/polar/exercise.ts";
import { applyWorkouts } from "../server/apply.ts";

/** A made-up run: its local start (YYYY-MM-DDTHH:MM:SS) and offset from UTC in minutes, how long and how far, and what recorded it. */
export interface MadeUpRun {
  start: string;
  offset: number;
  minutes: number;
  km: number;
  /** What recorded it; the Flow app unless said. */
  device?: string;
  /** Polar's sport for it; RUNNING unless said. */
  sport?: string;
  /** Moves the made-up heart-rate curve, so no two runs are alike. */
  seed: number;
  /** What its route loops around; 0°, 0° unless said. */
  around?: { latitude: number; longitude: number };
}

/** The middle of the made-up box testing-data/settings.json calls sample-city. */
export const SAMPLE_CITY = { latitude: 50.5, longitude: 10.5 };

/**
 * The area the recent runs (recentRuns) loop in, [west, south, east, north]: each loops within about 0.045° of
 * SAMPLE_CITY, so this box, a little wider, holds every one. The static demo's build cuts its map and terrain from the
 * open builds for this area alone (server/demoRecord.ts).
 */
export const RUNS_AREA = [SAMPLE_CITY.longitude - 0.06, SAMPLE_CITY.latitude - 0.05, SAMPLE_CITY.longitude + 0.06, SAMPLE_CITY.latitude + 0.05] as const;

/** The made-up recorder a chest strap is paired with. */
export const FLOW_APP = "Polar Flow app";

/** Made-up heart-rate zones, as exercise.json's heartRateZones sets them (where zones 2 to 5 start), unlike the made-up Polar zones below. */
export const MADE_UP_ZONES = { source: "a made-up clinic, May 2026", zone2: 112, zone3: 130, zone4: 148, zone5: 160 };

/** A made-up heart rate, second by second: a warm-up, a steady stretch with a wave in it, and a hard finish. */
export function heartRateCurve(seconds: number, seed: number): number[] {
  return Array.from({ length: seconds }, (_, i) => {
    const warm = Math.min(1, i / 300);
    const finish = i > seconds - 240 ? (i - (seconds - 240)) / 240 : 0;
    return Math.round(100 + 45 * warm + 6 * Math.sin((i + seed * 97) / 50) + 22 * finish + (seed % 5));
  });
}

/** A made-up route, a point a second: a loop around `around` (else 0°, 0°), its wobble and lean by the seed, so no two look alike. */
function circle(seconds: number, seed: number, around = { latitude: 0, longitude: 0 }): Array<{ latitude: number; longitude: number; elapsed: number }> {
  return Array.from({ length: seconds }, (_, i) => {
    const a = (i / seconds) * 2 * Math.PI;
    const r = 1 + 0.28 * Math.sin(3 * a + seed) + 0.12 * Math.cos((5 + (seed % 3)) * a);
    return {
      latitude: Math.round((around.latitude + 0.01 * r * Math.sin(a + seed) * (1 + 0.15 * (seed % 4))) * 1e7) / 1e7,
      longitude: Math.round((around.longitude + 0.01 * r * Math.cos(a + seed)) * 1e7) / 1e7,
      elapsed: i * 1000,
    };
  });
}

/** Made-up distance so far, second by second, to `km` at the end: the pace a slow wave, never stopping. */
export function distanceCurve(seconds: number, km: number, seed: number): number[] {
  const waves = 2 + (seed % 3);
  return Array.from({ length: seconds }, (_, i) => {
    const u = i / seconds;
    return Math.round(km * 1000 * (u + (0.07 * Math.sin(2 * Math.PI * waves * u)) / (2 * Math.PI * waves)));
  });
}

/** The run's heart-rate zones, by made-up limits, with the seconds spent in each. */
function zonesOf(hr: number[]): Array<{ lower: number; upper: number; seconds: number }> {
  const limits = [[95, 113], [114, 132], [133, 151], [152, 170], [171, 190]];
  return limits.map(([lower, upper]) => ({ lower, upper, seconds: hr.filter((v) => v >= lower && v <= upper).length }));
}

/** An exercise as AccessLink gives it, with its samples, zones and route, its keys spelt as Polar's copies spell them (recording_rate, not its documentation's recording-rate). */
export function madeUpExercise(id: string, run: MadeUpRun): PolarExercise & Record<string, unknown> {
  const seconds = run.minutes * 60;
  const hr = heartRateCurve(seconds, run.seed);
  return {
    id,
    upload_time: `${run.start}.000Z`,
    polar_user: "https://www.polaraccesslink.com/v3/users/1",
    device: run.device ?? FLOW_APP,
    device_id: "MADEUP01",
    start_time: run.start,
    start_time_utc_offset: run.offset,
    duration: `PT${Math.floor(run.minutes / 60) > 0 ? `${Math.floor(run.minutes / 60)}H` : ""}${run.minutes % 60}M`,
    calories: 400 + run.seed,
    distance: run.km * 1000,
    heart_rate: { average: Math.round(hr.reduce((a, b) => a + b, 0) / hr.length), maximum: Math.max(...hr) },
    sport: run.sport ?? "RUNNING",
    has_route: true,
    detailed_sport_info: run.sport ?? "RUNNING",
    heart_rate_zones: zonesOf(hr).map((z, i) => ({ index: i + 1, lower_limit: z.lower, upper_limit: z.upper, in_zone: `PT${z.seconds}S` })),
    samples: [
      { recording_rate: 1, sample_type: 0, data: hr.join(",") },
      { recording_rate: 1, sample_type: 1, data: hr.map((_, i) => (i === 0 ? "null" : (run.km * 3600 / seconds).toFixed(1))).join(",") },
      { recording_rate: 1, sample_type: 10, data: distanceCurve(seconds, run.km, run.seed).join(",") },
    ],
    route: circle(seconds, run.seed, run.around).map((p) => ({ latitude: p.latitude, longitude: p.longitude, time: `PT${p.elapsed / 1000}S`, satellites: 9, fix: 3 })),
  };
}

/** A training session as Polar's account export holds it, its one exercise numbered `exerciseId`. */
export function madeUpSession(exerciseId: string, run: MadeUpRun): PolarSession & Record<string, unknown> {
  const seconds = run.minutes * 60;
  const hr = heartRateCurve(seconds, run.seed);
  const stop = new Date(Date.parse(`${run.start}Z`) + seconds * 1000).toISOString().slice(0, 19);
  const exercise = {
    identifier: { id: exerciseId },
    created: `${run.start}.000`,
    modified: `${run.start}.000`,
    startTime: run.start,
    stopTime: stop,
    durationMillis: seconds * 1000,
    distanceMeters: run.km * 1000,
    calories: 400 + run.seed,
    timezoneOffsetMinutes: run.offset,
    sport: { id: "1" },
    laps: {},
    statistics: {
      statistics: [
        { type: "STATISTICS_TYPE_HEART_RATE", min: Math.min(...hr), avg: Math.round(hr.reduce((a, b) => a + b, 0) / hr.length), max: Math.max(...hr) },
        { type: "STATISTICS_TYPE_SPEED", min: 0, avg: 10, max: 14 },
      ],
    },
    zones: [
      { type: "ZONE_TYPE_HEART_RATE", zones: zonesOf(hr).map((z) => ({ lowerLimit: z.lower, higherLimit: z.upper, ...(z.seconds > 0 ? { inZone: z.seconds * 1000 } : {}) })) },
      { type: "ZONE_TYPE_SPEED", zones: [] },
    ],
    samples: {
      samples: [
        { type: "DISTANCE", intervalMillis: 1000, values: distanceCurve(seconds, run.km, run.seed) },
        { type: "SPEED", intervalMillis: 1000, values: hr.map((_, i) => (i === 0 ? "NaN" : 10)) },
        { type: "HEART_RATE", intervalMillis: 1000, values: hr },
      ],
    },
    routes: { route: { startTime: `${run.start}.000`, wayPoints: circle(seconds, run.seed, run.around).map((p) => ({ longitude: p.longitude, latitude: p.latitude, elapsedMillis: p.elapsed })) } },
  };
  return {
    identifier: { id: `0a000000-0000-4000-8000-${exerciseId.padStart(12, "0")}` },
    created: `${run.start}.000`,
    startTime: run.start,
    stopTime: stop,
    // The captain's own words and profile are in a real session; these are made up, and nothing reads them.
    note: "made-up note",
    durationMillis: seconds * 1000,
    distanceMeters: run.km * 1000,
    hrAvg: exercise.statistics.statistics[0].avg,
    hrMax: exercise.statistics.statistics[0].max,
    timezoneOffsetMinutes: run.offset,
    physicalInformation: { sex: "MALE", weightKg: 70, heightCm: 175, restingHeartRate: 60 },
    application: { name: "Polar Flow" },
    sport: { id: "1" },
    product: { modelName: run.device ?? FLOW_APP },
    exercises: [exercise],
  };
}

/** FIT's checksum (the FIT SDK's CRC-16). */
function fitCrc(bytes: Uint8Array): number {
  const table = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
  let crc = 0;
  for (const byte of bytes) {
    for (const nibble of [byte & 0xf, (byte >> 4) & 0xf]) {
      const tmp = table[crc & 0xf];
      crc = ((crc >> 4) & 0x0fff) ^ tmp ^ table[nibble];
    }
  }
  return crc;
}

/** The smallest FIT file: a 14-byte header (no records) and the file's checksum. */
export function madeUpFit(): Uint8Array {
  const header = Buffer.alloc(14);
  header[0] = 14;
  header[1] = 0x20;
  header.writeUInt16LE(2132, 2);
  header.writeUInt32LE(0, 4);
  header.write(".FIT", 8, "latin1");
  header.writeUInt16LE(fitCrc(header.subarray(0, 12)), 12);
  const file = Buffer.alloc(16);
  header.copy(file);
  file.writeUInt16LE(fitCrc(header), 14);
  return file;
}

/** One request the made-up AccessLink was asked: what, and whether it carried the token it takes. */
export interface Asked {
  method: string;
  path: string;
  authorized: boolean;
  body?: string;
}

/**
 * A made-up AccessLink, with Polar's authorisation page and token endpoint, on 127.0.0.1. It takes `token` (a request
 * with another is answered 401, as is every one while `refuse` is set; a login gives it), lists `exercises`, gives each with its samples
 * and its FIT file (none for an id in `noFit`), and grants a login: its authorisation page sends the browser back to
 * the redirect URI with `code` and the state it was given; its token endpoint takes the client `client` and gives
 * `token`, for the user `userId`; it registers a member once (then 409).
 */
export async function fakeAccessLink(options: {
  token: string;
  exercises: Array<PolarExercise & Record<string, unknown>>;
  noFit?: string[];
  client?: { id: string; secret: string };
  code?: string;
  userId?: number;
}): Promise<{ url: string; asked: Asked[]; refuse: boolean; token: string; registered: string[]; close: () => Promise<void> }> {
  const asked: Asked[] = [];
  const registered: string[] = [];
  const state = { refuse: false, token: options.token };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const authorized = !state.refuse && req.headers.authorization === `Bearer ${state.token}`;
      asked.push({ method: req.method ?? "GET", path: `${url.pathname}${url.search}`, authorized, ...(body ? { body } : {}) });
      const json = (status: number, value: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
      if (url.pathname === "/oauth2/authorization") {
        const back = new URL(url.searchParams.get("redirect_uri")!);
        back.search = new URLSearchParams({ code: options.code ?? "made-up-code", state: url.searchParams.get("state") ?? "" }).toString();
        return void res.writeHead(302, { Location: back.toString() }).end();
      }
      if (url.pathname === "/v2/oauth2/token") {
        const client = options.client ?? { id: "made-up-client", secret: "made-up-secret" };
        const basic = `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`;
        const form = new URLSearchParams(body);
        if (req.headers.authorization !== basic) return json(401, { error: "invalid_client" });
        if (form.get("grant_type") !== "authorization_code" || form.get("code") !== (options.code ?? "made-up-code")) return json(400, { error: "invalid_grant" });
        return json(200, { access_token: state.token, token_type: "bearer", expires_in: 31535999, x_user_id: options.userId ?? 12345678 });
      }
      if (!authorized) return json(401, { error: "unauthorized" });
      if (req.method === "POST" && url.pathname === "/v3/users") {
        const member = (JSON.parse(body) as { "member-id": string })["member-id"];
        if (registered.includes(member)) return json(409, { error: "already registered" });
        registered.push(member);
        return json(200, { "polar-user-id": options.userId ?? 12345678, "member-id": member });
      }
      if (url.pathname === "/v3/exercises") {
        if (options.exercises.length === 0) return void res.writeHead(204).end();
        return json(200, options.exercises.map(({ samples: _s, route: _r, heart_rate_zones: _z, ...summary }) => summary));
      }
      const one = /^\/v3\/exercises\/([^/]+)(\/fit)?$/.exec(url.pathname);
      const exercise = one && options.exercises.find((e) => e.id === decodeURIComponent(one[1]));
      if (!one || !exercise) return json(404, { error: "not found" });
      if (one[2]) {
        if (options.noFit?.includes(exercise.id)) return json(404, { error: "no FIT" });
        return void res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(madeUpFit());
      }
      return json(200, exercise);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const fake = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
    registered,
    get refuse() {
      return state.refuse;
    },
    set refuse(value: boolean) {
      state.refuse = value;
    },
    get token() {
      return state.token;
    },
    set token(value: string) {
      state.token = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  return fake;
}

/**
 * Made-up runs transcribed by hand from Polar's sharing pages (the SDK's Run, which the health module's by-hand.json
 * keeps and offers the Fitness page as RunsByHand), for the Fitness page's tests: the first is also TESTING_RUNS.may,
 * a second copy of that activity; the third a watch's, whose heart rate is never trusted. The health module's made-up
 * by-hand.json (modules/health/fixtures/health.ts) holds the same three, so the testing data's Fitness page shows an
 * activity from every source.
 */
export const RUNS_BY_HAND: readonly Run[] = [
  {
    start: "2026-05-20T07:15", sport: "Running", device: "Polar H10", trusted: true, duration: "41:02", distanceMi: 4.1, avgHr: 152, maxHr: 181, minHr: 104,
    hrMaxSetting: 181,
    zones: [{ zone: 5, share: 22, time: "9:01", from: 162 }, { zone: 4, share: 48, time: "19:42", from: 145 }, { zone: 3, share: 20, from: 127 }, { zone: 2, share: 7, from: 109 }, { zone: 1, share: 3, from: 91 }],
    source: "https://example.com/shared/run-one",
  },
  {
    start: "2026-06-03T18:40", sport: "Running", device: "Polar H10", trusted: true, duration: "32:45", distanceMi: 3.05, avgHr: 148, maxHr: 172, minHr: 110,
    zones: [{ zone: 5, share: 10 }, { zone: 4, share: 45 }, { zone: 3, share: 30 }, { zone: 2, share: 12 }, { zone: 1, share: 3 }],
    source: "https://example.com/shared/run-two",
  },
  {
    start: "2026-06-05T06:30", sport: "Running", device: "Wrist watch", trusted: false, duration: "25:10", distanceMi: 2.4, avgHr: 160, maxHr: 196, minHr: 95,
    source: "https://example.com/shared/run-watch",
  },
];

/** The testing data's Polar runs: what each source has, made up (see writeMadeUpPolar). */
export const TESTING_RUNS = {
  /** Also by hand (by-hand.json's first trusted run), and in the export. */
  may: { start: "2026-05-20T07:15:00", offset: 600, minutes: 41, km: 6.6, seed: 1 },
  /** In the export and through AccessLink. */
  october: { start: "2026-10-14T06:50:00", offset: 660, minutes: 35, km: 5.8, seed: 2 },
  /** Through AccessLink alone. */
  latest: { start: "2026-10-15T17:30:00", offset: 660, minutes: 28, km: 4.9, seed: 3 },
  /** A watch's, whose heart rate is never trusted. */
  watch: { start: "2026-10-10T07:00:00", offset: 660, minutes: 30, km: 5, seed: 4, device: "Sample watch" },
} satisfies Record<string, MadeUpRun>;

/**
 * The testing data's recent workouts, through AccessLink, for its Fitness page's feed and weekly summary: runs, rides
 * and a walk over the five weeks to `now`, days before it, at Melbourne times no other made-up run starts near, each
 * looping a few kilometres from SAMPLE_CITY (by its seed), within RUNS_AREA, so a folder with sample-city's map draws them on it.
 */
export function recentRuns(now: number): Record<string, MadeUpRun> {
  const plan: Array<[number, string, string, number, number]> = [
    [1, "06:41", "RUNNING", 32, 5.4], [2, "17:52", "CYCLING", 48, 19.6], [4, "07:26", "RUNNING", 45, 7.8], [6, "12:20", "WALKING", 35, 2.9],
    [9, "06:33", "RUNNING", 28, 4.6], [12, "18:10", "CYCLING", 62, 26.2], [16, "07:38", "RUNNING", 52, 9.1], [20, "06:22", "RUNNING", 30, 5],
    [27, "17:44", "CYCLING", 40, 15.3], [34, "07:44", "RUNNING", 38, 6.4],
  ];
  return Object.fromEntries(
    plan.map(([daysAgo, time, sport, minutes, km], i) => {
      const day = dayKey(now - daysAgo * 86_400_000);
      const offset = Math.round((Date.parse(`${day}T${time}:00Z`) - wallClock(day, time)) / 60_000);
      const around = { latitude: SAMPLE_CITY.latitude + 0.02 * Math.sin(i * 2.4), longitude: SAMPLE_CITY.longitude + 0.03 * Math.cos(i * 2.4) };
      return [`MadeUpRecent${i}`, { start: `${day}T${time}:00`, offset, minutes, km, seed: 11 + i, sport, around }];
    }),
  );
}

/** The export's folder in the testing data, from the archive's folder. */
export const TESTING_EXPORT = join(EXPORTS_FOLDER, "polar", "2026-10-16");

/**
 * Puts made-up Polar runs in a testing archive's folder, as the connectors would: AccessLink's copies in
 * platform-exports/polar/accesslink/, an account export in platform-exports/polar/2026-10-16/, the connector's
 * settings (its heart rate trusted, switched off: a testing folder has no token), and their workout events in the
 * module's index on `db`, as an import of each connector's (the host's record of it too); with `recent` (recentRuns),
 * more through AccessLink. With the health module's runs by hand (modules/health/fixtures/health.ts), the Fitness page
 * then has an activity from each source. The calendar is not pushed: the caller rebuilds it (the testing data), or
 * pushes the rows itself (a test).
 */
export async function writeMadeUpPolar(db: DatabaseSync, dataDir: string, { recent = {} }: { recent?: Record<string, MadeUpRun> } = {}): Promise<void> {
  const copies = join(dataDir, EXPORTS_FOLDER, COPIES);
  await mkdir(copies, { recursive: true });
  const api = { "MadeUp2Oct": TESTING_RUNS.october, "MadeUp3Oct": TESTING_RUNS.latest, "MadeUp4Wch": TESTING_RUNS.watch, ...recent };
  for (const [id, run] of Object.entries(api)) {
    await writeFile(join(copies, `${id}.json`), JSON.stringify(madeUpExercise(id, run)));
    await writeFile(join(copies, `${id}.fit`), madeUpFit());
  }
  const exported = join(dataDir, TESTING_EXPORT);
  await mkdir(exported, { recursive: true });
  const sessions = [["7000000001", TESTING_RUNS.may], ["7000000002", TESTING_RUNS.october]] as const;
  const files = [];
  for (const [id, run] of sessions) {
    const file = join(exported, `training-session_${run.start.replace(/:/g, "-")}_${id}.json`);
    const text = JSON.stringify(madeUpSession(id, run));
    await writeFile(file, text);
    files.push({ file, session: JSON.parse(text) as PolarSession, bytes: Buffer.byteLength(text) });
  }
  await mkdir(join(dataDir, "connectors"), { recursive: true });
  await writeFile(
    join(dataDir, "connectors", "polar.json"),
    `${JSON.stringify({ enabled: false, memberId: "life-archive-madeup1", trustedHeartRate: [{ device: FLOW_APP, sensor: "Polar H10" }], pollEveryHours: 3 }, null, 2)}\n`,
  );
  const { events } = await runPromise(copiedEvents(copies));
  const fromExport = files.flatMap(({ file, session, bytes }) => workoutEvents(session, file, bytes));
  transaction(db, () => {
    for (const [connector, list] of [["polar", events], ["polar-export", fromExport]] as const) {
      const kind = connector === "polar" ? "live" : "export";
      const source = Number(db
        .prepare("INSERT INTO source (platform, connector, kind, label, started_at, finished_at, status) VALUES ('polar', ?, ?, 'testing data', ?, ?, 'ok')")
        .run(connector, kind, Date.now(), Date.now()).lastInsertRowid);
      const { counts } = applyWorkouts(list, db, { id: source, platform: "polar", kind, seenAt: Date.now(), folder: dataDir });
      // The run's counts, as the host records them: a live run's name no events, as the rows taken over from the archive do not.
      db.prepare("UPDATE source SET counts_json = ? WHERE id = ?").run(JSON.stringify(kind === "live" ? { ...counts, events: {} } : counts), source);
    }
  });
}
