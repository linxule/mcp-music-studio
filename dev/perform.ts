// =============================================================================
// Performance page — one continuous piece through the real widgets.
//
// A cue list re-sends `ui/notifications/tool-input` into the SAME Strudel
// widget, so every section is a hot-swapped re-evaluation on the running
// clock (Strudel keeps its cycle position across evaluate()). Hydra evolves
// with it; captions are DOM over the visuals.
//
// Meant to be captured by an OBS Browser Source at 1920×1080 with
// `?autoplay=1` (see scripts/showcase/README.md), but it also runs in a tab.
// `?speed=4` compresses the cue times for rehearsal.
// =============================================================================

import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const SPEED = Number(params.get("speed") ?? 1) || 1;
// Canvas size: ?w=1080&h=1440 for a 3:4 cut. The widgets lay out at size/1.35
// (see perform.html) and portrait gets its code reflowed to fit.
const W = Number(params.get("w") ?? 1920) || 1920;
const H = Number(params.get("h") ?? 1080) || 1080;
const SCALE = 1.35;
const PORTRAIT = H > W;
document.documentElement.style.setProperty("--fw", `${Math.round(W / SCALE)}px`);
document.documentElement.style.setProperty("--fh", `${Math.round(H / SCALE)}px`);
if (PORTRAIT) document.documentElement.style.setProperty("--capw", "84vw");

/**
 * Break long lines at method-chain boundaries so they fit a narrow frame.
 * Splits at `).` outside string literals; continuation lines are indented.
 */
function reflow(code: string, max = 68): string {
  return code
    .split("\n")
    .flatMap((line) => {
      if (line.length <= max) return [line];
      const indent = (line.match(/^\s*/)?.[0] ?? "") + "    ";
      const out: string[] = [];
      let cur = "";
      let inStr: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        cur += ch;
        if (inStr) { if (ch === inStr) inStr = null; continue; }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === ")" && line[i + 1] === "." && cur.trim().length > max * 0.45) {
          out.push(cur);
          cur = indent;
        }
      }
      if (cur.trim()) out.push(cur);
      return out;
    })
    .join("\n");
}
// hydra-synth is pinned by the widget; a bare initHydra() is reproducible.
const THEME = "tokyoNight";
const BPM = 120;

// ---- the music (A minor, 120 bpm → 1 cycle = 2 s) --------------------------

const PAD = `note("<[a2,c3,e3] [f2,a2,c3] [c3,e3,g3] [g2,b2,d3]>/2").s("gm_pad_warm").attack(1).release(3).room(0.9)`;
const BOX = `note("<a4 ~ e5 ~ c5 ~ ~ ~>/2").s("gm_music_box").delay(0.6).delaytime(0.75).room(0.7)`;
const ROOTS = `"<a1 f1 c2 g1>/2"`;
const ARP = `n("0 2 4 7 9 7 4 2").scale("<a3:minor f3:major c4:major g3:major>/2")`;
const THEME_MELODY = `note("<[e4 c4 a4 c5] [a4 f4 c4 f4] [e4 g4 c5 g4] [d4 g4 b4 g4]>")`;

const WASH_SHADER = `noise(1.6, 0.06).color(0.16, 0.22, 0.55).modulate(voronoi(3, 0.15), 0.25)`;

const SECTIONS = {
  wash: `await initHydra()
${WASH_SHADER}
  .blend(o0, 0.92)
  .out(o0)

stack(
  ${PAD}.gain(0.6),
  ${BOX}.gain(0.45)
)`,

  pulse: `await initHydra()
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

  listen: `await initHydra()
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

  feed: `await initHydra({ feedStrudel: true })
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

  stage: `await initHydra({ feedStrudel: true })
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

  breathe: `await initHydra()
${WASH_SHADER}
  .add(osc(6, 0.03, () => 0.4 + a.fft[0]).kaleid(5).color(0.2, 0.3, 0.9), 0.35)
  .blend(o0, 0.9)
  .out(o0)

stack(
  ${PAD}.gain(0.6),
  ${THEME_MELODY}.s("gm_vibraphone").room(0.8).delay(0.3).delaytime(0.75).gain(0.75),
  note("<a1 f1 c2 g1>").s("gm_synth_bass_1").lpf(400).gain(0.5)
)`,

  tail: `await initHydra()
${WASH_SHADER}
  .blend(o0, 0.95)
  .out(o0)

stack(
  note("<a2 ~ ~ ~>").s("gm_pad_warm").attack(2).release(4).room(0.95).gain(0.5),
  note("<a4 ~ ~ ~ e5 ~ ~ ~>").s("gm_music_box").room(0.9).delay(0.5).gain(0.35)
)`,
};

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
};

