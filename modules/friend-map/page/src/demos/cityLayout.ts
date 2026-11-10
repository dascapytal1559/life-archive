// The geometry behind City (City.tsx): the same closeness as Orbits, built as a
// radial city. Your tower stands in the middle, whoever you live with (tagged
// "live-together") has a lit floor in it, and everyone else is a building on
// the ground round it, nearer the tower the closer they are: the distance is
// their closeness rank on the very scale Orbits uses (rankFraction in
// orbitsLayout.ts), so the two views agree on who is near. Ring roads
// (avenues) mark the closest 10, 25, 50 and so on, as Orbits' guide rings do,
// and four straight boulevards run out from the tower; buildings keep off
// both. A building's height is their closeness score itself, on a log scale,
// and its footprint how much you have talked; both taper away with rank past
// the closest few hundred, to dots at the edge. Pure functions, no DOM, so
// the city can be laid out and tested with made-up people. How it is built in
// 3D and seen is cityScene.ts.
//
// Coordinates: the ground is a map seen from above, x to the right and y down
// as on Orbits, the tower at (0, 0), in ground units.

import { directions, rankFraction, rings } from "./orbitsLayout.ts";

/** How far beyond the last avenue the outskirts lie: buildings for people with no closeness yet. */
export const OUTSKIRTS = 16;

/**
 * How far from the tower someone ranked `rank` of `count` by closeness stands:
 * `inner` for the closest, `outer` for the last, on Orbits' eased log scale
 * of the rank (rankFraction), as if the first `together` ranks (whoever lives
 * with you, who are in the tower) were not there, so tagging someone
 * moves nobody else. Rank 0 (no closeness yet) is the outskirts.
 */
export function plotRadius(rank: number, inner: number, outer: number, count: number, together = 0): number {
  if (rank <= 0) return outer + OUTSKIRTS;
  return inner + (outer - inner) * rankFraction(rank - together, count - together);
}

/** The ring roads: one round the closest 10, 25, 50 and so on, as far as there are people to fill them (Orbits' rings). */
export function avenues(count: number, inner: number, outer: number, together = 0): Array<{ rank: number; r: number; label: string }> {
  return rings(count).map((ring) => ({ rank: ring.rank, r: plotRadius(ring.rank, inner, outer, count, together), label: ring.label }));
}

/** Half an avenue's width, in ground units: buildings keep this far off its centre line, and their own half-diagonal more. */
export const AVENUE_HALF = 3;

/** The tallest building (the top closeness score) and the lowest (no closeness yet), as shares of the city's radius. */
export const TALLEST = 0.38;
export const LOWEST = 0.014;

/**
 * How tall someone's building is, in ground units: their closeness `score`
 * against the highest on the map (`top`), on a log scale, from LOWEST of
 * `outer` for no score to TALLEST of it for the top score, so the skyline
 * shows how strongly each friendship scores, not only its rank.
 */
export function buildingHeight(score: number, top: number, outer: number): number {
  const low = outer * LOWEST;
  if (score <= 0 || top <= 0) return low;
  return low + (outer * TALLEST - low) * Math.min(1, Math.log1p(score) / Math.log1p(top));
}

/** The widest and narrowest footprints, as shares of the city's radius. */
export const WIDEST = 0.03;
export const NARROWEST = 0.012;

/**
 * Half the diagonal of someone's footprint, in ground units: by how much you
 * have talked (`total` messages against the most anyone has, `top`), on a
 * square-root scale, so the biggest footprint is a few times the smallest.
 */
export function footprint(total: number, top: number, outer: number): number {
  const [low, high] = [outer * NARROWEST, outer * WIDEST];
  if (total <= 0 || top <= 0) return low;
  return low + (high - low) * Math.sqrt(Math.min(1, total / top));
}

/**
 * The taper: how much smaller a building is for standing far out. The closest
 * few hundred are full size; past the knee they shrink, smoothly, to dots.
 * TAPER_KNEE is the rank at which a building is halfway between full size and
 * a dot, TAPER_STEEP how sharply the curve turns there (a higher power turns
 * more sharply; 1 would be a long, lazy slope), and TAPER_DOT how big a dot
 * is, as a share of full size, so the furthest building is still a mark on
 * the ground.
 */
