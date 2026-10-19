/** @file Stage figures: whistle (split from src/stage/figures.ts; see its header for conventions). */
import "./whistle.css";
import { cross, cylinder, decal, lathe, norm, part, sub, translate, type Part, type Vec3 } from "../iso";
import { type Figure, fold } from "./common";

// -----------------------------------------------------------------------------
// Tin whistle (six holes, the simple system of a whistle or an Irish flute in D)
// -----------------------------------------------------------------------------

/**
 * Fingering for each semitone above the flute's D, holes top (left hand) to
 * bottom: x closed, o open, h half-holed. C natural is the cross fingering
 * oxxooo. The second octave repeats the first, blown harder.
 */
export const FLUTE_FINGERING = [
  "xxxxxx", "xxxxxh", "xxxxxo", "xxxxho", "xxxxoo", "xxxooo",
  "xxhooo", "xxoooo", "xhoooo", "xooooo", "oxxooo", "oooooo",
];
export const FLUTE_D = 62;

/** The keys a pitch lights: the holes its fingering closes, the mouthpiece, the octave mark. */
export function fluteKeys(pitch: number): string[] {
  const p = fold(pitch, FLUTE_D, FLUTE_D + 23);
  const keys = ["blow"];
  [...FLUTE_FINGERING[(p - FLUTE_D) % 12]].forEach((c, i) => {
    if (c === "x") keys.push(`h${i}`);
    if (c === "h") keys.push(`h${i}h`);
  });
  if (p >= FLUTE_D + 12) keys.push("oct");
  return keys;
}

/** A pressed hole plays the note you get covering it and every hole above it; the mouthpiece alone, all open. */
export function flutePitch(key: string): number | null {
  if (key === "blow") return FLUTE_D + 11;
  const m = /^h(\d)(h?)$/.exec(key);
  if (!m) return null;
  const pattern = "x".repeat(Number(m[1])) + (m[2] ? "h" : "x") + "o".repeat(5 - Number(m[1]));
  const s = FLUTE_FINGERING.indexOf(pattern);
  return s < 0 ? null : FLUTE_D + s;
}

/**
 * The six-hole tin whistle in D (a Clarke/Generation-style high D): a drawn
 * brass or nickel tube pushed into a moulded plastic fipple head. Built along
 * +x, beak at x = 0 (the left of the default view), floating level at playing
 * height, the finger holes and the window on top, the player's side toward +y.
 *
 * Dimensions (cm). Sources: the Chiff & Fipple bore-size list (Generation D:
 * bore 11.9 mm, bell-to-blade 266 mm — chiffandfipple.com/t/bore-size-and-hole-spacing/14466);
 * hole spacing read from maker photographs — INFERRED, not measured:
 *
 *   overall, beak tip to tube end ...... 31.2
 *   beak (flattened mouthpiece) ......... 0 – 2.6, 1.4 wide × 0.8 tall (true; ×1.5 below)
 *   head (sleeve over the tube) ......... 2.6 – 7.4, OD 1.75, end bead 7.0 – 7.4
 *   window ............................. 0.7 long × 0.6 wide, blade (labium edge) at 4.55
 *   tube ............................... 7.4 – 31.2, OD 1.27 (bore 1.19), open end
 *   holes, from the blade .............. 10.9, 13.2, 15.6 | 18.8, 21.1, 23.2 (two groups of three)
 *   hole diameters ..................... 0.64 – 0.74
 *
 * Exaggerations, for legibility: every cross-section ×1.5 (tube, head, beak,
 * holes, window across the tube); lengths along the whistle are true.
 *
 * Parts (16): head (one moulding: beak, swell, sleeve, end bead), tube with its open bore,
 * window/labium/windway (the press-to-blow part), six holes, six half-holes,
 * the octave mark. A real whistle is three pieces (tube, head, fipple block);
 * the block and windway channel are inside the head and show only where the
 * windway opens into the window (the flue line upstream of the blade) — the
 * beak's slot faces away from the default view. More parts would be noise.
 */
