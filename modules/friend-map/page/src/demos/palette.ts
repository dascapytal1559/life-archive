// Colours shared by the demo views, tuned for their dark background. The
// same values are CSS variables on .demos (demos.css) for use in stylesheets.

export const COLORS = {
  /** The page background, and ink on light marks. */
  night: "#070b16",
  /** Light text and marks. */
  star: "#e8eefc",
  /** Secondary text, axes, guides. */
  dim: "#8d97ad",
  /** You, and the other person, wherever the two are told apart. */
  me: "#f4b860",
  them: "#6fd0c6",
  /** Moving in and moving out (Orbits' comet trails). */
  warm: "#ff9e5e",
  cool: "#6aa8ff",
  /** A person in no friend group. */
  loner: "#8a93a6",
};

/** One colour per friend group (DemoPerson.community), biggest group first. */
const COMMUNITY = [
  "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#a6da95", "#f5a97f",
  "#8bd5ca", "#b7bdf8", "#eed49f", "#91d7e3", "#f0c6c6", "#c6a0f6",
];

export function communityColor(community: number): string {
  return community < 0 ? COLORS.loner : COMMUNITY[community % COMMUNITY.length];
}
