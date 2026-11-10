// The City's drawing (City.tsx): the whole city on one WebGL 2 canvas, lit
// like a cyberspace city at night after rain. What is drawn, in order:
//
// 1. The reflection: the buildings and your tower mirrored in the ground,
//    into a smaller picture (cityScene's Quality says how much smaller).
// 2. The scene, into a picture of its own in high dynamic range: the wet
//    ground (dark asphalt with puddles, the boulevards' and avenues' light
//    lines worked out per pixel, so they stay crisp at any zoom, and the
//    reflection, streaked as rain-wet roads streak it), then every building
//    at once (one instanced draw of a stepped form: near-black faces, thin
//    cyan light along the ledges and corners, a few lit windows), your
//    tower among them with its glowing core.
// 3. The mist: for every pixel, a walk from the camera to whatever it sees
//    through drifting mist that thickens toward the ground and glows round
//    your tower's core, and the sky beyond with its low cloud.
// 4. What glows on top: the light running along the roads, the beacons over
//    everyone to reach out to, the arcs to whoever is picked out's group-chat
//    friends, and the far buildings' roof lights, each fogged by its distance.
// 5. Bloom on what is bright (the cyan light, nothing else is that bright),
//    then a filmic tone curve, a vignette and a little grain, onto the canvas.
// 6. The names, last, at the canvas's own pixels so they stay sharp, each
//    hidden where a nearer building stands in front of it (the scene's depth
//    says), but whoever is picked out, who shows through.
//
// Written by hand on WebGL 2, as Orbits 3D's sky is (orbits3dGl.ts), with no
// library: a few hundred lines of plain shaders cost the page nothing it did
// not already have. Nothing here is React; where things are is cityScene.ts.

import { BOULEVARD_HALF, AVENUE_HALF } from "./cityLayout.ts";
import { TIERS_MOST, type Form, type Quality } from "./cityScene.ts";

/** What a building is: a friend's, your tower's shaft (with its core), or its podium. */
export const KIND = { building: 0, shaft: 1, podium: 2 } as const;

/** A building to draw: its form, what it is, when it starts to rise (seconds after the city appears). */
export interface Building {
  form: Form;
  kind: number;
  delay: number;
}

/** How a building is lit: its strength (0 to 1, as Orbits draws tiers and dims), whether it is picked out, and whether it has no closeness yet. */
export interface Light {
  strength: number;
  picked: boolean;
  silent: boolean;
}

/** A floor of your tower: its bottom and top (world units), how strongly it is lit, whether it is the one picked out, and how much it pulses now (to reach out to). */
export interface FloorLight {
  bottom: number;
  top: number;
  strength: number;
  picked: boolean;
  glow: number;
}

/** The ground's roads: each avenue's radius and how brightly its lines glow; the plaza's ring. */
export interface Ground {
  avenues: Array<{ r: number; glow: number }>;
  plaza: number;
}

/** The light lines drawn on top, as segments: from a to b (world), each end's colour (linear rgb, premultiplied by strength) and width in pixels. */
export class Lines {
  data: Float32Array = new Float32Array(4096 * LINE_FLOATS);
  count = 0;
  clear(): void {
    this.count = 0;
  }
  /** A segment from `a` to `b`, `rgb` at full strength, `alpha` at each end, `width` CSS pixels wide. */
  add(a: readonly number[], b: readonly number[], rgb: readonly number[], alphaA: number, alphaB: number, width: number): void {
    if (this.count >= this.data.length / LINE_FLOATS) {
      const more = new Float32Array(this.data.length * 2);
      more.set(this.data);
      this.data = more;
    }
    this.data.set([a[0], a[1], a[2], b[0], b[1], b[2], rgb[0], rgb[1], rgb[2], alphaA, alphaB, width], this.count * LINE_FLOATS);
    this.count++;
  }
}
const LINE_FLOATS = 12;

/** A name to draw: where it stands (world), its slot in the atlas, its offset from there in CSS pixels, how strongly, and how far in front of it something must be to hide it. */
export interface Label {
  at: readonly number[];
  uv: readonly number[];
  wide: number;
  tall: number;
  dx: number;
  dy: number;
  alpha: number;
  /** Shows through whatever stands in front (whoever is picked out). */
  always: boolean;
  /** World units a surface must be nearer than the name to hide it. */
  bias: number;
}

/** What one frame needs. */
export interface Frame {
  view: Float32Array;
  projection: Float32Array;
  eye: readonly number[];
  near: number;
  far: number;
  /** Seconds since the city appeared, for its rise; and a clock for the mist, the core and the grain (frozen with reduced motion). */
  time: number;
  clock: number;
  /** How long a building takes to rise, in seconds; 0 when the city has risen. */
  rise: number;
  floors: FloorLight[];
  lines: Lines;
  labels: Label[];
  /** Whether the camera is still, so the names land on whole pixels. */
  still: boolean;
  /** How far the camera is from what it looks at, which sets where the mist comes in. */
  focus: number;
}

/** The colours, in linear light: the one cyan, the night, the mist. */
export const CYAN = [0.07, 0.62, 1.0] as const;
export const WHITE_CYAN = [0.55, 0.88, 1.0] as const;

// The shaders.

const HEADER = "#version 300 es\nprecision highp float;\nprecision highp int;\n";

/**
 * The fog every shader agrees on: density at the ground and how fast it thins with height (exponential height fog),
 * and how far from the camera it comes in (u_fogNear: thin round what the camera looks at, thick beyond, so what you
 * look at stays clear and black while the distance goes to mist).
 */
const FOG_GLSL = `
uniform vec3 u_fog;
uniform float u_fogNear;
// Optical depth of the height fog between two points (closed form for density a·exp(−b·y)).
float fogDepth(vec3 a, vec3 b) {
  float len = length(b - a);
  float dy = b.y - a.y;
  float ea = exp(-u_fog.y * max(a.y, 0.0));
  float eb = exp(-u_fog.y * max(b.y, 0.0));
  float mean = abs(dy) < 1e-3 ? ea : (ea - eb) / (u_fog.y * dy);
  return u_fog.x * len * max(mean, 0.0) + u_fog.z * len;
}
// The same from the camera, with the fog coming in over u_fogNear: the mean of 1 − exp(−s / u_fogNear) along the way.
float fogFrom(vec3 eye, vec3 p) {
  float len = length(p - eye);
  float share = 1.0 - (u_fogNear / max(len, 1e-3)) * (1.0 - exp(-len / u_fogNear));
  return fogDepth(eye, p) * share;
}
`;

const BUILDING_VS = `${HEADER}
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_normal;
layout(location=2) in vec3 a_face;
layout(location=3) in float a_tier;
layout(location=4) in vec4 i_place;
layout(location=5) in vec4 i_shape;
layout(location=6) in vec4 i_scales;
layout(location=7) in vec4 i_tops;
layout(location=8) in vec4 i_light;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform float u_mirror;
uniform float u_time;
uniform float u_rise;
out vec3 v_world;
out vec3 v_normal;
out vec2 v_uv;
out vec2 v_size;
flat out float v_roof;
flat out float v_tier;
flat out vec4 v_light;
flat out vec4 v_shape;
flat out float v_bottom;
void main() {
  int t = int(a_tier + 0.5);
  float scale = i_scales[t];
  if (scale <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float p = u_rise > 0.0 ? clamp((u_time - i_shape.z) / u_rise, 0.0, 1.0) : 1.0;
  float h = i_shape.x * (1.0 - pow(1.0 - p, 3.0));
  float bottom = (t == 0 ? 0.0 : i_tops[t - 1]) * h;
  float top = i_tops[t] * h;
  float half_ = i_place.w * scale;
  vec3 local = vec3(a_pos.x * half_, mix(bottom, top, a_pos.y), a_pos.z * half_);
  float c = cos(i_place.z), s = sin(i_place.z);
  v_world = vec3(i_place.x + local.x * c - local.z * s, local.y, i_place.y + local.x * s + local.z * c);
  v_normal = vec3(a_normal.x * c - a_normal.z * s, a_normal.y, a_normal.x * s + a_normal.z * c);
  v_roof = a_face.z;
  v_uv = a_face.z > 0.5 ? a_face.xy * 2.0 * half_ : vec2(a_face.x * 2.0 * half_, a_face.y * (top - bottom));
  v_size = a_face.z > 0.5 ? vec2(2.0 * half_) : vec2(2.0 * half_, top - bottom);
  v_tier = float(t);
  v_light = i_light;
  v_shape = i_shape;
  v_bottom = bottom;
  gl_Position = u_proj * u_view * vec4(v_world.x, v_world.y * u_mirror, v_world.z, 1.0);
}`;

