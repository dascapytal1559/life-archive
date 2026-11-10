// Inspirations' Platforms, drawn from made-up counts: the headline counts the platforms but not his own files, a bar a
// platform the most first with its icon, name, count and share, each a link to Recent narrowed to it, the largest in the
// accent; a platform the console does not know keeps its own word and gets a link for an icon.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InspirationTagsAnswer } from "../wire.ts";
import { InspirationsPlatforms, platformBars, platformCount, platformIcon, platformName } from "./InspirationsPlatforms.tsx";

const answer = (platforms: InspirationTagsAnswer["platforms"]): InspirationTagsAnswer => ({
  tags: [], aiTags: [], platforms, untagged: 0, total: platforms.reduce((sum, p) => sum + p.count, 0), hidden: 2,
});
const draw = (tags: InspirationTagsAnswer) => renderToStaticMarkup(createElement(InspirationsPlatforms, { tags, recentPath: (p: string) => `/recent?platform=${p}` }));

const MADE_UP = [
  { platform: "instagram", count: 600 },
  { platform: "youtube", count: 300 },
  { platform: "file", count: 97 },
  { platform: "mastodon", count: 3 },
];

describe("Inspirations' Platforms", () => {
  it("count the platforms but not his own files, and give each its icon and name", () => {
    expect(platformCount(MADE_UP)).toBe(3);
    expect(["instagram", "x", "web", "file", "mastodon"].map(platformIcon)).toEqual(["instagram", "x", "web", "file", "link"]);
    expect(["youtube", "web", "file", "mastodon"].map(platformName)).toEqual(["YouTube", "Web", "Kept files", "mastodon"]);
  });

  it("draw a bar a platform as long as its share of the largest's, with its count and share", () => {
    expect(platformBars(MADE_UP).map(({ platform, count, share, length }) => ({ platform, count, share, length }))).toEqual([
      { platform: "instagram", count: 600, share: "60%", length: 100 },
      { platform: "youtube", count: 300, share: "30%", length: 50 },
      { platform: "file", count: 97, share: "10%", length: 16 },
      { platform: "mastodon", count: 3, share: "<1%", length: 1 },
    ]);
  });

  it("head the chart with the number of platforms, and link each bar to Recent narrowed to it", () => {
    const html = draw(answer(MADE_UP));
    expect(html).toMatch(/From <strong>3<\/strong> platforms<span class="platforms__and"> and your own files<\/span>/);
    expect(html).toContain("1,000 inspirations, hidden ones aside.");
    expect(html).toMatch(/<a class="platforms__row platforms__row--lead" href="\/recent\?platform=instagram" title="Instagram: 600 of 1,000, 60%">/);
    expect(html.match(/class="platforms__row/g)).toHaveLength(4);
    expect(html.indexOf("YouTube")).toBeLessThan(html.indexOf("Kept files"));
  });

  it("say one platform in the singular, and draw no bars with nothing kept", () => {
    expect(draw(answer([{ platform: "web", count: 1 }]))).toMatch(/From <strong>1<\/strong> platform<\/h2>.*1 inspiration, hidden/);
    const none = draw(answer([]));
    expect(none).toContain("From <strong>0</strong> platforms");
    expect(none).toContain("Nothing kept yet.");
    expect(none).not.toContain("platforms__bars");
  });
});
