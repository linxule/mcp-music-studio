/**
 * @file A small isometric engine for the sheet widget's Stage: solids in 3D,
 * drawn as flat-toned SVG faces from any of four quarter-turn views.
 *
 * Lineage. The projection, and drawing flat shapes on a plane through one SVG
 * `matrix()`, come from iso-figure (Tolga Cohce, MIT). Three flat tone bands
 * per material, rounded extrusions and per-part shadows come from Colorfigures
 * (April Zhu, MIT), which draws one fixed view; the paper-and-ink look from
 * Anatomy (Ryan, MIT). The Stage shows one angle; what this file adds:
 *
 *  - **Four views, sorted per view.** Painter's order is the only depth test,
 *    so a scene drawn in a fixed order breaks as soon as it turns. Here each
 *    part keeps its bounding box, and {@link orderByBoxes} sorts parts for the
 *    view at hand: two parts whose drawings overlap are ordered by an axis
 *    that separates their boxes, which is exact for boxes. Quarter turns keep
 *    every axis-aligned box axis-aligned, which is why the views are quarter
 *    turns and not a free spin.
 *  - **Colour by CSS variable.** A face carries only its tone band (`l`/`m`/
 *    `d`) and its part's material class; the colours live in CSS. Lighting a
 *    key, ghosting the next note or recolouring an instrument is a class
 *    change, never a re-render.
 *
 * Coordinates: x and y on the floor, z up. The viewer looks from (+1,+1,+1) in
 * VIEW coordinates (the scene turned about its centre), so a box shows its top,
 * its +x face (lower right on screen) and its +y face (lower left).
 */

export type Vec3 = readonly [number, number, number];
export type Turn = 0 | 1 | 2 | 3;
export type Tone = "l" | "m" | "d";

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

/** A flat polygon with its outward normal. */
export interface Face {
  pts: Vec3[];
  n: Vec3;
  /**
   * One strip of a curved surface (a cylinder's side, a rounded body's rim):
   * `[surface id, index, count, rims?]`. Strips are not inked one by one —
   * that reads as stripes — but along the surface's rims and its silhouette.
   * `rims` (default 3) says which ends are a rim worth inking: 1 the first
   * edge (pts 0→1), 2 the second (pts 2→3) — a lathe inks only its ends and
   * its creases, not every ring.
   */
  strip?: readonly [number, number, number] | readonly [number, number, number, number];
}

/**
 * SVG drawn flat on a plane: `svg` is in plane units, x along `u`, y along
 * `v` (so `v` should point "down" the picture). Shown only when the plane's
 * normal `u × v` faces the viewer.
 */
export interface Decal {
  o: Vec3;
  u: Vec3;
  v: Vec3;
  svg: string;
  /**
   * What the picture covers, `[x0, y0, x1, y1]` in plane units. Required for
   * a part drawn only as decals: the depth sort trusts a part's box to bound
   * everything it draws, and a dot whose box was its centre point counted as
   * "apart" from the fingerboard under it — which then drew over it.
   */
  rect?: readonly [number, number, number, number];
}

/** A 3D polyline (a string, a stand's leg) drawn with a CSS class. */
export interface Stroke {
  pts: Vec3[];
  cls: string;
}

export interface Part {
  /** Press id (`data-k`): a key, a drum, a string position. */
  key?: string;
  /** Material class suffix: the part's faces read `--l/--m/--d` from `.m-<mat>`. */
  mat: string;
  /** Extra classes on the part's group. */
  cls?: string;
  faces: Face[];
  decals: Decal[];
  strokes: Stroke[];
  /** Ties between parts whose boxes overlap: lower draws first. */
  pri: number;
  box: Box3;
  /** A non-convex solid: its visible faces are sorted by depth. */
  sortFaces?: boolean;
  /** Draw the part only when this direction faces the viewer (a wall's inner side). */
  when?: Vec3;
  /**
   * Parts of one object sharing a shadow group cast one shadow (the hull of
   * their outlines). Separate pieces (a drum and its stand) get their own
   * groups, or one hull would bridge the floor between them. `false`: none.
   */
  shadow?: string | false;
}

export interface SceneObject {
  id: string;
  cls?: string;
  parts: Part[];
  /** Cast a shadow on the floor (default true). */
  shadow?: boolean;
}

