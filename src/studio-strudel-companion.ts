/** Human-facing marginalia for the local studio. Uses the pinned REPL's own
 * registry and the shared Strudel syntax parser. Never evaluates a draft. */
// @ts-expect-error upstream package has no TypeScript declarations
import { transpiler } from "@strudel/transpiler";
export interface RegisteredSound {
  data?: { type?: string; samples?: unknown[] | Record<string, unknown> };
  onTrigger(time: number, value: Record<string, unknown>, ended: () => void): Promise<PreviewVoice> | PreviewVoice;
}
interface PreviewVoice { node: AudioNode; stop?: (time: number) => void }
interface CompanionOptions {
  container: HTMLElement;
  stage: HTMLElement;
  status: HTMLElement;
  editor: () => any;
  playing: () => boolean;
  recording: () => boolean;
}

const STARTERS: Record<string, string> = {
  bd: 'Kick drum', sd: 'Snare drum', hh: 'Closed hi-hat', cp: 'Handclap',
  oh: 'Open hi-hat', rim: 'Rimshot', triangle: 'Soft, rounded synth',
  sine: 'Pure, smooth tone', sawtooth: 'Bright, buzzy synth', square: 'Hollow, chiptune tone',
  piano: 'Acoustic piano', marimba: 'Warm wooden mallets', kalimba: 'Plucked thumb piano',
  harp: 'Plucked strings', crow: 'Field recording', space: 'Textural sample',
};
const LESSONS = [
  ['A first beat', 'Four evenly spaced sounds in one cycle. Change a name, then press Play.', 's("bd hh sd hh")'],
  ['Leave some air', 'The ~ is a rest. Try removing a hit before adding another.', 's("bd ~ sd ~")'],
  ['Repeat a sound', 'The * repeats a sound within its step. Try changing 4 to 8.', 's("hh*4").gain(0.3)'],
  ['Notes and timbre', 'note() chooses pitches; s() chooses the instrument.', 'note("c4 e4 g4 e4").s("triangle")'],
  ['Play together', 'stack() layers patterns. A comma separates each part.', 'stack(\n  s("bd ~ sd ~"),\n  s("hh*8").gain(0.25)\n)'],
  ['An evolving phrase', 'Angle brackets choose a different note each cycle.', 'note("<c4 e4 g4 a4>").s("piano")'],
  ['Soften the edge', 'Chain effects with a dot. This low-pass filter removes higher frequencies.', 'note("c3 e3 g3").s("sawtooth").lpf(800).gain(0.3)'],
  ['Give it room', 'A little reverb lets notes linger. Start with a small amount.', 'note("c4 e4 g4").s("marimba").room(0.3)'],
] as const;

export function soundExample(name: string, type: string, variant = 0): string {
  const sound = JSON.stringify(name);
  return `${type === 'synth' || type === 'soundfont' || /^(gm_|piano|marimba|kalimba|harp)/.test(name) ? 'note("c4 e4 g4").' : ''}s(${sound})${variant ? `.n(${variant})` : ''}.gain(0.35)`;
}

export function errorSuggestion(message: string): string {
  if (/sound .+ not found/i.test(message)) return 'Search Sounds for a registered name. Check spelling and the bank name; a missing sound can leave one layer silent.';
  if (/not defined|is not a function/i.test(message)) return 'Check the function name and capitalization. Start with s(), note(), or stack(); sound names belong inside quotes.';
  if (/unterminated|string|quote/i.test(message)) return 'Check that each opening quote has a closing quote. Use straight quotes around sound names and notes.';
  if (/unexpected|expected|parse|syntax/i.test(message)) return 'Check the nearby quotes, parentheses and commas. Inside stack(), separate the patterns with commas.';
  return 'Syntax checks do not test sounds or playback. Press Play to check both.';
}

/** One bounded voice, independent of the pattern scheduler. A cancelled async
 * sample load must never connect a late voice to the speakers. */
