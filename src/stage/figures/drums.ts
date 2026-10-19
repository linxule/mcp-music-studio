/**
 * @file Stage figures: the drum kit (GM channel 10).
 *
 * A standard five-piece kit as a drummer sets it up, built the way it is made
 * (1 unit = 1 cm). The player sits at +y and faces −y, so their right hand is
 * at −x: hi-hat and crash on the left (+x), floor tom and ride on the right
 * (−x), the kick in the middle with its batter head toward the throne.
 *
 * Dimensions (cm; drums are diameter × depth in inches as sold):
 *
 *   piece          size            here                              placed (centre)
 *   kick           22 × 18"        Ø55.9 × 45.7, wood hoops 1.1×2.8   x 80, axis y 14.6..62.4, on its hoops
 *   rack tom 1     10 × 8"         Ø25.4 × 20.3, 6 lugs               (99, 44), z 61..81, tilted 10° to player
 *   rack tom 2     12 × 9"         Ø30.5 × 22.9, 6 lugs               (60, 44), z 59..82, tilted 10°
 *   floor tom      16 × 16"        Ø40.6 × 40.6, 8 × 2 lugs, 3 legs   (24, 84), z 20..61
 *   snare          14 × 5.5"       Ø35.6 × 14.0, 10 lugs, strainer    (104, 86), z 54..68 (top ≈ seated waist)
 *   hi-hat         14"             Ø35.6, bell Ø11, 1.4 apart         (136, 82), z 85..87 (above the snare)
 *   crash          18"             Ø45.7, bell Ø12                    (122, 26), z 125, tilted 14°
 *   ride           20"             Ø50.8, bell Ø15                    (34, 42), z 100, tilted 10°
 *   woodblock      7 × 2.4 × 2"    18 × 6 × 5 on a hoop-clamp arm     (121, 16), z 63..68
 *   throne         Ø36 seat        top z 54, tripod Ø56               (78, 124)
 *   kick pedal     footboard 23×8  posts 18, beater Ø6 felt           x 76..88, y 62..92
 *   Heads sit 1.0–1.1 below their hoop's top; steel hoops 0.5 thick, 2.6–2.8 tall.
 *   Hoop ears: rods 0.95 out from the shell, lugs 1.9 deep. No exaggeration: the
 *   kit is all playing surface and reads at true size; only the hoop bevels
 *   (0.15) and the woodblock slot are drawn a little bolder than life.
 *
 * Parts (≈95), in the order a drum tech assembles the kit:
 *   kick: shell+hoops+heads (one turned solid), 8 tension positions (front and
 *   back lugs, rods, claw bodies), 8 batter-side claw lips + T-rods, 8 front
 *   ones, port hole and beater patch (decals), air vent, 2 spurs;
 *   tom holder: base plate, post, clamp collar, 2 L-arms with ball joints;
 *   toms: shell+hoops+heads, 6 tension positions each (lug, top and bottom
 *   rods, washers, rod heads), mount bracket;
 *   floor tom: shell+hoops+heads, 8 positions with two lugs, 3 leg brackets,
 *   legs with eye bolts and rubber feet;
 *   snare: shell+hoops+heads, 10 positions, strainer with throw-off lever and
 *   knob, snare cord, butt plate, vent;
 *   cymbals: bow-and-bell turned profiles with tonal grooves and the centre
 *   hole; hi-hat: top (bell up) and bottom (bell down) cymbals, clutch with
 *   felts, nuts and wing screw, pull rod, cup seat;
 *   woodblock: block with slots, holder, arm, hoop clamp;
 *   pedal: base plate, heel plate and hinge, footboard, two posts, bearings,
 *   axle, sprocket, chain, spring and rocker, beater hub, shaft, felt beater;
 *   throne: cushion, seat plate, inner and outer column, memory lock and knob,
 *   hub, lower collar, 3 legs, 3 braces, 3 rubber feet.
 *
 * Sources: Mapex Storm 5-piece spec (22×18, 16×16, 14×5.5 standard sizes),
 * https://citraintirama.com/products/mapex-storm-st5255-biz ; PP Drums 5-piece
 * (lug counts per drum), https://www.pmtonline.co.uk/pp-drums-full-size-5-piece-drum-kit-black ;
 * parts of a kit, https://www.adorama.com/alc/parts-of-a-drum-kit ; setup
 * heights (snare at the waist, hi-hat above the snare, crash 25–35 cm over
 * the ride), https://www.sagemusic.co/blog/ready-set-drum-how-to-set-up-a-drum-set/ .
 * Cymbal bell and bow heights are inferred from common catalogue profiles.
 *
 * Depth: every drum is one non-convex turned solid (`sortFaces`); hardware
 * around it is split per tension position, `pri` above the drum on the half
 * that faces the viewer (turn 0) and below it on the far half; anything that
 * sticks out past a hoop's face (claw lips, T-rods) is its own part, separated
 * from the drum on that axis.
 */
import { decal, part, rod, rotate, rotation, type Axis, type Face, type Part, type Vec3 } from "../iso";
import { type Figure } from "./common";
import "./drums.css";

