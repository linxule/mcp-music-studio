/**
 * @file The Stage's DOM: draws the band (src/stage/room.ts) into an SVG from
 * one fixed angle, follows the transport, and lets you play the instruments.
 *
 * - Every frame it asks the host where playback is and lights what sounds
 *   (`on`), what a muted practice voice would play (`yours`) and what starts
 *   within a beat (`next`) — class toggles on parts drawn once.
 * - Press a key, a drum, a string stop: it sounds through the host while it is
 *   held; slide to the next one without lifting. The computer keyboard plays
 *   the instrument you are looking at, two rows like a DAW's (z–/ and q–]),
 *   ← → shift the octave.
 * - Press an instrument to look at it from the player's seat, with note
 *   names; the ✕ or Esc steps back. Digits 1–9 pick one.
 * - **Join** takes over an instrument's part: its voices go quiet in the
 *   playback, its notes stay lit as "your part", the keys show their letters,
 *   and a MIDI keyboard (where the browser allows Web MIDI) plays every key.
 *
 * The look follows Anatomy's discipline: paper-coloured solids, form carried
 * by line tones, and colour only for the playing (src/stage/stage.css).
 */
import { noteName } from "./figures";
import { escapeXml, renderScene, type Rect, View } from "./iso";
import { buildStage, type Placed, type Stage } from "./room";
import { momentAt, type Player } from "./stage-model";
import { TAP_SLOP_PX } from "../audio-unlock";

export interface StageHost {
  /** Playback position (seconds into the audio) and whether it is moving. */
  position(): { t: number; running: boolean };
  /** Start a note on an instrument (GM program; 128 = drums); velocity 1–127. */
  noteOn(program: number, pitch: number, velocity?: number): void;
  /** Let it go. */
  noteOff(program: number, pitch: number): void;
  /** You take over `player`'s part (its voices go quiet), or hand it back (null). */
  join?(player: Player | null): void;
}

type Lights = Record<"on" | "yours" | "next", Set<string>>;

const SVG_NS = "http://www.w3.org/2000/svg";
/**
 * Letters → semitones above the window's lowest C: two rows, as trackers and
 * DAWs lay out a computer keyboard — z s x d c … for the lower octave and a
 * half, q 2 w 3 e … an octave up — 2½ octaves under two hands.
 */