export const TAPER_KNEE = 500;
export const TAPER_STEEP = 5;
export const TAPER_DOT = 0.1;

/**
 * How big someone ranked `rank` by closeness is, as a share of full size, on
 * a logistic curve in the rank: TAPER_DOT + (1 − TAPER_DOT) / (1 + (rank /
 * TAPER_KNEE)^TAPER_STEEP). Full size for the closest (1 at rank 1, 0.97 at
 * 250), half at the knee (0.55 at 500), and a dot past it (0.13 at 1000, the
 * floor by 2000), with no step anywhere. It scales footprint and height
 * alike, so volume goes as its cube. Rank 0 (no closeness yet) counts as the
 * last rank, `count`: the outskirts are as far out as anyone.
 */
export function taper(rank: number, count: number): number {
  const r = rank > 0 ? rank : Math.max(1, count);
  return TAPER_DOT + (1 - TAPER_DOT) / (1 + (r / TAPER_KNEE) ** TAPER_STEEP);
}

/** The tower's half-diagonal, as a share of the closest building's distance. */
export const TOWER_SHARE = 0.5;
/** The tower's height, as a share of the city's radius: over the tallest building. */
export const TOWER_HEIGHT = 0.46;
/** Nothing stands nearer the tower than this share of `inner` (its edge): a plaza round the tower. */
export const PLAZA = 0.74;

/** Someone to place: their closeness rank now (0 for none), score, how much you have talked, and whether they live with you. */
export interface Resident {
  id: number;
  name: string;
  rank: number;
  closeness: number;
  total: number;
  together: boolean;
}

/** A building: where it stands (ground units, from the tower), its half-diagonal `s`, height `h`, and whose. */
export interface Plot {
  id: number;
  x: number;
  y: number;
  /** Distance from the tower and direction, as placed (nudged a little from the true `orbit`). */
  r: number;
  angle: number;
  /** The distance their rank alone gives (plotRadius). */
  orbit: number;
  s: number;
  h: number;
  rank: number;
  /** No closeness yet: the outskirts. */
  silent: boolean;
}

/** A floor of the tower: whose, and how far up its bottom and top are, in ground units. */
export interface Floor {
  id: number;
  bottom: number;
  top: number;
}

export interface Tower {
  s: number;
  h: number;
  /** Whoever lives with you, lowest floor first, closest at the top. */
  floors: Floor[];
}

export interface CityLayout {
  plots: Map<number, Plot>;
  tower: Tower;
  avenues: Array<{ rank: number; r: number; label: string }>;
  /** The people in the tower, as ranked. */
  together: number[];
}

/** Room kept between two buildings' circumscribed circles, in ground units. */
const SPACING = 2;

/**
 * The boulevards: BOULEVARDS straight roads from the tower out past the
 * outskirts, evenly round it, the first running north (up the map), where A to
 * Z begins as it does on Orbits, so the City stands everyone in Orbits' own
 * directions, only squeezed a little within each quarter to leave the roads
 * clear. Their angles are radians clockwise from east, as the map has them
 * (y down): north is −π/2.
 */
export const BOULEVARDS = 4;
export const BOULEVARD_ANGLES: readonly number[] = Array.from({ length: BOULEVARDS }, (_, i) => -Math.PI / 2 + (i * 2 * Math.PI) / BOULEVARDS);
/** Half a boulevard's width, in ground units: buildings keep this far off its centre line, and their own half-diagonal more. */
export const BOULEVARD_HALF = 8;
/** The boulevard the avenues are labelled on, where it crosses each: the one running south, toward where the city is first seen from. */
export const LABEL_BOULEVARD = Math.PI / 2;

/** How far a point is from the nearest boulevard's centre line, in ground units (behind the tower a boulevard is not there). */
export function offBoulevards(x: number, y: number): number {
  let least = Infinity;
  for (const angle of BOULEVARD_ANGLES) {
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    if (x * c + y * s <= 0) continue;
    least = Math.min(least, Math.abs(-x * s + y * c));
  }
  return least;
}

