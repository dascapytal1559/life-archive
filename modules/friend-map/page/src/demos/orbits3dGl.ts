// Orbits 3D's drawing (Orbits3D.tsx): everything round the sun on one WebGL
// canvas, and, once the view tilts, the names too. Each thing drawn is a
// sprite, a square facing the screen, and the shader makes it what it is:
// the sun's glow and the smaller glow round whoever lives with you
// (the sun's gradient), the glow round everyone to reach out to (their
// colour), a sphere filled with its person's identicon and lit by the sun,
// the belt's hollow rings, your photo in place of the sun, and a
// name from the names atlas (orbits3dNames.ts). From straight above a
// sphere is a disc filled with its identicon, as Orbits draws it: the
// identicon is painted on the top of the sphere, so it foreshortens as the
// view tilts and the underside shows the identicon's background, and the
// shading fades in with the tilt (shadeAt in orbits3dScene.ts), so nothing
// changes until the view does. Sprites are drawn in the order given (back to
// front, from orbits3dScene's paintOrder), blended over the page's own
// background.
//
// Depth: each sprite carries how near the camera it is (`near`), and the
// solid ones (the spheres, the belt's rings, the photo, and the sun's bright
// middle) write theirs into a depth buffer as they are painted, so a name,
// drawn after them at its own sphere's depth, is hidden wherever something
// nearer covers it and never shows through a sphere in front; the glows,
// soft and painted in order, neither test depth nor write it, so nothing
// of Orbits' painting changes. That takes one draw call per run of sprites
// of a kind (passesOf): a handful a frame.
//
// WebGL rather than SVG or Canvas 2D because a lit sphere is per-pixel work
// (a normal and the sun's direction at every pixel) that only a shader does
// cheaply for hundreds of spheres every frame while the camera turns, on a
// phone too. Written by hand, with no library: a few hundred lines of plain
// WebGL 2, instanced, so the view costs the page nothing it did not already
// have. Nothing here is React.

import { identicon, IDENTICON_SIZE } from "../identicon.ts";
import { COLORS } from "./palette.ts";

/** What a sprite is. */
export const SUN_GLOW = 0;
export const COLOUR_GLOW = 1;
export const SPHERE = 2;
export const HOLLOW = 3;
export const PHOTO = 4;
/** The sun's bright middle, as something names hide behind: writes depth and draws nothing (the glow has drawn it). */
export const SUN_CORE = 5;
/** A name from the names atlas (orbits3dNames.ts), facing the screen at its sphere's depth. */
export const NAME = 6;

/** How far out, as a share of the sun's radius, the sun's middle is solid enough to hide a name behind it. */
export const SUN_SOLID = 0.5;

export interface Sprite {
  /** Where its middle is on the canvas, in CSS pixels from the sun's spot. */
  x: number;
  y: number;
  /** Its radius, in pixels: the sphere's, the glow's, the ring's. */
  r: number;
  /** How strongly it is drawn, 0 to 1 (opacity and strength, as Orbits has them). */
  alpha: number;
  mode: number;
  /** How near the camera it is (orbits3dScene's nearness; greater is nearer): its depth, 0 when it does not matter (a glow). */
  near?: number;
  /** A glow's colour; a sphere's, ring's or photo's stroke, with its opacity. */
  colour?: readonly [number, number, number, number];
  /** The stroke's width, in pixels. */
  stroke?: number;
  /** A sphere's identicon: its index in the atlas (see faces). */
  face?: number;
  /** A sphere's light: a unit vector toward the sun, as the screen sees it (lightOn). */
  light?: readonly [number, number, number];
  /** How much of a sphere's shading shows, 0 to 1 (shadeAt). */
  shade?: number;
  /** A name's box in the names atlas (its NameSlot's uv), and its half width and height in CSS pixels. */
  uv?: readonly [number, number, number, number];
  wide?: number;
  tall?: number;
}

/**
 * What a run of sprites does to the depth buffer: a `glow` neither tests nor
 * writes it, a `solid` tests and writes it, a `mask` writes it and draws
 * nothing (the sun's middle), a `name` tests it and leaves it.
 */
export type PassKind = "glow" | "solid" | "mask" | "name";

export function kindOf(mode: number): PassKind {
  return mode === SUN_GLOW || mode === COLOUR_GLOW ? "glow" : mode === SUN_CORE ? "mask" : mode === NAME ? "name" : "solid";
}

