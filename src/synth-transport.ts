/**
 * @file The sheet-music widget's reach into abcjs's SynthController.
 *
 * Pure: no DOM, no abcjs import. `tests/synth-transport.test.ts` drives these
 * against the REAL `ABCJS.synth.SynthController` (with its audio stubbed out),
 * so each fix is checked against the abcjs code it works around, not against a
 * model of it. Every function leans on a detail of abcjs 6.7.x
 * `src/synth/synth-controller.js`, quoted where it is used.
 */

/** abcjs's transport UI (`create-synth-control.js`), as far as we touch it. */
interface TransportUi {
  pushLoop(push: boolean): void;
}

/** The SynthController members the widget reads or wraps. */
interface SynthInternals {
  isLooping?: boolean;
  control?: TransportUi | null;
  setWarp(warp: unknown): unknown;
}

const internals = (control: object) => control as SynthInternals;

/**
 * Keep the Loop button lit through a tempo change (#31).
 *
 * `setWarp()` re-primes by way of `destroy()`, which ends in
 * `control.resetAll()` and so un-pushes every transport button, but it never
 * touches `isLooping`. It re-lights Play (through `play()`); nothing re-lights
 * Loop. The tune went on looping under a dark button, and the next click on
 * Loop turned looping OFF. The % field reaches `setWarp` as `self.setWarp`
 * (`onWarp`), an instance lookup, so wrapping the instance method catches it.
 */
export function keepLoopLitThroughWarp(control: object): void {
  const raw = internals(control);
  const setWarp = raw.setWarp;
  const relight = () => raw.control?.pushLoop(Boolean(raw.isLooping));
  raw.setWarp = (warp: unknown) => {
    const done = Promise.resolve(setWarp(warp));
    // destroy() → resetAll() has already run, synchronously: fix the button
    // now rather than after the re-prime, and again once it lands.
    relight();
    return done.then(
      (value) => {
        relight();
        return value;
      },
      (error: unknown) => {
        relight();
        throw error;
      },
    );
  };
}
