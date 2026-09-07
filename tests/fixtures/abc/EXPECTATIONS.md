# Original ABC benchmark corpus — not yet rendered

These deliberately small fixtures were authored for this handoff. They are test
inputs and intended expectations, not a claim of renderer-verified correctness.
Validate/correct the corpus itself against the authoritative ABC syntax and the
current ABCJS implementation before scoring alternative engines.

| Input | Inspect | Intended expectation |
|---|---|---|
| 01 | Basic pitches/rhythm | Two bars; straightforward ascending/descending melody. |
| 02 | Simultaneous voices, bass clef | Two independent voices with aligned durations. Direct Verovio ABC is documented as unsupported. |
| 03 | Triplets | Triplet grouping and duration, not three ordinary eighth notes. Direct Verovio ABC is documented as unsupported. |
| 04 | Repeat and alternate endings | First and second endings retained; separately inspect playback repeat expansion. |
| 05 | Lyrics | Text under notes and hyphen placement; source includes an intentional syllabic phrase for inspection. |
| 06 | Chord symbols and style directives | Symbols engrave; accompaniment is an independent playback feature, not a renderer guarantee. |
| 07 | Changing 4/4 → 3/4 → 6/8 | Meter and bar durations change; cycle semantics must not be inferred from this notation alone. |
| 08 | Tie versus slur, accidentals | Tied notes connect duration; slur remains phrasing; spelling is preserved. |
| 09 | Grace and dynamics | Grace note placement and dynamic marks; playback support may differ. |
| 10 | Malformed content | Bounded useful errors/warnings; no crash or silent success claim. |

Record parse, engraving, playback-event, synthesis and export results separately.
A documented unsupported feature must not be scored as "passes" merely because some
SVG was produced. No renderer binaries or outputs are bundled with this corpus.