/** The sprites, in the order given, as runs of one kind each: each run is one draw call with that kind's depth state. */
export function passesOf(modes: readonly number[]): Array<{ start: number; end: number; kind: PassKind }> {
  const passes: Array<{ start: number; end: number; kind: PassKind }> = [];
  modes.forEach((mode, i) => {
    const kind = kindOf(mode);
    const last = passes[passes.length - 1];
    if (last && last.kind === kind) last.end = i + 1;
    else passes.push({ start: i, end: i + 1, kind });
  });
  return passes;
}

/**
 * Each sprite's depth, in clip space, from how near the camera it is: the
 * nearest at −1, the furthest at 1, the same nearness the same depth, so
 * what is painted later (nearer, by paintOrder) passes the depth test and a
 * name at its sphere's nearness is hidden by exactly what is nearer. All
 * equally near (straight above a flat plane): all at 0.
 */
export function depthsOf(nears: readonly number[]): number[] {
  let [min, max] = [Infinity, -Infinity];
  for (const n of nears) {
    min = Math.min(min, n);
    max = Math.max(max, n);
  }
  if (!(max > min)) return nears.map(() => 0);
  return nears.map((n) => 1 - (2 * (n - min)) / (max - min));
}

/** The camera's turn and lean, for painting each identicon on the top of its sphere. */
export interface Turned {
  bearing: number;
  tilt: number;
}

/** How big each identicon is in the atlas: IDENTICON_SIZE cells of CELL_PX, in a square of STRIDE_PX, the margin its own background so sampling never bleeds into a neighbour. */
const CELL_PX = 4;
const FACE_PX = IDENTICON_SIZE * CELL_PX;
const STRIDE_PX = FACE_PX + 8;

const FLOATS = 24;