export interface Scene {
  /** Walls etc.: drawn first, in order, each subject to its `when`. */
  back: Part[];
  /** The floor and anything lying flat on it, drawn after the walls. */
  floor: Part[];
  /** The floor's top outline: shadows are clipped to it. */
  floorTop: Vec3[];
  /** Height of the floor's top surface, where shadows fall. */
  floorZ: number;
  objects: SceneObject[];
  /** The point the views turn about. */
  center: readonly [number, number];
  /**
   * Distance from the centre to the eye, in drawing units: a little true
   * perspective (near things larger). Omit for pure isometric, where the far
   * end of a long object reads as larger than the near end.
   */
  eye?: number;
}

export type Rect = readonly [x0: number, y0: number, x1: number, y1: number];

// -----------------------------------------------------------------------------
// Vectors
// -----------------------------------------------------------------------------

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const centroid = (pts: readonly Vec3[]): Vec3 => {
  let x = 0, y = 0, z = 0;
  for (const p of pts) { x += p[0]; y += p[1]; z += p[2]; }
  const k = pts.length || 1;
  return [x / k, y / k, z / k];
};

// -----------------------------------------------------------------------------
// The view
// -----------------------------------------------------------------------------

const C30 = Math.cos(Math.PI / 6);
const S30 = 0.5;
/**
 * The light, in VIEW coordinates: from above, a little from the viewer's
 * right and behind. Tops are lightest, the lower-right face mid, the
 * lower-left face dark, and shadows fall toward the lower left — it stays put
 * relative to the viewer as the scene turns, like a turntable under a studio
 * lamp.
 */
const LIGHT = norm([0.32, -0.55, 1]);
/**
 * Shadows fall straight down: a soft halo under each thing, lifted or not
 * (Anatomy's halo), rather than a cast shadow that lands away from a
 * floating instrument and reads as a second object.
 */
const SHADOW_LENGTH = 0;

export class View {
  constructor(
    readonly turn: Turn,
    readonly center: readonly [number, number],
    /** Eye distance from the centre (drawing units); 0 = isometric. */
    readonly eye = 0,
  ) {}

  /** A direction, turned into view coordinates. */
  dir(v: Vec3): Vec3 {
    switch (this.turn) {
      case 1: return [v[1], -v[0], v[2]];
      case 2: return [-v[0], -v[1], v[2]];
      case 3: return [-v[1], v[0], v[2]];
      default: return v;
    }
  }

  /** A point, turned about the scene's centre into view coordinates. */
  rot(p: Vec3): Vec3 {
    const r = this.dir([p[0] - this.center[0], p[1] - this.center[1], p[2]]);
    return [r[0] + this.center[0], r[1] + this.center[1], r[2]];
  }

  /** Screen position of a point. */
  P(p: Vec3): [number, number] {
    const [a, b, z] = this.rot(p);
    const sx = (a - b) * C30, sy = (a + b) * S30 - z;
    if (!this.eye) return [sx, sy];
    // Two-point perspective: scale about the centre's image by eye / (eye - d),
    // d = distance toward the viewer measured on the ground, so a vertical line
    // keeps one scale and stays vertical (a 3-point view leans tall things out
    // at the edges). Separating-axis order still holds: the eye is outside
    // every part's box.
    const cx = this.center[0], cy = this.center[1];
    const d = (a - cx + (b - cy)) / Math.SQRT2;
    const k = this.eye / Math.max(this.eye * 0.2, this.eye - d);
    const px = (cx - cy) * C30, py = (cx + cy) * S30;
    return [px + (sx - px) * k, py + (sy - py) * k];
  }

  /** Screen displacement of a direction (for plane matrices). */
  D(v: Vec3): [number, number] {
    const [a, b, z] = this.dir(v);
    return [(a - b) * C30, (a + b) * S30 - z];
  }

