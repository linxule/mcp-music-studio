/** @file Stage figures: piano — the grand and the stage keyboard (see src/stage/figures.ts for conventions). */
import "./piano.css";
import {
  box,
  cross,
  cylinder,
  decal,
  dot,
  lathe,
  norm,
  part,
  plate,
  prism,
  rod,
  rotate,
  rotation,
  scale,
  sub,
  translate,
  type Axis,
  type Face,
  type Part,
  type Vec3,
} from "../iso";
import { type Figure, GRAND_RANGE, STAGE_RANGE, isBlack, keyboardFigure, keysFocus, noteName, text } from "./common";

// -----------------------------------------------------------------------------
// Plan geometry helpers
// -----------------------------------------------------------------------------

type P2 = readonly [number, number];
type Pt = [number, number];

/** Strip ids only need to be unique within one part; start far from the engine's own. */
let surf = 90000;

/** A cubic Bézier from a to d, `n` samples after a. */
function bez(a: P2, b: P2, c: P2, d: P2, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    out.push([k[0] * a[0] + k[1] * b[0] + k[2] * c[0] + k[3] * d[0], k[0] * a[1] + k[1] * b[1] + k[2] * c[1] + k[3] * d[1]]);
  }
  return out;
}

const area = (poly: readonly P2[]) => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
};

/** The outline moved inward by `d`, corners mitred. */
function inset(poly: readonly P2[], d: number): Pt[] {
  const s = Math.sign(area(poly));
  const n = poly.length;
  const nrm = (i: number): P2 => {
    const a = poly[i], b = poly[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [(-dy / l) * s, (dx / l) * s];
  };
  return poly.map((p, i) => {
    const n1 = nrm((i + n - 1) % n), n2 = nrm(i);
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml; my /= ml;
    const k = d / Math.max(0.3, mx * n1[0] + my * n1[1]);
    return [p[0] + mx * k, p[1] + my * k];
  });
}

/** Keep the part of a polygon where a·x + b·y + c ≥ 0. */
function clip(poly: readonly P2[], [a, b, c]: readonly [number, number, number]): Pt[] {
  const out: Pt[] = [];
  const f = (p: P2) => a * p[0] + b * p[1] + c;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], fp = f(p), fq = f(q);
    if (fp >= 0) out.push([p[0], p[1]]);
    if (fp >= 0 !== fq >= 0) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** The half-plane left of p→q (facing q), at least `off` from the line. */
function leftOf(p: P2, q: P2, off: number): [number, number, number] {
  const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy);
  return [-dy, dx, dy * p[0] - dx * p[1] - off * l];
}

/** Where a ray from `o` along `d` leaves a polygon (o inside). */
function exit(poly: readonly P2[], o: P2, d: P2): Pt {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const den = d[0] * ey - d[1] * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - o[0]) * ey - (a[1] - o[1]) * ex) / den;
    const s = ((a[0] - o[0]) * d[1] - (a[1] - o[1]) * d[0]) / den;
    if (t > 1e-6 && s >= 0 && s <= 1 && t < best) best = t;
  }
  return [o[0] + d[0] * best, o[1] + d[1] * best];
}

/** Points every `step` along a closed polygon. */
function resample(poly: readonly P2[], step: number): Pt[] {
  const out: Pt[] = [];
  let carry = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let s = carry;
    while (s < l) {
      out.push([a[0] + ((b[0] - a[0]) * s) / l, a[1] + ((b[1] - a[1]) * s) / l]);
      s += step;
    }
    carry = s - l;
  }
  return out;
}

const lift = (axis: Axis, p: P2, at: number): Vec3 => (axis === "z" ? [p[0], p[1], at] : axis === "y" ? [p[0], at, p[1]] : [at, p[0], p[1]]);
const axisUp = (axis: Axis): Vec3 => (axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1]);
const f2 = (v: number) => (Math.round(v * 100) / 100).toString();
const pathD = (pts: readonly P2[], close = true) => pts.map((p, i) => `${i ? "L" : "M"}${f2(p[0])} ${f2(p[1])}`).join("") + (close ? "Z" : "");

/**
 * An outline extruded along `axis` (from < to). Unlike `prism`, only the
 * edges `curved(i)` says are curved are shaded as one smooth surface; the
 * flat sides keep their corner lines. `inward` turns the side walls inside
 * out (the far walls of a case seen from above), without caps.
 */