const VERTEX = `#version 300 es
precision highp float;
in vec2 aCorner;
in vec2 aPos;
in vec2 aHalf;
in float aZ;
in float aR;
in float aAlpha;
in float aMode;
in vec4 aColour;
in float aStroke;
in vec4 aUv;
in vec3 aLight;
in float aShade;
in vec3 aUnder;
uniform vec2 uView;
uniform vec2 uOrigin;
out vec2 vLocal;
flat out vec2 vHalf;
flat out float vR;
flat out float vAlpha;
flat out int vMode;
flat out vec4 vColour;
flat out float vStroke;
flat out vec4 vUv;
flat out vec3 vLight;
flat out float vShade;
flat out vec3 vUnder;
void main() {
  vLocal = aCorner * aHalf;
  vec2 p = uOrigin + aPos + vLocal;
  gl_Position = vec4(p.x / uView.x * 2.0 - 1.0, 1.0 - p.y / uView.y * 2.0, aZ, 1.0);
  vHalf = aHalf;
  vR = aR;
  vAlpha = aAlpha;
  vMode = int(aMode + 0.5);
  vColour = aColour;
  vStroke = aStroke;
  vUv = aUv;
  vLight = aLight;
  vShade = aShade;
  vUnder = aUnder;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec2 vHalf;
flat in float vR;
flat in float vAlpha;
flat in int vMode;
flat in vec4 vColour;
flat in float vStroke;
flat in vec4 vUv;
flat in vec3 vLight;
flat in float vShade;
flat in vec3 vUnder;
uniform sampler2D uAtlas;
uniform sampler2D uPhoto;
uniform sampler2D uNames;
uniform vec4 uTurn;
uniform vec3 uSunCore;
uniform vec3 uSunRim;
uniform float uSunSolid;
out vec4 outColour;

// A band of the radius from a to b, one pixel soft at each end.
float band(float d, float a, float b) {
  return smoothstep(a - 0.5, a + 0.5, d) * (1.0 - smoothstep(b - 0.5, b + 0.5, d));
}

void main() {
  float d = length(vLocal);
  float t = d / vR;
  vec4 c = vec4(0.0);
  if (vMode == 6) {
    // A name, as drawn into the names atlas; nothing of its transparent surround, so only the letters take a depth.
    vec2 uv = mix(vUv.xy, vUv.zw, clamp((vLocal / vHalf + 1.0) * 0.5, 0.0, 1.0));
    c = texture(uNames, uv);
    if (c.a < 0.004) discard;
    outColour = c * vAlpha;
    return;
  }
  if (vMode == 5) {
    // The sun's solid middle: a depth, no colour (the pass draws no colour).
    if (t > uSunSolid) discard;
    outColour = vec4(0.0);
    return;
  }
  if (vMode == 0) {
    // The sun's gradient: its bright core, your colour, fading away to nothing (SVG's orbits-sun stops).
    vec3 rgb = t < 0.35 ? mix(uSunCore, uSunRim, t / 0.35) : uSunRim;
    float a = t < 0.35 ? 1.0 : t < 0.7 ? mix(1.0, 0.18, (t - 0.35) / 0.35) : mix(0.18, 0.0, (t - 0.7) / 0.3);
    a *= 1.0 - smoothstep(vR - 0.5, vR + 0.5, d);
    c = vec4(rgb * a, a);
  } else if (vMode == 1) {
    // A glow in a person's colour (Orbits' reach-out gradient stops).
    float a = t < 0.25 ? 0.75 : t < 0.6 ? mix(0.75, 0.22, (t - 0.25) / 0.35) : mix(0.22, 0.0, (t - 0.6) / 0.4);
    a *= 1.0 - smoothstep(vR - 0.5, vR + 0.5, d);
    c = vec4(vColour.rgb * a, a);
  } else if (vMode == 2) {
    // A sphere: its normal, as the screen sees it, and then as the world has it, to paint the identicon on its top.
    vec2 q = vLocal / vR;
    float q2 = dot(q, q);
    vec3 n = vec3(q, sqrt(max(0.0, 1.0 - q2)));
    float cB = uTurn.x, sB = uTurn.y, cT = uTurn.z, sT = uTurn.w;
    vec3 w = vec3(n.x, n.y * cT + n.z * sT, n.z * cT - n.y * sT);
    vec2 ground = vec2(w.x * cB + w.y * sB, -w.x * sB + w.y * cB);
    vec2 uv = mix(vUv.xy, vUv.zw, clamp((ground + 1.0) * 0.5, 0.0, 1.0));
    vec3 face = texture(uAtlas, uv).rgb;
    vec3 base = mix(vUnder, face, smoothstep(-0.06, 0.06, w.z));
    float lambert = max(dot(n, vLight), 0.0);
    vec3 reflected = reflect(-vLight, n);
    float shine = pow(max(reflected.z, 0.0), 40.0) * 0.3;
    float lit = mix(1.0, 0.18 + 0.82 * lambert, vShade);
    vec3 rgb = base * lit + vec3(shine * vShade);
    float fill = 1.0 - smoothstep(vR - 0.5, vR + 0.5, d);
    float ring = band(d, vR - vStroke * 0.5, vR + vStroke * 0.5);
    // Outside the sphere nothing is drawn, and no depth: the square's corners hide nothing behind them.
    if (max(fill, ring) < 0.004) discard;
    vec4 body = vec4(rgb, 1.0) * fill;
    vec4 edge = vec4(vColour.rgb, 1.0) * vColour.a * ring;
    c = edge + body * (1.0 - edge.a);
  } else if (vMode == 3) {
    // A hollow ring: the belt.
    float ring = band(d, vR - vStroke * 0.5, vR + vStroke * 0.5);
    if (ring < 0.004) discard;
    c = vec4(vColour.rgb, 1.0) * vColour.a * ring;
  } else {
    // Your photo, round, ringed in your colour.
    vec2 uv = clamp((vLocal / vR + 1.0) * 0.5, 0.0, 1.0);
    vec3 rgb = texture(uPhoto, uv).rgb;
    float fill = 1.0 - smoothstep(vR - 0.5, vR + 0.5, d);
    float ring = band(d, vR - vStroke * 0.5, vR + vStroke * 0.5);
    if (max(fill, ring) < 0.004) discard;
    vec4 body = vec4(rgb, 1.0) * fill;
    vec4 edge = vec4(vColour.rgb, 1.0) * vColour.a * ring;
    c = edge + body * (1.0 - edge.a);
  }
  outColour = c * vAlpha;
}`;

/** A #rrggbb colour as three channels, 0 to 1. */
export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * The sky's drawing on `canvas`. `faces` gives it everyone's identicons;
 * `draw` draws one frame. Null (`SkyGl.on`) where the browser has no WebGL 2.
 */
export class SkyGl {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private quad: WebGLBuffer;
  private instances: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private atlas: WebGLTexture;
  private photoTexture: WebGLTexture;
  private namesTexture: WebGLTexture;
  private uniforms: Record<"uView" | "uOrigin" | "uAtlas" | "uPhoto" | "uNames" | "uTurn" | "uSunCore" | "uSunRim" | "uSunSolid", WebGLUniformLocation | null>;
  private data = new Float32Array(FLOATS * 64);
  /** Each identicon's place in the atlas: its uv box, and its background colour (for the sphere's underside). */
  private faceAt = new Map<number, { uv: [number, number, number, number]; under: [number, number, number] }>();
  private hasPhoto = false;