export function whistle(): Figure {
  const Z = 58, K = 1.5;
  const RT = 0.635 * K, RH = 0.875 * K, BLADE = 4.55;
  const parts: Part[] = [];
  // Head, in one moulding: a turned profile from the lip to the bead where it grips the tube, its
  // mouthpiece end flattened into the beak (squashed in z, its top falling toward the lip).
  const lerp = (x: number, pts: readonly (readonly [number, number])[]) => {
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) {
      const [x0, v0] = pts[i - 1], [x1, v1] = pts[i];
      return v0 + ((v1 - v0) * (x - x0)) / (x1 - x0);
    }
    return pts[pts.length - 1][1];
  };
  const squash = (x: number) => lerp(x, [[0.25, 0.46], [1.2, 0.54], [2.2, 0.64], [3.0, 0.82], [3.6, 0.97], [4.0, 1]]);
  const headFaces = lathe("x", [0, Z], [[0.9, 0], [1.0, 0.2], [1.04, 1.0], [1.08, 2.0], [1.16, 2.8], [1.26, 3.4], [RH, 3.9], [RH, 6.95], [RH + 0.07, 7.03], [RH + 0.07, 7.32], [RH, 7.4]], 32, [1, 7, 8])
    .map((f) => {
      const pts = f.pts.map(([x, y, z]) => { const k = squash(x); return [x, y, Z + (1 - k) * RH * 0.62 + (z - Z) * k] as Vec3; });
      if (!f.strip) return { ...f, pts };
      const c = pts.reduce((m, q) => [m[0] + q[0] / pts.length, m[1] + q[1] / pts.length, m[2] + q[2] / pts.length], [0, 0, 0]);
      const k = squash(c[0]);
      let n = norm(cross(sub(pts[1], pts[0]), sub(pts[3], pts[0])));
      if (!isFinite(n[0]) || Math.hypot(...n) < 0.5) n = norm(cross(sub(pts[2], pts[3]), sub(pts[0], pts[3])));
      const out: Vec3 = [0, c[1], c[2] - (Z + (1 - k) * RH * 0.62)];
      if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) n = [-n[0], -n[1], -n[2]];
      return { ...f, pts, n };
    });
  parts.push(part("plastic", headFaces, { pri: 1, shadow: "whistle" }));
  // Tube, open at the end.
  const END = BLADE + 26.6;
  parts.push(part("brass", cylinder("x", [0, Z], RT, RT, 7.4, END, 22), {
    pri: 1, shadow: "whistle",
    decals: [decal([END, 0, Z], [0, -1, 0], [0, 0, -1], `<circle class="wh-bore" r="${(0.595 * K).toFixed(3)}"/>`, [-RT, -RT, RT, RT])],
  }));
  // Window: the windway's flue opens upstream, the labium's ramp falls to the blade downstream. Press it to blow.
  parts.push(part("cell", [], {
    key: "blow", cls: "blow", pri: 3, shadow: false,
    decals: [decal([BLADE - 0.35, 0, Z + RH], [1, 0, 0], [0, 1, 0],
      `<ellipse class="hit" rx="1.9" ry="1.3"/><path class="wh-ramp" d="M0.35 -0.45L1.3 -0.3V0.3L0.35 0.45Z"/>` +
      `<rect class="mouth" x="-0.35" y="-0.45" width="0.7" height="0.9" rx="0.06"/><path class="wh-flue" d="M-0.3 -0.36V0.36"/><path class="wh-blade" d="M0.35 -0.45V0.45"/>`,
      [-1.9, -1.3, 1.9, 1.3])],
  }));
  // The second octave: blow harder (shown only while it sounds).
  parts.push(part("cell", [], { key: "oct", cls: "oct", pri: 3, shadow: false,
    decals: [decal([11.6, 0, Z + RT], [1, 0, 0], [0, 1, 0], `<text class="octmark" font-size="1.3" y="0.45" text-anchor="middle">8va</text>`, [-1.4, -0.6, 1.4, 0.6])] }));
  // Six finger holes in two groups of three, left hand then right.
  const at = [10.9, 13.2, 15.6, 18.8, 21.1, 23.2].map((d) => BLADE + d);
  const radius = [0.34, 0.36, 0.33, 0.37, 0.36, 0.32].map((r) => r * K);
  at.forEach((x, i) => {
    const r = radius[i];
    parts.push(part("cell", [], { key: `h${i}`, cls: "hole", pri: 3, shadow: false,
      decals: [decal([x, 0, Z + RT], [1, 0, 0], [0, 1, 0],
        `<circle class="hit" r="1.1"/><circle class="ring" r="${(r + 0.09).toFixed(2)}"/><circle class="tonehole" r="${r.toFixed(2)}"/><circle class="dot" r="${r.toFixed(2)}"/>` +
        `<text class="lbl" y="1.95" font-size="0.95" text-anchor="middle">${i + 1}</text>`, [-1.1, -1.1, 1.1, 2.1])] }));
    parts.push(part("cell", [], { key: `h${i}h`, cls: "hole half", pri: 3.5, shadow: false,
      decals: [decal([x, 0, Z + RT], [1, 0, 0], [0, 1, 0], `<path class="dot" d="M-${r.toFixed(2)} 0A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${r.toFixed(2)} 0Z"/>`, [-r, -r, r, 0])] }));
  });
  const placed = translate(parts, [2, 5, 0]);
  return {
    kind: "whistle",
    parts: placed,
    size: [END + 4, 10, Z + 2],
    light: (pitches) => (pitches.length ? fluteKeys(Math.max(...pitches)) : []),
    pitchOf: flutePitch,
    // Where the hands go: the window and the six holes.
    focus: { min: [2 + 2, 5 - 2.5, Z - 2], max: [2 + END + 0.5, 5 + 2.5, Z + 2] },
  };
}
