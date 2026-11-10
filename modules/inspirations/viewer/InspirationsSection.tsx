// Inspirations in the console: the Inspirations page's view (InspirationsView.tsx), wrapped, with the console's blocks
// above it, in the module's own stylesheet (inspirations.css). Each of its own tabs (tabs.ts: Platforms, Recent, By tag, Search,
// Untagged, Tags, Changes) is one view under the Inspirations aspect, Platforms the aspect's address itself (the
// console's chart, InspirationsPlatforms.tsx, each bar opening Recent narrowed to it); what a tab is narrowed to,
// its list's page and the item open stay in the address's query, as on the old page, under the console's address
// (InspirationsView's `tabPath`). Above every tab, the counts the view fetched once: the items, the untagged, the
// hidden, his tags and the AI's. The view is the old page's code, the one in the console that writes (its own items
// and tags, each edit a changeset with Undo).

import { NO_INSPIRATION_FILTER, type InspirationTagsAnswer } from "../wire.ts";
import { InspirationsView } from "./InspirationsView.tsx";
import { INSPIRATIONS_TABS, inspirationsAddress, type InspirationsTab } from "./tabs.ts";
import { consolePath, Kpi, Kpis, LOCALE, type View } from "../../../sdk/viewer.ts";
import { InspirationsPlatforms } from "./InspirationsPlatforms.tsx";
import "./inspirations.css";

/** The Inspirations aspect's key in the registry. */
export const INSPIRATIONS_ASPECT = "inspirations";

const BLURBS: Record<InspirationsTab["key"], string> = {
  "": "How many platforms your inspirations come from, and how many each gives.",
  recent: "Everything kept, newest first, or one platform's; the hidden behind a switch.",
  "by-tag": "Narrowed to every tag picked, yours or the AI's.",
  search: "Words found in your caption, the title, author, description, link and tags.",
  untagged: "What you have not tagged yet.",
  tags: "Your vocabulary: rename, merge, order, describe, delete.",
  changes: "Every change to inspirations, each with Undo.",
};

/** The address of an Inspirations tab in the console: Platforms is the aspect's own. */
export const inspirationsPath = (tab: InspirationsTab): string => consolePath(INSPIRATIONS_ASPECT, tab.key || undefined);

const RECENT_TAB = INSPIRATIONS_TABS.find((tab) => tab.key === "recent")!;

/** The address of Recent narrowed to `platform`. */
export const platformPath = (platform: string): string => inspirationsAddress(inspirationsPath(RECENT_TAB), RECENT_TAB, { ...NO_INSPIRATION_FILTER, platform }, null);

/** The Inspirations views: one for each of its own tabs, in their order. */
export function inspirationsViews(): View[] {
  return INSPIRATIONS_TABS.map((tab) => ({
    key: `inspirations-${tab.key || "platforms"}`,
    label: tab.label,
    aspects: [INSPIRATIONS_ASPECT],
    section: tab.key || "platforms",
    blurb: BLURBS[tab.key],
    component: () => (
      <InspirationsView
        tab={tab}
        tabPath={inspirationsPath}
        above={(tags) => <InspirationsBlocks tags={tags} />}
        home={(tags) => <InspirationsPlatforms tags={tags} recentPath={platformPath} />}
      />
    ),
  }));
}

/** The console's blocks above an Inspirations tab: what is kept, and the tags. */
export function InspirationsBlocks({ tags }: { tags: InspirationTagsAnswer }) {
  const tagged = tags.total - tags.untagged;
  return (
    <Kpis label="Inspirations">
      <Kpi label="Inspirations" value={tags.total.toLocaleString(LOCALE)} note="hidden ones aside" tone="accent" />
      <Kpi label="Tagged" value={tagged.toLocaleString(LOCALE)} note={tags.total > 0 ? `${Math.round((tagged / tags.total) * 100)}% have your tags` : "nothing kept yet"} />
      <Kpi label="Untagged" value={tags.untagged.toLocaleString(LOCALE)} note="none of your tags yet" />
      <Kpi label="Hidden" value={tags.hidden.toLocaleString(LOCALE)} note="behind the switch" />
      <Kpi label="Your tags" value={tags.tags.length.toLocaleString(LOCALE)} note={`${tags.aiTags.length.toLocaleString(LOCALE)} the AI's in use`} />
    </Kpis>
  );
}
