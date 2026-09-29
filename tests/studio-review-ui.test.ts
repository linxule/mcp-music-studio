import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioSnapshot } from '../src/studio-session';
import type { Review } from '../src/studio-review';
const audition = vi.hoisted(() => ({ load: vi.fn(), dispose: vi.fn() }));
vi.mock('../dev/studio-audition', () => ({ createAudition: vi.fn(() => audition) }));
import { createAudition } from '../dev/studio-audition';
import { installReview } from '../dev/studio-review';

class Element extends EventTarget {
  textContent = ''; hidden = false; disabled = false; value = '';
  classList = { toggle: vi.fn() };
  removeAttribute() {} focus() {}
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
const sample: Review = { passage: { mode: 'live', revision: 1, from: 3, to: 5, text: 'bd' }, explanation: 'Use a snare.', replacement: 'sd' };
function harness() {
  const elements = new Map<string, Element>();
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  vi.stubGlobal('document', { getElementById: el });
  let active: 'live' | 'score' = 'live';
  const state: StudioSnapshot & { revision: number; busy: boolean } = { args: { code: 's("bd")' }, selection: { from: 3, to: 5, text: 'bd' }, playback: 'stopped', status: 'Ready', error: null, revision: 1, busy: false };
  const request = vi.fn(async (_mode, command) => {
    if (command.action === 'set') { state.args = command.args; state.revision++; }
    return structuredClone(state);
  });
  const stopPrimary = vi.fn(async () => {});
  const ui = installReview({ active: () => active, request, stopPrimary, log: vi.fn() });
  return { el, state, request, stopPrimary, ui, mode: () => { active = 'score'; ui.changeMode(); } };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => { vi.clearAllMocks(); audition.load.mockResolvedValue({ error: null }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('passage review interactions', () => {
  it('shares an actual editor selection without changing the source', async () => {
    const h = harness(); h.el('capture-selection').click(); await settle();
    expect(h.ui.shared()?.passage).toEqual(sample.passage);
    expect(h.request.mock.calls.every(([, command]) => command.action === 'get')).toBe(true);
  });
  it('auditions the full candidate separately and closes it on Stop', async () => {
    const h = harness(); await h.ui.stage(sample); h.el('hear-suggestion').click(); await settle();
    expect(h.stopPrimary).toHaveBeenCalledOnce();
    expect(audition.load).toHaveBeenCalledWith({ code: 's("sd")' }, undefined);
    expect(h.state.args.code).toBe('s("bd")');
    h.ui.stop();
    expect(audition.dispose).toHaveBeenCalledOnce();
    expect(h.el('audition').hidden).toBe(true);
  });
  it('does not mount a player if Stop arrives during source validation', async () => {
    const h = harness(); await h.ui.stage(sample);
    let resolve!: (value: typeof h.state) => void;
    h.request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    h.el('hear-suggestion').click(); h.ui.stop(); resolve(h.state); await settle();
    expect(createAudition).not.toHaveBeenCalled();
  });
  it('ignores a preview load that finishes after a mode switch', async () => {
    const h = harness(); await h.ui.stage(sample);
    let resolve!: (value: unknown) => void;
    audition.load.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    h.el('hear-suggestion').click(); await settle(); h.mode(); resolve({ error: null }); await settle();
    expect(audition.dispose).toHaveBeenCalledOnce();
    expect(h.el('audition').hidden).toBe(true);
    expect(h.el('review-status').textContent).toBe('');
    expect(h.ui.shared()).toBeNull();
  });
  it('refuses stale edits at click time even without an earlier state notification', async () => {
    const h = harness(); await h.ui.stage(sample); h.state.revision++;
    h.el('apply-suggestion').click(); await settle();
    expect(h.state.args.code).toBe('s("bd")');
    expect(h.el('review-status').textContent).toContain('draft changed');
  });
  it('applies only the reviewed replacement through the revision-checked session', async () => {
    const h = harness(); await h.ui.stage(sample); h.el('apply-suggestion').click(); await settle();
    expect(h.request).toHaveBeenLastCalledWith('live', { action: 'set', args: { code: 's("sd")' }, expectedRevision: 1 });
    expect(h.el('review-status').textContent).toContain('Undo edit');
    expect(h.ui.shared()).toBeNull();
  });
  it('shows rendering errors after an edit rather than claiming success', async () => {
    const h = harness(); await h.ui.stage(sample); h.state.error = 'Syntax error';
    h.el('apply-suggestion').click(); await settle();
    expect(h.el('review-status').textContent).toContain('Syntax error');
    expect(h.el('review-status').textContent).toContain('Undo edit');
  });
});

it('shows a manual copy fallback when clipboard access is denied', async () => {
  const h = harness(); await h.ui.stage(sample);
  const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('Denied')) };
  vi.stubGlobal('navigator', { clipboard });
  const fallback = h.el('copy-fallback');
  Object.assign(fallback, { select: vi.fn() });
  h.el('passage-question').value = 'Make this softer.';
  h.el('copy-passage').click(); await settle();
  expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Make this softer.'));
  expect(fallback.hidden).toBe(false); expect(fallback.value).toContain('bd');
  expect(h.el('copy-status').textContent).toContain('Clipboard unavailable');
});
