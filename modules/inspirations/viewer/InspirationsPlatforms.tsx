// Inspirations' Platforms, the aspect's first view: how many platforms the things he keeps come from, in a headline,
// and how many each gives, a bar a platform with its icon (icons.tsx), name, count and share, the most first. Each bar
// opens Recent narrowed to that platform. The counts are the server's (the tags answer's `platforms`), hidden items
// aside as every other count there; his own kept files (platform "file") are a bar of their own but no platform.

import type { MouseEvent } from "react";
import { platformLabel } from "./format.ts";
import type { InspirationTagsAnswer } from "../wire.ts";
import { Icon, type IconName, LOCALE } from "../../../sdk/viewer.ts";

/** The platforms with an icon of their own; the web is a globe, his files a picture. */
const PLATFORM_ICONS: readonly IconName[] = [
  "instagram", "x", "youtube", "tiktok", "pinterest", "reddit", "vimeo", "threads", "facebook", "spotify", "soundcloud", "behance", "dribbble", "web", "file",
];

/** A platform's icon: its own, else a link for one the console does not know. */
export const platformIcon = (platform: string): IconName => PLATFORM_ICONS.find((icon) => icon === platform) ?? "link";

/** A platform's name on its bar: the page's word for it, his files as "Kept files". */
export const platformName = (platform: string): string => (platform === "file" ? "Kept files" : platformLabel(platform));

/** What each bar shows: the platform, its count, its share of every item and its length against the largest's. */
export interface PlatformBar {
  platform: string;
  name: string;
  icon: IconName;
  count: number;
  /** "72%", "<1%". */
  share: string;
  /** Of the largest bar's, 0 to 100. */
  length: number;
}

/** The bars for `platforms` (the server's, most first), in that order. */
export function platformBars(platforms: InspirationTagsAnswer["platforms"]): PlatformBar[] {
  const total = platforms.reduce((sum, p) => sum + p.count, 0);
  const most = Math.max(1, ...platforms.map((p) => p.count));
  return platforms.map(({ platform, count }) => {
    const percent = total > 0 ? (count / total) * 100 : 0;
    return {
      platform,
      name: platformName(platform),
      icon: platformIcon(platform),
      count,
      share: percent > 0 && percent < 0.5 ? "<1%" : `${Math.round(percent)}%`,
      length: Math.max(count > 0 ? 1 : 0, Math.round((count / most) * 100)),
    };
  });
}

/** How many platforms the items come from: every one but his own files. */
export const platformCount = (platforms: InspirationTagsAnswer["platforms"]): number => platforms.filter((p) => p.platform !== "file").length;

const number = (n: number) => n.toLocaleString(LOCALE);

export function InspirationsPlatforms({ tags, recentPath }: { tags: InspirationTagsAnswer; recentPath: (platform: string) => string }) {
  const bars = platformBars(tags.platforms);
  const count = platformCount(tags.platforms);
  const files = tags.platforms.some((p) => p.platform === "file");
  /** Opens Recent narrowed to a platform in place, as the rail does (a modified click opens a new tab). */
  const open = (path: string) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  };
  return (
    <section className="card platforms" aria-labelledby="platforms-headline">
      <div className="platforms__head">
        <h2 id="platforms-headline" className="platforms__headline">
          From <strong>{number(count)}</strong> {count === 1 ? "platform" : "platforms"}
          {files && <span className="platforms__and"> and your own files</span>}
        </h2>
        <p className="platforms__note">
          {tags.total > 0 ? `${number(tags.total)} ${tags.total === 1 ? "inspiration" : "inspirations"}, hidden ones aside. Choose one to see its items.` : "Nothing kept yet."}
        </p>
      </div>
      {bars.length > 0 && (
        <ol className="platforms__bars" aria-label="Inspirations by platform, the most first">
          {bars.map((bar, i) => {
            const path = recentPath(bar.platform);
            return (
              <li key={bar.platform}>
                <a className={`platforms__row${i === 0 ? " platforms__row--lead" : ""}`} href={path} onClick={open(path)} title={`${bar.name}: ${number(bar.count)} of ${number(tags.total)}, ${bar.share}`}>
                  <Icon name={bar.icon} className="platforms__icon" />
                  <span className="platforms__name">{bar.name}</span>
                  <span className="platforms__track" aria-hidden="true">
                    <i style={{ width: `${bar.length}%` }} />
                  </span>
                  <span className="platforms__count">{number(bar.count)}</span>
                  <span className="platforms__share">{bar.share}</span>
                </a>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