  /**
   * Whether a face is seen. In isometric that is its normal against the view
   * direction w = (1, 1, 1). With `eye`, P scales the isometric image by
   * k(d) about the centre, and the face is seen when its projected area keeps
   * its sign: n · (k·w + a × ∇k) > 0 at the face's centre. (P's Jacobian is
   * J = k·A + q·∇kᵀ, A the isometric matrix, q the isometric image's offset
   * from the centre; the projected area of tangents t1, t2 is then
   * k·(t1 × t2)·(k·w + a × ∇k) with a = q_y·A_x − q_x·A_y.) That field is smooth, so a curved surface's
   * silhouette is one clean edge — testing each strip's projected winding
   * instead flickered on strips seen nearly edge-on and dashed the rims.
   */
  sees(pts: readonly Vec3[], n: Vec3): boolean {
    if (!this.eye) return this.facing(n);
    let mx = 0, my = 0, mz = 0;
    for (const q of pts) { mx += q[0]; my += q[1]; mz += q[2]; }
    const [a, b, z] = this.rot([mx / pts.length, my / pts.length, mz / pts.length]);
    const [nx, ny, nz] = this.dir(n);
    const cx = this.center[0], cy = this.center[1];
    const d = (a - cx + (b - cy)) / Math.SQRT2;
    const k = this.eye / Math.max(this.eye * 0.2, this.eye - d);
    const g = (k * k) / this.eye / Math.SQRT2; // ∇k = g·(1, 1, 0)
    const qx = (a - b) * C30 - (cx - cy) * C30, qy = (a + b) * S30 - z - (cx + cy) * S30;
    // a = qy·rowX − qx·rowY, rows of the isometric matrix: X = (C30, −C30, 0), Y = (S30, S30, −1).
    const ax = qy * C30 - qx * S30, ay = -qy * C30 - qx * S30, az = qx;
    // a × ∇k with ∇k = (g, g, 0).
    const vx = k * C30 + -az * g, vy = k * C30 + az * g, vz = k * C30 + (ax * g - ay * g);
    return nx * vx + ny * vy + nz * vz > 1e-9;
  }

  facing(n: Vec3): boolean {
    const r = this.dir(n);
    return r[0] + r[1] + r[2] > 1e-6;
  }

  /** Larger is nearer the viewer. */
  depth(p: Vec3): number {
    const r = this.rot(p);
    return r[0] + r[1] + r[2];
  }

  tone(n: Vec3): Tone {
    const d = dot(this.dir(norm(n)), LIGHT);
    return d > 0.62 ? "l" : d > 0.05 ? "m" : "d";
  }

  /** Where a point's shadow lands on the floor at height `z0`. */
  shadowAt(p: Vec3, z0: number): [number, number] {
    const [a, b, z] = this.rot(p);
    const h = Math.max(0, z - z0) * SHADOW_LENGTH;
    const sa = a - (LIGHT[0] / LIGHT[2]) * h;
    const sb = b - (LIGHT[1] / LIGHT[2]) * h;
    return [(sa - sb) * C30, (sa + sb) * S30 - z0];
  }
}

// -----------------------------------------------------------------------------
// Solids — each returns faces with outward normals
// -----------------------------------------------------------------------------

/** Axis-aligned box between two corners. */
export function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Face[] {
  return [
    { n: [0, 0, 1], pts: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
    { n: [0, 0, -1], pts: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]] },
    { n: [1, 0, 0], pts: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]] },
    { n: [-1, 0, 0], pts: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
    { n: [0, 1, 0], pts: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]] },
    { n: [0, -1, 0], pts: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
  ];
}

export type Axis = "x" | "y" | "z";

/** A 2D outline in the plane across `axis`, lifted to 3D at `at` along it. */
function lift(axis: Axis, [p, q]: readonly [number, number], at: number): Vec3 {
  // The outline's (p, q) are (x, y) across z, (x, z) across y, (y, z) across x.
  return axis === "z" ? [p, q, at] : axis === "y" ? [p, at, q] : [at, p, q];
}

function axisVec(axis: Axis, sign: number): Vec3 {
  return axis === "x" ? [sign, 0, 0] : axis === "y" ? [0, sign, 0] : [0, 0, sign];
}

/**
 * An outline extruded along `axis` from `from` to `to` (a slab: a guitar
 * body, a piano case). Any simple polygon, convex or not; mark the part
 * `sortFaces` when it is concave.
 */
let surfaces = 0;

