// What the Fitness page and the module's server half say to each other (server/http.ts), and the addresses both
// halves share: the module's routes, under its address (sdk/wire.ts's moduleApi), and its page in the console.
//
//   GET /life-archive/api/m/exercise/activities          -> ExerciseAnswer: every activity, newest first, each as its feed card
//   GET /life-archive/api/m/exercise/activities/<id>     -> ActivityDetail: one activity, with its route, heart rate and splits
//   GET /life-archive/api/m/exercise/activities/<id>/playback -> PlaybackTrack: its route whole, to replay in 3D (409: none)
//   GET /life-archive/api/m/exercise/pillars             -> PillarsAnswer: the Bryan Johnson tab's weekly targets and the
//                                                        ritual days' stretching statuses (statuses alone)
//   DELETE /life-archive/api/m/exercise/activities/<id>  {start} -> ActivityDeleted: every copy of it removed for good (the
//                                                        page's own only; 409 when it cannot be, or `start` is no longer its start)
//   GET /life-archive/api/m/exercise/map/<region>/<z>/<x>/<y>.mvt        -> a vector tile of a map kept on this Mac (204: none there)
//   GET /life-archive/api/m/exercise/map/fonts/<font>/<from>-<to>.pbf    -> a font's glyphs, for the map's labels
//   GET /life-archive/api/m/exercise/map/terrain/<region>/<z>/<x>/<y>.webp -> the region's terrain, for the playback's 3D
//   GET /life-archive/api/m/exercise/cesium/<path>       -> CesiumJS's build, for the playback's photorealistic city
//
// An activity is every source's copies of one workout made one (server/workouts.ts), shown from the copy with
// the most detail; a workout the captain logged in Rituals joins the one it is (the same day, sport and duration:
// server/rituals.ts), else is an activity of its own, known only by its day. Each activity says its minutes
// in zone 2, for the weekly zone 2 target the archive keeps (modules/exercise/exercise.json in its folder, or exercise.json at its root until it is moved), counted by the zones set there. Its heart rate is sent only when the captain trusts it (a chest strap's, never a watch's: his rule in
// each source's settings), as the Health tab always has. Its route is sent as a shape in metres, and, when a map the
// archive keeps on this Mac covers it (server/maps/), with its south-west corner, so the page lays it on that map,
// read from this server alone (each region's map was downloaded once, npm run map -- download <region>; viewing a map
// asks nothing of any server but this one); with no such map it is drawn over none (server/track.ts).
//
// Under the viewer's /life-archive/, which Tailscale Serve passes on to the tailnet whole, so the captain's phone
// reaches it as it reaches the rest of the viewer; the tailnet's ACL admits only his own devices.

import { consolePath, moduleApi } from "../../sdk/wire.ts";

/** The module's routes' address. */
export const EXERCISE_API = moduleApi("exercise");
/** The activities' routes, at it and under it. */
export const ACTIVITIES_API = `${EXERCISE_API}/activities`;
/** The maps' routes, under it. */
export const MAP_API = `${EXERCISE_API}/map`;

/** A region's tiles, as a MapLibre source names them. */
export const tilesUrl = (region: string): string => `${MAP_API}/${encodeURIComponent(region)}/{z}/{x}/{y}.mvt`;

/** A region's terrain, as a MapLibre raster-dem source names it: Terrarium-encoded WebP tiles of 512 pixels. */
export const terrainUrl = (region: string): string => `${MAP_API}/terrain/${encodeURIComponent(region)}/{z}/{x}/{y}.webp`;

/** What the terrain is credited with: Mapterhorn, and the open data it is built from (its attribution page lists them). */
export const TERRAIN_CREDIT = "© Mapterhorn";
export const TERRAIN_CREDIT_URL = "https://mapterhorn.com/attribution";

/** CesiumJS's build, served by this server for the playback's photorealistic city (server/cesium.ts); its CESIUM_BASE_URL. */
export const CESIUM_URL = `${EXERCISE_API}/cesium/`;

/** An activity's playback: GET .../activities/<id>/playback (PlaybackTrack). */
export const playbackUrl = (id: string): string => `${ACTIVITIES_API}/${encodeURIComponent(id)}/playback`;

/** The fonts' glyphs, as a MapLibre style names them. */
export const GLYPHS_URL = `${MAP_API}/fonts/{fontstack}/{range}.pbf`;

/** What the maps are credited with, as OpenStreetMap's licence asks wherever one is shown. */
export const MAP_CREDIT = "© OpenStreetMap contributors";
export const MAP_CREDIT_URL = "https://www.openstreetmap.org/copyright";

/**
 * The Fitness aspect's key in the console's registry: its page's address, and its place in the rail. The page was
 * Exercise until the captain renamed it ("we're gonna change exercise to fitness"); the module keeps its id, exercise.
 */
export const FITNESS_ASPECT = "fitness";

/** The address of the Fitness page, or of one activity's page there. */
export const fitnessPath = (activity?: string): string => consolePath(FITNESS_ASPECT) + (activity ? `?${new URLSearchParams({ activity })}` : "");

