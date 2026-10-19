/**
 * @file Stage figures: guitars — the classical (nylon) guitar, the solid-body
 * electric, the electric bass. Each stands upright, its top toward the player
 * (+y), low string on the left and the nut at the top: a chord chart.
 *
 * Dimensions (cm; 1 unit = 1 cm, real unless marked ×):
 *
 * | | classical | electric (S-type) | bass (J-type) |
 * |---|---|---|---|
 * | scale (nut → saddle) | 65.0 | 64.8 (25.5") | 86.4 (34") |
 * | body length | 49 | 45.7 (horn tip) | 52.6 (horn tip) |
 * | lower / waist / upper bout | 36.6 / 24 / 28.4 | 32.4 wide | 32.8 wide |
 * | body depth | 10 at the tail → 9.2 at the heel | 4.45, edges rounded | 4.45 |
 * | neck meets body at | 12th fret | 16th (neck pocket) | 16th |
 * | frets drawn | 19 | 21 | 20 |
 * | nut width / outer-string spread | 5.2 / 4.3 → ×1.2 | 4.2 / 3.5 → ×1.2 | 3.8 / 2.9 → ×1.2 |
 * | string spread at saddle | 5.8 → ×1.2 | 5.25 → ×1.2 | 5.7 → ×1.1 |
 * | headstock | 19, slotted, back-angled 12°, rollers 3.5 apart | 20, flat, 6 in line | 21.6, flat, 4 in line |
 * | soundhole / rosette | Ø 8.6 / Ø 13.7, centre 15.3 below the heel | — | — |
 * | bridge | 18.7 × 2.9, tie block behind the saddle | 6 saddles on a trem plate | 4 saddles, plate + rear lip |
 *
 * ×1.2 across the neck only (the playing surface: frets, cells, strings);
 * everything else, scale lengths and fret spacing (equal temperament) included,
 * is true. Sources: Fender Stratocaster / Jazz Bass spec sheets (fender.com:
 * 25.5" and 34" scales, 1.650"/1.5" nuts, 21/20 frets, 2-1/16" saddle spacing);
 * classical-guitar plans (Ramírez/Torres-pattern: 650 scale, 52 nut, 58 at the
 * saddle, body 485–490, bouts 365/235/285, depth 95–100, 12-fret joint).
 *
 * Parts (maker's order). Classical: ribs+back (tapered), spruce top (binding,
 * rosette rings + mosaic, soundhole), bridge wings, saddle bed, tie block
 * (mosaic tile, six holes), bone saddle, six string ties, ebony fretboard (19
 * frets), neck (rounded back), heel, bone nut, slotted headstock (bar, two
 * cheeks, centre bar, crown), six rollers, two tuner plates (3 screws each), six
 * key shafts, six buttons — 40, plus six strings and 78 cells.
 * Electric: body core, rounded front edge, pickguard (11 screws), three
 * single-coils (6 pole pieces, 2 screws each), trem plate (6 pivot screws),
 * rear flange, six saddles (height screws), six intonation screws, trem arm
 * (socket, bar, tip), volume and two tone knobs, 5-way switch (slot + tip),
 * jack plate + jack, two strap buttons, neck heel in its pocket, neck, maple board (21 frets, dots), nut, headstock, six posts with bushings,
 * six tuner housings, six buttons, string tree — 60.
 * Bass: body core, front edge, pickguard (screws), two J pickups (8 poles),
 * control plate, three knobs, jack, bridge plate, rear lip, four saddles, four
 * intonation screws, finger rest, two strap buttons, neck heel, neck,
 * rosewood board (20 frets, dots), nut, headstock, four posts, four housings,
 * four keys, string tree — 43.
 */
import "./guitars.css";
import { box, cross, cylinder, decal, dot, lathe, norm, part, prism, rod, scale, sub, translate, type Face, type Part, type Vec3 } from "../iso";
import { FLOAT, type Figure } from "./common";
import { type NeckSpec, bodyOutline, liftNeck, neckFigure, neckParts, stopZ, stringX } from "./necks";

// -----------------------------------------------------------------------------
// Shapes
// -----------------------------------------------------------------------------

type P2 = readonly [number, number];
/** A plane y = a + b·z (a flat top, or a back that tapers). */
type Lin = readonly [number, number];

let surf = 7_000_000;
const f2 = (v: number) => (Math.round(v * 100) / 100).toString();
const crs = (a: number, b: number, c: number, d: number, t: number) =>
  0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
const crp = (p0: P2, p1: P2, p2: P2, p3: P2, t: number): [number, number] =>
  [crs(p0[0], p1[0], p2[0], p3[0], t), crs(p0[1], p1[1], p2[1], p3[1], t)];

/** A smooth closed curve through the points (Catmull-Rom). */
function closedSpline(pts: readonly P2[], per = 5): [number, number][] {
  const n = pts.length, out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p = (k: number) => pts[(i + k + n) % n];
    for (let s = 0; s < per; s++) out.push(crp(p(-1), p(0), p(1), p(2), s / per));
  }
  return out;
}

/** A smooth open curve through the points, ends included. */
function openSpline(pts: readonly P2[], per = 5): [number, number][] {
  const n = pts.length, out: [number, number][] = [];
  for (let i = 0; i < n - 1; i++) {
    const p = (k: number) => pts[Math.max(0, Math.min(n - 1, i + k))];
    for (let s = 0; s < per; s++) out.push(crp(p(-1), p(0), p(1), p(2), s / per));
  }
  out.push([pts[n - 1][0], pts[n - 1][1]]);
  return out;
}

const area = (poly: readonly P2[]) => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
};

