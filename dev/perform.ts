// =============================================================================
// Performance page — one continuous piece through the real widgets.
//
// A cue list re-sends `ui/notifications/tool-input` into the SAME Strudel
// widget, so every section is a hot-swapped re-evaluation on the running
// clock (Strudel keeps its cycle position across evaluate()). Hydra evolves
// with it; captions are DOM over the visuals. The last section hands the
// theme to the ABC widget as notation.
//
// Meant to be captured by an OBS Browser Source at 1920×1080 with
// `?autoplay=1` (see scripts/showcase/README.md), but it also runs in a tab.
// `?speed=4` compresses the cue times for rehearsal.
// =============================================================================

import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const SPEED = Number(params.get("speed") ?? 1) || 1;
const HY = "'https://unpkg.com/hydra-synth@1.4.0'";
const THEME = "tokyoNight";
const BPM = 120;

// ---- the music (A minor, 120 bpm → 1 cycle = 2 s) --------------------------

const PAD = `note("<[a2,c3,e3] [f2,a2,c3] [c3,e3,g3] [g2,b2,d3]>/2").s("gm_pad_warm").attack(1).release(3).room(0.9)`;
const BOX = `note("<a4 ~ e5 ~ c5 ~ ~ ~>/2").s("gm_music_box").delay(0.6).delaytime(0.75).room(0.7)`;
const ROOTS = `"<a1 f1 c2 g1>/2"`;
const ARP = `note("<[a3 c4 e4 a4 c5 a4 e4 c4]!2 [f3 a3 c4 f4 a4 f4 c4 a3]!2 [c4 e4 g4 c5 e5 c5 g4 e4]!2 [g3 b3 d4 g4 b4 g4 d4 b3]!2>")`;
const THEME_MELODY = `note("<[e4 c4 a4 c5] [a4 f4 c4 f4] [e4 g4 c5 g4] [d4 g4 b4 g4]>")`;

const WASH_SHADER = `noise(1.6, 0.06).color(0.16, 0.22, 0.55).modulate(voronoi(3, 0.15), 0.25)`;

