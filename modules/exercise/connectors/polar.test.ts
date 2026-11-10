// The polar connector, on a made-up AccessLink only (../fixtures/polar.ts), never Polar: an exercise read for the index
// (its streams, never a heart rate or a coordinate), its copies kept once, the import into the module's index through
// the core's host and a keychain file of the test's own (again: nothing changes), a refused token as "reconnect needed"
// live and asking Polar nothing more until the Keychain holds another, and the login: the client asked for and kept,
// the browser's way back caught, the code exchanged, the captain registered once and the token kept.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll } from "vitest";
import type { WorkoutEvent } from "../../../sdk/connector.ts";
import { runPromise, type ModuleStore } from "../../../sdk/server.ts";
import { testingLifeArchive, validateEvent, type ConnectorEvent } from "../../../sdk/testing.ts";
import { fakeAccessLink, FLOW_APP, madeUpExercise, madeUpFit, type MadeUpRun } from "../fixtures/polar.ts";
import exercise from "../module.ts";
import { WorkoutIndex } from "../server/workoutIndex.ts";
import { accessLink, isFit } from "./polar/api.ts";
import { heartRateOf, isoSeconds, sportFamily, startInstant, workoutEvent } from "./polar/exercise.ts";
import { polarLogin } from "./polar/login.ts";
import { changesSince, copiedEvents, COPIES, fetchNew, polarConnector, TOKEN_LOOK_EVERY_MS } from "./polar/read.ts";
import { keychainSecrets, memorySecrets } from "./polar/secrets.ts";
import { POLL_EVERY_HOURS, readSettings } from "./polar/settings.ts";

const RUN: MadeUpRun = { start: "2026-10-14T06:50:00", offset: 660, minutes: 20, km: 3.5, seed: 7 };
const OTHER: MadeUpRun = { start: "2026-10-15T17:30:00", offset: 660, minutes: 15, km: 2.5, seed: 8 };
const TOKEN = "made-up-token-1";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-polar-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("an exercise from AccessLink", () => {
  const exercise = madeUpExercise("Ab12Cd", RUN);

  it("is a workout event of when, how far, what recorded it and its streams, never a heart rate or a coordinate", () => {
    const event = workoutEvent(exercise, { file: "/archive/platform-exports/polar/accesslink/Ab12Cd.json", fit: "/archive/x.fit", bytes: 1234 });
    expect(event).toEqual({
      kind: "workout", id: "Ab12Cd", sport: "RUNNING", family: "run", at: Date.parse("2026-10-13T19:50:00Z"), endAt: Date.parse("2026-10-13T20:10:00Z"),
      distanceMeters: 3500, recorder: FLOW_APP,
      // The speed's first sample is a sensor's gap ("null"), so one fewer.
      streams: { heartRate: { samples: 1200, everySeconds: 1 }, speed: { samples: 1199, everySeconds: 1 }, distance: { samples: 1200, everySeconds: 1 }, gps: { samples: 1200, everySeconds: 1 } },
      file: "/archive/platform-exports/polar/accesslink/Ab12Cd.json", rawFile: "/archive/x.fit", bytes: 1234,
    });
    expect(validateEvent(event)).toEqual({ event });
    expect(JSON.stringify(event)).not.toMatch(/latitude|longitude|heart_rate|average|maximum/);
    expect(validateEvent({ ...event, streams: { heartRate: { samples: 3, everySeconds: 1, values: [140] } } })).toEqual({ error: "(workout) streams.heartRate holds only samples and everySeconds" });
    expect(validateEvent({ ...event, raw: exercise })).toEqual({ error: "(workout) must carry no text or raw record, only where the content is" });
  });

  it("reads Polar's times, durations and sports", () => {
    expect(isoSeconds("PT1H2M3.5S")).toBe(3723.5);
    expect(isoSeconds("PT41M")).toBe(2460);
    expect(isoSeconds("41:02")).toBeNull();
    expect(startInstant({ start_time: "2026-06-03T18:40:00", start_time_utc_offset: 600 })).toBe(Date.parse("2026-06-03T08:40:00Z"));
    expect(["RUNNING", "TRAIL_RUNNING", "WALKING", "ROAD_BIKING", "POOL_SWIMMING", "YOGA"].map((s) => sportFamily(s))).toEqual(["run", "run", "walk", "ride", "swim", "other"]);
  });

  it("gives the Fitness page its heart rate: average, maximum, minimum and each zone's share", () => {
    const hr = heartRateOf(exercise)!;
    expect(hr.average).toBe(exercise.heart_rate!.average);
    expect(hr.maximum).toBe(exercise.heart_rate!.maximum);
    expect(hr.minimum).toBeLessThan(hr.average);
    expect(hr.zones.map((z) => z.zone)).toEqual([1, 2, 3, 4, 5]);
    expect(hr.zones.reduce((n, z) => n + z.share, 0)).toBeGreaterThanOrEqual(98);
    expect(heartRateOf({ ...exercise, heart_rate: undefined, samples: [] })).toBeNull();
  });

  it("reads the keys as Polar's copies spell them (recording_rate) and as its documentation does (recording-rate)", () => {
    const dashed = {
      ...exercise,
      samples: exercise.samples!.map((s) => ({ "recording-rate": s.recording_rate, "sample-type": String(s.sample_type), data: s.data })),
      heart_rate_zones: exercise.heart_rate_zones!.map((z) => ({ index: z.index, "lower-limit": z.lower_limit, "upper-limit": z.upper_limit, "in-zone": z.in_zone })),
    };
    const files = { file: "/archive/x.json", bytes: 1 };
    expect(workoutEvent(dashed, files).streams).toEqual(workoutEvent(exercise, files).streams);
    expect(workoutEvent(exercise, files).streams.heartRate).toEqual({ samples: 1200, everySeconds: 1 });
    expect(heartRateOf(dashed)).toEqual(heartRateOf(exercise));
    expect(heartRateOf(exercise)!.zones[0].from).toBe(95);
  });

  it("knows a FIT file by its header", () => {
    expect(isFit(madeUpFit())).toBe(true);
    expect(isFit(Buffer.from("<html>not a fit file</html>"))).toBe(false);
  });
});

