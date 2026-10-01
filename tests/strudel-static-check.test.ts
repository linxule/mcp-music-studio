import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { staticCheckStrudel } from "../src/shared/strudel-static-check";

const piece = (name: string) => readFileSync(`tests/fixtures/pieces/${name}.js`, "utf8");

describe("staticCheckStrudel (no evaluation — what the Worker can run)", () => {
  it.each(["first-light-film", "duet", "petri-dish", "lossy-terminal", "signal-corruption"])(
    "%s parses",
    (name) => expect(staticCheckStrudel(piece(name))).toBeNull(),
  );

  it.each([
    ["lossy-v1-typo", 82, 41],
    ["lossy-club-damage-typo", 88, 61],
  ])("%s: the `))` typo, at the same position the full validator reports", (name, line, column) => {
    expect(staticCheckStrudel(piece(name))).toMatchObject({ line, column });
  });

  it("catches a broken mini-notation string too", () => {
    const error = staticCheckStrudel('s("bd [sd hh")');
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/mini|parse|Expected/i);
  });
});