const LOWER_ROW = "zsxdcvgbhnjm,l.;/";
const UPPER_ROW = "q2w3er5t6y7ui9o0p[=]";
const WINDOW = 12 + UPPER_ROW.length - 1;
/** Kinds whose keys carry their letter when you join. */
const LABELLED = new Set(["grand", "keys", "mallets"]);
/** A tap is a short press: long enough to hear the note bloom. */
const TAP_HOLD_MS = 450;
/** Letters → drum pieces, low row left to right. */
const DRUM_ROW: Record<string, number> = { z: 36, x: 38, c: 42, v: 48, b: 45, n: 41, m: 49, ",": 51, ".": 76 };
const MIN_PRESS_MS = 110;

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export class StageView {
  readonly el: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly art: SVGGElement;
  private readonly fig: HTMLElement;
  private readonly name: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly back: HTMLButtonElement;
  private readonly mode: HTMLButtonElement;
  /** Close-up framing: the whole instrument, or (default) where the hands go. */
  private whole = false;
  private objectRects = new Map<string, Rect>();
  /** The framed view zoom and pan are measured from. */
  private fitBox: Rect = [0, 0, 100, 100];
  /** A mouse drag on the drawing (not on a key) pans it; a drag must not also click. */
  private drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  private dragged = false;

  private stage: Stage | null = null;
  private signature = "";
  private title = "";
  private focus: string | null = null;
  private index = new Map<string, Map<string, Element[]>>();
  private lights = new Map<string, Lights>();
  private bandRect: Rect = [0, 0, 100, 100];
  private viewBox: Rect = [0, 0, 100, 100];
  private viewAnim = 0;
  private raf = 0;
  private lastT = NaN;
  private lookahead = 0.45;
  /**
   * Every pointer on a part. A mouse presses at once and can glide; a touch is
   * only a tap candidate until it lifts within TAP_SLOP_PX — a scroll that
   * starts on the Stage must not play a note (the 0.5.9 iOS lesson,
   * src/audio-unlock.ts TapTracker), and `preventDefault` on pointerdown cannot
   * stop a pan under `touch-action: manipulation`.
   */
  private pointers = new Map<number, { obj: string; key: string; at: number; x: number; y: number; touch: boolean }>();
  /** Held parts; `serial` lets a delayed release free only its own press. */
  private held = new Map<string, { obj: string; keys: string[]; serial: number; program?: number; pitch?: number }>();
  private serial = 0;
  /** The part you are playing (a player id), if you joined one. */
  private joined: string | null = null;
  /** Where each instrument's letter window starts (its lowest C), once moved. */
  private bases = new Map<string, number>();
  private readonly join: HTMLButtonElement;
  private readonly midi: HTMLButtonElement;
  private readonly labels: SVGGElement;
  private notice = "";
  private noticeTimer = 0;
  /** MIDI pitches held by the sustain pedal after their key came up. */
  private sustained = new Set<number>();
  private pedal = false;

  constructor(private readonly host: StageHost) {
    this.el = document.createElement("section");
    this.el.className = "stage";
    this.el.tabIndex = 0;
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Stage: the instruments playing this score. Press keys, drums and strings to play them.");
    this.el.innerHTML = `
      <div class="stage-cap tl"><span class="stage-fig">Fig. 1</span>
        <span class="stage-zoom">
          <button class="stage-btn" data-act="out" title="Zoom out (−)" aria-label="Zoom out">−</button>
          <button class="stage-btn" data-act="in" title="Zoom in (+)" aria-label="Zoom in">+</button>
          <button class="stage-btn" data-act="fit" title="Fit (0)" aria-label="Fit the view">fit</button>
        </span></div>
      <div class="stage-cap tr"><span class="stage-name"></span>
        <button class="stage-btn" data-act="mode" title="Frame the whole instrument, or just where the hands go" hidden>whole</button>
        <button class="stage-btn" data-act="join" title="Play this part yourself: it goes quiet in the playback and shows you what to play" hidden>join</button>
        <button class="stage-btn" data-act="midi" title="Play with a MIDI keyboard" hidden>midi</button>
        <button class="stage-btn" data-act="back" title="Back to the band (Esc)" aria-label="Back to the band" hidden>✕</button></div>
      <div class="stage-cap bl"></div>
      <div class="stage-cap br" aria-live="off"></div>`;
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("stage-svg");
    this.svg.setAttribute("role", "img");
    this.svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    this.art = document.createElementNS(SVG_NS, "g");
    this.labels = document.createElementNS(SVG_NS, "g");
    this.labels.classList.add("kbd-layer");
    this.svg.append(this.art, this.labels);
    this.el.insertBefore(this.svg, this.el.querySelector(".stage-cap.bl"));
    this.fig = this.el.querySelector(".stage-fig")!;
    this.name = this.el.querySelector(".stage-name")!;
    this.readout = this.el.querySelector(".stage-cap.br")!;
    this.hint = this.el.querySelector(".stage-cap.bl")!;
    this.back = this.el.querySelector('[data-act="back"]')!;
    this.back.addEventListener("click", () => this.setFocus(null));
    this.mode = this.el.querySelector('[data-act="mode"]')!;
    this.mode.addEventListener("click", () => {
      this.whole = !this.whole;
      this.caption();
      this.frame(true);
    });
    this.join = this.el.querySelector('[data-act="join"]')!;
    this.join.addEventListener("click", () => this.setJoined(this.joined ? null : this.focus));
    this.midi = this.el.querySelector('[data-act="midi"]')!;
    this.midi.addEventListener("click", () => void this.connectMidi());
    this.el.querySelector('[data-act="in"]')!.addEventListener("click", () => this.zoomBy(1.6));
    this.el.querySelector('[data-act="out"]')!.addEventListener("click", () => this.zoomBy(1 / 1.6));
    this.el.querySelector('[data-act="fit"]')!.addEventListener("click", () => this.frame(true));
    // Zoom: ⌘/Ctrl + scroll and trackpad pinches (which arrive as ctrl + wheel); a
    // plain scroll still scrolls the page. Double-click zooms in, Shift out.
    this.svg.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    }, { passive: false });
    this.svg.addEventListener("dblclick", (e) => {
      if ((e.target as Element).closest("[data-k]")) return;
      e.preventDefault();
      this.zoomBy(e.shiftKey ? 1 / 1.8 : 1.8, e.clientX, e.clientY);
    });
    this.svg.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    // Looking closer is a click: browsers don't fire one after a pan.
    this.svg.addEventListener("click", (e) => this.onClick(e));
    this.svg.addEventListener("pointermove", (e) => this.onPointerMove(e));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
      this.svg.addEventListener(type, (e) => this.onPointerUp(e as PointerEvent));
    }
    this.el.addEventListener("keydown", (e) => this.onKey(e, true));
    this.el.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => this.releaseAll());
    // Focus leaving the Stage takes its held letters with it (their keyup goes elsewhere).
    this.el.addEventListener("focusout", (e) => {
      if (!this.el.contains(e.relatedTarget as Node | null)) this.releaseAll();
    });
  }

  // ---------------------------------------------------------------------------
  // Content
  // ---------------------------------------------------------------------------

  /**
   * The players to show (src/stage/stage-model.ts). The band is rebuilt only
   * when the instruments or their ranges change; new notes for the same band
   * (a re-prime, a tempo change) just replace the timeline.
   */
  setPlayers(players: readonly Player[], title: string, beatSeconds?: number): void {
    if (beatSeconds && beatSeconds > 0) this.lookahead = Math.min(1, Math.max(0.2, beatSeconds));
    const signature = JSON.stringify([title, players.map((p) => [p.id, p.figure, p.low, p.high])]);
    if (this.stage && signature === this.signature) {
      const byId = new Map(players.map((p) => [p.id, p]));
      for (const placed of this.stage.placed) {
        const p = byId.get(placed.player.id);
        if (p) placed.player = p;
      }
      this.lastT = NaN;
      return;
    }
    this.signature = signature;
    this.title = title;
    this.stage = players.length ? buildStage(players, title) : null;
    if (this.focus && !this.stage?.placed.some((p) => p.player.id === this.focus)) this.focus = null;
    if (this.joined && !this.stage?.placed.some((p) => p.player.id === this.joined)) this.setJoined(null);
    this.lights.clear();
    this.lastT = NaN;
    if (!this.el.hidden) this.draw();
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  setVisible(on: boolean): void {
    if (on === !this.el.hidden) return;
    this.el.hidden = !on;
    if (on) {
      this.draw();
      this.loop();
    } else {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.releaseAll();
    }
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  private draw(): void {
    if (!this.stage) {
      this.art.innerHTML = "";
      this.hint.textContent = "the band appears when the score has notes";
      this.readout.textContent = "";
      return;
    }
    const rendered = renderScene(this.stage.scene, 0);
    this.art.innerHTML = rendered.svg;
    this.index.clear();
    for (const g of this.art.querySelectorAll<SVGGElement>("g[data-obj]")) {
      const keys = new Map<string, Element[]>();
      for (const el of g.querySelectorAll<SVGGElement>("[data-k]")) {
        const k = el.dataset.k!;
        const list = keys.get(k);
        if (list) list.push(el);
        else keys.set(k, [el]);
      }
      this.index.set(g.dataset.obj!, keys);
    }
    for (const [obj, l] of this.lights) {
      for (const cls of ["on", "yours", "next"] as const) for (const k of l[cls]) this.mark(obj, k, cls, true);
    }
    let band: Rect | null = null;
    for (const r of rendered.objects.values()) {
      band = band ? [Math.min(band[0], r[0]), Math.min(band[1], r[1]), Math.max(band[2], r[2]), Math.max(band[3], r[3])] : r;
    }
    this.bandRect = band ?? rendered.bounds;
    this.objectRects = rendered.objects;
    this.frame(false);
    this.caption();
    this.drawKeyLabels();
  }

  /** The viewBox for the band or a close-up, eased there unless `animate` is false. */
  private frame(animate = true): void {
    const placed = this.focused();
    const r = (placed && (this.whole ? this.objectRects.get(placed.player.id) : this.playRect(placed) ?? this.focusRect(placed))) || this.bandRect;
    const w = r[2] - r[0], h = r[3] - r[1];
    const pad = placed ? 0.1 : 0.06;
    // Headroom for the captions over the drawing.
    const target: Rect = [r[0] - pad * w, r[1] - (placed ? pad : 0.14) * h, r[2] + pad * w, r[3] + (placed ? pad : 0.1) * h];
    this.fitBox = target;
    cancelAnimationFrame(this.viewAnim);
    if (!animate || reducedMotion()) {
      this.setViewBox(target);
      return;
    }
    const from = this.viewBox, t0 = performance.now(), ms = 380;
    const step = () => {
      const u = Math.min(1, (performance.now() - t0) / ms), e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
      this.setViewBox(from.map((v, i) => v + (target[i] - v) * e) as unknown as Rect);
      if (u < 1) this.viewAnim = requestAnimationFrame(step);
    };
    this.viewAnim = requestAnimationFrame(step);
  }

  /** Joined at a keyboard: the keys the letters reach (the window moves with the octave). */
  private playRect(placed: Placed): Rect | null {
    if (placed.player.id !== this.joined || !LABELLED.has(placed.figure.kind)) return null;
    const keys = this.index.get(placed.player.id);
    const base = this.baseFor(placed);
    let r: Rect | null = null;
    for (let p = base; p <= base + WINDOW; p++) {
      for (const k of placed.figure.light([p])) {
        const el = keys?.get(k)?.[0] as SVGGraphicsElement | undefined;
        if (!el) continue;
        const b = el.getBBox();
        if (!(b.width > 0)) continue;
        r = r ? [Math.min(r[0], b.x), Math.min(r[1], b.y), Math.max(r[2], b.x + b.width), Math.max(r[3], b.y + b.height)] : [b.x, b.y, b.x + b.width, b.y + b.height];
      }
    }
    return r;
  }

  /** The screen rect of a figure's close-up box. */
  private focusRect(placed: Placed): Rect {
    const view = new View(0, this.stage!.scene.center, this.stage!.scene.eye);
    const { min, max } = placed.focus;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
      const [sx, sy] = view.P([x, y, z]);
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    return [x0, y0, x1, y1];
  }

  private setViewBox(r: Rect): void {
    this.viewBox = r;
    this.svg.setAttribute("viewBox", `${r[0].toFixed(2)} ${r[1].toFixed(2)} ${(r[2] - r[0]).toFixed(2)} ${(r[3] - r[1]).toFixed(2)}`);
    // Zoomed well in, small labels (note names, fingers) are worth showing anywhere.
    this.el.classList.toggle("zoomed", (this.fitBox[2] - this.fitBox[0]) / (r[2] - r[0]) > 1.9);
  }

  /** Drawing units per screen pixel (the viewBox is letterboxed with `meet`). */
  private unitsPerPixel(): number {
    const w = this.svg.clientWidth || 1, h = this.svg.clientHeight || 1;
    return Math.max((this.viewBox[2] - this.viewBox[0]) / w, (this.viewBox[3] - this.viewBox[1]) / h);
  }

  /** Zoom by `factor` (> 1 in) about a screen point, or the middle; never past 16× or below the fit. */
  zoomBy(factor: number, clientX?: number, clientY?: number): void {
    cancelAnimationFrame(this.viewAnim);
    const [x0, y0, x1, y1] = this.viewBox;
    const fitW = this.fitBox[2] - this.fitBox[0];
    const w = Math.min(fitW * 1.25, Math.max(fitW / 16, (x1 - x0) / factor));
    const k = w / (x1 - x0);
    let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    if (clientX !== undefined && clientY !== undefined) {
      const ctm = this.svg.getScreenCTM();
      if (ctm) {
        const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
        cx = p.x; cy = p.y;
      }
    }
    // Keep the point under the cursor where it is.
    this.setViewBox([cx - (cx - x0) * k, cy - (cy - y0) * k, cx + (x1 - cx) * k, cy + (y1 - cy) * k]);
  }

  private panBy(dxPx: number, dyPx: number): void {
    const u = this.unitsPerPixel();
    const [x0, y0, x1, y1] = this.viewBox;
    this.setViewBox([x0 - dxPx * u, y0 - dyPx * u, x1 - dxPx * u, y1 - dyPx * u]);
  }

  private caption(): void {
    const placed = this.focused();
    const n = placed ? this.stage!.placed.indexOf(placed) + 1 : 0;
    this.fig.textContent = placed ? `Fig. 1.${n}` : "Fig. 1";
    const joined = Boolean(placed && placed.player.id === this.joined);
    this.name.textContent = placed ? `${placed.player.label}${joined ? " · you" : ""}` : this.title;
    this.back.hidden = !placed;
    this.mode.hidden = !placed;
    this.mode.textContent = this.whole ? "hands" : "whole";
    this.mode.setAttribute("aria-pressed", String(this.whole));
    this.join.hidden = !placed || !this.host.join;
    this.join.textContent = joined ? "leave" : "join";
    this.join.setAttribute("aria-pressed", String(joined));
    this.midi.hidden = !joined || typeof navigator === "undefined" || !("requestMIDIAccess" in navigator);
    this.el.classList.toggle("close", Boolean(placed));
    this.el.classList.toggle("joined", joined);
    const target = this.target();
    const keys = target && target.figure.kind !== "drums" ? ` ${noteName(this.baseFor(target))}–${noteName(this.baseFor(target) + WINDOW)}` : "";
    this.hint.textContent = this.notice || (joined
      ? `your part: play the dashed notes · keys z–/ q–]${keys} · ← → octave · esc leaves`
      : placed
        ? `press or type to play${keys} · join to take this part · ⌘-scroll or double-click to zoom · esc steps back`
        : "press an instrument to look closer · ⌘-scroll or double-click to zoom");
    this.svg.setAttribute("aria-label", placed ? `${placed.player.label}, seen from the player's seat` : `The band: ${this.stage?.placed.map((p) => p.player.label).join(", ")}`);
    this.lastT = NaN;
  }

  setFocus(id: string | null): void {
    if (id === this.focus) return;
    this.focus = id;
    if (!id) this.whole = false;
    this.caption();
    this.frame(true);
  }

  private focused(): Placed | undefined {
    return this.stage?.placed.find((p) => p.player.id === this.focus);
  }

  // ---------------------------------------------------------------------------
  // Following the music
  // ---------------------------------------------------------------------------

  private loop(): void {
    if (this.raf) return;
    const tick = () => {
      this.raf = 0;
      if (this.el.hidden) return;
      this.update();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private update(): void {
    if (!this.stage) return;
    const { t, running } = this.host.position();
    if (!running && t === this.lastT) return;
    this.lastT = t;
    for (const placed of this.stage.placed) {
      const m = momentAt(placed.player, t, running ? this.lookahead : 0);
      const fig = placed.figure;
      const on = new Set(fig.light(m.on));
      const yours = new Set(fig.light(m.yours));
      const next = new Set(fig.light(m.next).filter((k) => !on.has(k)));
      this.apply(placed.player.id, { on, yours, next });
      if (fig.kind === "bowed") this.art.querySelector(`g[data-obj="${CSS.escape(placed.player.id)}"]`)?.classList.toggle("odd", m.started % 2 === 1);
    }
    // The readout follows the instrument you are looking at, or the melody (the first player).
    const placed = this.focused() ?? this.stage.placed[0];
    const m = placed ? momentAt(placed.player, t) : null;
    const name = (pitches: number[]) => placed?.figure.kind === "drums"
      ? [...new Set(placed.figure.light(pitches).map((k) => k.slice(2)))].join(" ")
      : [...new Set(pitches)].sort((a, b) => a - b).map(noteName).join(" ");
    // A muted voice's notes are the player's own part: say so.
    const notes = m ? (m.on.length ? name(m.on) : m.yours.length ? `your part: ${name(m.yours)}` : "") : "";
    const text = `${(placed?.player.label ?? "").toLowerCase()} · ${running ? notes || "rest" : t > 0 ? "paused" : "ready"}`;
    if (this.readout.textContent !== text) this.readout.textContent = text;
  }

  /** Exactly these parts carry each class; leaving `on` fades back (a CSS transition). */
  private apply(obj: string, next: Lights): void {
    const prev = this.lights.get(obj) ?? { on: new Set<string>(), yours: new Set<string>(), next: new Set<string>() };
    for (const cls of ["on", "yours", "next"] as const) {
      for (const k of prev[cls]) if (!next[cls].has(k)) this.mark(obj, k, cls, false);
      for (const k of next[cls]) if (!prev[cls].has(k)) this.mark(obj, k, cls, true);
    }
    this.lights.set(obj, next);
  }

  private mark(obj: string, key: string, cls: string, on: boolean): void {
    for (const el of this.index.get(obj)?.get(key) ?? []) el.classList.toggle(cls, on);
  }

  // ---------------------------------------------------------------------------
  // Playing
  // ---------------------------------------------------------------------------

  private placedById(id: string): Placed | undefined {
    return this.stage?.placed.find((p) => p.player.id === id);
  }

  /** Press part `key` of `obj`: it goes down and sounds. */
  private pressKey(obj: string, key: string): void {
    const placed = this.placedById(obj);
    if (!placed) return;
    const pitch = placed.figure.pitchOf(key);
    const keys = pitch === null ? [key] : placed.figure.light([pitch]);
    if (!keys.includes(key)) keys.push(key);
    for (const k of keys) this.mark(obj, k, "down", true);
    const program = placed.player.program;
    this.held.set(`${obj}\n${key}`, { obj, keys, serial: ++this.serial, program, pitch: pitch ?? undefined });
    if (pitch !== null) this.host.noteOn(program, pitch);
  }

  /** Release a held part — only the press numbered `serial`, when given. */
  private releaseKey(obj: string, key: string, serial?: number): void {
    const id = `${obj}\n${key}`;
    const held = this.held.get(id);
    if (!held || (serial !== undefined && held.serial !== serial)) return;
    this.held.delete(id);
    for (const k of held.keys) this.mark(obj, k, "down", false);
    if (held.program !== undefined && held.pitch !== undefined) this.host.noteOff(held.program, held.pitch);
  }

  /** Release after the press has shown for MIN_PRESS_MS. */
  private releaseLater(obj: string, key: string, at: number): void {
    const serial = this.held.get(`${obj}\n${key}`)?.serial;
    const wait = Math.max(0, MIN_PRESS_MS - (performance.now() - at));
    setTimeout(() => this.releaseKey(obj, key, serial), wait);
  }

  private releaseAll(): void {
    for (const id of [...this.held.keys()]) {
      const [obj, key] = id.split("\n");
      this.releaseKey(obj, key);
    }
    this.pointers.clear();
    this.sustained.clear();
    this.pedal = false;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as Element;
    const part = target.closest<SVGGElement>("[data-k]");
    const objEl = target.closest<SVGGElement>("[data-obj]");
    if (!part || !objEl) {
      // Not a key: a mouse drag here pans the drawing (touch keeps scrolling the page).
      if (e.pointerType === "mouse") {
        // Captured only once it moves: a capture retargets the click to the <svg>.
        this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      }
      return;
    }
    const obj = objEl.dataset.obj!, key = part.dataset.k!;
    const touch = e.pointerType !== "mouse";
    this.pointers.set(e.pointerId, { obj, key, at: performance.now(), x: e.clientX, y: e.clientY, touch });
    if (touch) return; // a tap candidate: plays on lift, if it was not a scroll
    e.preventDefault();
    this.el.focus({ preventScroll: true });
    this.pressKey(obj, key);
    try {
      this.svg.setPointerCapture(e.pointerId);
    } catch { /* the pointer is already gone */ }
  }

  /** Mouse: slide across keys without lifting (a glissando). Touch: moving past the slop makes it a scroll. */
  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (d && d.id === e.pointerId) {
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
      if (!d.moved) try { this.svg.setPointerCapture(e.pointerId); } catch { /* gone */ }
      d.moved = true;
      this.panBy(e.clientX - d.x, e.clientY - d.y);
      d.x = e.clientX; d.y = e.clientY;
      return;
    }
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    if (p.touch) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP_PX) this.pointers.delete(e.pointerId);
      return;
    }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const part = el?.closest<SVGGElement>("[data-k]");
    const obj = part?.closest<SVGGElement>("[data-obj]")?.dataset.obj;
    if (!part || obj !== p.obj || part.dataset.k === p.key) return;
    this.releaseKey(p.obj, p.key);
    p.key = part.dataset.k!;
    p.at = performance.now();
    this.pressKey(p.obj, p.key);
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.drag && this.drag.id === e.pointerId) {
      this.dragged = this.drag.moved;
      this.drag = null;
      return;
    }
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.touch) {
      // A tap: it lifted where it landed and the browser never took it for a pan.
      if (e.type !== "pointerup") return;
      this.pressKey(p.obj, p.key);
      const serial = this.held.get(`${p.obj}\n${p.key}`)?.serial;
      setTimeout(() => this.releaseKey(p.obj, p.key, serial), TAP_HOLD_MS);
      return;
    }
    this.releaseLater(p.obj, p.key, p.at);
  }

  /** Press an instrument to look closer; press the paper to step back. */
  private onClick(e: MouseEvent): void {
    // The end of a drag is not a click.
    if (this.dragged) { this.dragged = false; return; }
    const target = e.target as Element;
    if (target.closest("[data-k]")) return;
    const objEl = target.closest<SVGGElement>("[data-obj]");
    // Pressing an instrument looks closer; stepping back is ✕ or Esc (a click on the
    // paper would leave the close-up mid-way through a double-click zoom).
    if (objEl && objEl.dataset.obj !== this.focus) this.setFocus(objEl.dataset.obj!);
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const joined = this.joined !== null;
    if (down && e.key === "Escape" && (this.joined || this.focus)) {
      e.preventDefault();
      if (this.joined) this.setJoined(null);
      else this.setFocus(null);
      return;
    }
    const target = this.target();
    if (down && (e.key === "ArrowLeft" || e.key === "ArrowRight") && target && target.figure.kind !== "drums") {
      e.preventDefault();
      const base = Math.min(96, Math.max(12, this.baseFor(target) + (e.key === "ArrowLeft" ? -12 : 12)));
      this.bases.set(target.player.id, base);
      this.caption();
      this.drawKeyLabels();
      if (target.player.id === this.joined && !this.whole) this.frame(true);
      return;
    }
    // Joined, the whole keyboard is the instrument: digits, 0 and = are notes.
    if (!joined) {
      if (down && (e.key === "+" || e.key === "=")) { e.preventDefault(); this.zoomBy(1.6); return; }
      if (down && e.key === "0") { e.preventDefault(); this.frame(true); return; }
      if (down && /^[1-9]$/.test(e.key) && this.stage) {
        const placed = this.stage.placed[Number(e.key) - 1];
        if (placed) { e.preventDefault(); this.setFocus(placed.player.id); }
        return;
      }
    } else if (down && e.key === "+") { e.preventDefault(); this.zoomBy(1.6); return; }
    if (down && (e.key === "-" || e.key === "_")) { e.preventDefault(); this.zoomBy(1 / 1.6); return; }
    const hold = `letter:${e.key.toLowerCase()}`;
    // A letter releases wherever it was pressed — the instrument in view may have changed since.
    if (!down) {
      this.stopHold(hold);
      return;
    }
    if (!target) return;
    const pitch = this.letterPitch(target, e.key.toLowerCase());
    if (pitch === null) return;
    e.preventDefault();
    if (e.repeat) return;
    this.playHold(target, hold, pitch);
  }

  /** The instrument letters and MIDI play: the part you joined, the one in view, or the melody. */
  private target(): Placed | undefined {
    return (this.joined ? this.placedById(this.joined) : undefined) ?? this.focused() ?? this.stage?.placed[0];
  }

  /** Where `placed`'s letter window starts: a C, set so the window centres on the part's range. */
  private baseFor(placed: Placed): number {
    const moved = this.bases.get(placed.player.id);
    if (moved !== undefined) return moved;
    const { low, high } = placed.player;
    const mid = Number.isFinite(low) ? (low + high) / 2 : 60;
    return Math.min(96, Math.max(12, 12 * Math.round((mid - WINDOW / 2) / 12)));
  }

  /** The pitch a letter plays on this instrument. */
  private letterPitch(placed: Placed, letter: string): number | null {
    if (placed.figure.kind === "drums") return DRUM_ROW[letter] ?? null;
    if (letter.length !== 1) return null;
    const lo = LOWER_ROW.indexOf(letter);
    if (lo >= 0) return this.baseFor(placed) + lo;
    const up = UPPER_ROW.indexOf(letter);
    return up >= 0 ? this.baseFor(placed) + 12 + up : null;
  }

  /** Hold `pitch` on `placed` under the name `hold` (a letter, a MIDI note) until stopHold. */
  private playHold(placed: Placed, hold: string, pitch: number, velocity?: number): void {
    const obj = placed.player.id;
    const id = `${obj}\n${hold}`;
    if (this.held.has(id)) this.releaseKey(obj, hold);
    const keys = placed.figure.light([pitch]);
    for (const k of keys) this.mark(obj, k, "down", true);
    const program = placed.player.program;
    this.held.set(id, { obj, keys, serial: ++this.serial, program, pitch });
    this.host.noteOn(program, pitch, velocity);
  }

  private stopHold(hold: string): void {
    for (const [id, h] of [...this.held]) if (id.endsWith(`\n${hold}`)) this.releaseKey(h.obj, hold);
  }

  // ---------------------------------------------------------------------------
  // Joining the band
  // ---------------------------------------------------------------------------

  /** Take over `id`'s part, or hand it back (null). */
  setJoined(id: string | null): void {
    if (id === this.joined) return;
    this.releaseAll();
    this.joined = id;
    const placed = id ? this.placedById(id) : undefined;
    if (id && !placed) this.joined = null;
    this.host.join?.(placed?.player ?? null);
    if (placed && this.focus !== placed.player.id) this.setFocus(placed.player.id);
    else this.frame(true);
    this.caption();
    this.drawKeyLabels();
  }

  get joinedPart(): string | null {
    return this.joined;
  }

  /** Each mapped key of the joined keyboard carries its letter. */
  private drawKeyLabels(): void {
    this.labels.innerHTML = "";
    const placed = this.joined ? this.placedById(this.joined) : undefined;
    if (!placed || !LABELLED.has(placed.figure.kind) || this.el.hidden) return;
    let out = "";
    for (const letter of LOWER_ROW + UPPER_ROW) {
      const pitch = this.letterPitch(placed, letter);
      if (pitch === null) continue;
      const key = placed.figure.light([pitch])[0];
      const el = key && this.index.get(placed.player.id)?.get(key)?.[0];
      if (!el) continue;
      const at = keyTop(el);
      if (!at) continue;
      const black = [1, 3, 6, 8, 10].includes(pitch % 12);
      out += `<text class="kbd${black ? " b" : ""}" x="${at.x.toFixed(2)}" y="${(at.y + at.size * 0.35).toFixed(2)}" font-size="${at.size.toFixed(2)}" text-anchor="middle">${escapeXml(letter.toUpperCase())}</text>`;
    }
    this.labels.innerHTML = out;
  }

  private flash(text: string): void {
    this.notice = text;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => { this.notice = ""; this.caption(); }, 5000);
    this.caption();
  }

  /** Web MIDI: every key of a real keyboard plays the joined part, with velocity and the sustain pedal. */
  private async connectMidi(): Promise<void> {
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MIDIAccess> };
    try {
      const access = await nav.requestMIDIAccess!();
      const attach = () => {
        const names: string[] = [];
        for (const input of access.inputs.values()) {
          input.onmidimessage = (m) => { if (m.data) this.onMidi(m.data); };
          names.push(input.name ?? "keyboard");
        }
        this.flash(names.length ? `midi: ${names.join(", ")}` : "midi: no keyboard found — plug one in");
      };
      attach();
      access.onstatechange = attach;
    } catch {
      this.flash("midi isn't allowed here — try the full player in a new tab");
    }
  }

  private onMidi(data: Uint8Array): void {
    const [status, d1, d2] = data;
    const cmd = status & 0xf0;
    const placed = this.target();
    if (!placed) return;
    if (cmd === 0x90 && d2 > 0) {
      this.sustained.delete(d1);
      this.playHold(placed, `midi:${d1}`, d1, d2);
    } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
      if (this.pedal) this.sustained.add(d1);
      else this.stopHold(`midi:${d1}`);
    } else if (cmd === 0xb0 && d1 === 64) {
      this.pedal = d2 >= 64;
      if (!this.pedal) {
        for (const p of this.sustained) this.stopHold(`midi:${p}`);
        this.sustained.clear();
      }
    }
  }
}

/**
 * Where a key's letter goes: on its top face (the lightest face, tone `l`),
 * part-way from the middle toward the front edge (the lowest on screen), sized
 * to the key's width there. Front of a white key, clear of the black keys.
 */
function keyTop(el: Element): { x: number; y: number; size: number } | null {
  const d = el.querySelector("path.f.l")?.getAttribute("d");
  const nums = d?.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  if (!nums || nums.length < 8) return null;
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  // The front edge: the two corners lowest on screen.
  const [f1, f2] = [...pts].sort((a, b) => b[1] - a[1]);
  const fx = (f1[0] + f2[0]) / 2, fy = (f1[1] + f2[1]) / 2;
  const width = Math.hypot(f1[0] - f2[0], f1[1] - f2[1]);
  return { x: cx + (fx - cx) * 0.45, y: cy + (fy - cy) * 0.45, size: width * 0.62 };
}
