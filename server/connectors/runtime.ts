// The child-process side of a connector, and that process's edge: the one place it runs Effect code
// (docs/effect.md, "Where plain TypeScript meets Effect"). A connector's main.ts is just
//
//   await runConnector(connector);
//
// and the host starts it as
//
//   node server/connectors/<id>/main.ts --mode history --source <path> [--source <path> ...] --media <dir> [--copies <dir>] --config <json>
//   node server/connectors/<id>/main.ts --mode sync --source <path> --media <dir> --config <json> --cursor <json>
//
// Events go to stdout, one JSON object per line. Anything written to stderr is
// kept by the host as the connector's error, so it must never quote message
// content: name the record by position or kind instead.
//
// In sync mode, commands arrive on stdin, one JSON object per line, and each
// is answered with a `send-result`. The connector stops when the host sends
// SIGTERM or closes stdin (the host has gone), so it never outlives it:
// either interrupts its sync, which finishes the step it is in (`whole`).

import "../onSettings.ts";
import { parseArgs } from "node:util";
import { Cause, Effect, Fiber, Stream } from "effect";
import {
  connectorError,
  validateCommand,
  type CommandOutcome,
  type Connector,
  type ConnectorCommand,
  type ConnectorEvent,
  type SendResultEvent,
  type SyncOptions,
} from "./contract.ts";
import { jsonLines } from "./lines.ts";

type Handler = (command: ConnectorCommand) => Effect.Effect<CommandOutcome, Error>;

export async function runConnector(connector: Connector): Promise<void> {
  let program: Effect.Effect<void, unknown>;
  let sync = false;
  try {
    const { values } = parseArgs({
      options: {
        mode: { type: "string" },
        source: { type: "string", multiple: true },
        media: { type: "string" },
        copies: { type: "string" },
        config: { type: "string", default: "{}" },
        cursor: { type: "string", default: "null" },
      },
    });
    if (!values.source?.length) throw new Error("no --source given");
    if (!values.media) throw new Error("no --media folder given");
    const common = {
      sources: values.source,
      mediaDir: values.media,
      ...(values.copies ? { copiesDir: values.copies } : {}),
      config: JSON.parse(values.config) as Record<string, unknown>,
      emit: writeEvent,
    };
    if (values.mode === "history" && connector.history) {
      const history = connector.history;
      program = Effect.suspend(() => {
        const run = history(common);
        return Effect.isEffect(run) ? run : Effect.tryPromise({ try: () => run, catch: connectorError });
      });
    } else if (values.mode === "sync" && connector.sync) {
      program = runSync(connector, { ...common, cursor: JSON.parse(values.cursor) as unknown });
      sync = true;
    } else {
      const modes = [connector.history && "history", connector.sync && "sync"].filter(Boolean).join(" and ");
      throw new Error(`mode ${values.mode ?? "(none)"} is not supported; only ${modes} ${modes.includes(" and ") ? "are" : "is"}`);
    }
  } catch (error) {
    return failed(error);
  }

  const fiber = Effect.runFork(program);
  const stop = () => fiber.interruptUnsafe();
  if (sync) {
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  const exit = await Effect.runPromise(Fiber.await(fiber));
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)) failed(Cause.squash(exit.cause));
}

function failed(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

/** Runs the connector's sync, answering the host's commands, until it ends or is stopped. */
const runSync = (connector: Connector, options: Omit<SyncOptions, "onCommand">): Effect.Effect<void, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      let handler: Handler | null = null;
      // Each command is answered as it comes, and an answer begun is finished before the process ends.
      const commands = Stream.fromAsyncIterable(jsonLines(process.stdin), () => "stdin failed").pipe(
        Stream.runForEach((line) => (line.trim() ? Effect.forkScoped(Effect.uninterruptible(answer(line, handler))) : Effect.void)),
        // stdin failing is the host going away, as its end is.
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => process.stdin.destroy())),
      );
      // No more commands can come once stdin ends: the host has gone, so stop rather than run on alone.
      yield* connector.sync!({
        ...options,
        onCommand: (next) => {
          handler = next;
        },
      }).pipe(Effect.raceFirst(commands));
    }),
  );

const answer = (line: string, handler: Handler | null): Effect.Effect<void> =>
  Effect.gen(function* () {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stderr.write("the host sent a command that is not JSON\n");
      return;
    }
    const request = typeof (parsed as { request?: unknown })?.request === "string" ? (parsed as { request: string }).request : null;
    const checked = validateCommand(parsed);
    let result: Omit<SendResultEvent, "kind" | "request">;
    if ("error" in checked) {
      result = { status: "failed", error: `the command ${checked.error}` };
    } else if (!handler) {
      result = { status: "failed", error: "the connector is not ready for commands yet" };
    } else {
      result = yield* handler(checked.command).pipe(
        Effect.map((outcome) => ({ status: outcome.status, ...(outcome.messageId ? { messageId: outcome.messageId } : {}), ...(outcome.error ? { error: outcome.error } : {}) })),
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          return Effect.succeed({ status: "failed" as const, error: error instanceof Error ? error.message : String(error) });
        }),
      );
    }
    if (request === null) {
      process.stderr.write("the host sent a command without a request id\n");
      return;
    }
    yield* Effect.promise(() => writeEvent({ kind: "send-result", request, ...result }));
  });

function writeEvent(event: ConnectorEvent): Promise<void> {
  return new Promise((resolve, reject) => {
    // Waiting for each write keeps memory flat when the host applies events slower than they are read.
    process.stdout.write(`${JSON.stringify(event)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}
