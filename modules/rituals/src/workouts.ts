// Workout categories and titles. `type` is the category (indexed with date); `title` is a short, glanceable label.
export const WORKOUT_TITLE_SQL = "ALTER TABLE workouts ADD COLUMN title TEXT;";

const CATEGORY_ALIASES: Record<string, string> = {
  "bike ride": "bike",
  cycling: "bike",
  cycle: "bike",
  running: "run",
  jog: "run",
};

/** Lower-case, single-spaced category; a few well-known synonyms fold into one category. Everything else stays open text. */
export const normaliseCategory = (type: string): string => {
  const clean = type.trim().replace(/\s+/g, " ").toLowerCase();
  return CATEGORY_ALIASES[clean] ?? clean;
};

const trimNumber = (n: number): string => String(Number(n.toFixed(2)));

/** Total minutes only when the details state a duration unambiguously; otherwise null (never guessed). */
export const minutesOf = (details: string): number | null => {
  const found = [...details.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|min|m)\b/gi)];
  if (found.length !== 1) return null;
  const [, amount, unit] = found[0] as unknown as [string, string, string];
  return /^h/i.test(unit) ? Number(amount) * 60 : Number(amount);
};

/** Kilometres only when the details state one distance unambiguously; otherwise null. */
export const kilometresOf = (details: string): number | null => {
  const found = [...details.matchAll(/(\d+(?:\.\d+)?)\s*(kilometres?|kilometers?|kms?|k)\b/gi)];
  if (found.length !== 1) return null;
  return Number((found[0] as unknown as [string, string])[1]);
};

const capitalise = (words: string): string => words.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** "Gym Push" / "Bike 30 min" / "Run 8k"; null when the category or details do not settle one. */
export const deriveTitle = (category: string, details: string): string | null => {
  if (/^gym \S+$/.test(category)) return capitalise(category);
  if (category === "bike") {
    const minutes = minutesOf(details);
    return minutes === null ? null : `Bike ${trimNumber(minutes)} min`;
  }
  if (category === "run") {
    const km = kilometresOf(details);
    return km === null ? null : `Run ${trimNumber(km)}k`;
  }
  return null;
};
