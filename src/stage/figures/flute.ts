/** @file Stage figures: flute (split from src/stage/figures.ts; see its header for conventions). */
import "./flute.css";
import { box, cylinder, decal, lathe, part, prism, rod, rotate, translate, type Face, type Part, type Vec3 } from "../iso";
import { FLUTE } from "../fingerings";
import { type Figure, woodwindLight, woodwindPitch } from "./common";

/**
 * The Boehm concert flute in C, C foot, closed G♯, French (open-hole) model,
 * silver throughout — GM 73 (and GM 72, the piccolo, which the room draws with
 * this same figure). Built along +x, crown at x = 0 (the left of the default
 * view), floating level at playing height, the player's side toward +y.
 *
 * Dimensions (cm). Sources: VSL Academy "Concert flute" (tube 67–68 cm, bore
 * ≈ 19 mm); National Music Museum Boehm C flutes (embouchure 12.5 × 10.5 mm;
 * a Conn C flute: head 16.7, body 34.2, foot 13.4 without tenons); the rest
 * read off maker photographs and drawings — INFERRED, not measured:
 *
 *   overall, crown to foot ring ............ 67      (true)
 *   crown + head ring ...................... 1.6
 *   head joint, tapering (parabolic) ....... 1.6 → 19.4; OD 1.75 at the cork → 1.97 at the tenon
 *   receiver ring (head into body) ......... 19.4 – 21.0
 *   body ................................... 21 – 53;   OD 1.97 (bore 1.9, wall 0.4 mm)
 *   foot socket ring ....................... 53 – 54.4
 *   foot (C foot) .......................... 54.4 – 66.9, end ring 65.9 – 66.9
 *   embouchure centre ...................... 6 from the crown tip (cork 1.7 above it, inside, unseen)
 *   lip plate .............................. 5.2 × 3.1, flatter than the tube; riser 0.42 high
 *   embouchure hole ........................ 1.25 × 1.05 (rounded rectangle, long along the tube)
 *   main key cups .......................... Ø 2.2 (r 1.55 here); foot cups Ø 2.1; trill/G♯/E♭ Ø 1.2–1.3
 *   cup centres (from the crown tip) ....... C♯ 23.4, L1 25.6, B 28.4, L2 31.5, L3 34.9, G♯ 37.8,
 *                                            R1 41.4, D-trill 43.5, R2 45.6, D♯-trill 47.7, R3 49.8,
 *                                            E♭ 55.4, C♯ 59.6, C 63.4 (inferred from photographs)
 *
 * Exaggerations, for legibility: every cross-section ×1.4 (tube, rings, cups,
 * lip plate across the tube) — a true 2 cm tube on a 67 cm instrument reads as
 * a wire; lengths along the tube are true. Trill cups are nearer true size
 * (×1.1) to fit between the plates, as they do on the real flute.
 *
 * Orientation. The rod line (posts, steel rods, hinge tubes, the G♯ and E♭
 * touches and the foot rollers) runs along the far side, as on a real flute;
 * its touches stand high enough to clear the tube's silhouette. The flute is
 * NOT rolled about its axis: a roll would give every key a loose, rotated box
 * (depth rule 3) and still hide what sits underneath. Instead the left-thumb
 * B and B♭ (Briccialdi) levers are drawn on the near, lower flank — where the
 * left thumb reaches them from the player's side — on their own hinge rod,
 * which shows below the tube's lower silhouette.
 *
 * Parts (95): crown, head joint, one curved lip plate, riser,
 * embouchure (blow), receiver ring, body, foot socket ring, foot, end ring
 * with the open bore; ten top cups (C♯ vent, L1, thumb-B cup, L2, L3, R1, R2,
 * R3, foot C♯, foot C) each on a tone-hole chimney, French ring keys with
 * their inner ring, hole and French point, closed keys with pearls; four side
 * cups (G♯, D-trill, D♯-trill, E♭) on chimneys with pearls; hinge tubes, one
 * per key, on three steel rods (upper stack, lower stack, foot) and a thumb
 * rod; turned posts (rod ends and shared middle post); cup arms; the G♯ and
 * E♭ touches and their arms; C♯ and C rollers and their long arms; thumb B
 * plate and B♭ lever with their arms.
 *
 * Lighting: every part that moves with a key carries that key's name (cup,
 * pearl, hinge tube, arm, touch, roller), so a lit key reads end to end.
 */

const Z = 60;
/** Body/foot radius (OD 1.97 ×1.4) and the rod line: angle from +y (toward +z), radius. */
const R = 1.38;
const ROD_A = 140, ROD_R = 1.8;
const THUMB_A = -55, THUMB_R = 1.8;
const deg = Math.PI / 180;
/** (y, z) of a point at angle `a` (degrees from +y toward +z) and radius `r` about the tube's axis. */
const yz = (a: number, r: number): [number, number] => [Math.cos(a * deg) * r, Z + Math.sin(a * deg) * r];
const pt = (x: number, a: number, r: number): Vec3 => [x, ...yz(a, r)];