const SECTIONS = {
  wash: `await initHydra({ src: ${HY} })
${WASH_SHADER}
  .blend(o0, 0.92)
  .out(o0)

stack(
  ${PAD}.gain(0.6),
  ${BOX}.gain(0.45)
)`,

  pulse: `await initHydra({ src: ${HY} })
const kick = "1 0 0.5 0 1 0 0.3 0.3"
${WASH_SHADER}
  .add(shape(6, () => 0.12 + 0.3 * H(kick)(), 0.4).color(0.35, 0.5, 1.2), 0.6)
  .blend(o0, 0.85)
  .out(o0)

stack(
  ${PAD}.gain(0.55),
  ${BOX}.gain(0.4),
  s("bd ~ bd ~").bank("RolandTR808").gain(0.9),
  s("[~ hh]*4").bank("RolandTR808").gain(0.3),
  note(${ROOTS}).s("gm_synth_bass_1").lpf(500).gain(0.7)
)`,

  listen: `await initHydra({ src: ${HY} })
a.setCutoff(1)
a.setScale(6)
osc(12, 0.08, () => 0.6 + a.fft[0] * 2)
  .kaleid(() => 4 + Math.round(a.fft[1] * 3))
  .modulateScale(noise(2, 0.1), () => 0.05 + a.fft[1] * 0.3)
  .color(0.3, 0.45, 1.3)
  .contrast(1.3)
  .blend(o0, 0.6)
  .out(o0)

stack(
  s("bd*4").bank("RolandTR909").gain(1),
  s("~ cp").bank("RolandTR909").room(0.3),
  s("[~ hh]*4, [~ ~ ~ oh]").bank("RolandTR909").gain(0.4),
  note(${ROOTS}).struct("x*8").s("sawtooth").lpf(sine.range(400, 2200).slow(8)).decay(0.12).sustain(0).gain(0.6),
  ${PAD}.gain(0.4)
)`,

  feed: `await initHydra({ feedStrudel: true, src: ${HY} })
src(s0)
  .kaleid(4)
  .modulate(noise(3, 0.2), 0.05)
  .colorama(0.008)
  .blend(o0, 0.7)
  .out(o0)
all(p => p.pianoroll({ fold: 1, cycles: 4 }))

stack(
  s("bd*4").bank("RolandTR909").gain(1),
  s("~ cp").bank("RolandTR909").room(0.3),
  s("[~ hh]*4, [~ ~ ~ oh]").bank("RolandTR909").gain(0.4),
  note(${ROOTS}).struct("x*8").s("sawtooth").lpf(1200).decay(0.12).sustain(0).gain(0.55),
  ${ARP}
    .s("gm_epiano1").room(0.5).delay(0.25).gain(0.7).color("cyan")
)`,

  stage: `await initHydra({ feedStrudel: true, src: ${HY} })
src(s0)
  .kaleid(() => 4 + Math.round(a.fft[0] * 4))
  .modulate(noise(3, 0.2), () => 0.05 + a.fft[1] * 0.4)
  .colorama(0.02)
  .blend(o0, 0.65)
  .out(o0)
all(p => p.pianoroll({ fold: 1, cycles: 4 }))

stack(
  s("bd*4").bank("RolandTR909").gain(1),
  s("~ cp").bank("RolandTR909").room(0.3),
  s("[~ hh]*4, [~ ~ ~ oh]").bank("RolandTR909").gain(0.45),
  note(${ROOTS}).struct("x*8").s("sawtooth").lpf(sine.range(600, 3000).fast(2)).decay(0.12).sustain(0).gain(0.6),
  ${ARP}
    .s("gm_epiano1").room(0.5).delay(0.25).gain(0.7).color("cyan"),
  note("<a5 e5 c5 e5>*2").s("gm_lead_2_sawtooth").lpf(2500)
    .delay(0.5).delaytime(0.375).room(0.6).gain(0.35).color("magenta")
)`,

  breathe: `await initHydra({ src: ${HY} })
${WASH_SHADER}
  .add(osc(6, 0.03, () => 0.4 + a.fft[0]).kaleid(5).color(0.2, 0.3, 0.9), 0.35)
  .blend(o0, 0.9)
  .out(o0)

stack(
  ${PAD}.gain(0.6),
  ${THEME_MELODY}.s("gm_vibraphone").room(0.8).delay(0.3).delaytime(0.75).gain(0.75),
  note("<a1 f1 c2 g1>").s("gm_synth_bass_1").lpf(400).gain(0.5)
)`,

  tail: `await initHydra({ src: ${HY} })
${WASH_SHADER}
  .blend(o0, 0.95)
  .out(o0)

stack(
  note("<a2 ~ ~ ~>").s("gm_pad_warm").attack(2).release(4).room(0.95).gain(0.5),
  note("<a4 ~ ~ ~ e5 ~ ~ ~>").s("gm_music_box").room(0.9).delay(0.5).gain(0.35)
)`,
};

const ABC_SCORE = `X:1
T:Theme
C:mcp-music-studio 0.5
M:4/4
L:1/8
Q:1/4=120
K:Am
"Am"e2 c2 a2 c'2 | "F"a2 f2 c2 f2 | "C"e2 g2 c'2 g2 | "G"d2 g2 b2 g2 |
"Am"e2 c2 a2 c'2 | "F"a2 f2 c2 f2 | "C"e2 g2 c'2 g2 | "G"d2 g2 b2 a2 |]`;

// ---- cues -------------------------------------------------------------------

type Cue = { at: number; run: () => void | Promise<void> };
type Caption = { n: string; t: string; s: string };