export function prism(
  outline: readonly (readonly [number, number])[],
  axis: Axis,
  from: number,
  to: number,
  smooth = false,
): Face[] {
  const lo = outline.map((p) => lift(axis, p, from));
  const hi = outline.map((p) => lift(axis, p, to));
  const up = axisVec(axis, to > from ? 1 : -1);
  const id = ++surfaces;
  // Which way the outline winds, measured in 3D so every axis agrees.
  let wind = 0;
  for (let i = 0; i < lo.length; i++) {
    const a = lo[i], b = lo[(i + 1) % lo.length];
    wind += dot(cross(a, b), up);
  }
  const faces: Face[] = [
    { n: up, pts: wind > 0 ? hi : [...hi].reverse() },
    { n: scale(up, -1), pts: wind > 0 ? [...lo].reverse() : lo },
  ];
  for (let i = 0; i < lo.length; i++) {
    const j = (i + 1) % lo.length;
    const edge = sub(lo[j], lo[i]);
    if (Math.hypot(...edge) < 1e-9) continue;
    // Outward is to the right of the edge for a counter-clockwise outline.
    const out = norm(wind > 0 ? cross(edge, up) : cross(up, edge));
    faces.push({ n: out, pts: [lo[i], lo[j], hi[j], hi[i]], ...(smooth ? { strip: [id, i, lo.length] as const } : {}) });
  }
  return faces;
}

/**
 * A cylinder or frustum along `axis` through centre `c` (its position across
 * the axis, in the same (p, q) order as {@link prism}), radius `r0` at `from`
 * and `r1` at `to`.
 */
export function cylinder(
  axis: Axis,
  c: readonly [number, number],
  r0: number,
  r1: number,
  from: number,
  to: number,
  n = 20,
): Face[] {
  const ring = (r: number, at: number) =>
    Array.from({ length: n }, (_, i) => {
      const t = (i / n) * Math.PI * 2;
      return lift(axis, [c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r], at);
    });
  const lo = ring(r0, from), hi = ring(r1, to);
  const up = axisVec(axis, to > from ? 1 : -1), down = scale(up, -1);
  const faces: Face[] = [];
  if (r1 > 0) faces.push({ n: up, pts: orient(hi, up) });
  if (r0 > 0) faces.push({ n: down, pts: orient(lo, down) });
  const along = axisVec(axis, 1);
  const id = ++surfaces;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const quad = [lo[i], lo[j], hi[j], hi[i]];
    let nrm = norm(cross(sub(quad[1], quad[0]), sub(quad[3], quad[0])));
    const mid = centroid(quad);
    const radial = sub(mid, lift(axis, c, dot(mid, along)));
    if (dot(nrm, radial) < 0) nrm = scale(nrm, -1);
    faces.push({ n: nrm, pts: quad, strip: [id, i, n] });
  }
  return faces;
}

/**
 * A surface of revolution about `axis` through `c` (a bell, a crown, a drum
 * hoop, a tapering head joint): `profile` is `[radius, position along the
 * axis]` from one end to the other. Ends with a radius get caps. The ink
 * follows the outline only — the two ends, the silhouette, and the profile
 * points listed in `creases` (a sharp step, like a ring's edge).
 */
export function lathe(
  axis: Axis,
  c: readonly [number, number],
  profile: readonly (readonly [number, number])[],
  n = 22,
  creases: readonly number[] = [],
): Face[] {
  const rings = profile.map(([r, at]) => Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return lift(axis, [c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r], at);
  }));
  const along = axisVec(axis, 1);
  const first = profile[0], last = profile[profile.length - 1];
  const up = axisVec(axis, last[1] >= first[1] ? 1 : -1), down = scale(up, -1);
  const faces: Face[] = [];
  if (last[0] > 0) faces.push({ n: up, pts: orient(rings[rings.length - 1], up) });
  if (first[0] > 0) faces.push({ n: down, pts: orient(rings[0], down) });
  for (let k = 0; k + 1 < rings.length; k++) {
    if (profile[k][0] === 0 && profile[k + 1][0] === 0) continue;
    const id = ++surfaces;
    const rims = (k === 0 || creases.includes(k) ? 1 : 0) | (k + 2 === rings.length || creases.includes(k + 1) ? 2 : 0);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const quad = [rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]];
      const mid = centroid(quad);
      const radial = sub(mid, lift(axis, c, dot(mid, along)));
      let nrm = norm(cross(sub(quad[1], quad[0]), sub(quad[3], quad[0])));
      if (!isFinite(nrm[0]) || Math.hypot(...cross(sub(quad[1], quad[0]), sub(quad[3], quad[0]))) < 1e-9) {
        nrm = norm(cross(sub(quad[2], quad[3]), sub(quad[0], quad[3])));
      }
      if (dot(nrm, radial) < 0) nrm = scale(nrm, -1);
      faces.push({ n: nrm, pts: quad, strip: [id, i, n, rims] });
    }
  }
  return faces;
}

/**
 * A tube between two points at any angle (a key rod, a bow's stick, a
 * lamp arm), radius `r0` at `a` and `r1` at `b`, capped at both ends.
 */
