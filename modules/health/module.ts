// Health's server half (sdk/server.ts's defineModule): the Health tab's route, the runs transcribed by hand offered to
// the Fitness page (RunsByHand), its made-up results for the testing data, and its lines of the privacy policy. The
// core finds this file by its place (server/modules/loader.ts) and loads it while the module is on. Its page half is
// viewer.tsx, its command cli.ts (`npm run health`); README.md says what the module is.

import { defineModule, Layer, RunsByHand } from "../../sdk/server.ts";
import { writeMadeUpHealth } from "./fixtures/health.ts";
import { healthRoute } from "./server/http.ts";
import { HEALTH_PRIVACY } from "./server/privacy.ts";
import { HEALTH_MOVE, runsByHand } from "./server/store.ts";
import { HEALTH_API } from "./wire.ts";

export default defineModule({
  id: "health",
  sdk: 1,
  routes: ({ folder }) => healthRoute(folder),
  services: ({ folder }) => Layer.succeed(RunsByHand, { runs: runsByHand(folder) }),
  fixtures: { what: "made-up health results", write: writeMadeUpHealth },
  privacy: HEALTH_PRIVACY,
  // Its records, in health/ of the archive's folder before modules kept their files in theirs (server/store.ts).
  moves: [HEALTH_MOVE],
  // The static demo keeps the Health tab's one answer (docs/demo.md).
  demo: { record: async (recorder) => void (await recorder.json(HEALTH_API)) },
});
