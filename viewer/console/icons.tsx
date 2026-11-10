// The console's icons: one stroked path each, drawn with the text's colour, so a new aspect names one here and nothing
// else changes. An aspect whose icon the console does not know gets a ring. The kinds of event have one each, for the
// Calendar's cards (calendar/CalendarView.tsx), with the arrows and marks its bar and panel draw, and the rail's grip (an aspect moves). The platforms an
// inspiration comes from have one each too, each its logo's outline in the same stroke (Inspirations' Platforms,
// InspirationsPlatforms.tsx), the web a globe, his own files a picture, and a platform it does not know a link; a tab
// that opens a page elsewhere has an arrow out, and Tables' Edits a pen.
// Friend Map's icon is drawn rather than stroked (DRAWN): a spider, friend-map's Spider web spider at rest seen from
// above, its body filled and its legs stroked, in the text's colour like the rest. An aspect may bring a drawing of its
// own in place of a name (IconDrawing: a private module's mark, which no file here names).
import type { ReactNode } from "react";

export type IconName =
  | "friends" | "health" | "exercise" | "events" | "journal" | "rituals" | "inspirations" | "shopping"
  | "sun" | "moon" | "auto" | "settings" | "search" | "arrow" | "close"
  | "message" | "call" | "hangout" | "llm" | "workout" | "ride" | "walk" | "swim"
  | "prev" | "next" | "chevron" | "check" | "grip"
  | "instagram" | "x" | "youtube" | "tiktok" | "pinterest" | "reddit" | "vimeo" | "threads" | "facebook" | "spotify"
  | "soundcloud" | "behance" | "dribbble" | "web" | "file" | "link"
  | "out" | "edit" | "group";

const PATHS: Record<Exclude<IconName, keyof typeof DRAWN>, string> = {
  health: "M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z",
  exercise: "M3 12h4l3-7 4 14 3-7h4",
  events: "M4 6h16M4 12h16M4 18h10M18 16v4M16 18h4",
  rituals: "M5 12l4 4 10-10M5 20h14",
  inspirations: "M12 3l2.6 5.6L20 9.5l-4 4.1 1 5.9-5-2.8-5 2.8 1-5.9-4-4.1 5.4-.9z",
  shopping: "M5 8h14l-1.2 12H6.2zM9 10V7a3 3 0 0 1 6 0v3",
  // A notebook: its cover, its spine and two lines of writing.
  journal: "M6 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6zM9.5 3v18M13 8h3M13 11.5h3",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  auto: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 3v18M12 7a5 5 0 0 1 0 10",
  // A gear of eight teeth round a hole: the rail's settings.
  settings:
    "M10.57 5.35L10.8 3.08A9 9 0 0 1 13.2 3.08L13.43 5.35A6.8 6.8 0 0 1 15.69 6.29L17.46 4.85A9 9 0 0 1 19.15 6.54L17.71 8.31A6.8 6.8 0 0 1 18.65 10.57L20.92 10.8A9 9 0 0 1 20.92 13.2L18.65 13.43A6.8 6.8 0 0 1 17.71 15.69L19.15 17.46A9 9 0 0 1 17.46 19.15L15.69 17.71A6.8 6.8 0 0 1 13.43 18.65L13.2 20.92A9 9 0 0 1 10.8 20.92L10.57 18.65A6.8 6.8 0 0 1 8.31 17.71L6.54 19.15A9 9 0 0 1 4.85 17.46L6.29 15.69A6.8 6.8 0 0 1 5.35 13.43L3.08 13.2A9 9 0 0 1 3.08 10.8L5.35 10.57A6.8 6.8 0 0 1 6.29 8.31L4.85 6.54A9 9 0 0 1 6.54 4.85L8.31 6.29A6.8 6.8 0 0 1 10.57 5.35zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5",
  arrow: "M5 12h14M13 6l6 6-6 6",
  close: "M6 6l12 12M18 6L6 18",
  message: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z",
  call: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
  hangout: "M5 8h11v6a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM16 10h2a2 2 0 0 1 0 4h-2M7 4v2M10 3v3M13 4v2",
  llm: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  workout: "M14 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM6 12l5-3 3 2 3-1M11 9l-1 5 3 2v5M10 14l-3 2-2 4",
  ride: "M6 18a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM18 18a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM6 14.5l4-6.5h5l3 6.5M10 8l2.5 6.5H6M14 5h2.5",
  walk: "M13 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM12.5 9l-2 5 2.5 2 1 5M12.5 9l2.5 3 2.5 1M12.5 9l-3 1.5-1 3M10.5 14l-2 7",
  swim: "M3 17c2 0 2-1.5 4.5-1.5S10 17 12 17s2.5-1.5 4.5-1.5S19 17 21 17M3 21c2 0 2-1.5 4.5-1.5S10 21 12 21s2.5-1.5 4.5-1.5S19 21 21 21M16 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM6 13l4-4 3 3",
  prev: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  chevron: "M6 9l6 6 6-6",
  check: "M5 12l4 4 10-10",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  instagram: "M7.5 3h9A4.5 4.5 0 0 1 21 7.5v9a4.5 4.5 0 0 1-4.5 4.5h-9A4.5 4.5 0 0 1 3 16.5v-9A4.5 4.5 0 0 1 7.5 3zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM17.2 6.8h.01",
  x: "M4 4h4.5L20 20h-4.5zM19.5 4l-6.6 7.3M4.5 20l6.6-7.3",
  youtube: "M7 5h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4zM10 9v6l5-3z",
  tiktok: "M13.5 3v12a3.5 3.5 0 1 1-3.5-3.5M13.5 3c.3 2.6 2.2 4.5 5 4.8",
  pinterest: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12.3 9.5L9.8 21M10.6 14.5c3.8 1.3 6.4-.8 6.4-3.6C17 8.3 14.8 6.5 12 6.5c-3.2 0-5 2.1-5 4.6 0 1.1.4 2.1 1.1 2.6",
  reddit: "M12 20c4.4 0 8-2.4 8-5.5S16.4 9 12 9s-8 2.4-8 5.5S7.6 20 12 20zM12 9l1.3-5 4.2 1M18.5 6h.01M9 14h.01M15 14h.01M9.5 16.8c1.6.8 3.4.8 5 0M4.6 11.6a2 2 0 1 1 2.3-2.4M19.4 11.6a2 2 0 1 0-2.3-2.4",
  vimeo: "M3 8.8L4.6 7.5c1.4-1 2.4-.6 2.9 1.2l1.6 6.6c.6 2.4 1.4 2.6 2.7 1C15.2 12.1 18.6 8 19 6.1c.4-2.1-2.4-2.5-4.5-.4",
  threads: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM16 8.5v5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.6 7.2",
  facebook: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 7.5H14a2.5 2.5 0 0 0-2.5 2.5v11M8.5 12.5h6.5",
  spotify: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM7 9.5c3.4-1 7.4-.6 10 1.1M7.6 12.8c2.8-.8 5.8-.4 8 .9M8.2 16c2.2-.6 4.3-.3 6 .7",
  soundcloud: "M14 17V7.5a5 5 0 0 1 5 4.6 2.5 2.5 0 0 1 0 4.9zM11 17V8.5M8 17v-6M5 17v-4M2 17v-2",
  behance: "M3 6h5a3 3 0 0 1 0 6H3zM3 12h5.5a3 3 0 0 1 0 6H3zM15 7h5M14 14h7a3.5 3.5 0 1 0-1 2.6",
  dribbble: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM6.4 5c3.6 3.9 6.4 9.4 7.6 15.7M3.1 10.3c5.3.8 11.4-.6 14.9-5.2M8.7 20.4c1.7-4.1 6.2-7 12.2-6",
  web: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.4 2.6 3.7 5.6 3.7 9s-1.3 6.4-3.7 9M12 3C9.6 5.6 8.3 8.6 8.3 12s1.3 6.4 3.7 9",
  file: "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 18M15.5 9h.01",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  out: "M8 16L16 8M10 8h6v6",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  group: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M16 11a2.5 2.5 0 1 0 0-5M17.5 20H21a5 5 0 0 0-4.5-5",
};

