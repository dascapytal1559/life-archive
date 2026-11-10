// Made-up inspirations for the testing data (server/fixtures/testing-data.ts, through module.ts's fixtures), for the viewer's Inspirations page: links on made-up
// accounts and example sites, captions, his tags and the AI's (as the server's worker would leave them, so the page
// shows them without asking any model), saves from the CLI and his Grok Bot agent, a hidden one, one still waiting for
// its AI tags, and two kept pictures drawn here (plain stripes, no photo of anything); and a back-fill's worth of
// made-up Instagram saves, enough for a few pages, as an import and Instagram's slow previews would leave them: most
// with an author, the post's words and a small kept picture, some not fetched yet (their import's placeholder title),
// one skipped. Nothing is fetched.

import { deflateSync } from "node:zlib";
import type { Inspirations, KeptFile } from "../server/store.ts";

/** How a made-up picture is kept: its bytes, a name and its type in, where it was kept out (files.ts's keepFile, in the module's folder). */
export type KeepFile = (bytes: Buffer, name: string, mime: string) => Promise<KeptFile>;

/** A PNG of `width` by `height`, in bands of the colours given (RGB), drawn row by row. */
export function stripesPng(width: number, height: number, colours: Array<[number, number, number]>): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colours[Math.floor(((x + y) / (width + height)) * colours.length * 3) % colours.length];
      row.set([r, g, b], 1 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

interface MadeUp {
  link?: string;
  picture?: Array<[number, number, number]>;
  caption: string;
  tags: string[];
  aiTags: string[] | null;
  title?: string;
  author?: string;
  description?: string;
  origin: string;
  daysAgo: number;
  hidden?: boolean;
}

const ITEMS: MadeUp[] = [
  {
    link: "https://www.instagram.com/reel/MadeUp0001/?igsh=bWFkZXVw", caption: "the slow hands thing, I want to try this with the kids",
    tags: ["craft", "parenting"], aiTags: ["ceramics", "craft", "parenting"], title: "Throwing a tall vase on the wheel", author: "@studio.example",
    description: "A potter throws a tall vase in one long pull, slowly", origin: "grok-bot", daysAgo: 0,
    picture: [[124, 82, 58], [176, 128, 92], [214, 186, 150]],
  },
  {
    link: "https://www.youtube.com/watch?v=MadeUpVid01", caption: "for bedtime, the bridge at 2:10",
    tags: ["music", "parenting"], aiTags: ["music", "lullaby", "parenting"], title: "Lullabies on a made-up piano", author: "A made-up channel", origin: "grok-bot", daysAgo: 1,
  },
  {
    link: "https://blog.example.com/terrazzo-by-hand", caption: "for the bathroom floor",
    tags: ["interior-design", "craft"], aiTags: ["interior-design", "terrazzo", "craft"], title: "Terrazzo tiles, poured by hand", author: "A made-up blog",
    description: "How a small studio pours terrazzo tiles by hand, start to finish", origin: "cli", daysAgo: 2,
    picture: [[58, 92, 120], [210, 204, 190], [168, 112, 96], [236, 232, 222]],
  },
  {
    link: "https://x.com/madeupaccount/status/1790000000000000001", caption: "a light well in a narrow house",
    tags: ["architecture"], aiTags: ["architecture", "daylight"], author: "Made-up account", description: "A narrow house with a light well cut through all three floors", origin: "grok-bot", daysAgo: 4,
  },
  {
    link: "https://recipes.example.org/one-pot-dal", caption: "make this on a cold night",
    tags: [], aiTags: ["cooking", "comfort-food"], title: "One-pot dal for a cold night", author: "A made-up kitchen", origin: "grok-bot", daysAgo: 5,
  },
  {
    link: "https://www.youtube.com/shorts/MadeUpShrt1", caption: "painting with the kids: the tape trick",
    tags: ["art", "parenting"], aiTags: ["art", "parenting", "painting"], title: "Tape-resist painting in a minute", author: "A made-up channel", origin: "grok-bot", daysAgo: 8,
  },
  {
    caption: "the colours on this wall", tags: ["art", "architecture"], aiTags: ["colour", "architecture", "art"], origin: "cli", daysAgo: 12,
    picture: [[196, 84, 60], [232, 170, 72], [70, 120, 140]],
  },
  {
    link: "https://www.instagram.com/p/MadeUp0002/", caption: "", tags: [], aiTags: null, origin: "grok-bot", daysAgo: 0,
  },
  {
    link: "https://example.com/a-shop-i-will-never-buy-from", caption: "not really an inspiration", tags: [], aiTags: ["shopping"], origin: "cli", daysAgo: 20, hidden: true,
  },
];

/** Made-up accounts and words for the made-up Instagram saves. */
const HANDLES = ["@made.up.potter", "@studio.example", "@made.up.weaver", "@example.kitchen", "@made.up.vanlife", "@sample.sketches"];
const WORDS = [
  "A tall vase in one pull, slowly\n#pottery #wheel",
  "Ten minutes of stretching before the kids wake up",
  "A van kitchen that folds into the wall",
  "Watercolour skies, three colours only",
  "The softest focaccia, dimpled by hand",
  "A loom made from a picture frame",
  "Reading corner under the stairs",
  "Clay day with toddlers: what worked",
];
const PALETTES: Array<Array<[number, number, number]>> = [
  [[124, 82, 58], [214, 186, 150]],
  [[58, 92, 120], [236, 232, 222]],
  [[196, 84, 60], [232, 170, 72]],
  [[70, 120, 140], [190, 214, 200]],
  [[96, 70, 120], [222, 196, 230]],
  [[60, 110, 74], [210, 226, 168]],
];
const INSTAGRAM_SAVES = 52;

/** His tags as the made-up captain describes them. */
const DESCRIPTIONS: Record<string, string> = {
  craft: "made by hand: pottery, wood, sewing",
  parenting: "things to do with the kids, and raising them",
  music: "songs, artists, instruments",
  "interior-design": "rooms, tiles and furniture; not whole buildings",
  architecture: "buildings and how light moves through them",
  art: "painting, drawing, colour",
};

/** Writes the made-up inspirations into `store`, their pictures kept by `keep` (in the module's files/, files.ts), as `inspiration add` would. */
export async function writeMadeUpInspirations(store: Inspirations, keep: KeepFile, now = Date.now()): Promise<number> {
  for (const [i, item] of ITEMS.entries()) {
    const at = now - item.daysAgo * 86_400_000 - (ITEMS.length - i) * 600_000;
    const files = [];
    if (item.picture) {
      files.push(await keep(stripesPng(480, 300, item.picture), "picture.png", "image/png"));
    }
    const { id } = store.capture({
      link: item.link ?? null, files, caption: item.caption, tags: item.tags, title: item.title, author: item.author, description: item.description,
      origin: item.origin, savedAt: at, now: at,
    });
    if (item.link) store.setPreview(id, "none");
    if (item.aiTags) store.setAiTags(id, item.aiTags, "made-up-model", at + 5000);
    if (item.hidden) store.setHidden(id, true, at);
  }
  // A second save of the vase, from the CLI, with words of its own.
  store.capture({ link: "https://instagram.com/reel/MadeUp0001", caption: "and the trimming at the end", origin: "cli", savedAt: now - 3_600_000, now: now - 3_600_000 });
  store.setAiTags(1, ["ceramics", "craft", "parenting"], "made-up-model", now - 3_595_000);
  for (const [name, description] of Object.entries(DESCRIPTIONS)) store.describeTag(name, description);
  await writeMadeUpInstagramSaves(store, keep, now);
  return ITEMS.length + INSTAGRAM_SAVES;
}

/** The made-up Instagram saves (see the top), saved over the last months, as the import and the slow previews leave them. */
async function writeMadeUpInstagramSaves(store: Inspirations, keep: KeepFile, now: number): Promise<void> {
  for (let i = 0; i < INSTAGRAM_SAVES; i++) {
    const code = `MadeUpC${String(i + 1).padStart(3, "0")}`;
    const at = now - (30 + i * 3) * 86_400_000;
    const { id } = store.capture({ link: `https://www.instagram.com/p/${code}/`, title: `Instagram save ${code}`, origin: "instagram-saves-import", nativeId: code, savedAt: at, now: at });
    store.setAiTags(id, [["craft", "art", "parenting", "cooking", "travel", "exercise"][i % 6]], "made-up-model", at + 5000);
    const progress = { tries: 1, retryAt: 0, note: null };
    if (i % 5 === 3) {
      store.setPreview(id, "none");
      continue;
    }
    if (i === 7) {
      store.setPreview(id, "none", {}, { ...progress, tries: 3, note: "skipped: its embed page shows no post after 3 tries (removed, private, or not to be embedded)" });
      continue;
    }
    const picture = await keep(stripesPng(320, 320, PALETTES[i % PALETTES.length]), "picture.png", "image/png");
    store.keepPreviewFile(id, picture, at + 60_000);
    store.setPreview(id, "done", { author: HANDLES[i % HANDLES.length], description: WORDS[i % WORDS.length], placeholderTitle: `Instagram save ${code}` }, progress);
  }
}