export function rod(a: Vec3, b: Vec3, r0: number, r1 = r0, n = 10): Face[] {
  const d = norm(sub(b, a));
  const u = norm(cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  const v = cross(d, u);
  const ring = (p: Vec3, r: number) => Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2, cs = Math.cos(t) * r, sn = Math.sin(t) * r;
    return [p[0] + u[0] * cs + v[0] * sn, p[1] + u[1] * cs + v[1] * sn, p[2] + u[2] * cs + v[2] * sn] as Vec3;
  });
  const A = ring(a, r0), B = ring(b, r1), id = ++surfaces;
  const faces: Face[] = [];
  if (r1 > 0) faces.push({ n: d, pts: orient(B, d) });
  if (r0 > 0) faces.push({ n: scale(d, -1), pts: orient(A, scale(d, -1)) });
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const quad = [A[i], A[j], B[j], B[i]];
    const mid = centroid(quad);
    const axisPt = add(a, scale(d, dot(sub(mid, a), d)));
    let nrm = norm(cross(sub(quad[1], quad[0]), sub(quad[3], quad[0])));
    if (dot(nrm, sub(mid, axisPt)) < 0) nrm = scale(nrm, -1);
    faces.push({ n: nrm, pts: quad, strip: [id, i, n] });
  }
  return faces;
}

/** Order a ring so it winds counter-clockwise seen from the side `n` points to. */
function orient(pts: Vec3[], n: Vec3): Vec3[] {
  let w = 0;
  for (let i = 0; i < pts.length; i++) w += dot(cross(pts[i], pts[(i + 1) % pts.length]), n);
  return w >= 0 ? pts : [...pts].reverse();
}

/** A single flat polygon facing `n` (a rug, a panel). */
export function plate(pts: Vec3[], n: Vec3): Face[] {
  return [{ pts, n }];
}

/** Rotate points and normals by `deg` about `axis` through `pivot`. */
export function rotate(faces: Face[], axis: Axis, deg: number, pivot: Vec3): Face[] {
  const f = rotation(axis, deg, pivot);
  return faces.map((face) => ({ ...face, pts: face.pts.map(f.point), n: f.dir(face.n) }));
}

export function rotation(axis: Axis, deg: number, pivot: Vec3) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const dir = (v: Vec3): Vec3 => {
    const [x, y, z] = v;
    if (axis === "x") return [x, y * c - z * s, y * s + z * c];
    if (axis === "y") return [x * c + z * s, y, -x * s + z * c];
    return [x * c - y * s, x * s + y * c, z];
  };
  return { dir, point: (p: Vec3): Vec3 => add(dir(sub(p, pivot)), pivot) };
}

// -----------------------------------------------------------------------------
// Parts
// -----------------------------------------------------------------------------

export interface PartOptions {
  key?: string;
  cls?: string;
  pri?: number;
  decals?: Decal[];
  strokes?: Stroke[];
  sortFaces?: boolean;
  when?: Vec3;
  shadow?: string | false;
}

export function part(mat: string, faces: Face[], opts: PartOptions = {}): Part {
  const pts: Vec3[] = [];
  for (const f of faces) pts.push(...f.pts);
  for (const s of opts.strokes ?? []) pts.push(...s.pts);
  for (const d of opts.decals ?? []) pts.push(...decalCorners(d));
  return {
    mat,
    faces,
    decals: opts.decals ?? [],
    strokes: opts.strokes ?? [],
    pri: opts.pri ?? 0,
    box: bounds(pts),
    ...(opts.key ? { key: opts.key } : {}),
    ...(opts.cls ? { cls: opts.cls } : {}),
    ...(opts.sortFaces ? { sortFaces: true } : {}),
    ...(opts.when ? { when: opts.when } : {}),
    ...(opts.shadow !== undefined ? { shadow: opts.shadow } : {}),
  };
}

export function bounds(pts: readonly Vec3[]): Box3 {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++) {
    if (p[i] < min[i]) min[i] = p[i];
    if (p[i] > max[i]) max[i] = p[i];
  }
  return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
}

export function unionBox(boxes: readonly Box3[]): Box3 {
  return bounds(boxes.flatMap((b) => [b.min, b.max]));
}

/** A decal on the plane through `o` spanned by `u` (picture x) and `v` (picture y, "down"). */
export const decal = (o: Vec3, u: Vec3, v: Vec3, svg: string, rect?: Decal["rect"]): Decal =>
  rect ? { o, u, v, svg, rect } : { o, u, v, svg };

