/**
 * @file Stage figures: the marimba (GM 8–15 chromatic percussion, kalimba, steel drums).
 *
 * A concert marimba, built the way a maker builds one (1 unit ≈ 1 cm).
 *
 * Dimensions (sources: Yamaha YM-6100 spec, usa.yamaha.com/products/musical_instruments/
 * percussion/marimbas/ym-6100/specs.html — bars 41–80 mm wide, 20–25 mm thick, height
 * 88–103 cm, footprint 272 × 116 cm for 5 octaves; free-free bar nodes at 0.224 L):
 *   bar width        6.5 cm at C2 → 4.0 cm at C7, linear in pitch (the brief's figures; Yamaha's C2 is 8.0)
 *   bar length       50 cm at C2 → 25 cm at C7, halving over the five octaves (2^(−semitones/60))
 *   bar thickness    2.5 → 2.0 cm; undercut arch between the nodes, 60 % deep in the bass, 30 % in the treble
 *   gap between bars 1.0 → 0.7 cm
 *   nodes            0.224 L from each end; the cord runs through a hole there at mid-thickness
 *   rows             naturals in front (+y, the player), accidentals behind, 3 cm higher; each row centred
 *   playing height   natural bar centres at 88 (Yamaha's lowest setting)
 *   rails            2.2 × 3.5 cm wood on the node lines (they converge to the treble), 0.4 cm felt on top
 *   pins             Ø 0.36 cm, one between every pair of bars and one at each end of a row
 *   resonators       aluminium, Ø = bar width − 0.4, open top 3 cm under the bar, length λ/4 − 0.61 r
 *                    (c = 343 m/s), clamped to the frame (tubes of C2–B2 would need up to 131 cm: real
 *                    instruments fold them; here they stop above the foot rails)
 *   end frames       6.5 cm thick (x): top beam 9 cm deep, accidental riser 3 cm, two telescoping legs
 *                    with height knobs, a centre post, a mid cross bar, a foot on four casters (Ø 7.2)
 *   stretchers       two tubes Ø 2.6 / 2.4 along x on the centre line, an X brace between them
 *   mallets          two yarn mallets, birch shafts Ø 0.8 × 36 cm, heads Ø 3.4, resting on the treble end frame
 * Exaggerations for legibility: pins ×1.5, cord drawn as a line, node holes ×1.3.
 *
 * Parts (≈ 400 for three octaves): per natural / accidental bar — the bar (its own pressable part,
 * cls "key bar", undercut arch, node holes, note name on the naturals), its resonator tube (open
 * mouth, cap crease, rolled rim), two pins, two cord runs; per row — four rails and felt strips (two
 * per row), tie rods between the tubes; per end frame — top beam, riser, two leg sleeves, two inner
 * legs, two height knobs, centre post, mid cross bar, foot, bolts, four casters (plate, king pin,
 * crown, two fork cheeks, wheel, two axle nuts); the two stretchers, the X brace; two mallets (shaft,
 * end cap, yarn head).
 */
import "./mallets.css";
import { box, cylinder, decal, lathe, part, prism, rod, type Part, type Vec3 } from "../iso";
import { type Figure, isBlack, keyboardFigure, noteName, text } from "./common";

/** 0 at C2, 1 at C7 (a little beyond at either end). */
const span = (p: number) => Math.max(-0.2, Math.min(1.2, (p - 36) / 60));
const barW = (p: number) => 6.5 - 2.5 * span(p);
const barL = (p: number) => 50 * 2 ** (-span(p));
const barT = (p: number) => 2.5 - 0.5 * span(p);
const barGap = (p: number) => 1.0 - 0.3 * span(p);
const NODE = 0.224;
const hz = (p: number) => 440 * 2 ** ((p - 69) / 12);

/** One bar: a slab with the undercut arch between its nodes, seen from its side (+x) as a prism across x. */
function barFaces(x0: number, x1: number, yc: number, zc: number, p: number) {
  const L = barL(p), T = barT(p), y0 = yc - L / 2, y1 = yc + L / 2, z0 = zc - T / 2, z1 = zc + T / 2;
  const deep = T * (0.6 - 0.3 * Math.max(0, Math.min(1, span(p))));
  const arch: [number, number][] = [];
  for (let i = 0; i <= 8; i++) arch.push([y1 - 0.26 * L - (i / 8) * 0.48 * L, z0 + deep * Math.sin((Math.PI * i) / 8)]);
  const outline: [number, number][] = [[y0, z1], [y1, z1], [y1, z0], ...arch, [y0, z0]];
  return prism(outline, "x", x0, x1);
}

