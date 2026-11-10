import { NodeServices } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { deriveTitle, normaliseCategory } from "../src/workouts.ts";
import { openStore } from "../src/store.ts";
import { tempDirectory } from "./helpers/fixtures.ts";

layer(NodeServices.layer, { excludeTestServices: true })("workout categories and titles", (it) => {
  it.effect("folds synonyms into one category and keeps other types open", () =>
    Effect.sync(() => {
      expect(["Bike ride", "  cycling", "bike", "Running", "Gym  Push", "swim"].map(normaliseCategory)).toEqual([
        "bike",
        "bike",
        "bike",
        "run",
        "gym push",
        "swim",
      ]);
    }),
  );

  it.effect("derives glanceable titles only when the details settle them", () =>
    Effect.sync(() => {
      expect(deriveTitle("gym push", "bench 50kg")).toBe("Gym Push");
      expect(deriveTitle("gym legs", "")).toBe("Gym Legs");
      expect(deriveTitle("bike", "30 minutes")).toBe("Bike 30 min");
      expect(deriveTitle("bike", "1 hour")).toBe("Bike 60 min");
      expect(deriveTitle("bike", "bike ride today")).toBeNull();
      expect(deriveTitle("bike", "30 minutes then 20 minutes")).toBeNull();
      expect(deriveTitle("run", "5 km")).toBe("Run 5k");
      expect(deriveTitle("run", "Notes: running, 5k, zone 2-4")).toBe("Run 5k");
      expect(deriveTitle("run", "ran")).toBeNull();
      expect(deriveTitle("walk", "after dinner")).toBeNull();
    }),
  );

  it.effect(
    "workout_add stores the category and an explicit or derived title; the category index serves last-of-type",
    () =>
      Effect.gen(function* () {
        const store = yield* openStore(yield* tempDirectory);
        const add = (id: string, record: Record<string, unknown>) =>
          store.request({ op: "workout_add", record, source_text: "test", request_id: id });
        yield* add("a", { date: "2026-10-01", type: "bike ride", details: "30 minutes" });
        yield* add("b", { date: "2026-10-02", type: "Gym Push", details: "bench" });
        yield* add("c", { date: "2026-10-03", type: "run", details: "8 km", title: "Run 8k (hilly)" });
        yield* add("d", { date: "2026-10-04", type: "swim", details: "laps" });
        const all = (yield* store.request({ op: "workouts", from: "2026-10-01", to: "2026-10-31" })) as any;
        expect(all.records.map((r: any) => [r.type, r.title])).toEqual([
          ["bike", "Bike 30 min"],
          ["gym push", "Gym Push"],
          ["run", "Run 8k (hilly)"],
          ["swim", null],
        ]);
        const bikes = (yield* store.request({
          op: "workouts",
          from: "2026-10-01",
          to: "2026-10-31",
          type: "Bike ride",
        })) as any;
        expect(bikes.records.length).toBe(1);
        const plan = yield* store.sql.unsafe<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT MAX(date) FROM workouts WHERE type='gym push'",
        );
        expect(plan.map((r) => r.detail).join(" ")).toContain("idx_workouts_type_date");
      }),
  );

  it.effect("a legacy row is backfilled with correct, keeping history and its original source", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request({
        op: "workout_add",
        record: { date: "2026-10-05", type: "swim", details: "40 min" },
        source_text: "original words",
        request_id: "orig",
      });
      const row = ((yield* store.request({ op: "workouts", from: "2026-10-05", to: "2026-10-05" })) as any).records[0];
      yield* store.request({
        op: "correct",
        entity: "workouts",
        id: row.id,
        patch: { title: "Swim 40 min" },
        expected_revision: row.revision,
        reason: "Backfill glanceable title",
        request_id: "fix",
        source_text: "title backfill",
      });
      const after = ((yield* store.request({ op: "workouts", from: "2026-10-05", to: "2026-10-05" })) as any)
        .records[0];
      expect([after.type, after.details, after.title]).toEqual(["swim", "40 min", "Swim 40 min"]);
      const history = yield* store.sql.unsafe<{ source_text: string }>(
        "SELECT source_text FROM changes WHERE entity='workouts' ORDER BY id",
      );
      expect(history.map((h) => h.source_text)).toEqual(["original words", "title backfill"]);
    }),
  );
});