describe("the copies", () => {
  it.live("are kept once each, the FIT file tried again until Polar has one, and read back as events", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() => fakeAccessLink({ token: TOKEN, exercises: [madeUpExercise("Ab12Cd", RUN), madeUpExercise("Ef34Gh", OTHER)], noFit: ["Ef34Gh"] }));
      const dir = join(root, "copies", COPIES);
      const api = accessLink(fake.url, TOKEN);
      const first = yield* fetchNew(api, dir);
      expect(first).toEqual({ copied: 2, tallies: { noFit: 1 } });
      expect((yield* Effect.promise(() => readdir(dir))).sort()).toEqual(["Ab12Cd.fit", "Ab12Cd.json", "Ef34Gh.json"]);
      const kept = yield* Effect.promise(() => stat(join(dir, "Ab12Cd.json")));
      fake.asked.length = 0;
      const again = yield* fetchNew(api, dir);
      expect(again).toEqual({ copied: 0, tallies: { noFit: 1 } });
      // Only the list, and the FIT file still missing: never an exercise kept already.
      expect(fake.asked.map((a) => a.path)).toEqual(["/v3/exercises", "/v3/exercises/Ef34Gh/fit"]);
      expect((yield* Effect.promise(() => stat(join(dir, "Ab12Cd.json")))).mtimeMs).toBe(kept.mtimeMs);
      expect(fake.asked.every((a) => a.authorized)).toBe(true);

      const { events, unread } = yield* copiedEvents(dir);
      expect(events.map((e) => [e.id, e.rawFile !== undefined])).toEqual([["Ab12Cd", true], ["Ef34Gh", false]]);
      expect(unread).toBe(0);
      // A copy that is not an exercise this connector reads is counted, never guessed at.
      yield* Effect.promise(() => writeFile(join(dir, "Zz99.json"), "{\"id\": \"another\"}"));
      expect((yield* copiedEvents(dir)).unread).toBe(1);
      yield* Effect.promise(() => rm(join(dir, "Zz99.json")));
      yield* Effect.promise(() => fake.close());
    }));

  it("are written live only when they changed", () => {
    const event = workoutEvent(madeUpExercise("Ab12Cd", RUN), { file: "/a/Ab12Cd.json", bytes: 10 });
    const first = changesSince([event], null);
    expect(first.events).toEqual([event]);
    expect(changesSince([event], first.cursor).events).toEqual([]);
    const withFit: WorkoutEvent = { ...event, rawFile: "/a/Ab12Cd.fit" };
    expect(changesSince([withFit], first.cursor).events).toEqual([withFit]);
  });
});

