/**
 * @file Stage figures: the violin family (violin, viola, cello, double bass),
 * built the way a luthier builds them, at 1 unit ≈ 1 cm.
 *
 * Frame: x across the instrument (string 0, the lowest, on −x), y out of the
 * top toward the player (+y, the lower-left face in the default view), z up.
 * The strings run straight from bridge to nut in the plane y = S, so the neck,
 * fingerboard, nut, bridge, pegbox and scroll are built in that frame. The
 * body (plates, ribs, f-holes, tailpiece, chinrest, end button) is built flat
 * and then tilted about the bridge feet by the neck angle θ, the way a real
 * neck is set into the body at an angle: the fingerboard then stands off the
 * top by the real overstand at the neck root and climbs away from the top
 * toward its free end, and the strings break down over the bridge to the
 * tailpiece.
 *
 * Dimension table (cm). Sources: violin/viola/cello standard 4/4 patterns
 * (body, bouts, ribs, stop, string length, neck, fingerboard) as given on
 * https://en.wikipedia.org/wiki/Violin#Construction_and_mechanics,
 * https://en.wikipedia.org/wiki/Cello#Construction,
 * https://www.violinist.com (Strad-model plans) and the double-bass 3/4 sizes
 * on https://en.wikipedia.org/wiki/Double_bass#Construction. Values not
 * stated there (rib height at the top, camber radii, frog heights) are
 * workshop norms, marked ~.
 *
 *                      violin  viola  cello  bass(3/4)
 *   body length         35.5   40.6   75.5   111
 *   upper / C / lower   16.8 / 11 / 20.8 · 18.8/12.8/23.6 · 35.5/22.8/44 · 52/36/66
 *   ribs                 3.1    3.8   12.0   19.5
 *   arching top/back    1.6/1.5 1.8/1.6 2.7/2.7 2.8/flat
 *   string length       32.8   37.5   69.5   105
 *   neck (nut→body)     13.0   15.0   28.5    44
 *   stop (body→bridge)  19.8   22.5   41.0    61
 *   fingerboard         27     30     58      86
 *   fb width nut / end  2.4/4.2 2.5/4.5 3.1/6.3 4.5/10.5
 *   bridge height       3.3    3.6    9.0    15.5   (~ from the arch)
 *   bridge foot width   4.1    4.5    9.3    14
 *   strings at bridge   3.4    3.7    4.7     8.2
 *   strings at nut      1.65   1.8    2.4     3.4
 *   afterlength         string / 6 (tailpiece fret to bridge)
 *   head (nut→scroll)   10.5   11.5   19.5    30
 *   overstand at root   0.6    0.65   2.0     3.0
 *   bow length          74.5   74     72      71
 *   stands at           floats, end button at 95 (a seated player's shoulder) /
 *                       92 · endpin 30 out · endpin 22 out
 *
 * Exaggerations for legibility: the string spread at the nut ×1.15 (violin,
 * viola) and ×1.1 (cello), the fingerboard widened to keep 0.3 of wood
 * outside the outer strings; tailgut and strand thickness ×1.6. Everything
 * else is true to the table. The tailpiece is as long as the afterlength and
 * the saddle leave room for (a little shorter than catalogue lengths).
 *
 * Parts, in the order a luthier assembles them (violin: ~60 solids besides the
 * 60 stop cells and 4 strings):
 *  body   back plate, back arch (2 inset terraces), ribs, top plate with
 *         purfling, top arch (2 terraces, the inner one pinched round the
 *         f-holes), f-holes with wings, eyes and notches, saddle, end button
 *         (or endpin plug, rod, thumbscrew and rubber tip)
 *  neck   neck and heel (one lofted D section), fingerboard (cambered, tapes),
 *         nut, pegbox back, two cheeks, scroll (two spiral turns and the eye),
 *         pegs (shaft, collar, thumb piece with pip, tip through the far
 *         cheek) — or, on the bass, capstans, brass plates, gears, worms, keys
 *  setup  bridge (feet, kidneys, heart, ears; bass: two height adjusters),
 *         tailpiece with its fret, fine tuners (violin four, viola and cello
 *         one), tailgut / tailwire to the button, chinrest (cup with its dish,
 *         foot, two clamp barrels: violin, viola), strings tailpiece → bridge →
 *         nut → peg
 *  bow    hair, stick (cambered), grip and winding, button, frog with its eye,
 *         ferrule, head, ivory tip plate
 */
import "./bowed.css";
import {
  box,
  cylinder,
  decal,
  lathe,
  part,
  prism,
  rod,
  rotation,
  translate,
  unionBox,
  type Decal,
  type Face,
  type Part,
  type PartOptions,
  type Vec3,
} from "../iso";
import { type Figure } from "./common";
import { type NeckSpec, bodyOutline, neckFigure, neckParts, stopZ, stringX } from "./necks";

export type BowedKind = "violin" | "viola" | "cello" | "bass";

interface Dims {
  /** Body length, lower bout width, rib height, plate edge thickness, top arch terraces, back edge and terraces, plate overhang. */
  L: number; B: number; rib: number; edge: number; a1: number; a2: number; back: number; b1: number; b2: number; over: number;
  string: number; neck: number; fb: number; fbN: number; fbE: number; fbT: number; camber: number; clr: number;
  bridgeH: number; bridgeW: number; bridgeT: number; spreadN: number; spreadB: number;
  tpW: number; tpB: number; tpT: number; tuners: number[];
  head: number; R0: number; scrollW: number; pbW: number; neckD: readonly [number, number]; overstand: number;
  /** Height of the body's lower edge: a seated player's shoulder, or the endpin's length. */
  Z0: number; endpin: number;
  bow: { len: number; hairW: number; r: readonly [number, number]; gap: readonly [number, number, number]; frog: number; at: number };
  /** Scale for small hardware (pegs, buttons, tuners) relative to the violin. */
  u: number;
  sloped: boolean; machines: boolean; chinrest: boolean;
}

