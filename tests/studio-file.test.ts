import { describe, expect, it, vi } from 'vitest';
import { parseStudioFile, savedDraft, draftSignature, reviewForMode, connectStudioTools } from '../src/studio-file';
import { chatHandoff } from '../src/studio-handoff';
const file = {
  format: 'music-studio', version: 1, active: 'score',
  drafts: {
    live: { args: { code: 's("bd")', title: 'Beat', theme: 'nord' } },
    score: { args: { abcNotation: 'X:1\nK:C\nCDEF|', instrument: 'Flute', swing: 60, drumIntro: 0 }, settings: { soundFont: 'dry', room: false, instrumentOverride: true, warp: 120, loop: true } },
  },
};
describe('portable studio sessions', () => {
  it('round-trips both drafts and sound settings', () => { expect(parseStudioFile(JSON.stringify(file))).toEqual(file); });
  it('keeps empty and unfinished drafts', () => {
    const empty = structuredClone(file); empty.drafts.live.args.code = ''; empty.drafts.score.args.abcNotation = 'unfinished';
    expect(parseStudioFile(JSON.stringify(empty))).toEqual(empty);
  });
  it.each([
    { ...file, version: 2 }, { ...file, drafts: {} },
    { ...file, drafts: { ...file.drafts, live: { args: { code: 's("bd")', autoplay: true } } } },
    { ...file, drafts: { ...file.drafts, score: { ...file.drafts.score, settings: { loop: 'false' } } } },
    { ...file, drafts: { ...file.drafts, live: { args: { code: 'x'.repeat(65537) } } } },
  ])('rejects unsupported or invalid files before changing the workspace', data => { expect(() => parseStudioFile(JSON.stringify(data))).toThrow('Unsupported session'); });
  it('rejects malformed and oversized files', () => {
    expect(() => parseStudioFile('{bad')).toThrow(); expect(() => parseStudioFile(' '.repeat(2_000_001))).toThrow('2 MB');
  });
  it('does not persist measured live tempo or treat playback tempo feedback as a draft change', () => {
    const a = { args: { code: 'setcps(1)\ns("bd")', bpm: 120 } };
    const b = { args: { ...a.args, bpm: 240 } };
    expect(draftSignature('live', a)).toBe(draftSignature('live', b));
    expect(savedDraft('live', a).args).not.toHaveProperty('bpm');
    expect(a.args.bpm).toBe(120);
  });
  it('does treat source and score sound changes as unsaved changes', () => {
    const a = file.drafts.score;
    expect(draftSignature('score', a)).not.toBe(draftSignature('score', { ...a, settings: { ...a.settings, room: true } }));
  });
  it('does not attach a live review to a score read', () => {
    const review = { passage: { mode: 'live' as const } };
    expect(reviewForMode('score', review)).toBeNull(); expect(reviewForMode('live', review)).toBe(review);
  });
});
describe('agent connection fallback', () => {
  it('detects absent or incomplete APIs', async () => {
    const status = vi.fn(); const register = vi.fn();
    await connectStudioTools([{}, undefined], register, status);
    expect(register).not.toHaveBeenCalled(); expect(status).toHaveBeenLastCalledWith('WebMCP unavailable. Use Copy for chat.');
  });
  it('uses a callable legacy API if the primary API is incomplete', async () => {
    const legacy = { registerTool: vi.fn() }; const register = vi.fn(); const status = vi.fn();
    await connectStudioTools([{}, legacy], register, status);
    expect(register).toHaveBeenCalledWith(legacy); expect(status).toHaveBeenLastCalledWith('Agent tools ready');
  });
  it('reports partial registration failure instead of leaving Checking visible', async () => {
    const status = vi.fn();
    await connectStudioTools([{ registerTool: vi.fn() }], async () => { throw new Error('Not supported'); }, status);
    expect(status).toHaveBeenLastCalledWith('Some agent tools could not load. Use Copy for chat or reload.');
  });
});
it('copies only the chosen passage, question, and optional proposal', () => {
  const text = chatHandoff({ passage: { mode: 'live', revision: 2, from: 5, to: 7, text: 'bd' }, explanation: 'private explanation', replacement: 'sd' }, 'Make this softer.');
  expect(text).toContain('Make this softer.'); expect(text).toContain('bd'); expect(text).toContain('sd'); expect(text).not.toContain('private explanation');
});
