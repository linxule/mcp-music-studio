import type { Review, SharedReview } from './studio-review';
import type { StudioMode } from './studio-session';

/** 1-based first and last line a selection [from, to) touches. */
export function lineRange(source: string, from: number, to: number): { first: number; last: number } {
  const lineAt = (offset: number) => source.slice(0, Math.max(0, Math.min(offset, source.length))).split('\n').length;
  const end = to > from && source[to - 1] === '\n' ? to - 1 : to; // a selection ending at a line break stays on its line
  return { first: lineAt(from), last: Math.max(lineAt(from), lineAt(end)) };
}

/**
 * The chat message for "Ask about selection" in a chat host: plain text any
 * model can act on, with no studio tool names or request ids (no chat host
 * calls the widget's review tools).
 */
export function askAboutSelectionMessage(args: {
  mode: StudioMode;
  text: string;
  lines?: { first: number; last: number };
  inSession?: boolean;
}): string {
  const language = args.mode === 'score' ? 'ABC notation' : 'Strudel';
  const where = args.lines
    ? args.lines.first === args.lines.last ? `, line ${args.lines.first}` : `, lines ${args.lines.first}–${args.lines.last}`
    : '';
  const longest = Math.max(0, ...(args.text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const session = args.inSession
    ? '\n\nThis player is in a live session: you can play your change on it with update-session.'
    : '';
  return `Explain this passage and suggest one small change.\n\nMusic Studio — ${language}${where}:\n\n${fence}\n${args.text}\n${fence}${session}`;
}

export function chatHandoff(review: Review | SharedReview, question?: string): string {
  const mode = review.passage.mode === 'score' ? 'ABC notation' : 'Strudel';
  const request = 'requestId' in review ? `Review requestId: ${review.requestId}\n` : '';
  const passage = JSON.stringify(review.passage);
  const prompt = ('question' in review ? review.question : question)?.trim() || 'Explain this passage.';
  return `${prompt}\n\nMusic Studio — ${mode}\n${request}Exact passage identity: ${passage}\nSelected passage (may depend on the rest of the piece):\n\n${review.passage.text || '(Insertion point; no text selected)'}\n\n${review.replacement !== undefined ? `Proposed replacement:\n${review.replacement || '(Delete the selection)'}\n\n` : ''}Please explain the musical effect and return any replacement as plain source, or stage it with explain-selection/suggest-edit using this exact requestId and passage. I will review and apply it in the studio.`;
}