/**
 * Orbits' direction `aim` (A to Z clockwise from north, round the whole
 * circle) for a building of half-diagonal `size` on a ring of radius `r`,
 * squeezed into its quarter between two boulevards so its footprint clears
 * both; its reach either way stays within the quarter. Order round the ring
 * is kept, so A to Z still runs clockwise.
 */
export function betweenBoulevards(aim: { angle: number; lo: number; hi: number }, r: number, size: number): { angle: number; lo: number; hi: number } {
  const quarter = (2 * Math.PI) / BOULEVARDS;
  // Where the direction falls round the circle from north, 0 to 1, and in which quarter.
  const f = Math.min(1, Math.max(0, (aim.angle + Math.PI / 2) / (2 * Math.PI)));
  const i = Math.min(BOULEVARDS - 1, Math.floor(f * BOULEVARDS));
  const clear = Math.min(quarter / 2 - 1e-3, Math.asin(Math.min(1, (BOULEVARD_HALF + size) / Math.max(r, 1e-9))));
  const start = BOULEVARD_ANGLES[i] + clear;
  const span = quarter - 2 * clear;
  const at = (local: number) => start + span * Math.min(1, Math.max(0, local));
  const local = f * BOULEVARDS - i;
  const perRadian = BOULEVARDS / (2 * Math.PI);
  return { angle: at(local), lo: at(local - (aim.angle - aim.lo) * perRadian), hi: at(local + (aim.hi - aim.angle) * perRadian) };
}

/**
 * The city laid out: the tower, with a floor for each person who lives with
 * you, and a building for everyone else, each on the distance their
 * rank gives, in Orbits' directions (A to Z clockwise from north) squeezed
 * between the boulevards (betweenBoulevards), pushed apart only as far as it
 * takes to stop them overlapping, each within the band between the avenues
 * its rank falls between (placeInBands), so which side of "top 10" someone
 * stands on is always their rank's, and never on a boulevard. Nothing
 * stands nearer the tower than the plaza. Footprint and height taper away
 * with rank (taper). The tower's floors stack by rank, the closest at the top.
 */
export function layoutCity(residents: readonly Resident[], { inner, outer }: { inner: number; outer: number }): CityLayout {
  const count = residents.length;
  const together = residents.filter((p) => p.together).sort((a, b) => a.rank - b.rank || a.id - b.id).map((p) => p.id);
  const ground = residents.filter((p) => !p.together);
  const topScore = Math.max(0, ...ground.map((p) => p.closeness));
  const topTotal = Math.max(0, ...ground.map((p) => p.total));
  const roads = avenues(count, inner, outer, together.length);
  // Orbits' directions round the whole circle, each with a wider reach round its orbit than Orbits gives (buildings are
  // broad, and sliding along is better than stepping out), then squeezed between the boulevards at its own distance.
  const aim = directions(ground, 0, SLIDE);
  const bodies = ground.map((p) => {
    const orbit = plotRadius(p.rank, inner, outer, count, together.length);
    const size = footprint(p.total, topTotal, outer) * taper(p.rank, count) + SPACING / 2;
    return { id: p.id, orbit, size, band: bandOf(p.rank, roads, inner * PLAZA, outer + OUTSKIRTS + OUTSKIRTS_ROOM), ...betweenBoulevards(aim.get(p.id)!, orbit, size) };
  });
  const placed = placeInBands(bodies);
  const plots = new Map<number, Plot>();
  for (const p of ground) {
    const body = placed.get(p.id)!;
    plots.set(p.id, {
      id: p.id,
      x: Math.cos(body.angle) * body.r,
      y: Math.sin(body.angle) * body.r,
      r: body.r,
      angle: body.angle,
      orbit: plotRadius(p.rank, inner, outer, count, together.length),
      s: body.size - SPACING / 2,
      h: buildingHeight(p.closeness, topScore, outer) * taper(p.rank, count),
      rank: p.rank,
      silent: p.rank <= 0,
    });
  }
  return { plots, tower: tower(together, inner, outer), avenues: roads, together };
}

/** How many spaces either way a building may slide round its orbit to clear an overlap (Orbits gives 2.5). */
const SLIDE = 12;
/** How far beyond the outskirts' own distance their slabs may be pushed. */
const OUTSKIRTS_ROOM = 40;

