// The module's lines of the privacy policy (sdk/server.ts's ModulePrivacy; the core's server/privacy/policy.ts): what
// of its data is content, what holds that to the rule, and what is metadata. `npm run docs` writes them into
// docs/privacy.md with the core's, and the guard's review is told them.

import type { ModulePrivacy } from "../../../sdk/server.ts";

export const EXERCISE_PRIVACY: ModulePrivacy = {
  content: [
    "a workout's route and heart rate, in its copy among the exports: the Fitness page draws them for the captain, a route as its shape in metres laid on the map of its area that the archive keeps on this Mac (`maps/` in the archive's folder, OpenStreetMap's data and Mapterhorn's terrain downloaded once with `npm run map`, their tiles and fonts served by the archive's own server), the page told the route's corner only then; viewing one never contacts a map server, so no tile server is told where he went, and a route whose area's map is not downloaded is drawn over none",
    "an activity's playback in 3D (the Fitness page, Play back in 3D): the route whole, point by point with its times, distance and altitude, and the trusted heart rate, sent to the page alone and only for a route inside a map kept here; over the archive's own 3D it asks no other server for anything; the playback opens over that 3D; over the photorealistic city, only when the captain chooses it for that playback and only while CESIUM_ION_TOKEN or GOOGLE_MAPS_API_KEY is set in .env.local, the page asks Cesium ion for the tileset's address once a playback and Google for the city's tiles the camera sees as it follows the route, so the tile requests retrace the route and Google can learn where he went, piece by piece and when he played it back, though never its times, distance or heart rate, which stay on this Mac",
    "the captain's note on a workout (the Workouts table's Note: `workout_note` in the exercise module's database, and its change log's rows of it): read only when he opens it to edit, each read kept in the trail; never in the calendar or the record of edits",
  ],
  contentGuards: [
    "a workout the captain deletes from the Fitness page is removed whole from the archive's folder, with no backup taken: its copies' files, their entries in an export's zip and their rows in the exercise module's index and the calendar, and his corrections and note on it with their change log's rows (overwritten, not just unlinked); the backups and NAS snapshots taken before still hold it until they expire, and Polar Flow until he deletes it there; and between the module's landing and the migration that drops the archive's old rows (which overwrites them for good), those rows and the archive's 48-hour backups still hold its index row, metadata only",
  ],
  metadata: [
    "the exercise module's index (`modules/exercise/exercise.sqlite` in the archive's folder): of each copy of a workout, when, its sport and family, how far, what recorded it, which sample streams it holds and where the copy is, never a heart rate or a coordinate; the weekly targets and the heart-rate zones every workout's time in zones is counted by (`modules/exercise/exercise.json` in the archive's folder, or `exercise.json` at its root until it is moved)",
    "a tombstone for each workout copy he deleted: its source, the source's id, its sport family, when it started and ended, and when it was deleted; nothing of what it held",
    "his corrections to a workout from the Workouts table (`workout_correction`): its sport, start, end or distance as he says, kept beside each copy as its source gave it, and the change log they are made under",
  ],
};