/** A turned part standing radially at angle `a`: its profile is [radius, distance from the tube axis]. */
function radial(x: number, a: number, profile: readonly (readonly [number, number])[], creases: number[] = [], n = 16): Face[] {
  const f = lathe("z", [x, 0], profile.map(([r, s]) => [r, Z + s] as const), n, creases);
  return a === 90 ? f : rotate(f, "x", a - 90, [x, 0, Z]);
}

/** A flat plate (touch, lever) lying across angle `a` at radius `r`: x0..x1 long, `w` wide, `t` thick. */
function plateAt(x0: number, x1: number, a: number, r: number, w: number, tilt = a, t = 0.16): Face[] {
  const [y, z] = yz(a, r);
  return rotate(box(x0, -w / 2, -t / 2, x1, w / 2, t / 2), "x", tilt - 90, [x0, 0, 0])
    .map((f) => ({ ...f, pts: f.pts.map((q) => [q[0], q[1] + y, q[2] + z] as Vec3) }));
}

/** An arc band across the tube (a curved plate hugging it), as a prism along x. */
function arcBand(x0: number, x1: number, a0: number, a1: number, r0: number, r1: number, cy = 0, cz = Z, steps = 8): Face[] {
  const outer: [number, number][] = [], inner: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (a0 + ((a1 - a0) * i) / steps) * deg;
    outer.push([cy + Math.cos(a) * r1, cz + Math.sin(a) * r1]);
    inner.push([cy + Math.cos(a) * r0, cz + Math.sin(a) * r0]);
  }
  return prism([...outer, ...inner.reverse()], "x", x0, x1, true);
}

const ring = (x0: number, x1: number, r: number, inner: number) =>
  part("silver", lathe("x", [0, Z], [[inner, x0], [r, x0 + 0.1], [r, x1 - 0.1], [inner, x1]], 22, [1, 2]), { pri: 1, shadow: false });

