// The rituals module's command (README.md):
//
//   npm run rituals -- status    where the store is, as the module reads it (modules/rituals/data/ritual.sqlite3 in the
//                                archive's folder), and what it holds: its days, habit times, weekly targets and
//                                temporary items, and what the calendar would hold of it (the migration's check); or
//                                that there is none yet, and where ritualctl would make it
//   npm run rituals -- voice-calls ...
//                                moved: the journal module's `npm run journal -- grok-calls ...` now; says so and does
//                                nothing (until the agent rituals installed is written anew, README.md's "Voice calls")
//
// The writes are ritualctl's (bin/ritualctl, HANDOFF.md), never this command's. The archive's folder is found as every
// entry point finds it (the core's dataHome.ts, through the SDK): sdk/command.ts first (the pinned Node, the settings),
// then the SDK for the rest.

import "../../sdk/command.ts";
import { archiveFolder, runMain, Effect } from "../../sdk/server.ts";
import { ritualsRows } from "./server/calendar.ts";
import { readRituals, ritualsRoot, STORE_FILE, storeFile } from "./server/view.ts";
import { workoutDays } from "./server/workouts.ts";

const [command, ...rest] = process.argv.slice(2);
const USAGE = "Usage: npm run rituals -- status";

if (command === "voice-calls") {
  console.error(`The voice-calls job is the journal module's now: npm run journal -- grok-calls${rest.length ? ` ${rest.join(" ")}` : ""}`);
  process.exitCode = 1;
} else if (command === "status") {
  await runMain(
    readRituals(archiveFolder()).pipe(
      Effect.match({
        onSuccess: (view) => {
          const rows = ritualsRows(view);
          const days = view.daily.rows;
          console.log(`${storeFile(archiveFolder())}:`);
          console.log(`  ${days.length} days, ${days[days.length - 1]?.date} to ${days[0]?.date}, ${view.events.length} habit times, ${workoutDays(view).reduce((n, day) => n + day.workouts.length, 0)} workouts logged.`);
          console.log(`  ${view.weekly_targets.weeks.flatMap((week) => week.targets).length} weekly target weeks over ${view.weekly_targets.weeks.length} weeks, ${view.attachments.items.length} temporary items.`);
          console.log(`  The calendar would hold ${rows.filter((row) => row.kind === "ritual_habit").length} habits done and ${rows.filter((row) => row.kind === "ritual_day").length} days of it (npm run archive -- calendar check compares).`);
        },
        onFailure: (error) => {
          if (error.state === "unset") {
            console.log(`No store yet: ${error.reason}.`);
            console.log(`ritualctl writes it at ${ritualsRoot(archiveFolder())}/${STORE_FILE} once its config/root (or RITUAL_ROOT) names ${ritualsRoot(archiveFolder())} (README.md).`);
          } else {
            console.error(error.reason);
            process.exitCode = 1;
          }
        },
      }),
    ),
  );
} else {
  console.log(USAGE);
  if (command !== undefined && command !== "help") process.exitCode = 1;
}