function extrude(
  outline: readonly P2[],
  axis: Axis,
  from: number,
  to: number,
  curved: (i: number) => boolean = () => false,
  opts: { caps?: boolean; inward?: boolean; skip?: (i: number) => boolean } = {},
): Face[] {
  const lo = outline.map((p) => lift(axis, p, from)), hi = outline.map((p) => lift(axis, p, to));
  const up = axisUp(axis), n = lo.length, id = ++surf;
  let wind = 0;
  for (let i = 0; i < n; i++) wind += dot(cross(lo[i], lo[(i + 1) % n]), up);
  const faces: Face[] = [];
  if (opts.caps !== false && !opts.inward) {
    faces.push({ n: up, pts: wind > 0 ? hi : [...hi].reverse() });
    faces.push({ n: scale(up, -1), pts: wind > 0 ? [...lo].reverse() : lo });
  }
  for (let i = 0; i < n; i++) {
    if (opts.skip?.(i)) continue;
    const j = (i + 1) % n;
    const edge = sub(lo[j], lo[i]);
    if (Math.hypot(...edge) < 1e-9) continue;
    let out = norm(wind > 0 ? cross(edge, up) : cross(up, edge));
    if (opts.inward) out = scale(out, -1);
    faces.push({ n: out, pts: [lo[i], lo[j], hi[j], hi[i]], ...(curved(i) ? { strip: [id, i, n + 2] as const } : {}) });
  }
  return faces;
}

/** A flat band between an outline and its inset at height z (a rim's top), shaded as one surface. */
function band(outer: readonly P2[], inner: readonly P2[], z: number): Face[] {
  const id = ++surf, n = outer.length;
  return outer.map((_, i) => {
    const j = (i + 1) % n;
    return { n: [0, 0, 1] as Vec3, pts: [lift("z", outer[i], z), lift("z", outer[j], z), lift("z", inner[j], z), lift("z", inner[i], z)], strip: [id, i, n] as const };
  });
}

// -----------------------------------------------------------------------------
// Keys at their real size
// -----------------------------------------------------------------------------

/**
 * Real key dimensions (cm): white 2.35 wide (an octave is 16.5), 15 visible,
 * 2.2 thick above its neighbours' slots; black 1.3 wide at the base, tapering,
 * 9.5 long, standing 1.2 above the whites. Blacks are not centred on the
 * white joints: C♯/D♯ split C–E into fifths, F♯/G♯/A♯ split F–B into
 * sevenths, as on a real action.
 */
const KW = 2.35, KL = 15, KH = 2.2, BW = 1.3, BL = 9.5, BH = 1.2, KGAP = 0.06;
const BLACK_AT: Record<number, number> = { 1: 0.9, 3: 2.1, 6: 3 + (1.5 * 4) / 7, 8: 3 + (3.5 * 4) / 7, 10: 3 + (5.5 * 4) / 7 };

function pianoKeys(lo: number, hi: number, x0: number, y0: number, z0: number) {
  const whites = (a: number, b: number) => {
    let n = 0;
    for (let p = a; p < b; p++) if (!isBlack(p)) n++;
    return n;
  };
  const wx = (q: number) => x0 + KW * (q >= lo ? whites(lo, q) : -whites(q, lo));
  const parts: Part[] = [];
  const zt = z0 + KH;
  for (let p = lo; p <= hi; p++) {
    if (isBlack(p)) continue;
    const x = wx(p), name = noteName(p);
    parts.push(
      part("ivory", box(x + KGAP, y0, z0, x + KW - KGAP, y0 + KL, zt), {
        key: `k${p}`,
        cls: p % 12 === 0 ? "key c" : "key",
        pri: 1,
        shadow: false,
        decals: [decal([x + KW / 2, y0 + KL - 1.7, zt], [1, 0, 0], [0, 1, 0], text(0, 0, 1.35, p % 12 === 0 ? name : name[0]))],
      }),
    );
  }
  for (let p = lo; p <= hi; p++) {
    if (!isBlack(p)) continue;
    const m = ((p % 12) + 12) % 12;
    const cx = wx(p - m) + BLACK_AT[m] * KW, h = BW / 2, t = 0.17;
    const section: P2[] = [[cx - h, zt], [cx + h, zt], [cx + h - t, zt + BH], [cx - h + t, zt + BH]];
    parts.push(part("ebony", prism(section, "y", y0, y0 + BL), { key: `k${p}`, cls: "key b", pri: 2, shadow: false }));
  }
  const xOf = (p: number) => {
    let q = Math.max(lo, Math.min(hi, p));
    while (isBlack(q) && q > lo) q--;
    return wx(q);
  };
  return { parts, width: whites(lo, hi + 1) * KW, xOf, top: zt + BH };
}

