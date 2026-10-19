// The Stage's isometric engine (src/stage/iso.ts): projection, solids, and
// the depth order — including the three ordering bugs found while drawing
// the band (contradictory axes, decal-only boxes, loose rotated boxes).
import { describe, expect, it } from "vitest";
import {
  View,
  behind,
  box,
  cylinder,
  decal,
  decalMatrix,
  decalPieces,
  lathe,
  orderByBoxes,
  paintOrder,
  part,
  prism,
  renderScene,
  rod,
  translate,
  type Part,
  type Scene,
  type Turn,
  type Vec3,
} from "../src/stage/iso";
import { bassGuitar, bowed, clarinet, drumKit, flute, grandPiano, guitar, mallets, standKeys, whistle } from "../src/stage/figures";

const TURNS: Turn[] = [0, 1, 2, 3];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const centre = (pts: readonly Vec3[]): Vec3 => pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0] as Vec3);

describe("projection", () => {
  it("is the classic 2:1-ish isometric in the default view", () => {
    const v = new View(0, [0, 0]);
    expect(v.P([1, 0, 0])).toEqual([Math.cos(Math.PI / 6), 0.5]);
    expect(v.P([0, 1, 0])).toEqual([-Math.cos(Math.PI / 6), 0.5]);
    expect(v.P([0, 0, 1])).toEqual([0, -1]);
  });

  it("shows the top and the +x/+y faces from the front; each quarter turn brings a new side round", () => {
    expect(new View(0, [0, 0]).facing([0, 0, 1])).toBe(true);
    expect(new View(0, [0, 0]).facing([1, 0, 0])).toBe(true);
    expect(new View(0, [0, 0]).facing([-1, 0, 0])).toBe(false);
    const seen = TURNS.map((t) => [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]].filter((n) => new View(t, [0, 0]).facing(n as unknown as Vec3)).length);
    expect(seen).toEqual([2, 2, 2, 2]);
    expect(new Set(TURNS.map((t) => JSON.stringify(new View(t, [0, 0]).dir([1, 0, 0]))))).toHaveProperty("size", 4);
  });

  it("keeps z pointing straight up the screen in every view (a key goes down by translateY)", () => {
    for (const t of TURNS) expect(new View(t, [5, 7]).D([0, 0, 1]).map((v) => v + 0)).toEqual([0, -1]);
  });
});

// Isometric draws a far key as large as a near one, which reads as the far end
// growing (reported on the practice keys); `eye` adds two-point perspective.
describe("perspective (eye)", () => {
  const width = (v: View, x: number, y: number) => v.P([x + 1, y, 0])[0] - v.P([x, y, 0])[0];
  it("draws near things larger, keeps verticals vertical, and leaves the centre where it was", () => {
    const iso = new View(0, [50, 50]), v = new View(0, [50, 50], 400);
    expect(width(v, 90, 90)).toBeGreaterThan(width(v, 10, 10) * 1.2);
    for (const [x, y] of [[0, 0], [100, 20], [30, 90]]) expect(v.P([x, y, 0])[0]).toBeCloseTo(v.P([x, y, 40])[0], 9);
    expect(v.P([50, 50, 0])).toEqual(iso.P([50, 50, 0]));
  });

  it("sees exactly the faces whose projected outline keeps its winding", () => {
    const v = new View(0, [50, 50], 300);
    const area = (pts: readonly Vec3[]) => {
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = v.P(pts[i]), b = v.P(pts[(i + 1) % pts.length]);
        s += a[0] * b[1] - b[0] * a[1];
      }
      return s;
    };
    const iso = new View(0, [50, 50]);
    for (let x = -100; x <= 200; x += 25) for (let y = -100; y <= 200; y += 25) for (const f of box(x, y, 0, x + 10, y + 10, 30)) {
      const isoArea = (() => { let s = 0; for (let i = 0; i < f.pts.length; i++) { const a = iso.P(f.pts[i]), b = iso.P(f.pts[(i + 1) % f.pts.length]); s += a[0] * b[1] - b[0] * a[1]; } return s; })();
      if (Math.abs(isoArea) < 1e-9) continue;
      const byWinding = Math.sign(area(f.pts)) === Math.sign(isoArea) ? iso.facing(f.n) : !iso.facing(f.n);
      expect(v.sees(f.pts, f.n)).toBe(byWinding);
    }
  });

  it("is isometric when the eye is far", () => {
    const far = new View(0, [0, 0], 1e9), iso = new View(0, [0, 0]);
    for (const f of [...box(0, 0, 0, 1, 2, 3), ...cylinder("z", [5, 5], 2, 2, 0, 4, 24)]) expect(far.sees(f.pts, f.n)).toBe(iso.facing(f.n));
  });

  it("lays a large decal on its plane in perspective (reviewer: a piano plate's far pins were 15 units off)", () => {
    const v = new View(0, [100, 100], 700);
    const d = decal([0, 0, 50], [1, 0, 0], [0, 1, 0], "", [0, 0, 140, 60]);
    const gap = (m: number[], a: number, b: number) => {
      const want = v.P([a, b, 50]);
      return Math.hypot(m[0] * a + m[2] * b + m[4] - want[0], m[1] * a + m[3] * b + m[5] - want[1]);
    };
    // One matrix for the whole plate is already far better than the origin's axes…
    const one = decalMatrix(v, d);
    expect(Math.max(...[[0, 0], [140, 0], [140, 60], [0, 60]].map(([a, b]) => gap(one, a, b)))).toBeLessThan(3.5);
    // …and the tiles it is drawn in each sit within 0.4 of the plane.
    const pieces = decalPieces(v, d);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      const [x0, y0, x1, y1] = p.clip!;
      for (const [a, b] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [(x0 + x1) / 2, (y0 + y1) / 2]]) expect(gap(p.m, a, b)).toBeLessThan(0.45);
    }
    // A small decal stays one piece, unclipped; isometric never splits.
    expect(decalPieces(v, decal([0, 0, 50], [1, 0, 0], [0, 1, 0], "", [0, 0, 6, 3]))).toHaveLength(1);
    expect(decalPieces(new View(0, [100, 100]), d)).toHaveLength(1);
  });

  it("casts shadows through the same perspective as the objects", () => {
    const v = new View(0, [100, 100], 700);
    for (const p of [[20, 180, 40], [180, 20, 0], [150, 150, 70]] as Vec3[]) expect(v.shadowAt(p, 0)).toEqual(v.P([p[0], p[1], 0]));
  });

  it("renders a scene with an eye", () => {
    const s = renderScene({ ...sceneOf([[part("body", box(0, 0, 0, 10, 10, 10))]]), eye: 300 }, 0);
    expect(s.svg).not.toContain("NaN");
    expect(s.svg).toContain("<path");
  });
});

