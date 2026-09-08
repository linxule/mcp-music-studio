/**
 * The headless Strudel evaluator moved to src/shared/strudel-eval.ts when the
 * SERVER started using it (src/shared/strudel-validate.ts) to tell text-only
 * clients whether a pattern actually evaluates. This re-export keeps the test
 * suite's import path stable — and keeps the guide corpus and the production
 * validator provably running the same evaluator.
 */
export {
  DRAW_METHODS,
  evalStrudel,
  queryHaps,
  setupStrudel,
  type EvalResult,
} from "../src/shared/strudel-eval";