export function createSoundPreview(
  getContext: () => AudioContext | null,
  prepare: (sound: RegisteredSound, value: Record<string, unknown>) => Promise<unknown> = async () => {},
) {
  let generation = 0;
  let voice: PreviewVoice | undefined;
  let output: GainNode | undefined;
  let context: AudioContext | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const stopVoice = (v: PreviewVoice | undefined, ctx: AudioContext | null) => {
    try { v?.stop?.(ctx?.currentTime ?? 0); } catch { /* already ended */ }
    try { v?.node.disconnect(); } catch { /* already disconnected */ }
  };
  const stop = () => {
    generation++;
    cancel?.(); cancel = undefined;
    clearTimeout(timer);
    if (output) { output.gain.value = 0; output.disconnect(); }
    stopVoice(voice, context);
    voice = undefined; output = undefined;
  };
  return {
    stop,
    async play(sound: RegisteredSound, name: string, variant: number) {
      stop();
      const intent = generation;
      const ctx = getContext();
      context = ctx;
      if (!ctx) throw new Error('Audio has not loaded yet.');
      const cancellation = new Promise<undefined>(resolve => { cancel = () => resolve(undefined); });
      timer = setTimeout(stop, 8000);
      const resumed = await Promise.race([ctx.resume().then(() => true).catch(error => { if (intent === generation) stop(); throw error; }), cancellation]);
      if (!resumed || intent !== generation) return false;
      if (ctx.state !== 'running') { stop(); throw new Error('Audio is paused by the browser. Try Preview again.'); }
      const value = { s: name, n: variant, note: 60, duration: 0.65, release: 0.08, clip: 1 };
      try {
        const ready = await Promise.race([prepare(sound, value).then(() => true), cancellation]);
        if (!ready || intent !== generation) return false;
      } catch (error) { if (intent === generation) stop(); throw error; }
      clearTimeout(timer); timer = setTimeout(stop, 1800);
      const gain = ctx.createGain();
      gain.gain.value = 0.22;
      output = gain;
      // Cut off both the audition and any sample load that arrives too late.
      let next: PreviewVoice | undefined;
      try {
        const loading = Promise.resolve(sound.onTrigger(ctx.currentTime + 0.04,
          value, () => {}))
          .then(loaded => { if (intent !== generation) stopVoice(loaded, ctx); return loaded; });
        next = await Promise.race([loading, cancellation]);
      } catch (error) { if (intent === generation) stop(); throw error; }
      if (intent !== generation) { stopVoice(next, ctx); return false; }
      if (!next?.node) { stop(); throw new Error('This sound cannot be previewed here.'); }
      voice = next;
      next.node.connect(gain);
      gain.connect(ctx.destination);
      return true;
    },
  };
}