// -----------------------------------------------------------------------------
// Grand piano
// -----------------------------------------------------------------------------
/*
 * A parlour grand built like one (Yamaha C3 / Steinway A class).
 *
 * Dimension table (cm; 1 unit = 1 cm in plan). Sources: Yamaha C3X spec
 * (149 W × 186 L × 101 H), Steinway model A (188 × 147), keyboard 88 keys =
 * 52 whites × 2.35 = 122.2 (piano tech references, e.g. pianobuyer.com,
 * Reblitz "Piano Servicing, Tuning and Rebuilding").
 *   case width W ............ 144.2  (keys 122.2 + two 11 cheeks)
 *   overall length .......... 186    (key slip front to tail)
 *   case body, front wall→tail 157
 *   case depth (bottom→rim) . 37     real; rim top 63 here
 *   rim thickness ........... 4      (visible rim top)
 *   lid ..................... 2.5 thick, front flap 28 folded back on it,
 *                             short stick: 16° open, stick ~42
 *   keybed / keys ........... keybed 4 thick, key 15 visible, slip 1.7
 *   fallboard ............... sloped board 1.6 thick, keys → rim
 *   music desk .............. 80 × 27, tilted back 12°, rest with a lip
 *   plate ................... 5.5 below the rim top, 4 struts, 4 round holes
 *   strings ................. 88 drawn (one per note), bass 20 overstrung
 *   legs .................... 3, tapered, block on top, brass caster
 *   lyre .................... 2 curved arms, pedal box, 3 pedals 6.5 apart,
 *                             2 brace rods to the case bottom
 *   bench ................... 76 × 36
 * Heights are true: a real keybed is ~62 cm off the floor (LEG). (An early
 * contract test pinned the keybed at z 26–30 and forced a ×0.43 squash below
 * it; the test now finds the keybed by what it is, the case part the keys
 * rest on.)
 *
 * Parts (bottom up): 3 legs, 3 leg blocks, 3 caster cups, 3 wheels; lyre
 * top block, 2 lyre arms, pedal box, 3 pedals, 2 braces; keybed, key slip,
 * 2 cheek arms, 88 keys, fallboard; case walls + rim top, inner walls,
 * soundboard, plate (struts, holes, bolts, tuning pins, bridges, hitch
 * pins), tenor/treble strings, overstrung bass strings, dampers; desk panel,
 * desk rest; lid, folded flap, 3 hinges, stick cup, stick, stick block;
 * bench seat, apron, 4 legs, 2 stretchers, 2 height knobs.
 */

/** Keybed underside = case bottom, off the floor; everything in the case is measured from it. */
const LEG = 62;
/** Keybed 4 thick; the keys rest on it. */
const KEYBED = LEG + 4;
/** Case depth 37: rim top ~99 (a C3 is 101 with the lid shut). */
const RIM = LEG + 37;
/** Bench seat height (an adjustable bench at its usual setting). */
const SEAT = 50;
const CH = 11;
const FRONT = -12;
const LID_DEG = 16;
const LID_FRONT = -38;
const FLAP = 28;

/** The case seen from above: straight spine at x = 0 (bass), bentside curving in on the treble side, round tail. */
function caseOutline(W: number): { pts: Pt[]; curved: (i: number) => boolean } {
  const pts: Pt[] = [[0, FRONT], [W, FRONT], [W, -48]];
  const p3: P2 = [0.37 * W, -142];
  pts.push(...bez([W, -48], [W, -86], [0.5 * W, -92], p3, 14));
  pts.push(...bez(p3, [0.31 * W, -164], [0.08 * W, -172], [0, -150], 10));
  const first = 2, last = pts.length - 1;
  return { pts, curved: (i) => i >= first && i < last };
}

