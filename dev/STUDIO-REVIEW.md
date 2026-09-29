# Local studio review — 29 September 2026

Three independent agent reviews covered design philosophy, interaction/accessibility,
and functional correctness. The design and interaction reviews read the personal
website's current `.claude/docs/design.md` and `design-system.md` in `xule-site`.
Findings were checked against this implementation before changes were made.

## Findings addressed

- Pending score playback could resume after Stop or a mode switch. Playback now
  carries a cancellation signal through audio resume and score preparation, and
  retires a controller that starts after its generation was cancelled.
- An empty ABC draft could play the last valid score. Empty drafts now produce an
  explicit error; a newer human draft supersedes pending agent playback.
- A renderer-reported error during undo could discard the recovery snapshot.
  The snapshot now remains until restoration succeeds.
- Stop requests ran serially across modes. They now all run even if one frame
  fails, with an aggregate error when a stop cannot be confirmed.
- A previously measured Strudel tempo could override tempo in replacement code.
  New source only receives a BPM override explicitly supplied with that edit.
- A failed iframe handshake poisoned that mode for the session. Failed frames
  are removed and closed so selecting the mode can retry initialization.
- Mode transitions displayed stale state. The workspace now announces opening,
  exposes `aria-busy`, and disables conflicting mode buttons while loading.
- The activity margin printed protocol names, read-only polls, and source dumps,
  and could announce completion after rendering failed. It now records concise
  outcomes, coalesces adjacent duplicates, omits successful reads, and provides
  a named keyboard-focusable history. Status carries the live announcement.
- Instrument names clipped because labels consumed select width. Labels now sit
  above full-width selects. Working metadata is larger; code leading is 1.65.
- Stop, Undo, and status were too far below the mobile editor; Undo disappeared
  in focus mode. Stop is in sticky navigation; Undo, source export, and status
  precede the workspace and remain present in focus mode.
- A 1100px sidebar transition inadvertently forced a stacked score. Adjusted
  margin/gutter widths keep source and score side by side above that breakpoint.
  Stacked workspace height is based on actual container width, not page width.
- WAV/MIDI exports did not preserve editable source. Download ABC / Download
  Strudel requests a file containing the actual live buffer, including unevaluated
  human edits. Source export does not serialize toolbar or runtime settings.

## Framework decisions

Retain paper/ink, Cormorant/Plex dialogue, a single still cyan mark, violet
interaction feedback, source beside its rendering, and marginalia/endnotes.
The compact MCP apps retain their original styling outside the local opt-in.
Keyboard guidance is a disclosure so collaboration history has more weight.
Focus is an expanded workspace, not a modal. Do not add ornamental stagger,
scroll snapping, or ambient chrome animation to a composition tool.

## Verification and remaining limits

- Build passed; standalone studio TypeScript check and diff whitespace check passed.
- Full suite: 1,802 tests passed, including seven new regressions for cancellation,
  blank drafts, newer human input, and recovery after a failed undo.
- Live browser: WebMCP state reads do not add history; invalid Strudel produces an
  error rather than a success receipt; undo restores the previous source.
- Browser layout measured at 390, 820, 900, and 1101px with no horizontal overflow.
  The repaired 1101px score uses a 779px grid workspace and its source pane fits
  without clipping the keyboard hint. Stop remains reachable in sticky navigation.
- Source export request was triggered in the browser. The in-app browser did not
  provide a download-completion event, so receipt and file contents on disk remain
  unverified. The UI says “download requested,” not “downloaded.”
- Session content is still ephemeral, clearly stated in the interface. Durable
  session save/import and automatic recovery are future product decisions.
- This remains a local prototype: fonts, Strudel, and sounds can require network
  access; native browser audio-unlock rules still apply.

## ABC writing follow-up

The source and score now have nearly equal columns. The writing pad and the
176px notation/playback feedback region occupy independent grid rows. Long
warnings scroll inside the feedback region; source lines keep their original
line breaks. The editor retains at least 440px of vertical space including its
label and padding. The overall score workspace is taller rather than squeezing
the pad to fit a short frame.

Browser checks confirmed the pad remained 440×405px with no feedback, a short
error, and a 488px-long warning list in an 87px scrolling feedback viewport.
At the 1101px sidebar breakpoint the pad stays 405px tall; at phone width it is
368px tall without document horizontal overflow. Correcting the source back to
the exact last good draft now revalidates and clears stale errors immediately,
without waiting for audio preparation. Build and all 1,806 tests passed.

## Strudel human companion — 2026-09-29

Added a stable source/feedback column and adjacent sound-and-lessons panel,
following the site's marginalia principle. Session notes now follow the live
workspace so composition can use the full page width.

Verified in the local browser:
- Malformed source produced `Unexpected token (1:15)` and a concrete suggestion;
  correcting it cleared the syntax error without evaluating or playing.
- Editor dimensions stayed 674 × 557.5px through that error transition.
- Selected source was replaced by a piano example; native undo restored it.
- Piano sample and triangle synth auditions reported successful triggers without
  changing the source. Audio was not independently recorded/listened to for QA.
- Kick drum exposed 8 variants; variant 2 generated `.n(2)`. Stop preview worked.
- At 390px viewport width: frame content width and scroll width both 348px,
  writing surface 440px high, feedback 164px high, companion below.
