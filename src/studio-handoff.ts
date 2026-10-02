import type { Review, SharedReview } from './studio-review';
export function chatHandoff(review: Review | SharedReview, question?: string): string {
  const mode = review.passage.mode === 'score' ? 'ABC notation' : 'Strudel';
  const request = 'requestId' in review ? `Review requestId: ${review.requestId}\n` : '';
  const passage = JSON.stringify(review.passage);
  const prompt = ('question' in review ? review.question : question)?.trim() || 'Explain this passage.';
  return `${prompt}\n\nMusic Studio — ${mode}\n${request}Exact passage identity: ${passage}\nSelected passage (may depend on the rest of the piece):\n\n${review.passage.text || '(Insertion point; no text selected)'}\n\n${review.replacement !== undefined ? `Proposed replacement:\n${review.replacement || '(Delete the selection)'}\n\n` : ''}Please explain the musical effect and return any replacement as plain source, or stage it with explain-selection/suggest-edit using this exact requestId and passage. I will review and apply it in the studio.`;
}
