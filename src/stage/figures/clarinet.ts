/** @file Stage figures: clarinet (split from src/stage/figures.ts; see its header for conventions). */
import { cross, decal, dot, lathe, norm, part, rod, sub, translate, type Decal, type Face, type Part, type Vec3 } from "../iso";
import { CLARINET } from "../fingerings";
import "./clarinet.css";
import { FLOAT, type Figure, woodwindLight, woodwindPitch } from "./common";

/*
 * The B♭ soprano clarinet, Boehm system, 17 keys / 6 rings — built as made.
 *
 * Dimension table (1 unit = 1 cm; u = height above the bell's rim):
 *   overall, assembled          66.5   (real 66–67)
 *   bell                        0–11    mouth Ø 6.7, socket Ø 3.4
 *   lower joint (visible)       11–31   Ø 2.9
 *   upper joint (visible)       31–52   Ø 2.9, bottom socket Ø 3.2
 *   barrel                      52–58.5 6.5 long (Yamaha: 65 mm), Ø 3.2 at the rings, waisted to 3.0
 *   mouthpiece (visible)        58.5–66.5, beak sloping to the tip; table and reed on the reed side
 *   reed                        59.4–66.4, 1.3 wide, 0.3 → 0.04 thick
 *   ligature                    59.7–62.2, two screws on the reed side
 *   tone holes (front column)   L1 41.5  L2 38  L3 35 | R1 26  R2 23  R3 20; thumb 40.6
 *   rings                       Ø 1.28 over a raised chimney Ø 0.84; tone hole Ø 0.6
 *   key touches                 0.65–1.3 long, standing 0.45–0.6 off the wood on posts
 *   bore                        1.46 (not drawn: the ends are capped)
 * Exaggerations: none above ~1.15× — the rings and touches are at real size; the
 * hole dot is drawn a little larger than the bore of the hole so a lit hole reads.
 *
 * Orientation. The front (the tone-hole column) faces the viewer squarely —
 * along (+1, +1), the middle of the default view — so the column runs down the
 * middle like a method-book drawing. Keys sit where they are on the instrument,
 * seen from the front: the player's LEFT side (left pinky cluster, G♯, the
 * thumb's ring and register key) is on the screen's right, the player's RIGHT
 * side (four side trill keys, right pinky cluster) on the screen's left. The
 * thumb hole, the register key and the reed are really on the back; they are
 * turned 60–75° round to the visible left side (screen right), together, so
 * they keep their places relative to each other.
 *
 * Parts (71 solids, 24 of them pressable): bell (lathe, rim bead), bell ring, lower joint, upper joint with
 * its socket, socket ring, barrel (waisted lathe), two barrel rings, mouthpiece
 * (lofted D-section with the beak), reed, ligature, two ligature screws (ears,
 * screw, knurled knob); six chimneys; six rings (L1 L2 T R1 R2 R3), each a flat band
 * on an arm to its hinge tube; the plain L3 hole; two hinge tubes with four
 * posts; throat A and G♯ (touch, lever, pad cup, chimney, post); register key;
 * the E♭/B♭ sliver key; four side trill keys (touch, cranked lever, cup, post);
 * left pinky E/B, F/C, F♯/C♯, C♯/G♯ and their long rods with posts; right pinky
 * E/B, F/C, F♯/C♯, G♯/D♯; the open low E, F and F♯ pads on their chimneys; the
 * joint bridge (two plates and their links). Primitives: lathe for the body,
 * a lofted solid (below) for the mouthpiece, reed, ligature and every turned
 * part not along z (posts, cups, chimneys, knobs), flat washers for the rings, rod for
 * every lever, hinge and link.
 *
 * Sources: Yamaha YCL-450 spec (17 keys / 6 rings, 65 mm barrel)
 * https://au.yamaha.com/en/products/musical_instruments/winds/clarinets/ycl-450_03/specs.html ;
 * which holes carry rings (the left ring finger, L3, is a plain hole; thumb,
 * L1, L2, R1–R3 are ringed): Yamaha's instrument guide, "The Structure of the
 * Clarinet" https://www.yamaha.com/en/musical_instrument_guide/clarinet/mechanism/mechanism002.html
 * and Edinburgh MIMEd records (e.g. https://collections.ed.ac.uk/mimed/record/17147).
 * Other lengths and key placements are typical modern values, not one maker's drawing.
 */