- At 1280px: source 846px + companion 330px; no horizontal overflow.
- Original seed restored, stopped; browser left in live mode.

Focused tests cover preview cancellation during resume, sample preparation and
late triggering; bounded playback; hanging loads; example parsing/escaping;
missing-sound guidance; and cancelling a preview before pattern evaluation.
Build and studio TypeScript checks pass. Final full suite: **1,814 tests passed**
across 80 files. Ordinary MCP app instances do not install the companion.

Known scope: typing feedback checks syntax using the repository's pinned parser,
not runtime validity or sound quality. Registered custom instruments may require
additional initialization and may not support a standalone audition.

## Shared passages and content audit

Applied the personal site's source-first, marginalia, paper/ink, typography, and
restrained interaction principles alongside the GOV.UK plain-English skill.
The review occupies a full-width endnote below the composition surface. It adds
no column to the writing pad. Original and proposed text sit side by side on a
wide screen and stack on a narrow one. Violet marks the proposed text; labels
also distinguish it without color. Source and explanations use the established
machine and human typefaces.

### Content decisions

| Previous content | Decision | Reason |
| --- | --- | --- |
| Mode, revision, and repeated widget status above the workspace | Show only loading or host errors there | Playback and validation already have a dedicated feedback area. Revisions stay in agent state. |
| “Code and sound, in the same place” and “Source beside the music it makes” | Remove | The visible two-column layout already demonstrates this. |
| “You and your agent work on the same music. Changes appear here.” | Remove | The passage review now demonstrates the collaboration. |
| “WebMCP ready · 7 tools” | “Agent tools ready” | Tool counts do not help someone compose. |
| “Alongside the pattern” above “Find your sound” | Remove | It repeats the column's placement without guiding an action. |
| Repeated instructions to evaluate after every syntax check | “Syntax looks good.” plus one runtime limitation | Preserve the distinction between syntax and working audio. |
| Long insertion paragraph | “How insertion works” disclosure | Keep replacement and undo guidance available at the point of use. |
| Sample download paragraph | “Samples download on first use. Download errors appear below the editor.” | Say when loading happens and where to recover. |
| Open session history | Collapsed “Session activity” | History is useful on demand; the composition and current feedback take priority. |
| “Undo agent edit” | “Undo edit” | The same history now includes human-reviewed suggestions. |

Kept the download reminder, reload warning, keyboard guidance, error feedback,
Stop control, attribution, source/license links, and privacy notice. These answer
real questions about recovery, operation, ownership, and data. No copy was
shortened by shrinking its type. The new review supports cursor insertions,
selected replacements, and deliberate deletions; source is always rendered as
text, never injected HTML.

### Verification

- Build and standalone studio typecheck passed.
- Final full suite: 1,830 tests passed across 82 files.
- Regression tests cover exact ranges, Unicode offsets, stale drafts/settings,
  preserved ABC context, undo, isolated previews, cancellation during validation,
  mode changes during loading, and renderer-reported errors.
- Browser checks: live and ABC selections are exposed without changing revision;
  staged suggestions leave the draft unchanged; both separate players start;
  Stop removes the preview. Applying the live suggestion changes only the
  selected notes, and Undo restores the exact original source.
- At a 390px viewport, the review stacks into one 350px column and the page has
  no horizontal overflow. The desktop layout retains separate original and
  proposed text columns.

### Deliberate limits

One passage and suggestion at a time. No embedded model or automatic chat send.
The agent must read the shared passage and call the explanation/suggestion tool.
Suggestions are rechecked when previewed/applied; a stale review must be refreshed.
Audio requires the preview's Play gesture and may download existing sound assets.
The preview ends after 2 minutes and does not save recordings. Reviews and drafts
remain local session state and reset on reload.


## Closeout: files and browser fallbacks

- Mode-specific state now returns only a review belonging to that mode.
- WebMCP capability detection requires a callable registration method and falls
  back to the legacy API when appropriate. Registration failure replaces the
  checking indicator with an explicit partial-failure message.
- Copy for chat provides a question field and a clipboard/manual-copy route. It
  sends nothing automatically and includes only the chosen passage/proposal.
- Save/Open session preserves both drafts and current settings. Files are validated
  before replacement, restoration is stopped, and failed operations attempt to
  recover the previous drafts. Blank drafts retain title and sound choices.
- Source and settings changes show Unsaved changes and install an exit warning.
  CodeMirror edits/undo/insertion and button-based settings also trigger checks.
  Session files exclude undo history, reviews, and recordings; no autosave added.
- Privacy and recovery copy now explains session files, clipboard use, browser
  warning limits, and direct edits versus proposals requiring Apply.

Browser verification: imported both sources, including Flute, dry soundfont,
room off, instrument override, warp 120, loop on, and live nord theme. Both were
stopped. A score review was absent from a live-state read. Copy reported success.
Typing showed Unsaved changes. The in-app browser did not expose an exit dialog
through its automation API; the test draft remained in place after the reload
attempt. Session export was requested, but this host did not expose a download
completion event. File validation/round-trip and clipboard denial are also covered
by automated tests. Verify download receipt and native exit prompts per host.

Final verification: build and standalone studio typecheck passed; all 1,846 tests
passed across 83 files. `git diff --check` passed.