/** A sport's family, which every source's copies of one activity share. */
export type Family = "run" | "walk" | "ride" | "swim" | "other";

/** A route's shape: points in whole metres east (x) and north (y) of its south-west corner, and its size. */
export interface Shape {
  width: number;
  height: number;
  points: Array<[number, number]>;
}

/**
 * Where a route lies, to lay its shape on a map kept on this Mac: the map's region and highest zoom, and the route's
 * south-west corner in degrees, its shape's origin (a point x metres east and y north of it is at
 * shapeToLngLat(place, shape, [x, y]), viewer/place.ts).
 */
export interface MapPlace {
  region: string;
  maxZoom: number;
  south: number;
  west: number;
}

/** The heart rate shown of an activity, when the captain trusts it. */
export interface HeartRateSummary {
  average: number;
  maximum: number;
  /** The sensor whose heart rate it is, as the captain names it ("Polar H10"); null when he has not said. */
  sensor: string | null;
}

/** What the page calls Rituals, as a source of an activity: the copy of a workout the captain logged there. */
export const RITUALS_SOURCE = "Rituals, as you logged it";

/** A workout as the captain logged it in Rituals: its category, Rituals' title, what he said of it and what that states (the core's RitualsLog, sdk/server.ts). */
export interface RitualsLog {
  /** Rituals' category ("gym push", "bike"). */
  type: string;
  /** Rituals' title for it ("Gym Push", "Bike 44 min"), else its category. */
  title: string;
  /** His words about it (sets, a duration, the zone): content, shown to him alone. */
  details: string;
  /** The minutes it states, when it states one; null otherwise. */
  minutes: number | null;
  /** It says it was zone 2 (and no other zone). */
  zone2: boolean;
}

/** An activity's minutes in zone 2, and what says so: its trusted heart rate's zones, or its Rituals log ("zone 2", its stated minutes). */
export interface Zone2 {
  minutes: number;
  from: "heart-rate" | "rituals";
}

/** One activity as the feed shows it. */
export interface ActivitySummary {
  /** Its address on the page (the shown copy's event in the index, a by-hand run's place, or a Rituals log's day and place). */
  id: string;
  /** When it started, local time, YYYY-MM-DDTHH:MM; only its day, YYYY-MM-DD, when no copy says the time (logged in Rituals alone). */
  start: string;
  /** The sport in words ("Running", "Trail running"). */
  sport: string;
  family: Family;
  /** Its name, by the time of day and the sport, as a feed names an untitled one ("Morning Run"). */
  title: string;
  distanceM: number | null;
  /** From its start to its end; null when nothing says (a Rituals log that states no duration). */
  elapsedS: number | null;
  /** The time spent moving, from its distance over time; its elapsed time when nothing says. */
  movingS: number | null;
  /** Trusted heart rate, or null (see heartRateNote). */
  heartRate: HeartRateSummary | null;
  /** Why no heart rate is shown, when none is: not trusted (a watch's, or a source with no rule), or none recorded. */
  heartRateNote: string | null;
  /** The route, thinned for a thumbnail; null with none. */
  thumb: Shape | null;
  /** Time in each heart-rate zone, trusted only; [] when not trusted or the copy has no zones. */
  zones: Zone[];
  /**
   * Whose zones they are: "archive", counted here from the trusted heart rate's samples by the zones exercise.json sets
   * (ExerciseAnswer's zones); "polar", Polar's own, for a recording with no samples or while exercise.json sets none;
   * null with no zones.
   */
  zonesBy: "archive" | "polar" | null;
  /** Where the route lies, when a map kept on this Mac holds it; null otherwise (no route, or its area's map not downloaded). */
  map: MapPlace | null;
  /** What recorded it, as its source names it ("Polar Flow app"); null when it does not say. */
  recorder: string | null;
  /** The source of the copy shown, credited ("Polar Flow"). */
  source: string;
  /** The other sources that have the same activity. */
  alsoIn: string[];
  /** Its log in Rituals, when the captain logged it there; null otherwise. */
  logged: RitualsLog | null;
  /** Its minutes in zone 2, when known: its trusted heart rate's zones, else a Rituals log saying zone 2 and how long; null otherwise. */
  zone2: Zone2 | null;
}

/** One split: a kilometre (the last, what is left), the moving seconds it took, and its average trusted heart rate. */
export interface Split {
  distanceM: number;
  seconds: number;
  heartRate: number | null;
}

/** A heart-rate zone of the activity: its share of the time in zones (%), its time (m:ss) and lower limit (bpm). */
export interface Zone {
  zone: number;
  share: number;
  time: string | null;
  from: number | null;
}

