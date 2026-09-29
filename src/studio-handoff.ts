import type { Review } from './studio-review';
export function chatHandoff(review: Review, question: string): string {
  const mode = review.passage.mode === 'score' ? 'ABC notation' : 'Strudel';
  return `${question.trim() || 'Explain this passage.'}\n\nMusic Studio — ${mode}\nSelected passage (may depend on the rest of the piece):\n\n${review.passage.text || '(Insertion point; no text selected)'}\n\n${review.replacement !== undefined ? `Proposed replacement:\n${review.replacement || '(Delete the selection)'}\n\n` : ''}Please explain the musical effect and return any replacement as plain source. I will review and apply it in the studio.`;
}