const CAPTIONS: Record<string, Caption> = {
  wash: { n: "I", t: "wash", s: "one <code>await initHydra()</code>, then the pattern — a shader behind the code" },
  pulse: { n: "II", t: "pulse", s: "<code>H(kick)</code> — the shader reads the rhythm sequence" },
  listen: { n: "III", t: "listen", s: "<code>a.fft</code> — Hydra's audio object, wired to Strudel's own master bus" },
  feed: { n: "IV", t: "feed", s: "<code>feedStrudel</code> — the piano roll is the shader's texture" },
  stage: { n: "V", t: "stage", s: "Stage mode — the code steps aside" },
  breathe: { n: "VI", t: "breathe", s: "every section was a hot-swapped re-evaluation — the clock never stopped" },
  score: { n: "VII", t: "score, arranged", s: "the theme again, <code>style: bossa</code> — presets with real drums again, swing that swings, edit in place, MIDI export" },
};

const T = 18; // the score plays the theme first; Strudel enters on top of its chords
const cues: Cue[] = [
  { at: 0, run: async () => { await abc(ABC_SCORE, "classical"); $("veil").classList.add("off"); $("abc").classList.add("on"); } },
  { at: 2.5, run: () => caption({ n: "theme", t: "score", s: "eight bars in A minor, as <code>play-sheet-music</code> — everything that follows is built on them" }, 8000) },
  { at: 4, run: () => $("brand").classList.add("on") },
  { at: T - 1, run: () => strudel(SECTIONS.wash, "wash") },
  { at: T + 0.5, run: () => { $("abc").classList.remove("on"); $("strudel").classList.add("on"); } },
  // The 8-bar score ends on its own (~17.5 s); do not touch its transport — the
  // abcjs button is a toggle and would restart the tune.
  { at: T + 3, run: () => caption(CAPTIONS.wash) },
  { at: T + 24, run: () => strudel(SECTIONS.pulse, "pulse") },
  { at: T + 25, run: () => caption(CAPTIONS.pulse) },
  { at: T + 48, run: () => strudel(SECTIONS.listen, "listen") },
  { at: T + 49, run: () => caption(CAPTIONS.listen) },
  { at: T + 76, run: () => strudel(SECTIONS.feed, "feed") },
  { at: T + 77, run: () => caption(CAPTIONS.feed) },
  { at: T + 104, run: () => strudel(SECTIONS.stage, "stage") },
  { at: T + 105, run: () => clickInStrudel("stage-btn") },
  { at: T + 106, run: () => caption(CAPTIONS.stage) },
  { at: T + 128, run: () => strudel(SECTIONS.breathe, "breathe") },
  { at: T + 129, run: () => clickInStrudel("stage-btn") },
  { at: T + 130, run: () => caption(CAPTIONS.breathe) },
  { at: T + 156, run: () => strudel(SECTIONS.tail, "tail") },
  { at: T + 164, run: () => { $("strudel").classList.remove("on"); } },
  { at: T + 166, run: async () => {
    // Stop the Strudel widget cleanly (its Play button toggles), then hand over.
    clickInStrudel("play-btn");
    $("strudel").classList.add("gone");
    await abc(ABC_SCORE, "bossa");
    $("abc").classList.add("on");
  } },
  { at: T + 168, run: () => caption(CAPTIONS.score, 14000) },
  { at: T + 192, run: () => { $("abc").classList.remove("on"); $("brand").classList.remove("on"); } },
];

// ---- host plumbing ----------------------------------------------------------