const BUILDING_FS = `${HEADER}
in vec3 v_world;
in vec3 v_normal;
in vec2 v_uv;
in vec2 v_size;
flat in float v_roof;
flat in float v_tier;
flat in vec4 v_light;
flat in vec4 v_shape;
flat in float v_bottom;
uniform vec3 u_eye;
uniform float u_mirror;
uniform float u_clock;
uniform vec4 u_core;
uniform vec4 u_floors[8];
uniform vec4 u_floorLook[8];
uniform int u_floorCount;
${FOG_GLSL}
out vec4 o_color;

const vec3 CYAN = vec3(${CYAN.join(", ")});
const vec3 WHITE_CYAN = vec3(${WHITE_CYAN.join(", ")});

float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }

// A line of the given width in pixels at distance d (world units) from it, fw world units to a pixel: how much of the pixel it covers.
float line(float d, float fw, float width) {
  float w = max(width * fw, 1e-5);
  float lit = 1.0 - smoothstep(0.5 * w, 0.5 * w + fw, d);
  return lit;
}

// The sky and the mist as a face sees them, for its sheen.
vec3 skyIn(vec3 dir) {
  float up = clamp(dir.y, -1.0, 1.0);
  vec3 horizon = vec3(0.004, 0.010, 0.013);
  vec3 zenith = vec3(0.0006, 0.0012, 0.002);
  return mix(horizon, zenith, smoothstep(0.0, 0.6, up)) + vec3(0.002, 0.006, 0.007) * smoothstep(0.1, -0.4, up);
}

void main() {
  vec3 n = normalize(v_normal);
  vec3 eye = vec3(u_eye.x, u_eye.y * u_mirror, u_eye.z);
  vec3 toEye = eye - vec3(v_world.x, v_world.y * u_mirror, v_world.z);
  float dist = length(toEye);
  vec3 V = normalize(vec3(toEye.x, toEye.y * u_mirror, toEye.z));
  int kind = int(v_shape.w + 0.5);
  float strength = v_light.x;
  float picked = v_light.y;
  float silent = v_light.w;
  float seed = v_shape.y;

  // The surface: near black, a little blue, the roofs a shade lighter; a sheen of the sky at a glancing angle, as glass and wet stone have.
  vec3 albedo = v_roof > 0.5 ? vec3(0.009, 0.0095, 0.0105) : vec3(0.0055, 0.006, 0.0068);
  if (kind != 0) albedo = vec3(0.007, 0.0075, 0.0085);
  float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 5.0);
  vec3 color = albedo * (0.35 + 0.65 * max(n.y, 0.0)) * vec3(0.32, 0.36, 0.40);
  color += skyIn(reflect(-V, n)) * fres * 0.22;

  // Your tower's core lights the faces turned to it, cyan, falling off with distance.
  vec3 corePoint = vec3(0.0, clamp(v_world.y, 0.0, u_core.y), 0.0);
  vec3 toCore = corePoint - v_world;
  float dc = length(toCore);
  vec3 L = toCore / max(dc, 1e-3);
  float reach = 1.0 / (1.0 + (dc * dc) / (u_core.z * u_core.z));
  float diffuse = max(dot(n, L), 0.0);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(n, H), 0.0), 48.0);
  if (kind == 0) color += CYAN * u_core.w * reach * (albedo * 1.5 * diffuse + 0.2 * spec * fres * 3.0);

  // How big a world unit is on the screen here, across and up the face.
  vec2 fw = max(fwidth(v_uv), vec2(1e-5));
  float facePx = v_size.x / fw.x;
  float detail = smoothstep(2.0, 9.0, facePx);

  // The light: thin cyan along the ledges (each tier's top), dimmer up the corners, a line at the foot.
  // The closest burn bright enough to bloom; fainter tiers fall off faster than their strength, so the crowd stays quiet.
  float gain = (kind == 0 ? 2.6 : 3.2) * mix(1.0, 0.4, silent);
  float bright = pow(strength, 2.5) * gain;
  vec3 tone = mix(CYAN, WHITE_CYAN, picked);
  if (picked > 0.5) bright = 7.5;
  float glow = 0.0;
  if (v_roof > 0.5) {
    float edge = min(min(v_uv.x, v_size.x - v_uv.x), min(v_uv.y, v_size.y - v_uv.y));
    glow += line(edge, max(fw.x, fw.y), 1.6);
    float inset = v_size.x * 0.16;
    glow += 0.3 * line(abs(edge - inset), max(fw.x, fw.y), 1.0) * smoothstep(9.0, 30.0, facePx);
  } else {
    float u = v_uv.x, v = v_uv.y;
    float rise = v / max(v_size.y, 1e-3);
    glow += line(v_size.y - v, fw.y, 1.6);
    glow += (0.04 + 0.2 * rise * rise) * line(min(u, v_size.x - u), fw.x, 1.0) * detail;
    if (v_tier < 0.5) glow += 0.3 * line(v, fw.y, 1.2);
    // Some buildings carry a spine of light up the middle of their top tier's faces.
    if (kind == 0 && seed > 0.62 && v_tier > 0.5 && v_size.x / fw.x > 14.0) glow += 0.45 * rise * line(abs(u - 0.5 * v_size.x), fw.x, 1.0);
  }
  color += tone * bright * glow * mix(0.2, 1.0, detail);

  // A few lit windows on a friend's building's faces: sparse, faint, and only where they are big enough to see.
  if (kind == 0 && v_roof < 0.5) {
    vec2 cell = vec2(2.6, 3.4);
    vec2 id = floor(vec2(v_uv.x, v_world.y) / cell);
    vec2 inCell = fract(vec2(v_uv.x, v_world.y) / cell);
    float onFace = step(1.2, v_uv.x) * step(1.2, v_size.x - v_uv.x) * step(2.0, v_world.y) * step(1.5, v_size.y + v_bottom - v_world.y);
    float lit = step(0.972 - 0.02 * strength, hash(vec3(id, seed * 97.0 + floor(dot(n, vec3(1.0, 0.0, 3.0)) + 3.0))));
    float pane = step(0.3, inCell.x) * step(inCell.x, 0.7) * step(0.38, inCell.y) * step(inCell.y, 0.62);
    float seen = smoothstep(2.0, 7.0, cell.x / fw.x);
    color += WHITE_CYAN * 0.22 * strength * lit * pane * onFace * seen;
  }

  // Your tower: a core of light up the middle of each face of the shaft, an X of light on the crown, and the floors of whoever lives with you.
  if (kind == 1) {
    float u = v_uv.x - 0.5 * v_size.x;
    if (v_roof < 0.5 && v_tier < 0.5) {
      float slit = v_size.x * 0.035;
      float core = 1.0 - smoothstep(slit * 0.5, slit * 0.5 + fw.x, abs(u));
      float shimmer = 0.85 + 0.15 * sin(v_world.y * 0.35 - u_clock * 1.7);
      color += WHITE_CYAN * core * 4.0 * shimmer;
      color += CYAN * 0.12 * exp(-abs(u) / (v_size.x * 0.06)) * (1.0 - core);
      for (int i = 0; i < 8; i++) {
        if (i >= u_floorCount) break;
        vec4 f = u_floors[i];
        vec4 look = u_floorLook[i];
        float band = step(f.x, v_world.y) * step(v_world.y, f.y);
        float edges = line(abs(v_world.y - f.x), fw.y, 1.4) + line(abs(v_world.y - f.y), fw.y, 1.4);
        vec3 t2 = mix(CYAN, WHITE_CYAN, look.y);
        color += t2 * (edges * (2.2 + 4.0 * look.y) + band * 0.10) * look.x * (1.0 + look.z);
      }
    }
    if (v_roof < 0.5 && v_tier > 0.5 && v_tier < 1.5) {
      vec2 q = vec2(v_uv.x / v_size.x, v_uv.y / max(v_size.y, 1e-3));
      float x = min(abs(q.x - q.y), abs(q.x - (1.0 - q.y))) * v_size.x;
      color += WHITE_CYAN * 4.0 * line(x, fw.x, 2.0);
    }
  }

  // Mirrored, the reflection is fogged by its own path, as the ground's mist would hide it.
  if (u_mirror < 0.0) {
    float T = exp(-fogFrom(eye, vec3(v_world.x, -v_world.y, v_world.z)));
    color = color * T + vec3(0.009, 0.026, 0.033) * (1.0 - T);
  }
  o_color = vec4(color, 1.0);
}`;