const cues: Cue[] = [
  { at: 0, run: () => strudel(SECTIONS.wash, "wash") },
  { at: 1.5, run: () => { $("veil").classList.add("off"); $("strudel").classList.add("on"); } },
  { at: 4, run: () => caption(CAPTIONS.wash) },
  { at: 6, run: () => $("brand").classList.add("on") },
  { at: 24, run: () => strudel(SECTIONS.pulse, "pulse") },
  { at: 25, run: () => caption(CAPTIONS.pulse) },
  { at: 48, run: () => strudel(SECTIONS.listen, "listen") },
  { at: 49, run: () => caption(CAPTIONS.listen) },
  { at: 76, run: () => strudel(SECTIONS.feed, "feed") },
  { at: 77, run: () => caption(CAPTIONS.feed) },
  { at: 104, run: () => strudel(SECTIONS.stage, "stage") },
  { at: 105, run: () => clickInStrudel("stage-btn") },
  { at: 106, run: () => caption(CAPTIONS.stage) },
  { at: 128, run: () => strudel(SECTIONS.breathe, "breathe") },
  { at: 129, run: () => clickInStrudel("stage-btn") },
  { at: 130, run: () => caption(CAPTIONS.breathe) },
  { at: 156, run: () => strudel(SECTIONS.tail, "tail") },
  { at: 168, run: () => { $("strudel").classList.remove("on"); $("brand").classList.remove("on"); } },
  { at: 171, run: () => clickInStrudel("play-btn") },
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

/**
 * OBS's CEF renders fonts wider than Chrome, so at the portrait layout width
 * the widget's toolbar overflows and CodeMirror scrolls the whole document
 * sideways — the take came out shifted with a blank strip. Pin the widget
 * document at (0,0) with overflow hidden; same-origin, so we can reach in.
 */
function pinStrudelViewport(): void {
  const win = $<HTMLIFrameElement>("strudel").contentWindow;
  const doc = win?.document;
  if (!doc) return;
  if (!doc.getElementById("perform-pin")) {
    const st = doc.createElement("style");
    st.id = "perform-pin";
    st.textContent = "html, body { overflow: hidden !important; } .toolbar, header { flex-wrap: wrap; }";
    doc.head.appendChild(st);
  }
  win!.scrollTo(0, 0);
  doc.documentElement.scrollLeft = 0;
  doc.body.scrollLeft = 0;
}

async function strudel(code: string, title: string): Promise<void> {
  const args = { code: PORTRAIT ? reflow(code) : code, bpm: BPM, theme: THEME, title, autoplay: true };
  await strudelBridge.sendToolInput({ arguments: args });
  await strudelBridge.sendToolResult({ content: [{ type: "text", text: `"${title}" — Strudel pattern ready.` }] });
  setTimeout(pinStrudelViewport, 300);
  setTimeout(pinStrudelViewport, 1500);
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
  strudelBridge = await mount("strudel", "/widgets/strudel-app.html", "PerformHost/strudel");
  console.log("[perform] widgets ready");
  pinStrudelViewport();
  setInterval(pinStrudelViewport, 1000);
  (window as any).__performReady = true;
  if (params.get("debug") === "1") {
    const r = $("strudel").getBoundingClientRect();
    const cs = getComputedStyle($("strudel"));
    $("go").textContent = `inner ${innerWidth}x${innerHeight} dpr ${devicePixelRatio} | frame rect ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} | css w ${cs.width} h ${cs.height} transform ${cs.transform} | ua ${navigator.userAgent.slice(-60)}`;
    $("go").style.cssText += ";font-size:26px;padding:40px;text-align:left;white-space:normal;line-height:1.5";
  }
  if (params.get("debug") === "2") {
    setTimeout(() => {
      const doc = $<HTMLIFrameElement>("strudel").contentDocument!;
      const rect = (sel: string) => { const e = doc.querySelector(sel); if (!e) return `${sel}: none`; const r = e.getBoundingClientRect(); return `${sel}: ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
      const info = [`inner ${doc.defaultView!.innerWidth}x${doc.defaultView!.innerHeight} scrollW ${doc.documentElement.scrollWidth} scrollX ${doc.defaultView!.scrollX}`,
        rect("body"), rect("header"), rect(".repl-section"), rect("#strudel-container"), rect(".cm-editor"), rect("#hydra-canvas"), rect("#test-canvas")].join(" | ");
      const el = $("caption"); el.querySelector(".s")!.textContent = info; el.querySelector(".t")!.textContent = "debug"; el.classList.add("on");
      (el.querySelector(".s") as HTMLElement).style.fontSize = "22px";
    }, 22000);
  }
  if (params.get("autoplay") === "1") void perform();
  else $("go").addEventListener("click", () => void perform(), { once: true });
}

(window as any).__perform = { perform, cues, SECTIONS };
void boot();