export function mallets(lo: number, hi: number): Figure {
  const parts: Part[] = [];
  const naturals: number[] = [];
  const accidentals: number[] = [];
  for (let p = lo; p <= hi; p++) (isBlack(p) ? accidentals : naturals).push(p);
  const FT = 6.5; // end frame thickness along x
  const lowN = naturals[0], lowA = accidentals[0] ?? lowN + 1;
  const gapRows = 3;
  const yA = barL(lowA) / 2 + 0.5;
  const yN = yA + barL(lowA) / 2 + gapRows + barL(lowN) / 2;
  const zcN = 88, zcA = zcN + 3;
  const D = yN + barL(lowN) / 2 + 0.5;

  // Naturals side by side from the bass end, accidentals over the gaps between them.
  const xs = new Map<number, [number, number]>();
  let x = FT + 3;
  for (const p of naturals) {
    xs.set(p, [x, x + barW(p)]);
    x += barW(p) + barGap(p);
  }
  const W = x - barGap(naturals[naturals.length - 1]) + 3 + FT;
  const accs = accidentals.filter((p) => xs.has(p - 1) && xs.has(p + 1));
  for (const p of accs) {
    const c = (xs.get(p - 1)![1] + xs.get(p + 1)![0]) / 2;
    xs.set(p, [c - barW(p) / 2, c + barW(p) / 2]);
  }

  // Each row hangs on two rails along its node lines; a rail is a straight line from end frame to end frame.
  const rows = [
    { bars: naturals, yc: yN, zc: zcN, id: "n" },
    { bars: accs, yc: yA, zc: zcA, id: "a" },
  ];
  const frameY: [number, number][] = [[Infinity, -Infinity], [Infinity, -Infinity]]; // y extent at the bass / treble frame
  const accFront = [yA, yA]; // the raised row's front rail at each frame: the riser ends just past it
  for (const row of rows) {
    if (!row.bars.length) continue;
    const first = row.bars[0], last = row.bars[row.bars.length - 1];
    const xa = (xs.get(first)![0] + xs.get(first)![1]) / 2, xb = (xs.get(last)![0] + xs.get(last)![1]) / 2;
    const off = (xq: number) => {
      const t = xb > xa ? (xq - xa) / (xb - xa) : 0;
      return (0.5 - NODE) * (barL(first) + t * (barL(last) - barL(first)));
    };
    const tMax = Math.max(...row.bars.map(barT));
    const feltTop = row.zc - tMax / 2 - 0.5, railTop = feltTop - 0.4, railBot = railTop - 3.5;
    const hook = row.zc + 0.25;
    for (const side of [-1, 1]) {
      const yAt = (xq: number) => row.yc + side * off(xq);
      const quad = (hw: number): [number, number][] => [[FT, yAt(FT) - hw], [W - FT, yAt(W - FT) - hw], [W - FT, yAt(W - FT) + hw], [FT, yAt(FT) + hw]];
      parts.push(part("body", prism(quad(1.1), "z", railBot, railTop), { shadow: "frame" }));
      parts.push(part("felt", prism(quad(0.8), "z", railTop, feltTop), { shadow: false }));
      frameY[0] = [Math.min(frameY[0][0], yAt(0) - 1.1), Math.max(frameY[0][1], yAt(0) + 1.1)];
      frameY[1] = [Math.min(frameY[1][0], yAt(W) - 1.1), Math.max(frameY[1][1], yAt(W) + 1.1)];
      if (row.id === "a" && side > 0) [accFront[0], accFront[1]] = [yAt(0) + 3, yAt(W) + 3];
      // Pins between the bars and at each end; the cord dips to each pin's hook and runs through the bars.
      const edges: [number, number][] = row.bars.map((p) => xs.get(p)!);
      const pinXs = [edges[0][0] - 1.6, ...edges.slice(1).map((e, i) => (edges[i][1] + e[0]) / 2), edges[edges.length - 1][1] + 1.6];
      pinXs.forEach((px, i) => {
        const py = yAt(px);
        parts.push(part("metal", cylinder("z", [px, py], 0.18, 0.18, feltTop, hook + 0.15, 6), { pri: 0.5, shadow: false }));
        const from = i > 0 ? edges[i - 1][1] : px, to = i < edges.length ? edges[i][0] : px;
        const pts: Vec3[] = [];
        if (i > 0) pts.push([from, yAt(from), row.zc]);
        pts.push([px, py, hook]);
        if (i < edges.length) pts.push([to, yAt(to), row.zc]);
        parts.push(part("cord", [], { pri: 0.8, shadow: false, strokes: [{ pts, cls: "mb-cord" }] }));
      });
    }

    // The bars, each its own pressable part, with node holes on the side that faces the treble (+x).
    for (const p of row.bars) {
      const [x0, x1] = xs.get(p)!;
      const L = barL(p), yc = row.yc;
      const holes = [yc - L / 2 + NODE * L, yc + L / 2 - NODE * L]
        .map((yy) => decal([x1, yy, row.zc], [0, -1, 0], [0, 0, -1], `<circle class="mb-hole" r="0.32"/>`, [-0.32, -0.32, 0.32, 0.32]));
      const decals = [...holes];
      if (row.id === "n") {
        decals.push(decal([(x0 + x1) / 2, yc + L / 2 - 3.2, row.zc + barT(p) / 2], [1, 0, 0], [0, 1, 0],
          text(0, 0, 2.4, p % 12 === 0 ? noteName(p) : noteName(p)[0])));
      }
      parts.push(part("rosewood", barFaces(x0, x1, yc, row.zc, p), { key: `k${p}`, cls: "key bar", pri: 1, shadow: false, sortFaces: true, decals }));
    }

    // Resonators: one tube under every bar, a quarter wavelength long, its open mouth 3 cm under the bar.
    const top = row.zc - tMax / 2 - 3;
    const floor = 17;
    const tubes = row.bars.map((p) => {
      const [x0, x1] = xs.get(p)!;
      const r = barW(p) / 2 - 0.2, cx = (x0 + x1) / 2;
      const len = Math.max(6, Math.min(top - floor, 34300 / (4 * hz(p)) - 0.61 * r));
      const b = top - len;
      parts.push(part("metal", lathe("z", [cx, row.yc], [[r - 0.35, b], [r, b + 0.5], [r, top - 1], [r, top]], 18, [1, 2]), {
        pri: -0.5, shadow: "tubes",
        decals: [decal([cx, row.yc, top], [1, 0, 0], [0, 1, 0], `<circle class="mb-mouth" r="${(r - 0.2).toFixed(2)}"/>`, [-r, -r, r, r])],
      }));
      return { cx, r };
    });
    // A tie rod through the bank, seen between the tubes, ending on the end frames' beams.
    const zr = top - 4;
    const stops = [FT, ...tubes.flatMap((t) => [t.cx - t.r, t.cx + t.r]), W - FT];
    for (let i = 0; i + 1 < stops.length; i += 2) {
      if (stops[i + 1] - stops[i] < 0.05) continue;
      parts.push(part("metal", cylinder("x", [row.yc, zr], 0.35, 0.35, stops[i], stops[i + 1], 8), { pri: -0.4, shadow: false }));
    }
  }

  // End frames: a top beam under the rails' ends, a riser for the raised row, telescoping legs, a centre
  // post, a cross bar, a foot on two casters.
  const yMid = (yA + yN) / 2;
  const beamTop = zcN - Math.max(...naturals.map(barT)) / 2 - 0.9;
  const beamBot = beamTop - 9;
  const riserTop = zcA - Math.max(...(accs.length ? accs : naturals).map(barT)) / 2 - 0.9;
  const footB = 9.5, footT = 13, crossZ = 26, upperZ = 52;
  for (const end of [0, 1] as const) {
    const fx0 = end ? W - FT : 0, fx1 = fx0 + FT, cxF = fx0 + FT / 2;
    const out = end ? 1 : -1; // outward along x
    const yb = frameY[end][0] - 2, yf = frameY[end][1] + 2;
    const riserY = accFront[end];
    parts.push(part("body", box(fx0, yb, beamBot, fx1, yf, beamTop), { shadow: "frame" }));
    if (accs.length) parts.push(part("body", box(fx0, yb, beamTop, fx1, riserY, riserTop), { shadow: "frame" }));
    const lx0 = cxF - 2, lx1 = cxF + 2;
    for (const [ly0, ly1] of [[yb, yb + 4], [yf - 4, yf]] as const) {
      parts.push(part("body", box(lx0, ly0, 46, lx1, ly1, beamBot), { shadow: "frame" }));
      parts.push(part("metal", box(lx0 + 0.6, ly0 + 0.6, footT, lx1 - 0.6, ly1 - 0.6, 46), { shadow: "frame" }));
      // Height knob on the sleeve's outer face.
      const kx = end ? lx1 : lx0;
      parts.push(part("ebony", lathe("x", [(ly0 + ly1) / 2, 48], [[0.6, kx], [1.3, kx + out * 0.4], [1.3, kx + out * 1.4], [0.9, kx + out * 1.8]], 12, [1, 2]),
        { pri: 1, shadow: false }));
    }
    parts.push(part("body", box(lx0, yb + 4, crossZ - 2, lx1, yf - 4, crossZ + 2), { shadow: "frame" }));
    parts.push(part("body", box(lx0, yMid - 2, crossZ + 2, lx1, yMid + 2, beamBot), { shadow: "frame" }));
    parts.push(part("body", box(fx0 + 0.5, yb - 2, footB, fx1 - 0.5, yf + 2, footT), {
      shadow: "frame",
      decals: [decal([end ? fx1 - 0.5 : fx0 + 0.5, (yb + yf) / 2, (footB + footT) / 2], [0, -out, 0], [0, 0, -1], `<path class="mb-seam" d="M${-(yf - yb) / 2 - 1.5} 0H${(yf - yb) / 2 + 1.5}"/>`, [-(yf - yb) / 2 - 2, -0.2, (yf - yb) / 2 + 2, 0.2])],
    }));
    // Bolts on the beam's outer face where the legs and the post join it.
    const bolts = [yb + 2, yMid, yf - 2].map((yy) => `<circle class="mb-bolt" cx="${(-out * (yy - (yb + yf) / 2)).toFixed(2)}" cy="0" r="0.6"/>`).join("");
    parts.push(part("body", [], {
      pri: 2, shadow: false,
      decals: [decal([end ? fx1 : fx0, (yb + yf) / 2, beamBot + 2.5], [0, -out, 0], [0, 0, -1], bolts, [-(yf - yb) / 2, -0.6, (yf - yb) / 2, 0.6])],
    }));
    // Casters under the foot's ends: plate, king pin, crown, fork cheeks, wheel, axle nuts.
    for (const yc of [yb - 0.5, yf + 0.5]) {
      parts.push(part("metal", cylinder("z", [cxF, yc], 1.8, 1.8, footB - 0.5, footB, 12), { shadow: false }));
      parts.push(part("metal", cylinder("z", [cxF, yc], 0.6, 0.6, 8.1, footB - 0.5, 8), { shadow: false }));
      parts.push(part("metal", box(cxF - 1.3, yc - 1.4, 7.6, cxF + 1.3, yc + 1.4, 8.1), { shadow: false }));
      for (const s of [-1, 1]) {
        const ya = yc + s * 1.05, yo = yc + s * 1.4;
        parts.push(part("metal", box(cxF - 1.3, Math.min(ya, yo), 3, cxF + 1.3, Math.max(ya, yo), 7.6), { shadow: false }));
        parts.push(part("metal", cylinder("y", [cxF, 3.6], 0.5, 0.5, yo, yo + s * 0.35, 6), { pri: 1, shadow: false }));
      }
      parts.push(part("felt", cylinder("y", [cxF, 3.6], 3.6, 3.6, yc - 1, yc + 1, 16), { shadow: false }));
    }
  }

  // Stretchers between the end frames, on the centre line between the banks, and an X brace.
  parts.push(part("metal", cylinder("x", [yMid, crossZ], 1.3, 1.3, FT, W - FT, 12), { shadow: "frame" }));
  parts.push(part("metal", cylinder("x", [yMid, upperZ], 1.2, 1.2, FT, W - FT, 12), { shadow: "frame" }));
  parts.push(part("metal", rod([FT, yMid - 0.7, crossZ + 3], [W - FT, yMid - 0.7, upperZ - 3], 0.5), { pri: -0.2, shadow: false }));
  parts.push(part("metal", rod([FT, yMid + 0.7, upperZ - 3], [W - FT, yMid + 0.7, crossZ + 3], 0.5), { pri: 0.2, shadow: false }));

  // Two yarn mallets resting on the treble end frame, heads on the beam, handles over its front edge.
  const yfT = frameY[1][1] + 2;
  for (const [mx, stagger] of [[W - FT + 1.9, 0], [W - 1.9, 5]] as const) {
    const rh = 1.7, rs = 0.4;
    const head: Vec3 = [mx, yfT - 30 + stagger, beamTop + rh];
    const lip: Vec3 = [mx, yfT, beamTop + rs];
    const dir = [0, lip[1] - head[1], lip[2] - head[2]], n = Math.hypot(dir[1], dir[2]);
    const at = (d: number): Vec3 => [mx, head[1] + (dir[1] / n) * d, head[2] + (dir[2] / n) * d];
    const len = 36 - stagger * 0.4;
    parts.push(part("body", rod(at(rh * 0.8), at(len - 1.2), rs), { pri: 3, shadow: false }));
    parts.push(part("ebony", rod(at(len - 1.2), at(len), rs + 0.12), { pri: 3, shadow: false }));
    const sphere: [number, number][] = [];
    for (let i = 0; i <= 8; i++) sphere.push([rh * Math.sin((Math.PI * i) / 8), head[1] - rh * Math.cos((Math.PI * i) / 8)]);
    parts.push(part("felt", lathe("y", [mx, head[2]], sphere, 14), { pri: 3, shadow: false }));
  }

  const top = zcA + 2;
  return keyboardFigure("mallets", parts, [W, D, top], lo, hi, { min: [FT, 0, zcN - 6], max: [W - FT, D, top + 2] });
}
