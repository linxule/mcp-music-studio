/**
 * @file The band: one figure per player, laid out in columns with every
 * player's side toward +y. No room around them — the instruments stand on the
 * paper, the way Anatomy draws an object on its card.
 */
import {
  bowed,
  bassGuitar,
  clarinet,
  drumKit,
  flute,
  grandPiano,
  guitar,
  keyRange,
  mallets,
  standKeys,
  whistle,
  type Figure,
} from "./figures";
import { add, translate, type Scene, type Vec3 } from "./iso";
import { bowedKind, isElectric, type Player } from "./stage-model";

export interface Placed {
  player: Player;
  figure: Figure;
  /** Where the figure's frame sits in the room. */
  offset: Vec3;
  /** Top centre of the figure, where its name tag points. */
  top: Vec3;
  /** What a close-up frames, in room coordinates. */
  focus: { min: Vec3; max: Vec3 };
}

export interface Stage {
  scene: Scene;
  placed: Placed[];
}

export function figureOf(player: Player): Figure {
  switch (player.figure) {
    case "grand": return grandPiano(...keyRange(player.low, player.high, 4));
    case "mallets": return mallets(...keyRange(player.low, player.high, 3));
    case "drums": return drumKit();
    case "guitar": return guitar(isElectric(player.program));
    case "ebass": return bassGuitar();
    case "bowed": return bowed(bowedKind(player.program));
    case "flute": return flute();
    case "whistle": return whistle();
    case "clarinet": return clarinet();
    default: return standKeys(...keyRange(player.low, player.high, 4), shortLabel(player.label));
  }
}

/** The name on a keyboard's screen: the instrument, not its family. */
const shortLabel = (label: string) => label.replace(/\s*\(.*\)$/, "").slice(0, 16);

const MARGIN = 34;
const GAP = 16;
/**
 * Where the eye is, in drawing units (≈ cm): a seat about 7 m back. Pure
 * isometric draws far things as large as near ones, which reads as the far end
 * of a long keyboard growing; a little perspective puts that right. The dev
 * page overrides it with ?eye= (0 = isometric).
 */
const EYE = 700;

/**
 * Lay the band out in one row, tallest first, level across the screen.
 */
export function buildStage(players: readonly Player[], _title?: string): Stage {
  const figures = players.map((player) => ({ player, figure: figureOf(player) }));
  // The row runs along (+x, −y): in the fixed view that is straight across the
  // screen, so the band is as wide and as low as the panel it sits in. Every
  // figure's centre keeps x + y constant (the same height on screen), and each
  // starts where the last one's silhouette ends (screen x ∝ x − y). Nothing
  // stands in front of anything, so every keyboard and fingerboard (facing the
  // lower left, +y) is clear; tallest first keeps the skyline falling away.
  const row = [...figures].sort((a, b) => b.figure.size[2] - a.figure.size[2]);
  let cursor = 0;
  const raw: { player: Player; figure: Figure; offset: Vec3 }[] = [];
  for (const { player, figure } of row) {
    const [w, d] = figure.size;
    const cx = (cursor + (w + d) / 2) / 2;
    raw.push({ player, figure, offset: [cx - w / 2, -cx - d / 2, 0] });
    cursor += w + d + GAP;
  }
  const minX = Math.min(...raw.map((r) => r.offset[0]));
  const minY = Math.min(...raw.map((r) => r.offset[1]));
  const placed: Placed[] = [];
  const objects: Scene["objects"] = [];
  let W = 0, D = 0;
  for (const { player, figure, offset: o } of raw) {
    const offset: Vec3 = [o[0] - minX + MARGIN, o[1] - minY + MARGIN, 0];
    W = Math.max(W, offset[0] + figure.size[0] + MARGIN);
    D = Math.max(D, offset[1] + figure.size[1] + MARGIN);
    placed.push({
      player,
      figure,
      offset,
      top: [offset[0] + figure.size[0] / 2, offset[1] + figure.size[1] / 2, figure.size[2]],
      focus: figure.focus
        ? { min: add(figure.focus.min, offset), max: add(figure.focus.max, offset) }
        : { min: offset, max: add(offset, figure.size) },
    });
    objects.push({ id: player.id, cls: "inst", parts: translate(figure.parts, offset) });
  }
  // Keep the players' order (the melody first) for keyboard shortcuts and captions.
  placed.sort((a, b) => players.indexOf(a.player) - players.indexOf(b.player));
  // No room: the instruments stand on the paper, each with a soft halo below
  // (the shadow layer, clipped to the band's footprint).
  return {
    scene: {
      back: [],
      floor: [],
      floorTop: [[0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0]],
      floorZ: 0,
      objects,
      center: [W / 2, D / 2],
      eye: (globalThis as { __STAGE_EYE?: number }).__STAGE_EYE ?? EYE,
    },
    placed,
  };
}
