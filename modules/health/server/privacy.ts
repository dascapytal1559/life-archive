// Health's lines of the privacy policy (sdk/server.ts's ModulePrivacy; the core's policy is server/privacy/policy.ts,
// and docs/privacy.md is them all): health results are content, by the captain's word (docs/features.md's "Health"), and so is
// every copy that holds them; what the import says of its files, and the authority on range, are not.

import type { ModulePrivacy } from "../../../sdk/server.ts";

export const HEALTH_PRIVACY: ModulePrivacy = {
  content: [
    "the health results and records (the health module): the lab reports and the portals' pages in their exports (`platform-exports/everlab/` and `platform-exports/my-health-record/` in the archive's folder), what the import read from them (`modules/health/imported.json`: every result of every report it reads), what was transcribed by hand (`modules/health/by-hand.json`: results, the physical assessment, runs, treatments, immunisations, medicines and Medicare's claims), and the Health page's one answer (`/life-archive/api/m/health`), every result judged",
  ],
  contentGuards: [
    "the Health page's answer: its route refuses another site's page and any write, and the door's Host guard and the tailnet's ACL decide who may ask; `npm run health -- import` says what each file gave and which it could not read, never a result",
  ],
  metadata: [
    "which health exports the import read, left to the hand or could not read, and when (`modules/health/imported.json`'s list of files and `importedAt`); and the one authority on range (`npm run health -- ranges`: each test's source and bands, with the labs' printed intervals chosen in `modules/health/lab-intervals.json`), which is no one's result, though the labs it names and their reports' dates are the owner's own and stay in the archive's folder",
  ],
};
