import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSoundPreview, errorSuggestion, soundExample } from '../src/studio-strudel-companion';
import { transpiler } from '@strudel/transpiler';
import sounds from '../src/shared/data/strudel-sounds.json';

function audio() {
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const ctx = { currentTime: 0, state: 'running', destination: {}, resume: vi.fn().mockResolvedValue(undefined), createGain: () => gain };
  const voice = { node: { connect: vi.fn(), disconnect: vi.fn() }, stop: vi.fn() };
  return { gain, ctx, voice, preview: createSoundPreview(() => ctx as any) };
}
afterEach(() => vi.useRealTimers());
describe('isolated sound previews', () => {
  it('never connects a sample that finishes loading after Stop', async () => {
    const { preview, voice } = audio();
    let finish!: (v: any) => void;
    const pending = preview.play({ onTrigger: () => new Promise(resolve => { finish = resolve; }) }, 'piano', 0);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    preview.stop(); expect(await pending).toBe(false);
    finish(voice); await Promise.resolve();
    expect(voice.node.connect).not.toHaveBeenCalled(); expect(voice.stop).toHaveBeenCalled();
  });
  it('bounds an audition without touching the pattern scheduler', async () => {
    vi.useFakeTimers();
    const { preview, voice, gain } = audio();
    expect(await preview.play({ onTrigger: () => voice as any }, 'triangle', 0)).toBe(true);
    expect(gain.gain.value).toBe(0.22);
    await vi.advanceTimersByTimeAsync(1800);
    expect(gain.gain.value).toBe(0); expect(voice.stop).toHaveBeenCalled();
  });
  it('releases a hanging sample request so another audition is possible', async () => {
    vi.useFakeTimers();
    const { preview, voice } = audio();
    const pending = preview.play({ onTrigger: () => new Promise(() => {}) }, 'piano', 0);
    await vi.advanceTimersByTimeAsync(1800);
    expect(await pending).toBe(false);
    expect(await preview.play({ onTrigger: () => voice as any }, 'triangle', 0)).toBe(true);
    preview.stop();
  });
  it('cancels sample preparation before a voice can start', async () => {
    const { ctx, voice } = audio();
    let finish!: () => void;
    const preview = createSoundPreview(() => ctx as any, () => new Promise<void>(resolve => { finish = resolve; }));
    const trigger = vi.fn(() => voice as any);
    const pending = preview.play({ onTrigger: trigger }, 'piano', 0);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    preview.stop(); expect(await pending).toBe(false);
    finish(); await Promise.resolve(); expect(trigger).not.toHaveBeenCalled();
  });
  it('cancels while audio resume is pending', async () => {
    const { preview, ctx } = audio(); ctx.resume.mockReturnValue(new Promise(() => {}));
    const trigger = vi.fn();
    const pending = preview.play({ onTrigger: trigger }, 'piano', 0);
    preview.stop(); expect(await pending).toBe(false); expect(trigger).not.toHaveBeenCalled();
  });
});
describe('beginner examples', () => {
  it('produces parseable examples for registered sample and synth names', () => {
    for (const name of ['bd', 'piano', 'marimba', 'triangle']) {
      expect([...sounds.samples, ...sounds.synths]).toContain(name);
      expect(() => transpiler(soundExample(name, name === 'triangle' ? 'synth' : 'sample', 2))).not.toThrow();
    }
  });
  it('escapes arbitrary registered names as source rather than executable code', () => {
    expect(soundExample('odd"name', 'sample')).toBe('s("odd\\"name").gain(0.35)');
  });
  it('offers an actionable missing-sound suggestion', () => {
    expect(errorSuggestion('sound nonexistent not found! Is it loaded?')).toContain('Search Sounds');
  });
});