/** The ring of ground a building may stand in: between two avenues (clear of both), or inside the first, or beyond the last. */
export interface Band {
  lo: number;
  hi: number;
}

/**
 * The band for someone ranked `rank`: from the avenue their rank is just
 * outside (or `plaza`, the nearest anyone comes to the tower) to the one it
 * is just inside (or `edge`, the furthest anyone may stand), each AVENUE_HALF
 * clear of the road itself. Rank 0, no closeness yet, is beyond the last avenue.
 */
export function bandOf(rank: number, roads: ReadonlyArray<{ rank: number; r: number }>, plaza: number, edge: number): Band {
  let lo = plaza;
  let hi = edge;
  for (const road of roads) {
    if (rank > 0 && rank < road.rank) hi = Math.min(hi, road.r - AVENUE_HALF);
    else lo = Math.max(lo, road.r + AVENUE_HALF);
  }
  return { lo, hi };
}

/** A building to place: its orbit, direction (with the reach it may slide), size (half-diagonal, with spacing), and band. */
export interface Lot {
  id: number;
  orbit: number;
  angle: number;
  lo: number;
  hi: number;
  size: number;
  band: Band;
}

export interface Stood {
  id: number;
  angle: number;
  r: number;
  size: number;
  x: number;
  y: number;
}

/** How many times a band that cannot hold its buildings has them shrunk, and by how much each time. */
const SHRINK_ROUNDS = 3;
const SHRINK = 0.85;
/** A band is too full when this share of its buildings (at least two) found no free spot. */
const CROWDED_SHARE = 0.04;
/** How far, in ground units, a building may be set in or out from its orbit to find room, and the step between tries. */
const DODGE = 70;
const DODGE_STEP = 2;

/**
 * Buildings stood in their bands, the closest first: each takes its own spot
 * (its orbit, in its direction) if that is free of everyone stood already
 * and of the boulevards, and otherwise the nearest free spot to it, trying
 * small steps in or out along its spoke and a little round the ring (within
 * its reach), always within its band (never across an avenue: an avenue
 * means what it says).
 * So the closest few stand exactly where their rank puts them, and the crowd
 * further out dodges round them. A band too full to hold its buildings at
 * their size (the long tail of a decade of history, crammed into the outer
 * bands) has them all shrunk by SHRINK, up to SHRINK_ROUNDS times, until
 * they fit; what is left overlapping is stood on its own spot anyway.
 * Deterministic; only near neighbours are compared (through a grid), so
 * hundreds place in a few milliseconds.
 */
export function placeInBands(lots: readonly Lot[]): Map<number, Stood> {
  const sizes = new Map(lots.map((l) => [l.id, l.size]));
  let stood = new Map<number, Stood>();
  for (let round = 0; round <= SHRINK_ROUNDS; round++) {
    const placed = stand(lots.map((l) => ({ ...l, size: sizes.get(l.id)! })));
    stood = placed.stood;
    if (placed.crowded.size === 0 || round === SHRINK_ROUNDS) break;
    for (const lot of lots) if (placed.crowded.has(bandKey(lot.band))) sizes.set(lot.id, sizes.get(lot.id)! * SHRINK);
  }
  return stood;
}

const bandKey = (band: Band) => `${band.lo}:${band.hi}`;

/** The tries, nearest first: in or out along the spoke by `dr`, and round the ring by `da` (as a share of the reach either way). */
const TRIES: Array<{ dr: number; da: number }> = (() => {
  const tries: Array<{ dr: number; da: number; cost: number }> = [];
  for (let dr = -DODGE; dr <= DODGE; dr += DODGE_STEP) {
    for (let i = -8; i <= 8; i++) tries.push({ dr, da: i / 8, cost: Math.abs(dr) + Math.abs(i) * 6 });
  }
  return tries.sort((a, b) => a.cost - b.cost || a.dr - b.dr || a.da - b.da).map(({ dr, da }) => ({ dr, da }));
})();