/** A grand piano with all 88 keys; `lo`..`hi` (the octaves the music uses) is what its close-up frames. */
export function grandPiano(lo: number, hi: number): Figure {
  const [from, to] = GRAND_RANGE;
  const kb = pianoKeys(from, to, CH, 0, KEYBED);
  const W = kb.width + 2 * CH;
  const { pts: outline, curved } = caseOutline(W);
  const inner = inset(outline, 4);
  const parts: Part[] = [];

  // --- Case: outer walls with the rim's top, the far inner walls, the soundboard.
  parts.push(part("body", [...extrude(outline, "z", LEG, RIM, curved, { caps: false }), ...band(outline, inner, RIM)], { sortFaces: true, pri: 5, shadow: "case" }));
  parts.push(part("body", extrude(inner, "z", RIM - 12, RIM, curved, { inward: true }), { sortFaces: true, pri: 1.5, shadow: false }));
  parts.push(part("wood", plate(inner.map((p) => lift("z", p, RIM - 12)), [0, 0, 1]), { pri: 1, shadow: false }));

  // --- The cast-iron plate: openings between four struts, round holes, bolts, tuning pins, bridges, hitch pins.
  const PZ = RIM - 7;
  const plateOut = inset(outline, 5.5);
  const hitch = inset(outline, 8);
  const N = to - from + 1, BASS = 20;
  const pinX = (i: number) => 9 + (i * (W - 18)) / (N - 1);
  const strings = Array.from({ length: N }, (_, i) => {
    const lean = i < BASS ? 0.26 + 0.004 * i : -0.3 + (0.3 * (i - BASS)) / (N - 1 - BASS);
    const d: P2 = [lean / Math.hypot(lean, 1), -1 / Math.hypot(lean, 1)];
    const o: P2 = [pinX(i), -25];
    return { o, d, end: exit(hitch, o, d), bass: i < BASS };
  });
  const base = clip(inset(outline, 11), [0, -1, -42]);
  const struts: [P2, P2][] = [[[0.2 * W, -42], [0.15 * W, -152]], [[0.45 * W, -42], [0.27 * W, -150]], [[0.7 * W, -42], [0.4 * W, -136]]];
  const SW = 1.8;
  const openings = [0, 1, 2, 3].map((k) => {
    let poly: Pt[] = base;
    if (k > 0) poly = clip(poly, leftOf(struts[k - 1][0], struts[k - 1][1], SW));
    if (k < 3) poly = clip(poly, leftOf(struts[k][1], struts[k][0], SW));
    return poly;
  }).filter((p) => p.length > 2);
  const bridge = (sel: (s: (typeof strings)[number]) => boolean) =>
    strings.filter(sel).map(({ end, d }) => [end[0] - d[0] * 7, end[1] - d[1] * 7] as P2);
  const plateSvg =
    openings.map((p) => `<path class="gp-open" d="${pathD(p)}"/>`).join("") +
    [0.17, 0.39, 0.61, 0.83].map((f) => `<circle class="gp-hole" cx="${f2(f * W)}" cy="-37.5" r="2.1"/>`).join("") +
    resample(inset(outline, 7.2), 13).map(([x, y]) => `<circle class="gp-bolt" cx="${f2(x)}" cy="${f2(y)}" r="0.55"/>`).join("") +
    strings.map(({ o }, i) => `<circle class="gp-pin" cx="${f2(o[0])}" cy="-20.5" r="0.42"/><circle class="gp-pin" cx="${f2(o[0] + (i % 2 ? 0.5 : -0.5))}" cy="-23" r="0.42"/>`).join("") +
    [bridge((s) => !s.bass), bridge((s) => s.bass)].map((b) => `<path class="gp-bridge" d="${pathD(b, false)}"/><path class="gp-bridge-top" d="${pathD(b, false)}"/>`).join("") +
    strings.map(({ end }) => `<circle class="gp-hitch" cx="${f2(end[0])}" cy="${f2(end[1])}" r="0.45"/>`).join("");
  parts.push(
    part("iron", plate(plateOut.map((p) => lift("z", p, PZ)), [0, 0, 1]), {
      pri: 2,
      shadow: false,
      decals: [decal([0, 0, PZ], [1, 0, 0], [0, 1, 0], plateSvg, [Math.min(...plateOut.map((p) => p[0])), Math.min(...plateOut.map((p) => p[1])), Math.max(...plateOut.map((p) => p[0])), Math.max(...plateOut.map((p) => p[1]))])],
    }),
  );
  const strokes = (bass: boolean, z: number, cls: string) =>
    strings.filter((s) => s.bass === bass).map(({ o, end }) => ({ pts: [[o[0], o[1], z], [end[0], end[1], z]] as Vec3[], cls }));
  parts.push(part("metal", [], { pri: 3, shadow: false, strokes: strokes(false, PZ + 1.5, "gp-str") }));
  parts.push(part("metal", [], { pri: 3.3, shadow: false, strokes: strokes(true, PZ + 2.8, "gp-bass") }));
  // Dampers: felt-and-wood heads resting on the strings near the pins, none in the top two octaves.
  const damp = strings.slice(0, 66).map(({ o }) => `<rect class="gp-damp" x="${f2(o[0] - 0.55)}" y="-31.5" width="1.1" height="3.6" rx="0.2"/>`).join("");
  parts.push(part("felt", [], { pri: 3.6, shadow: false, decals: [decal([0, 0, PZ + 4.5], [1, 0, 0], [0, 1, 0], damp, [4, -32, W - 4, -27])] }));

  // --- Keyboard end: keybed (the case part the keys rest on), key slip, cheek arms, fallboard.
  parts.push(part("body", box(CH, FRONT, LEG, W - CH, 15.3, KEYBED), { pri: 0, shadow: "case" }));
  parts.push(part("body", box(CH, 15.3, LEG, W - CH, 17, KEYBED + 1.6), { pri: 0, shadow: "case" }));
  const arm: Pt[] = [[FRONT, LEG], [17, LEG], [17, LEG + 10], [16.4, LEG + 11.2], [15, LEG + 11.6], [5, LEG + 11.6]];
  const armCurved = new Set([2, 3, 4]);
  const n0 = arm.length;
  arm.push(...bez([5, LEG + 11.6], [-3, LEG + 11.6], [-12, LEG + 21], [FRONT, RIM], 8));
  for (let i = n0 - 1; i < arm.length - 1; i++) armCurved.add(i);
  for (const [x0, x1] of [[0, CH], [W - CH, W]]) {
    parts.push(part("body", extrude(arm, "x", x0, x1, (i) => armCurved.has(i)), { pri: 0, shadow: "case", sortFaces: true }));
  }
  // The fallboard stands open, nearly upright, behind the keys; the key cover closes the gap to the rim.
  const fA: P2 = [1.4, kb.top + 0.2], fD: P2 = [-4.6, RIM - 1.6];
  const fall: P2[] = [fA, [-0.2, kb.top + 0.2], [-6.2, RIM - 1.6], fD];
  const fl = Math.hypot(fA[0] - fD[0], fA[1] - fD[1]);
  const fv: Vec3 = [0, (fA[0] - fD[0]) / fl, (fA[1] - fD[1]) / fl];
  const FW = W - 2 * CH;
  parts.push(
    part("body", extrude(fall, "x", CH, W - CH), {
      pri: 0,
      shadow: false,
      cls: "fallboard",
      decals: [
        decal([CH, fD[0], fD[1]], [1, 0, 0], fv,
          `<path class="gp-trim" d="M0 ${f2(fl * 0.42)}H${f2(FW)}"/><rect class="gp-lock" x="${f2(FW / 2 - 1.2)}" y="2" width="2.4" height="1.1" rx="0.4"/>`),
      ],
    }),
  );
  parts.push(part("body", box(CH, FRONT, RIM - 1.6, W - CH, -4.6, RIM), { pri: 0, shadow: false }));

  // --- Music desk on the rim's front edge: a panel tilted back, on its rest.
  const DX0 = W / 2 - 40, DX1 = W / 2 + 40;
  const tilt = rotation("x", 12, [0, -15, RIM + 1.4]);
  parts.push(
    part("wood", rotate(box(DX0, -15.6, RIM + 1.4, DX1, -14.4, RIM + 27), "x", 12, [0, -15, RIM + 1.4]), {
      pri: 6,
      shadow: false,
      cls: "desk",
      decals: [
        decal(tilt.point([DX0, -14.4, RIM + 27]), tilt.dir([1, 0, 0]), tilt.dir([0, 0, -1]),
          `<rect class="gp-trim" x="2.5" y="2" width="75" height="21" rx="1"/><path class="gp-trim" d="M8 7.5H72M8 12H72"/>`),
      ],
    }),
  );
  const rest: P2[] = [[-14.4, RIM], [-11.2, RIM], [-11.2, RIM + 3.2], [-11.9, RIM + 3.2], [-11.9, RIM + 1.4], [-14.4, RIM + 1.4]];
  parts.push(part("wood", extrude(rest, "x", DX0 - 1, DX1 + 1), { pri: 6.5, shadow: false }));

  // --- The lid on hinges along the spine, the front flap folded back on it, propped on the short stick.
  const lidOut = clip(outline, [0, -1, LID_FRONT]);
  const flapOut = clip(lidOut, [0, 1, -(LID_FRONT - FLAP)]);
  const pivot: Vec3 = [0, 0, RIM];
  parts.push(part("body", rotate(extrude(lidOut, "z", RIM, RIM + 2.5, (i) => i > 1 && i < lidOut.length - 2), "y", -LID_DEG, pivot), { sortFaces: true, pri: 8, shadow: "case", cls: "lid" }));
  parts.push(part("body", rotate(extrude(flapOut, "z", RIM + 2.5, RIM + 4.3, (i) => i > 1 && i < flapOut.length - 2), "y", -LID_DEG, pivot), { sortFaces: true, pri: 8.5, shadow: false, cls: "lid" }));
  for (const y of [-58, -100, -138]) {
    parts.push(part("brass", cylinder("y", [-0.8, RIM], 0.8, 0.8, y - 3.5, y + 3.5, 10), { pri: 7.8, shadow: false }));
  }
  const lidRot = rotation("y", -LID_DEG, pivot);
  const SY = -45, cup: Vec3 = [W - 2, SY, RIM];
  const xu = (W - 12) / Math.cos((LID_DEG * Math.PI) / 180);
  const top = lidRot.point([xu, SY, RIM]);
  parts.push(part("brass", lathe("z", [cup[0], cup[1]], [[1.5, RIM], [2.0, RIM + 0.4], [2.0, RIM + 1.4], [1.4, RIM + 1.4]], 14, [1, 2]), { pri: 6, shadow: false }));
  parts.push(part("wood", rod([cup[0], cup[1], RIM + 0.8], top, 0.9, 0.75), { pri: 7, shadow: false, cls: "stick" }));
  parts.push(part("wood", rotate(box(xu - 4, SY - 1.6, RIM - 1.4, xu + 1.5, SY + 1.6, RIM), "y", -LID_DEG, pivot), { pri: 7.5, shadow: false }));

  // --- Legs: a block under the case, a tapered leg, a brass caster.
  const legs: P2[] = [[5.5, 3], [W - 5.5, 3], [0.29 * W, -148]];
  for (const [x, y] of legs) {
    parts.push(part("body", box(x - 5.8, y - 5.8, LEG - 3, x + 5.8, y + 5.8, LEG), { pri: -1, shadow: "case" }));
    parts.push(part("body", lathe("z", [x, y], [[2.8, 4.4], [3.3, 5.2], [4.6, LEG - 4.4], [5.2, LEG - 4], [5.2, LEG - 3]], 16, [1, 3]), { pri: -1, shadow: "case" }));
    parts.push(part("brass", lathe("z", [x, y], [[1.6, 3.2], [2.5, 3.6], [2.5, 4.4]], 14, [1]), { pri: -1, shadow: "case" }));
    parts.push(part("felt", cylinder("x", [y, 1.6], 1.6, 1.6, x - 0.9, x + 0.9, 14), { pri: -1.5, shadow: "case" }));
  }

  // --- The lyre under the keybed: two curved arms, the pedal box, three pedals, two braces.
  const LX = W / 2;
  parts.push(part("body", box(LX - 9, 2, LEG - 2.5, LX + 9, 8, LEG), { pri: -1, shadow: "case" }));
  for (const s of [-1, 1]) {
    const c = bez([LX + s * 7.5, LEG - 2.5], [LX + s * 11.5, LEG * 0.69], [LX + s * 10.5, LEG * 0.42], [LX + s * 7, 7.5], 8);
    c.unshift([LX + s * 7.5, LEG - 2.5]);
    const outl: Pt[] = [...c.map(([x, z]) => [x - 0.85, z] as Pt), ...c.reverse().map(([x, z]) => [x + 0.85, z] as Pt)];
    parts.push(part("body", extrude(outl, "y", 4, 6, (i) => i !== c.length - 1 && i !== outl.length - 1), { pri: -1, shadow: "case", sortFaces: true }));
    parts.push(part("brass", rod([LX + s * 7, 1.4, 5.5], [LX + s * 12, -40, LEG - 0.5], 0.45), { pri: -1.2, shadow: false }));
  }
  parts.push(part("body", box(LX - 11, 2, 3.5, LX + 11, 8, 7.5), { pri: -1, shadow: "case" }));
  for (const dx of [-6.5, 0, 6.5]) {
    const x = LX + dx;
    const pedal: P2[] = [[x - 1, 8], [x + 1, 8], [x + 1.6, 16.5], [x + 1.3, 18.6], [x - 1.3, 18.6], [x - 1.6, 16.5]];
    parts.push(part("brass", extrude(pedal, "z", 4.6, 5.6, (i) => i >= 1 && i <= 4), { pri: -0.8, shadow: "case", cls: "pedal" }));
  }

  // --- The bench: padded seat on an apron, four tapered legs, stretchers, height knobs.
  const BZ = SEAT, BX = W / 2, BY0 = 37, BY1 = 73;
  const seat: P2[] = [[BY0, BZ - 2.6], [BY1, BZ - 2.6], [BY1, BZ - 0.8], [BY1 - 0.8, BZ], [BY0 + 0.8, BZ], [BY0, BZ - 0.8]];
  parts.push(part("seat", extrude(seat, "x", BX - 38, BX + 38, (i) => i >= 2 && i <= 4), { pri: 1, shadow: "bench", sortFaces: true }));
  parts.push(part("wood", box(BX - 36.5, BY0 + 1.5, BZ - 6.6, BX + 36.5, BY1 - 1.5, BZ - 2.6), { pri: 0, shadow: "bench" }));
  for (const x of [BX - 34, BX + 34]) {
    for (const y of [BY0 + 3.5, BY1 - 3.5]) {
      parts.push(part("wood", lathe("z", [x, y], [[1.25, 0], [1.4, 0.6], [2.0, BZ - 7.6], [2.3, BZ - 6.6]], 12, [1]), { pri: -1, shadow: "bench" }));
    }
    parts.push(part("wood", rod([x, BY0 + 3.5, 10], [x, BY1 - 3.5, 10], 0.7), { pri: -1.2, shadow: "bench" }));
  }
  for (const s of [-1, 1]) {
    const x0 = BX + s * 36.5;
    parts.push(part("wood", lathe("x", [(BY0 + BY1) / 2, BZ - 4.6], [[1.0, x0], [1.9, x0 + s * 0.7], [1.9, x0 + s * 2.2], [1.2, x0 + s * 3]], 14, [1, 2]), { pri: 0.5, shadow: "bench" }));
  }

  parts.push(...kb.parts);
  const Y0 = -Math.min(...outline.map((p) => p[1]));
  const all = translate(parts, [0, Y0, 0]);
  const size: Vec3 = [W, Math.max(...all.map((p) => p.box.max[1])), Math.max(...all.map((p) => p.box.max[2]))];
  const focus = keysFocus(kb, lo, hi, Y0 - 6, Y0 + 20, LEG, kb.top + 8);
  return keyboardFigure("grand", all, size, from, to, focus);
}

