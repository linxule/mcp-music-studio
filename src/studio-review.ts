import type { StudioSnapshot } from './studio-session';
import { z } from 'zod';

export type StudioMode = 'live' | 'score';
export type Passage = { instanceId: string; mode: StudioMode; revision: number; from: number; to: number; text: string };
export type Review = { passage: Passage; explanation: string; replacement?: string };
export type SharedReview = Review & { requestId: string; question: string; stale: boolean };
export const passageSchema = z.object({
  instanceId: z.string().min(1), mode: z.enum(['live', 'score']),
  revision: z.number().int().nonnegative(), from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(), text: z.string().max(65536),
}).strict();
export const reviewResponseSchema = z.object({
  instanceId: z.string().min(1), requestId: z.string().min(1), passage: passageSchema,
  explanation: z.string().min(1).max(6000),
}).strict();
export function samePassage(a: Passage, b: Passage): boolean {
  return a.instanceId === b.instanceId && a.mode === b.mode && a.revision === b.revision
    && a.from === b.from && a.to === b.to && a.text === b.text;
}
export function sourceOf(mode: StudioMode, state: StudioSnapshot): string {
  return String(state.args[mode === 'score' ? 'abcNotation' : 'code'] ?? '');
}
export function checkPassage(passage: Passage, state: StudioSnapshot & { revision: number; instanceId: string; mode: StudioMode }): string {
  if (passage.instanceId !== state.instanceId) throw new Error('This passage belongs to another widget session. Select it again.');
  if (passage.mode !== state.mode) throw new Error('This passage belongs to another music mode. Select it again.');
  const source = sourceOf(passage.mode, state);
  if (passage.revision !== state.revision) throw new Error('The draft changed. Select the passage again and request a new suggestion.');
  if (!Number.isInteger(passage.from) || !Number.isInteger(passage.to) || passage.from < 0 || passage.to < passage.from || passage.to > source.length) throw new Error('This selection is outside the draft. Select the passage again.');
  if (source.slice(passage.from, passage.to) !== passage.text) throw new Error('The selected text no longer matches the draft. Select it again.');
  return source;
}
export function proposedArgs(review: Review, state: StudioSnapshot & { revision: number; instanceId: string; mode: StudioMode }): Record<string, unknown> {
  const source = checkPassage(review.passage, state);
  if (review.replacement === undefined) throw new Error('There is no proposed edit to apply.');
  const code = source.slice(0, review.passage.from) + review.replacement + source.slice(review.passage.to);
  const args = { ...state.args, [review.passage.mode === 'score' ? 'abcNotation' : 'code']: code };
  // Live tempo is measured feedback, not an override for the proposed source.
  if (review.passage.mode === 'live') delete args.bpm;
  return args;
}