/** General MIDI drum notes → the piece that sounds them. */
export function drumPiece(pitch: number): string {
  if (pitch === 35 || pitch === 36) return "kick";
  if (pitch === 37 || pitch === 38 || pitch === 39 || pitch === 40) return "snare";
  if (pitch === 42 || pitch === 44 || pitch === 46) return "hat";
  if (pitch === 41 || pitch === 43) return "ftom";
  if (pitch === 45 || pitch === 47) return "tom2";
  if (pitch === 48 || pitch === 50) return "tom1";
  if (pitch === 49 || pitch === 52 || pitch === 55 || pitch === 57) return "crash";
  if (pitch === 51 || pitch === 53 || pitch === 59) return "ride";
  return "block";
}

/** What a pressed piece plays. */
export const PIECE_PITCH: Record<string, number> = {
  kick: 36, snare: 38, hat: 42, ftom: 41, tom2: 45, tom1: 48, crash: 49, ride: 51, block: 76,
};

// -----------------------------------------------------------------------------
// Turned solids with true normals
// -----------------------------------------------------------------------------

type P2 = readonly [number, number];
const RAD = Math.PI / 180;

/** A point at radius r, angle θ (degrees) round an axis through c, at s along it. */
function at(axis: Axis, c: P2, r: number, deg: number, s: number): Vec3 {
  const p = c[0] + Math.cos(deg * RAD) * r, q = c[1] + Math.sin(deg * RAD) * r;
  return axis === "z" ? [p, q, s] : axis === "y" ? [p, s, q] : [s, p, q];
}

const unitOf = (axis: Axis): Vec3 => (axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1]);

let revId = 7_000_000;

/**
 * A surface of revolution whose normals come from the profile's direction:
 * walk the half-section `[r, s]` with the solid on the left (outward along
 * the bottom, up the outside, inward across the top) and every face points out
 * — including faces the engine's lathe cannot make: the inside of a hoop's
 * collar, a hi-hat's concave top. Rings listed in `creases` are inked;
 * segments in `quiet` never ink their rims (a head inside its collar: its
 * edge is inked by the collar's far half only); segments in `nearOnly` ink
 * only the half that faces the default view (a ledge hidden behind its shell).
 */
function rev(axis: Axis, c: P2, prof: readonly P2[], n = 20, creases: readonly number[] = [], quiet: readonly number[] = [], nearOnly: readonly number[] = []): Face[] {
  const A = unitOf(axis);
  const faces: Face[] = [];
  const rings = prof.map(([r, s]) => Array.from({ length: n }, (_, i) => at(axis, c, r, (i / n) * 360, s)));
  for (let k = 0; k + 1 < prof.length; k++) {
    const [ra, sa] = prof[k], [rb, sb] = prof[k + 1];
    if (ra === 0 && rb === 0) continue;
    const dr = rb - ra, ds = sb - sa;
    const id = ++revId;
    const rims = quiet.includes(k) ? 0 : (creases.includes(k) ? 1 : 0) | (creases.includes(k + 1) ? 2 : 0);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const mid = ((i + 0.5) / n) * 360;
      const rad = at(axis, [0, 0], 1, mid, 0);
      const r = nearOnly.includes(k) && rad[0] + rad[1] + rad[2] <= 0 ? 0 : rims;
      const v: Vec3 = [rad[0] * ds - A[0] * dr, rad[1] * ds - A[1] * dr, rad[2] * ds - A[2] * dr];
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      faces.push({ n: [v[0] / l, v[1] / l, v[2] / l], pts: [rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]], strip: [id, i, n, r] });
    }
  }
  return faces;
}

/** A plain turned piece on an off-axis centre: a lug casing, a washer, a foot. */
const knob = (axis: Axis, c: P2, prof: readonly P2[], n = 8) => rev(axis, c, prof, n, [1, prof.length - 2]);

/** Centre of something at radius r, angle θ round c (the cross-axis pair). */
const offC = (c: P2, r: number, deg: number): P2 => [c[0] + Math.cos(deg * RAD) * r, c[1] + Math.sin(deg * RAD) * r];

/** Does this direction face the viewer of the default view (turn 0)? */
const facesUs = (v: Vec3) => v[0] + v[1] + v[2] > 0;

/** A block standing off a round body: radially r0..r1, w wide, s0..s1 along the axis (a lug, a rod's square head). */
function blockAt(axis: "y" | "z", c: P2, r0: number, r1: number, deg: number, s0: number, s1: number, w: number): Face[] {
  if (axis === "z") return rotate(boxF(c[0] + r0, c[1] - w / 2, s0, c[0] + r1, c[1] + w / 2, s1), "z", deg, [c[0], c[1], 0]);
  return rotate(boxF(c[0] + r0, s0, c[1] - w / 2, c[0] + r1, s1, c[1] + w / 2), "y", -deg, [c[0], 0, c[1]]);
}

/** A capsule casing from s0 to s1, radius w (a tube lug, a leg bracket). */
const capsule = (w: number, s0: number, s1: number): P2[] => [
  [0, s0], [w * 0.6, s0 + 0.08], [w, s0 + w * 0.6], [w, s1 - w * 0.6], [w * 0.6, s1 - 0.08], [0, s1],
];

/**
 * A drum: shell, two hoops and two heads as one turned solid, from a0 to a1
 * along the axis (hoop face to hoop face). The head at a1 (the batter head
 * the viewer sees) sits `col` inside its hoop, so the collar shows; the head
 * at a0 (bottom, or the kick's front) is never seen from the player's side
 * and is drawn flush — an inset there would show its collar's far wall
 * through the shell.
 */