  static on(canvas: HTMLCanvasElement): SkyGl | null {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: true, stencil: false, preserveDrawingBuffer: false });
    return gl ? new SkyGl(gl) : null;
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Orbits 3D shader: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Orbits 3D program: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    gl.useProgram(program);
    const u = (name: string) => gl.getUniformLocation(program, name);
    this.uniforms = {
      uView: u("uView"), uOrigin: u("uOrigin"), uAtlas: u("uAtlas"), uPhoto: u("uPhoto"), uNames: u("uNames"), uTurn: u("uTurn"),
      uSunCore: u("uSunCore"), uSunRim: u("uSunRim"), uSunSolid: u("uSunSolid"),
    };
    gl.uniform1i(this.uniforms.uAtlas, 0);
    gl.uniform1i(this.uniforms.uPhoto, 1);
    gl.uniform1i(this.uniforms.uNames, 2);
    gl.uniform3fv(this.uniforms.uSunCore, rgb("#fff8e8"));
    gl.uniform3fv(this.uniforms.uSunRim, rgb(COLORS.me));
    gl.uniform1f(this.uniforms.uSunSolid, SUN_SOLID);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(program, "aCorner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    this.instances = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    const stride = FLOATS * 4;
    let offset = 0;
    for (const [name, size] of [["aPos", 2], ["aHalf", 2], ["aZ", 1], ["aR", 1], ["aAlpha", 1], ["aMode", 1], ["aColour", 4], ["aStroke", 1], ["aUv", 4], ["aLight", 3], ["aShade", 1], ["aUnder", 3]] as const) {
      const at = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, size, gl.FLOAT, false, stride, offset * 4);
      gl.vertexAttribDivisor(at, 1);
      offset += size;
    }
    if (offset !== FLOATS) throw new Error("Orbits 3D: the sprite's floats do not add up");
    gl.bindVertexArray(null);

    this.atlas = this.texture();
    this.photoTexture = this.texture();
    this.namesTexture = this.texture();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // Nearer is a smaller depth (depthsOf); what is as near as what is there already (painted later, by paintOrder) is drawn over it.
    gl.depthFunc(gl.LEQUAL);
    gl.clearDepth(1);
    gl.disable(gl.DEPTH_TEST);
  }

  private texture(): WebGLTexture {
    const { gl } = this;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
  }

  /**
   * Everyone's identicon, drawn once into one atlas (a canvas, uploaded as a
   * texture with mipmaps, so a small sphere samples a smooth picture), each
   * found again by its person's id (`face` of a Sprite). Call again when who
   * is on the map, or anyone's icon, changes.
   */
  faces(people: ReadonlyArray<{ id: number; identiconSeed: string; identiconHue: number | null }>): void {
    const { gl } = this;
    const columns = Math.max(1, Math.ceil(Math.sqrt(people.length)));
    const rows = Math.max(1, Math.ceil(people.length / columns));
    const [width, height] = [columns * STRIDE_PX, rows * STRIDE_PX];
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    this.faceAt.clear();
    people.forEach((person, i) => {
      const icon = identicon(person.identiconSeed, person.identiconHue);
      const [x0, y0] = [(i % columns) * STRIDE_PX, Math.floor(i / columns) * STRIDE_PX];
      ctx.fillStyle = icon.background;
      ctx.fillRect(x0, y0, STRIDE_PX, STRIDE_PX);
      const at = (STRIDE_PX - FACE_PX) / 2;
      icon.cells.forEach((row, y) => row.forEach((cell, x) => {
        if (cell === 0) return;
        ctx.fillStyle = cell === 1 ? icon.main : icon.spot;
        ctx.fillRect(x0 + at + x * CELL_PX, y0 + at + y * CELL_PX, CELL_PX, CELL_PX);
      }));
      this.faceAt.set(person.id, {
        uv: [(x0 + at) / width, (y0 + at) / height, (x0 + at + FACE_PX) / width, (y0 + at + FACE_PX) / height],
        under: rgb(icon.background),
      });
    });
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Your photo (an image that has loaded), cropped to a square about its middle, or none. */
  photo(image: HTMLImageElement | null): void {
    const { gl } = this;
    this.hasPhoto = image !== null;
    if (!image) return;
    const side = Math.min(image.naturalWidth, image.naturalHeight, 512);
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext("2d")!;
    const crop = Math.min(image.naturalWidth, image.naturalHeight);
    ctx.drawImage(image, (image.naturalWidth - crop) / 2, (image.naturalHeight - crop) / 2, crop, crop, 0, 0, side, side);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.photoTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Whether a photo has been given. */
  get photoShown(): boolean {
    return this.hasPhoto;
  }

  /**
   * The names atlas (orbits3dNames.ts' NameAtlas, built), uploaded as drawn:
   * no mipmaps, as a name is drawn at exactly its size in the atlas, pixel
   * for pixel. Call again when the atlas is built again.
   */
  names(canvas: HTMLCanvasElement): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.namesTexture);
    // The canvas's pixels are straight; the blending wants them premultiplied, as the shader's own colours are.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }

  /**
   * One frame: `sprites` in the order given, the sun's spot at `origin` on a
   * canvas `width` by `height` CSS pixels drawn at `dpr` device pixels each,
   * the camera turned as `turned` says.
   */
  draw(sprites: readonly Sprite[], origin: { x: number; y: number }, width: number, height: number, dpr: number, turned: Turned): void {
    const { gl } = this;
    const canvas = gl.canvas as HTMLCanvasElement;
    const [w, h] = [Math.round(width * dpr), Math.round(height * dpr)];
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (sprites.length === 0) return;
    if (this.data.length < sprites.length * FLOATS) this.data = new Float32Array(FLOATS * Math.ceil(sprites.length * 1.5));
    const d = this.data;
    const depths = depthsOf(sprites.map((s) => s.near ?? 0));
    let i = 0;
    sprites.forEach((s, n) => {
      const face = s.face === undefined ? undefined : this.faceAt.get(s.face);
      const colour = s.colour ?? [0, 0, 0, 0];
      const light = s.light ?? [0, 0, 1];
      const uv = s.uv ?? face?.uv ?? [0, 0, 0, 0];
      const under = face?.under ?? [0, 0, 0];
      // A round sprite reaches its radius, its stroke and a pixel of softness; a name its own box.
      const reach = s.r + (s.stroke ?? 0) * 0.5 + 1.5;
      const [wide, tall] = s.mode === NAME ? [s.wide ?? 0, s.tall ?? 0] : [reach, reach];
      d[i++] = s.x; d[i++] = s.y; d[i++] = wide; d[i++] = tall; d[i++] = depths[n];
      d[i++] = s.r; d[i++] = s.alpha; d[i++] = s.mode;
      d[i++] = colour[0]; d[i++] = colour[1]; d[i++] = colour[2]; d[i++] = colour[3];
      d[i++] = s.stroke ?? 0;
      d[i++] = uv[0]; d[i++] = uv[1]; d[i++] = uv[2]; d[i++] = uv[3];
      d[i++] = light[0]; d[i++] = light[1]; d[i++] = light[2];
      d[i++] = s.shade ?? 0;
      d[i++] = under[0]; d[i++] = under[1]; d[i++] = under[2];
    });
    gl.useProgram(this.program);
    gl.uniform2f(this.uniforms.uView, width, height);
    gl.uniform2f(this.uniforms.uOrigin, origin.x, origin.y);
    gl.uniform4f(this.uniforms.uTurn, Math.cos(turned.bearing), Math.sin(turned.bearing), Math.cos(turned.tilt), Math.sin(turned.tilt));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.photoTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.namesTexture);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    // One draw call per run of sprites of a kind, each with that kind's depth state (passesOf).
    for (const pass of passesOf(sprites.map((s) => s.mode))) {
      if (pass.kind === "glow") gl.disable(gl.DEPTH_TEST);
      else gl.enable(gl.DEPTH_TEST);
      gl.depthMask(pass.kind === "solid" || pass.kind === "mask");
      const colour = pass.kind !== "mask";
      gl.colorMask(colour, colour, colour, colour);
      gl.bufferData(gl.ARRAY_BUFFER, d.subarray(pass.start * FLOATS, pass.end * FLOATS), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, pass.end - pass.start);
    }
    gl.colorMask(true, true, true, true);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }

  /**
   * Lets the GPU's memory go. The context itself is left to go with the
   * canvas: React in development mounts a view twice on the same canvas,
   * and a context once lost on purpose cannot be had again.
   */
  dispose(): void {
    const { gl } = this;
    gl.deleteTexture(this.atlas);
    gl.deleteTexture(this.photoTexture);
    gl.deleteTexture(this.namesTexture);
    gl.deleteBuffer(this.quad);
    gl.deleteBuffer(this.instances);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