/** The outline moved inward by d (a binding line, a rounded edge's inner rim). */
function inset(poly: readonly P2[], d: number): [number, number][] {
  const s = Math.sign(area(poly)) || 1, n = poly.length;
  const inward = (a: P2, b: P2): [number, number] => {
    const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
    return [(-s * ey) / l, (s * ex) / l];
  };
  return poly.map((p, i) => {
    const n1 = inward(poly[(i - 1 + n) % n], p), n2 = inward(p, poly[(i + 1) % n]);
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const l = Math.hypot(mx, my) || 1;
    mx /= l; my /= l;
    const k = d / Math.max(0.35, mx * n1[0] + my * n1[1]);
    return [p[0] + mx * k, p[1] + my * k];
  });
}

const move = (poly: readonly P2[], dx: number, dz: number, deg = 0): [number, number][] => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return poly.map(([x, z]) => [x * c - z * s + dx, x * s + z * c + dz]);
};

/** A rounded slot outline (a pickup cover, a control plate) centred on 0, `len` along x. */
function stadium(len: number, wid: number, n = 6): [number, number][] {
  const r = wid / 2, h = len / 2 - r, out: [number, number][] = [];
  for (let k = 0; k <= n; k++) { const t = -Math.PI / 2 + (Math.PI * k) / n; out.push([h + r * Math.cos(t), r * Math.sin(t)]); }
  for (let k = 0; k <= n; k++) { const t = Math.PI / 2 + (Math.PI * k) / n; out.push([-h + r * Math.cos(t), r * Math.sin(t)]); }
  return out;
}

const ellipse = (a: number, b: number, n = 16): [number, number][] =>
  Array.from({ length: n }, (_, k) => [a * Math.cos((2 * Math.PI * k) / n), b * Math.sin((2 * Math.PI * k) / n)]);

/**
 * A slab between two outlines in the (x, z) plane, the back one on plane `yb`
 * and the front one on `yf` (same point count): a body whose back tapers, an
 * edge that rounds over (front outline inset), a flat plate (both equal).
 */
function loftY(back: readonly P2[], yb: Lin, front: readonly P2[], yf: Lin, o: { smooth?: boolean; backCap?: boolean; frontCap?: boolean } = {}): Face[] {
  const B = back.map(([x, z]) => [x, yb[0] + yb[1] * z, z] as Vec3);
  const F = front.map(([x, z]) => [x, yf[0] + yf[1] * z, z] as Vec3);
  const s = Math.sign(area(front)) || 1, n = B.length, id = ++surf;
  const faces: Face[] = [];
  if (o.frontCap !== false) faces.push({ n: norm([0, 1, -yf[1]]), pts: F });
  if (o.backCap !== false) faces.push({ n: norm([0, -1, yb[1]]), pts: [...B].reverse() });
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = front[j][0] - front[i][0], ez = front[j][1] - front[i][1];
    if (Math.hypot(ex, ez) < 1e-9) continue;
    const quad = [B[i], B[j], F[j], F[i]];
    const out: Vec3 = [s * ez, 0, -s * ex];
    let nn = cross(sub(quad[1], quad[0]), sub(quad[3], quad[0]));
    if (Math.hypot(...nn) < 1e-9) nn = cross(sub(quad[2], quad[3]), sub(quad[0], quad[3]));
    nn = norm(nn);
    if (dot(nn, out) < 0) nn = scale(nn, -1);
    faces.push({ n: nn, pts: quad, ...(o.smooth ? { strip: [id, i, n] as const } : {}) });
  }
  return faces;
}

/** A solid between two cross-sections in the (x, y) plane at heights z0 < z1 (a neck that tapers). */
function loftZ(z0: number, r0: readonly P2[], z1: number, r1: readonly P2[], flat: readonly number[] = []): Face[] {
  const A = r0.map(([x, y]) => [x, y, z0] as Vec3), B = r1.map(([x, y]) => [x, y, z1] as Vec3);
  const n = A.length, id = ++surf;
  const cx = r0.reduce((s, p) => s + p[0], 0) / n, cy = r0.reduce((s, p) => s + p[1], 0) / n;
  const faces: Face[] = [{ n: [0, 0, -1], pts: A }, { n: [0, 0, 1], pts: B }];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, quad = [A[i], A[j], B[j], B[i]];
    let nn = norm(cross(sub(quad[1], quad[0]), sub(quad[3], quad[0])));
    const mx = (A[i][0] + A[j][0]) / 2 - cx, my = (A[i][1] + A[j][1]) / 2 - cy;
    if (nn[0] * mx + nn[1] * my < 0) nn = scale(nn, -1);
    faces.push({ n: nn, pts: quad, ...(flat.includes(i) ? {} : { strip: [id, i, n] as const }) });
  }
  return faces;
}

const rectXY = (hw: number, y0: number, y1: number): P2[] => [[-hw, y0], [hw, y0], [hw, y1], [-hw, y1]];
/** A neck's section: flat under the board at `y`, a rounded back `d` deep. */
const neckSection = (hw: number, y: number, d: number): P2[] =>
  Array.from({ length: 10 }, (_, k) => [hw * Math.cos((Math.PI * k) / 9), y - d * Math.sin((Math.PI * k) / 9)] as P2);

/** SVG path of an (x, z) outline drawn on a +y face (picture y = −z). */
const pathOf = (poly: readonly P2[], close = true) =>
  "M" + poly.map(([x, z]) => `${f2(x)} ${f2(-z)}`).join("L") + (close ? "Z" : "");
/** A decal on the +y plane y = Y, in (x, −z) picture coordinates. */
const onFront = (y: number, svg: string, rect?: readonly [number, number, number, number]) => decal([0, y, 0], [1, 0, 0], [0, 0, -1], svg, rect);
const circ = (x: number, z: number, r: number, cls: string) => `<circle class="${cls}" cx="${f2(x)}" cy="${f2(-z)}" r="${f2(r)}"/>`;
const line = (x0: number, z0: number, x1: number, z1: number, cls: string) =>
  `<line class="${cls}" x1="${f2(x0)}" y1="${f2(-z0)}" x2="${f2(x1)}" y2="${f2(-z1)}"/>`;

