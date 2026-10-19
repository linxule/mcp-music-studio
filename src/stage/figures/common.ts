/** @file Stage figures: common (split from src/stage/figures.ts; see its header for conventions). */
import { box, cylinder, decal, escapeXml, part, rotate, type Box3, type Face, type Part, type Vec3 } from "../iso";
import { fingeringFor, pitchForKey, type FingeringChart } from "../fingerings";

export type FigureKind = "grand" | "keys" | "drums" | "mallets" | "guitar" | "ebass" | "bowed" | "flute" | "whistle" | "clarinet";

export interface Figure {
  kind: FigureKind;
  parts: Part[];
  /** Footprint x, y and height. */
  size: Vec3;
  /** Part keys to light for these sounding pitches. */
  light(pitches: readonly number[]): string[];
  /** The pitch a pressed part sounds, or null. */
  pitchOf(key: string): number | null;
  /**
   * What a close-up frames: where the hands go (the keys, the first
   * positions of a fingerboard, the tone holes). The whole figure if absent.
   */
  focus?: Box3;
}

// -----------------------------------------------------------------------------
// Pitches
// -----------------------------------------------------------------------------

export const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
export const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
export const noteName = (p: number) => `${NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;

/**
 * The keys to draw for notes spanning low..high: whole octaves C..C, at least
 * two, at most `maxOctaves`; when the notes need more, the range keeps the
 * middle of them.
 */
export function keyRange(low: number, high: number, maxOctaves = 5): [number, number] {
  if (!(low <= high)) [low, high] = [60, 60];
  let lo = 12 * Math.floor(low / 12);
  let hi = 12 * Math.ceil((high + 1) / 12);
  while (hi - lo < 24) {
    if (60 - lo > hi - 60) hi += 12;
    else lo -= 12;
  }
  while (hi - lo > maxOctaves * 12) {
    const mid = (low + high) / 2;
    if (mid - lo > hi - mid) lo += 12;
    else hi -= 12;
  }
  return [Math.max(0, lo), Math.min(127, hi)];
}

/** Bring a pitch into lo..hi by octaves (an out-of-range note still lights a key). */
export function fold(p: number, lo: number, hi: number): number {
  while (p < lo) p += 12;
  while (p > hi) p -= 12;
  return p < lo ? lo : p;
}

// -----------------------------------------------------------------------------
// Shared pieces
// -----------------------------------------------------------------------------

/** A real keyboard's proportions (a white key is 2.35 × 15 cm), a little over 1 unit per cm. */
export const WHITE_W = 3.2;
export const WHITE_L = 15;
export const WHITE_H = 1.8;
export const BLACK_W = 1.9;
export const BLACK_L = 9.5;
export const BLACK_H = 1.5;
/** A grand has all 88 keys, A0–C8; a stage keyboard 61, C2–C7, more if the music needs them. */
export const GRAND_RANGE: readonly [number, number] = [21, 108];
export const STAGE_RANGE: readonly [number, number] = [36, 96];

/** Faces of a solid without the ones facing `skip` (to give a drum a separate head). */
export const without = (faces: Face[], ...skip: Vec3[]) =>
  faces.filter((f) => !skip.some((s) => f.n[0] * s[0] + f.n[1] * s[1] + f.n[2] * s[2] > 0.99));

export const text = (x: number, y: number, size: number, str: string, cls = "lbl") =>
  `<text class="${cls}" x="${x}" y="${y}" font-size="${size}" text-anchor="middle">${escapeXml(str)}</text>`;

/**
 * A keyboard: white keys along +x from (x0, y0) with their fronts at
 * y0 + WHITE_L, black keys on top. Returns the parts, the width, and where
 * a pitch's white key (or the one below a black key) starts.
 */
export function keyboard(lo: number, hi: number, x0: number, y0: number, z0: number): { parts: Part[]; width: number; xOf(p: number): number } {
  const parts: Part[] = [];
  let whites = 0;
  const whiteX = new Map<number, number>();
  for (let p = lo; p <= hi; p++) {
    if (isBlack(p)) continue;
    const x = x0 + whites * WHITE_W;
    whiteX.set(p, x);
    whites++;
    const name = noteName(p);
    const label = p % 12 === 0 ? name : name[0];
    parts.push(
      part("ivory", box(x + 0.18, y0, z0, x + WHITE_W - 0.18, y0 + WHITE_L, z0 + WHITE_H), {
        key: `k${p}`,
        cls: p % 12 === 0 ? "key c" : "key",
        pri: 1,
        shadow: false,
        decals: [
          decal([x + WHITE_W / 2, y0 + WHITE_L - 2.2, z0 + WHITE_H], [1, 0, 0], [0, 1, 0], text(0, 0, 1.9, label)),
        ],
      }),
    );
  }
  for (let p = lo; p <= hi; p++) {
    if (!isBlack(p)) continue;
    const left = whiteX.get(p - 1);
    if (left === undefined) continue;
    const cx = left + WHITE_W;
    parts.push(
      part("ebony", box(cx - BLACK_W / 2, y0, z0 + WHITE_H, cx + BLACK_W / 2, y0 + BLACK_L, z0 + WHITE_H + BLACK_H), {
        key: `k${p}`,
        cls: "key b",
        pri: 2,
        shadow: false,
      }),
    );
  }
  const xOf = (p: number) => {
    let q = Math.max(lo, Math.min(hi, p));
    while (isBlack(q) && q > lo) q--;
    return whiteX.get(q) ?? x0;
  };
  return { parts, width: whites * WHITE_W, xOf };
}

/** The close-up box over the keys the music uses, a key's width to spare each side. */
export const keysFocus = (kb: { xOf(p: number): number }, lo: number, hi: number, y0: number, y1: number, z0: number, z1: number): Box3 => ({
  min: [kb.xOf(lo) - WHITE_W, y0, z0],
  max: [kb.xOf(hi) + 2 * WHITE_W, y1, z1],
});

export function keyboardFigure(kind: FigureKind, parts: Part[], size: Vec3, lo: number, hi: number, focus?: Box3): Figure {
  return {
    kind,
    parts,
    size,
    ...(focus ? { focus } : {}),
    light: (pitches) => pitches.map((p) => `k${fold(p, lo, hi)}`),
    pitchOf: (key) => (/^k\d+$/.test(key) ? Number(key.slice(1)) : null),
  };
}

/** A cylindrical drum: a shell in the body colour and a head on each open end. */
export function drum(
  key: string,
  axis: "x" | "y" | "z",
  c: readonly [number, number],
  r: number,
  from: number,
  to: number,
  opts: { pri?: number; shadow?: string; heads?: "both" | "top" } = {},
): Part[] {
  const faces = cylinder(axis, c, r, r, from, to, 22);
  const up: Vec3 = axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
  const down: Vec3 = [-up[0], -up[1], -up[2]];
  const heads = faces.filter((f) => Math.abs(f.n[0] * up[0] + f.n[1] * up[1] + f.n[2] * up[2]) > 0.99);
  const shared = { key, pri: opts.pri ?? 0, ...(opts.shadow ? { shadow: opts.shadow } : {}) };
  return [
    part("body", without(faces, up, down), { ...shared, cls: "drum" }),
    part("head", opts.heads === "top" ? heads.filter((f) => f.n[2] > 0) : heads, {
      ...shared,
      cls: "drum head",
      pri: (opts.pri ?? 0) + 0.5,
    }),
  ];
}

/** A cymbal: a shallow cone, tilted `tilt` degrees, floating where a stand would hold it. */
export function cymbal(key: string, x: number, y: number, z: number, r: number, tilt = 8): Part[] {
  let faces = cylinder("z", [x, y], r, r * 0.22, z, z + 1.4, 24);
  faces = rotate(faces, "x", tilt, [x, y, z]);
  return [part("brass", faces, { key, cls: "cym", pri: 3, shadow: key })];
}

/** Instruments without legs float at playing height: no stands, a shadow below. */
export const FLOAT = 16;

// -----------------------------------------------------------------------------
// Keyed woodwinds: the silver Boehm flute, the B♭ clarinet
// -----------------------------------------------------------------------------

/** Lights for a keyed woodwind: the breath, and the chart's keys for the top note (none if unverified). */
export function woodwindLight(chart: FingeringChart) {
  return (pitches: readonly number[]): string[] => {
    if (!pitches.length) return [];
    const keys = fingeringFor(chart, Math.max(...pitches));
    return ["blow", ...(keys ?? [])];
  };
}

/** Pressing a key or the mouthpiece plays what the chart says it plays (fingerings.ts pitchForKey). */
export const woodwindPitch = (chart: FingeringChart) => (key: string): number | null => pitchForKey(chart, key === "blow" ? "" : key);
