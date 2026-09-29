import { checkPassage, proposedArgs, sourceOf, type Review, type StudioMode } from '../src/studio-review';
import type { StudioCommand, StudioSnapshot } from '../src/studio-session';
import { chatHandoff } from '../src/studio-handoff';
import { createAudition } from './studio-audition';

type Snapshot = StudioSnapshot & { revision: number; busy: boolean };
export function installReview(options: {
  active: () => StudioMode;
  request: (mode: StudioMode, command: StudioCommand) => Promise<Snapshot>;
  stopPrimary: () => Promise<unknown>;
  log: (text: string) => void;
}) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  let review: Review | undefined;
  let audition: ReturnType<typeof createAudition> | undefined;
  let generation = 0;
  let working = false;
  let stale = false;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  const notice = (text: string, error = false) => {
    $('review-status').textContent = text;
    $('review-status').classList.toggle('error', error);
  };
  function stop() {
    generation++;
    clearTimeout(lifetime);
    const wasOpen = !!audition;
    audition?.dispose(); audition = undefined;
    $('audition').hidden = true;
    if (wasOpen) notice('Preview stopped. Your draft is unchanged.');
  }
  function buttons() {
    const proposed = review?.replacement !== undefined;
    $<HTMLButtonElement>('hear-suggestion').disabled = !proposed || stale || working;
    $<HTMLButtonElement>('apply-suggestion').disabled = !proposed || stale || working;
    $<HTMLButtonElement>('capture-selection').disabled = working;
    $<HTMLButtonElement>('dismiss-suggestion').disabled = working;
    $<HTMLButtonElement>('try-edit').disabled = working || stale;
  }
  function render() {
    $('review-content').hidden = !review;
    $('review-empty').hidden = !!review;
    if (!review) return;
    const p = review.passage;
    $('passage-label').textContent = `${p.mode === 'score' ? 'ABC' : 'Strudel'} · ${p.from === p.to ? 'cursor' : `${p.to - p.from} characters`}`;
    $('selected-passage').textContent = p.text || '(Insert at cursor)';
    $('review-explanation').textContent = review.explanation;
    const proposed = review.replacement !== undefined;
    $('suggestion').hidden = !proposed;
    $('proposed-passage').textContent = review.replacement || '(Remove selected text)';
    $<HTMLTextAreaElement>('replacement').value = review.replacement ?? p.text;
    buttons();
  }
  async function stage(next: Review) {
    if (working) throw new Error('Finish the current review action first.');
    const mode = options.active();
    if (next.passage.mode !== mode) throw new Error('Open this mode before sharing a passage.');
    const intent = generation;
    const current = await options.request(mode, { action: 'get' });
    if (intent !== generation || options.active() !== mode) throw new Error('The workspace changed. Try again.');
    checkPassage(next.passage, current);
    stop(); review = structuredClone(next); stale = false;
    $('manual-edit').removeAttribute('open');
    $('copy-status').textContent = '';
    $('copy-fallback').hidden = true; $('copy-fallback-label').hidden = true;
    render();
    notice(next.replacement === undefined ? 'Passage ready.' : 'Suggestion ready. Preview it or apply it to your draft.');
    return { staged: true, passage: next.passage, explanation: next.explanation, replacement: next.replacement, draftUnchanged: true };
  }
  function sync(mode: StudioMode, state: Snapshot) {
    if (!review || mode !== review.passage.mode) return;
    try { checkPassage(review.passage, state); }
    catch {
      stale = true; stop();
      notice('The draft changed. Share the passage again to review a new suggestion.', true);
      buttons();
    }
  }
  async function checked() {
    const currentReview = review;
    if (!currentReview || options.active() !== currentReview.passage.mode) throw new Error('Share a passage from the current workspace first.');
    const state = await options.request(currentReview.passage.mode, { action: 'get' });
    if (review !== currentReview || options.active() !== currentReview.passage.mode) throw new Error('The shared passage changed. Try again.');
    return { currentReview, state, args: proposedArgs(currentReview, state) };
  }
  function run(fn: () => Promise<void>) {
    if (working) return;
    working = true; buttons();
    void fn().catch(error => notice(error instanceof Error ? error.message : String(error), true)).finally(() => { working = false; buttons(); });
  }
  $('capture-selection').addEventListener('click', () => {
    // stage owns its own guard; do not hold the mutation lock while capturing.
    const mode = options.active();
    void options.request(mode, { action: 'get' }).then(state => {
      if (mode !== options.active()) throw new Error('The workspace changed. Select the passage again.');
      const selection = state.selection ?? { from: 0, to: 0, text: '' };
      if (selection.from === selection.to && !sourceOf(mode, state).trim()) throw new Error('Write some music first, then select a passage.');
      return stage({ passage: { mode, revision: state.revision, ...selection }, explanation: 'Ask your agent about this passage in your current chat. Its explanation and suggested edit can appear here.' });
    }).then(() => { $('review-title').focus(); }).catch(error => notice(String(error), true));
  });
  $('try-edit').addEventListener('click', () => {
    if (!review) return;
    void stage({ ...review, replacement: $<HTMLTextAreaElement>('replacement').value, explanation: 'Your proposed edit. Preview it in the full piece before applying.' }).catch(error => notice(String(error), true));
  });
  $('hear-suggestion').addEventListener('click', () => run(async () => {
    stop();
    const intent = generation;
    const { currentReview, state, args } = await checked();
    await options.stopPrimary();
    if (intent !== generation || review !== currentReview) return;
    $('audition').hidden = false;
    notice('Loading preview…');
    const player = createAudition($('audition-player'), currentReview.passage.mode);
    audition = player;
    try {
      const result = await player.load(args, state.settings);
      if (intent !== generation) return;
      if (result.error) notice(`Preview: ${result.error}`, true);
      else notice('Press Play in the preview to hear the proposed edit in context.');
      lifetime = setTimeout(() => { stop(); notice('Preview closed after 2 minutes. Reopen it to listen again.'); }, 120_000);
    } catch (error) {
      if (intent !== generation) return;
      stop(); throw error;
    }
  }));
  $('apply-suggestion').addEventListener('click', () => run(async () => {
    stop();
    const { currentReview, state, args } = await checked();
    const result = await options.request(currentReview.passage.mode, { action: 'set', args, expectedRevision: state.revision });
    review = undefined; stale = false; render();
    notice(result.error ? `Edit applied, but it has an error: ${result.error}. Use Undo edit to restore the draft.` : 'Edit applied. Use Undo edit to restore the previous draft.', !!result.error);
    options.log(result.error ? 'Suggested edit applied with an error' : 'Suggested edit applied');
  }));
  $('dismiss-suggestion').addEventListener('click', () => {
    if (working) { stop(); return; }
    stop(); review = undefined; stale = false; render(); notice('Review cleared. Your draft is unchanged.');
  });
  $('copy-passage').addEventListener('click', () => {
    if (!review) return;
    const text = chatHandoff(review, $<HTMLTextAreaElement>('passage-question').value);
    // Clipboard access happens in the click gesture. No model is invoked.
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        $('copy-status').textContent = 'Copied. Paste it into your chat; nothing was sent automatically.';
        $('copy-fallback').hidden = true; $('copy-fallback-label').hidden = true;
      } catch {
        const fallback = $<HTMLTextAreaElement>('copy-fallback');
        fallback.value = text; fallback.hidden = false; $('copy-fallback-label').hidden = false;
        fallback.focus(); fallback.select();
        $('copy-status').textContent = 'Clipboard unavailable. Copy the text below.';
      }
    })();
  });
  $('stop-preview').addEventListener('click', stop);
  return { stage, sync, stop, shared: () => review ? structuredClone({ ...review, stale }) : null,
    changeMode() { stop(); review = undefined; stale = false; render(); notice(''); },
  };
}