/** A decal's covered corners in 3D (just its origin when it declares no rect). */
export function decalCorners(d: Decal): Vec3[] {
  if (!d.rect) return [d.o];
  const [x0, y0, x1, y1] = d.rect;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([a, b]) => add(d.o, add(scale(d.u, a), scale(d.v, b))));
}

// -----------------------------------------------------------------------------
// Depth order
// -----------------------------------------------------------------------------

interface Sortable {
  /** Box in VIEW coordinates. */
  vmin: Vec3;
  vmax: Vec3;
  /** Screen bounding box. */
  sx0: number; sy0: number; sx1: number; sy1: number;
  depth: number;
  pri: number;
}

const EPS = 1e-6;

/**
 * Must `a` be drawn before `b`? The viewer looks from +x, +y and +z in view
 * coordinates, so whichever box lies on the far side of a separating plane
 * goes first. If two boxes share a line of sight, every axis that separates
 * them gives the same answer; so when two axes DISAGREE (one box behind and
 * the other above, like a raised lid and the keys in front of it), no line of
 * sight meets both and neither hides the other — `"apart"`, no constraint.
 * Taking the first axis found there is what made a cycle (lid → keybed →
 * keys → lid) and painted a grand's keybed over its keys. `null`: the boxes
 * overlap and only a tie-break can order them.
 */
export function behind(
  a: Pick<Sortable, "vmin" | "vmax">,
  b: Pick<Sortable, "vmin" | "vmax">,
): boolean | "apart" | null {
  let answer: boolean | null = null;
  for (let i = 0; i < 3; i++) {
    let axis: boolean | null = null;
    if (a.vmax[i] <= b.vmin[i] + EPS) axis = true;
    else if (b.vmax[i] <= a.vmin[i] + EPS) axis = false;
    if (axis === null) continue;
    if (answer === null) answer = axis;
    else if (answer !== axis) return "apart";
  }
  return answer;
}

/**
 * Painter's order for items with boxes: a topological sort of "is behind"
 * between items whose drawings overlap. Overlapping boxes fall back to
 * `pri`, then to centre depth; a cycle (never seen for boxes) is broken at the
 * farthest remaining item.
 */
export function orderByBoxes<T extends Sortable>(items: T[]): T[] {
  const n = items.length;
  const after: number[][] = Array.from({ length: n }, () => []);
  const inDeg = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = items[i];
    for (let j = i + 1; j < n; j++) {
      const b = items[j];
      if (a.sx1 <= b.sx0 || b.sx1 <= a.sx0 || a.sy1 <= b.sy0 || b.sy1 <= a.sy0) continue;
      let first = behind(a, b);
      if (first === "apart") continue;
      if (first === null) first = a.pri !== b.pri ? a.pri < b.pri : a.depth <= b.depth;
      if (first) { after[i].push(j); inDeg[j]++; } else { after[j].push(i); inDeg[i]++; }
    }
  }
  const done = new Array<boolean>(n).fill(false);
  const out: T[] = [];
  for (let k = 0; k < n; k++) {
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (done[i] || inDeg[i] > 0) continue;
      if (pick < 0 || items[i].depth < items[pick].depth) pick = i;
    }
    if (pick < 0) {
      for (let i = 0; i < n; i++) if (!done[i] && (pick < 0 || items[i].depth < items[pick].depth)) pick = i;
    }
    done[pick] = true;
    out.push(items[pick]);
    for (const j of after[pick]) inDeg[j]--;
  }
  return out;
}

function sortable(view: View, box: Box3, pts: Iterable<[number, number]>, pri: number) {
  const a = view.rot(box.min), b = view.rot(box.max);
  let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < sx0) sx0 = x; if (x > sx1) sx1 = x;
    if (y < sy0) sy0 = y; if (y > sy1) sy1 = y;
  }
  const mid: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  return {
    vmin: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])] as Vec3,
    vmax: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] as Vec3,
    sx0, sy0, sx1, sy1,
    depth: view.depth(mid),
    pri,
  };
}

// -----------------------------------------------------------------------------
// SVG
// -----------------------------------------------------------------------------