const GROUND_VS = `${HEADER}
layout(location=0) in vec2 a_pos;
uniform mat4 u_view;
uniform mat4 u_proj;
out vec3 v_world;
void main() {
  v_world = vec3(a_pos.x, 0.0, a_pos.y);
  gl_Position = u_proj * u_view * vec4(v_world, 1.0);
}`;

const GROUND_FS = `${HEADER}
in vec3 v_world;
uniform vec3 u_eye;
uniform sampler2D u_reflection;
uniform sampler2D u_noise;
uniform vec2 u_target;
uniform float u_avenues[10];
uniform float u_avenueGlow[10];
uniform int u_avenueCount;
uniform float u_plaza;
uniform vec4 u_core;
uniform int u_streakTaps;
out vec4 o_color;

const vec3 CYAN = vec3(${CYAN.join(", ")});
const vec3 WHITE_CYAN = vec3(${WHITE_CYAN.join(", ")});
const float BOULEVARD_HALF = ${BOULEVARD_HALF.toFixed(2)};
const float AVENUE_HALF = ${AVENUE_HALF.toFixed(2)};

// A line of the given width in world units (never under a pixel) at distance d: its light, dimmed rather than thinned below a pixel so far lines do not shimmer.
float paint(float d, float fw, float width) {
  float w = max(width, fw);
  return (1.0 - smoothstep(0.5 * w - 0.5 * fw, 0.5 * w + 0.5 * fw, d)) * (width / w);
}

void main() {
  vec2 p = v_world.xz;
  float r = length(p);
  vec3 toEye = u_eye - v_world;
  float dist = length(toEye);
  vec3 V = toEye / dist;
  float fw = max(fwidth(r), 1e-4);

  vec4 large = texture(u_noise, p / 260.0);
  vec4 fine = texture(u_noise, p / 31.0);
  // Puddles where the large noise is high, damp elsewhere.
  float wet = smoothstep(0.48, 0.64, large.r + (fine.r - 0.5) * 0.12);
  float rough = mix(1.0, 0.08, wet) + (fine.g - 0.5) * 0.15;

  // Which surface: the roads are smoother, darker asphalt; the rest is paving, with faint joints.
  float onRoad = 0.0;
  vec3 lines = vec3(0.0);
  // The boulevards: north, east, south and west of the tower.
  for (int i = 0; i < 4; i++) {
    vec2 dir = i == 0 ? vec2(0.0, -1.0) : i == 1 ? vec2(1.0, 0.0) : i == 2 ? vec2(0.0, 1.0) : vec2(-1.0, 0.0);
    float along = dot(p, dir);
    if (along < u_plaza * 0.9) continue;
    float across = abs(dir.x * p.y - dir.y * p.x);
    float fwa = max(fwidth(across), 1e-4);
    onRoad = max(onRoad, 1.0 - smoothstep(BOULEVARD_HALF, BOULEVARD_HALF + 0.6, across));
    float fade = smoothstep(u_plaza * 0.9, u_plaza * 1.15, along);
    lines += CYAN * 2.6 * paint(abs(across - (BOULEVARD_HALF - 0.55)), fwa, 0.42) * fade;
    float dash = step(fract(along / 11.0), 0.5);
    lines += WHITE_CYAN * 0.55 * paint(abs(across - BOULEVARD_HALF * 0.52), fwa, 0.26) * dash * fade;
    lines += CYAN * 0.9 * paint(abs(across - 0.38), fwa, 0.2) * fade;
  }
  // The avenues: a ring road each, its two edges lit, brighter for the closest.
  for (int i = 0; i < 10; i++) {
    if (i >= u_avenueCount) break;
    float d = abs(r - u_avenues[i]);
    onRoad = max(onRoad, 1.0 - smoothstep(AVENUE_HALF, AVENUE_HALF + 0.5, d));
    lines += CYAN * u_avenueGlow[i] * paint(abs(d - (AVENUE_HALF - 0.4)), fw, 0.3);
  }
  // The plaza's rings, and its floor lit by your tower.
  lines += CYAN * 2.4 * paint(abs(r - u_plaza), fw, 0.5);
  lines += CYAN * 0.7 * paint(abs(r - u_plaza - 3.0), fw, 0.25);
  // The paving's joints, faint and dark, in squares along the boulevards.
  vec2 cell = abs(fract(p / 16.0) - 0.5) * 16.0;
  vec2 fwp = max(fwidth(p), vec2(1e-4));
  float joint = max(1.0 - smoothstep(0.0, fwp.x * 1.2, 8.0 - cell.x), 1.0 - smoothstep(0.0, fwp.y * 1.2, 8.0 - cell.y));
  joint *= (1.0 - onRoad) * smoothstep(0.5, 0.05, fwp.x);

  vec3 albedo = mix(vec3(0.012, 0.0125, 0.0135), vec3(0.0065, 0.0068, 0.0075), onRoad);
  albedo *= 0.85 + 0.3 * fine.b;
  albedo *= 1.0 - 0.35 * joint;
  albedo *= mix(1.0, 0.75, wet);

  // Light pooling round the tower, and the mist's dim light from above.
  float pool = u_core.w / (1.0 + (r * r) / (u_core.z * u_core.z * 1.8));
  vec3 color = albedo * (vec3(0.22, 0.25, 0.28) + CYAN * pool * 8.0);

  // The reflection: the mirrored city at this pixel, nudged by the surface's ripples and streaked up the screen as wet roads streak lights.
  vec2 uv = gl_FragCoord.xy / u_target;
  vec2 ripple = (fine.rg - 0.5) * vec2(0.006, 0.003) * rough;
  float streak = mix(0.004, 0.07, rough);
  vec3 mirrored = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 9; i++) {
    if (i >= u_streakTaps) break;
    float k = float(i) - float(u_streakTaps - 1) * 0.5;
    float w = exp(-k * k / (0.35 * float(u_streakTaps * u_streakTaps)));
    mirrored += texture(u_reflection, uv + ripple + vec2(0.0, k * streak / float(u_streakTaps))).rgb * w;
    total += w;
  }
  mirrored /= total;
  float cosv = clamp(V.y, 0.0, 1.0);
  float fresnel = 0.04 + 0.96 * pow(1.0 - cosv, 5.0);
  color += mirrored * fresnel * mix(0.22, 1.7, wet);

  color += lines;
  o_color = vec4(color, 1.0);
}`;

const SCREEN_VS = `${HEADER}
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const MIST_FS = `${HEADER}
in vec2 v_uv;
uniform sampler2D u_color;
uniform sampler2D u_depth;
uniform highp sampler3D u_mist;
uniform mat4 u_inverse;
uniform vec3 u_eye;
uniform float u_clock;
uniform vec4 u_core;
uniform int u_steps;
uniform float u_far;
${FOG_GLSL}
out vec4 o_color;

