/**
 * @file The sheet widget's practice row, under the transport: loop the
 * selected notes, and mute voices of a score with more than one. (The tempo
 * is the transport's own % field.) DOM only; the widget owns the state and
 * passes it in through {@link PracticeRow.sync}.
 */

export interface PracticeRowView {
  /** Is a selection loop on? */
  looping: boolean;
  /** One entry per voice; the row shows voice toggles only for two or more. */
  voices: ReadonlyArray<{ name: string; muted: boolean }>;
}

export interface PracticeRowActions {
  toggleLoop(): void;
  toggleVoice(voice: number): void;
}

export class PracticeRow {
  readonly element: HTMLElement;
  private readonly loopBtn: HTMLButtonElement;
  private readonly voicesEl: HTMLElement;
  private voiceKey = "";

  constructor(private readonly actions: PracticeRowActions) {
    this.element = document.createElement("div");
    this.element.id = "practice-row";
    this.element.className = "practice-row";
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", "Practice");
    this.element.hidden = true;

    this.loopBtn = document.createElement("button");
    this.loopBtn.type = "button";
    this.loopBtn.className = "toolbar-btn toolbar-btn-text practice-loop-btn";
    this.loopBtn.textContent = "Loop selection";
    this.loopBtn.title =
      "Play the selected notes over and over. Click a note, Shift-click another to extend, or select ABC in the editor.";
    this.loopBtn.setAttribute("aria-pressed", "false");
    this.loopBtn.addEventListener("click", () => actions.toggleLoop());

    this.voicesEl = document.createElement("span");
    this.voicesEl.className = "practice-voices";
    this.voicesEl.setAttribute("role", "group");
    this.voicesEl.setAttribute("aria-label", "Voices (press to mute)");

    this.element.append(this.loopBtn, this.voicesEl);
  }

  /** Show the row (once there is a score) and reflect `view`. */
  sync(view: PracticeRowView, visible: boolean): void {
    this.element.hidden = !visible;
    this.loopBtn.setAttribute("aria-pressed", String(view.looping));
    const key = view.voices.length >= 2 ? view.voices.map((v) => v.name).join("\u0000") : "";
    if (key !== this.voiceKey) this.buildVoices(view.voices, key);
    const buttons = this.voicesEl.querySelectorAll<HTMLButtonElement>("button");
    buttons.forEach((button, i) => {
      const voice = view.voices[i];
      if (!voice) return;
      // Pressed = sounding, like the Room toggle: a muted voice reads as "off".
      button.setAttribute("aria-pressed", String(!voice.muted));
      button.title = voice.muted ? `${voice.name} is muted — press to hear it` : `Mute ${voice.name}`;
    });
  }

  private buildVoices(voices: PracticeRowView["voices"], key: string): void {
    this.voiceKey = key;
    this.voicesEl.replaceChildren();
    if (!key) return;
    const label = document.createElement("span");
    label.className = "control-label";
    label.textContent = "Voices";
    this.voicesEl.append(label);
    voices.forEach((voice, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toolbar-btn toolbar-btn-text practice-voice-btn";
      button.dataset.voice = String(i);
      button.textContent = voice.name;
      button.addEventListener("click", () => this.actions.toggleVoice(i));
      this.voicesEl.append(button);
    });
  }
}