const DIMS: Record<BowedKind, Dims> = {
  violin: {
    L: 35.5, B: 20.8, rib: 3.1, edge: 0.4, a1: 0.6, a2: 0.6, back: 0.4, b1: 0.55, b2: 0.55, over: 0.25,
    string: 32.8, neck: 13, fb: 27, fbN: 2.6, fbE: 4.2, fbT: 0.5, camber: 4.2, clr: 0.45,
    bridgeH: 3.3, bridgeW: 4.1, bridgeT: 0.35, spreadN: 1.65 * 1.15, spreadB: 3.4,
    tpW: 4.0, tpB: 1.8, tpT: 0.6, tuners: [0, 1, 2, 3],
    head: 10.5, R0: 2.1, scrollW: 3.4, pbW: 2.6, neckD: [1.3, 1.55], overstand: 0.6,
    Z0: 95, endpin: 0,
    bow: { len: 74.5, hairW: 0.9, r: [0.43, 0.27], gap: [1.75, 0.55, 1.25], frog: 4.6, at: 2.6 },
    u: 1, sloped: false, machines: false, chinrest: true,
  },
  viola: {
    L: 40.6, B: 23.6, rib: 3.8, edge: 0.42, a1: 0.7, a2: 0.7, back: 0.42, b1: 0.6, b2: 0.6, over: 0.27,
    string: 37.5, neck: 15, fb: 30, fbN: 2.75, fbE: 4.5, fbT: 0.52, camber: 4.5, clr: 0.5,
    bridgeH: 3.6, bridgeW: 4.5, bridgeT: 0.38, spreadN: 1.8 * 1.15, spreadB: 3.7,
    tpW: 4.3, tpB: 1.9, tpT: 0.65, tuners: [3],
    head: 11.5, R0: 2.3, scrollW: 3.7, pbW: 2.75, neckD: [1.4, 1.65], overstand: 0.65,
    Z0: 92, endpin: 0,
    bow: { len: 74, hairW: 1.0, r: [0.45, 0.28], gap: [1.8, 0.6, 1.3], frog: 4.8, at: 2.9 },
    u: 1.1, sloped: false, machines: false, chinrest: true,
  },
  cello: {
    L: 75.5, B: 44, rib: 12, edge: 0.65, a1: 1.0, a2: 1.0, back: 0.65, b1: 1.0, b2: 1.0, over: 0.4,
    string: 69.5, neck: 28.5, fb: 58, fbN: 3.3, fbE: 6.3, fbT: 0.8, camber: 7.5, clr: 0.65,
    bridgeH: 9, bridgeW: 9.3, bridgeT: 0.55, spreadN: 2.4 * 1.1, spreadB: 4.7,
    tpW: 7.2, tpB: 3.0, tpT: 1.0, tuners: [3],
    head: 19.5, R0: 3.9, scrollW: 5.0, pbW: 3.6, neckD: [2.0, 2.5], overstand: 2.0,
    Z0: 32.5, endpin: 30,
    bow: { len: 72, hairW: 1.15, r: [0.5, 0.32], gap: [2.2, 0.7, 1.55], frog: 5.2, at: 5.5 },
    u: 1.9, sloped: false, machines: false, chinrest: false,
  },
  bass: {
    L: 111, B: 66, rib: 19.5, edge: 0.8, a1: 1.0, a2: 1.0, back: 0.8, b1: 0, b2: 0, over: 0.5,
    string: 105, neck: 44, fb: 86, fbN: 4.5, fbE: 10.5, fbT: 1.2, camber: 11.5, clr: 0.85,
    bridgeH: 15.5, bridgeW: 14, bridgeT: 0.9, spreadN: 3.4, spreadB: 8.2,
    tpW: 11, tpB: 4.5, tpT: 1.5, tuners: [],
    head: 30, R0: 5.5, scrollW: 7.5, pbW: 5.6, neckD: [3.0, 3.8], overstand: 3.0,
    Z0: 26, endpin: 22,
    bow: { len: 71, hairW: 1.4, r: [0.55, 0.36], gap: [2.6, 0.8, 1.8], frog: 6.0, at: 8.5 },
    u: 2.6, sloped: true, machines: true, chinrest: false,
  },
};

/**
 * First-position fingering, the way a beginner is taught: which finger stops
 * the string k semitones up (0 = open). Violin and viola: a whole tone per
 * finger, low/high 2 and 3. Cello: a semitone per finger from a whole tone
 * up, with a backward extension. Double bass: 1-2-4. Past the hand's reach
 * the dot shows ↑ — shift up a position. Tapes go where a beginner's go.
 * `lift`: how high the body's lower edge floats (0: it stands on its endpin).
 */
export const BOWED: Record<BowedKind, { tuning: number[]; lift: number; fingers: string; tapes: number[] }> = {
  violin: { tuning: [55, 62, 69, 76], lift: DIMS.violin.Z0, fingers: "011223344", tapes: [2, 4, 5, 7] },
  viola: { tuning: [48, 55, 62, 69], lift: DIMS.viola.Z0, fingers: "011223344", tapes: [2, 4, 5, 7] },
  cello: { tuning: [36, 43, 50, 57], lift: 0, fingers: "0112344", tapes: [2, 3, 4, 5] },
  bass: { tuning: [28, 33, 38, 43], lift: 0, fingers: "011244", tapes: [2, 3, 5] },
};

// -----------------------------------------------------------------------------
// Outlines (violin template, cm; scaled per instrument)
// -----------------------------------------------------------------------------

type P2 = readonly [number, number];

/** Right half of the body outline, (half-width, height), bottom centre to top centre. Indices 12 and 22 are the corner tips. */
const VIOLIN_RIGHT: P2[] = [
  [0, 0], [2.0, 0.08], [4.2, 0.45], [6.3, 1.25], [8.0, 2.5], [9.4, 4.3], [10.2, 6.4], [10.4, 8.2], [10.2, 10.0], [9.6, 11.8], [8.9, 13.3], [8.5, 14.5], [8.35, 15.0],
  [7.5, 14.75], [6.5, 15.0], [5.8, 15.8], [5.45, 17.0], [5.4, 18.1], [5.5, 19.3], [5.95, 20.3], [6.7, 21.0], [7.55, 21.15], [7.95, 20.95],
  [7.95, 21.6], [8.2, 23.0], [8.4, 24.8], [8.4, 26.6], [8.1, 28.6], [7.4, 30.6], [6.2, 32.4], [4.6, 33.9], [2.8, 35.05], [1.3, 35.42], [0, 35.5],
];
/** The double bass keeps the violin's corners but slopes its shoulders, like a viol. */
const BASS_RIGHT: P2[] = [
  ...VIOLIN_RIGHT.slice(0, 23),
  [8.05, 21.7], [8.25, 23.0], [8.2, 24.4], [7.5, 26.2], [6.1, 28.8], [4.6, 31.4], [3.2, 33.6], [2.0, 34.95], [0.9, 35.42], [0, 35.5],
];
const CORNERS = [12, 22];

/** Arching contours as (height, half-width): the first terrace, and the crown pinched inside the f-holes. */
const ARCH1: P2[] = [[0.9, 0], [1.2, 4.4], [2.6, 7.4], [5.0, 9.0], [8.2, 9.5], [11, 9.0], [13.3, 7.7], [15.0, 5.8], [16.6, 4.7], [18.0, 4.45], [19.4, 4.65], [20.8, 5.6], [22.6, 6.8], [25, 7.4], [27, 7.45], [29.6, 7.05], [31.8, 6.0], [33.5, 4.0], [34.4, 2.0], [34.6, 0]];
const ARCH1_BASS: P2[] = [...ARCH1.slice(0, 12), [24, 7.0], [26, 6.3], [28.5, 5.0], [31, 3.6], [33.3, 2.0], [34.4, 0.8], [34.6, 0]];
const CROWN: P2[] = [[2.6, 0], [3.0, 3.0], [4.4, 5.0], [6.8, 6.1], [9.0, 5.9], [10.8, 4.8], [12.4, 3.75], [14.2, 2.85], [15.7, 2.35], [17.4, 2.0], [19.6, 1.8], [21.4, 2.25], [23.2, 3.3], [25.2, 4.1], [27.4, 4.2], [29.0, 3.5], [29.8, 1.8], [30.0, 0]];
const CROWN_BASS: P2[] = [...CROWN.slice(0, 13), [24.8, 3.6], [26.8, 3.0], [28.6, 1.8], [29.4, 0]];
const BACK_CROWN: P2[] = [[2.6, 0], [3.0, 3.0], [4.4, 5.0], [6.8, 6.1], [9.5, 6.0], [12, 4.8], [15, 3.6], [18, 3.3], [21, 3.7], [24, 4.3], [27, 4.3], [29.6, 3.4], [31.6, 1.8], [32, 0]];