const vec3 CYAN = vec3(${CYAN.join(", ")});

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

vec3 sky(vec3 dir) {
  float up = dir.y;
  vec3 horizon = vec3(0.010, 0.028, 0.035);
  vec3 zenith = vec3(0.0012, 0.0028, 0.0038);
  vec3 color = mix(horizon, zenith, smoothstep(0.0, 0.55, up));
  // Low cloud, lit from below by the city, most over the tower.
  if (up > 0.0) {
    float t = (420.0 - u_eye.y) / max(up, 0.02);
    vec3 q = u_eye + dir * t;
    float c = texture(u_mist, vec3(q.xz / 900.0 + vec2(u_clock * 0.002, 0.0), 0.35)).r;
    c = smoothstep(0.35, 0.85, c) * smoothstep(0.0, 0.12, up);
    float over = 1.0 / (1.0 + dot(q.xz, q.xz) / (700.0 * 700.0));
    color = mix(color, vec3(0.012, 0.03, 0.038) + CYAN * 0.04 * over, c * 0.75);
  }
  return color;
}

// The mist's light at a point: its own dim teal, and the glow of the tower's core round it.
vec3 lightAt(vec3 s) {
  float y = clamp(s.y, 0.0, u_core.y);
  float d2 = s.x * s.x + s.z * s.z + (s.y - y) * (s.y - y);
  return vec3(0.009, 0.026, 0.033) + CYAN * u_core.w * 0.12 / (1.0 + d2 / (u_core.z * u_core.z * 2.5));
}

