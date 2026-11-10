// Made-up fixtures by default; RITUAL_FIXTURE_DIR can point at a local evidence folder instead.
import { Effect } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha } from "../../src/encoding.ts";
import { WEEKLY_TARGET_SQL } from "../../src/weeklyTargets.ts";

/** Rituals' own folder: the module, modules/rituals/ of the life archive checkout, with bin/, src/ and tests/. */
export const REPO = path.resolve(import.meta.dirname, "..", "..");
/** The packages the sources import: the life archive's, at its root (a module has none of its own). */
export const NODE_MODULES = path.resolve(REPO, "..", "..", "node_modules");
export const FIXTURES = process.env.RITUAL_FIXTURE_DIR ?? path.join(REPO, "tests", "fixtures");

const readJson = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
export const BUNDLE: any = readJson("import-bundle.json");
export const PENDING: any = readJson("pending-journalling-2026-09-30.json");

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A fresh temporary directory, removed when the test's scope closes. */
export const tempDirectory = Effect.acquireRelease(
  Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "ritual-test-"))),
  (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
);

export const fileSha = (file: string): string => sha(fs.readFileSync(file));

export const listFiles = (folder: string, suffix: string): Array<string> =>
  fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => name.endsWith(suffix)) : [];

export const mode = (file: string): number => fs.statSync(file).mode & 0o777;

/** Inspect a SQLite file directly (read-only), the way the Python tests opened backups. */
export const inspect = <A>(file: string, use: (db: DatabaseSync) => A): A => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return use(db);
  } finally {
    db.close();
  }
};

/** Run SQL scripts against a new SQLite file, for building old-schema stores. */
export const withDatabase = (file: string, use: (db: DatabaseSync) => void): void => {
  const db = new DatabaseSync(file);
  try {
    use(db);
  } finally {
    db.close();
  }
};

/** The one-line error text, whatever kind of failure it is. */
export const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);

/** Version 3's weekly review table, which version 9 drops: only for building a store at an older schema version. */
export const WEEKLY_SQL = `CREATE TABLE weekly_reviews(
 week_start TEXT PRIMARY KEY CHECK(date(week_start) IS week_start AND strftime('%w',week_start)='1'),
 answer TEXT NOT NULL CHECK(length(trim(answer))>0)
);`;

/**
 * Take a current store's wind-down tick away (version 12), for building a store at an older schema version. The two
 * habit tables keep their wider check, which an older store did not have; the migration rebuilds them either way.
 */
export const BEFORE_WIND_DOWN_SQL = `ALTER TABLE rituals DROP COLUMN wind_down;
DELETE FROM schema_migrations WHERE version=12;`;

/**
 * An older export's rows of `table` as a migration to version 12 leaves them: each ritual day gains a null wind-down,
 * every other row exactly as it was.
 */
export const migratedRows = (table: string, rows: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> =>
  rows.map((row) => (table === "rituals" && !("wind_down" in row) ? { ...row, wind_down: null } : { ...row }));

/** Take a current store's check times away (version 11) and what came after, for building a store at an older schema version. */
export const BEFORE_CHECK_TIMES_SQL = `${BEFORE_WIND_DOWN_SQL}
ALTER TABLE ritual_attachment_checks DROP COLUMN done_at;
ALTER TABLE ritual_attachment_checks DROP COLUMN basis;
DELETE FROM schema_migrations WHERE version=11;`;

/**
 * Turn a current store's weekly_targets back into the version 8–9 shape (one `minimum` column instead of the dated
 * `minimums` history of version 10), for building a store at an older schema version. Each target must have had a
 * single minimum, as every target did before version 10.
 */
export const toVersion9Targets = (db: DatabaseSync): void => {
  const rows = db.prepare("SELECT * FROM weekly_targets ORDER BY id").all() as Array<Record<string, any>>;
  // The entries keep referring to the targets while their table is rebuilt.
  db.exec(
    BEFORE_CHECK_TIMES_SQL +
      "PRAGMA foreign_keys=OFF; DROP TABLE weekly_targets; DELETE FROM schema_migrations WHERE version=10;" +
      (WEEKLY_TARGET_SQL.split(";")[0] as string),
  );
  for (const { minimums, ...row } of rows) {
    const history = JSON.parse(minimums) as Array<{ minimum: number }>;
    if (history.length !== 1) throw new Error(`Target ${row.id} has a dated minimum history`);
    const values = { ...row, minimum: (history[0] as { minimum: number }).minimum };
    db.prepare(
      `INSERT INTO weekly_targets(${Object.keys(values).join(",")}) VALUES(${Object.keys(values)
        .map(() => "?")
        .join(",")})`,
    ).run(...(Object.values(values) as Array<any>));
  }
  db.exec("PRAGMA foreign_keys=ON");
};

/**
 * An `events` list saying the time of each habit is unknown. A ritual_put that ticks a habit must carry its event, so
 * a fixture that only needs the tick says so this way.
 */
export const untimed = (...habits: ReadonlyArray<string>): Array<{ habit: string; done_at: null; basis: "unknown" }> =>
  habits.map((habit) => ({ habit, done_at: null, basis: "unknown" }));