describe("solids", () => {
  const outward = (faces: ReturnType<typeof box>) => {
    const c = centre(faces.flatMap((f) => f.pts));
    for (const f of faces) expect(dot(f.n, [centre(f.pts)[0] - c[0], centre(f.pts)[1] - c[1], centre(f.pts)[2] - c[2]])).toBeGreaterThan(0);
  };
  it("gives a box, a cylinder and a convex prism outward normals", () => {
    outward(box(0, 0, 0, 2, 3, 4));
    outward(cylinder("z", [1, 1], 2, 2, 0, 3));
    outward(cylinder("x", [0, 5], 1, 0.5, 0, 6));
    outward(prism([[0, 0], [4, 0], [4, 3], [0, 3]], "y", -1, 1));
    // The same outline wound the other way still points outward.
    outward(prism([[0, 3], [4, 3], [4, 0], [0, 0]], "z", 0, 2));
  });

  it("gives a lathe and a rod outward normals, and inks a lathe only at its ends and creases", () => {
    outward(lathe("z", [0, 0], [[2, 0], [3, 2], [3, 6], [1.5, 9]], 16)); // convex: the centroid test only holds for convex shapes
    outward(rod([0, 0, 0], [5, 3, 4], 1, 0.6));
    const bell = lathe("z", [0, 0], [[1, 0], [1, 5], [3, 8]], 12, [1]);
    const rims = bell.filter((f) => f.strip).map((f) => f.strip![3]);
    expect(new Set(rims)).toEqual(new Set([3]));
    const smooth = lathe("z", [0, 0], [[1, 0], [1.2, 1], [1.4, 2]], 12).filter((f) => f.strip).map((f) => f.strip![3]);
    expect(new Set(smooth)).toEqual(new Set([1, 2]));
  });

  it("marks curved strips (inked along rims, not strip by strip)", () => {
    expect(cylinder("z", [0, 0], 1, 1, 0, 1, 12).filter((f) => f.strip)).toHaveLength(12);
    expect(prism([[0, 0], [1, 0], [0, 1]], "z", 0, 1).some((f) => f.strip)).toBe(false);
    expect(prism([[0, 0], [1, 0], [0, 1]], "z", 0, 1, true).filter((f) => f.strip)).toHaveLength(3);
  });

  it("bounds a decal-only part by its decal's rect, not its origin", () => {
    const dotPart = part("cell", [], { decals: [decal([10, 5, 20], [1, 0, 0], [0, 0, -1], "<circle r='1'/>", [-1, -1, 1, 1])] });
    expect(dotPart.box.min).toEqual([9, 5, 19]);
    expect(dotPart.box.max).toEqual([11, 5, 21]);
  });
});