// -----------------------------------------------------------------------------
// Stage keyboard (synth, organ, and any melody without a figure of its own)
// -----------------------------------------------------------------------------
/*
 * A 61-key stage piano / synth (Nord Stage, Yamaha MODX6, Roland Juno class),
 * floating at playing height with a stool; no stand.
 *
 * Dimension table (cm). Sources: Yamaha MODX6 spec 98.4 W × 30.4 D × 11.8 H;
 * Nord Stage 3 HP76 / Roland Juno-DS61 (≈ 100 × 30 × 10); keys as on the
 * grand (2.35 × 15, blacks 1.3 × 9.5).
 *   end cheeks ........ 2.2 thick, full depth, rounded top
 *   wheel block ....... 11 wide at the left: pitch and mod wheels Ø6 × 1.6
 *   control panel ..... 11 deep behind the keys: screen 22 × 5.5, 5 knobs
 *                       Ø3.4, 6 buttons with LEDs, a volume slider
 *   felt strip ........ along the back of the keys
 *   key slip / lip .... 2 deep in front of the keys
 *   chassis ........... keys' top at 76.7 (a stand at 70), 4 rubber feet
 *   stool ............. round seat Ø30 at 50, column, four-star base
 * Exaggerations: none beyond the knobs (×1.3, so a close-up reads them).
 *
 * Parts: chassis tray, panel deck, felt strip, key slip, wheel deck, 2 end
 * cheeks, 4 feet, 2 wheels, 2 wheel slots, screen, 5 knobs, 6 buttons,
 * slider cap, keys; stool seat, seat pan, column, collar, 4 base legs,
 * 4 glides.
 */

