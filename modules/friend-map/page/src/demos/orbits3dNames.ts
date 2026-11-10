// Orbits 3D's names once the view tilts (Orbits3D.tsx). From straight above
// the names are Orbits' own: flat text centred where each person's sphere
// would be, standing in for it, placed by orbitsSky's useOrbitNames and drawn
// in the SVG above the canvas. Tilted, that overlay would show a name through
// a sphere in front of it. So past a small tilt the names move into the
// scene: each in its person's place, facing the camera, drawn on the WebGL
// canvas (orbits3dGl.ts) at its person's depth, so a sphere or the sun nearer
// the camera hides it as it would anything behind it. Between the two
// the overlay fades out as the in-scene names fade in (namesInScene), so a
// nudge of the camera flips nothing. The text itself is drawn once per name
// with Canvas 2D into one atlas (NameAtlas), at the canvas's own pixel
// density, with Orbits' type, outline and glow, and sampled pixel for pixel,
// so it is as crisp as the SVG's; a name is drawn again only when it changes
// (the text, its colour, its size, whether it is picked out).
//
// The rules are pure functions, tested without a GPU; the atlas needs a
// document and is only made in the browser.

import type { Camera } from "./cityCamera.ts";
import { alphaHex, NAME_GLOW, NAME_HALO } from "./orbitsLayout.ts";

/**
 * Over what tilt the names move from Orbits' flat overlay into the scene:
 * the overlay alone to NAMES_TILT_FROM (a nudge of the camera changes
 * nothing), the scene's alone from NAMES_TILT_TO, a crossfade between.
 */
export const NAMES_TILT_FROM = (2 * Math.PI) / 180;
export const NAMES_TILT_TO = (8 * Math.PI) / 180;

/** How much of the names are in the scene rather than the flat overlay, 0 to 1, eased over the tilt between NAMES_TILT_FROM and NAMES_TILT_TO. */
export function namesInScene(camera: Camera): number {
  const p = Math.min(1, Math.max(0, (camera.tilt - NAMES_TILT_FROM) / (NAMES_TILT_TO - NAMES_TILT_FROM)));
  return p * p * (3 - 2 * p);
}

/** A name as it is drawn:/** A name as it is drawn: Orbits' type (orbits.css' orbits__name) in the person's colour, bold when picked out, glowing in their colour when to reach out to. */
export interface NameLook {
  text: string;
  /** The fill (nameColour). */
  colour: string;
  /** The type size as a share of the full size: 1, or MINOR_SCALE. */
  scale: number;
  bold: boolean;
  /** The glow's colour (glowColour), or none. */
  glow: string | null;
  /** How strong the Reach-out glow is, 0 (the usual) to 1 (reachGlow.ts): its wider halo, as nameGlow's. */
  boost: number;
}

/** One key per distinct drawing of a name, so the atlas draws each once. */
export function nameKey(look: NameLook): string {
  return [look.text, look.colour, look.scale, look.bold ? 1 : 0, look.glow ?? "", look.glow ? look.boost : 0].join("\u0001");
}

/** Where a name is in the atlas (its uv box) and how big it is drawn, in CSS pixels from its middle. */
export interface NameSlot {
  uv: [number, number, number, number];
  wide: number;
  tall: number;
}

/** Orbits' type for a name (orbits.css): the full size in pixels, the outline's width and colour. */
export const NAME_TYPE = { size: 12.5, stroke: 3.5, outline: "rgba(7, 11, 22, 0.9)" };
/** Room round a name in the atlas for its outline and glow, in CSS pixels. */
const PAD = Math.ceil(NAME_TYPE.stroke / 2 + NAME_GLOW.blur) + 1;

/** Room round a name for its glow's wider halo at `boost` (nameGlow's NAME_HALO), past PAD, in CSS pixels: a blur fades out within about one and a half times itself. */
function haloPad(look: NameLook): number {
  return look.glow && look.boost > 0 ? Math.ceil(1.5 * (NAME_HALO.blur + NAME_HALO.more * look.boost)) : 0;
}
/** The widest the atlas grows, in device pixels: a row's width, and the most rows. */
const ATLAS_MAX = 4096;

/** A name drawn once, kept until it is no longer wanted. */
interface Glyph {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/**
 * Every name the scene shows, drawn into one texture. `build` draws each new
 * name once (Canvas 2D, at the given pixel density, with Orbits' type,
 * outline and glow) and packs them all, with those drawn before, into one
 * canvas for the GPU, giving each its slot; a name not asked for again is
 * forgotten. Nothing here is React or WebGL.
 */
export class NameAtlas {
  private glyphs = new Map<string, Glyph>();
  private dpr = 0;
  private font = "";

