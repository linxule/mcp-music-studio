import { describe, expect, it } from "vitest";
import { mapLineToSent, sourceLineNote } from "../src/shared/line-map";
import { injectTempo } from "../src/shared/tempo";

const sent = ["await initHydra()", "const x = 1", "stack(", "  s(\"bd\"))),", ")"].join("\n");

describe("error lines in the code the model sent", () => {
  it("maps past a prepended setcps line (the bpm parameter)", () => {
    const shown = injectTempo(sent, 120).code;
    expect(shown.split("\n").length).toBe(sent.split("\n").length + 1);
    expect(mapLineToSent(shown, sent, 5)).toBe(4);
    expect(sourceLineNote("SyntaxError: Unexpected token (5:12)", shown, sent)).toBe(
      " — that is line 4 of the code you sent (the widget added 1 line for bpm/visuals before running it)",
    );
  });

  it("says nothing when nothing was added, or the buffer was edited", () => {
    expect(sourceLineNote("Unexpected token (4:12)", sent, sent)).toBe("");
    const edited = sent.replace("const x = 1", "const x = 2");
    expect(sourceLineNote("Unexpected token (4:12)", "setcps(0.5);\n" + edited, sent)).toBe("");
  });

  it("an error ON an inserted line has no source line", () => {
    expect(mapLineToSent("setcps(0.5);\n" + sent, sent, 1)).toBeNull();
  });
});
