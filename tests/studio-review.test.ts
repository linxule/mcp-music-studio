import { describe, expect, it } from 'vitest';
import { checkPassage, proposedArgs, type Review } from '../src/studio-review';
import { createStudioSession, type StudioSnapshot } from '../src/studio-session';

const source = 'X:1\nT:Test\nM:4/4\nL:1/8\nK:Am\nA2 c2 e2 c2 |';
const state = { instanceId: "test-score", mode: "score" as const, args: { abcNotation: source, instrument: 'Acoustic Grand Piano' }, revision: 4, settings: { warp: 110 }, playback: 'stopped', status: 'Ready', error: null };
const from = source.indexOf('A2');
const review: Review = { passage: { instanceId: "test-score", mode: 'score', revision: 4, from, to: from + 12, text: 'A2 c2 e2 c2 ' }, explanation: 'Let the phrase rise.', replacement: 'A2 c2 e2 a2 ' };

describe('reviewing music passages', () => {
  it('previews a local edit inside the complete ABC context without mutating the draft', () => {
    const before = structuredClone(state);
    const args = proposedArgs(review, state);
    expect(args.abcNotation).toBe(source.replace('A2 c2 e2 c2', 'A2 c2 e2 a2'));
    expect(args.instrument).toBe(state.args.instrument);
    expect(state).toEqual(before);
  });
  it('refuses stale source and sound settings before applying or auditioning', () => {
    expect(() => proposedArgs(review, { ...state, revision: 5 })).toThrow('draft changed');
    expect(() => proposedArgs(review, { ...state, args: { ...state.args, abcNotation: source.replace('A2', 'B2') } })).toThrow('no longer matches');
  });
  it.each([-1, 1.5, source.length + 1])('rejects an invalid selection boundary %s', value => {
    expect(() => checkPassage({ ...review.passage, from: value }, state)).toThrow('outside the draft');
  });
  it('allows deliberate deletion and insertion, without expanding the selected range', () => {
    expect(proposedArgs({ ...review, replacement: '' }, state).abcNotation).toBe(source.slice(0, from) + source.slice(from + 12));
    expect(proposedArgs({ ...review, passage: { ...review.passage, to: from, text: '' }, replacement: '!p!' }, state).abcNotation).toBe(source.slice(0, from) + '!p!' + source.slice(from));
  });
  it('uses UTF-16 offsets and keeps live tempo in the source authoritative', () => {
    const live = { ...state, mode: "live" as const, args: { code: '// 🎵\ns("bd")', bpm: 120, title: 'Beat' } };
    const begin = live.args.code.indexOf('bd');
    const args = proposedArgs({ passage: { instanceId: "test-score", mode: 'live', revision: 4, from: begin, to: begin + 2, text: 'bd' }, explanation: 'Change drum.', replacement: 'sd' }, live);
    expect(args).toEqual({ code: '// 🎵\ns("sd")', title: 'Beat' });
  });
  it('does not turn an explanation into a source mutation', () => {
    expect(() => proposedArgs({ ...review, replacement: undefined }, state)).toThrow('no proposed edit');
  });
  it('keeps selection changes out of revisions and applies with a recoverable draft', async () => {
    const current: StudioSnapshot = { ...state, selection: { from: 0, to: 0, text: '' } };
    const dispatch = createStudioSession({ read: () => structuredClone(current), apply: async (args, settings) => { current.args = args; current.settings = settings; }, play: async () => {}, stop: () => {} }, { mode: 'score' });
    current.selection = { from, to: from + 12, text: review.passage.text };
    const selected = await dispatch({ action: 'get' });
    expect(selected.revision).toBe(0);
    expect(selected.selection?.text).toBe(review.passage.text);
    const updatedReview = { ...review, passage: { ...review.passage, instanceId: selected.instanceId, revision: selected.revision } };
    const applied = await dispatch({ action: 'set', args: proposedArgs(updatedReview, selected), expectedRevision: selected.revision, instanceId: selected.instanceId });
    expect(applied.settings).toEqual(state.settings);
    const undo = await dispatch({ action: 'undo', expectedRevision: applied.revision, instanceId: applied.instanceId });
    expect(undo.args).toEqual(state.args);
  });
});
