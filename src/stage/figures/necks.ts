/** @file Stage figures: necks (split from src/stage/figures.ts; see its header for conventions). */
import { decal, part, type Box3, type Part, type Vec3 } from "../iso";
import { FLOAT, type Figure, type FigureKind, fold } from "./common";

// -----------------------------------------------------------------------------
// Strings: guitar, bass guitar, violin family
// -----------------------------------------------------------------------------

/** Where a string is stopped to sound `pitch` — or folded by octaves into reach. */
export interface Stop { string: number; fret: number }

/**
 * Choose a string and fret for each pitch, at most one note per string: the
 * hand position a teacher would show first (low frets, a narrow span, open
 * strings welcome). Brute force — a chord has at most as many notes as the
 * instrument has strings.
 */
export function assignStops(pitches: readonly number[], tuning: readonly number[], maxFret: number): Stop[] {
  const lowest = tuning[0], highest = tuning[tuning.length - 1] + maxFret;
  const wanted = [...new Set(pitches.map((p) => fold(p, lowest, highest)))].sort((a, b) => a - b).slice(0, tuning.length);
  let best: Stop[] = [];
  let bestCost = Infinity;
  const used = new Array<boolean>(tuning.length).fill(false);
  const chosen: Stop[] = [];
  const walk = (i: number) => {
    if (i === wanted.length) {
      const fretted = chosen.filter((s) => s.fret > 0).map((s) => s.fret);
      const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0;
      const cost = chosen.reduce((sum, s) => sum + s.fret, 0) + span * 3 + (span > 4 ? 40 : 0);
      if (cost < bestCost) { bestCost = cost; best = chosen.map((s) => ({ ...s })); }
      return;
    }
    for (let s = 0; s < tuning.length; s++) {
      const fret = wanted[i] - tuning[s];
      if (used[s] || fret < 0 || fret > maxFret) continue;
      used[s] = true;
      chosen.push({ string: s, fret });
      walk(i + 1);
      chosen.pop();
      used[s] = false;
    }
  };
  walk(0);
  return best;
}

export interface NeckSpec {
  tuning: number[];
  frets: number;
  /** Nut and bridge heights, and string spread (half-width) at each. */
  nutZ: number;
  bridgeZ: number;
  nutHalf: number;
  bridgeHalf: number;
  /** The front plane the strings lie on. */
  y: number;
  fretted: boolean;
  /** Fretless: the finger a beginner uses for stop k ("0" = open string). */
  finger?: (k: number) => string;
  /**
   * Where string i is anchored past the bridge (tailpiece, bridge pins) and
   * past the nut (its peg). A string runs anchor → over the bridge → along
   * the neck → over the nut → peg, touching each; without these it floated
   * between bridge and nut with both ends loose.
   */
  tail: (i: number) => Vec3;
  head: (i: number) => Vec3;
  /**
   * Points string i touches between the nut and its peg (a string tree that
   * pulls it down onto the headstock). Optional; none by default.
   */
  via?: (i: number) => Vec3[];
  /** An extra class on every string (a bass's heavier gauge). */
  wire?: string;
}

/** Height of fret/position k between nut and bridge (equal temperament). */
export const stopZ = (n: NeckSpec, k: number) => n.nutZ - (n.nutZ - n.bridgeZ) * (1 - 2 ** (-k / 12));
export const stringX = (n: NeckSpec, i: number, z: number) => {
  const t = (n.nutZ - z) / (n.nutZ - n.bridgeZ);
  const half = n.nutHalf + (n.bridgeHalf - n.nutHalf) * t;
  return -half + (2 * half * i) / (n.tuning.length - 1);
};

/**
 * The playable surface of a neck: one string part each (it rings) and a cell
 * per string and stop (press it to play that note; it shows a dot when the
 * music stops the string there).
 */