function makeBridge(frame: HTMLIFrameElement, name: string): AppBridge {
  const b = new AppBridge(
    null,
    { name, version: "0.0.0" },
    {
      openLinks: {},
      downloadFile: {},
      logging: {},
      message: { text: {}, image: {}, resource: {} },
      updateModelContext: { text: {}, structuredContent: {} },
    },
    { hostContext: { theme: "dark", displayMode: "inline" } },
  );
  b.onmessage = async () => ({});
  b.onupdatemodelcontext = async ({ content }) => {
    const text = (content as any[])?.map((c) => c.text).filter(Boolean).join(" ");
    console.log(`[${name}] model-context: ${text}`);
    return {};
  };
  b.ondownloadfile = async () => ({});
  b.onopenlink = async () => ({});
  b.onrequestdisplaymode = async ({ mode }) => {
    b.setHostContext({ theme: "dark", displayMode: mode });
    return { mode };
  };
  b.onerror = (err) => console.warn(`[${name}] bridge error`, err);
  return b;
}

async function mount(id: string, src: string, name: string): Promise<AppBridge> {
  const frame = $<HTMLIFrameElement>(id);
  frame.setAttribute("allow", "autoplay; clipboard-write");
  const b = makeBridge(frame, name);
  let ready!: () => void;
  const init = new Promise<void>((r) => (ready = r));
  b.oninitialized = () => ready();
  await b.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  frame.src = src;
  await init;
  return b;
}

let strudelBridge: AppBridge;
let abcBridge: AppBridge;

async function strudel(code: string, title: string): Promise<void> {
  const args = { code, bpm: BPM, theme: THEME, title, autoplay: true };
  await strudelBridge.sendToolInput({ arguments: args });
  await strudelBridge.sendToolResult({ content: [{ type: "text", text: `"${title}" — Strudel pattern ready.` }] });
}

async function abc(abcNotation: string, style: string): Promise<void> {
  const args = { abcNotation, title: "Theme", instrument: "vibraphone", style, tempo: BPM, autoplay: true };
  await abcBridge.sendToolInput({ arguments: args });
  await abcBridge.sendToolResult({ content: [{ type: "text", text: "Sheet music ready." }] });
}

/** abcjs's transport buttons carry classes, not ids: "play" (toggles), "pause". */
function clickInAbc(cls: string): void {
  const doc = $<HTMLIFrameElement>("abc").contentDocument;
  const el = doc?.querySelector(`.abcjs-midi-${cls}, .abcjs-midi-start`) as HTMLButtonElement | null;
  if (el) el.click();
  else console.warn(`no abcjs ${cls} button`);
}

function clickInStrudel(id: string): void {
  const doc = $<HTMLIFrameElement>("strudel").contentDocument;
  const el = doc?.getElementById(id) as HTMLButtonElement | null;
  if (el) el.click();
  else console.warn(`no #${id} in strudel frame`);
}

let captionTimer: ReturnType<typeof setTimeout> | null = null;
function caption(c: Caption, holdMs = 9000): void {
  const el = $("caption");
  el.querySelector(".n")!.textContent = c.n;
  el.querySelector(".t")!.textContent = c.t;
  el.querySelector(".s")!.innerHTML = c.s;
  el.classList.add("on");
  if (captionTimer) clearTimeout(captionTimer);
  captionTimer = setTimeout(() => el.classList.remove("on"), holdMs / SPEED);
}

async function perform(): Promise<void> {
  $("go").hidden = true;
  const t0 = performance.now();
  console.log("[perform] start");
  for (const cue of cues) {
    const due = t0 + (cue.at * 1000) / SPEED;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    console.log(`[perform] cue @${cue.at}s`);
    try { await cue.run(); } catch (err) { console.error("[perform] cue failed", err); }
  }
  console.log("[perform] end");
  (window as any).__performDone = true;
}

async function boot(): Promise<void> {
  [strudelBridge, abcBridge] = await Promise.all([
    mount("strudel", "/widgets/strudel-app.html", "PerformHost/strudel"),
    mount("abc", "/widgets/mcp-app.html", "PerformHost/abc"),
  ]);
  console.log("[perform] widgets ready");
  (window as any).__performReady = true;
  if (params.get("autoplay") === "1") void perform();
  else $("go").addEventListener("click", () => void perform(), { once: true });
}

(window as any).__perform = { perform, cues, SECTIONS };
void boot();
