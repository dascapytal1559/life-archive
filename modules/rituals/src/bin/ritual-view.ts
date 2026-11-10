// bin/ritual-view: print the dashboard's daily and weekly-target data as one versioned JSON envelope, read-only.
import { runCli } from "../cli.ts";
import { describe } from "../errors.ts";
import { ROOT } from "../root.ts";
import { main } from "../view.ts";

runCli(main(process.argv.slice(2), ROOT), {
  onError: (error) => ({ ok: false, error: describe(error) }),
});