export function neckParts(n: NeckSpec): Part[] {
  const parts: Part[] = [];
  const strings = n.tuning.length;
  const front = n.y + 0.4;
  for (let i = 0; i < strings; i++) {
    parts.push(
      part("metal", [], {
        key: `s${i}`,
        cls: "str",
        pri: 5,
        shadow: false,
        strokes: [{
          pts: [n.tail(i), [stringX(n, i, n.bridgeZ), front, n.bridgeZ], [stringX(n, i, n.nutZ), front, n.nutZ], ...(n.via?.(i) ?? []), n.head(i)],
          cls: `wire w${i}${n.wire ? " " + n.wire : ""}`,
        }],
      }),
    );
    for (let k = 0; k <= n.frets; k++) {
      // The open string's cell sits just above the nut, like a chord chart's ○.
      const top = k === 0 ? n.nutZ + 3.2 : stopZ(n, k - 1);
      const bottom = k === 0 ? n.nutZ + 0.4 : stopZ(n, k);
      const zc = k === 0 ? n.nutZ + 1.8 : bottom + (top - bottom) * 0.42;
      const xc = stringX(n, i, zc);
      const spacing = (2 * Math.abs(stringX(n, 0, zc))) / (strings - 1);
      const w = spacing;
      const r = Math.min(1.6, spacing * 0.42, (top - bottom) * 0.38);
      parts.push(
        part("cell", [], {
          key: `s${i}f${k}`,
          cls: "cell",
          pri: 6,
          shadow: false,
          decals: [
            decal([xc, front + 0.2, zc], [1, 0, 0], [0, 0, -1],
              `<rect class="hit" x="${-w / 2}" y="${-(top - zc)}" width="${w}" height="${top - bottom}"/>` +
              (k === 0 ? `<circle class="dot open" r="${r}"/>` : `<circle class="dot" r="${r}"/>`) +
              (n.finger ? `<text class="fing" y="${r * 0.42}" font-size="${r * 1.25}" text-anchor="middle">${n.finger(k)}</text>` : ""),
              [-w / 2, -(top - zc), w / 2, zc - bottom]),
          ],
        }),
      );
    }
  }
  return parts;
}

/** The same neck raised by FLOAT (the spec's heights are before the lift). */
export const liftNeck = (n: NeckSpec): NeckSpec => ({ ...n, nutZ: n.nutZ + FLOAT, bridgeZ: n.bridgeZ + FLOAT });

/** A neck's close-up: the nut down to the ninth stop — first position and a little past it. */
export const neckFocus = (n: NeckSpec, at: Vec3): Box3 => ({
  min: [at[0] - n.bridgeHalf - 2, at[1], stopZ(n, 9)],
  max: [at[0] + n.bridgeHalf + 2, at[1] + n.y + 2, n.nutZ + 4],
});

export function neckFigure(kind: FigureKind, parts: Part[], size: Vec3, n: NeckSpec, at: Vec3, extra: string[] = []): Figure {
  return {
    kind,
    parts,
    size,
    focus: neckFocus(n, at),
    light(pitches) {
      const keys: string[] = [];
      for (const s of assignStops(pitches, n.tuning, n.frets)) keys.push(`s${s.string}`, `s${s.string}f${s.fret}`);
      return keys.length ? keys.concat(extra) : keys;
    },
    pitchOf(key) {
      const m = /^s(\d+)(?:f(\d+))?$/.exec(key);
      if (!m) return null;
      const open = n.tuning[Number(m[1])];
      return open === undefined ? null : open + Number(m[2] ?? 0);
    },
  };
}

/** A body outline in the (x, z) plane from half-widths at heights, smoothed. */
export function bodyOutline(ctrl: readonly (readonly [number, number])[], z0: number): [number, number][] {
  const right: [number, number][] = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const [za, wa] = ctrl[i], [zb, wb] = ctrl[i + 1];
    // Catmull-Rom through the control points: smooth across them. (Cosine easing between
    // pairs flattened the edge at every control point, and a cello's sides rippled.)
    const [zp, wp] = ctrl[Math.max(0, i - 1)], [zn, wn] = ctrl[Math.min(ctrl.length - 1, i + 2)];
    for (let s = 0; s < 8; s++) {
      const t = s / 8, t2 = t * t, t3 = t2 * t;
      const cr = (p0: number, p1: number, p2: number, p3: number) =>
        0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
      right.push([Math.max(0, cr(wp, wa, wb, wn)), z0 + cr(zp, za, zb, zn)]);
    }
  }
  right.push([ctrl[ctrl.length - 1][1], z0 + ctrl[ctrl.length - 1][0]]);
  const left = right.slice(1, -1).reverse().map(([x, z]) => [-x, z] as [number, number]);
  return right.concat(left);
}