const hasSecurity = existsSync("/usr/bin/security");

describe.skipIf(!hasSecurity)("the Keychain", () => {
  it.live("keeps the client and the token, and refuses what would not be safe on security's line", () =>
    Effect.gen(function* () {
      const keychain = join(root, "secrets.keychain-db");
      expect(spawnSync("/usr/bin/security", ["create-keychain", "-p", "made-up", keychain]).status).toBe(0);
      try {
        const secrets = keychainSecrets(keychain);
        expect(yield* secrets.token).toBeNull();
        yield* secrets.setClient({ id: "made-up-client", secret: "made-up-secret" });
        yield* secrets.setToken({ userId: "12345678", accessToken: TOKEN });
        expect(yield* secrets.client).toEqual({ id: "made-up-client", secret: "made-up-secret" });
        expect(yield* secrets.token).toEqual({ userId: "12345678", accessToken: TOKEN });
        // A login again replaces it.
        yield* secrets.setToken({ userId: "12345678", accessToken: "made-up-token-2" });
        expect((yield* secrets.token)?.accessToken).toBe("made-up-token-2");
        const refused = yield* Effect.flip(secrets.setToken({ userId: "1", accessToken: "a b" }));
        expect(refused.message).toMatch(/holds a character/);
        expect(refused.message).not.toContain("a b");
      } finally {
        spawnSync("/usr/bin/security", ["delete-keychain", keychain]);
      }
    }));
});