/** One pass of standing everyone, closest first (by orbit, then id): where each stands, and the bands too full. */
function stand(lots: readonly Lot[]): { stood: Map<number, Stood>; crowded: Set<string> } {
  const order = [...lots].sort((a, b) => a.orbit - b.orbit || a.id - b.id);
  const most = Math.max(1, ...lots.map((l) => l.size));
  const cells = grid(2 * most);
  const placed: Stood[] = [];
  const stuck = new Map<string, number>();
  const members = new Map<string, number>();
  for (const lot of order) {
    const key = bandKey(lot.band);
    members.set(key, (members.get(key) ?? 0) + 1);
    const { lo, hi } = lot.band;
    const least = Math.min(lo + lot.size, (lo + hi) / 2);
    const greatest = Math.max(hi - lot.size, (lo + hi) / 2);
    const own = { r: Math.min(Math.max(lot.orbit, least), greatest), angle: lot.angle };
    let found: { r: number; angle: number } | null = null;
    for (const { dr, da } of TRIES) {
      const r = own.r + dr;
      if (r < least || r > greatest) continue;
      const angle = da < 0 ? lot.angle + (lot.angle - lot.lo) * da : lot.angle + (lot.hi - lot.angle) * da;
      const [x, y] = [Math.cos(angle) * r, Math.sin(angle) * r];
      let clear = offBoulevards(x, y) >= BOULEVARD_HALF + lot.size;
      if (clear) cells.near(x, y, (j) => {
        const o = placed[j];
        if (Math.hypot(o.x - x, o.y - y) < o.size + lot.size) {
          clear = false;
          return true;
        }
      });
      if (clear) {
        found = { r, angle };
        break;
      }
    }
    if (!found) stuck.set(key, (stuck.get(key) ?? 0) + 1);
    const at = found ?? own;
    const node = { id: lot.id, angle: at.angle, r: at.r, size: lot.size, x: Math.cos(at.angle) * at.r, y: Math.sin(at.angle) * at.r };
    cells.add(node.x, node.y, placed.length);
    placed.push(node);
  }
  const crowded = new Set([...stuck].filter(([band, n]) => n >= Math.max(2, CROWDED_SHARE * (members.get(band) ?? 0))).map(([band]) => band));
  return { stood: new Map(placed.map((n) => [n.id, n])), crowded };
}

/** Points bucketed into square cells `size` wide, to find those near a spot without looking at all of them (as Orbits' layout does). */
function grid(size: number) {
  const cells = new Map<number, number[]>();
  const key = (i: number, j: number) => (i + 32_768) * 65_536 + (j + 32_768);
  return {
    add(x: number, y: number, item: number): void {
      const k = key(Math.floor(x / size), Math.floor(y / size));
      const list = cells.get(k);
      if (list) list.push(item);
      else cells.set(k, [item]);
    },
    near(x: number, y: number, visit: (item: number) => boolean | void): void {
      const ci = Math.floor(x / size);
      const cj = Math.floor(y / size);
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (let j = cj - 1; j <= cj + 1; j++) {
          for (const item of cells.get(key(i, j)) ?? []) if (visit(item) === true) return;
        }
      }
    },
  };
}

/** The share of the tower's height its floors fill, from the ground up; the rest is its crown. */
const FLOORS_SHARE = 0.78;
/** The tallest a floor is, in ground units, so two people do not each get half a skyscraper. */
const FLOOR_MOST = 26;

/** The tower for `together` (ranked, closest first): its footprint and height, and a floor each, the closest at the top. */
export function tower(together: readonly number[], inner: number, outer: number): Tower {
  const s = inner * TOWER_SHARE;
  const h = outer * TOWER_HEIGHT;
  const n = together.length;
  const each = n === 0 ? 0 : Math.min(FLOOR_MOST, (h * FLOORS_SHARE) / n);
  // Lowest floor first: the last of them at the bottom, the closest on top.
  const floors = [...together].reverse().map((id, i) => ({ id, bottom: each * i, top: each * (i + 1) }));
  return { s, h, floors };
}

/**
 * Who sends light down the roads: someone you have talked with in the last
 * `days` days, with their phase round the loop (from their id, so the traffic
 * does not all set off together).
 */
export function traffic(people: ReadonlyArray<{ id: number; daysSince: number | null }>, days: number): Array<{ id: number; phase: number }> {
  return people
    .filter((p) => p.daysSince !== null && p.daysSince <= days)
    .map((p) => ({ id: p.id, phase: ((p.id * 0.6180339887) % 1 + 1) % 1 }));
}