function drumShell(axis: Axis, c: P2, R: number, a0: number, a1: number, hw: number, ht: number, col: number, n = 22): Face[] {
  const Ri = R + 0.15, Rh = Ri + ht, b = 0.15;
  const prof: P2[] = [
    [0, a0], [Ri, a0], [Rh, a0 + b], [Rh, a0 + hw], [R, a0 + hw + b],
    [R, a1 - hw - b], [Rh, a1 - hw], [Rh, a1 - b], [Ri, a1], [Ri, a1 - col], [0, a1 - col],
  ];
  // The lower hoop's ledge faces up all round, but its far half is behind the shell.
  return rev(axis, c, prof, n, [2, 3, 4, 5, 6, 7, 8, 9], [0, 9], [1, 2, 3]);
}

/**
 * A cymbal's top: lathe-turned bow rising to a bell, edge at s = 0 (or, for a
 * hi-hat's bottom cymbal, `down`: bell hanging below, concave side up). The
 * edge has a thin bevel underneath so it reads as metal, not paper.
 */
function cymbalFaces(c: P2, R: number, bellR: number, bellH: number, bowH: number, z: number, down = false): Face[] {
  const k = down ? -1 : 1;
  // The bottom hi-hat shows only its rim under the top one: the rest is a plain dish.
  if (down) return rev("z", c, [[R - 0.7, z - 0.32], [R, z - 0.16], [R, z], [R * 0.86, z - bowH * 0.25], [0, z - bowH * 0.6]], 22, [1, 2]);
  const prof: P2[] = [
    [R - 0.7, z - 0.32], [R, z - k * 0.16], [R, z],
    [R * 0.86, z + k * bowH * 0.25], [R * 0.62, z + k * bowH * 0.6],
    [bellR * 1.15, z + k * bowH * 0.95], [bellR, z + k * bowH],
    [bellR * 0.85, z + k * (bowH + bellH * 0.7)], [bellR * 0.45, z + k * (bowH + bellH)], [0, z + k * (bowH + bellH * 1.02)],
  ];
  return rev("z", c, prof, 22, [1, 2, 6]);
}

/** Height of a cymbal's top surface at radius r (for the tonal grooves). */
function bowAt(R: number, bowH: number, r: number) {
  const t = (R - r) / R; // 0 at the edge
  return bowH * Math.min(1, t * 1.9 - t * t * 0.9);
}

// -----------------------------------------------------------------------------
// The kit
// -----------------------------------------------------------------------------

