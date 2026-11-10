import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { requirePinnedNode } from "./server/nodeVersion.ts";

requirePinnedNode();

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "src/**/*.test.ts", "viewer/**/*.test.ts", "sdk/**/*.test.ts", "tools/**/*.test.ts", "modules/*/**/*.test.ts"],
    environment: "node",
    // Left unset, the archive's address is the running server's (dataHome.ts), and any test whose CLI asks for the live
    // connectors' state would ask the real one. Nothing listens on port 1, and a test that starts a server names its own.
    // Likewise the archive's folder: left unset it is the real one in the captain's copy, so it is one that cannot be made.
    // The tests, and every process they start, run on the made-up settings, whatever the machine's zone and locale are.
    env: {
      LIFE_ARCHIVE_URL: "http://127.0.0.1:1",
      LIFE_ARCHIVE_DATA: "/nonexistent/life-archive-data",
      LIFE_ARCHIVE_SETTINGS: fileURLToPath(new URL("./testing-data/settings.json", import.meta.url)),
      LIFE_ARCHIVE_MODEL: "sample-model",
      // Rituals' store reckons its days in a zone of its own (modules/rituals/src/instants.ts): the tests', whatever the machine's.
      RITUAL_TIME_ZONE: "Australia/Melbourne",
    },
    setupFiles: ["server/onSettings.ts"],
    // Most tests here build a real archive, and many start processes of their
    // own (the archive's CLI, the SQL reader, git, restic), so a worker is
    // more than a core. vitest's default, a worker for every core but one,
    // took this 16-core Mac to a load of 15 on its own and 60 beside other
    // work, and tests timed out. Half the cores costs an idle run a few
    // seconds and a busy one runs in a third of the time.
    maxWorkers: "50%",
    // Time for a busy machine: beside 14 busy cores, tests that start node
    // processes took up to 8 s and mapFacts' beforeAll over 10 s, past
    // vitest's 5 s and 10 s. A test that needs more still says so itself.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
