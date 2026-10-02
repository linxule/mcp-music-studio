import { checkPassage, proposedArgs, sourceOf, type Review, type SharedReview, type StudioMode } from '../src/studio-review';
import type { StudioCommand } from '../src/studio-session';
import type { WidgetSnapshot } from './studio-client';
import { chatHandoff } from '../src/studio-handoff';
import { createAudition } from './studio-audition';

/** Review is session-owned. Only the disposable preview belongs to this UI. */
export function installReview(options: {
  active: () => StudioMode;
  request: (mode: StudioMode, command: StudioCommand) => Promise<WidgetSnapshot>;
  stopPrimary: () => Promise<unknown>;
  log: (text: string) => void;
}) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const questionEl = $<HTMLTextAreaElement>('passage-question');
  let state: WidgetSnapshot | undefined;
  let audition: ReturnType<typeof createAudition> | undefined;
  let generation = 0;
  let working = false;
  let questionIntent = 0;
  let questionPending = false;
  let questionQueue = Promise.resolve();
  let pendingPassage: SharedReview['passage'] | undefined;
  let renderedRequestId: string | null = null;
  let renderedReplacement: string | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  const current = () => state?.mode === options.active() ? state.sharedReview : null;
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
    const review = current();
    const proposed = review?.replacement !== undefined;
    const unavailable = !review || review.stale || questionPending;
    $<HTMLButtonElement>('hear-suggestion').disabled = !proposed || unavailable || working;
    $<HTMLButtonElement>('apply-suggestion').disabled = !proposed || unavailable || working;
    $<HTMLButtonElement>('capture-selection').disabled = working || questionPending;
    $<HTMLButtonElement>('dismiss-suggestion').disabled = !review && !questionPending;
    $<HTMLButtonElement>('try-edit').disabled = working || unavailable;
  }
  function render() {
    const review = current();
    $('review-content').hidden = !review;
    $('review-empty').hidden = !!review;
    if (review) {
      const p = review.passage;
      $('passage-label').textContent = `${p.mode === 'score' ? 'ABC' : 'Strudel'} · ${p.from === p.to ? 'cursor' : `${p.to - p.from} characters`}`;
      $('selected-passage').textContent = p.text || '(Insert at cursor)';
      $('review-explanation').textContent = questionPending ? '' : review.explanation;
      $('suggestion').hidden = review.replacement === undefined || questionPending;
      $('proposed-passage').textContent = review.replacement || '(Remove selected text)';
      if (renderedRequestId !== review.requestId || renderedReplacement !== review.replacement) {
        $<HTMLTextAreaElement>('replacement').value = review.replacement ?? p.text;
      }
      renderedRequestId = review.requestId;
      renderedReplacement = review.replacement;
      if (!questionPending && document.activeElement !== questionEl) questionEl.value = review.question;
    } else { renderedRequestId = null; renderedReplacement = undefined; }
    buttons();
  }
  function sync(mode: StudioMode, next: WidgetSnapshot) {
    if (mode !== options.active()) return;
    const before = current();
    state = next;
    const review = current();
    if (JSON.stringify(before) !== JSON.stringify(review)) stop();
    render();
    if (questionPending) return;
    if (review?.stale) notice('The draft changed. Share the passage again to request a new answer.', true);
    else if (review?.replacement !== undefined) notice('Suggestion ready. Preview it or apply it to your draft.');
    else if (review?.explanation) notice('Explanation ready. Your draft is unchanged.');
  }
  async function stage(next: Review & { requestId: string }) {
    const mode = options.active();
    if (questionPending) throw new Error('The question changed. Read the new request before answering.');
    if (next.passage.mode !== mode) throw new Error('Open this mode before answering its passage.');
    const result = await options.request(mode, { action: 'review-stage', instanceId: next.passage.instanceId,
      requestId: next.requestId, passage: next.passage, explanation: next.explanation,
      ...(next.replacement === undefined ? {} : { replacement: next.replacement }),
    });
    sync(mode, result);
    $('manual-edit').removeAttribute('open');
    return result;
  }
  async function checked() {
    const review = current();
    if (!review || review.stale || questionPending) throw new Error('Share a passage and ask your question before reviewing an edit.');
    const next = await options.request(review.passage.mode, { action: 'get' });
    if (next.sharedReview?.stale) throw new Error('The draft changed. Share the passage again before applying or previewing.');
    if (questionPending || next.sharedReview?.requestId !== review.requestId) {
      throw new Error('The question or passage changed. Read the current request before continuing.');
    }
    return { review: next.sharedReview, state: next, args: proposedArgs(next.sharedReview, next) };
  }
  function run(fn: () => Promise<void>) {
    if (working) return;
    working = true; buttons();
    void fn().catch(error => notice(error instanceof Error ? error.message : String(error), true))
      .finally(() => { working = false; buttons(); });
  }
  async function begin(mode: StudioMode, passage?: SharedReview['passage'], question = questionEl.value, intent?: number) {
    const next = await options.request(mode, { action: 'get' });
    if (intent !== undefined && intent !== questionIntent) return next;
    if (mode !== options.active()) throw new Error('The workspace changed. Share the passage again.');
    const selection = next.selection ?? { from: 0, to: 0, text: '' };
    if (!passage && selection.from === selection.to && !sourceOf(mode, next).trim()) throw new Error('Write some music first, then select a passage.');
    const captured = passage ?? { instanceId: next.instanceId, mode, revision: next.revision, ...selection };
    checkPassage(captured, next);
    const result = await options.request(mode, { action: 'review-start', instanceId: next.instanceId,
      expectedRevision: next.revision, question, passage: captured });
    sync(mode, result);
    $('copy-status').textContent = '';
    $('copy-fallback').hidden = true; $('copy-fallback-label').hidden = true;
    return result;
  }
  $('capture-selection').addEventListener('click', () => run(async () => {
    stop();
    await begin(options.active());
    notice('Question ready. Ask your agent in the current chat, or copy the passage and question.');
    questionEl.focus();
  }));
  questionEl.addEventListener('input', () => {
    // Cancel synchronously before bridge work or a late answer can finish.
    stop();
    const review = current();
    if (!review && !questionPending) return;
    const mode = options.active();
    const passage = review?.passage ?? pendingPassage;
    pendingPassage = passage;
    const intent = ++questionIntent;
    const question = questionEl.value;
    questionPending = true; render();
    notice('Question changed. Previous answer and preview cancelled.');
    questionQueue = questionQueue.catch(() => {}).then(async () => {
      if (intent !== questionIntent || mode !== options.active()) return;
      const latest = await options.request(mode, { action: 'get' });
      if (intent !== questionIntent || mode !== options.active()) return;
      if (latest.sharedReview) await options.request(mode, { action: 'review-clear', requestId: latest.sharedReview.requestId });
      if (intent !== questionIntent || mode !== options.active()) return;
      if (passage) await begin(mode, passage, question, intent);
      if (intent !== questionIntent) return;
      questionPending = false; render();
      notice('New question ready. Read the new request before answering.');
    }).catch(error => {
      if (intent !== questionIntent) return;
      questionPending = false; render();
      notice(error instanceof Error ? error.message : String(error), true);
    });
  });
  $('try-edit').addEventListener('click', () => run(async () => {
    const review = current();
    if (!review) throw new Error('Share a passage first.');
    await stage({ requestId: review.requestId, passage: review.passage,
      replacement: $<HTMLTextAreaElement>('replacement').value,
      explanation: 'Your proposed edit. Preview it in the full piece before applying.' });
  }));
  $('hear-suggestion').addEventListener('click', () => run(async () => {
    stop();
    const intent = generation;
    const checkedReview = await checked();
    if (intent !== generation || questionPending) return;
    await options.stopPrimary();
    if (intent !== generation || current()?.requestId !== checkedReview.review.requestId || questionPending) return;
    $('audition').hidden = false;
    notice('Loading preview…');
    const player = createAudition($('audition-player'), checkedReview.review.passage.mode);
    audition = player;
    try {
      const result = await player.load(checkedReview.args, checkedReview.state.settings);
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
    const checkedReview = await checked();
    const result = await options.request(checkedReview.review.passage.mode, { action: 'review-apply',
      requestId: checkedReview.review.requestId, expectedRevision: checkedReview.state.revision });
    sync(result.mode, result);
    notice(result.error ? `Edit applied, but it has an error: ${result.error}. Use Undo edit to restore the draft.`
      : 'Edit applied. Use Undo edit to restore the previous draft.', !!result.error);
    options.log(result.error ? 'Suggested edit applied with an error' : 'Suggested edit applied');
  }));
  $('dismiss-suggestion').addEventListener('click', () => {
    stop(); ++questionIntent; questionPending = false; pendingPassage = undefined;
    void (async () => {
      const mode = options.active();
      const next = await options.request(mode, { action: 'get' });
      if (next.sharedReview) sync(mode, await options.request(mode, { action: 'review-clear', requestId: next.sharedReview.requestId }));
      render(); notice('Review cleared. Your draft is unchanged.');
    })().catch(error => notice(String(error), true));
  });
  $('copy-passage').addEventListener('click', () => {
    const review = current();
    if (!review || questionPending) return;
    const text = chatHandoff(review, review.question);
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
  render();
  return { stage, sync, stop, shared: () => current() ? structuredClone(current()) : null,
    changeMode() { stop(); ++questionIntent; questionPending = false; pendingPassage = undefined; state = undefined; render(); notice(''); },
  };
}