/** Catmull-Rom through `pts`, broken at the `sharp` indices (corner tips). */
function smooth2(pts: readonly P2[], sharp: readonly number[] = [], per = 5): P2[] {
  const out: P2[] = [];
  const cuts = [0, ...sharp.filter((i) => i > 0 && i < pts.length - 1), pts.length - 1];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const seg = pts.slice(cuts[c], cuts[c + 1] + 1);
    for (let i = 0; i + 1 < seg.length; i++) {
      const p0 = seg[Math.max(0, i - 1)], p1 = seg[i], p2 = seg[i + 1], p3 = seg[Math.min(seg.length - 1, i + 2)];
      for (let s = 0; s < per; s++) {
        const t = s / per, t2 = t * t, t3 = t2 * t;
        const cr = (a: number, b: number, c2: number, d: number) =>
          0.5 * (2 * b + (c2 - a) * t + (2 * a - 5 * b + 4 * c2 - d) * t2 + (3 * b - a - 3 * c2 + d) * t3);
        out.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])]);
      }
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** A closed outline from its right half (bottom centre → top centre). */
const mirror = (right: readonly P2[]): P2[] => right.concat(right.slice(1, -1).reverse().map(([x, z]) => [-x, z] as P2));

/** The outline moved inward by d (a rib inside the plate's overhang, a purfling line). */
function inset(poly: readonly P2[], d: number): P2[] {
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1];
  const s = area > 0 ? 1 : -1;
  const inward = (a: P2, b: P2): P2 => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    return [(-dz / l) * s, (dx / l) * s];
  };
  return poly.map((p, i) => {
    const n1 = inward(poly[(i - 1 + n) % n], p), n2 = inward(p, poly[(i + 1) % n]);
    let mx = n1[0] + n2[0], mz = n1[1] + n2[1];
    const l = Math.hypot(mx, mz) || 1;
    mx /= l; mz /= l;
    const k = Math.max(0.5, mx * n1[0] + mz * n1[1]);
    return [p[0] + (mx * d) / k, p[1] + (mz * d) / k] as P2;
  });
}

const svgPath = (pts: readonly P2[], close = true) =>
  "M" + pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L") + (close ? "Z" : "");

// -----------------------------------------------------------------------------
// Lofts: a solid through a series of rings (a neck with its heel, a cambered
// fingerboard). `hard(i)` marks the faces between ring points i and i+1 as
// creased (outlined); the rest are one smooth surface, inked on its rims and
// silhouette only.
// -----------------------------------------------------------------------------

let loftId = 1e6;
const v3sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const v3dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const v3norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const v3mid = (pts: readonly Vec3[]): Vec3 => {
  let x = 0, y = 0, z = 0;
  for (const p of pts) { x += p[0]; y += p[1]; z += p[2]; }
  return [x / pts.length, y / pts.length, z / pts.length];
};

function loft(rings: Vec3[][], hard: (i: number) => boolean = () => false): Face[] {
  const n = rings[0].length;
  const faces: Face[] = [];
  const cen = rings.map(v3mid);
  for (let k = 0; k + 1 < rings.length; k++) {
    const id = ++loftId;
    const rims = (k === 0 ? 1 : 0) | (k + 2 === rings.length ? 2 : 0);
    const axis = v3mid([cen[k], cen[k + 1]]);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const quad = [rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]];
      let nrm = v3cross(v3sub(quad[1], quad[0]), v3sub(quad[3], quad[0]));
      if (Math.hypot(...nrm) < 1e-9) nrm = v3cross(v3sub(quad[2], quad[3]), v3sub(quad[0], quad[3]));
      nrm = v3norm(nrm);
      if (v3dot(nrm, v3sub(v3mid(quad), axis)) < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
      faces.push(hard(i) ? { n: nrm, pts: quad } : { n: nrm, pts: quad, strip: [id, i, n, rims] });
    }
  }
  const first = rings[0], last = rings[rings.length - 1];
  faces.push({ n: v3norm(v3sub(cen[0], cen[1])), pts: [...first] });
  faces.push({ n: v3norm(v3sub(cen[cen.length - 1], cen[cen.length - 2])), pts: [...last] });
  return faces;
}

/** A decal whose origin sits at (px, py) of its picture, so the part's box stays where the picture is. */
const decalAt = (o: Vec3, u: Vec3, v: Vec3, px: number, py: number, svg: string): Decal =>
  decal([o[0] + u[0] * px + v[0] * py, o[1] + u[1] * px + v[1] * py, o[2] + u[2] * px + v[2] * py], u, v,
    `<g transform="translate(${(-px).toFixed(2)} ${(-py).toFixed(2)})">${svg}</g>`);

// -----------------------------------------------------------------------------
// The builder
// -----------------------------------------------------------------------------