/** Two decimals: at one, small turned parts (a clarinet touch, a post head) read as polygons up close. */
const f1 = (v: number) => (Math.round(v * 100) / 100).toString();
const pathOf = (pts: Iterable<[number, number]>, close = true) => {
  let d = "";
  for (const [x, y] of pts) d += (d ? "L" : "M") + f1(x) + " " + f1(y);
  return close ? d + "Z" : d;
};

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The faces of a part that are seen. A smooth strip seen on its own between two
 * hidden neighbours (or hidden between two seen ones) follows its neighbours: a
 * small wiggle in an outline otherwise breaks the silhouette into dashes.
 */
function visibleFaces(view: View, faces: readonly Face[]): Face[] {
  const seen = faces.map((f) => view.sees(f.pts, f.n));
  const strips = new Map<number, Map<number, number>>();
  faces.forEach((f, i) => {
    if (!f.strip) return;
    let m = strips.get(f.strip[0]);
    if (!m) strips.set(f.strip[0], (m = new Map()));
    m.set(f.strip[1], i);
  });
  const fixed = seen.slice();
  for (const m of strips.values()) {
    for (const [k, i] of m) {
      const n = faces[i].strip![2];
      const l = m.get((k - 1 + n) % n), r = m.get((k + 1) % n);
      if (l !== undefined && r !== undefined && seen[l] === seen[r] && seen[l] !== seen[i]) fixed[i] = seen[l];
    }
  }
  return faces.filter((_, i) => fixed[i]);
}