const RB = 1.45; // body radius
const FRONT = 45; // world angle (deg) the tone-hole column faces
let surface = 7_000_000; // strip ids for our own lofts (only unique within a part matters)

// ---- Geometry in the instrument's frame: φ = degrees round from the front, + toward the player's left ----

const theta = (phi: number) => ((FRONT - phi) * Math.PI) / 180;
/** Outward unit vector at φ. */
const rad = (phi: number): Vec3 => [Math.cos(theta(phi)), Math.sin(theta(phi)), 0];
/** Unit vector toward larger φ (the screen's right on the front). */
const tng = (phi: number): Vec3 => [Math.sin(theta(phi)), -Math.cos(theta(phi)), 0];
const Z: Vec3 = [0, 0, 1];
const at = (phi: number, r: number, z: number): Vec3 => [Math.cos(theta(phi)) * r, Math.sin(theta(phi)) * r, z];
const plus = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const centre = (pts: readonly Vec3[]): Vec3 => {
  let x = 0, y = 0, z = 0;
  for (const p of pts) { x += p[0]; y += p[1]; z += p[2]; }
  return [x / pts.length, y / pts.length, z / pts.length];
};
const area = (pts: readonly Vec3[]): Vec3 => {
  let a: Vec3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) a = plus(a, cross(pts[i], pts[(i + 1) % pts.length]));
  return a;
};

/**
 * A solid lofted through cross-sections with the same point count (a lathe
 * generalised: any axis, any section). Normals point away from the line
 * through the sections' centres (a waisted section still faces out). Inked
 * like a lathe: the end rims, the creases, and the silhouette.
 */
function loft(secs: Vec3[][], o: { closed?: boolean; caps?: boolean; creases?: number[] } = {}): Face[] {
  const m = secs.length, n = secs[0].length, creases = o.creases ?? [];
  const cs = secs.map(centre);
  const faces: Face[] = [];
  for (let k = 0; k < (o.closed ? m : m - 1); k++) {
    const A = secs[k], B = secs[(k + 1) % m], c = mid(cs[k], cs[(k + 1) % m]);
    const id = ++surface;
    const rims = o.closed ? 0 : (k === 0 || creases.includes(k) ? 1 : 0) | (k === m - 2 || creases.includes(k + 1) ? 2 : 0);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const q = [A[i], A[j], B[j], B[i]];
      let nn = cross(sub(q[1], q[0]), sub(q[3], q[0]));
      if (Math.hypot(...nn) < 1e-9) nn = cross(sub(q[2], q[3]), sub(q[0], q[3]));
      if (Math.hypot(...nn) < 1e-9) continue;
      if (dot(nn, sub(centre(q), c)) < 0) nn = [-nn[0], -nn[1], -nn[2]];
      faces.push({ n: norm(nn), pts: q, strip: [id, i, n, rims] });
    }
  }
  if (o.caps && !o.closed) {
    for (const [k, other] of [[0, 1], [m - 1, m - 2]] as const) {
      const a = area(secs[k]);
      if (Math.hypot(...a) < 1e-6) continue;
      let nn = norm(a), pts = secs[k];
      if (dot(nn, sub(cs[k], cs[other])) < 0) { nn = [-nn[0], -nn[1], -nn[2]]; pts = [...pts].reverse(); }
      faces.push({ n: nn, pts });
    }
  }
  return faces;
}

/** Two unit vectors across direction d. */
function across(d: Vec3): [Vec3, Vec3] {
  const e1 = norm(cross(d, Math.abs(d[2]) < 0.9 ? Z : [1, 0, 0]));
  return [e1, cross(d, e1)];
}
const ring = (c: Vec3, e1: Vec3, e2: Vec3, r: number, n: number, ra = r): Vec3[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return plus(plus(c, e1, Math.cos(t) * r), e2, Math.sin(t) * ra);
  });