export function installStrudelCompanion(options: CompanionOptions) {
  const { stage, status, container } = options;
  const runtime = window as any;
  const preview = createSoundPreview(() => runtime.getAudioContext?.() ?? null,
    async (sound, value) => {
      // Sample triggers drop late notes. Warm the engine's own cache first,
      // then schedule the audition against its current clock.
      if (sound.data?.samples && typeof runtime.getSampleBuffer === 'function') {
        await runtime.getSampleBuffer(value, sound.data.samples);
      }
    });
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = cls; return node;
  };
  const button = (text: string, run: () => void) => {
    const node = el('button', text); node.type = 'button'; node.addEventListener('click', run); return node;
  };
  const feedback = el('section', '', 'live-feedback');
  feedback.setAttribute('aria-label', 'Pattern feedback');
  feedback.append(el('h2', 'While you write', 'companion-label'));
  const feedbackBody = el('div', '', 'live-feedback-body');
  feedbackBody.tabIndex = 0;
  feedbackBody.setAttribute('role', 'region'); feedbackBody.setAttribute('aria-label', 'Current pattern feedback');
  const syntax = el('p', 'Loading syntax checker…');
  syntax.setAttribute('role', 'status');
  const tip = el('p', '', 'companion-muted');
  feedbackBody.append(syntax, status, tip); feedback.append(feedbackBody);
  stage.after(feedback);

  const panel = el('aside', '', 'strudel-companion');
  panel.setAttribute('aria-label', 'Pattern companion');
  const heading = el('div', '', 'companion-heading');
  heading.append(el('h2', 'Find your sound'));
  const tabs = el('div', '', 'companion-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Companion view');
  const sounds = el('section', '', 'companion-sounds');
  const learn = el('section', '', 'companion-learn'); learn.hidden = true;
  const soundsTab = button('Sounds', () => setView(false));
  const learnTab = button('Small lessons', () => setView(true));
  const setView = (lessons: boolean) => {
    sounds.hidden = lessons; learn.hidden = !lessons;
    soundsTab.setAttribute('aria-pressed', String(!lessons)); learnTab.setAttribute('aria-pressed', String(lessons));
    heading.querySelector('h2')!.textContent = lessons ? 'One small change' : 'Find your sound';
  };
  setView(false); tabs.append(soundsTab, learnTab); heading.append(tabs);
  panel.append(heading, sounds, learn); feedback.after(panel);

  const searchLabel = el('label', 'Search sounds', 'companion-label');
  const search = el('input'); search.type = 'search'; search.placeholder = 'piano, kick, 808…'; search.id = 'sound-search'; searchLabel.htmlFor = search.id;
  const filterLabel = el('label', 'Collection', 'companion-label');
  const filter = el('select'); filter.id = 'sound-collection'; filterLabel.htmlFor = filter.id;
  for (const [value, label] of [['starter', 'Start here'], ['all', 'All registered sounds'], ['sample', 'Samples & drum machines'], ['synth', 'Synthesizers'], ['soundfont', 'GM instruments']]) {
    const option = el('option', label); option.value = value; filter.append(option);
  }
  const count = el('p', 'Waiting for the sound library…', 'companion-muted');
  const list = el('div', '', 'sound-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Matching sounds');
  const more = button('Show more sounds', () => { limit += 40; renderList(); }); more.hidden = true;
  const detail = el('div', '', 'sound-detail'); detail.hidden = true;
  const soundTitle = el('h3'); const soundInfo = el('p', '', 'companion-muted');
  const variantsLabel = el('label', 'Sample variant', 'companion-label');
  const variants = el('select'); variants.id = 'sound-variant'; variantsLabel.htmlFor = variants.id;
  const example = el('code'); const pre = el('pre'); pre.append(example);
  const auditionStatus = el('p', '', 'companion-muted'); auditionStatus.setAttribute('role', 'status');
  const insertStatus = el('p', '', 'companion-muted'); insertStatus.setAttribute('role', 'status');
  const previewButton = button('Preview sound', () => { void audition(); });
  const stopButton = button('Stop preview', () => { stop(); auditionStatus.textContent = 'Preview stopped.'; });
  const insertButton = button('Insert at cursor', () => insert(example.textContent ?? ''));
  const actions = el('div', '', 'companion-actions'); actions.append(previewButton, stopButton, insertButton);
  detail.append(soundTitle, soundInfo, variantsLabel, variants, pre, actions, auditionStatus);
  sounds.append(searchLabel, search, filterLabel, filter, count, list, more, detail,
    el('p', 'Samples download on first use. Download errors appear below the editor.', 'companion-muted'));
  const insertionHelp = el('details', '', 'companion-footnote');
  insertionHelp.append(el('summary', 'How insertion works'), el('p', 'Insert replaces selected text or adds at the cursor. Undo with ⌘Z / Ctrl+Z. Press Play to listen.'));
  panel.append(insertionHelp, insertStatus);

  function insert(code: string) {
    const view = options.editor()?.editor;
    if (!view?.state?.replaceSelection || !view?.dispatch) { insertStatus.textContent = 'Wait for the editor to load, then try again.'; return; }
    view.dispatch(view.state.replaceSelection(code)); view.focus();
    insertStatus.textContent = 'Inserted. Press Play to listen.';
    checkDraft();
  }
  learn.append(el('p', 'Try a single idea. Each example is a complete pattern: select the source you want to replace, then insert it.', 'companion-intro'));
  for (const [title, description, code] of LESSONS) {
    const row = el('details', '', 'companion-lesson');
    row.append(el('summary', title), el('p', description));
    const codeBlock = el('pre'); codeBlock.append(el('code', code));
    row.append(codeBlock, button(`Insert example: ${title}`, () => insert(code))); learn.append(row);
  }
  const collaboration = el('details', '', 'companion-lesson');
  collaboration.append(el('summary', 'Compose with an agent'), el('p', 'Keep a sound you like in the source, then ask your agent for one specific change: “Keep this kick and tempo; make the hi-hat sparser.” The agent can read your current draft. Use Undo agent edit above the workspace to compare.'));
  learn.append(collaboration);

  let registry: Record<string, RegisteredSound> = {};
  let selected = '';
  let limit = 40;
  let previewIntent = 0;
  let previewPending = false;
  let subscribed: unknown;
  let unsubscribe: (() => void) | undefined;
  let registryTimer: ReturnType<typeof setTimeout> | undefined;
  const category = (name: string) => name.startsWith('gm_') ? 'soundfont' : registry[name]?.data?.type ?? 'sample';
  function stop() { previewIntent++; previewPending = false; preview.stop(); }
  async function audition() {
    if (previewPending) return;
    if (options.playing() || options.recording()) { auditionStatus.textContent = 'Stop the pattern before previewing a sound.'; return; }
    const sound = registry[selected]; if (!sound) return;
    stop(); const intent = previewIntent; previewPending = true;
    auditionStatus.textContent = 'Loading a short preview…';
    try {
      const played = await preview.play(sound, selected, Number(variants.value || 0));
      if (intent === previewIntent) auditionStatus.textContent = played ? 'Preview at C4. Your draft is unchanged.' : 'Preview ended before the sound was ready. Try again to use the cached sample.';
    } catch (error) {
      if (intent === previewIntent) auditionStatus.textContent = `Preview unavailable: ${error instanceof Error ? error.message : String(error)}`;
    } finally { if (intent === previewIntent) previewPending = false; }
  }
  function select(name: string) {
    stop(); selected = name;
    detail.hidden = false; soundTitle.textContent = name; auditionStatus.textContent = '';
    const sampleData = registry[name]?.data?.samples;
    // Pitched maps can have multiple zones; only arrays are indexable variants.
    const n = Array.isArray(sampleData) ? sampleData.length : 1;
    soundInfo.textContent = `${STARTERS[name] ?? (category(name) === 'sample' ? 'Recorded sample' : 'Pitched instrument')} · ${n > 1 ? `${n} variants` : 'single sound'}`;
    variants.replaceChildren();
    for (let i = 0; i < Math.max(1, n); i++) { const option = el('option', `Variant ${i}`); option.value = String(i); variants.append(option); }
    variants.hidden = variantsLabel.hidden = n <= 1;
    example.textContent = soundExample(name, category(name));
    list.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sound === name)));
  }
  variants.addEventListener('change', () => { stop(); example.textContent = soundExample(selected, category(selected), Number(variants.value)); });
  function renderList() {
    const query = search.value.trim().toLowerCase();
    const names = Object.keys(registry).filter(name => !['user', 'one', 'bus'].includes(name))
      .filter(name => (query || filter.value !== 'starter') ? filter.value === 'all' || filter.value === 'starter' || category(name) === filter.value : name in STARTERS)
      .filter(name => `${name} ${STARTERS[name] ?? ''}`.toLowerCase().includes(query))
      .sort((a, b) => a.localeCompare(b));
    count.textContent = names.length ? `${Math.min(names.length, limit)} of ${names.length} sounds` : Object.keys(registry).length ? 'No sounds match. Try another name or collection.' : 'Waiting for the sound library…';
    list.replaceChildren();
    for (const name of names.slice(0, limit)) {
      const b = button(name, () => select(name)); b.dataset.sound = name; b.title = STARTERS[name] ?? name;
      b.setAttribute('aria-pressed', String(selected === name)); list.append(b);
    }
    more.hidden = names.length <= limit;
  }
  search.addEventListener('input', () => { limit = 40; renderList(); });
  filter.addEventListener('change', () => { limit = 40; renderList(); });

  let previousCode: string | undefined;
  let syntaxTimer: ReturnType<typeof setTimeout> | undefined;
  function checkDraft() {
    const code = options.editor()?.code;
    if (typeof code !== 'string' || code === previousCode) return;
    previousCode = code; clearTimeout(syntaxTimer);
    document.dispatchEvent(new Event('music-studio-draft-changed'));
    syntax.textContent = 'Checking syntax…'; syntax.classList.remove('error');
    syntaxTimer = setTimeout(() => {
      if (code.length > 40000) { syntax.textContent = 'Large draft — use Play to evaluate.'; return; }
      if (!code.trim()) { syntax.textContent = 'Start with a sound or a small lesson.'; return; }
      try {
        transpiler(code, { emitWidgets: false });
        syntax.textContent = 'Syntax looks good.'; syntax.classList.remove('error');
        tip.textContent = errorSuggestion(status.textContent ?? '');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        syntax.textContent = `Draft: ${message}`; syntax.classList.add('error');
        tip.textContent = errorSuggestion(message);
      }
    }, 400);
  }
  function refresh() {
    container.querySelector('[contenteditable="true"]')?.setAttribute("aria-label", "Strudel source");
    checkDraft();
    const map = runtime.soundMap;
    if (map && map !== subscribed) {
      unsubscribe?.(); subscribed = map;
      const update = (value: Record<string, RegisteredSound>) => {
        registry = value;
        registryTimer ??= setTimeout(() => { registryTimer = undefined; renderList(); }, 80);
      };
      if (typeof map.subscribe === 'function') unsubscribe = map.subscribe(update);
      else if (typeof map.get === 'function') update(map.get());
    }
  }
  const draftObserver = new MutationObserver(refresh);
  draftObserver.observe(container, { subtree: true, childList: true, characterData: true });
  container.addEventListener('input', checkDraft);
  const statusObserver = new MutationObserver(() => {
    if (options.playing()) stop();
    tip.textContent = errorSuggestion(status.textContent ?? '');
  });
  statusObserver.observe(status, { childList: true, characterData: true, subtree: true });
  tip.textContent = errorSuggestion('');
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop(); unsubscribe?.(); draftObserver.disconnect(); statusObserver.disconnect();
    clearTimeout(syntaxTimer); clearTimeout(registryTimer);
    container.removeEventListener('input', checkDraft);
    window.removeEventListener('pagehide', dispose);
  };
  window.addEventListener('pagehide', dispose);
  refresh();
  return { stop, refresh: () => { if (!disposed) refresh(); }, dispose };
}