function partSvg(view: View, p: Part): string {
  if (p.when && !view.facing(p.when)) return "";
  let faces = visibleFaces(view, p.faces);
  if (p.sortFaces) {
    faces = faces
      .map((f) => ({ f, d: view.depth(centroid(f.pts)) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.f);
  }
  let s = "";
  const strips = new Map<number, Set<number>>();
  for (const f of faces) {
    if (f.strip) {
      let seen = strips.get(f.strip[0]);
      if (!seen) strips.set(f.strip[0], (seen = new Set()));
      seen.add(f.strip[1]);
    }
    s += `<path class="f ${f.strip ? "s " : ""}${view.tone(f.n)}" d="${pathOf(f.pts.map((q) => view.P(q)))}"/>`;
  }
  // A curved surface's ink: its two rims, and the edge where it turns away.
  let ink = "";
  for (const f of faces) {
    if (!f.strip) continue;
    const [id, i, n, rims = 3] = f.strip;
    const seen = strips.get(id)!;
    const [a, b, c, d] = f.pts.map((q) => view.P(q));
    if (rims & 1) ink += `M${f1(a[0])} ${f1(a[1])}L${f1(b[0])} ${f1(b[1])}`;
    if (rims & 2) ink += `M${f1(c[0])} ${f1(c[1])}L${f1(d[0])} ${f1(d[1])}`;
    if (!seen.has((i + n - 1) % n)) ink += `M${f1(a[0])} ${f1(a[1])}L${f1(d[0])} ${f1(d[1])}`;
    if (!seen.has((i + 1) % n)) ink += `M${f1(b[0])} ${f1(b[1])}L${f1(c[0])} ${f1(c[1])}`;
  }
  if (ink) s += `<path class="ink" d="${ink}"/>`;
  for (const st of p.strokes) s += `<path class="${st.cls}" d="${pathOf(st.pts.map((q) => view.P(q)), false)}"/>`;
  for (const d of p.decals) {
    if (!view.facing(cross(d.u, d.v))) continue;
    // The plane's local axes at the decal's origin (exact in isometric; in perspective, true at the origin).
    const o = view.P(d.o), pu = view.P(add(d.o, d.u)), pv = view.P(add(d.o, d.v));
    const u = [pu[0] - o[0], pu[1] - o[1]], v = [pv[0] - o[0], pv[1] - o[1]];
    s += `<g transform="matrix(${[u[0], u[1], v[0], v[1], o[0], o[1]].map((x) => x.toFixed(4)).join(" ")})">${d.svg}</g>`;
  }
  if (!s) return "";
  const cls = `p m-${p.mat}${p.cls ? " " + p.cls : ""}`;
  return `<g class="${cls}"${p.key ? ` data-k="${escapeXml(p.key)}"` : ""}>${s}</g>`;
}

/**
 * Where a part lands on screen, for the overlap test. A part drawn only as
 * decals (a tone hole, a fret cell) counts by its decals' origins — with no
 * points at all it overlapped nothing, took no order, and its body drew over it.
 */
function* partScreenPoints(view: View, p: Part): Generator<[number, number]> {
  for (const f of p.faces) for (const q of f.pts) yield view.P(q);
  for (const s of p.strokes) for (const q of s.pts) yield view.P(q);
  for (const d of p.decals) for (const q of decalCorners(d)) yield view.P(q);
}

/** Convex hull of 2D points (monotone chain). */
export function hull2(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const turn = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], up: [number, number][] = [];
  for (const p of pts) {
    while (lo.length >= 2 && turn(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (up.length >= 2 && turn(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
    up.push(p);
  }
  lo.pop(); up.pop();
  return lo.concat(up);
}

/** One object's parts in the order they are painted from `view`. */
export function paintOrder(parts: readonly Part[], view: View): Part[] {
  return orderByBoxes(parts.map((p) => ({ p, ...sortable(view, p.box, partScreenPoints(view, p), p.pri) }))).map((x) => x.p);
}

export interface Rendered {
  svg: string;
  /** Screen bounds of the whole scene. */
  bounds: Rect;
  /** Screen bounds of each object, for framing a close-up. */
  objects: Map<string, Rect>;
}

const rectOf = (pts: Iterable<[number, number]>): Rect => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
};

/**
 * Draw a scene from one view. Layers: walls (each only from inside), floor,
 * shadows (clipped to the floor), then objects in box order, each object's
 * parts in box order.
 */
export function renderScene(scene: Scene, turn: Turn, clipId = "stage-floor"): Rendered {
  const view = new View(turn, scene.center, scene.eye);
  let svg = "";
  const all: [number, number][] = [];
  const backs = scene.back
    .filter((p) => !p.when || view.facing(p.when))
    .map((p) => ({ p, ...sortable(view, p.box, partScreenPoints(view, p), p.pri) }));
  for (const { p } of orderByBoxes(backs)) {
    svg += partSvg(view, p);
    for (const q of partScreenPoints(view, p)) all.push(q);
  }
  for (const p of scene.floor) {
    svg += partSvg(view, p);
    for (const q of partScreenPoints(view, p)) all.push(q);
  }

  const shadows: string[] = [];
  const objects = new Map<string, Rect>();
  const placed = scene.objects.map((obj) => {
    const pts: [number, number][] = [];
    for (const p of obj.parts) for (const q of partScreenPoints(view, p)) pts.push(q);
    const box = unionBox(obj.parts.map((p) => p.box));
    objects.set(obj.id, rectOf(pts));
    for (const q of pts) all.push(q);
    if (obj.shadow !== false) {
      const groups = new Map<string, [number, number][]>();
      for (const p of obj.parts) {
        if (p.shadow === false) continue;
        const key = p.shadow ?? "";
        let sh = groups.get(key);
        if (!sh) groups.set(key, (sh = []));
        for (const f of p.faces) for (const q of f.pts) sh.push(view.shadowAt(q, scene.floorZ));
      }
      // A group with no faces (a pole alone) has no outline to cast.
      for (const sh of groups.values()) if (sh.length >= 3) shadows.push(`<path d="${pathOf(hull2(sh))}"/>`);
    }
    return { obj, ...sortable(view, box, pts, 0) };
  });
  if (shadows.length) {
    svg += `<clipPath id="${clipId}"><path d="${pathOf(scene.floorTop.map((q) => view.P(q)))}"/></clipPath>`;
    svg += `<g class="shadow" clip-path="url(#${clipId})">${shadows.join("")}</g>`;
  }
  for (const { obj } of orderByBoxes(placed)) {
    svg += `<g class="obj${obj.cls ? " " + obj.cls : ""}" data-obj="${escapeXml(obj.id)}">${paintOrder(obj.parts, view).map((p) => partSvg(view, p)).join("")}</g>`;
  }
  return { svg, bounds: rectOf(all), objects };
}

/** Move parts by (dx, dy, dz): faces, strokes, decals and boxes. */
export function translate(parts: Part[], d: Vec3): Part[] {
  const t = (p: Vec3) => add(p, d);
  return parts.map((p) => ({
    ...p,
    faces: p.faces.map((f) => ({ ...f, pts: f.pts.map(t) })),
    strokes: p.strokes.map((s) => ({ cls: s.cls, pts: s.pts.map(t) })),
    decals: p.decals.map((dc) => ({ ...dc, o: t(dc.o) })),
    box: { min: t(p.box.min), max: t(p.box.max) },
  }));
}
