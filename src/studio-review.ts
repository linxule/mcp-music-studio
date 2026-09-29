import type { StudioSnapshot } from './studio-session';

export type StudioMode = 'live' | 'score';
export type Passage = { mode: StudioMode; revision: number; from: number; to: number; text: string };
export type Review = { passage: Passage; explanation: string; replacement?: string };
export function sourceOf(mode: StudioMode, state: StudioSnapshot): string {
  return String(state.args[mode === 'score' ? 'abcNotation' : 'code'] ?? '');
}
export function checkPassage(passage: Passage, state: StudioSnapshot & { revision: number }): string {
  const source = sourceOf(passage.mode, state);
  if (passage.revision !== state.revision) throw new Error('The draft changed. Select the passage again and request a new suggestion.');
  if (!Number.isInteger(passage.from) || !Number.isInteger(passage.to) || passage.from < 0 || passage.to < passage.from || passage.to > source.length) throw new Error('This selection is outside the draft. Select the passage again.');
  if (source.slice(passage.from, passage.to) !== passage.text) throw new Error('The selected text no longer matches the draft. Select it again.');
  return source;
}
export function proposedArgs(review: Review, state: StudioSnapshot & { revision: number }): Record<string, unknown> {
  const source = checkPassage(review.passage, state);
  if (review.replacement === undefined) throw new Error('There is no proposed edit to apply.');
  const code = source.slice(0, review.passage.from) + review.replacement + source.slice(review.passage.to);
  const args = { ...state.args, [review.passage.mode === 'score' ? 'abcNotation' : 'code']: code };
  // Live tempo is measured feedback, not an override for the proposed source.
  if (review.passage.mode === 'live') delete args.bpm;
  return args;
}
