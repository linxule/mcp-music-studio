/**
 * The shape of a Strudel validation result, and nothing else.
 *
 * A leaf on purpose: tool-defs.ts renders these fields into the tool result and
 * is shared by BOTH transports, so whatever it imports the Cloudflare Worker
 * has to typecheck. The validator behind these types is emphatically not that —
 * strudel-validate-core.ts reaches @strudel/*, and strudel-validate-host.ts
 * reaches node:child_process and node:vm, none of which exist in workerd. Types
 * are erased, so importing from here costs the worker nothing at all.
 *
 * What each field means, and what validation does and does not certify, is in
 * strudel-validate-core.ts.
 */
export interface StrudelValidationError {
  message: string;
  line?: number;
  column?: number;
}

export interface StrudelValidation {
  ok: boolean;
  error?: StrudelValidationError;
  /** Number of patterns handed to stack(); absent when stack() was not used. */
  layers?: number;
  eventsPerCycle?: number;
  /** Distinct sound names the pattern actually triggers, sorted. */
  sounds?: string[];
  /** Sounds prebake() does not register. Absent when samples() was called. */
  unregistered?: string[];
  usesNotes?: boolean;
  cps?: number;
  usesHydra?: boolean;
  /** Draw methods the code called (pianoroll, scope, ...). */
  visuals?: string[];
  /** URLs passed to samples() — why `unregistered` may be withheld. */
  sampleUrls?: string[];
}

export interface ValidateOptions {
  /** Cycles to query. Four bars is enough to see a pattern's full shape. */
  cycles?: number;
  /** Wall-clock ceiling for the whole run. */
  timeoutMs?: number;
}