export function drumKit(): Figure {
  const parts: Part[] = [];
  const push = (...ps: Part[]) => parts.push(...ps);

  // ---------------------------------------------------------------- kick
  {
    const R = 27.94, ht = 1.1, hw = 2.8, col = 1.0;
    const Rh = R + 0.15 + ht;
    const cx = 80, cz = Rh; // resting on its hoops
    const C: P2 = [cx, cz];
    const a0 = 14.6, a1 = 62.4;
    const portSvg = `<circle class="cuphole" cx="-12" cy="10" r="6.2"/><circle class="kd-ring" cx="-12" cy="10" r="6.9"/>`;
    const patchSvg = `<circle class="kd-patch" cx="1.8" cy="-8.8" r="4.6"/>`;
    push(part("shell", drumShell("y", C, R, a0, a1, hw, ht, col, 28), {
      key: "d:kick", cls: "kit", sortFaces: true, shadow: "kick",
      decals: [
        // Port hole in the resonant (front) head, toward the audience.
        decal([cx, a0, cz], [-1, 0, 0], [0, 0, -1], portSvg),
        // Impact patch where the beater lands on the batter head.
        decal([cx, a1 - col, cz], [1, 0, 0], [0, 0, -1], patchSvg),
      ],
    }));
    const Rr = Rh + 0.55; // tension rods run just outside the wood hoop
    for (let k = 0; k < 8; k++) {
      const th = 22.5 + k * 45;
      const out = at("y", [0, 0], 1, th, 0);
      const vis = facesUs(out);
      const reach = out[0] + out[1] + out[2]; // < −0.55: behind the kick, never seen
      const lug = (s0: number, s1: number) => blockAt("y", C, R - 0.05, R + 2.2, th, s0, s1, 1.8);
      const f: Face[] = [
        ...lug(a0 + 6.5, a0 + 11.5), ...lug(a1 - 11.5, a1 - 6.5),
        ...rod(at("y", C, Rr, th, a0 + 6.8), at("y", C, Rr, th, a0 + hw + 0.2), 0.3, 0.3, 6),
        ...rod(at("y", C, Rr, th, a1 - 6.8), at("y", C, Rr, th, a1 - hw - 0.2), 0.3, 0.3, 6),
        // Claw bodies hugging the hoop's outer wall.
        ...rod(at("y", C, Rr, th, a0 + hw + 0.2), at("y", C, Rr, th, a0), 0.5, 0.5, 6),
        ...rod(at("y", C, Rr, th, a1 - hw - 0.2), at("y", C, Rr, th, a1), 0.5, 0.5, 6),
      ];
      if (reach > -0.55) push(part("chrome", f, { pri: vis ? 0.5 : -0.5, shadow: "kick" }));
      // Past each hoop face: the claw's lip over the hoop and the T-rod's handle.
      for (const [face, dir] of [[a1, 1], [a0, -1]] as const) {
        if (dir < 0 && !vis) continue;
        const tip: Face[] = [
          ...rod(at("y", C, Rr + 0.3, th, face + dir * 0.25), at("y", C, Rh - 0.8, th, face + dir * 0.25), 0.25, 0.25, 6),
          ...rod(at("y", C, Rr, th, face), at("y", C, Rr, th, face + dir * 1.9), 0.3, 0.3, 6),
          ...rod(at("y", C, Rr, th - 3.4, face + dir * 1.9), at("y", C, Rr, th + 3.4, face + dir * 1.9), 0.38, 0.38, 6),
        ];
        push(part("chrome", tip, { pri: 1, shadow: false }));
      }
    }
    // Air vent on the shell, upper right.
    push(part("chrome", rod(at("y", C, R - 0.1, 50, 40), at("y", C, R + 0.35, 50, 40), 0.9, 0.9, 12), { pri: 0.6, shadow: false }));
    // Spurs: brackets on the shell's sides, legs down and forward to the floor.
    for (const side of [0, 180]) {
      const sx = side === 0 ? 1 : -1;
      const f: Face[] = [
        ...knob("y", offC(C, R + 1.2, side), capsule(1.2, a0 + 5, a0 + 10)),
        ...rod([cx + sx * (R + 1.3), a0 + 7.5, cz + 1], [cx + sx * (R + 11), a0 + 2, 1.2], 0.6, 0.6, 8),
        ...knob("z", [cx + sx * (R + 11), a0 + 2], [[0, 0], [1.1, 0], [1.1, 1.0], [0.7, 1.9], [0, 1.9]]),
      ];
      push(part("chrome", f, { pri: side === 0 ? 0.5 : -0.5, shadow: "spur" + side }));
    }

    // ------------------------------------------------------------ pedal
    const py = a1; // the pedal's frame stands against the batter hoop
    const plate = boxF;
    push(part("chrome", plate(73.5, py, 0, 88.5, py + 4.6, 0.7), { pri: 0, shadow: "pedal" })); // base plate
    push(part("chrome", plate(74.6, py + 4.6, 0, 85.4, py + 30, 0.5), { pri: 0, shadow: "pedal" })); // base rails
    push(part("chrome", plate(75.2, py + 25.6, 0.5, 84.8, py + 30, 2.4), { pri: 0.2, shadow: "pedal" })); // heel plate
    push(part("chrome", rev("x", [py + 27.2, 2.4], [[0, 75.6], [0.6, 75.6], [0.6, 84.4], [0, 84.4]], 8, [1, 2]), { pri: 0.3, shadow: false })); // hinge
    // Footboard, toe raised on the chain.
    const board: P2[] = [[py + 27.6, 2.2], [py + 5, 9.4], [py + 4.4, 10.1], [py + 4.6, 10.9], [py + 27.8, 3.1]];
    push(part("chrome", prismX(board, 76, 84), { key: "d:kick", cls: "kit", pri: 0.5, shadow: "pedal" }));
    // Posts, bearings, axle.
    for (const x of [74.4, 86.6]) {
      push(part("chrome", [
        ...knob("z", [x, py + 2.3], [[0, 0.7], [1.0, 0.7], [0.85, 1.6], [0.85, 17.6], [0, 17.6]], 8),
        ...knob("x", [py + 2.3, 19], [[0, x - 1.3], [1.5, x - 1.3], [1.5, x + 1.3], [0, x + 1.3]], 10),
      ], { pri: 0.4, shadow: "pedal" }));
    }
    push(part("chrome", knob("x", [py + 2.3, 19], [[0, 75.7], [0.5, 75.7], [0.5, 85.3], [0, 85.3]], 8), { pri: 0.45, shadow: false }));
    // Sprocket and the chain down to the toe.
    push(part("chrome", [
      ...knob("x", [py + 2.3, 19], [[0, 78.6], [2.5, 78.6], [2.5, 80.4], [0, 80.4]], 14),
      ...rod([79.5, py + 4.8, 19], [79.5, py + 4.9, 10.4], 0.42, 0.42, 6),
    ], { pri: 0.6, shadow: false }));
    // Spring on the right post, hooked to a rocker on the axle's end.
    push(part("chrome", [
      ...rod([87.9, py + 2.3, 19], [88.4, py + 3.6, 16.8], 0.35, 0.35, 6),
      ...rod([88.4, py + 3.6, 16.8], [88.4, py + 3.6, 5.5], 0.62, 0.62, 8),
      ...knob("z", [88.4, py + 3.6], [[0, 2.6], [0.9, 2.6], [0.9, 5.5], [0, 5.5]], 8),
    ], { pri: 0.6, shadow: false }));
    // Beater: hub on the axle, shaft up to a felt head against the batter head.
    const bx = 82;
    push(part("chrome", [
      ...knob("x", [py + 2.3, 19], [[0, 80.8], [1.2, 80.8], [1.2, 83.2], [0, 83.2]], 10),
      ...rod([bx, py + 2.1, 20], [bx, a1 - col + 2, 35.1], 0.4, 0.4, 6),
    ], { pri: 0.7, shadow: false }));
    push(part("felt", rev("y", [bx, 38], [[0, a1 - col], [2.6, a1 - col], [3.0, a1 - col + 0.4], [3.0, a1 - col + 3.6], [2.6, a1 - col + 4], [0, a1 - col + 4]], 14, [1, 2, 3, 4]),
      { key: "d:kick", cls: "kit", pri: 2, shadow: false }));

    // ------------------------------------------------------------ tom holder
    const post: Vec3 = [80, 44, 0];
    push(part("chrome", [
      ...knob("z", [post[0], post[1]], [[0, cz + R - 0.25], [3.6, cz + R - 0.25], [3.6, cz + R + 0.6], [1.6, cz + R + 1.3], [0, cz + R + 1.3]], 14),
    ], { pri: 1, shadow: false }));
    push(part("chrome", [
      ...knob("z", [post[0], post[1]], [[0, cz + R + 1.3], [1.1, cz + R + 1.3], [1.1, 64.5], [1.7, 64.8], [1.7, 67.2], [0, 67.4]], 10),
      ...rod([80, 44, 66], [83.4, 44, 66], 0.35, 0.35, 6), // clamp's T-screw
      ...knob("x", [44, 66], [[0, 83.4], [0.8, 83.4], [0.8, 84.2], [0, 84.2]], 6),
    ], { pri: 1, shadow: false }));
  }

  // ---------------------------------------------------------------- z-axis drums
  type ZDrum = {
    key: string; cx: number; cy: number; R: number; z0: number; z1: number;
    lugs: number; hw: number; col: number; tilt?: number; two?: boolean;
  };
  /** A drum standing on its axis, with its tension hardware; returns its tilt. */
  const zDrum = (d: ZDrum, extra: (C: P2, mid: number) => { faces: Face[]; vis: boolean; mat?: string; cls?: string }[] = () => []) => {
    const C: P2 = [d.cx, d.cy];
    const mid = (d.z0 + d.z1) / 2;
    const pivot: Vec3 = [d.cx, d.cy, mid];
    const tilt = (f: Face[]) => (d.tilt ? rotate(f, "x", -d.tilt, pivot) : f);
    const ht = 0.5, Rh = d.R + 0.15 + ht;
    push(part("shell", tilt(drumShell("z", C, d.R, d.z0, d.z1, d.hw, ht, d.col)), { key: d.key, cls: "kit", sortFaces: true, shadow: d.key }));
    const Rr = d.R + 0.95;
    for (let k = 0; k < d.lugs; k++) {
      const th = ((k + 0.5) * 360) / d.lugs;
      const out = at("z", [0, 0], 1, th, 0);
      const vis = facesUs(out);
      const far = out[0] + out[1] < -0.55; // only its rod head shows, above the far hoop
      const lc = offC(C, d.R + 0.95, th);
      const lugA = d.two ? [d.z1 - 9.5, d.z1 - 5] : [mid - 2.6, mid + 2.6];
      const lugB = d.two ? [d.z0 + 5, d.z0 + 9.5] : lugA;
      // Top: washer on the hoop's ear and the rod head (these show above the far rim too).
      const head: Face[] = [
        ...knob("z", lc, [[0, d.z1 - 1.05], [0.8, d.z1 - 1.05], [0.8, d.z1 - 0.8], [0, d.z1 - 0.8]], 6),
        ...blockAt("z", C, Rr - 0.42, Rr + 0.42, th, d.z1 - 0.8, d.z1 + 0.2, 0.84),
      ];
      const lug = (s0: number, s1: number) => blockAt("z", C, d.R - 0.05, d.R + 1.9, th, s0, s1, 1.5);
      const f: Face[] = far ? head : [
        ...lug(lugA[0], lugA[1]),
        ...(d.two ? lug(lugB[0], lugB[1]) : []),
        // Rod from the lug up through the hoop's ear.
        ...rod(at("z", C, Rr, th, lugA[1]), at("z", C, Rr, th, d.z1 - 1.05), 0.27, 0.27, 5),
        ...head,
        // Bottom: the same, hanging under the resonant hoop.
        ...(vis ? [
          ...rod(at("z", C, Rr, th, lugB[0]), at("z", C, Rr, th, d.z0 + 1.05), 0.27, 0.27, 5),
          ...knob("z", lc, [[0, d.z0 + 0.8], [0.8, d.z0 + 0.8], [0.8, d.z0 + 1.05], [0, d.z0 + 1.05]], 6),
          ...blockAt("z", C, Rr - 0.42, Rr + 0.42, th, d.z0 - 0.2, d.z0 + 0.8, 0.84),
        ] : []),
      ];
      push(part("chrome", tilt(f), { pri: vis ? 0.5 : -0.5, shadow: false }));
    }
    for (const x of extra(C, mid)) push(part(x.mat ?? "chrome", tilt(x.faces), { pri: x.vis ? 0.6 : -0.6, shadow: false, ...(x.cls ? { cls: x.cls } : {}) }));
    return { tiltPt: (p: Vec3) => (d.tilt ? rotation("x", -d.tilt, pivot).point(p) : p), Rh };
  };

  // Rack toms on the holder: brackets facing the post, arms with ball joints.
  const arm = (from: Vec3, to: Vec3, vis: boolean) =>
    push(part("chrome", [
      ...rod(from, [from[0], from[1], to[2]], 0.75, 0.75, 8),
      ...rod([from[0], from[1], to[2]], to, 0.75, 0.75, 8),
      ...rev("z", [to[0], to[1]], [[0, to[2] - 1.15], [0.8, to[2] - 0.85], [1.15, to[2]], [0.8, to[2] + 0.85], [0, to[2] + 1.15]], 10, []),
    ], { pri: vis ? 0.7 : -0.7, shadow: false }));
  for (const t of [
    { key: "d:tom1", cx: 99, R: 12.7, z0: 61, z1: 81.3, side: 180 },
    { key: "d:tom2", cx: 60, R: 15.24, z0: 59.4, z1: 82.3, side: 0 },
  ]) {
    const mid = (t.z0 + t.z1) / 2;
    const { tiltPt } = zDrum({ key: t.key, cx: t.cx, cy: 44, R: t.R, z0: t.z0, z1: t.z1, lugs: 6, hw: 2.6, col: 1.05, tilt: 10 }, (C) => [{
      vis: facesUs(at("z", [0, 0], 1, t.side, 0)),
      faces: [
        ...knob("z", offC(C, t.R + 0.9, t.side), [[0, mid - 3], [0.9, mid - 3], [1.3, mid - 2.4], [1.3, mid + 2.4], [0.9, mid + 3], [0, mid + 3]], 10),
        ...rod(at("z", C, t.R + 2.1, t.side, mid), at("z", C, t.R + 3.3, t.side, mid), 0.55, 0.55, 8),
      ],
    }]);
    const end = tiltPt(at("z", [t.cx, 44], t.R + 4.4, t.side, mid));
    arm([80 + (t.side === 0 ? -1.4 : 1.4), 44, 66], end, t.side === 0);
  }

  // Floor tom: two lugs a side, three legs from brackets on the shell.
  {
    const R = 20.32, cx = 24, cy = 84, z0 = 20, z1 = 61;
    zDrum({ key: "d:ftom", cx, cy, R, z0, z1, lugs: 8, hw: 2.8, col: 1.1, two: true }, (C) => [45, 165, 285].map((th) => {
      const zb = z1 - 11;
      const foot = at("z", C, R + 9, th, 1.3);
      const top = at("z", C, R + 1.3 - (7.7 / (zb - 1.3)) * 4, th, zb + 4);
      return {
        vis: facesUs(at("z", [0, 0], 1, th, 0)),
        faces: [
          ...rod(top, foot, 0.64, 0.64, 8),
          ...knob("z", offC(C, R + 1.3, th), [[0, zb - 2.6], [1.0, zb - 2.6], [1.45, zb - 2], [1.45, zb + 2], [1.0, zb + 2.6], [0, zb + 2.6]], 10),
          ...rod(at("z", C, R + 2.6, th + 4, zb), at("z", C, R + 4.2, th + 10, zb), 0.35, 0.35, 6),
          ...knob("z", [foot[0], foot[1]], [[0, 0], [1.2, 0], [1.2, 1.3], [0.75, 2.4], [0, 2.4]], 8),
        ],
      };
    }));
  }

  // Snare between the knees, strainer on the player's side.
  {
    const R = 17.78, cx = 104, cy = 86, z0 = 54, z1 = 68;
    const mid = (z0 + z1) / 2;
    zDrum({ key: "d:snare", cx, cy, R, z0, z1, lugs: 10, hw: 2.8, col: 1.1 }, (C) => {
      const sth = 72, bth = 252;
      const block = (th: number, h0: number, h1: number, w: number, d: number) =>
        rotate(boxF(cx + R - 0.1, cy - w / 2, h0, cx + R + d, cy + w / 2, h1), "z", th, [cx, cy, 0]);
      return [
        {
          vis: true,
          faces: [
            ...block(sth, mid - 3, mid + 3, 3.4, 1.9),
            // Throw-off lever, up and along the shell.
            ...rod(at("z", C, R + 2.2, sth - 4, mid - 1), at("z", C, R + 2.4, sth + 6, mid + 3.6), 0.4, 0.3, 6),
            // Tension knob on top of the strainer.
            ...knob("z", offC(C, R + 1.1, sth), [[0, mid + 3], [0.75, mid + 3], [0.75, mid + 4.4], [0.6, mid + 4.6], [0, mid + 4.6]], 10),
            // Snare cord from the strainer down under the bottom hoop to the wires.
            ...rod(at("z", C, R + 1.0, sth, mid - 3), at("z", C, R + 1.0, sth, z0 - 0.4), 0.3, 0.3, 5),
            ...rod(at("z", C, R + 1.0, sth, z0 - 0.4), at("z", C, R - 6, sth, z0 - 0.4), 0.3, 0.3, 5),
          ],
        },
        { vis: false, faces: block(bth, mid - 2, mid + 2, 3, 1.4) },
        { vis: true, faces: rod(at("z", C, R - 0.1, 126, mid), at("z", C, R + 0.3, 126, mid), 0.75, 0.75, 12) },
      ];
    });
  }

  // ---------------------------------------------------------------- cymbals
  const grooves = (cx: number, cy: number, z: number, R: number, bowH: number, radii: number[], tf: (p: Vec3) => Vec3) =>
    radii.map((r) => ({
      cls: "kd-groove",
      pts: Array.from({ length: 41 }, (_, i) => tf([cx + Math.cos((i / 40) * Math.PI * 2) * r, cy + Math.sin((i / 40) * Math.PI * 2) * r, z + bowAt(R, bowH, r)])),
    }));
  const cym = (key: string, cx: number, cy: number, z: number, R: number, bellR: number, bellH: number, bowH: number, tilt: number) => {
    const pivot: Vec3 = [cx, cy, z];
    const f = rotation("x", -tilt, pivot);
    const top: Vec3 = [cx, cy, z + bowH + bellH * 1.02];
    push(part("bronze", rotate(cymbalFaces([cx, cy], R, bellR, bellH, bowH, z), "x", -tilt, pivot), {
      key, cls: "cym", pri: 3, shadow: key,
      strokes: grooves(cx, cy, z, R, bowH, [R * 0.55, R * 0.66, R * 0.77, R * 0.88, R * 0.95], f.point),
      decals: [decal(f.point(top), f.dir([1, 0, 0]), f.dir([0, 1, 0]), `<circle class="cuphole" cx="0" cy="0" r="0.65"/>`, [-0.7, -0.7, 0.7, 0.7])],
    }));
  };
  cym("d:crash", 122, 26, 125, 22.86, 6.1, 2.4, 2.7, 14);
  cym("d:ride", 34, 42, 100, 25.4, 7.6, 2.9, 3.3, 10);

  // Hi-hat: the top cymbal bell up, the bottom one bell down, 1.4 apart;
  // clutch on the pull rod above, the cup seat and the rod's end below.
  {
    const cx = 136, cy = 82, R = 17.78, zt = 87, zb = 85.6;
    const id = (p: Vec3) => p;
    push(part("bronze", cymbalFaces([cx, cy], R, 5.5, 2.2, 1.5, zt), {
      key: "d:hat", cls: "cym", pri: 3, shadow: "hat",
      strokes: grooves(cx, cy, zt, R, 1.5, [R * 0.6, R * 0.72, R * 0.84, R * 0.94], id),
    }));
    push(part("bronze", cymbalFaces([cx, cy], R, 5.5, 2.2, 1.5, zb, true), { key: "d:hat", cls: "cym", pri: 2.9, shadow: "hat" }));
    const top = zt + 1.5 + 2.2 * 1.02;
    push(part("chrome", [
      ...knob("z", [cx, cy], [[0, top], [1.7, top], [1.7, top + 0.6], [0, top + 0.6]], 8), // felt
      ...knob("z", [cx, cy], [[0, top + 0.6], [1.3, top + 0.6], [1.3, top + 1.0], [1.0, top + 1.1], [1.0, top + 3.0], [1.3, top + 3.1], [1.3, top + 3.6], [0, top + 3.6]], 8),
      ...rod([cx, cy, top + 2.0], [cx + 2.6, cy, top + 2.0], 0.3, 0.3, 6),
      ...rod([cx + 2.6, cy - 0.9, top + 2.0], [cx + 2.6, cy + 0.9, top + 2.0], 0.45, 0.45, 6),
      ...rod([cx, cy, top + 3.6], [cx, cy, top + 9.5], 0.4, 0.4, 8),
      ...knob("z", [cx, cy], [[0, top + 9.5], [0.55, top + 9.5], [0.55, top + 10.1], [0, top + 10.3]], 8),
    ], { pri: 3.2, shadow: false }));
    const bot = zb - 1.5 - 2.2 * 1.02;
    push(part("chrome", [
      ...knob("z", [cx, cy], [[0, bot - 0.6], [1.9, bot - 0.6], [1.9, bot], [0, bot]], 8),
      ...knob("z", [cx, cy], [[0, bot - 3.4], [1.0, bot - 3.4], [2.3, bot - 0.9], [2.3, bot - 0.6], [0, bot - 0.6]], 8),
      ...rod([cx, cy, bot - 3.4], [cx, cy, bot - 11], 0.4, 0.4, 8),
      ...knob("z", [cx, cy], [[0, bot - 11.6], [0.6, bot - 11.4], [0.6, bot - 11], [0, bot - 11]], 8),
    ], { pri: 2.8, shadow: false }));
  }

  // ---------------------------------------------------------------- woodblock
  {
    // On a bass-drum hoop mount: clamp on the front hoop, arm up, cradle under the block.
    const x0 = 112, x1 = 130, y0 = 13, y1 = 19, z0 = 63, z1 = 68;
    const slot = (w: number) => `<rect class="cuphole" x="1.6" y="1.1" width="${w}" height="0.55" rx="0.27"/>`;
    push(part("wood", boxF(x0, y0, z0, x1, y1, z1), {
      key: "d:block", cls: "kit", pri: 1, shadow: "block",
      decals: [
        decal([x0, y1, z1], [1, 0, 0], [0, 0, -1], slot(x1 - x0 - 3.2)),
        decal([x0, y0, z1], [1, 0, 0], [0, 0, -1], slot(x1 - x0 - 3.2)),
      ],
    }));
    const clamp = at("y", [80, 29.15], 29.15 + 0.3, 42, 16);
    push(part("chrome", [
      ...boxF(x0 + 4, y0 + 1.5, z0 - 1.2, x1 - 4, y1 - 1.5, z0),
      ...rod([121, 16, z0 - 1.2], [121, 16, z0 - 4], 0.5, 0.5, 8),
      ...rod([121, 16, z0 - 4], [clamp[0] + 1.2, 16, clamp[2] + 1.0], 0.6, 0.6, 8),
      ...knob("y", [clamp[0], clamp[2]], [[0, 13.2], [1.6, 13.2], [1.6, 18.4], [0, 18.4]], 8),
    ], { pri: 0.8, shadow: false }));
  }

  // ---------------------------------------------------------------- throne
  {
    const cx = 78, cy = 124;
    const C: P2 = [cx, cy];
    push(part("seat", rev("z", C, [[0, 45.6], [14.5, 45.6], [17.2, 46.6], [18, 49], [17.6, 51.8], [15.4, 53.6], [9, 54.2], [0, 54.3]], 20, [1]), {
      pri: 2, shadow: "throne",
      strokes: [{ cls: "kd-welt", pts: Array.from({ length: 21 }, (_, i) => at("z", C, 18.03, -45 + i * 9, 49)) }],
    }));
    push(part("chrome", knob("z", C, [[0, 43.8], [10, 43.8], [10.6, 44.6], [10, 45.6], [0, 45.6]], 8), { pri: 1.6, shadow: "throne" }));
    push(part("chrome", [
      ...knob("z", C, [[0, 30], [1.4, 30], [1.4, 43.8], [0, 43.8]], 8),
      ...knob("z", C, [[0, 8.5], [2.0, 8.5], [2.0, 30.5], [0, 30.5]], 8),
      ...knob("z", C, [[0, 28.6], [2.7, 28.6], [2.7, 31.2], [0, 31.2]], 8), // memory lock
      ...rod([cx, cy + 2.6, 29.9], [cx, cy + 6, 29.9], 0.35, 0.35, 6),
      ...rod([cx - 1.6, cy + 6, 29.9], [cx + 1.6, cy + 6, 29.9], 0.5, 0.5, 6),
      ...knob("z", C, [[0, 14], [3.1, 14], [3.1, 18], [0, 18]], 8), // leg hub
      ...knob("z", C, [[0, 7.5], [2.8, 7.5], [2.8, 9.8], [0, 9.8]], 8), // brace collar
    ], { pri: 1.2, shadow: "throne" }));
    for (const th of [90, 210, 330]) {
      const foot = at("z", C, 27, th, 1.4);
      const midLeg = at("z", C, 15, th, 8.8);
      push(part("chrome", [
        ...rod(at("z", C, 3.1, th, 16), foot, 0.7, 0.7, 8),
        ...rod(at("z", C, 2.8, th, 8.6), midLeg, 0.5, 0.5, 6),
        ...knob("z", [foot[0], foot[1]], [[0, 0], [1.4, 0], [1.4, 1.2], [0.8, 2.2], [0, 2.2]], 8),
      ], { pri: facesUs(at("z", [0, 0], 1, th, 0)) ? 1.4 : 1.0, shadow: "throne" }));
    }
  }

  return {
    kind: "drums",
    parts,
    size: [160, 155, 140],
    focus: { min: [48, 26, 50], max: [156, 108, 96] },
    light: (pitches) => [...new Set(pitches.map((p) => `d:${drumPiece(p)}`))],
    pitchOf: (key) => (key.startsWith("d:") ? PIECE_PITCH[key.slice(2)] ?? null : null),
  };
}