/** A stage keyboard, 61 keys or wider if the music needs it; its close-up frames `lo`..`hi`. */
export function standKeys(lo: number, hi: number, label: string): Figure {
  const ECH = 2.2, WH = 11, PANEL = 11, LIP = 2, Z0 = 70, TRAY = 4.5, DECK = Z0 + 10;
  const from = Math.min(STAGE_RANGE[0], 12 * Math.floor(lo / 12)), to = Math.max(STAGE_RANGE[1], 12 * Math.ceil(hi / 12));
  const kb = pianoKeys(from, to, ECH + WH, PANEL, Z0 + TRAY);
  const KX1 = ECH + WH + kb.width;
  const W = KX1 + 3 + ECH, D = PANEL + KL + LIP;
  const parts: Part[] = [];
  const sh = "kb";
  // Chassis: the tray under everything, the raised panel deck, the felt strip, the key slip.
  parts.push(part("body", box(ECH, 0, Z0, W - ECH, D, Z0 + TRAY), { pri: 0, shadow: sh }));
  parts.push(
    part("body", box(ECH, 0, Z0 + TRAY, W - ECH, PANEL - 0.6, DECK), {
      pri: 0,
      shadow: sh,
      decals: [decal([ECH + 1.6, 5, DECK], [1, 0, 0], [0, 1, 0], `<rect class="sk-slot" x="0" y="0" width="7.8" height="0.6" rx="0.3"/>`)],
    }),
  );
  parts.push(part("felt", box(ECH + WH, PANEL - 0.6, Z0 + TRAY, KX1 + 3, PANEL, Z0 + TRAY + 3.4), { pri: 0, shadow: false }));
  parts.push(part("body", box(ECH + WH, PANEL + KL, Z0 + TRAY, KX1 + 3, D, Z0 + TRAY + 1.4), { pri: 0, shadow: false }));
  parts.push(part("body", box(KX1, PANEL - 0.6, Z0 + TRAY, KX1 + 3, PANEL + KL, Z0 + TRAY + 2.2), { pri: 0, shadow: false }));
  // The wheel deck at the left, two wheels showing through their slots.
  const WD = Z0 + 7.4;
  parts.push(
    part("body", box(ECH, PANEL - 0.6, Z0 + TRAY, ECH + WH, D, WD), {
      pri: 0,
      shadow: false,
      decals: [decal([ECH, PANEL, WD], [1, 0, 0], [0, 1, 0], [2.0, 6.2].map((x) => `<rect class="sk-slot" x="${x}" y="3.2" width="2.4" height="7.6" rx="0.5"/>`).join(""), [2, 3.2, 8.6, 10.8])],
    }),
  );
  const R = 3, wy = PANEL + 7, wz = WD - 1.3;
  const a0 = Math.asin((WD - wz) / R);
  const cap: Pt[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = a0 + ((Math.PI - 2 * a0) * i) / 10;
    cap.push([wy + Math.cos(t) * R, wz + Math.sin(t) * R]);
  }
  for (const x of [2.4, 6.6]) {
    parts.push(part("ebony", extrude(cap, "x", ECH + x, ECH + x + 1.6, (i) => i < cap.length - 1), { pri: 1, shadow: false, cls: "wheel" }));
  }
  // End cheeks: full depth, rounded top front and back.
  const cheek: Pt[] = [[0, Z0], [D, Z0], [D, Z0 + 6], ...bez([D, Z0 + 6], [D, Z0 + 8.4], [D - 1.5, Z0 + 9], [D - 4, Z0 + 9], 4), [6, DECK + 1.2], ...bez([6, DECK + 1.2], [3, DECK + 1.6], [0, DECK + 1.6], [0, DECK - 1], 4)];
  for (const [x0, x1] of [[0, ECH], [W - ECH, W]]) {
    parts.push(part("body", extrude(cheek, "x", x0, x1, (i) => i >= 2 && i !== 6), { pri: 0, shadow: sh, sortFaces: true }));
  }
  for (const x of [ECH + 4, W - ECH - 4]) for (const y of [3, D - 3]) {
    parts.push(part("felt", cylinder("z", [x, y], 1.2, 1.2, Z0 - 0.9, Z0, 10), { pri: -1, shadow: sh }));
  }
  // The panel: screen with the sound's name, knobs to its left, buttons with LEDs to its right, a volume slider.
  const SX = W / 2;
  parts.push(
    part("screen", box(SX - 11, 2.5, DECK, SX + 11, 8, DECK + 0.4), {
      pri: 1,
      shadow: false,
      decals: [decal([SX, 5.25, DECK + 0.4], [1, 0, 0], [0, 1, 0], text(0, 0.8, Math.min(2.4, 19 / (0.7 * Math.max(1, label.length))), label.toUpperCase(), "lcd"))],
    }),
  );
  for (let i = 0; i < 5; i++) {
    const x = SX - 16 - i * 6.2, y = 5.4;
    parts.push(
      part("metal", lathe("z", [x, y], [[1.7, DECK], [1.7, DECK + 0.5], [1.35, DECK + 0.7], [1.25, DECK + 2.0], [1.05, DECK + 2.2]], 14, [1, 2]), {
        pri: 1,
        shadow: false,
        decals: [decal([x, y, DECK + 2.2], [1, 0, 0], [0, 1, 0], `<path class="sk-tick" d="M0 0L${f2(-0.7 + i * 0.35)} -0.8"/>`, [-1.1, -1.1, 1.1, 1.1])],
      }),
    );
  }
  for (let i = 0; i < 6; i++) {
    const x = SX + 14 + i * 3.6;
    parts.push(
      part("body", box(x, 4.2, DECK, x + 2.4, 6.6, DECK + 0.6), {
        pri: 1,
        shadow: false,
        decals: [decal([x + 1.2, 3.2, DECK], [1, 0, 0], [0, 1, 0], `<circle class="sk-led" r="0.35"/>`)],
      }),
    );
  }
  parts.push(
    part("body", box(ECH + 4.4, 4.4, DECK, ECH + 6.6, 6.2, DECK + 1.2), { pri: 1, shadow: false }),
  );
  parts.push(...kb.parts);
  // The stool: a round padded seat on a column, a four-star base on glides.
  const cx = W / 2, cy = D + 30, SZ = 50;
  const ssh = "stool";
  parts.push(part("seat", lathe("z", [cx, cy], [[14, SZ - 4], [15, SZ - 3.2], [15, SZ - 1.2], [14, SZ], [0, SZ]], 22, [1, 2]), { pri: 2, shadow: ssh }));
  parts.push(part("metal", lathe("z", [cx, cy], [[3, SZ - 6], [11, SZ - 4.6], [11, SZ - 4]], 18, [1]), { pri: 1, shadow: ssh }));
  parts.push(part("metal", cylinder("z", [cx, cy], 2.2, 2.2, 9, SZ - 6, 14), { pri: 0, shadow: ssh }));
  parts.push(part("metal", lathe("z", [cx, cy], [[2.2, 30], [3.2, 30.6], [3.2, 33], [2.2, 33.6]], 14, [1, 2]), { pri: 0.5, shadow: ssh }));
  for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const fx = cx + dx * 17, fy = cy + dy * 17;
    parts.push(part("metal", rod([cx, cy, 10], [fx, fy, 2.4], 1.1, 0.8), { pri: -1, shadow: ssh }));
    parts.push(part("felt", cylinder("z", [fx, fy], 1.4, 1.4, 0, 2.4, 10), { pri: -1, shadow: ssh }));
  }
  const size: Vec3 = [W, cy + 20, DECK + 2.4];
  return keyboardFigure("keys", parts, size, from, to, keysFocus(kb, lo, hi, PANEL - 4, D + 3, Z0, Z0 + 14));
}