export function flute(): Figure {
  const parts: Part[] = [];
  const [hy, hz] = yz(ROD_A, ROD_R);
  const [ty, tz] = yz(THUMB_A, THUMB_R);

  // ---- The tube: crown, head joint, joints, body, foot ----
  parts.push(part("silver", lathe("x", [0, Z], [[0.55, 0], [0.95, 0.12], [1.28, 0.42], [1.4, 0.72], [1.4, 1.2], [1.3, 1.24], [1.3, 1.6]], 22, [4, 5]), { pri: 1, shadow: "flute" }));
  // Head joint: a parabolic taper from the cork end to the tenon.
  const head: [number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const x = 1.6 + (17.8 * i) / 6;
    head.push([1.22 + 0.16 * Math.sqrt(i / 6), x]);
  }
  parts.push(part("silver", lathe("x", [0, Z], head, 22), { pri: 1, shadow: "flute" }));
  parts.push(ring(19.4, 21.0, 1.52, 1.38));
  parts.push(part("silver", cylinder("x", [0, Z], R, R, 21.0, 53.0, 22), { pri: 1, shadow: "flute" }));
  parts.push(ring(53.0, 54.4, 1.5, R));
  parts.push(part("silver", cylinder("x", [0, Z], R, R, 54.4, 65.9, 22), { pri: 1, shadow: "flute" }));
  parts.push(part("silver", lathe("x", [0, Z], [[R, 65.9], [1.48, 66.0], [1.48, 66.8], [1.42, 66.9]], 22, [1, 2]), {
    pri: 1, shadow: false,
    decals: [decal([66.9, 0, Z], [0, -1, 0], [0, 0, -1], `<circle class="fl-bore" r="1.3"/>`, [-1.42, -1.42, 1.42, 1.42])],
  }));

  // ---- Lip plate (flatter than the tube, oval in plan), riser, embouchure ----
  const EX = 6, RH = 1.25, PR = 2.4, PT = 0.13;
  const pcz = Z + RH + 0.03 - PR;
  // One curved plate, a larger radius than the tube so its wings stand off it, as on a real head joint.
  parts.push(part("silver", arcBand(EX - 2.5, EX + 2.5, 90 - 40, 90 + 40, PR, PR + PT, 0, pcz, 12), { pri: 2, sortFaces: true, shadow: false }));
  const rise: [number, number][] = [];
  for (let i = 0; i < 20; i++) {
    const t = (i / 20) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    rise.push([EX + Math.sign(c) * Math.abs(c) ** 0.6 * 1.0, Math.sign(s) * Math.abs(s) ** 0.6 * 0.88]);
  }
  const riseTop = Z + RH + 0.16 + 0.42;
  parts.push(part("silver", prism(rise, "z", Z + RH + 0.1, riseTop, true), { pri: 2.5, shadow: false }));
  parts.push(part("cell", [], {
    key: "blow", cls: "blow", pri: 3.5, shadow: false,
    decals: [decal([EX, 0, riseTop], [1, 0, 0], [0, 1, 0],
      `<ellipse class="hit" rx="2.6" ry="1.7"/><rect class="mouth" x="-0.63" y="-0.53" width="1.26" height="1.06" rx="0.42"/><path class="fl-edge" d="M-0.63 -0.1V0.1M0.63 -0.1V0.1"/>`,
      [-2.6, -1.7, 2.6, 1.7])],
  }));

  // ---- The mechanism ----
  /** A tone-hole chimney and its cup, standing at angle `a`. Open-hole cups get the ring, hole and French point. */
  const cupTop = R + 0.8;
  const cup = (key: string | undefined, x: number, r: number, a = 90, style: "ring" | "pearl" | "plain" = "pearl") => {
    const opts = key ? { key, cls: "wkey" } : {};
    parts.push(part("silver", radial(x, a, [[r * 0.78, R - 0.35], [r * 0.78, R + 0.2]], [], 20), { pri: a === 90 ? 2.1 : 2.3, shadow: false }));
    const decals = [];
    if (style === "ring") {
      decals.push(decal([x, 0, Z + cupTop], [1, 0, 0], [0, 1, 0],
        `<path class="fl-point" d="M-0.42 -${r * 0.97}L0 -${r * 0.42}L0.42 -${r * 0.97}Z"/><circle class="ring" r="${r * 0.52}"/><circle class="cuphole" r="${r * 0.36}"/>`, [-r, -r, r, r]));
    } else if (style === "plain") {
      decals.push(decal([x, 0, Z + cupTop], [1, 0, 0], [0, 1, 0], `<circle class="fdot" r="0.12"/>`, [-r, -r, r, r]));
    }
    parts.push(part("silver", radial(x, a, [[r - 0.1, R + 0.2], [r, R + 0.3], [r, R + 0.62], [r - 0.14, R + 0.77], [r * 0.82, cupTop]], [1], 24), {
      ...opts, pri: a === 90 ? 3 : 2.4, shadow: false, decals: a === 90 ? decals : [],
    }));
    if (style === "pearl") {
      parts.push(part("silver", radial(x, a, [[0.36, cupTop], [0.36, cupTop + 0.07], [0.28, cupTop + 0.18], [0.1, cupTop + 0.25]], [1], 12), {
        ...opts, pri: a === 90 ? 3.3 : 2.6, shadow: false,
      }));
    }
    // The arm from the cup's far rim down to its hinge tube.
    if (a === 90) {
      parts.push(part("silver", rod([x, -r * 0.8, Z + R + 0.4], [x, hy + 0.15, hz + 0.05], 0.15), { ...opts, pri: 2.2, shadow: false }));
    }
  };
  /** A key's hinge tube on the rod line, and the steel rod between posts. */
  const hinge = (key: string | undefined, x0: number, x1: number, y = hy, z = hz) =>
    parts.push(part("silver", cylinder("x", [y, z], 0.28, 0.28, x0, x1, 12), { ...(key ? { key, cls: "wkey" } : {}), pri: 2, shadow: false }));
  const steel = (x0: number, x1: number, y = hy, z = hz) =>
    parts.push(part("flsteel", rod([x0, y, z], [x1, y, z], 0.12, 0.12, 8), { pri: 1.6, shadow: false }));
  /** A turned post soldered to the tube, its head holding the rod. */
  const post = (x: number, a = ROD_A, r = ROD_R) =>
    parts.push(part("silver", radial(x, a, [[0.42, R - 0.05], [0.42, R + 0.06], [0.24, R + 0.15], [0.22, r - 0.26], [0.31, r - 0.2], [0.31, r + 0.22], [0.18, r + 0.3]], [1, 2, 3, 4, 5], 12), { pri: 1.7, shadow: false }));

  // Upper stack (left hand): the C♯ vent, L1, the thumb's B cup, L2, L3, and the G♯ key.
  steel(22.2, 39.5);
  post(22.2); post(39.5);
  cup(undefined, 23.4, 0.85);
  hinge(undefined, 22.55, 24.4);
  cup("L1", 25.6, 1.5);
  hinge("L1", 24.55, 26.75);
  cup("thumbB", 28.4, 1.3);
  hinge("thumbB", 26.9, 29.75);
  cup("L2", 31.5, 1.55, 90, "ring");
  hinge("L2", 29.9, 33.15);
  cup("L3", 34.9, 1.55, 90, "ring");
  hinge("L3", 33.3, 36.5);
  cup("Gs", 37.8, 0.82, 108);
  hinge("Gs", 36.65, 39.15);
  // The G♯ touch for the left little finger, standing above the rod line.
  parts.push(part("silver", plateAt(36.7, 38.9, 135, 2.42, 1.1, 105), { key: "Gs", cls: "wkey", pri: 2.5, shadow: false }));
  parts.push(part("silver", rod(pt(37.8, 137, ROD_R + 0.2), pt(37.8, 135, 2.34), 0.13), { key: "Gs", cls: "wkey", pri: 2.2, shadow: false }));

  // Lower stack (right hand): R1, the D trill, R2, the D♯ trill, R3.
  steel(39.5, 51.3);
  post(51.3);
  cup("R1", 41.4, 1.55, 90, "ring");
  hinge("R1", 39.85, 42.65);
  cup("trill1", 43.5, 0.55, 110);
  hinge("trill1", 42.8, 44.2);
  cup("R2", 45.6, 1.55, 90, "ring");
  hinge("R2", 44.35, 46.85);
  cup("trill2", 47.7, 0.55, 110);
  hinge("trill2", 47.0, 48.4);
  cup("R3", 49.8, 1.55, 90, "ring");
  hinge("R3", 48.55, 50.95);

  // Foot (C foot): E♭ (closed), C♯ and C (open-standing), their touches at the top for the right little finger.
  steel(54.55, 64.95);
  post(54.55); post(56.55); post(64.95);
  cup("Eb", 55.4, 0.8, 108);
  hinge("Eb", 54.9, 56.2);
  parts.push(part("silver", plateAt(53.4, 56.2, 135, 2.42, 1.1, 105), { key: "Eb", cls: "wkey", pri: 2.5, shadow: false }));
  parts.push(part("silver", rod(pt(55.7, 139, ROD_R + 0.2), pt(55.7, 135, 2.34), 0.13), { key: "Eb", cls: "wkey", pri: 2.2, shadow: false }));
  cup("Cs", 59.6, 1.45, 90, "plain");
  hinge("Cs", 56.9, 60.65);
  cup("C", 63.4, 1.45, 90, "plain");
  hinge("C", 60.8, 64.6);
  // Rollers, each on a long arm back to its key's hinge tube.
  const roller = (key: string, a: number, r: number, toX: number, pri: number) => {
    const [ry, rz] = yz(a, r);
    parts.push(part("silver", cylinder("x", [ry, rz], 0.42, 0.42, 56.7, 58.1, 14), { key, cls: "wkey", pri, shadow: false }));
    parts.push(part("silver", rod([58.1, ry, rz], [toX, hy, hz + 0.2], 0.12), { key, cls: "wkey", pri: pri - 0.3, shadow: false }));
  };
  roller("Cs", 124, 2.32, 57.5, 2.6);
  roller("C", 150, 2.5, 61.3, 2.4);

  // Left thumb: the B lever (keyed) and the B♭ (Briccialdi) lever above it, on their own rod underneath.
  steel(23.9, 31.1, ty, tz);
  post(23.9, THUMB_A, THUMB_R); post(31.1, THUMB_A, THUMB_R);
  hinge("thumbB", 24.3, 27.8, ty, tz);
  hinge(undefined, 28.0, 30.7, ty, tz);
  parts.push(part("silver", arcBand(24.5, 27.7, -40, -10, 1.45, 1.62), { key: "thumbB", cls: "wkey", pri: 3, shadow: false }));
  parts.push(part("silver", rod(pt(26.1, -38, 1.5), [26.1, ty, tz + 0.15], 0.14), { key: "thumbB", cls: "wkey", pri: 2.2, shadow: false }));
  parts.push(part("silver", arcBand(27.9, 30.5, -36, -14, 1.68, 1.84), { pri: 3, shadow: false }));
  parts.push(part("silver", rod(pt(29.2, -34, 1.7), [29.2, ty, tz + 0.15], 0.13), { pri: 2.2, shadow: false }));

  const placed = translate(parts, [2, 6, 0]);
  return {
    kind: "flute",
    parts: placed,
    size: [71, 12, Z + 4],
    light: woodwindLight(FLUTE),
    pitchOf: woodwindPitch(FLUTE),
    // Where the hands go: the left thumb and fingers from the receiver to the right little finger on the foot.
    // From the embouchure (where the breath lights) to the foot rollers.
    focus: { min: [2 + 4, 6 - 3, Z - 3], max: [2 + 67, 6 + 3, Z + 3] },
  };
}
