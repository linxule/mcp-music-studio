import type { App } from "@modelcontextprotocol/ext-apps";
import type { StudioSession, StudioState } from "./studio-session";
import type { SharedReview } from "./studio-review";
import { chatHandoff } from "./studio-handoff";
import "./studio-review-panel.css";

/** A view of the widget's session-owned review, never a second review store. */
export function installStudioReviewPanel(app: App, session: StudioSession): void {
  // The standalone page owns the surrounding controls and isolated preview.
  if (document.documentElement.dataset.studio) return;
  const panel = document.createElement("details");
  panel.id = "studio-review-panel";
  panel.className = "studio-review-panel";
  panel.innerHTML = `
    <summary>Work on a passage</summary>
    <div class="studio-review-body">
      <p>Select music in the source editor, then use that selection here.</p>
      <button id="review-capture" type="button">Use selection</button>
      <label for="review-question">Ask about this passage</label>
      <textarea id="review-question" rows="2" maxlength="6000">Explain this passage and suggest one small musical change.</textarea>
      <p id="review-panel-status" role="status" aria-live="polite"></p>
      <div id="review-selection" hidden>
        <h3>Selected passage</h3><pre id="review-selected" tabindex="0"></pre>
        <div class="studio-review-actions">
          <button id="review-send" type="button" hidden>Send question to chat</button>
          <button id="review-copy" type="button">Copy for chat</button>
          <button id="review-clear" type="button">Clear review</button>
        </div>
        <textarea id="review-copy-fallback" aria-label="Copy passage and question manually" rows="5" readonly hidden></textarea>
        <p id="review-answer"></p>
        <div id="review-proposal" hidden>
          <h3>Proposed edit</h3><pre id="review-proposed" tabindex="0"></pre>
          <p>Audio preview is available in the standalone studio. Apply keeps playback stopped.</p>
          <button id="review-apply" type="button">Apply edit</button>
        </div>
        <details><summary>Try your own edit</summary>
          <label for="review-replacement">Replace the selected text with</label>
          <textarea id="review-replacement" rows="3" spellcheck="false" maxlength="64000"></textarea>
          <button id="review-manual" type="button">Review this edit</button>
        </details>
      </div>
      <button id="review-undo" type="button" disabled>Undo edit</button>
    </div>`;
  const main = document.querySelector("main")!;
  main.insertBefore(panel, main.querySelector("footer"));
  const $ = <T extends HTMLElement>(id: string) => panel.querySelector<T>(`#${id}`)!;
  const question = $<HTMLTextAreaElement>("review-question");
  const replacement = $<HTMLTextAreaElement>("review-replacement");
  const controller = new AbortController();
  const { signal } = controller;
  let review: SharedReview | null = null;
  let state: StudioState | undefined;
  let busy = false;
  let intent = 0;
  let viewEpoch = 0;
  let questionDirty = false;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;

  const notice = (text: string, error = false) => {
    if (signal.aborted) return;
    $("review-panel-status").textContent = text;
    $("review-panel-status").classList.toggle("error", error);
  };
  function buttons() {
    const usable = !!review && !review.stale && !busy;
    for (const id of ["review-copy", "review-send", "review-manual"]) $<HTMLButtonElement>(id).disabled = !usable;
    $<HTMLButtonElement>("review-apply").disabled = !usable || review?.replacement === undefined;
    $<HTMLButtonElement>("review-clear").disabled = !review || busy;
    $<HTMLButtonElement>("review-capture").disabled = busy;
    $<HTMLButtonElement>("review-undo").disabled = busy || !state?.canUndo;
    question.disabled = busy;
    $("review-send").hidden = !app.getHostCapabilities()?.message;
  }
  function render(next: SharedReview | null) {
    if (signal.aborted) return;
    ++viewEpoch;
    const previous = review;
    review = next;
    $("review-selection").hidden = !next;
    $("review-proposal").hidden = next?.replacement === undefined;
    $("review-copy-fallback").hidden = true;
    if (next) {
      if (!questionDirty && question.value !== next.question) question.value = next.question;
      $("review-selected").textContent = next.passage.text || "(Insert at cursor)";
      $("review-answer").textContent = next.explanation;
      $("review-proposed").textContent = next.replacement || "(Remove selected text)";
      if (next.requestId !== previous?.requestId || next.replacement !== previous?.replacement) replacement.value = next.replacement ?? next.passage.text;
      if (next.stale) notice("The draft changed. Use the selection again to ask a new question.", true);
      else if (next.replacement !== undefined) {
        panel.open = true;
        notice("Suggestion ready. Compare the source before applying.");
      } else notice("Passage ready. Send your question or copy it into your chat.");
    }
    buttons();
  }
  const unsubscribe = session.onReviewChange(next => {
    render(next);
    // get only notifies when a review first becomes stale, so this refresh
    // does not loop; it keeps Undo in sync after tool-driven source changes.
    queueMicrotask(() => { if (!signal.aborted) void read().catch(() => {}); });
  });
  async function read() {
    const pending = session({ action: "get", instanceId: session.instanceId });
    const epoch = viewEpoch;
    const next = await pending;
    if (!signal.aborted && epoch === viewEpoch) { state = next; render(next.sharedReview); }
    return next;
  }
  function run(action: () => Promise<void>) {
    if (busy || signal.aborted) return;
    busy = true; buttons();
    void action().catch(async error => {
      await read().catch(() => {});
      notice(String(error), true);
    }).finally(() => {
      busy = false;
      if (!signal.aborted) buttons();
    });
  }
  function publish(next: SharedReview | null) {
    if (!next || next.stale || !app.getHostCapabilities()?.updateModelContext) return;
    void app.updateModelContext({ content: [{ type: "text", text: chatHandoff(next) }] }).catch(() => {});
  }
  $("review-capture").addEventListener("click", () => run(async () => {
    const ticket = ++intent;
    const asked = question.value;
    questionDirty = true;
    const current = await read();
    if (ticket !== intent || signal.aborted) return;
    const selection = current.selection ?? { from: 0, to: 0, text: "" };
    const next = await session({ action: "review-start", instanceId: current.instanceId,
      expectedRevision: current.revision, question: asked,
      passage: { instanceId: current.instanceId, mode: current.mode, revision: current.revision, ...selection } });
    questionDirty = false;
    state = next; render(next.sharedReview); publish(next.sharedReview);
  }), { signal });
  question.addEventListener("input", () => {
    ++intent;
    questionDirty = true;
    if (!review || busy) return;
    // Dispatch immediately: the previous request expires before a delayed
    // agent response can arrive, even though the music revision is unchanged.
    const pending = session({ action: "review-start", instanceId: session.instanceId,
      expectedRevision: review.passage.revision, passage: review.passage, question: question.value });
    const ticket = intent;
    void pending.then(next => {
      if (ticket !== intent || signal.aborted) return;
      questionDirty = false;
      state = next; render(next.sharedReview);
    }).catch(error => notice(String(error), true));
  }, { signal });
  // Publish once the person leaves the question, rather than on every key.
  question.addEventListener("change", () => publish(review), { signal });
  $("review-manual").addEventListener("click", () => run(async () => {
    if (!review) return;
    const next = await session({ action: "review-stage", instanceId: session.instanceId,
      requestId: review.requestId, passage: review.passage, replacement: replacement.value,
      explanation: "Your proposed edit. Compare it with the selected passage before applying." });
    state = next; render(next.sharedReview);
  }), { signal });
  $("review-apply").addEventListener("click", () => run(async () => {
    if (!review) return;
    const requestId = review.requestId;
    const next = await session({ action: "review-apply", instanceId: session.instanceId,
      requestId, expectedRevision: review.passage.revision });
    state = next; render(next.sharedReview);
    if (!next.error && next.sharedReview?.requestId === requestId) {
      notice("Edit was not applied. Check the current source and review the passage again.", true);
      return;
    }
    notice(next.error ? `Edit has an error: ${next.error}. Undo can restore your draft.` : "Edit applied, stopped. Undo restores the previous draft.", !!next.error);
  }), { signal });
  $("review-clear").addEventListener("click", () => run(async () => {
    ++intent;
    if (!review) return;
    const next = await session({ action: "review-clear", instanceId: session.instanceId, requestId: review.requestId });
    state = next; render(next.sharedReview); notice("Review cleared. Your draft is unchanged.");
  }), { signal });
  $("review-undo").addEventListener("click", () => run(async () => {
    const current = await read();
    const next = await session({ action: "undo", instanceId: session.instanceId, expectedRevision: current.revision });
    state = next; render(next.sharedReview); notice("Previous draft restored, stopped.");
  }), { signal });
  $("review-send").addEventListener("click", () => run(async () => {
    const current = await read();
    if (!current.sharedReview || current.sharedReview.stale) throw new Error("Use the selection again before sending.");
    await app.sendMessage({ role: "user", content: [{ type: "text", text: chatHandoff(current.sharedReview) }] });
    notice("Question sent to chat.");
  }), { signal });
  $("review-copy").addEventListener("click", () => {
    if (!review || review.stale) return;
    const text = chatHandoff(review);
    // Invoke clipboard directly in the click gesture; a denied clipboard has
    // an ordinary selectable text fallback inside the same panel.
    void navigator.clipboard?.writeText(text).then(() => notice("Copied. Paste it into your chat.")).catch(() => fallback(text));
    if (!navigator.clipboard) fallback(text);
  }, { signal });
  function fallback(text: string) {
    if (signal.aborted) return;
    const field = $<HTMLTextAreaElement>("review-copy-fallback");
    field.value = text; field.hidden = false; field.focus(); field.select();
    notice("Copy the text above into your chat.");
  }
  function scheduleRead(event: Event) {
    if (panel.contains(event.target as Node)) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { void read().catch(() => {}); }, 0);
  }
  for (const event of ["input", "change", "click", "music-studio-draft-changed"]) document.addEventListener(event, scheduleRead, { signal, capture: true });
  panel.addEventListener("toggle", () => { if (panel.open) void read().catch(error => notice(String(error), true)); }, { signal });
  session.onDispose(() => { ++intent; controller.abort(); clearTimeout(syncTimer); unsubscribe(); panel.remove(); });
}