  /**
   * The atlas for `looks` at `dpr` device pixels per CSS pixel, in `family`
   * (Orbits' serif): the canvas to upload, and each name's slot by its key.
   * Every width and height is even, in device pixels, so a name centred on
   * the device grid lands on whole pixels.
   */
  build(looks: readonly NameLook[], dpr: number, family: string): { canvas: HTMLCanvasElement; slots: Map<string, NameSlot> } {
    if (dpr !== this.dpr || family !== this.font) {
      this.glyphs.clear();
      this.dpr = dpr;
      this.font = family;
    }
    const wanted = new Map<string, Glyph>();
    for (const look of looks) {
      const key = nameKey(look);
      if (wanted.has(key)) continue;
      wanted.set(key, this.glyphs.get(key) ?? this.draw(look));
    }
    this.glyphs = wanted;

    // Packed in rows, tallest first, each row as wide as ATLAS_MAX allows.
    const order = [...wanted].sort((a, b) => b[1].height - a[1].height || a[0].localeCompare(b[0]));
    const at = new Map<string, { x: number; y: number }>();
    let [x, y, rowHeight, width] = [0, 0, 0, 0];
    for (const [key, glyph] of order) {
      if (x + glyph.width > ATLAS_MAX && x > 0) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      at.set(key, { x, y });
      x += glyph.width;
      rowHeight = Math.max(rowHeight, glyph.height);
      width = Math.max(width, x);
    }
    const height = Math.min(ATLAS_MAX, y + rowHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext("2d")!;
    const slots = new Map<string, NameSlot>();
    for (const [key, glyph] of wanted) {
      const p = at.get(key)!;
      if (p.y + glyph.height > ATLAS_MAX) continue;
      ctx.drawImage(glyph.canvas, p.x, p.y);
      slots.set(key, {
        uv: [p.x / canvas.width, p.y / canvas.height, (p.x + glyph.width) / canvas.width, (p.y + glyph.height) / canvas.height],
        wide: glyph.width / dpr / 2,
        tall: glyph.height / dpr / 2,
      });
    }
    return { canvas, slots };
  }

  /** One name drawn as orbits.css draws it: the outline under the fill (paint-order: stroke), round joins, a glow in its colour when it has one. */
  private draw(look: NameLook): Glyph {
    const { dpr } = this;
    const size = NAME_TYPE.size * look.scale;
    const font = `${look.bold ? 600 : 400} ${size * dpr}px ${this.font}`;
    const measure = document.createElement("canvas").getContext("2d")!;
    measure.font = font;
    const m = measure.measureText(look.text);
    const ascent = m.actualBoundingBoxAscent || size * dpr * 0.8;
    const descent = m.actualBoundingBoxDescent || size * dpr * 0.25;
    const even = (n: number) => 2 * Math.ceil(n / 2);
    const pad = PAD + haloPad(look);
    const width = even(Math.ceil(m.width) + 2 * pad * dpr);
    const height = even(Math.ceil(ascent + descent) + 2 * pad * dpr);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.font = font;
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    ctx.lineWidth = NAME_TYPE.stroke * dpr;
    ctx.strokeStyle = NAME_TYPE.outline;
    ctx.fillStyle = look.colour;
    const [x, y] = [(width - m.width) / 2, (height - (ascent + descent)) / 2 + ascent];
    if (look.glow && look.boost > 0) {
      // nameGlow's wider halo at full glow, under the near one: NAME_HALO's blur and strength at the boost.
      ctx.shadowColor = look.glow + alphaHex(NAME_HALO.alpha * look.boost);
      ctx.shadowBlur = (NAME_HALO.blur + NAME_HALO.more * look.boost) * dpr;
      ctx.strokeText(look.text, x, y);
    }
    if (look.glow) {
      // nameGlow's drop-shadow at full glow: a blur of NAME_GLOW.blur, NAME_GLOW.alpha strong (NAME_GLOW.boosted more at
      // the boost), cast by the outline, which covers the fill.
      ctx.shadowColor = look.glow + alphaHex(NAME_GLOW.alpha * (1 + NAME_GLOW.boosted * look.boost));
      ctx.shadowBlur = NAME_GLOW.blur * dpr;
    }
    ctx.strokeText(look.text, x, y);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.fillText(look.text, x, y);
    return { canvas, width, height };
  }
}