/** A turned part along any direction: `prof` is [radius, distance along d], like `lathe`. */
function spin(o: Vec3, d: Vec3, prof: readonly (readonly [number, number])[], n = 14, creases: number[] = []): Face[] {
  const [e1, e2] = across(d);
  return loft(prof.map(([r, s]) => ring(plus(o, d, s), e1, e2, r, n)), { caps: true, creases });
}

/**
 * A key ring: a flat nickel band (a washer), its top facing `d`: the outer
 * wall and the inner wall (seen through the opening); the top is {@link bandTop}.
 */
function washer(c: Vec3, d: Vec3, r0: number, r1: number, h: number, n = 28): Face[] {
  const [e1, e2] = across(d);
  const ins = ring(c, e1, e2, r0, n), out = ring(c, e1, e2, r1, n);
  const insB = ring(plus(c, d, -h), e1, e2, r0, n), outB = ring(plus(c, d, -h), e1, e2, r1, n);
  const ow = ++surface, iw = ++surface;
  const faces: Face[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, t = ((i + 0.5) / n) * Math.PI * 2;
    const r: Vec3 = norm(plus(plus([0, 0, 0], e1, Math.cos(t)), e2, Math.sin(t)));
    faces.push({ n: r, pts: [out[i], out[j], outB[j], outB[i]], strip: [ow, i, n, 2] });
    faces.push({ n: [-r[0], -r[1], -r[2]], pts: [ins[i], ins[j], insB[j], insB[i]], strip: [iw, i, n, 2] });
  }
  return faces;
}

const bandTop = (c: Vec3, d: Vec3, r0: number, r1: number): Decal =>
  decal(plus(c, d, 0.004), norm(cross(d, Z)), [0, 0, -1],
    `<circle class="clar-band" r="${f2((r0 + r1) / 2)}" stroke-width="${f2(r1 - r0)}"/><circle class="clar-edge" r="${f2(r1)}"/><circle class="clar-edge" r="${f2(r0)}"/>`, [-r1, -r1, r1, r1]);

/** A flat oval touch (a spatula) facing `e`, `a` half-length along z, `b` half-width across. */
function spatula(c: Vec3, e: Vec3, a: number, b: number, th = 0.13): Face[] {
  const t = norm(cross(Z, e));
  const oval = (o: Vec3) => ring(o, Z, t, a, 14, b);
  return loft([oval(c), oval(plus(c, e, th * 0.7)), (() => {
    const o = plus(c, e, th);
    return ring(o, Z, t, a * 0.86, 14, b * 0.8);
  })()], { caps: true, creases: [1] });
}

/*
 * The engine rounds screen points to 0.1 unit, which turns a 1 cm round into a
 * visible polygon at close range; decals are drawn through a matrix and stay
 * round. So the face a player looks at — a touch, a cup's crown, a ring's top
 * band — is a decal in the part's own tones (clarinet.css) over the solid.
 */
const f2 = (x: number) => x.toFixed(3);
/** The top of a spatula, a smooth oval. */
const ovalTop = (c: Vec3, e: Vec3, a: number, b: number, th = 0.13): Decal =>
  decal(plus(c, e, th + 0.004), norm(cross(e, Z)), [0, 0, -1], `<ellipse class="clar-top" rx="${f2(b * 0.8)}" ry="${f2(a * 0.86)}"/>`, [-b, -a, b, a]);

/** A rod through several points (a cranked lever). */
const path = (pts: Vec3[], r: number): Face[] => pts.slice(1).flatMap((p, i) => rod(pts[i], p, r, r, 8));

/** Drop the end caps of a lathe (a ring band round the wood shows no disc). */
const band = (faces: Face[]) => faces.filter((f) => f.strip);

const holeSvg = (r: number, rim = "") =>
  `<circle class="hit" r="${(r + 0.35).toFixed(2)}"/>${rim}<circle class="tonehole" r="${r}"/><circle class="dot" r="${(r + 0.06).toFixed(2)}"/>`;

