import { z } from 'zod';
import type { StudioSnapshot } from './studio-session';
import type { StudioMode } from './studio-review';

const liveArgs = z.object({ code: z.string().max(65536), title: z.string().optional(), theme: z.string().optional() }).strict();
const scoreArgs = z.object({
  abcNotation: z.string().max(65536), title: z.string().optional(), instrument: z.string().optional(),
  style: z.enum(['rock', 'jazz', 'bossa', 'waltz', 'march', 'reggae', 'folk', 'classical']).optional(),
  swing: z.number().min(0).max(75).optional(), drumIntro: z.number().int().min(0).max(8).optional(),
}).strict();
const scoreSettings = z.object({
  soundFont: z.enum(['default', 'musyngkite', 'dry']).optional(), room: z.boolean().optional(),
  instrumentOverride: z.boolean().optional(), warp: z.number().min(1).max(1000).optional(), loop: z.boolean().optional(),
}).strict();
const schema = z.object({
  format: z.literal('music-studio'), version: z.literal(1), active: z.enum(['live', 'score']),
  drafts: z.object({
    live: z.object({ args: liveArgs, settings: z.object({}).strict().optional() }).strict(),
    score: z.object({ args: scoreArgs, settings: scoreSettings.optional() }).strict(),
  }).strict(),
}).strict();
export type StudioFile = z.infer<typeof schema>;
export function parseStudioFile(text: string): StudioFile {
  if (new TextEncoder().encode(text).length > 2_000_000) throw new Error('Session files must be smaller than 2 MB.');
  try { return schema.parse(JSON.parse(text)); }
  catch { throw new Error('Unsupported session file. Use a Music Studio v1 file with both drafts, valid settings, and at most 65,536 characters per draft.'); }
}
export function savedDraft(mode: StudioMode, state: Pick<StudioSnapshot, 'args' | 'settings'>) {
  const args = { ...state.args };
  if (mode === 'live') delete args.bpm;
  return { args, ...(state.settings ? { settings: { ...state.settings } } : {}) };
}
export function draftSignature(mode: StudioMode, state: Pick<StudioSnapshot, 'args' | 'settings'>) {
  return JSON.stringify(savedDraft(mode, state));
}
export function reviewForMode<T extends { passage: { mode: StudioMode } }>(mode: StudioMode, review: T | null | undefined): T | null {
  return review?.passage.mode === mode ? review : null;
}

export async function connectStudioTools<T extends { registerTool: (...args: any[]) => unknown }>(
  candidates: unknown[], register: (context: T) => Promise<void>, status: (text: string) => void,
) {
  const context = candidates.find(candidate => candidate && typeof (candidate as T).registerTool === 'function') as T | undefined;
  if (!context) { status('WebMCP unavailable. Use Copy for chat.'); return; }
  try { await register(context); status('Agent tools ready'); }
  catch { status('Some agent tools could not load. Use Copy for chat or reload.'); }
}
