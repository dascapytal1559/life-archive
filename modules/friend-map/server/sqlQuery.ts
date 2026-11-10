// SQL queries: a query that is SQL (isSqlQuery, src/archive.ts) is one
// read-only SELECT over the archive's tables and a few views, returning the
// people to show as a column person_id (or id). The Table, Orbits and the CLI's
// --query take it as they take the query language (query.ts), which
// is unchanged; Generate writes SQL (queryWriter.ts).
//
// Each query runs in a process of its own (sqlRead.ts, which says how it only
// reads and what the views are), on its own read-only connection to the
// archive's file, so:
//   - a query running longer than the time limit is stopped by ending the
//     process, and the server goes on serving while one runs;
//   - nothing a query says reaches the server's connection, which writes;
//   - at most maxRows rows are read, and a query returning more is refused.
// Whatever goes wrong comes back as a QueryError, said under the Query bar's box.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Db, isSqlQuery } from "../../../sdk/server.ts";
import { QueryError, runQuery, type QueryPerson, type QueryVocabulary } from "./query.ts";
import type { SqlAnswer, SqlRequest } from "./sqlRead.ts";

export interface SqlLimits {
  /** How long a query may run before its process is ended. */
  timeoutMs: number;
  /** The most rows a query may return. */
  maxRows: number;
}

export const SQL_LIMITS: SqlLimits = { timeoutMs: 10_000, maxRows: 100_000 };

const READER = fileURLToPath(new URL("./sqlRead.ts", import.meta.url));

/** The reader's command line and environment: this Node, without NODE_OPTIONS (an inspector or loader meant for the server). */
function reader(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const { NODE_OPTIONS: _options, ...env } = process.env;
  return { command: process.execPath, args: ["--no-warnings", READER], env };
}

function request(db: Db, sql: string, limits: SqlLimits): string {
  const file = db.location();
  if (!file) throw new QueryError("SQL runs only over an archive in a file");
  return JSON.stringify({ file, sql, maxRows: limits.maxRows } satisfies SqlRequest);
}

/** What the reader's run comes to: its ids, or a QueryError saying what went wrong. */
function outcome(run: { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }, limits: SqlLimits): number[] {
  if (run.timedOut) throw new QueryError(`SQL: the query ran longer than ${limits.timeoutMs / 1000} s and was stopped`);
  let answer: SqlAnswer | undefined;
  try {
    answer = run.code === 0 ? (JSON.parse(run.stdout) as SqlAnswer) : undefined;
  } catch {
    answer = undefined;
  }
  if (!answer) {
    const said = run.stderr.trim().split("\n").at(-1);
    throw new QueryError(`SQL: the query stopped unexpectedly (${run.signal ?? `exit ${run.code}`})${said ? `: ${said}` : ""}`);
  }
  if ("error" in answer) throw new QueryError(`SQL: ${answer.error}`);
  return answer.ids;
}

/** The person ids a SQL query returns over the archive open in `db`, each once, in its own read-only process (see the top). */
export async function sqlQuery(db: Db, sql: string, limits: SqlLimits = SQL_LIMITS): Promise<number[]> {
  const input = request(db, sql, limits);
  const { command, args, env } = reader();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, limits.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    // A reader that ends before reading its question: its exit says why.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try {
        resolve(outcome({ stdout, stderr, code, signal, timedOut }, limits));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

/** sqlQuery, waiting for the answer: for the CLI, whose edits choose people again inside their changeset. */
export function sqlQuerySync(db: Db, sql: string, limits: SqlLimits = SQL_LIMITS): number[] {
  const input = request(db, sql, limits);
  const { command, args, env } = reader();
  const run = spawnSync(command, args, { env, input, encoding: "utf8", timeout: limits.timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
  const timedOut = (run.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (run.error && !timedOut) throw run.error;
  return outcome({ stdout: run.stdout, stderr: run.stderr, code: run.status, signal: run.signal, timedOut }, limits);
}

/** What a query runs over (ArchiveStructure.queryable). */
export interface Queryable {
  people: readonly QueryPerson[];
  vocabulary: QueryVocabulary;
}

/** The ids of `people` among `ids`, in the people's order, as the query language gives them. */
function among(ids: readonly number[], people: readonly QueryPerson[]): number[] {
  const found = new Set(ids);
  return people.filter((person) => found.has(person.id)).map((person) => person.id);
}

/** Everyone a query matches, by id in the people's order: SQL (isSqlQuery) in its own process, else the query language. */
export async function matchQuery(db: Db, text: string, { people, vocabulary }: Queryable, limits?: SqlLimits): Promise<number[]> {
  return isSqlQuery(text) ? among(await sqlQuery(db, text, limits), people) : runQuery(text, people, vocabulary);
}

/** matchQuery, waiting for the answer. */
export function matchQuerySync(db: Db, text: string, { people, vocabulary }: Queryable, limits?: SqlLimits): number[] {
  return isSqlQuery(text) ? among(sqlQuerySync(db, text, limits), people) : runQuery(text, people, vocabulary);
}
