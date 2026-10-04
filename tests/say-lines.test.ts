// extractSayLines — the say() lines the Worker warms at tool time, read from
// the code without running it.
import { describe, expect, it } from "vitest";
import { transpiler } from "@strudel/transpiler";
import { PRERENDER_MAX_LINES, extractSayLines } from "../src/shared/say-lines";
import { TTS_MAX_CHARS } from "../src/shared/tts";

const texts = (code: string) => extractSayLines(code).lines.map((l) => `${l.voice}:${l.text}`);

describe("extractSayLines", () => {
  it("reads single-quoted literals, with the default or a literal voice", () => {
    expect(texts(`const a = say('hi. it is me.', { voice: 'orion' })\nconst b = say('now')\nstack(a, b)`)).toEqual([
      "orion:hi. it is me.",
      "luna:now",
    ]);
    expect(texts(`say('x', { 'voice': 'ZEUS', gain: 2 })`)).toEqual(["zeus:x"]);
  });

  it("skips double quotes and template literals: the transpiler makes them mini-notation", () => {
    // What the player actually receives — a pattern, which say() refuses.
    expect(transpiler(`say("hi")`, { emitMiniLocations: false }).output).toContain("say(m(");
    expect(transpiler("say(`hi`)", { emitMiniLocations: false }).output).toContain("say(m(");
    expect(texts(`say("hi"); say(\`hi\`); say(\`a \${b}\`)`)).toEqual([]);
    expect(texts(`say('hi', { voice: "orion" })`)).toEqual([]);
  });

  it("finds calls nested in chains, stacks, callbacks and labels", () => {
    const code = [
      `$: stack(s('bd*4'), say('one').slow(2))`,
      `onTap(() => say('tapped', { voice: 'iris' }))`,
      `note('c e g').sometimes(x => x.layer(() => say('deep')))`,
    ].join("\n");
    expect(texts(code)).toEqual(["luna:one", "iris:tapped", "luna:deep"]);
  });

  it("leaves non-literals alone (documented limitation)", () => {
    const code = [
      `const SPEECH = { bar: 'x' }`,
      `say(SPEECH.bar)`,
      `say(lines[i])`,
      `say('a' + b)`,
      `say('voiced', { voice: v })`,
      `say('spread', { ...opts })`,
      `say('computed', { [k]: 'orion' })`,
      `say('opts', options)`,
      `speech.say('member')`,
    ].join("\n");
    expect(texts(code)).toEqual([]);
  });

  it("decodes escapes and normalizes whitespace the way /tts does", () => {
    expect(texts(`say('it\\'s  me\\n now')`)).toEqual(["luna:it's me now"]);
    expect(texts(`say('caf\\u00e9')`)).toEqual(["luna:café"]);
  });

  it("dedupes after normalization, per voice", () => {
    expect(texts(`say('hi'); say(' hi '); say('hi', { voice: 'luna' }); say('hi', { voice: 'orion' })`)).toEqual([
      "luna:hi",
      "orion:hi",
    ]);
  });

  it("drops what /tts would refuse", () => {
    expect(texts(`say(''); say('${"a".repeat(TTS_MAX_CHARS + 1)}'); say('x', { voice: 'morgan' })`)).toEqual([]);
  });

  it(`caps at ${PRERENDER_MAX_LINES} distinct lines and counts the rest`, () => {
    const code = Array.from({ length: 11 }, (_, i) => `say('line ${i}')`).join("\n") + "\nsay('line 0')";
    const { lines, overCap } = extractSayLines(code);
    expect(lines.map((l) => l.text)).toEqual(Array.from({ length: 8 }, (_, i) => `line ${i}`));
    expect(overCap).toBe(3);
  });

  it("never throws on code that doesn't parse", () => {
    expect(extractSayLines("say('a'")).toEqual({ lines: [], overCap: 0 });
    expect(texts(`await initHydra()\nsay('top-level await is fine')`)).toEqual(["luna:top-level await is fine"]);
  });
});