// -----------------------------------------------------------------------------
// Flat-sided solids
// -----------------------------------------------------------------------------

function boxF(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Face[] {
  return [
    { n: [0, 0, 1], pts: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
    { n: [0, 0, -1], pts: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]] },
    { n: [1, 0, 0], pts: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]] },
    { n: [-1, 0, 0], pts: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
    { n: [0, 1, 0], pts: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]] },
    { n: [0, -1, 0], pts: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
  ];
}

/** A (y, z) outline extruded across x0..x1, sides facing out (the footboard). */
function prismX(outline: readonly P2[], x0: number, x1: number): Face[] {
  const lo = outline.map(([y, z]) => [x0, y, z] as Vec3), hi = outline.map(([y, z]) => [x1, y, z] as Vec3);
  // Signed area in (y, z): positive = counter-clockwise seen from +x.
  let a = 0;
  for (let i = 0; i < outline.length; i++) {
    const [y0, z0] = outline[i], [y1, z1] = outline[(i + 1) % outline.length];
    a += y0 * z1 - y1 * z0;
  }
  const ccw = a > 0;
  const faces: Face[] = [
    { n: [1, 0, 0], pts: ccw ? hi : [...hi].reverse() },
    { n: [-1, 0, 0], pts: ccw ? [...lo].reverse() : lo },
  ];
  for (let i = 0; i < outline.length; i++) {
    const j = (i + 1) % outline.length;
    const dy = outline[j][0] - outline[i][0], dz = outline[j][1] - outline[i][1];
    const l = Math.hypot(dy, dz) || 1;
    // Outward is to the right of the edge for a counter-clockwise outline.
    const n: Vec3 = ccw ? [0, dz / l, -dy / l] : [0, -dz / l, dy / l];
    faces.push({ n, pts: [lo[i], lo[j], hi[j], hi[i]] });
  }
  return faces;
}