/** A zone's time ("41:02", "1:02:03") in seconds; null without one. */
export function zoneSeconds(time: string | null): number | null {
  if (time === null || !/^\d+(:\d{2}){1,2}$/.test(time)) return null;
  return time.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

/** One activity in full, for its own page. */
export interface ActivityDetail extends ActivitySummary {
  /** The route, thinned for the page; null with none. */
  route: Shape | null;
  /** Trusted heart rate over time, [seconds from the start, bpm]; [] when not trusted or none. */
  heartRateSeries: Array<[number, number]>;
  /** The lowest trusted heart rate; null without one. */
  minHeartRate: number | null;
  /** Each kilometre, from its distance over time; [] when there is none. */
  splits: Split[];
  /** Polar's link to it, for a run transcribed from one of its share pages; null otherwise. */
  link: string | null;
  /** Why it cannot be deleted from the page, in a sentence for the captain; null when it can. */
  cannotDelete: string | null;
}

/**
 * The photorealistic city the playback may draw (Google's Photorealistic 3D Tiles): through Cesium ion, by the
 * token in the archive's .env.local (CESIUM_ION_TOKEN), else from Google directly by a Maps Platform key
 * (GOOGLE_MAPS_API_KEY); null with neither, and the playback draws the archive's own 3D alone.
 */
export type Photoreal = { via: "cesium-ion"; token: string } | { via: "google"; key: string };

/**
 * GET .../activities/<id>/playback: an activity's route whole, to replay on its area's map in 3D (viewer/playback/).
 * Only for a route inside a map kept on this Mac (`map`), as the route's corner is told the page only then.
 */
export interface PlaybackTrack {
  id: string;
  title: string;
  start: string;
  family: Family;
  /** Each timed point of the route, in order: seconds from the start, degrees, metres so far, and the altitude (m) where recorded. */
  points: { t: number[]; lat: number[]; lon: number[]; distance: number[]; altitude: number[] | null };
  /** The trusted heart rate, every sample, [seconds from the start, bpm]; null when not trusted or none. */
  heartRate: Array<[number, number]> | null;
  /** Each heart-rate zone's lower limit (bpm), trusted only, lowest zone first; [] when none. */
  zones: Array<{ zone: number; from: number }>;
  map: MapPlace;
  /** The region's terrain kept on this Mac, when it is: its highest zoom and its box; null, and the ground is flat. */
  terrain: { maxZoom: number; bbox: [number, number, number, number] } | null;
  photoreal: Photoreal | null;
}

/** What DELETE /life-archive/api/m/exercise/activities/<id> is sent:the activity's start as the page showed it, so a stale page deletes nothing else. */
export interface DeleteActivity {
  start: string;
}

/** What a delete removed: how many copies (index rows), and how many files of them (an export's zip rewritten counts once). */
export interface ActivityDeleted {
  id: string;
  copies: number;
  files: number;
}

/** The weekly zone 2 target, as data/exercise.json sets it (zone2WeeklyMinutes): its minutes, or why there is none. */
export type Zone2Target = { minutes: number } | { minutes: null; why: string };

/**
 * The heart-rate zones exercise.json sets (heartRateZones), which every activity's zones are counted by: the heart
 * rates zones 2 to 5 start at, in bpm, and where they came from ("Sample Clinic, May 2025"); or why there are none, when
 * Polar's own zones are kept.
 */
export type ZoneSettings = { starts: number[]; source: string } | { starts: null; why: string };

export interface ExerciseAnswer {
  /** Today, local, YYYY-MM-DD: the weeks run to it. */
  today: string;
  /** Minutes in zone 2 a week (Monday to Sunday, local), counted from every activity's zone2. */
  zone2Target: Zone2Target;
  /** The zones the activities' zones were counted by. */
  zones: ZoneSettings;
  /** Newest first. */
  activities: ActivitySummary[];
}

/** What the Fitness page's Bryan Johnson tab reads beside the activities: the weekly targets and the habit days its pillars count. */
export const PILLARS_API = `${EXERCISE_API}/pillars`;

/** A weekly target exercise.json sets: its amount, in the target's own unit, or why there is none. */
export type WeeklyTarget = { amount: number } | { amount: null; why: string };

/** The weekly targets exercise.json sets: zone 2's minutes, the gym sessions, and the minutes in zones 4 and 5. */
export interface PillarTargets {
  zone2: WeeklyTarget;
  lift: WeeklyTarget;
  hiit: WeeklyTarget;
}

/** Rituals' habits the pillars count, by Rituals' word: stretching is mobility (planks are not balance). */
export const PILLAR_HABITS = ["stretching"] as const;
export type PillarHabit = (typeof PILLAR_HABITS)[number];

/** How a habit stood on a ritual day: done, not done, not asked that day, or not reported yet. */
export type HabitStatus = "done" | "not_done" | "not_applicable" | "unreported";

/** One ritual day (an evening's date, YYYY-MM-DD) with the pillars' habits' statuses; a habit Rituals did not show that day is left out. */
export interface PillarHabitDay {
  day: string;
  habits: Partial<Record<PillarHabit, HabitStatus>>;
}

/** GET /life-archive/api/m/exercise/pillars: the targets, and each ritual day's habits, oldest first (null with the rituals module off). */
export interface PillarsAnswer {
  /** Today, local, YYYY-MM-DD. */
  today: string;
  targets: PillarTargets;
  habits: PillarHabitDay[] | null;
}