/** Points evenly spaced along a closed outline (screws round a pickguard). */
function along(poly: readonly P2[], count: number): P2[] {
  const seg = poly.map((p, i) => Math.hypot(poly[(i + 1) % poly.length][0] - p[0], poly[(i + 1) % poly.length][1] - p[1]));
  const total = seg.reduce((a, b) => a + b, 0), out: P2[] = [];
  let i = 0, acc = 0;
  for (let k = 0; k < count; k++) {
    const want = (total * (k + 0.5)) / count;
    while (acc + seg[i] < want) acc += seg[i++];
    const t = (want - acc) / seg[i], a = poly[i], b = poly[(i + 1) % poly.length];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

const knob = (x: number, z: number, y0: number, mat: string, h = 1.8, r = 1.05): Part =>
  part(mat, lathe("y", [x, z], [[r, y0], [r, y0 + 0.22], [r * 0.9, y0 + 0.28], [r * 0.8, y0 + h - 0.15], [r * 0.5, y0 + h - 0.02], [0, y0 + h]], 16, [1, 2, 3]), { pri: 3, shadow: false });

/** A strap button: a turned peg out of the body's end along ±z. */
const strapButton = (x: number, y: number, z: number, dir: 1 | -1): Part =>
  part("metal", lathe("z", [x, y], [[0.45, z], [0.3, z + dir * 0.35], [0.7, z + dir * 0.65], [0.55, z + dir * 0.95]], 12, [1, 2]), { pri: 2, shadow: false });

// -----------------------------------------------------------------------------
// The classical guitar
// -----------------------------------------------------------------------------

function classical(): Figure {
  const Z0 = 7, BODY = 49, top = Z0 + BODY;
  const SCALE = 65, nutZ = top + SCALE / 2, bridgeZ = nutZ - SCALE;
  const yT = 4.6, front = yT + 1.2;
  /** Fretboard half-width: 3.12 at the nut, 3.72 at the 12th fret (×1.2). */
  const hw = (z: number) => 3.12 + (0.6 * (nutZ - z)) / (nutZ - top);
  // The headstock leans back 12° from the nut: s along it, t into it from its face.
  const tilt = (12 * Math.PI) / 180, D: Vec3 = [0, -Math.sin(tilt), Math.cos(tilt)], K: Vec3 = [0, -Math.cos(tilt), -Math.sin(tilt)];
  const h0: Vec3 = [0, yT, nutZ + 0.6];
  const at = (x: number, s: number, t: number): Vec3 => [x, h0[1] + D[1] * s + K[1] * t, h0[2] + D[2] * s + K[2] * t];
  const headSlab = (outline: readonly P2[], t0: number, t1: number, smooth = false): Face[] => {
    const F = outline.map(([x, s]) => at(x, s, t0)), Bk = outline.map(([x, s]) => at(x, s, t1));
    const sg = Math.sign(area(outline)) || 1, n = outline.length, id = ++surf;
    const faces: Face[] = [{ n: scale(K, -1), pts: F }, { n: K, pts: [...Bk].reverse() }];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ex = outline[j][0] - outline[i][0], es = outline[j][1] - outline[i][1];
      const l = Math.hypot(ex, es);
      if (l < 1e-9) continue;
      const ox = (sg * es) / l, os = (-sg * ex) / l;
      faces.push({ n: [ox, D[1] * os, D[2] * os], pts: [F[i], F[j], Bk[j], Bk[i]], ...(smooth ? { strip: [id, i, n] as const } : {}) });
    }
    return faces;
  };
  const rect = (x0: number, x1: number, s0: number, s1: number): P2[] => [[x0, s0], [x1, s0], [x1, s1], [x0, s1]];
  const ROLLERS = [5.4, 9.0, 12.6];
  const neck: NeckSpec = {
    tuning: [40, 45, 50, 55, 59, 64],
    frets: 12,
    nutZ,
    bridgeZ,
    nutHalf: 2.6,
    bridgeHalf: 3.5,
    y: front - 0.4,
    fretted: true,
    // Through the tie block's holes behind the saddle (and tied over it).
    tail: (i) => [stringX(neck, i, bridgeZ), yT + 0.95, bridgeZ - 0.75],
    // Into the slots, round a roller: the outer strings to the rollers farthest from the nut.
    head: (i) => {
      const bass = i < 3, k = bass ? 2 - i : i - 3;
      return at(bass ? -1.25 + (i - 1) * 0.3 : 1.25 + (i - 4) * 0.3, ROLLERS[k], 0.45);
    },
  };
  const parts: Part[] = [];
  const shadow = "guitar";

  // Body: ribs and back (10 deep at the tail, 9.2 at the heel), and the spruce top.
  const out = bodyOutline(
    [[0, 0], [0.5, 6], [2, 10.6], [5, 14.8], [9, 17.6], [12.5, 18.3], [16, 17.8], [20, 15.9], [24, 13.3], [27.5, 12.0], [30, 12.0],
      [33, 12.7], [37, 13.9], [40, 14.2], [43, 13.6], [45.5, 12.0], [47.4, 9.2], [48.6, 5.5], [49, 0]],
    Z0,
  );
  const back: Lin = [yT - 10 - (0.8 * Z0) / BODY, 0.8 / BODY];
  parts.push(part("wood", loftY(out, back, out, [yT - 0.35, 0], { smooth: true, frontCap: false }), { pri: 1, sortFaces: true, shadow }));
  const hole = { z: top - 15.3, r: 4.3 };
  const ticks = Array.from({ length: 72 }, (_, k) => {
    const a = (2 * Math.PI * k) / 72, c = Math.cos(a), s = Math.sin(a);
    return line(5.3 * c, hole.z + 5.3 * s, 6.3 * c, hole.z + 6.3 * s, "g-tick");
  }).join("");
  const rosette = circ(0, hole.z, hole.r, "hole") + [4.75, 5.0, 5.3, 6.3, 6.6, 6.85].map((r) => circ(0, hole.z, r, "rosette")).join("") + ticks;
  parts.push(part("spruce", loftY(out, [yT - 0.35, 0], out, [yT, 0], { smooth: true, backCap: false }), { pri: 1.2, sortFaces: true, shadow,
    decals: [onFront(yT, `<path class="g-bind" d="${pathOf(inset(out, 0.3))}"/><path class="g-bind" d="${pathOf(inset(out, 0.6))}"/>${rosette}`)] }));

  // Bridge: wings glued to the top, the saddle bed, the tie block behind; a bone saddle.
  const zb = bridgeZ;
  const wings: P2[] = [[-4.3, zb + 0.9], [4.3, zb + 0.9], [8.8, zb + 0.35], [9.35, zb - 0.35], [8.8, zb - 1.05], [4.3, zb - 1.6], [4.3, zb - 2.0],
    [-4.3, zb - 2.0], [-4.3, zb - 1.6], [-8.8, zb - 1.05], [-9.35, zb - 0.35], [-8.8, zb + 0.35]];
  parts.push(part("wood", loftY(wings, [yT, 0], wings, [yT + 0.45, 0], { backCap: false }), { pri: 2, sortFaces: true, shadow: false }));
  parts.push(part("wood", box(-4.3, yT + 0.45, zb - 0.75, 4.3, yT + 0.85, zb + 0.9), { pri: 2.2, shadow: false }));
  const tiles = Array.from({ length: 15 }, (_, k) => {
    const x = -4.05 + k * 0.54;
    return `<rect class="g-tile" x="${f2(x)}" y="${f2(-(zb - 1.15))}" width="0.5" height="0.5"/>`;
  }).join("");
  parts.push(part("wood", box(-4.3, yT + 0.45, zb - 2.0, 4.3, yT + 1.05, zb - 0.75), { pri: 2.2, shadow: false,
    decals: [
      onFront(yT + 1.05, tiles),
      decal([0, 0, zb - 0.75], [1, 0, 0], [0, 1, 0], neck.tuning.map((_, i) => `<circle class="g-hole" cx="${f2(stringX(neck, i, zb))}" cy="${f2(yT + 0.95)}" r="0.16"/>`).join("")),
    ] }));
  parts.push(part("ivory", box(-4.0, yT + 0.85, zb - 0.15, 4.0, front, zb + 0.15), { pri: 2.5, shadow: false }));
  // Each string comes out the back of the tie block and is tied over its top.
  parts.push(part("nylon", [], { pri: 4, shadow: false, strokes: neck.tuning.map((_, i) => {
    const x = stringX(neck, i, zb), y = yT + 1.08;
    return { pts: [[x, y, zb - 2.0], [x + 0.32, y, zb - 1.45], [x - 0.22, y, zb - 1.05], [x + 0.05, y, zb - 0.8]] as Vec3[], cls: "g-knot" };
  }) }));

  // Neck: rounded back, a little deeper toward the heel; the heel curls down to the back.
  const d = (z: number) => 2.0 + (0.25 * (nutZ - z)) / (nutZ - top);
  parts.push(part("wood", loftZ(top, neckSection(hw(top), yT, d(top)), nutZ + 0.6, neckSection(hw(nutZ + 0.6), yT, d(nutZ + 0.6)), [9]), { pri: 2, shadow }));
  const heel = openSpline([[yT - 2.25, top + 8.5], [yT - 2.6, top + 6], [yT - 3.6, top + 3.8], [yT - 5.4, top + 2.0], [yT - 7.6, top + 0.7], [yT - 9.2, top]], 4);
  heel.push([yT - 2.25, top]);
  parts.push(part("wood", prism(heel, "x", -2.6, 2.6, true), { pri: 1.5, sortFaces: true, shadow }));

  // Ebony fretboard from the nut to the soundhole: 19 frets at their true places.
  const end = stopZ(neck, 19) - 0.5;
  const frets = Array.from({ length: 19 }, (_, k) => { const z = stopZ(neck, k + 1); return line(-hw(z) + 0.05, z, hw(z) - 0.05, z, "fret"); }).join("");
  parts.push(part("ebony", loftZ(end, rectXY(hw(end), yT, yT + 0.8), nutZ, rectXY(hw(nutZ), yT, yT + 0.8), [0, 1, 2, 3]), { pri: 3, shadow: false,
    decals: [onFront(yT + 0.8, frets)] }));
  parts.push(part("ivory", box(-hw(nutZ), yT, nutZ, hw(nutZ), front, nutZ + 0.6), { pri: 3.5, shadow: false }));

  // Slotted headstock: bottom bar, two cheeks and a centre bar round the slots, the crown.
  parts.push(part("wood", headSlab(rect(-3.25, 3.25, 0, 3.2), 0, 1.9), { pri: 2.4, shadow }));
  for (const [x0, x1] of [[-3.25, -1.95], [-0.55, 0.55], [1.95, 3.25]]) parts.push(part("wood", headSlab(rect(x0, x1, 3.2, 14.8), 0, 1.9), { pri: 2.5, shadow }));
  const crown = openSpline([[3.25, 14.8], [3.25, 16.9], [2.5, 17.5], [1.5, 18.1], [0.7, 18.95], [0, 19.3], [-0.7, 18.95], [-1.5, 18.1], [-2.5, 17.5], [-3.25, 16.9], [-3.25, 14.8]], 3);
  crown.pop();
  parts.push(part("wood", headSlab(crown, 0, 1.9, true), { pri: 2.6, sortFaces: true, shadow,
    decals: [decal(at(0, 0, 0), [1, 0, 0], scale(D, -1), `<path class="g-edge" d="M-2.6 -15.4L2.6 -15.4"/>`)] }));
  for (const sd of [-1, 1]) {
    for (const s of ROLLERS) {
      const c = at(0, s, 0.95);
      parts.push(part("ivory", cylinder("x", [c[1], c[2]], 0.5, 0.5, sd > 0 ? 0.55 : -1.95, sd > 0 ? 1.95 : -0.55, 12), { pri: 2.45, shadow: false }));
      // The key: a shaft out of the plate's back edge, a button behind the headstock.
      parts.push(part("metal", rod(at(sd * 3.32, s, 1.75), at(sd * 3.32, s, 3.1), 0.13), { pri: 1, shadow: false }));
      parts.push(part("ivory", rod(at(sd * 3.32, s, 3.1), at(sd * 3.32, s, 4.7), 0.55, 0.45), { pri: 1, shadow: false }));
    }
    const plate = rect(sd > 0 ? 3.25 : -3.4, sd > 0 ? 3.4 : -3.25, 4.0, 14.0);
    const screws = [4.6, 9.0, 13.4].map((s) => `<circle class="g-screw" cx="${s}" cy="0.95" r="0.24"/>`).join("") + `<rect class="g-edge" x="4.1" y="0.25" width="9.8" height="1.4"/>`;
    parts.push(part("metal", headSlab(plate, 0.15, 1.75), { pri: 2.55, shadow: false,
      decals: sd > 0 ? [decal(at(3.4, 0, 0), D, K, screws)] : [] }));
  }

  parts.push(...neckParts(neck));
  const lift: Vec3 = [20, 16, FLOAT];
  return neckFigure("guitar", translate(parts, lift), [40, 32, Math.ceil(at(0, 19.3, 0)[2]) + 1 + FLOAT], liftNeck(neck), lift);
}

// -----------------------------------------------------------------------------
// Solid bodies: the electric guitar and the electric bass
// -----------------------------------------------------------------------------

interface SolidSpec {
  kind: "guitar" | "ebass";
  tuning: number[];
  scale: number;
  /** Body outline (x, z from the butt), the neck pocket's edge, the bass horn's tip. */
  body: P2[];
  pocket: number;
  horn: P2;
  fretsDrawn: number;
  nutHalf: number;
  bridgeHalf: number;
  /** Board half-width at the nut and at the last fret. */
  board: readonly [number, number];
  boardMat: string;
  dots: string;
  neckDepth: number;
  /** Headstock outline (x, s up from the nut), post spacing, the first post, the strings a tree holds. */
  head: P2[];
  posts: { s0: number; step: number; x0: number; dx: number; r: number };
  tree: { s: number; strings: number[] };
  guard: P2[];
  pickups: { z: number; deg: number; len: number; wid: number; poles: number; onGuard: boolean }[];
  saddleZ: number;
  extras: (ctx: Ctx) => Part[];
}

interface Ctx { yT: number; Z0: number; bridgeZ: number; front: number; neck: NeckSpec }

function solidBody(spec: SolidSpec): Figure {
  const Z0 = 7, yT = 2.2, yB = yT - 4.45, yMid = (yT + yB) / 2;
  const pocket = Z0 + spec.pocket;
  const nutZ = pocket + spec.scale * (1 - 2 ** (-16 / 12));
  const bridgeZ = nutZ - spec.scale;
  const neckY = yT + 0.5, boardTop = yT + 1.0, front = boardTop + 0.4;
  const strings = spec.tuning.length;
  const lastFret = stopZ({ nutZ, bridgeZ } as NeckSpec, spec.fretsDrawn);
  const hwb = (z: number) => spec.board[0] + ((spec.board[1] - spec.board[0]) * (nutZ - z)) / (nutZ - lastFret);
  const headZ = nutZ + 0.5;
  const postAt = (k: number): [number, number] => [spec.posts.x0 + spec.posts.dx * k, headZ + spec.posts.s0 + spec.posts.step * k];
  const postTop = neckY + (spec.posts.r > 0.4 ? 0.9 : 0.75);
  const neck: NeckSpec = {
    tuning: spec.tuning,
    frets: 12,
    nutZ,
    bridgeZ,
    nutHalf: spec.nutHalf,
    bridgeHalf: spec.bridgeHalf,
    y: boardTop,
    fretted: true,
    ...(strings === 4 ? { wire: "g-heavy" } : {}),
    // From the bridge's back (through-body ferrules or the rear lip), over the saddles.
    tail: (i) => [stringX(neck, i, bridgeZ), yT + 0.9, bridgeZ - spec.saddleZ],
    // Round its post, the low string nearest the nut.
    head: (i) => { const [x, z] = postAt(i); return [x + spec.posts.r, postTop, z]; },
    // The treble strings run under the string tree.
    via: (i) => {
      if (!spec.tree.strings.includes(i)) return [];
      const [px, pz] = postAt(i), z = headZ + spec.tree.s, x0 = stringX(neck, i, nutZ);
      return [[x0 + ((px + spec.posts.r - x0) * (z - nutZ)) / (pz - nutZ), neckY + 0.5, z]];
    },
  };
  const ctx: Ctx = { yT, Z0, bridgeZ, front, neck };
  const parts: Part[] = [];
  const shadow = spec.kind;

  // Body: the slab, and its front edge rounded over (a bevel to an inset rim).
  const out = closedSpline(spec.body.map(([x, z]) => [x, Z0 + z] as P2), 4);
  parts.push(part("body", loftY(out, [yB, 0], out, [yT - 0.5, 0], { smooth: true, frontCap: false }), { pri: 1, sortFaces: true, shadow }));
  parts.push(part("body", loftY(out, [yT - 0.5, 0], inset(out, 0.55), [yT, 0], { smooth: true, backCap: false }), { pri: 1.1, sortFaces: true, shadow }));
  parts.push(strapButton(0, yMid, Z0, -1), strapButton(spec.horn[0], yMid, Z0 + spec.horn[1], 1));

  // Pickguard, screwed down round its edge.
  const guard = closedSpline(spec.guard.map(([x, z]) => [x, Z0 + z] as P2), 3);
  const gTop = yT + 0.25;
  const guardScrews = along(inset(guard, 0.55), strings === 6 ? 11 : 9).map(([x, z]) => circ(x, z, 0.2, "g-screw")).join("");
  const puScrews: string[] = [];
  for (const pu of spec.pickups) {
    const zc = Z0 + pu.z, base = pu.onGuard ? gTop : yT, a = (pu.deg * Math.PI) / 180;
    const outline = move(stadium(pu.len, pu.wid), 0, zc, -pu.deg);
    const poles = spec.tuning.flatMap((_, i) => {
      const lx = stringX(neck, i, zc) / Math.cos(a);
      const offs = pu.poles > strings ? [-0.32, 0.32] : [0];
      return offs.map((o) => { const [[x, z]] = move([[lx + o, 0]], 0, zc, -pu.deg); return circ(x, z, 0.24, "g-pole"); });
    }).join("");
    parts.push(part("ivory", loftY(outline, [base, 0], outline, [base + 0.75, 0], { smooth: true, backCap: false }), { pri: 2.5, shadow: false,
      decals: [onFront(base + 0.75, poles)] }));
    for (const sd of [-1, 1]) { const [[x, z]] = move([[sd * (pu.len / 2 + 0.4), 0]], 0, zc, -pu.deg); puScrews.push(circ(x, z, 0.18, "g-screw")); }
  }
  parts.push(part("guard", loftY(guard, [yT, 0], guard, [gTop, 0], { smooth: true, backCap: false }), { pri: 1.5, sortFaces: true, shadow: false,
    decals: [onFront(gTop, guardScrews + puScrews.join(""))] }));

  // Neck: its heel in the pocket, the rounded neck from the pocket to the head, the board.
  const boardEnd = lastFret - 0.6;
  const heelLow = boardEnd - 0.4;
  parts.push(part("maple", loftZ(heelLow, rectXY(hwb(heelLow), yT, neckY), pocket, rectXY(hwb(pocket), yT, neckY), [0, 1, 2, 3]), { pri: 2, shadow: false }));
  const dn = spec.neckDepth - 0.5;
  parts.push(part("maple", loftZ(pocket, neckSection(hwb(pocket), neckY, dn), headZ, neckSection(hwb(headZ), neckY, dn * 0.92), [9]), { pri: 2, shadow }));
  const frets = Array.from({ length: spec.fretsDrawn }, (_, k) => { const z = stopZ(neck, k + 1); return line(-hwb(z) + 0.05, z, hwb(z) - 0.05, z, "fret"); }).join("");
  const mid = (k: number) => (stopZ(neck, k - 1) + stopZ(neck, k)) / 2;
  const dots = [3, 5, 7, 9, 15, 17, 19, 21].filter((k) => k <= spec.fretsDrawn).map((k) => circ(0, mid(k), 0.38, spec.dots)).join("") +
    [-1, 1].map((sd) => circ(sd * 1.1, mid(12), 0.38, spec.dots)).join("");
  parts.push(part(spec.boardMat, loftZ(boardEnd, rectXY(hwb(boardEnd), neckY, boardTop), nutZ, rectXY(hwb(nutZ), neckY, boardTop), [0, 1, 2, 3]), { pri: 3, shadow: false,
    decals: [onFront(boardTop, dots + frets)] }));
  parts.push(part("ivory", box(-hwb(nutZ), neckY, nutZ, hwb(nutZ), front, headZ), { pri: 3.5, shadow: false }));

  // Headstock, flat, a little below the board; posts in line along the bass side.
  const headOut = openSpline(spec.head.map(([x, s]) => [x, headZ + s] as P2), 4);
  parts.push(part("maple", loftY(headOut, [neckY - 1.4, 0], headOut, [neckY, 0], { smooth: true }), { pri: 2.5, sortFaces: true, shadow,
    decals: [onFront(neckY, circ(0, headZ + 1.0, 0.3, "g-hole"))] }));
  const r = spec.posts.r;
  for (let k = 0; k < strings; k++) {
    const [x, z] = postAt(k);
    parts.push(part("metal", lathe("y", [x, z], [[r + 0.2, neckY], [r + 0.2, neckY + 0.18], [r, neckY + 0.18], [r, postTop + 0.3], [r * 0.7, postTop + 0.4], [0, postTop + 0.42]], 12, [1, 2, 3]), { pri: 4, shadow: false }));
    // The machine on the back, its key out past the bass edge.
    const edge = Math.min(...headOut.filter(([, hz]) => Math.abs(hz - z) < 1.6).map(([hx]) => hx)) + 0.3;
    parts.push(part("metal", box(edge, neckY - 2.6, z - 0.75, x + 0.6, neckY - 1.4, z + 0.75), { pri: 1, shadow: false }));
    const w = r > 0.4 ? 1.15 : 0.72;
    parts.push(part("metal", lathe("x", [neckY - 2.0, z], [[0.22, edge], [0.22, edge - 0.8], [w * 0.65, edge - 0.9], [w, edge - 1.6], [w * 0.8, edge - 2.3], [0, edge - 2.45]], 12, [1, 2]), { pri: 1, shadow: false }));
  }
  const treeZ = headZ + spec.tree.s;
  const tx = spec.tree.strings.map((i) => neck.via!(i)[0][0]).reduce((a, b) => a + b, 0) / spec.tree.strings.length;
  parts.push(part("metal", cylinder("y", [tx, treeZ], 0.15, 0.15, neckY, neckY + 0.55, 8), { pri: 4, shadow: false }));
  parts.push(part("metal", cylinder("y", [tx, treeZ], 0.55, 0.55, neckY + 0.55, neckY + 0.7, 12), { pri: 5.5, shadow: false }));

  parts.push(...spec.extras(ctx));
  parts.push(...neckParts(neck));
  const lift: Vec3 = [20, 16, FLOAT];
  const topZ = Math.max(...headOut.map(([, z]) => z));
  return neckFigure(spec.kind, translate(parts, lift), [40, 32, Math.ceil(topZ) + 1 + FLOAT], liftNeck(neck), lift);
}

/** Saddles on a bridge plate, each with its intonation screw back to the plate's rear flange. */
function saddles(c: Ctx, len: number, flangeZ: number, mat = "metal"): Part[] {
  const parts: Part[] = [];
  const n = c.neck.tuning.length, gap = (2 * c.neck.bridgeHalf) / (n - 1), hs = gap * 0.45;
  for (let i = 0; i < n; i++) {
    const x = stringX(c.neck, i, c.bridgeZ), z0 = c.bridgeZ - len + 0.3, y0 = c.yT + 0.2;
    parts.push(part(mat, box(x - hs, y0, z0, x + hs, c.front, c.bridgeZ + 0.3), { pri: 2.6, shadow: false,
      decals: [onFront(c.front, circ(x - hs * 0.5, z0 + 0.5, 0.15, "g-screw") + circ(x + hs * 0.5, z0 + 0.5, 0.15, "g-screw"))] }));
    parts.push(part("metal", rod([x, y0 + 0.35, flangeZ], [x, y0 + 0.35, z0], 0.11), { pri: 2.6, shadow: false }));
  }
  return parts;
}

export function guitar(electric: boolean): Figure {
  if (!electric) return classical();
  return solidBody({
    kind: "guitar",
    tuning: [40, 45, 50, 55, 59, 64],
    scale: 64.8,
    body: [[0, 0], [7, 0.8], [12.5, 4], [15.6, 9], [16.2, 14], [15, 19.5], [12.6, 23.5], [12.8, 27.5], [14.0, 32], [13.6, 36.5], [11.2, 40.5], [9.8, 42.3],
      [7.6, 42.0], [6.4, 39.8], [5.0, 37.6], [3.3, 37], [0, 37], [-3.3, 37], [-5.0, 38], [-6.6, 41.5], [-7.6, 44.6], [-9.6, 45.7], [-11.6, 44.6], [-12.6, 41],
      [-12.9, 36.5], [-13.8, 31.5], [-12.6, 25.5], [-13.0, 22], [-15.6, 17], [-16.2, 12], [-15.4, 7], [-12.4, 3], [-7, 0.6]],
    pocket: 37,
    horn: [-9.6, 45.7],
    fretsDrawn: 21,
    nutHalf: 2.1,
    bridgeHalf: 3.15,
    board: [2.5, 3.35],
    boardMat: "maple",
    dots: "g-dot",
    neckDepth: 2.1,
    head: [[2.3, 0], [2.6, 2], [2.2, 5], [2.0, 8.5], [2.6, 12], [3.6, 15.5], [3.8, 17.8], [2.9, 19.6], [1.0, 20.2], [-1.2, 19.8], [-2.6, 18.6], [-3.0, 16.5],
      [-3.0, 6], [-2.7, 2.5], [-2.3, 0]],
    posts: { s0: 4.3, step: 2.55, x0: -1.9, dx: 0, r: 0.3 },
    tree: { s: 8, strings: [4, 5] },
    guard: [[3.4, 37.0], [5.0, 37.3], [6.3, 38.6], [7.4, 36.8], [9.4, 31.5], [11.4, 26.0], [12.6, 19.5], [12.4, 13.0], [10.6, 8.2], [7.4, 6.6], [5.2, 8.2],
      [4.7, 10.8], [4.5, 13.4], [-4.4, 13.6], [-5.6, 13.3], [-8.6, 14.3], [-10.8, 17.5], [-11.6, 22.5], [-10.9, 28.5], [-9.4, 33.0], [-6.8, 36.6], [-5.0, 38.3], [-3.4, 37.0]],
    pickups: [
      { z: 26.5, deg: 0, len: 8.3, wid: 1.8, poles: 6, onGuard: true },
      { z: 21.5, deg: 0, len: 8.3, wid: 1.8, poles: 6, onGuard: true },
      { z: 17.3, deg: 10, len: 8.3, wid: 1.8, poles: 6, onGuard: true },
    ],
    saddleZ: 2.1,
    extras: (c) => {
      const { yT, Z0, bridgeZ: zb } = c, gTop = yT + 0.25;
      const parts: Part[] = [];
      // Tremolo bridge: plate with six pivot screws, the rear flange, saddles, the arm.
      parts.push(part("metal", box(-4.3, yT, zb - 2.6, 4.3, yT + 0.2, zb + 1.4), { pri: 2, shadow: false,
        decals: [onFront(yT + 0.2, Array.from({ length: 6 }, (_, k) => circ(-3.6 + k * 1.44, zb + 0.95, 0.17, "g-screw")).join(""))] }));
      parts.push(part("metal", box(-4.3, yT + 0.2, zb - 2.6, 4.3, yT + 0.95, zb - 2.35), { pri: 2.2, shadow: false }));
      parts.push(...saddles(c, 2.1, zb - 2.35));
      const sock: Vec3 = [4.0, yT + 0.2, zb - 1.7], bend: Vec3 = [4.0, yT + 1.4, zb - 1.7], arm: Vec3 = [5.4, yT + 2.2, zb - 6.5], tip: Vec3 = [5.8, yT + 2.3, zb - 8.4];
      parts.push(part("metal", rod(sock, bend, 0.2), { pri: 2.7, shadow: false }));
      parts.push(part("metal", rod(bend, arm, 0.12), { pri: 2.7, shadow: false }));
      parts.push(part("ivory", rod(arm, tip, 0.3, 0.26), { pri: 2.7, shadow: false }));
      // Volume and two tones; the 5-way switch; the jack in its plate on the face.
      for (const [x, z] of [[7.6, 15.6], [9.2, 12.6], [10.4, 9.8]]) parts.push(knob(x, Z0 + z, gTop, "ivory"));
      const sw: P2 = [7.2, Z0 + 19.2];
      parts.push(part("ivory", lathe("y", sw, [[0.24, gTop], [0.24, gTop + 0.7], [0.42, gTop + 0.8], [0.42, gTop + 1.3], [0, gTop + 1.38]], 10, [1, 2, 3]), { pri: 3, shadow: false,
        decals: [onFront(gTop, `<path class="g-slot" d="${pathOf(move(stadium(2.6, 0.38), sw[0], sw[1], 30))}"/>`)] }));
      const jack: P2 = [10.6, Z0 + 4.8];
      parts.push(part("metal", loftY(move(ellipse(1.9, 1.05), jack[0], jack[1], -35), [yT, 0], move(ellipse(1.9, 1.05), jack[0], jack[1], -35), [yT + 0.1, 0], { smooth: true, backCap: false }), { pri: 2, shadow: false }));
      parts.push(part("metal", lathe("y", jack, [[0.62, yT + 0.1], [0.62, yT + 0.5]], 6), { pri: 2.3, shadow: false,
        decals: [onFront(yT + 0.5, circ(jack[0], jack[1], 0.32, "g-hole"))] }));
      return parts;
    },
  });
}

export function bassGuitar(): Figure {
  return solidBody({
    kind: "ebass",
    tuning: [28, 33, 38, 43],
    scale: 86.4,
    body: [[0, 0], [7, 0.7], [13, 3.8], [16.0, 9], [16.4, 14.5], [15, 20], [12.2, 24.5], [11.8, 28.5], [12.8, 33.5], [12.6, 38], [10.6, 42.5], [9.2, 46.2],
      [7.6, 46.6], [6.2, 45.4], [4.6, 44.7], [3.1, 44.5], [0, 44.5], [-3.1, 44.5], [-4.8, 45.2], [-6.4, 48.0], [-7.6, 51.2], [-9.4, 52.6], [-11.2, 51.6],
      [-12.4, 47.5], [-12.8, 42], [-13.8, 36], [-13.0, 29.5], [-13.6, 24.5], [-15.6, 19], [-16.4, 13.5], [-15.6, 8], [-12.6, 3.4], [-7, 0.6]],
    pocket: 44.5,
    horn: [-9.4, 52.6],
    fretsDrawn: 20,
    nutHalf: 1.75,
    bridgeHalf: 3.15,
    board: [2.3, 3.55],
    boardMat: "ebony",
    dots: "inlay",
    neckDepth: 2.2,
    head: [[2.0, 0], [2.3, 2], [2.0, 6], [2.1, 10], [3.1, 14.5], [3.6, 18], [3.1, 20.6], [1.4, 21.6], [-0.8, 21.3], [-2.4, 20.2], [-3.1, 17.5], [-3.1, 6],
      [-2.6, 2.5], [-2.0, 0]],
    posts: { s0: 5.0, step: 4.2, x0: -2.0, dx: 0, r: 0.45 },
    tree: { s: 7.2, strings: [2, 3] },
    guard: [[3.2, 44.5], [4.8, 44.8], [6.0, 46.0], [7.6, 42.5], [9.0, 36], [9.6, 30], [8.8, 25], [7.0, 20.4], [5.6, 18.4], [5.0, 17.4], [-5.6, 17.6],
      [-8.0, 18.6], [-10.0, 22], [-10.6, 28], [-10.0, 34.5], [-8.6, 40], [-6.6, 46.4], [-4.6, 45.0], [-3.2, 44.5]],
    pickups: [
      { z: 29.0, deg: 0, len: 9.6, wid: 2.0, poles: 8, onGuard: true },
      { z: 15.2, deg: 0, len: 9.6, wid: 2.0, poles: 8, onGuard: false },
    ],
    saddleZ: 3.3,
    extras: (c) => {
      const { yT, Z0, bridgeZ: zb } = c, gTop = yT + 0.25;
      const parts: Part[] = [];
      // Bridge: plate (three screws), the rear lip the ball ends hook on, four saddles.
      parts.push(part("metal", box(-3.9, yT, zb - 3.6, 3.9, yT + 0.18, zb + 1.0), { pri: 2, shadow: false,
        decals: [onFront(yT + 0.18, [-2.8, 0, 2.8].map((x) => circ(x, zb + 0.6, 0.17, "g-screw")).join(""))] }));
      parts.push(part("metal", box(-3.9, yT + 0.18, zb - 3.6, 3.9, yT + 1.25, zb - 3.3), { pri: 2.2, shadow: false }));
      parts.push(...saddles(c, 2.7, zb - 3.3));
      // Control plate along the lower bout: volume, volume, tone, and the jack at its foot.
      const cp: P2 = [9.8, Z0 + 12.2], deg = 116.8, a = (deg * Math.PI) / 180;
      const plate = move(stadium(11.2, 3.2), cp[0], cp[1], deg);
      const pAt = (t: number): P2 => [cp[0] + t * Math.cos(a), cp[1] + t * Math.sin(a)];
      const screws = [-5.0, 5.0].map((t) => { const [x, z] = pAt(t); return circ(x, z, 0.18, "g-screw"); }).join("");
      parts.push(part("metal", loftY(plate, [yT, 0], plate, [yT + 0.15, 0], { smooth: true, backCap: false }), { pri: 2, shadow: false, decals: [onFront(yT + 0.15, screws)] }));
      for (const t of [3.9, 1.2, -1.5]) { const [x, z] = pAt(t); parts.push(knob(x, z, yT + 0.15, "metal", 1.4, 0.95)); }
      const [jx, jz] = pAt(-3.9);
      parts.push(part("metal", lathe("y", [jx, jz], [[0.62, yT + 0.15], [0.62, yT + 0.55]], 6), { pri: 2.3, shadow: false,
        decals: [onFront(yT + 0.55, circ(jx, jz, 0.32, "g-hole"))] }));
      // Finger rest on the treble side, below the strings.
      const rest = move(stadium(4.6, 0.9), 5.4, Z0 + 33.5, 90);
      parts.push(part("ebony", loftY(rest, [gTop, 0], rest, [gTop + 1.0, 0], { smooth: true, backCap: false }), { pri: 2.5, shadow: false }));
      return parts;
    },
  });
}