// Friend Map's spider: friend-map's Spider web spider at rest (its webRig.ts's own pose: hip, knee, ankle and foot of
// each leg) seen from above and mirrored, its abdomen, shield and head webSpider.ts's shapes drawn larger to read at 16 px.
const SPIDER_LEGS =
  "M13.16 10.89L15.09 9.68L16.54 5.42L16.85 3.58M10.84 10.89L8.91 9.68L7.46 5.42L7.15 3.58M13.2 11.42L16.31 12.07L19.71 9.07L20.88 7.23M10.8 11.42L7.69 12.07L4.29 9.07L3.12 7.23M13" +
  ".2 11.96L15.77 14.5L20.3 14.53L22.46 13.92M10.8 11.96L8.23 14.5L3.7 14.53L1.54 13.92M13.16 12.49L14.54 15.85L17.61 19.15L19.22 20.58M10.84 12.49L9.46 15.85L6.39 19.15L4.78 20.58";
const SPIDER_ABDOMEN =
  "M11.36 13.68Q12 13.42 12.64 13.68Q13.28 13.94 13.67 14.77Q14.05 15.61 13.92 16.5Q13.8 17.4 13.35 18.11Q12.9 18.81 12.45 19.01Q12 19.2 11.55 19.01Q11.1 18.81 10.65 18.11Q10.2 17.4 10.08 16.5Q9.95 15.61 10.33 14.77Q10.72 13.94 11.36 13.68Z";
const SPIDER_THORAX =
  "M11.49 10.51Q12 10.28 12.51 10.51Q13.03 10.73 13.28 11.37Q13.54 12.01 13.41 12.59Q13.28 13.17 12.96 13.39Q12.64 13.62 12 13.62Q11.36 13.62 11.04 13.39Q10.72 13.17 10.59 12.59Q10.46 12.01 10.72 11.37Q10.97 10.73 11.49 10.51Z";

const DRAWN = {
  friends: {
    viewBox: "0 0 24 24",
    body: (
      <>
        <path d={SPIDER_LEGS} strokeWidth="1.35" />
        <g fill="currentColor" stroke="none">
          <path d={SPIDER_ABDOMEN} />
          <path d={SPIDER_THORAX} />
          <ellipse cx="12" cy="9.58" rx="1.03" ry="1.41" />
        </g>
      </>
    ),
  },
} satisfies Partial<Record<IconName, IconDrawing>>;

/** An icon drawn rather than named: its box and what is drawn in it, as an aspect may bring its own (a module's mark). */
export interface IconDrawing {
  readonly viewBox: string;
  readonly body: ReactNode;
}

/** The icon `name` names, or the drawing it is. */
export function Icon({ name, className = "" }: { name: IconName | IconDrawing; className?: string }) {
  const drawn = typeof name === "object" ? name : name in DRAWN ? DRAWN[name as keyof typeof DRAWN] : undefined;
  return (
    <svg className={`icon ${className}`.trim()} viewBox={drawn?.viewBox ?? "0 0 24 24"} aria-hidden="true" focusable="false">
      {drawn?.body ?? <path d={PATHS[name as keyof typeof PATHS] ?? "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"} />}
    </svg>
  );
}
