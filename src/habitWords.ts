// How a habit done is said, as a moment of the captain's day (the Events calendar's Rituals cards and the Rituals tab
// of events, modules/rituals/server/habitsTab.ts): "Magnesium", "Protein", "Plank", "Stretch", "Journal" (the captain: "use these labels: Protein, Magnesium, Plank X:XX,
// Stretch, Journal"); a plank held a known time is "Plank 1:15".
// The habits are rituals' own words for them (magnesium, protein, stretching, planks, journalling); one rituals adds
// later is said by its name ("cold_shower" is "Cold shower"), and a required check on a day's rituals by its id.

/** What the wind-down habit is called wherever the console shows it (the captain: "winding down before midnight"). Its id stays `wind_down`. */
export const WIND_DOWN_NAME = "Winding down before midnight";

/** What doing each of rituals' habits is called. */
export const HABIT_DOINGS: Readonly<Record<string, string>> = {
  magnesium: "Magnesium",
  protein: "Protein",
  stretching: "Stretch",
  planks: "Plank",
  journalling: "Journal",
  wind_down: WIND_DOWN_NAME,
};

/**
 * "Magnesium": a habit done, in words; one with no wording of its own by its name in words, as is a required check by
 * its id ("morning-priority-review" is "Morning priority review").
 */
export function habitDoing(habit: string): string {
  const words = habit.replace(/[_-]+/g, " ").trim();
  return HABIT_DOINGS[habit] ?? words.charAt(0).toUpperCase() + words.slice(1);
}

/** "1:15" for 75 seconds: how long a plank was held, in minutes and seconds, as rituals writes it. */
export function heldText(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