export function clarinet(): Figure {
  const B = FLOAT + 6;
  const zOf = (u: number) => B + u;
  const parts: Part[] = [];
  const add = (p: Part) => parts.push(p);
  const zl = (prof: [number, number][]) => prof.map(([r, u]) => [r, zOf(u)] as [number, number]);

  // ---- Body: bell, joints, barrel (grenadilla), tenon rings (nickel silver) ----
  add(part("ebony", lathe("z", [0, 0], zl([[3.35, 0], [3.38, 0.25], [3.2, 0.5], [2.75, 1.3], [2.3, 2.4], [1.98, 3.8], [1.78, 5.5], [1.66, 7.4], [1.6, 8.8], [1.66, 9.6], [1.7, 9.9], [1.7, 11]]), 28, [1, 2, 9]), { shadow: "clar", sortFaces: true }));
  // The bell's ring and the barrel's top ring end flush with the wood: their top faces show.
  add(part("silver", lathe("z", [0, 0], zl([[1.74, 10.4], [1.74, 11]]), 28).filter((f) => f.n[2] > -0.5), { pri: 1, shadow: false, sortFaces: true }));
  add(part("ebony", lathe("z", [0, 0], zl([[RB, 11], [RB, 31]]), 24), { shadow: "clar" }));
  add(part("ebony", lathe("z", [0, 0], zl([[1.62, 31], [1.62, 32.6], [1.5, 33.1], [RB, 33.4], [RB, 52]]), 24, [1]), { shadow: "clar" }));
  add(part("silver", band(lathe("z", [0, 0], zl([[1.66, 31], [1.66, 31.5]]), 24)), { pri: 1, shadow: false }));
  add(part("ebony", lathe("z", [0, 0], zl([[1.62, 52], [1.62, 52.8], [1.55, 53.6], [1.5, 55.2], [1.55, 56.9], [1.62, 57.7], [1.62, 58.5]]), 24, [1, 5]), { shadow: "clar" }));
  add(part("silver", band(lathe("z", [0, 0], zl([[1.66, 52], [1.66, 52.45]]), 24)), { pri: 1, shadow: false }));
  add(part("silver", lathe("z", [0, 0], zl([[1.66, 58.05], [1.66, 58.5]]), 24).filter((f) => f.n[2] > -0.5), { pri: 1, shadow: false, sortFaces: true }));

  // ---- Mouthpiece, reed, ligature: the reed side turned to φ = 62 with the thumb ----
  const PR = 62, er = rad(PR), et = tng(PR);
  /** A D-section: half-width w across, f toward the beak, t to the flat table. */
  const dsec = (u: number, w: number, f: number, t: number, flat: number, n = 20): Vec3[] =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2, c = Math.cos(a);
      const y = c >= 0 ? t * Math.min(1, flat * c) : f * c;
      return plus(plus([0, 0, zOf(u)], et, w * Math.sin(a)), er, y);
    });
  add(part("ebony", loft([
    dsec(58.5, 1.36, 1.36, 1.36, 1), dsec(59.5, 1.34, 1.34, 1.0, 1.6), dsec(62.4, 1.28, 1.28, 0.98, 1.6),
    dsec(63.6, 1.2, 1.02, 0.96, 1.8), dsec(64.8, 1.08, 0.64, 0.93, 2), dsec(65.8, 0.95, 0.3, 0.9, 2.2), dsec(66.5, 0.8, 0.08, 0.88, 2.4),
  ], { caps: true }), { shadow: "clar", sortFaces: true }));
  // The reed, cane: thick at the heel, thinning through the vamp to the tip.
  const rsec = (u: number, t: number, th: number, w = 0.64): Vec3[] => [
    plus(plus([0, 0, zOf(u)], et, -w), er, t), plus(plus([0, 0, zOf(u)], et, w), er, t),
    plus(plus([0, 0, zOf(u)], et, w * 0.97), er, t + th), plus(plus([0, 0, zOf(u)], et, -w * 0.97), er, t + th),
  ];
  const reedTip = plus([0, 0, zOf(65.6)], er, 0.95);
  add(part("cane", loft([rsec(59.4, 1.0, 0.3), rsec(62.6, 0.98, 0.28), rsec(64.2, 0.95, 0.16), rsec(65.8, 0.9, 0.06), rsec(66.45, 0.88, 0.035, 0.6)], { caps: true }), {
    key: "blow", cls: "blow", pri: 0.5, shadow: false,
    decals: [decal(plus(reedTip, er, 0.12), et, [0, 0, -1], `<ellipse class="hit" rx="0.9" ry="1.3"/><ellipse class="mouth" rx="0.45" ry="0.22"/>`, [-0.9, -1.3, 0.9, 1.3])],
  }));
  // Ligature: a band shaped round mouthpiece and reed, with two screws through ears on the reed side.
  add(part("silver", loft([dsec(59.75, 1.42, 1.42, 1.4, 1.5), dsec(62.2, 1.38, 1.38, 1.36, 1.5)], { creases: [] }).filter((f) => f.strip), { pri: 1, shadow: false }));
  for (const u of [60.35, 61.6]) {
    const z = zOf(u), faces: Face[] = [];
    for (const s of [-0.5, 0.5]) faces.push(...spin(plus(plus([0, 0, z], et, s), er, 1.3), er, [[0.11, 0], [0.11, 0.42], [0.08, 0.5]], 8));
    faces.push(...rod(plus(plus([0, 0, z], et, -0.7), er, 1.62), plus(plus([0, 0, z], et, 0.62), er, 1.62), 0.05, 0.05, 8));
    faces.push(...spin(plus(plus([0, 0, z], et, 0.62), er, 1.62), et, [[0.12, 0], [0.27, 0.06], [0.27, 0.34], [0.2, 0.4], [0.2, 0.45], [0.24, 0.48], [0.24, 0.58], [0, 0.6]], 12, [1, 2, 3, 5]));
    add(part("silver", faces, { pri: 1.5, shadow: false }));
  }

  // ---- Mechanism ----
  // A post: a flanged foot screwed into the wood, a pillar, a ball head the rod's pivot screw passes through.
  const post = (phi: number, u: number, h = 0.45) =>
    add(part("silver", spin(at(phi, RB - 0.15, zOf(u)), rad(phi), [[0.22, 0], [0.22, 0.2], [0.12, 0.28], [0.12, h - 0.02], [0.17, h + 0.06], [0.17, h + 0.28], [0.14, h + 0.32]], 12, [1, 2, 4, 5]), {
      pri: 2, shadow: false,
      decals: [decal(at(phi, RB - 0.15 + h + 0.325, zOf(u)), tng(phi), [0, 0, -1], `<circle class="clar-top" r="0.15"/><path class="clar-edge" d="M-0.1 0H0.1"/>`, [-0.17, -0.17, 0.17, 0.17])],
    }));
  const chimney = (phi: number, u: number, r: number, top = 0.13) =>
    add(part("ebony", spin(at(phi, RB - 0.25, zOf(u)), rad(phi), [[r, 0], [r, 0.25 + top]], 24), { pri: 1, shadow: false }));
  const cup = (phi: number, u: number, r: number): Face[] =>
    spin(at(phi, RB - 0.02, zOf(u)), rad(phi), [[r * 0.92, 0], [r, 0.08], [r, 0.18], [r * 0.9, 0.26]], 18, [1, 2]);
  const crown = (phi: number, u: number, r: number): Decal =>
    decal(at(phi, RB + 0.245, zOf(u)), tng(phi), [0, 0, -1], `<circle class="clar-top" r="${f2(r * 0.9)}"/><circle class="clar-edge" r="${f2(r * 0.55)}"/>`, [-r, -r, r, r]);
  const holeDecal = (phi: number, u: number, r: number, lift: number, rim = "") =>
    decal(at(phi, RB + lift, zOf(u)), tng(phi), [0, 0, -1], holeSvg(r, rim), [-(r + 0.35), -(r + 0.35), r + 0.35, r + 0.35]);

  // Rings: a flat nickel band round a raised chimney, an arm out to its hinge tube.
  const RR = 0.58, LIFT = RB + 0.2;
  const ringed = (key: string, phi: number, u: number, hinge: number) => {
    chimney(phi, u, 0.42, 0.17);
    const c = at(phi, LIFT, zOf(u)), side = Math.sign(hinge - phi);
    const edge = plus(plus(c, tng(phi), side * (RR - 0.02)), rad(phi), -0.06);
    add(part("silver", [...washer(c, rad(phi), 0.46, RR, 0.12), ...rod(edge, at(hinge, RB + 0.42, zOf(u)), 0.07, 0.07, 8)], {
      key, cls: "hole", pri: 3, shadow: false, sortFaces: true, decals: [bandTop(c, rad(phi), 0.46, RR), holeDecal(phi, u, 0.3, 0.18)],
    }));
  };
  /** A hinge tube on its steel rod between two posts. */
  const hinge = (phi: number, u0: number, u1: number) => {
    post(phi, u0); post(phi, u1);
    add(part("silver", rod(at(phi, RB + 0.42, zOf(u0 + 0.17)), at(phi, RB + 0.42, zOf(u1 - 0.17)), 0.1, 0.1, 10), { pri: 2.5, shadow: false }));
  };
  /** A key: a touch, a lever through `via`, a pad cup (on its chimney) or a post at the far end. */
  const key = (k: string, t: { phi: number; u: number; a: number; b: number; lift?: number }, via: Vec3[], end?: { phi: number; u: number; r: number } | "post") => {
    const lift = t.lift ?? 0.5;
    const from = at(t.phi, RB + lift, zOf(t.u));
    const faces = spatula(from, rad(t.phi), t.a, t.b);
    const decals = [ovalTop(from, rad(t.phi), t.a, t.b)];
    const pts = [from, ...via];
    if (end && end !== "post") {
      faces.push(...cup(end.phi, end.u, end.r));
      decals.push(crown(end.phi, end.u, end.r));
      pts.push(at(end.phi, RB + 0.2, zOf(end.u)));
    }
    if (pts.length > 1) faces.push(...path(pts, 0.065));
    add(part("silver", faces, { key: k, cls: "wkey", pri: 3, shadow: false, decals }));
  };
  const lv = (phi: number, u: number, lift = 0.45) => at(phi, RB + lift, zOf(u));

  // Upper joint: L1, L2 and the thumb ringed on one hinge (player's left); L3 a plain hole.
  hinge(38, 37.3, 42.6);
  ringed("L1", 0, 41.5, 38);
  ringed("L2", 0, 38, 38);
  ringed("T", 62, 40.6, 38);
  add(part("cell", [], { key: "L3", cls: "hole", pri: 1.5, shadow: false, decals: [holeDecal(0, 35, 0.32, 0.02, `<circle class="clar-rim" r="0.42"/><circle class="clar-rim" r="0.33"/>`)] }));
  // Throat A (front, top) and G♯ (player's left), register key above the thumb.
  key("A", { phi: -6, u: 45.4, a: 0.62, b: 0.36 }, [lv(4, 46.8)], { phi: 10, u: 48.3, r: 0.42 });
  post(4, 46.8, 0.3);
  key("Gs", { phi: 28, u: 44.3, a: 0.45, b: 0.3 }, [lv(36, 45.6)], { phi: 44, u: 47.1, r: 0.38 });
  post(36, 45.6, 0.3);
  key("Reg", { phi: 66, u: 43.3, a: 0.5, b: 0.28, lift: 0.55 }, [lv(71, 46.4)], { phi: 76, u: 49.4, r: 0.34 });
  post(71, 46.4, 0.3);
  // The E♭/B♭ sliver key between L1 and L2, its pad on the player's right.
  key("Eb_Bb", { phi: -22, u: 39.7, a: 0.7, b: 0.15, lift: 0.4 }, [lv(-26, 40.9, 0.4)], { phi: -28, u: 43.4, r: 0.34 });
  post(-26, 40.9, 0.25);
  // Four side trill keys: touches in a column on the player's right, cranked levers up to their pads.
  ([["side1", 37.6, -54, 46.8], ["side2", 36.1, -50, 45.2], ["side3", 34.6, -46, 43.6], ["side4", 33.1, -42, 41.2]] as const).forEach(([k, u, ch, up]) => {
    key(k, { phi: -64, u, a: 0.42, b: 0.3, lift: 0.6 }, [lv(-58, u, 0.5), lv(ch, u, 0.45), lv(ch, up - 0.6)], { phi: ch, u: up, r: 0.34 });
    post(ch, (u + up) / 2, 0.3);
  });

  // Lower joint: R1–R3 ringed on one hinge (player's right), which ends at the joint in the bridge
  // key: its plate lies under the upper joint's bridge lever, which pivots on a post above.
  hinge(-38, 19.4, 29.6);
  add(part("silver", [...spatula(at(-38, RB + 0.36, zOf(30.55)), rad(-38), 0.45, 0.3, 0.08), ...rod(lv(-38, 29.75, 0.42), lv(-38, 30.2, 0.42), 0.08, 0.08, 8)], {
    pri: 2.4, shadow: false, decals: [ovalTop(at(-38, RB + 0.36, zOf(30.55)), rad(-38), 0.45, 0.3, 0.08)] }));
  add(part("silver", [...spatula(at(-38, RB + 0.46, zOf(31.45)), rad(-38), 0.42, 0.28, 0.08), ...rod(lv(-38, 31.8, 0.5), lv(-38, 33.6, 0.5), 0.07, 0.07, 8)], {
    pri: 2.5, shadow: false, decals: [ovalTop(at(-38, RB + 0.46, zOf(31.45)), rad(-38), 0.42, 0.28, 0.08)] }));
  post(-38, 33.8, 0.36);
  ringed("R1", 0, 26, -38);
  ringed("R2", 0, 23, -38);
  ringed("R3", 0, 20, -38);

  // The open low pads the little fingers close: E/B, F/C (front, low) and F♯/C♯ (player's left).
  const pad = (phi: number, u: number, r: number) => {
    add(part("silver", cup(phi, u, r), { pri: 2.5, shadow: false, decals: [crown(phi, u, r)] }));
  };
  pad(-2, 12.5, 0.48); // E/B
  pad(16, 14.3, 0.46); // F/C
  pad(74, 15.6, 0.44); // F♯/C♯
  // Left pinky cluster at the top of the lower joint; long rods down to the pads.
  key("LP_Cs", { phi: 38, u: 29.8, a: 0.5, b: 0.32, lift: 0.6 }, [lv(28, 29.8, 0.45), lv(26, 25.2)], { phi: 22, u: 24.45, r: 0.4 });
  key("LP_Fs", { phi: 57, u: 29.6, a: 0.48, b: 0.3, lift: 0.6 }, [lv(70, 29.4), lv(70, 16.2), lv(74, 15.9, 0.5)]);
  key("LP_E", { phi: 58, u: 27.4, a: 0.5, b: 0.32, lift: 0.6 }, [lv(62, 26.9), lv(62, 12.5), lv(14, 12.5, 0.5)]);
  key("LP_F", { phi: 40, u: 27.6, a: 0.5, b: 0.32, lift: 0.6 }, [lv(46, 27.1), lv(46, 14.3), lv(30, 14.3, 0.5)]);
  for (const [phi, u0, u1] of [[70, 17.2, 28.4], [62, 13.6, 25.8], [46, 15.3, 26.1]] as const) { post(phi, u0, 0.3); post(phi, u1, 0.3); }
  post(26, 26.4, 0.3);
  // Right pinky cluster at the foot of the lower joint.
  key("RP_Gs", { phi: -40, u: 18.4, a: 0.42, b: 0.3, lift: 0.6 }, [lv(-30, 18.4)], { phi: -22, u: 18.3, r: 0.38 });
  key("RP_F", { phi: -40, u: 15.3, a: 0.5, b: 0.32, lift: 0.6 }, [lv(-30, 15.0), lv(-3, 14.3, 0.5)]);
  key("RP_Fs", { phi: -56, u: 16.9, a: 0.48, b: 0.3, lift: 0.6 }, [lv(-66, 16.9), lv(-74, 16.0)], "post");
  key("RP_E", { phi: -56, u: 14.5, a: 0.5, b: 0.32, lift: 0.6 }, [lv(-44, 13.2), lv(-18, 12.5, 0.5)]);
  post(-74, 16.0, 0.3);
  post(-30, 16.7, 0.3);

  const at0: Vec3 = [10, 12, 0];
  const placed = translate(parts, at0);
  return {
    kind: "clarinet",
    parts: placed,
    size: [20, 24, zOf(66.5)],
    light: woodwindLight(CLARINET),
    pitchOf: woodwindPitch(CLARINET),
    focus: { min: [at0[0] - 4, at0[1] - 4, zOf(11)], max: [at0[0] + 4, at0[1] + 4, zOf(50)] },
  };
}
