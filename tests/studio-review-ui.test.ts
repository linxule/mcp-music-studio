import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStudioSession, type StudioCommand, type StudioState, type StudioSnapshot } from '../src/studio-session';
import { installReview } from '../dev/studio-review';
import { createAudition } from '../dev/studio-audition';

const audition = vi.hoisted(() => ({ load: vi.fn(), dispose: vi.fn() }));
vi.mock('../dev/studio-audition', () => ({ createAudition: vi.fn(() => audition) }));

class Element extends EventTarget {
  value = ''; textContent = ''; hidden = false; disabled = false;
  classList = { toggle: vi.fn() };
  removeAttribute() {}
  focus() { (document as unknown as { activeElement: Element }).activeElement = this; }
  select() {}
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
const dispose: Array<() => void> = [];
beforeEach(() => { vi.mocked(createAudition).mockClear(); audition.dispose.mockReset(); audition.load.mockReset(); audition.load.mockResolvedValue({ error: null }); });
afterEach(() => { dispose.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

async function fixture(mode: 'live' | 'score' = 'score') {
  const elements = new Map<string, Element>();
  for (const id of ['passage-question', 'review-status', 'audition', 'hear-suggestion', 'apply-suggestion', 'capture-selection',
    'dismiss-suggestion', 'try-edit', 'review-content', 'review-empty', 'passage-label', 'selected-passage',
    'review-explanation', 'suggestion', 'proposed-passage', 'replacement', 'manual-edit', 'copy-status',
    'copy-fallback', 'copy-fallback-label', 'audition-player', 'copy-passage', 'stop-preview']) elements.set(id, new Element());
  const el = (id: string) => elements.get(id)!;
  el('passage-question').value = 'Explain this phrase.';
  vi.stubGlobal('document', { getElementById: el, activeElement: null });
  const source = mode === 'live' ? 's("bd")' : 'X:1\nK:C\nCDEF|';
  let active = mode;
  const draft: StudioSnapshot = { args: { [mode === 'live' ? 'code' : 'abcNotation']: source, title: 'Phrase' }, playback: 'stopped', error: null, status: 'Ready', selection: mode === 'live' ? { from: 3, to: 5, text: 'bd' } : { from: 0, to: source.length, text: source } };
  const apply = vi.fn(async (args: Record<string, unknown>, settings?: Record<string, unknown>, _cancelled?: () => boolean, onCommit?: () => void) => {
    draft.args = args; draft.settings = settings; onCommit?.();
  });
  const play = vi.fn(async () => { throw new Error('No automatic playback'); });
  const session = createStudioSession({ read: () => structuredClone(draft), apply, play, stop: () => {} }, { mode });
  let panel!: ReturnType<typeof installReview>;
  const request = vi.fn(async (_mode: 'live' | 'score', command: StudioCommand): Promise<StudioState> => {
    const next = await session({ ...command, instanceId: command.instanceId ?? session.instanceId });
    panel.sync(mode, next);
    return next;
  });
  const stopPrimary = vi.fn(() => session({ action: 'stop', instanceId: session.instanceId }));
  panel = installReview({ active: () => active, request, stopPrimary, log: () => {} });
  dispose.push(() => { panel.stop(); session.dispose(); });
  const before = await request(mode, { action: 'get' });
  const started = await request(mode, { action: 'review-start', expectedRevision: before.revision,
    question: el('passage-question').value, passage: { instanceId: before.instanceId, mode, revision: before.revision, ...draft.selection! } });
  return { el, panel, request, session, draft, apply, play, started, stopPrimary,
    changeMode: () => { active = mode === 'live' ? 'score' : 'live'; panel.changeMode(); },
    stage: () => panel.stage({ requestId: started.sharedReview!.requestId, passage: started.sharedReview!.passage,
      explanation: 'Use a snare.', replacement: 'sd' }),
  };
}

describe('passage review interactions', () => {
  it('shares an actual editor selection without changing the source', async () => {
    const h = await fixture('live');
    const original = structuredClone(h.draft.args);
    const firstRequest = h.started.sharedReview!.requestId;
    h.el('capture-selection').click();
    await vi.waitFor(() => expect(h.panel.shared()?.requestId).not.toBe(firstRequest));
    expect(h.panel.shared()?.passage).toEqual({ instanceId: h.session.instanceId, mode: 'live', revision: h.started.revision, from: 3, to: 5, text: 'bd' });
    expect(h.draft.args).toEqual(original);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.play).not.toHaveBeenCalled();
    expect(h.request.mock.calls.some(([, command]) => command.action === 'review-start')).toBe(true);
  });

  it('auditions the full candidate separately and closes it on Stop', async () => {
    const h = await fixture('live');
    await h.stage();
    h.el('hear-suggestion').click();
    await vi.waitFor(() => expect(audition.load).toHaveBeenCalledOnce());
    expect(h.stopPrimary).toHaveBeenCalledOnce();
    expect(audition.load).toHaveBeenCalledWith({ code: 's("sd")', title: 'Phrase' }, undefined);
    expect(h.draft.args.code).toBe('s("bd")');
    h.panel.stop();
    expect(audition.dispose).toHaveBeenCalledOnce();
    expect(h.el('audition').hidden).toBe(true);
    expect(h.play).not.toHaveBeenCalled();
  });

  it('does not mount a player if Stop arrives during source validation', async () => {
    const h = await fixture('live');
    await h.stage();
    const snapshot = await h.session({ action: 'get' });
    let resolve!: (value: StudioState) => void;
    h.request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    h.el('hear-suggestion').click();
    h.panel.stop();
    resolve(snapshot);
    await vi.waitFor(() => expect(h.el('capture-selection').disabled).toBe(false));
    expect(createAudition).not.toHaveBeenCalled();
    expect(h.stopPrimary).not.toHaveBeenCalled();
    expect(h.draft.args.code).toBe('s("bd")');
  });

  it('ignores a preview load that finishes after a mode switch', async () => {
    const h = await fixture('live');
    await h.stage();
    let resolve!: (value: { error: null }) => void;
    audition.load.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    h.el('hear-suggestion').click();
    await vi.waitFor(() => expect(audition.load).toHaveBeenCalledOnce());
    h.changeMode();
    resolve({ error: null });
    await vi.waitFor(() => expect(h.el('capture-selection').disabled).toBe(false));
    expect(audition.dispose).toHaveBeenCalledOnce();
    expect(h.el('audition').hidden).toBe(true);
    expect(h.el('review-status').textContent).toBe('');
    expect(h.panel.shared()).toBeNull();
    expect(h.draft.args.code).toBe('s("bd")');
  });

  it('refuses stale edits at click time even without an earlier state notification', async () => {
    const h = await fixture('live');
    await h.stage();
    // A human edit has not yet caused panel.sync; the Apply click must read it.
    h.draft.args.code = 's("hh")';
    h.el('apply-suggestion').click();
    await vi.waitFor(() => expect(h.el('review-status').textContent).toContain('draft changed'));
    expect(h.draft.args.code).toBe('s("hh")');
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('applies only the reviewed replacement through the revision-checked session', async () => {
    const h = await fixture('live');
    await h.stage();
    h.el('apply-suggestion').click();
    await vi.waitFor(() => expect(h.draft.args.code).toBe('s("sd")'));
    expect(h.request).toHaveBeenLastCalledWith('live', { action: 'review-apply', requestId: h.started.sharedReview!.requestId, expectedRevision: h.started.revision });
    expect(h.apply).toHaveBeenCalledOnce();
    expect(h.el('review-status').textContent).toContain('Undo edit');
    expect(h.panel.shared()).toBeNull();
    expect(h.play).not.toHaveBeenCalled();
    const current = await h.session({ action: 'get' });
    expect(current.canUndo).toBe(true);
    const undone = await h.session({ action: 'undo', instanceId: h.session.instanceId, expectedRevision: current.revision });
    expect(undone.args.code).toBe('s("bd")');
  });

  it('shows rendering errors after an edit rather than claiming success', async () => {
    const h = await fixture('live');
    await h.stage();
    h.draft.error = 'Syntax error';
    h.el('apply-suggestion').click();
    await vi.waitFor(() => expect(h.el('review-status').textContent).toContain('Syntax error'));
    expect(h.el('review-status').textContent).toContain('Undo edit');
    expect((await h.session({ action: 'get' })).canUndo).toBe(true);
    expect(h.play).not.toHaveBeenCalled();
  });

  it('shows a manual copy fallback when clipboard access is denied', async () => {
    const h = await fixture('live');
    await h.stage();
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('Denied')) };
    vi.stubGlobal('navigator', { clipboard });
    const fallback = h.el('copy-fallback');
    const select = vi.spyOn(fallback, 'select');
    h.el('passage-question').focus();
    h.el('passage-question').value = 'Make this softer.';
    h.el('passage-question').dispatchEvent(new Event('input'));
    await vi.waitFor(async () => expect((await h.session({ action: 'get' })).sharedReview?.question).toBe('Make this softer.'));
    h.el('copy-passage').click();
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledOnce());
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Make this softer.'));
    expect(fallback.hidden).toBe(false);
    expect(fallback.value).toContain('bd');
    expect(fallback.value).toContain(h.session.instanceId);
    expect(select).toHaveBeenCalledOnce();
    expect(h.el('copy-status').textContent).toContain('Clipboard unavailable');
  });
});

describe('dev review panel mirroring shared session authority', () => {
  it('preserves unstaged manual text through state reads and explanation-only updates', async () => {
    const { el, request, started } = await fixture();
    const manual = 'X:1\nK:C\nGABc|';
    el('replacement').value = manual;
    await request('score', { action: 'get' });
    expect(el('replacement').value).toBe(manual);
    const review = started.sharedReview!;
    await request('score', { action: 'review-stage', requestId: review.requestId, passage: review.passage, explanation: 'The melody rises.' });
    expect(el('replacement').value).toBe(manual);
    await request('score', { action: 'review-stage', requestId: review.requestId, passage: review.passage, explanation: 'Try this ascent.', replacement: 'X:1\nK:C\ncdef|' });
    expect(el('replacement').value).toBe('X:1\nK:C\ncdef|');
  });

  it('preserves the newly typed question when Share selection triggers a read after blur', async () => {
    const { el, request, session } = await fixture();
    el('passage-question').value = 'Explain a different musical effect.  ';
    el('capture-selection').click();
    await vi.waitFor(async () => {
      const state = await session({ action: 'get' });
      expect(state.sharedReview?.question).toBe('Explain a different musical effect.  ');
    });
    const state = await request('score', { action: 'get' });
    expect(el('passage-question').value).toBe(state.sharedReview!.question);
  });

  it('cancels a loading preview immediately on question input and preserves blank-to-new requests', async () => {
    const { el, request, session, draft, apply, play, started } = await fixture();
    const original = structuredClone(draft.args);
    const review = started.sharedReview!;
    await request('score', { action: 'review-stage', requestId: review.requestId, passage: review.passage,
      explanation: 'Try an ascent.', replacement: 'X:1\nK:C\nGABc|' });
    let finish!: (value: { error: null }) => void;
    audition.load.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    el('hear-suggestion').click();
    await vi.waitFor(() => expect(audition.load).toHaveBeenCalledOnce());
    el('passage-question').focus();
    el('passage-question').value = '';
    el('passage-question').dispatchEvent(new Event('input'));
    expect(audition.dispose).toHaveBeenCalledOnce();
    expect(el('audition').hidden).toBe(true);
    expect(el('apply-suggestion').disabled).toBe(true);
    await vi.waitFor(async () => expect((await session({ action: 'get' })).sharedReview?.question).toBe(''));
    el('passage-question').value = 'What about rhythm?  ';
    el('passage-question').dispatchEvent(new Event('input'));
    await vi.waitFor(async () => {
      const current = await session({ action: 'get' });
      expect(current.sharedReview?.question).toBe('What about rhythm?  ');
      expect(current.sharedReview?.requestId).not.toBe(review.requestId);
      expect(current.sharedReview?.replacement).toBeUndefined();
    });
    finish({ error: null });
    await expect(session({ action: 'review-stage', instanceId: session.instanceId, requestId: review.requestId,
      passage: review.passage, explanation: 'Late answer.', replacement: 'bad' })).rejects.toThrow('superseded');
    expect(draft.args).toEqual(original);
    expect(apply).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(el('audition').hidden).toBe(true);
  });
});