describe.skipIf(!hasSecurity)("the import into the module's index", () => {
  it("brings each exercise in once through the host, as a workout event of its copy, and again changes nothing; a refused token fails it", async () => {
    const dataDir = join(root, "archive");
    const keychain = join(root, "import.keychain-db");
    expect(spawnSync("/usr/bin/security", ["create-keychain", "-p", "made-up", keychain]).status).toBe(0);
    const fake = await fakeAccessLink({ token: TOKEN, exercises: [madeUpExercise("Ab12Cd", RUN), madeUpExercise("Ef34Gh", OTHER)] });
    const life = await testingLifeArchive(dataDir, exercise);
    try {
      const { db } = life.module.context as ModuleStore;
      await runPromise(keychainSecrets(keychain).setToken({ userId: "12345678", accessToken: TOKEN }));
      await mkdir(join(dataDir, "connectors"), { recursive: true });
      await writeFile(join(dataDir, "connectors", "polar.json"), JSON.stringify({ enabled: true, source: fake.url, keychain }));
      const first = await life.archive.importHistory("polar", undefined);
      expect(first.counts.events).toEqual({ workout: { added: 2, updated: 0, unchanged: 0 } });
      const again = await life.archive.importHistory("polar", undefined);
      expect(again.counts.events).toEqual({ workout: { added: 0, updated: 0, unchanged: 2 } });

      const rows = new WorkoutIndex(db).all();
      expect(rows.map((r) => [r.origin, r.nativeId, r.subkind])).toEqual([["polar", "Ab12Cd", "run"], ["polar", "Ef34Gh", "run"]]);
      expect(rows[0].workout).toMatchObject({ sport: "RUNNING", distanceMeters: 3500, recorder: FLOW_APP, file: "platform-exports/polar/accesslink/Ab12Cd.json", rawFile: "platform-exports/polar/accesslink/Ab12Cd.fit" });
      // The index holds no heart rate and no coordinate: its workout rows are what the copy holds, and where.
      const detail = JSON.stringify(db.prepare("SELECT * FROM workout").all());
      expect(detail).not.toMatch(/latitude|longitude|heart_rate"|"data"/);
      const copy = JSON.parse(await readFile(join(dataDir, "platform-exports", COPIES, "Ab12Cd.json"), "utf8"));
      expect(copy.samples).toHaveLength(3);
      // The import's record is the module's, and its rows reached the calendar as it committed; the archive holds nothing of it.
      expect((db.prepare("SELECT count(*) AS n FROM source WHERE connector = 'polar'").get() as { n: number }).n).toBe(2);
      expect(life.archive.calendar.sink.rowsOf("exercise").map((row) => row.nativeId)).toEqual(["Ab12Cd", "Ef34Gh"]);
      expect(life.archive.calendar.drift()).toEqual([]);
      expect(life.archive.coreDb.prepare("SELECT count(*) AS n FROM source").get()).toEqual({ n: 0 });

      fake.refuse = true;
      await expect(life.archive.importHistory("polar", undefined)).rejects.toThrow(/reconnect needed: Polar refused the archive's token \(401\)/);
    } finally {
      life.close();
      await fake.close();
      spawnSync("/usr/bin/security", ["delete-keychain", keychain]);
    }
  });
});

describe("the polar connector, live", () => {
  it.effect("polls when it starts and every few hours, says reconnect needed on a 401 and asks nothing more until a new token", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() => fakeAccessLink({ token: TOKEN, exercises: [madeUpExercise("Ab12Cd", RUN)] }));
      const secrets = memorySecrets({ token: { userId: "1", accessToken: TOKEN } });
      const written: ConnectorEvent[] = [];
      const until = (done: () => boolean) =>
        Effect.promise(async () => {
          for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
        });
      const fiber = yield* polarConnector(() => secrets).sync!({
        sources: [fake.url], config: {}, mediaDir: join(root, "live"), cursor: null, onCommand: () => {},
        emit: async (event) => void written.push(event),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* until(() => written.some((e) => e.kind === "state"));
      expect(written.filter((e) => e.kind === "workout").map((e) => (e as WorkoutEvent).id)).toEqual(["Ab12Cd"]);
      expect(written.find((e) => e.kind === "checkpoint")).toEqual({ kind: "checkpoint", cursor: { copies: { Ab12Cd: expect.stringMatching(/^\d+ 1$/) } } });
      expect(written.at(-1)).toMatchObject({ kind: "state", state: "connected", detail: expect.stringMatching(/^last fetch \d{4}-\d\d-\d\d \d\d:\d\d, 1 workout kept$/) });

      fake.refuse = true;
      written.length = 0;
      fake.asked.length = 0;
      yield* TestClock.adjust(POLL_EVERY_HOURS * 3_600_000);
      yield* until(() => written.some((e) => e.kind === "state"));
      expect(written).toEqual([{ kind: "state", state: "logged-out", detail: "reconnect needed: Polar refused the archive's token (401); run npm run exercise -- polar login" }]);
      expect(fake.asked).toHaveLength(1);
      // The same token is never offered again.
      yield* TestClock.adjust(TOKEN_LOOK_EVERY_MS * 5);
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(fake.asked).toHaveLength(1);

      // A login again gives another token: the next look takes it, and nothing new is a checkpoint alone, so the
      // server still hears that the pass was good (its last good run moves though no workout came).
      fake.refuse = false;
      fake.token = "made-up-token-2";
      secrets.held.token = { userId: "1", accessToken: "made-up-token-2" };
      yield* TestClock.adjust(TOKEN_LOOK_EVERY_MS);
      yield* until(() => written.some((e) => e.kind === "state" && e.state === "connected"));
      expect(fake.asked.slice(1).map((a) => [a.path, a.authorized])).toEqual([["/v3/exercises", true]]);
      expect(written.filter((e) => e.kind !== "state")).toEqual([{ kind: "checkpoint", cursor: { copies: { Ab12Cd: expect.stringMatching(/^\d+ 1$/) } } }]);
      yield* Fiber.interrupt(fiber);
      yield* Effect.promise(() => fake.close());
    }));

  it.effect("says it is not connected when the Keychain holds no token, and asks Polar nothing", () =>
    Effect.gen(function* () {
      const written: ConnectorEvent[] = [];
      const fiber = yield* polarConnector(() => memorySecrets()).sync!({
        sources: ["http://127.0.0.1:9"], config: {}, mediaDir: join(root, "none"), cursor: null, onCommand: () => {},
        emit: async (event) => void written.push(event),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(written).toEqual([{ kind: "state", state: "logged-out", detail: "not connected yet: run npm run exercise -- polar login" }]);
      yield* Fiber.interrupt(fiber);
    }));
});

describe("the login", () => {
  it.live("asks for the client, catches the browser's way back, exchanges the code, registers once and keeps the token", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() => fakeAccessLink({ token: TOKEN, exercises: [], userId: 87654321 }));
      const settingsFile = join(root, "login", "connectors", "polar.json");
      const secrets = memorySecrets();
      const lines: string[] = [];
      const asked: string[] = [];
      const port = 46_000 + Math.floor(Math.random() * 1000);
      const login = (newClient = false) =>
        polarLogin({
          secrets, settingsFile, newClient, port,
          ask: (question) => Effect.sync(() => (asked.push(question), question.startsWith("Client ID") ? "made-up-client" : "made-up-secret")),
          // The captain's browser: Polar's page sends it back to the listener, which answers.
          open: (url) => Effect.promise(async () => void (await fetch(url).then((res) => res.text()))),
          log: (line) => lines.push(line),
          authorizeUrl: `${fake.url}/oauth2/authorization`, tokenUrl: `${fake.url}/v2/oauth2/token`, apiUrl: fake.url,
        });
      const first = yield* login();
      expect(first.registered).toBe("registered");
      expect(asked).toEqual(["Client ID: ", "Client secret (not shown): "]);
      expect(secrets.held).toEqual({ client: { id: "made-up-client", secret: "made-up-secret" }, token: { userId: "87654321", accessToken: TOKEN } });
      const settings = yield* Effect.promise(() => readSettings(settingsFile));
      expect(settings).toEqual({ enabled: true, memberId: first.memberId });
      expect(fake.registered).toEqual([first.memberId]);
      expect(lines.join("\n")).toContain("trustedHeartRate");
      expect(lines.join("\n")).not.toContain("made-up-secret");
      const authorize = new URL(fake.asked.find((a) => a.path.startsWith("/oauth2/authorization"))!.path, fake.url);
      expect(authorize.searchParams.get("redirect_uri")).toBe(`http://localhost:${port}/polar/callback`);
      expect(authorize.searchParams.get("scope")).toBe("accesslink.read_all");

      // Again: the Keychain's client, the same member, already registered.
      asked.length = 0;
      const again = yield* login();
      expect(again).toEqual({ memberId: first.memberId, registered: "already registered" });
      expect(asked).toEqual([]);

      // A way back with another state is some other page's, and is refused.
      const stray = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/polar/callback?code=x&state=other`).then((res) => res.status, () => "closed"));
      expect(stray).toBe("closed");
      yield* Effect.promise(() => fake.close());
    }));

  it.live("fails, keeping nothing, when Polar refuses the client", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() => fakeAccessLink({ token: TOKEN, exercises: [], client: { id: "another", secret: "client" } }));
      const secrets = memorySecrets({ client: { id: "made-up-client", secret: "wrong" } });
      const failed = yield* Effect.flip(polarLogin({
        secrets, settingsFile: join(root, "refused", "polar.json"), port: 47_000 + Math.floor(Math.random() * 1000),
        ask: () => Effect.succeed(""), open: (url) => Effect.promise(async () => void (await fetch(url).then((res) => res.text()))), log: () => {},
        authorizeUrl: `${fake.url}/oauth2/authorization`, tokenUrl: `${fake.url}/v2/oauth2/token`, apiUrl: fake.url,
      }));
      expect(failed.message).toMatch(/Polar refused the token exchange \(401\): check the client ID and secret/);
      expect(secrets.held.token).toBeUndefined();
      expect(existsSync(join(root, "refused", "polar.json"))).toBe(false);
      yield* Effect.promise(() => fake.close());
    }));
});