/** Violin-family instrument, upright: on its endpin, or (violin, viola) floating at the shoulder. */
export function bowed(kind: BowedKind): Figure {
  const spec = BOWED[kind];
  const D = DIMS[kind];
  const u = D.u;
  const sx = D.B / 20.8, sz = D.L / 35.5;
  const Z0 = D.Z0;
  const stop = D.string - D.neck;
  const bridgeZ = Z0 + D.L - stop;
  const nutZ = bridgeZ + D.string;
  const bodyTop = Z0 + D.L;
  const shadow = "bowed";

  // ---- Heights through the body (y), before the neck angle.
  const rib = D.rib;
  const topFace = rib + D.edge;
  const arch1Top = topFace + D.a1;
  const archTop = arch1Top + D.a2;
  const S = archTop + D.bridgeH; // the string plane
  const yRibMid = rib / 2;

  // ---- The fingerboard: tilting away from the strings toward its free end (the relief a player feels).
  const fbEnd = nutZ - D.fb;
  const fbHalf = (z: number) => (D.fbN + (D.fbE - D.fbN) * (nutZ - z) / D.fb) / 2;
  const fbSlope = (D.clr - 0.1) / D.fb;
  const fbTop = (z: number) => S - 0.1 - fbSlope * (nutZ - z);
  const drop = (w: number) => D.camber - Math.sqrt(D.camber * D.camber - w * w);
  const fbBottom = (z: number) => fbTop(z) - drop(fbHalf(z)) - D.fbT;

  // ---- The neck angle: the body tilts about the bridge feet until the top's edge at the neck root sits the overstand below the fingerboard.
  const target = fbBottom(bodyTop) - D.overstand - archTop;
  let theta = 0;
  for (let i = 0; i < 3; i++) theta = Math.asin(Math.max(0, Math.min(Math.sin(Math.PI / 18), (target + (D.a1 + D.a2) * Math.cos(theta)) / stop)));
  const R = rotation("x", (-theta * 180) / Math.PI, [0, archTop, bridgeZ]);
  const tilt = (faces: Face[]): Face[] => faces.map((f) => ({ ...f, pts: f.pts.map(R.point), n: R.dir(f.n) }));
  const tiltDecal = (d: Decal): Decal => decal(R.point(d.o), R.dir(d.u), R.dir(d.v), d.svg, d.rect);
  const bodyPart = (mat: string, faces: Face[], opts: PartOptions = {}) =>
    part(mat, tilt(faces), {
      ...opts,
      ...(opts.decals ? { decals: opts.decals.map(tiltDecal) } : {}),
      ...(opts.strokes ? { strokes: opts.strokes.map((s) => ({ cls: s.cls, pts: s.pts.map(R.point) })) } : {}),
    });

  const parts: Part[] = [];

  // ---------------------------------------------------------------------------
  // Body: back, ribs, top — each plate in terraces so the arching reads.
  // ---------------------------------------------------------------------------
  const right = smooth2((D.sloped ? BASS_RIGHT : VIOLIN_RIGHT).map(([x, z]) => [x * sx, Z0 + z * sz] as P2), CORNERS);
  const outline = mirror(right);
  const ribs = inset(outline, D.over);
  const contour = (table: readonly P2[]) => bodyOutline(table.map(([z, w]) => [z * sz, w * sx] as const), Z0);
  const arch1 = contour(D.sloped ? ARCH1_BASS : ARCH1);
  const crown = contour(D.sloped ? CROWN_BASS : CROWN);
  const plateLine = (y: number, normal: 1 | -1) => {
    const a = inset(outline, 0.35 * u), b = inset(outline, 0.5 * u);
    const svg = `<path class="purfling" d="${svgPath(a.map(([x, z]) => [x, -normal * z] as P2))}"/><path class="purfling" d="${svgPath(b.map(([x, z]) => [x, -normal * z] as P2))}"/>`;
    return decalAt([0, y, 0], [1, 0, 0], [0, 0, -normal], 0, -normal * (Z0 + D.L / 2), svg);
  };

  if (D.b1 > 0) {
    parts.push(bodyPart("wood", prism(contour(BACK_CROWN), "y", -D.back - D.b1 - D.b2, -D.back - D.b1, true), { pri: 0, sortFaces: true, shadow }));
    parts.push(bodyPart("wood", prism(arch1, "y", -D.back - D.b1, -D.back, true), { pri: 0.1, sortFaces: true, shadow }));
  }
  parts.push(bodyPart("wood", prism(outline, "y", -D.back, 0, true), { pri: 0.2, sortFaces: true, shadow, decals: [plateLine(-D.back, -1)] }));
  parts.push(bodyPart("wood", prism(ribs, "y", 0, rib, true), { pri: 0.3, sortFaces: true, shadow }));
  parts.push(bodyPart("spruce", prism(outline, "y", rib, topFace, true), { pri: 0.4, sortFaces: true, shadow, decals: [plateLine(topFace, 1)] }));

  // The f-holes (template: right side, relative to the bridge line): stem, eyes, wings, and the notches the bridge feet line up with.
  const zb = (bridgeZ - Z0) / sz; // the template's bridge line for this body
  const fhole = (side: 1 | -1) => {
    const P = ([x, z]: P2): P2 => [side * x * sx, -(Z0 + (zb + z) * sz)];
    const stem = smooth2([[2.6, 3.65], [3.0, 2.6], [3.28, 1.2], [3.35, 0], [3.5, -1.4], [3.85, -2.5], [4.3, -3.2]], [], 4);
    const w = (i: number) => 0.06 + 0.1 * Math.sin((Math.PI * i) / (stem.length - 1));
    const edge = (sgn: number) => stem.map((p, i) => {
      const a = stem[Math.max(0, i - 1)], b = stem[Math.min(stem.length - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      return [p[0] - (dz / l) * w(i) * sgn, p[1] + (dx / l) * w(i) * sgn] as P2;
    });
    const body = edge(1).concat(edge(-1).reverse());
    const eye = (c: P2, r: number) => {
      const [cx, cy] = P(c);
      return `<ellipse class="fdot" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" rx="${(r * sx).toFixed(2)}" ry="${(r * sz).toFixed(2)}"/>`;
    };
    const wing = (pts: P2[]) => `<path class="fdot" d="${svgPath(pts.map(P))}"/>`;
    const notch = (dx: number) => {
      const [x1, y1] = P([3.35 + dx * 0.12, 0]), [x2, y2] = P([3.35 + dx * 0.42, 0]);
      return `<line class="fhole" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
    };
    return `<path class="fdot" d="${svgPath(body.map(P))}"/>` + eye([2.45, 3.9], 0.33) + eye([4.55, -3.5], 0.4) +
      wing([[2.66, 3.3], [3.3, 3.95], [2.98, 2.95]]) + wing([[4.12, -2.85], [3.55, -3.95], [4.38, -3.25]]) + notch(1) + notch(-1);
  };
  parts.push(bodyPart("spruce", prism(arch1, "y", topFace, arch1Top, true), { pri: 0.5, sortFaces: true, shadow,
    decals: [decalAt([0, arch1Top, 0], [1, 0, 0], [0, 0, -1], 0, -bridgeZ, fhole(1) + fhole(-1))] }));
  parts.push(bodyPart("spruce", prism(crown, "y", arch1Top, archTop, true), { pri: 0.6, sortFaces: true, shadow }));

  // The saddle at the lower edge, over which the tailgut passes.
  const saddleW = 1.6 * D.tpB, saddleL = 0.7 * u;
  const saddleTop = topFace + 0.25 * u;
  parts.push(bodyPart("ebony", box(-saddleW / 2, rib, Z0 - 0.02, saddleW / 2, saddleTop, Z0 + saddleL), { pri: 0.55, shadow: false }));

  // End button (violin, viola) or the endpin's plug (cello, bass), turned, on the bottom rib.
  const endZ = Z0 + D.over;
  const plugDepth = D.endpin ? 2.6 * (u / 1.9) : 1.0;
  if (D.endpin) {
    const r = 0.75 * u;
    parts.push(bodyPart("ebony", lathe("z", [0, yRibMid], [[r, endZ], [r, endZ - 0.25 * u], [r * 0.82, endZ - 0.32 * u], [r * 0.7, endZ - plugDepth + 0.2], [r * 0.55, endZ - plugDepth]], 16, [1, 2]), { pri: 0.35, shadow: false }));
    // The thumbscrew that locks the pin.
    parts.push(bodyPart("metal", lathe("x", [yRibMid, endZ - plugDepth * 0.55], [[0.18 * u, r * 0.7], [0.18 * u, r * 0.7 + 0.35 * u], [0.32 * u, r * 0.7 + 0.35 * u], [0.32 * u, r * 0.7 + 0.6 * u]], 10, [1]), { pri: 0.36, shadow: false }));
  } else {
    parts.push(bodyPart("ebony", lathe("z", [0, yRibMid], [[0.55, endZ], [0.55, endZ - 0.15], [0.32, endZ - 0.22], [0.32, endZ - 0.45], [0.5, endZ - 0.55], [0.5, endZ - 0.8], [0.22, endZ - 0.95], [0, endZ - 1.0]], 14, [1, 2, 4]), { pri: 0.35, shadow: false }));
  }
  const pinTop = R.point([0, yRibMid, endZ - plugDepth]);
  if (D.endpin) {
    const pr = 0.26 * u;
    parts.push(part("metal", rod(pinTop, [pinTop[0], pinTop[1], 2.6 * (u / 1.9)], pr, pr * 0.9), { pri: 0.3, shadow: false }));
    const tipR = 0.55 * u;
    parts.push(part("felt", lathe("z", [pinTop[0], pinTop[1]], [[tipR * 0.7, 0], [tipR, 0.3 * u], [tipR, 2.2 * (u / 1.9)], [pr, 2.6 * (u / 1.9)]], 14, [1]), { pri: 0.31, shadow: false }));
  }

  // ---------------------------------------------------------------------------
  // Tailpiece, its fret, fine tuners, and the tailgut over the saddle to the button.
  // ---------------------------------------------------------------------------
  const after = D.string / 6;
  const tpBot = Z0 + saddleL + 0.45 * u;
  const tpTopZ = bridgeZ - after;
  const tpLen = tpTopZ - tpBot;
  const tpY0 = archTop + 0.15 * D.bridgeH;
  const tpY1 = tpY0 + D.tpT;
  const tw = D.tpW / 2, bw = D.tpB / 2;
  const tpRight: P2[] = [[0, 0], [bw * 0.85, 0.02 * tpLen], [bw, 0.07 * tpLen], [bw + (tw - bw) * 0.35, 0.45 * tpLen], [bw + (tw - bw) * 0.78, 0.8 * tpLen], [tw, 0.93 * tpLen], [tw * 0.86, 0.985 * tpLen], [tw * 0.45, tpLen + 0.08 * u], [0, tpLen + 0.1 * u]];
  const tpOutline = mirror(smooth2(tpRight.map(([x, z]) => [x, tpBot + z] as P2)));
  parts.push(bodyPart("ebony", prism(tpOutline, "y", tpY0, tpY1, true), { pri: 0.9, sortFaces: true, shadow: false }));
  const fretZ0 = tpTopZ - 0.75 * u, fretZ1 = tpTopZ - 0.15 * u, fretY = tpY1 + 0.3 * u;
  parts.push(bodyPart("ebony", box(-tw * 0.84, tpY1, fretZ0, tw * 0.84, fretY, fretZ1), { pri: 1.0, shadow: false }));
  const tailX = (i: number) => stringX({ ...neckStub(), bridgeZ, nutZ }, i, bridgeZ) * 0.84;
  for (const i of D.tuners) {
    const x = tailX(i), zs = fretZ0 - 1.15 * u;
    const lever = box(x - 0.28 * u, tpY1, fretZ0 - 2.1 * u, x + 0.28 * u, tpY1 + 0.32 * u, fretZ0 - 0.05);
    const screw = lathe("y", [x, zs], [[0.16 * u, tpY1 + 0.32 * u], [0.16 * u, tpY1 + 0.95 * u], [0.42 * u, tpY1 + 0.95 * u], [0.42 * u, tpY1 + 1.3 * u], [0.3 * u, tpY1 + 1.38 * u]], 12, [1, 2, 3]);
    parts.push(bodyPart("metal", [...lever, ...screw], { pri: 1.1, sortFaces: true, shadow: false }));
  }
  // Tailgut (violin, viola) or tailwire (cello, bass): two strands over the saddle, round the button's shank.
  const gutR = 0.1 * Math.max(1, u * 0.7);
  const gut: Face[] = [];
  for (const sd of [-1, 1]) {
    const a: Vec3 = [sd * 0.35 * u, (tpY0 + tpY1) / 2, tpBot + 0.1], b: Vec3 = [sd * 0.35 * u, saddleTop + gutR, Z0 + saddleL * 0.5];
    const c: Vec3 = D.endpin ? [sd * 0.3 * u, yRibMid + 0.75 * u, endZ - 0.15 * u] : [sd * 0.22, yRibMid + 0.32, endZ - 0.33];
    gut.push(...rod(a, b, gutR), ...rod(b, c, gutR));
  }
  parts.push(bodyPart("metal", gut, { pri: 0.8, sortFaces: true, shadow: false }));

  // ---------------------------------------------------------------------------
  // Chinrest (violin, viola): a cup on the bass side of the tailpiece, its foot on the edge, two barrels clamping the ribs.
  // ---------------------------------------------------------------------------
  if (D.chinrest) {
    const cx = -5.2 * sx, cz = Z0 + 2.9 * sz, rx = 3.0 * sx, rz = 2.3 * sz;
    const cup: P2[] = Array.from({ length: 28 }, (_, i) => {
      const a = (i / 28) * Math.PI * 2;
      const dent = 0.22 * Math.max(0, Math.cos(a)) ** 3; // the side toward the tailpiece is hollowed
      return [cx + rx * Math.cos(a) * (1 - dent), cz + rz * Math.sin(a)] as P2;
    });
    const dish = cup.map(([x, z]) => [cx + (x - cx) * 0.62, -(cz + (z - cz) * 0.6)] as P2);
    const cupY0 = archTop + 0.3 * u, cupY1 = cupY0 + 0.6 * u;
    parts.push(bodyPart("ebony", prism(cup, "y", cupY0, cupY1, true), { pri: 0.75, sortFaces: true, shadow: false,
      decals: [decalAt([0, cupY1, 0], [1, 0, 0], [0, 0, -1], cx, -cz, `<path class="ring" d="${svgPath(dish)}"/>`)] }));
    const foot = smooth2([[-3.7 * sx, Z0 - 0.1], [-3.7 * sx, Z0 + 1.0 * sz], [-2.6 * sx, Z0 + 1.25 * sz], [-1.5 * sx, Z0 + 1.0 * sz], [-1.5 * sx, Z0 - 0.1]], [], 3);
    parts.push(bodyPart("ebony", prism(foot, "y", topFace, cupY0, true), { pri: 0.7, sortFaces: true, shadow: false }));
    for (const x of [-3.2 * sx, -1.0 * sx]) {
      parts.push(bodyPart("metal", cylinder("y", [x, Z0 - 0.3], 0.24, 0.24, -D.back, topFace, 10), { pri: 0.36, shadow: false }));
    }
  }

  // ---------------------------------------------------------------------------
  // Neck: one lofted D section from the heel (on the body's top end, down to the back's button) to the nut.
  // ---------------------------------------------------------------------------
  const nutL = 0.6 * u;
  const D_RING = 24;
  const dRing = (z: number, a: number, depth: number, yFront: number, zAt: (y: number) => number = () => z): Vec3[] =>
    Array.from({ length: D_RING + 1 }, (_, j) => {
      const phi = (Math.PI * j) / D_RING;
      const y = yFront - depth * Math.sin(phi);
      return [a * Math.cos(phi), y, zAt(y)] as Vec3;
    });
  const pTop = R.point([0, topFace, bodyTop]), pBack = R.point([0, -D.back, bodyTop]);
  const topAt = (y: number) => pTop[2] + ((y - pTop[1]) * (pBack[2] - pTop[2])) / (pBack[1] - pTop[1]);
  const heelZ = Math.max(pTop[2], pBack[2]);
  const yF0 = fbBottom(heelZ);
  const heelDepth = yF0 - pBack[1];
  const aHeel = fbHalf(bodyTop) * 0.92, aNut = D.fbN / 2;
  const heelH = (heelDepth - D.neckD[1]) * 0.4;
  const neckRings: Vec3[][] = [dRing(heelZ, aHeel, heelDepth, yF0, topAt)];
  for (let k = 1; k <= 14; k++) {
    const t = k / 14, z = heelZ + 0.15 + heelH * t;
    neckRings.push(dRing(z, aHeel, D.neckD[1] + (heelDepth - D.neckD[1]) * Math.sqrt(1 - t * t), fbBottom(z)));
  }
  const neckTopZ = nutZ + nutL;
  neckRings.push(dRing(neckTopZ, aNut, D.neckD[0], fbBottom(nutZ)));
  parts.push(part("wood", loft(neckRings), { pri: 2, shadow }));

  // Fingerboard: cambered on top, flat beneath, the tapes where a beginner's go.
  const fbRing = (z: number): Vec3[] => {
    const h = fbHalf(z), top = fbTop(z), m = 8;
    const phi = Math.asin(h / D.camber);
    const arc = Array.from({ length: m + 1 }, (_, j) => {
      const p = phi - (2 * phi * j) / m;
      return [D.camber * Math.sin(p), top - D.camber + D.camber * Math.cos(p), z] as Vec3;
    });
    return [[h, fbBottom(z), z], ...arc, [-h, fbBottom(z), z]];
  };
  const tapes = spec.tapes.map((stopN) => {
    // A tape marks where the finger stops the string: the pitch's exact place (no fret to sit behind).
    const z = stopZ(neckStub(), stopN);
    const h = fbHalf(z);
    return `<line class="tape" x1="${(-h).toFixed(2)}" y1="${(-z).toFixed(2)}" x2="${h.toFixed(2)}" y2="${(-z).toFixed(2)}"/>`;
  }).join("");
  const fbA = S - 0.1 - fbSlope * nutZ;
  parts.push(part("ebony", loft([fbRing(fbEnd), fbRing(nutZ)], (i) => i === 0 || i >= 9), { pri: 3, shadow: false,
    decals: [decalAt([0, fbA, 0], [1, 0, 0], [0, -fbSlope, -1], 0, -(nutZ - 6 * u), tapes)] }));
  // The nut: the strings leave the fingerboard over it into the pegbox.
  parts.push(part("ebony", box(-aNut, fbBottom(nutZ), nutZ, aNut, S, nutZ + nutL), { pri: 3.5, shadow: false }));

  // ---------------------------------------------------------------------------
  // Pegbox and scroll.
  // ---------------------------------------------------------------------------
  const hw = D.pbW / 2, cheekT = 0.42 * u, wallT = 0.45 * u;
  const pbF = S - 0.3 * u;
  const zc = nutZ + D.head - D.R0;
  const yc = pbF + 0.5 * u - D.R0;
  const k = Math.log(3) / (4 * Math.PI);
  const rAt = (t: number) => D.R0 * Math.exp(-k * t);
  const spiral = (t: number, r: number): P2 => [yc + r * Math.cos(Math.PI - t), zc + r * Math.sin(Math.PI - t)];
  const yB0 = fbBottom(nutZ) - D.neckD[0];
  const yBs = yc - D.R0;
  const yBack = (z: number) => yB0 + ((z - neckTopZ) * (yBs - yB0)) / (zc - neckTopZ);
  const chinZ = zc - rAt(1.5 * Math.PI);
  parts.push(part("wood", prism([[yB0, neckTopZ], [yB0 + wallT, neckTopZ], [yBs + wallT, zc], [yBs, zc]], "x", -hw, hw), { pri: 2.1, shadow }));
  const cheek: P2[] = [[yB0 + wallT, neckTopZ], [pbF, neckTopZ], [pbF, chinZ], [yc, chinZ], [yBs + wallT, zc]];
  for (const sd of [-1, 1]) {
    parts.push(part("wood", prism(cheek, "x", sd * (hw - cheekT), sd * hw), { pri: 2.2, shadow }));
  }
  // The scroll: the volute's profile (a logarithmic spiral, one turn out to the throat at the back) cut as one
  // block, its turns and eye drawn on both cheeks the way the gouge leaves them, the chamfer inside the edge.
  const W0 = D.scrollW;
  const prof = Array.from({ length: 49 }, (_, i) => spiral((2 * Math.PI * i) / 48, rAt((2 * Math.PI * i) / 48)));
  const scrollFaces: Face[] = prism(prof, "x", -W0 / 2, W0 / 2, true);
  const groove = Array.from({ length: 49 }, (_, i) => spiral(2 * Math.PI + (2 * Math.PI * i) / 48, rAt(2 * Math.PI + (2 * Math.PI * i) / 48)));
  const chamfer = inset(prof, 0.14 * u).slice(2, -2);
  const eyeR = rAt(4 * Math.PI);
  const cheekArt = (sd: 1 | -1) => {
    const pic = (pts: readonly P2[]) => pts.map(([y, z]) => [sd * (y - yc), -(z - zc)] as P2);
    return `<path class="purfling" d="${svgPath(pic(chamfer), false)}"/><path class="ring" d="${svgPath(pic(groove), false)}"/>` +
      `<circle class="ring" r="${eyeR.toFixed(2)}"/><circle class="purfling" r="${(eyeR * 0.45).toFixed(2)}"/>`;
  };
  const scrollDecals = [1, -1].map((sd) => decal([(sd * W0) / 2, yc, zc], [0, -sd, 0], [0, 0, -1], cheekArt(sd as 1 | -1)));
  // The fluting either side of the spine, over the crown of the outer turn from the throat to the chin.
  const flutes = [-1, 1].map((sd) => ({ cls: "purfling", pts: Array.from({ length: 25 }, (_, i) => {
    const t = Math.PI / 4 + (Math.PI * i) / 24, [y, z] = spiral(t, rAt(t) + 0.02);
    return [sd * W0 * 0.27, y, z] as Vec3;
  }) }));
  parts.push(part("wood", scrollFaces, { pri: 2.5, sortFaces: true, shadow, decals: scrollDecals, strokes: flutes }));

  // Pegs (or machines): A, D, E, G from the nut up, alternating sides; each string's peg has its head on that string's side.
  const order = [2, 1, 3, 0];
  const pegZ = (i: number) => neckTopZ + (chinZ - 0.4 * u - neckTopZ) * (0.14 + 0.24 * order.indexOf(i));
  const pegY = (z: number) => (yBack(z) + wallT + pbF) / 2;
  const sideOf = (i: number) => (i < 2 ? -1 : 1);
  const inW = hw - cheekT;
  const shaftR = (D.machines ? 0.5 : 0.28) * u * (D.machines ? 0.5 : 1);
  for (let i = 0; i < 4; i++) {
    const z = pegZ(i), y = pegY(z), s = sideOf(i);
    parts.push(part(D.machines ? "metal" : "ebony", cylinder("x", [y, z], shaftR, shaftR, -inW, inW, 10), { pri: 2.3, shadow: false }));
    if (D.machines) {
      // A capstan through the pegbox, driven by a gear on a brass plate, turned by a worm and its key.
      const gx = s * (hw + 0.25 * u);
      parts.push(part("brass", cylinder("x", [y, z], 0.9 * u, 0.9 * u, s * hw, s * (hw + 0.25 * u), 16), { pri: 2.35, shadow: false,
        decals: [decal([s * (hw + 0.25 * u), y, z], [0, -s, 0], [0, 0, -1], `<circle class="ring" r="${(0.55 * u).toFixed(2)}"/>`)] }));
      const wormY = y - 0.95 * u;
      parts.push(part("metal", rod([gx + s * 0.12 * u, wormY, z], [gx + s * 0.12 * u, yBack(z) - 2.4 * u, z], 0.16 * u), { pri: 2.36, shadow: false }));
      const ky = yBack(z) - 2.4 * u;
      const key = smooth2([[ky, z - 0.25 * u], [ky - 0.6 * u, z - 0.75 * u], [ky - 1.6 * u, z - 0.6 * u], [ky - 1.9 * u, z], [ky - 1.6 * u, z + 0.6 * u], [ky - 0.6 * u, z + 0.75 * u], [ky, z + 0.25 * u]], [], 3);
      parts.push(part("metal", prism(key, "x", gx + s * 0.02 * u, gx + s * 0.24 * u, true), { pri: 2.37, sortFaces: true, shadow: false }));
    } else {
      // The tip through the far cheek; the collar, neck and thumb piece outside the near one.
      parts.push(part("ebony", lathe("x", [y, z], [[0.26 * u, -s * hw], [0.24 * u, -s * (hw + 0.3 * u)], [0.15 * u, -s * (hw + 0.36 * u)]], 10), { pri: 2.3, shadow: false }));
      parts.push(part("ebony", lathe("x", [y, z], [[0.32 * u, s * hw], [0.32 * u, s * (hw + 0.22 * u)], [0.48 * u, s * (hw + 0.25 * u)], [0.48 * u, s * (hw + 0.42 * u)], [0.33 * u, s * (hw + 0.5 * u)], [0.36 * u, s * (hw + 0.75 * u)]], 12, [1, 2, 3, 4]), { pri: 2.3, shadow: false }));
      const x0 = s * (hw + 0.75 * u), x1 = s * (hw + 2.75 * u);
      const at = (f: number) => x0 + (x1 - x0) * f;
      // The thumb piece's broad faces toward the player and away, as a peg is turned.
      const thumb = smooth2([[at(0), z - 0.3 * u], [at(0.3), z - 0.6 * u], [at(0.66), z - 0.72 * u], [at(0.92), z - 0.5 * u], [at(1), z], [at(0.92), z + 0.5 * u], [at(0.66), z + 0.72 * u], [at(0.3), z + 0.6 * u], [at(0), z + 0.3 * u]], [], 3);
      parts.push(part("ebony", prism(thumb, "y", y - 0.22 * u, y + 0.22 * u, true), { pri: 2.3, sortFaces: true, shadow: false,
        decals: [decal([at(0.66), y + 0.22 * u, z], [1, 0, 0], [0, 0, -1], `<circle class="inlay" r="${(0.16 * u).toFixed(2)}"/>`)] }));
    }
  }
  if (D.machines) {
    for (const s of [-1, 1]) {
      const zs = [0, 1, 2, 3].filter((i) => sideOf(i) === s).map(pegZ);
      const y = pegY((zs[0] + zs[1]) / 2);
      parts.push(part("brass", box(s > 0 ? hw : -hw - 0.12 * u, y - 1.2 * u, Math.min(...zs) - 1.2 * u, s > 0 ? hw + 0.12 * u : -hw, y + 1.0 * u, Math.max(...zs) + 1.2 * u), { pri: 2.32, shadow: false }));
    }
  }

  // ---------------------------------------------------------------------------
  // The bridge: standing on the crown between the f-hole notches, its top at the strings.
  // ---------------------------------------------------------------------------
  const bsx = D.bridgeW / 4.1, bsy = D.bridgeH / 3.3;
  const bridgeRight: P2[] = [[0, 0.9], [0.6, 0.78], [1.0, 0.45], [1.15, 0.12], [1.15, 0], [2.05, 0], [2.05, 0.22], [1.86, 0.6], [1.78, 1.05], [1.62, 1.35], [1.42, 1.62], [1.5, 1.88], [1.78, 2.05], [2.0, 2.22], [2.08, 2.5], [2.1, 2.85], [1.85, 3.12], [1.2, 3.26], [0.6, 3.3], [0, 3.3]];
  const bridgeOutline = mirror(bridgeRight.map(([x, y]) => [x * bsx, archTop + y * bsy] as P2));
  const holes = [
    `<path class="fdot" d="M0 ${(archTop + 2.05 * bsy).toFixed(2)}C${(-0.4 * bsx).toFixed(2)} ${(archTop + 2.25 * bsy).toFixed(2)} ${(-0.3 * bsx).toFixed(2)} ${(archTop + 2.62 * bsy).toFixed(2)} 0 ${(archTop + 2.48 * bsy).toFixed(2)}C${(0.3 * bsx).toFixed(2)} ${(archTop + 2.62 * bsy).toFixed(2)} ${(0.4 * bsx).toFixed(2)} ${(archTop + 2.25 * bsy).toFixed(2)} 0 ${(archTop + 2.05 * bsy).toFixed(2)}Z"/>`,
    ...[-1, 1].map((sd) => `<ellipse class="fdot" cx="${(sd * 0.92 * bsx).toFixed(2)}" cy="${(archTop + 1.28 * bsy).toFixed(2)}" rx="${(0.3 * bsx).toFixed(2)}" ry="${(0.16 * bsy).toFixed(2)}"/>`),
  ].join("");
  const bz0 = bridgeZ - D.bridgeT / 2, bz1 = bridgeZ + D.bridgeT / 2;
  parts.push(part("maple", prism(bridgeOutline, "z", bz0, bz1, false), { pri: 4, sortFaces: true, shadow: false,
    decals: [decalAt([0, 0, bz1], [1, 0, 0], [0, 1, 0], 0, archTop + 1.8 * bsy, holes)] }));
  if (D.machines) {
    // The bass bridge's height adjusters: a thumbwheel on each leg.
    for (const sd of [-1, 1]) {
      const x = sd * 1.6 * bsx, y0 = archTop + 0.95 * bsy, y1 = y0 + 0.35 * u;
      parts.push(part("metal", lathe("y", [x, bridgeZ], [[0.3 * u, y0 - 0.2 * u], [0.3 * u, y0], [1.0 * u, y0 + 0.03], [1.0 * u, y1 - 0.03], [0.3 * u, y1], [0.3 * u, y1 + 0.2 * u]], 16, [1, 2, 3, 4]), { pri: 4.1, shadow: false }));
    }
  }

  // ---------------------------------------------------------------------------
  // The strings and their stops.
  // ---------------------------------------------------------------------------
  function neckStub(): NeckSpec {
    return { tuning: spec.tuning, frets: 14, nutZ, bridgeZ, nutHalf: D.spreadN / 2, bridgeHalf: D.spreadB / 2, y: S - 0.4, fretted: false, tail: () => [0, 0, 0], head: () => [0, 0, 0] };
  }
  const neck: NeckSpec = {
    ...neckStub(),
    finger: (stopN) => spec.fingers[stopN] ?? "↑",
    tail: (i) => R.point([tailX(i), fretY, (fretZ0 + fretZ1) / 2]),
    head: (i) => {
      const z = pegZ(i), s = sideOf(i);
      return [s * inW * 0.45, pegY(z) + shaftR, z];
    },
  };
  parts.push(...neckParts(neck));

  // ---------------------------------------------------------------------------
  // The bow, resting across the strings between the bridge and the fingerboard,
  // frog toward the player's right hand. It moves (CSS) while a note sounds.
  // ---------------------------------------------------------------------------
  const W = D.bow;
  const bu = W.hairW / 0.9;
  const hairLen = W.len - 8.5 * bu;
  const contact = bridgeZ + W.at;
  const hairY = S + 0.3;
  const xF = -hairLen / 2, xT = hairLen / 2;
  const windL = 9 * bu;
  const xW = xF + windL;
  const gapAt = (x: number) => {
    if (x <= xW) return W.gap[0];
    const t = (x - xW) / (xT - xW);
    if (t < 0.45) { const s = t / 0.45; return W.gap[1] + (W.gap[0] - W.gap[1]) * (1 - 3 * s * s + 2 * s * s * s); }
    const s = Math.min(1, (t - 0.45) / 0.55);
    return W.gap[1] + (W.gap[2] - W.gap[1]) * (3 * s * s - 2 * s * s * s);
  };
  const radAt = (x: number) => (x <= xW ? W.r[0] : W.r[0] + ((W.r[1] - W.r[0]) * (x - xW)) / (xT - xW));
  const stickPt = (x: number): Vec3 => [x, hairY + gapAt(x), contact];
  const bowOpts = (pri: number, extra: Partial<PartOptions> = {}): PartOptions => ({ key: "bow", cls: "bow", pri, shadow: false, ...extra });
  parts.push(part("hair", box(xF, hairY, contact - W.hairW / 2, xT - 0.35 * bu, hairY + 0.06, contact + W.hairW / 2), bowOpts(7)));
  // The stick: one smooth surface lofted along its camber, round in section.
  const stickRings = Array.from({ length: 25 }, (_, i) => {
    const x = xW + ((xT - 0.6 * bu - xW) * i) / 24, c = stickPt(x), r = radAt(x);
    return Array.from({ length: 10 }, (_, j) => [x, c[1] + r * Math.cos((j * Math.PI) / 5), c[2] + r * Math.sin((j * Math.PI) / 5)] as Vec3);
  });
  const stick: Face[] = loft(stickRings);
  const yS = hairY + W.gap[0], rF = W.r[0];
  const xFrogBack = xF - W.frog;
  // Plain stick over the frog, then the leather grip and the silver winding, then the button.
  stick.push(...lathe("x", [yS, contact], [[rF, xFrogBack - 0.3 * bu], [rF, xF], [rF + 0.07, xF + 0.02], [rF + 0.07, xF + 2.4 * bu], [rF + 0.04, xF + 2.45 * bu], [rF + 0.04, xW - 0.05], [rF, xW]], 10, [1, 2, 3, 4, 5]));
  stick.push(...lathe("x", [yS, contact], [[rF * 0.95, xFrogBack - 0.3 * bu], [rF * 1.05, xFrogBack - 0.4 * bu], [rF * 1.05, xFrogBack - 0.75 * bu], [rF * 0.8, xFrogBack - 0.8 * bu], [rF * 0.8, xFrogBack - 1.6 * bu], [rF * 1.05, xFrogBack - 1.65 * bu], [rF * 1.05, xFrogBack - 1.9 * bu], [rF * 0.5, xFrogBack - 2.0 * bu]], 10, [1, 2, 3, 4, 5, 6]));
  parts.push(part("wood", stick, bowOpts(7.5, { sortFaces: true })));
  // The frog: ebony, its pearl eye, the ferrule where the hair fans out.
  const frogTop = yS - rF;
  const frog = smooth2([[xF, hairY - 0.05], [xF, frogTop], [xFrogBack, frogTop], [xFrogBack, frogTop - 0.45 * bu], [xFrogBack + 0.6 * bu, hairY + 0.35 * bu], [xFrogBack + 1.6 * bu, hairY - 0.25 * bu], [xF - 0.9 * bu, hairY - 0.3 * bu], [xF - 0.25 * bu, hairY - 0.2 * bu]], [0, 1, 2], 3);
  const fw = W.hairW / 2 + 0.14 * bu;
  parts.push(part("ebony", prism(frog, "z", contact - fw, contact + fw, true), bowOpts(7.2, { sortFaces: true,
    decals: [decal([xF - 2.3 * bu, (hairY + frogTop) / 2, contact + fw], [1, 0, 0], [0, 1, 0], `<circle class="inlay" r="${(0.3 * bu).toFixed(2)}"/>`)] })));
  parts.push(part("metal", box(xF - 0.6 * bu, hairY - 0.3 * bu, contact - fw - 0.04, xF + 0.03, hairY + 0.22 * bu, contact + fw + 0.04), bowOpts(7.3)));
  // The head (the tip) and its ivory plate.
  const yHs = hairY + W.gap[2], rT = W.r[1];
  const head = smooth2([[xT - 1.0 * bu, yHs + rT], [xT + 0.55 * bu, yHs + rT * 1.25], [xT + 1.1 * bu, yHs - 0.2 * bu], [xT + 1.2 * bu, hairY - 0.05], [xT - 0.35 * bu, hairY - 0.05], [xT - 0.6 * bu, hairY + 0.4 * bu], [xT - 1.0 * bu, yHs - rT]], [3, 4], 3);
  parts.push(part("wood", prism(head, "z", contact - rT * 1.15, contact + rT * 1.15, true), bowOpts(7.2, { sortFaces: true })));
  parts.push(part("ivory", prism([[xT + 1.1 * bu, yHs - 0.2 * bu], [xT + 1.32 * bu, yHs - 0.24 * bu], [xT + 1.42 * bu, hairY - 0.05], [xT + 1.2 * bu, hairY - 0.05]], "z", contact - rT * 1.15, contact + rT * 1.15), bowOpts(7.3)));

  // ---------------------------------------------------------------------------
  // Frame: footprint from (0, 0), everything inside it.
  // ---------------------------------------------------------------------------
  const all = unionBox(parts.map((p) => p.box));
  const at: Vec3 = [-all.min[0], -all.min[1], 0];
  const placed = translate(parts, at);
  const size: Vec3 = [all.max[0] - all.min[0], all.max[1] - all.min[1], all.max[2]];
  const figure = neckFigure("bowed", placed, size, neck, at, ["bow"]);
  return { ...figure, pitchOf: (key) => (key === "bow" ? null : figure.pitchOf(key)) };
}