void main() {
  vec3 color = texture(u_color, v_uv).rgb;
  float depth = texture(u_depth, v_uv).r;
  vec4 p = u_inverse * vec4(v_uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec3 end = p.xyz / p.w;
  vec3 ray = end - u_eye;
  float len = length(ray);
  vec3 dir = ray / len;
  if (depth >= 0.999999) {
    color = sky(dir);
    len = u_far;
  }
  len = min(len, u_far);
  // A walk along the ray: the mist's height fog, thicker and thinner in drifting banks, gathering light as it goes.
  float T = 1.0;
  vec3 gathered = vec3(0.0);
  float jitter = ign(gl_FragCoord.xy + fract(u_clock * 7.0) * 37.0);
  float n = float(u_steps);
  vec3 from = u_eye;
  for (int i = 0; i < 16; i++) {
    if (i >= u_steps) break;
    float t1 = len * (float(i) + 1.0) / n;
    vec3 to = u_eye + dir * t1;
    vec3 mid = u_eye + dir * (len * (float(i) + jitter) / n);
    float bank = texture(u_mist, mid * vec3(1.0 / 300.0, 1.0 / 90.0, 1.0 / 300.0) + vec3(u_clock * 0.004, -u_clock * 0.0015, u_clock * 0.0025)).r;
    bank = smoothstep(0.2, 0.85, bank);
    float tau = fogDepth(from, to) * (0.55 + 0.9 * bank) * (1.0 - exp(-length(mid - u_eye) / u_fogNear));
    float a = 1.0 - exp(-tau);
    gathered += T * a * lightAt(mid);
    T *= 1.0 - a;
    from = to;
  }
  o_color = vec4(color * T + gathered, 1.0);
}`;

const LINE_VS = `${HEADER}
layout(location=0) in vec3 a_a;
layout(location=1) in vec3 a_b;
layout(location=2) in vec3 a_rgb;
layout(location=3) in vec2 a_alpha;
layout(location=4) in float a_width;
layout(location=5) in vec2 a_corner;
uniform mat4 u_viewProj;
uniform vec2 u_css;
// Device pixels to a CSS pixel in the picture drawn into (the screen's, times the frame timer's share).
uniform float u_pixel;
out vec3 v_rgb;
out float v_side;
out vec3 v_world;
void main() {
  vec4 ca = u_viewProj * vec4(a_a, 1.0);
  vec4 cb = u_viewProj * vec4(a_b, 1.0);
  float near = 0.05;
  if (ca.w < near && cb.w < near) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (ca.w < near) ca = mix(ca, cb, (near - ca.w) / (cb.w - ca.w));
  if (cb.w < near) cb = mix(cb, ca, (near - cb.w) / (ca.w - cb.w));
  vec2 sa = ca.xy / ca.w * 0.5 * u_css;
  vec2 sb = cb.xy / cb.w * 0.5 * u_css;
  vec2 along = sb - sa;
  vec2 dir = length(along) > 1e-4 ? normalize(along) : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float end = a_corner.x;
  vec4 c = end < 0.5 ? ca : cb;
  // Never thinner than about a pixel and a half of the picture, or a line breaks into dashes; a widened line is dimmed to
  // keep the light it had.
  float width = max(a_width, 1.6 / u_pixel);
  float w = width + 1.5 / u_pixel;
  vec2 offset = normal * a_corner.y * w * 0.5 / (0.5 * u_css);
  c.xy += offset * c.w;
  v_rgb = a_rgb * mix(a_alpha.x, a_alpha.y, end) * (a_width / width);
  v_side = a_corner.y * w / width;
  v_world = mix(a_a, a_b, end);
  gl_Position = c;
}`;

const LINE_FS = `${HEADER}
in vec3 v_rgb;
in float v_side;
in vec3 v_world;
uniform vec3 u_eye;
${FOG_GLSL}
out vec4 o_color;
void main() {
  float d = abs(v_side);
  float core = 1.0 - smoothstep(0.55, 1.15, d);
  float T = exp(-fogFrom(u_eye, v_world));
  o_color = vec4(v_rgb * core * T, 1.0);
}`;

const LIGHTS_VS = `${HEADER}
layout(location=4) in vec4 i_place;
layout(location=5) in vec4 i_shape;
layout(location=8) in vec4 i_light;
uniform mat4 u_viewProj;
uniform vec3 u_eye;
uniform float u_pxPerUnit;
uniform float u_dpr;
uniform float u_time;
uniform float u_rise;
out vec3 v_rgb;
out vec3 v_world;
void main() {
  float p = u_rise > 0.0 ? clamp((u_time - i_shape.z) / u_rise, 0.0, 1.0) : 1.0;
  vec3 top = vec3(i_place.x, i_shape.x * (1.0 - pow(1.0 - p, 3.0)) + 0.4, i_place.y);
  vec4 c = u_viewProj * vec4(top, 1.0);
  float px = 2.0 * i_place.w * u_pxPerUnit / max(c.w, 1e-3);
  float small = 1.0 - smoothstep(2.5, 9.0, px);
  v_world = top;
  v_rgb = vec3(${CYAN.join(", ")}) * (0.6 + 1.6 * i_light.x) * small * (i_shape.w > 0.5 ? 0.0 : 1.0) * mix(1.0, 0.45, i_light.w);
  gl_PointSize = small > 0.0 ? 2.6 * u_dpr : 0.0;
  gl_Position = c;
}`;

const LIGHTS_FS = `${HEADER}
in vec3 v_rgb;
in vec3 v_world;
uniform vec3 u_eye;
${FOG_GLSL}
out vec4 o_color;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float a = 1.0 - smoothstep(0.2, 1.0, dot(q, q));
  o_color = vec4(v_rgb * a * exp(-fogFrom(u_eye, v_world)), 1.0);
}`;

const PREFILTER_FS = `${HEADER}
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_texel;
uniform float u_threshold;
out vec4 o_color;
vec3 karis(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b))); }
void main() {
  vec3 a = texture(u_source, v_uv + u_texel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture(u_source, v_uv + u_texel * vec2(1.0, -1.0)).rgb;
  vec3 c = texture(u_source, v_uv + u_texel * vec2(-1.0, 1.0)).rgb;
  vec3 d = texture(u_source, v_uv + u_texel * vec2(1.0, 1.0)).rgb;
  float wa = 1.0 / (1.0 + max(a.r, max(a.g, a.b)));
  float wb = 1.0 / (1.0 + max(b.r, max(b.g, b.b)));
  float wc = 1.0 / (1.0 + max(c.r, max(c.g, c.b)));
  float wd = 1.0 / (1.0 + max(d.r, max(d.g, d.b)));
  vec3 color = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
  float bright = max(color.r, max(color.g, color.b));
  float knee = u_threshold * 0.5;
  float soft = clamp(bright - u_threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float keep = max(soft, bright - u_threshold) / max(bright, 1e-4);
  o_color = vec4(color * keep, 1.0);
}`;

const DOWN_FS = `${HEADER}
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_texel;
out vec4 o_color;
void main() {
  vec2 t = u_texel;
  vec3 a = texture(u_source, v_uv + t * vec2(-2.0, -2.0)).rgb;
  vec3 b = texture(u_source, v_uv + t * vec2(0.0, -2.0)).rgb;
  vec3 c = texture(u_source, v_uv + t * vec2(2.0, -2.0)).rgb;
  vec3 d = texture(u_source, v_uv + t * vec2(-2.0, 0.0)).rgb;
  vec3 e = texture(u_source, v_uv).rgb;
  vec3 f = texture(u_source, v_uv + t * vec2(2.0, 0.0)).rgb;
  vec3 g = texture(u_source, v_uv + t * vec2(-2.0, 2.0)).rgb;
  vec3 h = texture(u_source, v_uv + t * vec2(0.0, 2.0)).rgb;
  vec3 i = texture(u_source, v_uv + t * vec2(2.0, 2.0)).rgb;
  vec3 j = texture(u_source, v_uv + t * vec2(-1.0, -1.0)).rgb;
  vec3 k = texture(u_source, v_uv + t * vec2(1.0, -1.0)).rgb;
  vec3 l = texture(u_source, v_uv + t * vec2(-1.0, 1.0)).rgb;
  vec3 m = texture(u_source, v_uv + t * vec2(1.0, 1.0)).rgb;
  vec3 color = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  o_color = vec4(color, 1.0);
}`;

const UP_FS = `${HEADER}
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_texel;
uniform float u_spread;
uniform float u_weight;
out vec4 o_color;
void main() {
  vec2 t = u_texel * u_spread;
  vec3 color = texture(u_source, v_uv).rgb * 4.0;
  color += (texture(u_source, v_uv + vec2(-t.x, 0.0)).rgb + texture(u_source, v_uv + vec2(t.x, 0.0)).rgb + texture(u_source, v_uv + vec2(0.0, -t.y)).rgb + texture(u_source, v_uv + vec2(0.0, t.y)).rgb) * 2.0;
  color += texture(u_source, v_uv - t).rgb + texture(u_source, v_uv + t).rgb + texture(u_source, v_uv + vec2(-t.x, t.y)).rgb + texture(u_source, v_uv + vec2(t.x, -t.y)).rgb;
  o_color = vec4(color / 16.0 * u_weight, 1.0);
}`;

const FINAL_FS = `${HEADER}
in vec2 v_uv;
uniform sampler2D u_color;
uniform sampler2D u_bloom;
uniform float u_bloomStrength;
uniform float u_clock;
uniform float u_grain;
uniform vec2 u_size;
out vec4 o_color;

vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 c = v_uv - 0.5;
  float edge = dot(c, c);
  // A touch of the lens: the colours part a hair toward the corners.
  vec2 shift = c * edge * 0.006;
  vec3 color = vec3(texture(u_color, v_uv + shift).r, texture(u_color, v_uv).g, texture(u_color, v_uv - shift).b);
  color += texture(u_bloom, v_uv).rgb * u_bloomStrength;
  color = aces(color);
  // Teal in the shadows, as the reference grades it, and the corners darkened.
  color += vec3(0.0, 0.0012, 0.0016) * (1.0 - color);
  color *= 1.0 - 0.55 * smoothstep(0.08, 0.55, edge);
  color = pow(color, vec3(1.0 / 2.2));
  color += (hash(gl_FragCoord.xy + fract(u_clock) * 113.0) - 0.5) * u_grain / 255.0;
  o_color = vec4(color, 1.0);
}`;

const LABEL_VS = `${HEADER}
layout(location=0) in vec2 a_corner;
layout(location=1) in vec3 i_at;
layout(location=2) in vec4 i_uv;
layout(location=3) in vec4 i_box;
layout(location=4) in vec3 i_look;
uniform mat4 u_viewProj;
uniform vec2 u_css;
uniform float u_dpr;
uniform float u_snap;
uniform sampler2D u_depth;
uniform vec2 u_clip;
out vec2 v_uv;
flat out float v_alpha;
// How much of a name a nearer building hides, from the scene's depth at three points across it: a name fades whole rather than being cut.
float hiddenAt(vec2 px, float depth) {
  float z = textureLod(u_depth, clamp(px / u_css, vec2(0.0), vec2(1.0)), 0.0).r * 2.0 - 1.0;
  float scene = 2.0 * u_clip.x * u_clip.y / (u_clip.y + u_clip.x - z * (u_clip.y - u_clip.x));
  return step(scene, depth);
}
void main() {
  vec4 c = u_viewProj * vec4(i_at, 1.0);
  if (c.w <= 0.0 || i_look.x <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 px = (c.xy / c.w * 0.5 + 0.5) * u_css + vec2(i_box.x, -i_box.y);
  if (u_snap > 0.5) px = floor(px * u_dpr + 0.5) / u_dpr;
  vec2 corner = (a_corner * 2.0 - 1.0) * i_box.zw;
  gl_Position = vec4((px + corner) / u_css * 2.0 - 1.0, 0.0, 1.0);
  v_uv = vec2(mix(i_uv.x, i_uv.z, a_corner.x), mix(i_uv.w, i_uv.y, a_corner.y));
  float depth = c.w - i_look.z;
  float across = i_box.z * 0.55;
  float hidden = (hiddenAt(px - vec2(across, 0.0), depth) + hiddenAt(px, depth) + hiddenAt(px + vec2(across, 0.0), depth)) / 3.0;
  v_alpha = i_look.x * mix(1.0, i_look.y * 0.85, hidden);
}`;

const LABEL_FS = `${HEADER}
in vec2 v_uv;
flat in float v_alpha;
uniform sampler2D u_atlas;
out vec4 o_color;
void main() {
  o_color = texture(u_atlas, v_uv) * v_alpha;
}`;

// The unit stepped form: TIERS_MOST boxes, each a square of half side 1 from y 0 to 1, its four sides and roof.

/** The mesh every building is drawn from: per vertex its place, normal, face coordinates (u, v, roof) and tier. */
export function stepMesh(): { vertices: Float32Array; indices: Uint16Array } {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let tier = 0; tier < TIERS_MOST; tier++) {
    const sides: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [nx, nz] of sides) {
      // The tangent along the face, so (along, up) runs anticlockwise seen from outside.
      const [tx, tz] = [nz, -nx];
      const base = vertices.length / 10;
      for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        vertices.push(nx + tx * (2 * a - 1), b, nz + tz * (2 * a - 1), nx, 0, nz, a, b, 0, tier);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const base = vertices.length / 10;
    for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) vertices.push(2 * a - 1, 1, -(2 * b - 1), 0, 1, 0, a, b, 1, tier);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

/** A tileable 3D noise, `size` voxels a side, `octaves` of value noise: the mist's banks and the clouds. */
export function mistNoise(size: number, octaves = 3, seed = 7): Uint8Array {
  const out = new Uint8Array(size * size * size);
  const lattice = (period: number, salt: number) => {
    const values = new Float32Array(period * period * period);
    let h = (seed * 2654435761 + salt * 40503) >>> 0;
    for (let i = 0; i < values.length; i++) {
      h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
      values[i] = (h >>> 8) / 16777216;
    }
    return values;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const layers = Array.from({ length: octaves }, (_, o) => ({ period: 4 << o, values: lattice(4 << o, o), weight: 1 / (1 << o) }));
  const total = layers.reduce((s, l) => s + l.weight, 0);
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let v = 0;
        for (const { period: p, values, weight } of layers) {
          const [fx, fy, fz] = [(x / size) * p, (y / size) * p, (z / size) * p];
          const [ix, iy, iz] = [Math.floor(fx), Math.floor(fy), Math.floor(fz)];
          const [ux, uy, uz] = [smooth(fx - ix), smooth(fy - iy), smooth(fz - iz)];
          const at = (i: number, j: number, k: number) => values[((i % p) * p + (j % p)) * p + (k % p)];
          const [x1, y1, z1] = [ix + 1, iy + 1, iz + 1];
          const a = at(ix, iy, iz) + (at(x1, iy, iz) - at(ix, iy, iz)) * ux;
          const b = at(ix, y1, iz) + (at(x1, y1, iz) - at(ix, y1, iz)) * ux;
          const c = at(ix, iy, z1) + (at(x1, iy, z1) - at(ix, iy, z1)) * ux;
          const d = at(ix, y1, z1) + (at(x1, y1, z1) - at(ix, y1, z1)) * ux;
          v += weight * ((a + (b - a) * uy) + ((c + (d - c) * uy) - (a + (b - a) * uy)) * uz);
        }
        out[(z * size + y) * size + x] = Math.round((v / total) * 255);
      }
    }
  }
  return out;
}

/** A tileable 2D noise, four channels of differently seeded value noise: the ground's puddles, ripples and grain. */
export function groundNoise(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let channel = 0; channel < 4; channel++) {
    const slice = mistNoise(size, 4, 11 + channel * 5).subarray(0, size * size);
    for (let i = 0; i < size * size; i++) out[i * 4 + channel] = slice[i];
  }
  return out;
}

// The renderer.

interface Program {
  program: WebGLProgram;
  u: (name: string) => WebGLUniformLocation | null;
}

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

/** Why the City could not be drawn here: no WebGL 2. */
export class NoWebGl extends Error {}

export class CityGl {
  private gl: WebGL2RenderingContext;
  private quality: Quality;
  private hdr: { internal: number; type: number };
  private programs: Record<"building" | "ground" | "mist" | "line" | "lights" | "prefilter" | "down" | "up" | "final" | "label", Program>;
  private buffers: { mesh: WebGLBuffer; index: WebGLBuffer; instances: WebGLBuffer; lights: WebGLBuffer; ground: WebGLBuffer; screen: WebGLBuffer; lines: WebGLBuffer; corners: WebGLBuffer; labels: WebGLBuffer };
  private vaos: { building: WebGLVertexArrayObject; lights: WebGLVertexArrayObject; ground: WebGLVertexArrayObject; screen: WebGLVertexArrayObject; lines: WebGLVertexArrayObject; labels: WebGLVertexArrayObject };
  private indexCount: number;
  private instanceCount = 0;
  private textures: { mist: WebGLTexture; noise: WebGLTexture; atlas: WebGLTexture };
  private targets: { scene: Target; depth: WebGLTexture; fogged: Target; mist: WebGLFramebuffer; reflection: Target & { depth: WebGLRenderbuffer }; bloom: Target[] } | null = null;
  private size = { width: 0, height: 0, css: { width: 0, height: 0 }, dpr: 1 };
  private ground: Ground = { avenues: [], plaza: 0 };
  private coreTop = 0;
  private lineCapacity = 0;
  private labelCapacity = 0;
  private atlasSize = { width: 1, height: 1 };
  /** The share of the quality's pixels drawn now (the frame timer's). */
  scale = 1;

  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) throw new NoWebGl("WebGL 2 is not available");
    this.gl = gl;
    this.quality = quality;
    const floats = !!gl.getExtension("EXT_color_buffer_float");
    this.hdr = floats ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    this.programs = {
      building: this.compile(BUILDING_VS, BUILDING_FS),
      ground: this.compile(GROUND_VS, GROUND_FS),
      mist: this.compile(SCREEN_VS, MIST_FS),
      line: this.compile(LINE_VS, LINE_FS),
      lights: this.compile(LIGHTS_VS, LIGHTS_FS),
      prefilter: this.compile(SCREEN_VS, PREFILTER_FS),
      down: this.compile(SCREEN_VS, DOWN_FS),
      up: this.compile(SCREEN_VS, UP_FS),
      final: this.compile(SCREEN_VS, FINAL_FS),
      label: this.compile(LABEL_VS, LABEL_FS),
    };
    const buffer = () => gl.createBuffer()!;
    this.buffers = { mesh: buffer(), index: buffer(), instances: buffer(), lights: buffer(), ground: buffer(), screen: buffer(), lines: buffer(), corners: buffer(), labels: buffer() };

    const mesh = stepMesh();
    this.indexCount = mesh.indices.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.mesh);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    const G = 40000;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.ground);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-G, -G, -G, G, G, G, -G, -G, G, G, G, -G]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.screen);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);

    const vao = () => gl.createVertexArray()!;
    this.vaos = { building: vao(), lights: vao(), ground: vao(), screen: vao(), lines: vao(), labels: vao() };
    // Buildings: the mesh per vertex, the forms and their light per instance.
    gl.bindVertexArray(this.vaos.building);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.mesh);
    const meshAttr = (loc: number, n: number, offset: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 40, offset * 4);
    };
    meshAttr(0, 3, 0);
    meshAttr(1, 3, 3);
    meshAttr(2, 3, 6);
    meshAttr(3, 1, 9);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    this.instanceAttributes(1);
    // The roof lights: the same instances, one point each.
    gl.bindVertexArray(this.vaos.lights);
    this.instanceAttributes(0);
    gl.bindVertexArray(this.vaos.ground);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.ground);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(this.vaos.screen);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.screen);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // Lines: each segment an instance, drawn as a quad of two triangles.
    gl.bindVertexArray(this.vaos.lines);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.lines);
    const lineAttr = (loc: number, n: number, offset: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, LINE_FLOATS * 4, offset * 4);
      gl.vertexAttribDivisor(loc, 1);
    };
    lineAttr(0, 3, 0);
    lineAttr(1, 3, 3);
    lineAttr(2, 3, 6);
    lineAttr(3, 2, 9);
    lineAttr(4, 1, 11);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 2, gl.FLOAT, false, 0, 0);
    // Labels: a corner per vertex, a name per instance.
    gl.bindVertexArray(this.vaos.labels);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.corners);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.labels);
    const labelAttr = (loc: number, n: number, offset: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, LABEL_FLOATS * 4, offset * 4);
      gl.vertexAttribDivisor(loc, 1);
    };
    labelAttr(1, 3, 0);
    labelAttr(2, 4, 3);
    labelAttr(3, 4, 7);
    labelAttr(4, 3, 11);
    gl.bindVertexArray(null);

    // The noise: the mist's banks in 3D, the ground's in 2D.
    const mistSize = quality.name === "lite" ? 32 : 64;
    const mist = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, mist);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, mistSize, mistSize, mistSize, 0, gl.RED, gl.UNSIGNED_BYTE, mistNoise(mistSize));
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const noise = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, noise);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, groundNoise(256));
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const atlas = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.textures = { mist, noise, atlas };
  }

  private instanceAttributes(divisor: number): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instances);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(4 + i);
      gl.vertexAttribPointer(4 + i, 4, gl.FLOAT, false, 64, i * 16);
      gl.vertexAttribDivisor(4 + i, divisor);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.lights);
    gl.enableVertexAttribArray(8);
    gl.vertexAttribPointer(8, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(8, divisor);
  }

  private compile(vs: string, fs: string): Program {
    const gl = this.gl;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`City shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`City shader: ${gl.getProgramInfoLog(program)}`);
    const kept = new Map<string, WebGLUniformLocation | null>();
    return {
      program,
      u: (name) => {
        if (!kept.has(name)) kept.set(name, gl.getUniformLocation(program, name));
        return kept.get(name)!;
      },
    };
  }

  /** The buildings, your tower's two forms among them: drawn as they are until set again. */
  setBuildings(buildings: readonly Building[]): void {
    const gl = this.gl;
    const data = new Float32Array(buildings.length * 16);
    buildings.forEach(({ form, kind, delay }, i) => {
      const o = i * 16;
      data.set([form.x, form.z, form.facing, form.half, form.h, form.seed, delay, kind], o);
      for (let t = 0; t < TIERS_MOST; t++) {
        data[o + 8 + t] = form.scales[t] ?? 0;
        data[o + 12 + t] = form.tops[t] ?? 1;
      }
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instances);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.instanceCount = buildings.length;
    const shaft = buildings.find((b) => b.kind === KIND.shaft);
    this.coreTop = shaft ? shaft.form.h * (shaft.form.tops[0] ?? 1) : 0;
  }

  /** How each building is lit, in the order given to setBuildings. */
  setLights(lights: readonly Light[]): void {
    const gl = this.gl;
    const data = new Float32Array(lights.length * 4);
    lights.forEach((l, i) => data.set([l.strength, l.picked ? 1 : 0, 0, l.silent ? 1 : 0], i * 4));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.lights);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  setGround(ground: Ground): void {
    this.ground = ground;
  }

  /** The names' atlas (orbits3dNames' NameAtlas), drawn at the canvas's pixels. */
  setAtlas(canvas: HTMLCanvasElement): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.textures.atlas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.atlasSize = { width: canvas.width, height: canvas.height };
  }

  /** The canvas's size in CSS pixels and the screen's pixel ratio: the canvas is sized to the quality's pixels, the pictures to the frame timer's share of them. */
  resize(width: number, height: number, devicePixelRatio: number): void {
    const dpr = Math.min(devicePixelRatio, this.quality.pixelRatio);
    const [w, h] = [Math.max(1, Math.round(width * dpr)), Math.max(1, Math.round(height * dpr))];
    if (w === this.size.width && h === this.size.height && this.targets) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.size = { width: w, height: h, css: { width, height }, dpr };
    this.makeTargets();
  }

  /** Changes the share of pixels drawn (the frame timer's), remaking the pictures. */
  setScale(scale: number): void {
    if (Math.abs(scale - this.scale) < 0.01) return;
    this.scale = scale;
    this.makeTargets();
  }

  private texture(width: number, height: number, internal: number, format: number, type: number, filter: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private target(width: number, height: number, depth?: WebGLTexture): Target {
    const gl = this.gl;
    const tex = this.texture(width, height, this.hdr.internal, gl.RGBA, this.hdr.type, gl.LINEAR);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    return { fb, tex, width, height };
  }

  private dropTargets(): void {
    const gl = this.gl;
    const t = this.targets;
    if (!t) return;
    for (const target of [t.scene, t.fogged, t.reflection, ...t.bloom]) {
      gl.deleteFramebuffer(target.fb);
      gl.deleteTexture(target.tex);
    }
    gl.deleteFramebuffer(t.mist);
    gl.deleteTexture(t.depth);
    gl.deleteRenderbuffer(t.reflection.depth);
    this.targets = null;
  }

  private makeTargets(): void {
    const gl = this.gl;
    this.dropTargets();
    const [w, h] = [Math.max(1, Math.round(this.size.width * this.scale)), Math.max(1, Math.round(this.size.height * this.scale))];
    const depth = this.texture(w, h, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.NEAREST);
    const scene = this.target(w, h, depth);
    const fogged = this.target(w, h, depth);
    // The mist reads the depth, so it writes the fogged picture through a framebuffer without it.
    const mist = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, mist);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fogged.tex, 0);
    const [rw, rh] = [Math.max(1, Math.round(w * this.quality.reflection)), Math.max(1, Math.round(h * this.quality.reflection))];
    const reflection = this.target(rw, rh);
    const rdepth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, rdepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, rw, rh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, reflection.fb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rdepth);
    const bloom: Target[] = [];
    let [bw, bh] = [w, h];
    for (let i = 0; i < this.quality.bloomLevels; i++) {
      bw = Math.max(1, Math.round(bw / 2));
      bh = Math.max(1, Math.round(bh / 2));
      bloom.push(this.target(bw, bh));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.targets = { scene, depth, fogged, mist, reflection: { ...reflection, depth: rdepth }, bloom };
  }

  /** Draws one frame. */
  draw(frame: Frame): void {
    const gl = this.gl;
    const t = this.targets;
    if (!t || gl.isContextLost()) return;
    const { programs: P, vaos } = this;
    const viewProj = multiply(frame.projection, frame.view);
    // Height fog thick at the ground and halving every 34 units up, and a thin haze everywhere, so the horizon goes to mist.
    const fog = [3.4e-3, Math.LN2 / 20, 3.2e-4];
    // The mist comes in past about half the camera's distance from what it looks at.
    const fogNear = Math.max(60, frame.focus * 0.55);
    const core = [0, this.coreTop, 85, 0.55];
    const floorData = new Float32Array(32);
    const floorLook = new Float32Array(32);
    const floors = frame.floors.slice(0, 8);
    floors.forEach((f, i) => {
      floorData.set([f.bottom, f.top, 0, 0], i * 4);
      floorLook.set([f.strength, f.picked ? 1 : 0, f.glow, 0], i * 4);
    });

    const drawBuildings = (mirror: number) => {
      const p = P.building;
      gl.useProgram(p.program);
      gl.uniformMatrix4fv(p.u("u_view"), false, frame.view);
      gl.uniformMatrix4fv(p.u("u_proj"), false, frame.projection);
      gl.uniform1f(p.u("u_mirror"), mirror);
      gl.uniform1f(p.u("u_time"), frame.time);
      gl.uniform1f(p.u("u_rise"), frame.rise);
      gl.uniform3fv(p.u("u_eye"), frame.eye as number[]);
      gl.uniform1f(p.u("u_clock"), frame.clock);
      gl.uniform4fv(p.u("u_core"), core);
      gl.uniform3fv(p.u("u_fog"), fog);
      gl.uniform1f(p.u("u_fogNear"), fogNear);
      gl.uniform4fv(p.u("u_floors"), floorData);
      gl.uniform4fv(p.u("u_floorLook"), floorLook);
      gl.uniform1i(p.u("u_floorCount"), floors.length);
      gl.bindVertexArray(vaos.building);
      gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0, this.instanceCount);
    };

    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.cullFace(gl.BACK);

    // 1. The reflection: everything above the ground, upside down.
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.reflection.fb);
    gl.viewport(0, 0, t.reflection.width, t.reflection.height);
    gl.clearColor(0.009, 0.026, 0.033, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.CULL_FACE);
    gl.frontFace(gl.CW);
    drawBuildings(-1);
    gl.frontFace(gl.CCW);
    gl.disable(gl.CULL_FACE);

    // 2. The scene: the ground, then the buildings.
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.scene.fb);
    gl.viewport(0, 0, t.scene.width, t.scene.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    {
      const p = P.ground;
      gl.useProgram(p.program);
      gl.uniformMatrix4fv(p.u("u_view"), false, frame.view);
      gl.uniformMatrix4fv(p.u("u_proj"), false, frame.projection);
      gl.uniform3fv(p.u("u_eye"), frame.eye as number[]);
      gl.uniform2f(p.u("u_target"), t.scene.width, t.scene.height);
      const radii = new Float32Array(10);
      const glows = new Float32Array(10);
      this.ground.avenues.slice(0, 10).forEach((a, i) => {
        radii[i] = a.r;
        glows[i] = a.glow;
      });
      gl.uniform1fv(p.u("u_avenues"), radii);
      gl.uniform1fv(p.u("u_avenueGlow"), glows);
      gl.uniform1i(p.u("u_avenueCount"), Math.min(10, this.ground.avenues.length));
      gl.uniform1f(p.u("u_plaza"), this.ground.plaza);
      gl.uniform4fv(p.u("u_core"), core);
      gl.uniform1i(p.u("u_streakTaps"), this.quality.name === "lite" ? 5 : 9);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.reflection.tex);
      gl.uniform1i(p.u("u_reflection"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.noise);
      gl.uniform1i(p.u("u_noise"), 1);
      gl.bindVertexArray(vaos.ground);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.enable(gl.CULL_FACE);
    drawBuildings(1);
    gl.disable(gl.CULL_FACE);

    // 3. The mist, from the scene and its depth into the fogged picture.
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.mist);
    gl.viewport(0, 0, t.fogged.width, t.fogged.height);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    {
      const p = P.mist;
      gl.useProgram(p.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.scene.tex);
      gl.uniform1i(p.u("u_color"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, t.depth);
      gl.uniform1i(p.u("u_depth"), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, this.textures.mist);
      gl.uniform1i(p.u("u_mist"), 2);
      gl.uniformMatrix4fv(p.u("u_inverse"), false, invert(viewProj));
      gl.uniform3fv(p.u("u_eye"), frame.eye as number[]);
      gl.uniform1f(p.u("u_clock"), frame.clock);
      gl.uniform4fv(p.u("u_core"), core);
      gl.uniform3fv(p.u("u_fog"), fog);
      gl.uniform1f(p.u("u_fogNear"), fogNear);
      gl.uniform1i(p.u("u_steps"), this.quality.mistSteps);
      gl.uniform1f(p.u("u_far"), Math.min(frame.far, 5200));
      gl.bindVertexArray(vaos.screen);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    // 4. What glows on top, added in, behind whatever stands in front of it.
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fogged.fb);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    {
      const p = P.lights;
      gl.useProgram(p.program);
      gl.uniformMatrix4fv(p.u("u_viewProj"), false, viewProj);
      gl.uniform3fv(p.u("u_eye"), frame.eye as number[]);
      gl.uniform1f(p.u("u_pxPerUnit"), frame.projection[5] * 0.5 * this.size.css.height);
      gl.uniform1f(p.u("u_dpr"), this.size.dpr * this.scale);
      gl.uniform1f(p.u("u_time"), frame.time);
      gl.uniform1f(p.u("u_rise"), frame.rise);
      gl.uniform3fv(p.u("u_fog"), fog);
      gl.uniform1f(p.u("u_fogNear"), fogNear);
      gl.bindVertexArray(vaos.lights);
      gl.drawArrays(gl.POINTS, 0, this.instanceCount);
    }
    if (frame.lines.count > 0) {
      const p = P.line;
      gl.useProgram(p.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.lines);
      const floats = frame.lines.count * LINE_FLOATS;
      if (floats > this.lineCapacity) {
        this.lineCapacity = frame.lines.data.length;
        gl.bufferData(gl.ARRAY_BUFFER, frame.lines.data, gl.DYNAMIC_DRAW);
      } else {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame.lines.data, 0, floats);
      }
      gl.uniformMatrix4fv(p.u("u_viewProj"), false, viewProj);
      gl.uniform2f(p.u("u_css"), this.size.css.width, this.size.css.height);
      gl.uniform1f(p.u("u_pixel"), this.size.dpr * this.scale);
      gl.uniform3fv(p.u("u_eye"), frame.eye as number[]);
      gl.uniform3fv(p.u("u_fog"), fog);
      gl.uniform1f(p.u("u_fogNear"), fogNear);
      gl.bindVertexArray(vaos.lines);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, frame.lines.count);
    }
    gl.disable(gl.DEPTH_TEST);

    // 5. Bloom: what is bright, halved and halved again, then gathered back up.
    const screen = (target: Target | null, p: Program, source: WebGLTexture, texel: [number, number]) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
      gl.viewport(0, 0, target ? target.width : this.size.width, target ? target.height : this.size.height);
      gl.useProgram(p.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, source);
      gl.uniform1i(p.u("u_source"), 0);
      gl.uniform2f(p.u("u_texel"), texel[0], texel[1]);
    };
    gl.disable(gl.BLEND);
    gl.bindVertexArray(vaos.screen);
    screen(t.bloom[0], P.prefilter, t.fogged.tex, [1 / t.fogged.width, 1 / t.fogged.height]);
    gl.uniform1f(P.prefilter.u("u_threshold"), 0.85);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    for (let i = 1; i < t.bloom.length; i++) {
      screen(t.bloom[i], P.down, t.bloom[i - 1].tex, [1 / t.bloom[i - 1].width, 1 / t.bloom[i - 1].height]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = t.bloom.length - 1; i > 0; i--) {
      screen(t.bloom[i - 1], P.up, t.bloom[i].tex, [1 / t.bloom[i].width, 1 / t.bloom[i].height]);
      gl.uniform1f(P.up.u("u_spread"), 1);
      // Each wider level adds less, so the bloom is a halo round the light rather than a haze over everything.
      gl.uniform1f(P.up.u("u_weight"), 0.6);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);

    // The picture, onto the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.size.width, this.size.height);
    {
      const p = P.final;
      gl.useProgram(p.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.fogged.tex);
      gl.uniform1i(p.u("u_color"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, t.bloom[0].tex);
      gl.uniform1i(p.u("u_bloom"), 1);
      gl.uniform1f(p.u("u_bloomStrength"), 0.45);
      gl.uniform1f(p.u("u_clock"), frame.clock);
      gl.uniform1f(p.u("u_grain"), this.quality.grain ? 2.2 : 0);
      gl.uniform2f(p.u("u_size"), this.size.width, this.size.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 6. The names, over everything, hidden behind nearer buildings by the scene's depth.
    if (frame.labels.length > 0) {
      const p = P.label;
      const data = new Float32Array(frame.labels.length * LABEL_FLOATS);
      frame.labels.forEach((l, i) => data.set([l.at[0], l.at[1], l.at[2], l.uv[0], l.uv[1], l.uv[2], l.uv[3], l.dx, l.dy, l.wide, l.tall, l.alpha, l.always ? 1 : 0, l.bias], i * LABEL_FLOATS));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.labels);
      if (data.length > this.labelCapacity) {
        this.labelCapacity = data.length * 2;
        gl.bufferData(gl.ARRAY_BUFFER, this.labelCapacity * 4, gl.DYNAMIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(p.program);
      gl.uniformMatrix4fv(p.u("u_viewProj"), false, viewProj);
      gl.uniform2f(p.u("u_css"), this.size.css.width, this.size.css.height);
      gl.uniform1f(p.u("u_dpr"), this.size.dpr);
      gl.uniform1f(p.u("u_snap"), frame.still ? 1 : 0);
      gl.uniform2f(p.u("u_clip"), frame.near, frame.far);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.atlas);
      gl.uniform1i(p.u("u_atlas"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, t.depth);
      gl.uniform1i(p.u("u_depth"), 1);
      gl.bindVertexArray(vaos.labels);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, frame.labels.length);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }

  /** The atlas's size, in device pixels. */
  get atlas(): { width: number; height: number } {
    return this.atlasSize;
  }

  /** Lets go of everything on the GPU, leaving the canvas's context for whatever draws on it next (React may mount the City again on the same canvas). */
  dispose(): void {
    const gl = this.gl;
    this.dropTargets();
    for (const p of Object.values(this.programs)) gl.deleteProgram(p.program);
    for (const b of Object.values(this.buffers)) gl.deleteBuffer(b);
    for (const v of Object.values(this.vaos)) gl.deleteVertexArray(v);
    for (const t of Object.values(this.textures)) gl.deleteTexture(t);
  }
}

const LABEL_FLOATS = 14;

/** a × b, 4×4, column-major. */
export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** The inverse of a 4×4 matrix, column-major. */
export function invert(m: Float32Array): Float32Array {
  const inv = new Float32Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  const d = det === 0 ? 0 : 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= d;
  return inv;
}