describe("depth order", () => {
  const sortable = (min: Vec3, max: Vec3, extra: Partial<{ depth: number; pri: number }> = {}) => ({
    vmin: min, vmax: max, sx0: 0, sy0: 0, sx1: 1, sy1: 1, depth: extra.depth ?? 0, pri: extra.pri ?? 0,
  });

  it("orders boxes by the axis that separates them (the viewer is at +x, +y, +z)", () => {
    expect(behind(sortable([0, 0, 0], [1, 1, 1]), sortable([1, 0, 0], [2, 1, 1]))).toBe(true);
    expect(behind(sortable([0, 0, 2], [1, 1, 3]), sortable([0, 0, 0], [1, 1, 2]))).toBe(false);
    expect(behind(sortable([0, 0, 0], [2, 2, 2]), sortable([1, 1, 1], [3, 3, 3]))).toBe(null);
  });

  it("calls two boxes apart when two axes disagree — behind on one, above on the other", () => {
    // A raised lid (behind in y, above in z) and a key in front of it.
    const lid = sortable([0, 0, 10], [10, 5, 20]);
    const key = sortable([0, 5, 0], [10, 8, 2]);
    expect(behind(lid, key)).toBe("apart");
  });

  it("draws a grand piano's keybed before every key, from all four sides", () => {
    const piano = grandPiano(48, 84);
    for (const t of TURNS) {
      const order = orderOf(piano.parts, t);
      // The keybed: the case part whose top the white keys rest on, under them in plan.
      const white = piano.parts.filter((p) => p.key && p.mat === "ivory");
      const keyFloor = Math.min(...white.map((p) => p.box.min[2]));
      const keybed = piano.parts.findIndex((p) => !p.key && Math.abs(p.box.max[2] - keyFloor) < 0.6 &&
        p.box.min[0] <= white[0].box.min[0] && p.box.max[0] >= white[white.length - 1].box.max[0]);
      expect(keybed).toBeGreaterThanOrEqual(0);
      const keyIdx = piano.parts.flatMap((p, i) => (p.key ? [i] : []));
      expect(keyIdx).toHaveLength(88);
      for (const k of keyIdx) expect(order.indexOf(keybed)).toBeLessThan(order.indexOf(k));
    }
  });

  it("draws a fret dot after the fingerboard it sits on (decal-only parts are ordered by their rect)", () => {
    const cello = bowed("cello");
    // The fingerboard faces +y, which the viewer sees from turns 0 and 1.
    for (const t of [0, 1] as Turn[]) {
      const order = orderOf(cello.parts, t);
      const board = cello.parts.findIndex((p) => p.mat === "ebony" && p.decals.some((d) => d.svg.includes("tape")));
      const cells = cello.parts.flatMap((p, i) => (p.cls === "cell" ? [i] : []));
      expect(cells.length).toBeGreaterThan(40);
      for (const c of cells) expect(order.indexOf(board)).toBeLessThan(order.indexOf(c));
    }
  });

  it("breaks a cycle instead of dropping parts", () => {
    const a = { ...sortable([0, 0, 0], [1, 1, 1], { depth: 1 }) };
    const b = { ...sortable([0, 0, 0], [1, 1, 1], { depth: 2 }) };
    expect(orderByBoxes([b, a])).toEqual([a, b]);
  });
});

describe("every figure renders from every side", () => {
  const figures = {
    grand: grandPiano(48, 84),
    keys: standKeys(55, 79, "Flute"),
    mallets: mallets(60, 84),
    drums: drumKit(),
    guitar: guitar(false),
    electric: guitar(true),
    bass: bassGuitar(),
    violin: bowed("violin"),
    cello: bowed("cello"),
    flute: flute(),
    whistle: whistle(),
    clarinet: clarinet(),
  };
  it.each(Object.entries(figures))("%s: no NaN, every pressable part drawn, inside its declared size", (_, fig) => {
    for (const t of TURNS) {
      const { svg } = renderScene(sceneOf([fig.parts]), t);
      expect(svg).not.toContain("NaN");
      expect(svg).not.toContain("Infinity");
    }
    for (const p of fig.parts) {
      for (let i = 0; i < 3; i++) {
        expect(p.box.min[i]).toBeGreaterThanOrEqual(-0.5 - (i === 2 ? 0 : 20));
        expect(p.box.max[i]).toBeLessThanOrEqual(fig.size[i] + 25);
      }
    }
  });
});

/** A one-object scene on a floor, for rendering figures alone. */
function sceneOf(objects: Part[][]): Scene {
  return {
    back: [],
    floor: [part("floor", box(-50, -50, -2, 300, 300, 0))],
    floorTop: [[-50, -50, 0], [300, -50, 0], [300, 300, 0], [-50, 300, 0]],
    floorZ: 0,
    objects: objects.map((parts, i) => ({ id: `o${i}`, parts: translate(parts, [0, 0, 0]) })),
    center: [100, 100],
  };
}

/** Paint order of a figure's parts in a view, as indices into `parts`. */
function orderOf(parts: Part[], t: Turn): number[] {
  return paintOrder(parts, new View(t, [100, 100])).map((p) => parts.indexOf(p));
}
