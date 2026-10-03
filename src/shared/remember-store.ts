// =============================================================================
// remember() — named state a piece owns, the listener changes and the AI reads
//
// The agent draws a piece's interface itself (a step grid on a canvas, a chord
// wheel) and handles taps with onTap. What it could not do before 0.11 is keep
// that state: `const cells = new Map()` is rebuilt on every run, so the AI's
// next update — or the listener's own edit — erased the beat. Faders survive
// because their values live in the stage runtime, keyed by name; remember()
// gives any plain JSON value the same life.
//
//   const drums = remember('drums', { kick: [1,0,0,0], snare: [0,0,1,0] }, {
//     describe: v => 'kick on ' + ...,   // how the AI reads it (optional)
//     version: 1,                         // a CHANGED version resets to init
//     merge: v => { v.kick[2] = 1 },      // the AI's targeted edit, applied once
//     label: 'kick on step 3',            // how the merge reads in the log
//   })
//   drums.value                 // deep-frozen; writing to it throws (strict mode)
//   drums.set(next, label?)     // label: string | (value) => string
//   drums.update(fn, label?)    // fn(draft) mutates a deep copy (or returns one)
//
// Design and review: .claude/designs/remember.md (BUILD CONTRACT). The rules
// that matter, each from a review finding:
//
// - TRANSACTIONS. Declarations, resets, merges and top-level writes of an
//   evaluation are STAGED. They apply together when the app activates the
//   evaluation's state — at commit, or later at the swap's bar (a quantized
//   update is evaluated ~0.85 s before its bar, and the old pattern still
//   reads the old state until then). A failed or superseded evaluation
//   changes nothing.
// - MERGES RUN ONCE per (name, merge source + label + version): a listener
//   re-running the same code does not re-apply the AI's edit; a new merge
//   does. Merges apply to the LATEST stored value, so the listener's taps
//   since the AI read the state survive.
// - ATTRIBUTION is "gesture-associated", not authenticated intent: a write
//   made synchronously inside a tap callback is the listener's; a merge is
//   the AI's; anything else (onFrame, async continuations) is the piece's and
//   is not logged as an event — only the snapshot moves.
// - Handles belong to their evaluation: a retired evaluation's leftover async
//   callback cannot write into its replacement's state.
//
// Pure: the stage runtime (widget, share page) and the validator both use it.
// =============================================================================

export type JsonType = "null" | "boolean" | "number" | "string" | "array" | "object";

/** At most this many remember() names per evaluation. */
export const MAX_REMEMBER_PER_EVALUATION = 8;
/** At most this many names kept at once (names the piece stopped declaring are evicted first). */
export const MAX_REMEMBER_NAMES = 16;
/** A value's JSON, at most this many characters. */
export const MAX_REMEMBER_JSON = 4096;
/** Nesting depth (an object in an array in an object… counts 3). */
export const MAX_REMEMBER_DEPTH = 8;
/** Merge ids remembered per name (a merge with a known id is not re-applied). */
export const MAX_MERGE_IDS = 32;
/** describe() results and labels are cut to this many characters. */
export const MAX_REMEMBER_TEXT = 300;

export type RememberBy = "listener" | "ai";
export type RememberLabel = string | ((value: any) => unknown);

export interface RememberOptions {
  describe?: (value: any) => unknown;
  version?: string | number;
  merge?: (draft: any) => unknown;
  label?: string;
}

export interface RememberHandle {
  /** The current value: deep-frozen plain JSON. The same object until it changes. */
  readonly value: any;
  set(next: unknown, label?: RememberLabel): void;
  update(fn: (draft: any) => unknown, label?: RememberLabel): void;
}

export interface RememberedEntry {
  name: string;
  json: string;
  /** describe(value), or null when there is none (or it threw). */
  text: string | null;
  /** Increments with every stored change of this name. */
  rev: number;
  /** When it last changed (hooks.now()). */
  at: number;
  /** Declared by the piece that is playing now (false: kept from earlier code). */
  declared: boolean;
}

export interface RememberChange {
  name: string;
  by: RememberBy;
  text: string;
  cycle: number | null;
}

export interface RememberHooks {
  now(): number;
  cycle(): number | null;
  /** True while the runtime is dispatching a tap callback synchronously. */
  listenerWriting(): boolean;
  /** A listener write or an AI merge changed a value. */
  observe?(change: RememberChange): void;
  /** Some stored value changed (any source). The app throttles snapshots. */
  changed?(): void;
  /** A listener write happened (the stage marks the tap as having changed state). */
  listenerWrote?(): void;
  /** A merge (or a staged write) failed at activation: the evaluation's state ops were discarded. */
  reportError(api: string, error: unknown): void;
}

interface Validated {
  value: unknown;
  json: string;
  type: JsonType;
}

interface Entry {
  name: string;
  value: unknown;
  json: string;
  type: JsonType;
  versionKey: string;
  describe?: (value: any) => unknown;
  text: string | null;
  rev: number;
  at: number;
  mergeIds: string[];
}

interface Decl {
  name: string;
  init: unknown;
  initJson: string;
  type: JsonType;
  versionKey: string;
  describe?: (value: any) => unknown;
  merge?: (draft: any) => unknown;
  label?: string;
  mergeId?: string;
}

interface StagedOp {
  name: string;
  /** The new value from the current one: re-run at activation on the value it lands on. */
  compute: (current: unknown, json: string) => Validated;
  /** What it computed when it was made (the base for the next write in the same evaluation). */
  value: Validated;
}

interface Staged {
  token: number;
  decls: Map<string, Decl>;
  /** set/update calls staged with the evaluation, in order: replayed after its resets, before its merges. */
  ops: StagedOp[];
  /** Its state was applied when its pattern was installed (activateEarly), before its commit. */
  early: boolean;
}

/** FNV-1a, 32 bit, as 8 hex digits. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const DOUBLE_QUOTE_HINT =
  "double-quoted and `backtick` strings are mini-notation patterns in Strudel code — write plain strings in 'single quotes'";

/**
 * A one-word double-quoted string arrives as a mini-notation pattern (the
 * transpiler's rule): give back its word, as controlName does for names.
 * Anything else that is a pattern stays a pattern (and is refused).
 */
function unwrapMiniWord(value: unknown): unknown {
  if (!value || typeof value !== "object" || typeof (value as any).queryArc !== "function") return value;
  if (typeof (value as any).__pure === "string") return (value as any).__pure;
  try {
    const haps = (value as any).queryArc(0, 1);
    if (haps.length === 1 && typeof haps[0]?.value === "string") {
      const whole = haps[0].whole;
      if (whole && Number(whole.begin) === 0 && Number(whole.end) === 1) return haps[0].value;
    }
  } catch {
    /* not a word */
  }
  return value;
}

const typeOf = (value: unknown): JsonType =>
  value === null ? "null" : Array.isArray(value) ? "array" : (typeof value as JsonType);

/** Plain object (any realm): not an array, class instance, Date, Map, pattern… */
function isPlainObject(value: object): boolean {
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * Copy `input` as deep-frozen plain JSON, or throw: TypeError for what isn't
 * JSON, RangeError for what is too deep or too big. The copy never shares an
 * object with the caller, so the caller can't change it behind our back.
 */
export function freezeJson(input: unknown, api: string): Validated {
  let nodes = 0;
  const walk = (raw: unknown, depth: number): unknown => {
    const value = unwrapMiniWord(raw);
    if (++nodes > MAX_REMEMBER_JSON) throw new RangeError(`${api}: the value has more than ${MAX_REMEMBER_JSON} parts (numbers, strings, arrays, objects)`);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError(`${api}: ${value} isn't JSON — use a finite number or null`);
      return value;
    }
    if (typeof value === "string") {
      if (value.length > MAX_REMEMBER_JSON) throw new RangeError(`${api}: the value is bigger than ${MAX_REMEMBER_JSON} characters of JSON`);
      return value;
    }
    if (typeof value !== "object") {
      throw new TypeError(`${api}: a ${typeof value} isn't JSON — store numbers, strings, booleans, null, arrays and plain objects`);
    }
    if (depth >= MAX_REMEMBER_DEPTH) {
      throw new RangeError(`${api}: nested deeper than ${MAX_REMEMBER_DEPTH} levels (or circular)`);
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) throw new TypeError(`${api}: an array with holes isn't JSON — fill it (e.g. Array(16).fill(0))`);
        out.push(walk(value[i], depth + 1));
      }
      return Object.freeze(out);
    }
    if (typeof (value as any).queryArc === "function") throw new TypeError(`${api}: a pattern isn't JSON — ${DOUBLE_QUOTE_HINT}`);
    if (!isPlainObject(value)) throw new TypeError(`${api}: only plain objects are JSON (not ${Object.prototype.toString.call(value).slice(8, -1)})`);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      // defineProperty: a key named "__proto__" stays a key, never a prototype.
      Object.defineProperty(out, key, {
        value: walk((value as Record<string, unknown>)[key], depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return Object.freeze(out);
  };
  const value = walk(input, 0);
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError(`${api}: the value isn't JSON`);
  if (json.length > MAX_REMEMBER_JSON) {
    throw new RangeError(`${api}: the value is ${json.length} characters of JSON — at most ${MAX_REMEMBER_JSON}`);
  }
  return { value, json, type: typeOf(value) };
}

/** A label as text: a string, or a function of the new value. Never throws. */
function labelText(label: RememberLabel | undefined, value: unknown): string | null {
  if (label === undefined) return null;
  try {
    const raw = typeof label === "function" ? unwrapMiniWord(label(value)) : label;
    if (raw === undefined || raw === null) return null;
    if (typeof raw === "object") return null; // a multi-word mini pattern: no honest text
    return String(raw).slice(0, MAX_REMEMBER_TEXT);
  } catch {
    return null;
  }
}

function requireLabel(api: string, label: unknown): void {
  if (label === undefined || typeof label === "function") return;
  const word = unwrapMiniWord(label);
  if (typeof word === "string") return;
  throw new TypeError(`${api}: a label is a string or a function — ${DOUBLE_QUOTE_HINT}`);
}

function describeText(entry: Pick<Entry, "describe" | "value">): string | null {
  if (!entry.describe) return null;
  try {
    const raw = unwrapMiniWord(entry.describe(entry.value));
    if (raw === undefined || raw === null || typeof raw === "object") return null;
    return String(raw).slice(0, MAX_REMEMBER_TEXT);
  } catch {
    return null;
  }
}

const isThenable = (v: unknown) => !!v && (typeof v === "object" || typeof v === "function") && typeof (v as any).then === "function";

export interface RememberStore {
  /** An evaluation is starting. */
  begin(token: number): void;
  /**
   * It succeeded. `defer`: its state waits for activate(token) (its swap's bar);
   * otherwise it applies now (unless it already did, at activateEarly).
   */
  commit(token: number, defer: boolean): void;
  /**
   * The running evaluation's pattern is being installed (and may be queried at
   * once, e.g. a stopped player starting): apply its state now, before that.
   */
  activateEarly(token: number): void;
  /** Apply a committed evaluation's staged state (its swap reached the bar). */
  /** `atCycle`: the bar it lands on (a swap's boundary), reported instead of the clock's lookahead. */
  activate(token: number, atCycle?: number): void;
  /** It failed or was cancelled: drop its staged state; its handles stop writing. */
  rollback(token: number): void;
  /** Declare a name in the running evaluation (or, outside one, at once). */
  declare(name: string, init: unknown, options?: RememberOptions): RememberHandle;
  /** Is this name declared by the evaluation that is running now? */
  declaresNow(name: string): boolean;
  entries(): RememberedEntry[];
  stop(): void;
}

/** Committed evaluations remembered for write authority (the newest writes). */
const MAX_COMMITTED_TOKENS = 8;
/**
 * Swaps whose state may wait for their bar at once. A newer one past this
 * drops the oldest: it loses write authority and its state never lands
 * (Codex review, round 3 — the queue was unbounded).
 */
export const MAX_REMEMBER_WAITING = 8;

export function createRememberStore(hooks: RememberHooks): RememberStore {
  const store = new Map<string, Entry>();
  let running: Staged | null = null;
  /** Committed evaluations whose state waits for their swap's bar, oldest first. */
  let deferred: Staged[] = [];
  /**
   * Committed evaluations, oldest first. The newest one's handles write (its
   * callbacks are the live ones); a rolled-back or superseded one is removed,
   * so authority never returns to an evaluation whose state was discarded.
   */
  let committed: number[] = [];
  const authority = (): number => (committed.length ? committed[committed.length - 1] : 0);
  const forget = (token: number): void => {
    committed = committed.filter((t) => t !== token);
  };
  const trust = (token: number): void => {
    forget(token);
    committed.push(token);
    if (committed.length > MAX_COMMITTED_TOKENS) committed.splice(0, committed.length - MAX_COMMITTED_TOKENS);
  };
  /** Names the active evaluation declared: never evicted. */
  let committedNames = new Set<string>();
  let disposed = false;
  /** >0 while a merge runs: a merge edits its draft — it never writes or declares through the store. */
  let inMerge = 0;
  /**
   * >0 while an evaluation's staged writes are replayed at activation: a write
   * an update() callback makes through ANOTHER handle was already staged as its
   * own op during the evaluation, so the replay ignores it — it never reaches
   * the store outside the transaction (Codex review, round 3).
   */
  let replaying = 0;
  /** >0 while an update() fn runs: it may not declare (declare at the top level). */
  let inUpdate = 0;
  /**
   * An evaluation activated early (its pattern was installed before it
   * committed): provisional until commit. Rollback restores the names it
   * changed; its merge announcements wait for the commit (Codex review, round 3).
   */
  let provisional: {
    token: number;
    before: Map<string, Entry>;
    affected: Set<string>;
    committedNames: Set<string>;
    committed: number[];
    deferred: Staged[];
    flush: () => void;
  } | null = null;
  /** A newer evaluation is taking over: an older provisional activation stands. */
  const confirmProvisional = (): void => {
    const p = provisional;
    provisional = null;
    p?.flush();
  };

  /** Never evict what the playing piece declared, nor what a waiting one will. */
  const protectedNames = (...extra: string[]): Set<string> =>
    new Set([
      ...committedNames,
      ...deferred.flatMap((d) => [...d.decls.keys()]),
      ...(running?.decls.keys() ?? []),
      ...extra,
    ]);

  const evict = (protect: Set<string>): void => {
    while (store.size > MAX_REMEMBER_NAMES) {
      let victim: string | undefined;
      for (const name of store.keys()) {
        if (!protect.has(name)) {
          victim = name;
          break;
        }
      }
      store.delete(victim ?? store.keys().next().value!);
    }
  };

  /** Put an entry last (Map order = least recently changed first, for eviction). */
  const put = (entry: Entry): void => {
    store.delete(entry.name);
    store.set(entry.name, entry);
  };

  const fresh = (decl: Decl, previous: Entry | undefined): Entry => {
    const entry: Entry = {
      name: decl.name,
      value: decl.init,
      json: decl.initJson,
      type: decl.type,
      versionKey: decl.versionKey,
      describe: decl.describe,
      text: null,
      rev: (previous?.rev ?? 0) + 1,
      at: hooks.now(),
      mergeIds: [],
    };
    entry.text = describeText(entry);
    return entry;
  };

  /** Does the stored entry belong to this declaration (same version, same top-level type)? */
  const fits = (entry: Entry | undefined, decl: Decl): entry is Entry =>
    !!entry && entry.versionKey === decl.versionKey && entry.type === decl.type;

  // Set while a deferred activation runs: the scheduler reaches the bar a
  // little ahead of the clock, so the clock would read e.g. 1.8 for bar 2.
  let landingCycle: number | null = null;
  const announce = (entry: Entry, by: RememberBy, label: string | null): void => {
    try {
      hooks.observe?.({ name: entry.name, by, text: label ?? entry.text ?? entry.json.slice(0, MAX_REMEMBER_TEXT), cycle: landingCycle ?? hooks.cycle() });
    } catch {
      /* an observer never stops the piece */
    }
  };
  const changed = (): void => {
    try {
      hooks.changed?.();
    } catch {
      /* cosmetic */
    }
  };

  /** Run a declaration's merge on a copy of `json`; throws on anything but same-type JSON. */
  const runMerge = (decl: Decl, json: string): Validated => {
    const draft = JSON.parse(json);
    let result: unknown;
    inMerge++;
    try {
      result = decl.merge!(draft);
    } finally {
      inMerge--;
    }
    if (isThenable(result)) throw new TypeError(`remember('${decl.name}'): merge must be synchronous (no async/await)`);
    const v = freezeJson(result === undefined ? draft : result, `remember('${decl.name}') merge`);
    if (v.type !== decl.type) throw new TypeError(`remember('${decl.name}') merge: the value must stay a${v.type === "array" || v.type === "object" ? "n" : ""} ${decl.type}, like its init`);
    return v;
  };

  /**
   * The value a write staged in `staged` starts from: the evaluation's last
   * staged write to the name, else the stored value — or init, when the
   * evaluation resets the name. (No merge: merges apply at activation, after
   * the evaluation's own writes, on whatever value is there by then.)
   */
  const stagedBase = (staged: Staged, decl: Decl): { value: unknown; json: string } => {
    for (let i = staged.ops.length - 1; i >= 0; i--) if (staged.ops[i].name === decl.name) return staged.ops[i].value;
    const stored = store.get(decl.name);
    return fits(stored, decl) ? stored : { value: decl.init, json: decl.initJson };
  };

  /**
   * Apply an evaluation's state: for each name its reset (or the stored
   * value), then its staged writes replayed in order on that value, then its
   * merges — all into a scratch map first, so one failure discards the lot.
   */
  const activateStaged = (staged: Staged, replaceCommitted: boolean, holdNotices = false): { ok: boolean; flush: () => void } => {
    const none = { ok: false, flush: () => {} };
    if (disposed) return none;
    const scratch = new Map<string, Entry>();
    const touched = new Set<string>();
    const merged: Array<{ name: string; label: string | null }> = [];
    replaying++;
    try {
      for (const decl of staged.decls.values()) {
        const stored = store.get(decl.name);
        let next: Entry;
        if (fits(stored, decl)) {
          next = { ...stored, describe: decl.describe, mergeIds: [...stored.mergeIds] };
          if (decl.describe !== stored.describe) {
            next.text = describeText(next);
            // A new description of the same value is news for the AI too.
            if (next.text !== stored.text) touched.add(decl.name);
          }
        } else {
          next = fresh(decl, stored);
          touched.add(decl.name);
        }
        scratch.set(decl.name, next);
      }
      for (const op of staged.ops) {
        const next = scratch.get(op.name);
        if (!next) continue;
        const v = op.compute(next.value, next.json);
        next.value = v.value;
        next.json = v.json;
        next.rev++;
        next.text = describeText(next);
        touched.add(op.name);
      }
      for (const decl of staged.decls.values()) {
        const next = scratch.get(decl.name)!;
        if (!decl.merge || !decl.mergeId || next.mergeIds.includes(decl.mergeId)) continue;
        const v = runMerge(decl, next.json);
        next.value = v.value;
        next.json = v.json;
        next.rev++;
        next.mergeIds.push(decl.mergeId);
        if (next.mergeIds.length > MAX_MERGE_IDS) next.mergeIds.splice(0, next.mergeIds.length - MAX_MERGE_IDS);
        next.text = describeText(next);
        touched.add(decl.name);
        merged.push({ name: decl.name, label: decl.label ?? null });
      }
    } catch (error) {
      hooks.reportError("remember", error);
      return none;
    } finally {
      replaying--;
    }
    const now = hooks.now();
    for (const entry of scratch.values()) {
      if (touched.has(entry.name)) entry.at = now;
      put(entry);
    }
    const before = committedNames;
    committedNames = replaceCommitted ? new Set(staged.decls.keys()) : new Set([...committedNames, ...staged.decls.keys()]);
    evict(protectedNames(...staged.decls.keys()));
    // A name the playing piece stopped (or started) declaring reads differently
    // in the snapshot ("kept from earlier code"): that is a change too.
    let flipped = false;
    for (const name of store.keys()) if (before.has(name) !== committedNames.has(name)) flipped = true;
    const notices = merged.map((m) => ({ ...m, entry: store.get(m.name) }));
    const notify = touched.size > 0 || flipped;
    const flush = () => {
      for (const m of notices) if (m.entry) announce(m.entry, "ai", m.label);
      if (notify) changed();
    };
    if (!holdNotices) flush();
    return { ok: true, flush };
  };

  /** Swaps waiting for a bar before `token` never play once `token` takes over. */
  const dropDeferredBefore = (token: number): void => {
    for (const d of deferred) if (d.token < token) forget(d.token);
    deferred = deferred.filter((d) => d.token >= token);
  };

  const write = (decl: Decl, token: number, compute: (current: unknown, json: string) => Validated, label: RememberLabel | undefined): void => {
    if (disposed) return;
    const api = `remember('${decl.name}')`;
    if (inMerge) throw new TypeError(`${api}: a merge can't write through a handle — change its draft (or return a new value) instead`);
    if (replaying) return; // already staged as its own op (see `replaying`)
    requireLabel(`${api}.set/update`, label);
    // Top level of the evaluation that is running: staged with it. Validated
    // now (a bad value throws to the piece), replayed at activation.
    if (running && !running.early && token === running.token) {
      const base = stagedBase(running, decl);
      running.ops.push({ name: decl.name, compute, value: compute(base.value, base.json) });
      return;
    }
    // A retired, rolled-back or superseded evaluation's handle: its leftover
    // callbacks must not write into the state of the piece that replaced it.
    if (token !== authority()) return;
    const stored = store.get(decl.name);
    const pending = deferred.find((d) => d.token === token);
    if (pending && pending.decls.get(decl.name) === decl && !fits(stored, decl)) {
      // This evaluation resets the name at its bar, which hasn't come: the
      // write waits with the reset (the old pattern keeps the old value, and a
      // refused write stores nothing — Codex review).
      const base = stagedBase(pending, decl);
      const v = compute(base.value, base.json);
      pending.ops.push({ name: decl.name, compute, value: v });
      if (hooks.listenerWriting()) {
        const shown: Entry = { ...fresh(decl, stored), value: v.value, json: v.json };
        shown.text = describeText(shown);
        noteListener(shown, label);
      }
      return;
    }
    // Validate first: a refused write leaves the store untouched.
    const base = fits(stored, decl) ? stored : null;
    const v = compute(base ? base.value : decl.init, base ? base.json : decl.initJson);
    const start = base ?? fresh(decl, stored);
    const next: Entry = { ...start, value: v.value, json: v.json, rev: start.rev + 1, at: hooks.now() };
    next.text = describeText(next);
    put(next);
    evict(protectedNames(decl.name));
    if (hooks.listenerWriting()) noteListener(next, label);
    changed();
  };

  const noteListener = (entry: Entry, label: RememberLabel | undefined): void => {
    try {
      hooks.listenerWrote?.();
    } catch {
      /* cosmetic */
    }
    announce(entry, "listener", labelText(label, entry.value));
  };

  return {
    begin(token) {
      // A newer evaluation does not cancel a swap still waiting for its bar:
      // if the newer one fails, that swap's pattern is what plays at the bar,
      // so its state must land there too. It is superseded only when a newer
      // one takes over (a commit that applies now, or an earlier bar).
      if (provisional && provisional.token !== token) confirmProvisional();
      running = { token, decls: new Map(), ops: [], early: false };
    },
    activateEarly(token) {
      if (!running || running.token !== token || running.early) return;
      confirmProvisional();
      const before = new Map(store);
      const saved = { committedNames, committed: [...committed], deferred: [...deferred] };
      running.early = true;
      dropDeferredBefore(token);
      trust(token);
      const { flush } = activateStaged(running, true, true);
      // What the activation CHANGED (activation re-puts every declared entry
      // as a copy, so identity is no measure): value, version, text, merges.
      const same = (a: Entry | undefined, b: Entry | undefined): boolean =>
        !!a && !!b && a.json === b.json && a.versionKey === b.versionKey && a.type === b.type &&
        a.text === b.text && a.mergeIds.join() === b.mergeIds.join();
      const affected = new Set<string>();
      for (const name of new Set([...before.keys(), ...store.keys()])) {
        if (!same(before.get(name), store.get(name))) affected.add(name);
      }
      provisional = { token, before, affected, ...saved, flush };
    },
    commit(token, defer) {
      if (!running || running.token !== token) return;
      const staged = running;
      running = null;
      if (staged.early) {
        // Applied when its pattern was installed: now it stands.
        if (provisional?.token === token) confirmProvisional();
        return;
      }
      confirmProvisional();
      trust(token);
      if (defer) {
        deferred.push(staged);
        while (deferred.length > MAX_REMEMBER_WAITING) forget(deferred.shift()!.token);
        return;
      }
      dropDeferredBefore(token);
      activateStaged(staged, true);
    },
    activate(token, atCycle) {
      const i = deferred.findIndex((d) => d.token === token);
      if (i < 0) return;
      const staged = deferred[i];
      // Older swaps still waiting for a later bar never play now.
      for (const d of deferred.slice(0, i)) forget(d.token);
      deferred = deferred.slice(i + 1);
      landingCycle = typeof atCycle === "number" && Number.isFinite(atCycle) ? atCycle : null;
      try {
        activateStaged(staged, true);
      } finally {
        landingCycle = null;
      }
    },
    rollback(token) {
      if (running?.token === token) running = null;
      if (provisional?.token === token) {
        // Activated when its pattern was installed, then cancelled or
        // superseded before it committed: put back every name it changed
        // (a listener write to one of them since loses — restore wins; writes
        // to other names stay), and never announce its merges.
        const p = provisional;
        provisional = null;
        for (const name of p.affected) {
          const prev = p.before.get(name);
          if (prev) store.set(name, prev);
          else store.delete(name);
        }
        committedNames = p.committedNames;
        committed = p.committed;
        deferred = p.deferred;
        changed();
      }
      deferred = deferred.filter((d) => d.token !== token);
      forget(token);
    },
    declaresNow: (name) => !!running && !running.early && running.decls.has(name),
    declare(name, init, options) {
      const api = `remember('${name}')`;
      if (inMerge) throw new TypeError(`${api}: a merge can't declare remembered state — declare it at the top level`);
      if (inUpdate || replaying) throw new TypeError(`${api}: declare remembered state at the top level, not inside update()`);
      if (options !== undefined && (options === null || typeof options !== "object")) {
        throw new TypeError(`${api}: the third argument is an options object, e.g. { describe: v => '…', version: 1 }`);
      }
      const opts = options ?? {};
      for (const key of ["describe", "merge"] as const) {
        if (opts[key] !== undefined && typeof opts[key] !== "function") throw new TypeError(`${api}: ${key} must be a function`);
      }
      if (opts.version !== undefined && typeof opts.version !== "number" && typeof opts.version !== "string") {
        throw new TypeError(`${api}: version must be a number or a string`);
      }
      if (opts.label !== undefined) requireLabel(api, opts.label);
      const label = opts.label === undefined ? undefined : String(unwrapMiniWord(opts.label)).slice(0, MAX_REMEMBER_TEXT);
      const v = freezeJson(init, api);
      const versionKey = opts.version === undefined ? "" : String(opts.version);
      const decl: Decl = {
        name,
        init: v.value,
        initJson: v.json,
        type: v.type,
        versionKey,
        describe: opts.describe,
        merge: opts.merge,
        label,
        mergeId: opts.merge ? fnv1a(`${String(opts.merge)}\u0000${label ?? ""}\u0000${versionKey}`) : undefined,
      };
      let token: number;
      if (running && !running.early) {
        if (running.decls.has(name)) throw new TypeError(`${api} is declared twice in this piece — declare each name once`);
        if (running.decls.size >= MAX_REMEMBER_PER_EVALUATION) {
          throw new RangeError(`At most ${MAX_REMEMBER_PER_EVALUATION} remember() names per piece`);
        }
        running.decls.set(name, decl);
        token = running.token;
      } else {
        // Inside a callback: it belongs to the piece whose callbacks are live.
        token = authority();
        const pending = deferred.find((d) => d.token === token);
        if (pending) {
          // That piece's state waits for its bar: so does this name, and it
          // counts toward that piece's names (Codex review, round 2).
          if (!pending.decls.has(name) && pending.decls.size >= MAX_REMEMBER_PER_EVALUATION) {
            throw new RangeError(`At most ${MAX_REMEMBER_PER_EVALUATION} remember() names per piece`);
          }
          pending.decls.set(name, decl);
        } else {
          if (!committedNames.has(name) && committedNames.size >= MAX_REMEMBER_PER_EVALUATION) {
            throw new RangeError(`At most ${MAX_REMEMBER_PER_EVALUATION} remember() names per piece`);
          }
          if (!disposed) activateStaged({ token, decls: new Map([[name, decl]]), ops: [], early: false }, false);
        }
      }
      // Always the stored value: an evaluation whose state hasn't activated yet
      // reads what is playing. Its state lands with its pattern — at the
      // swap's bar, or when its pattern is installed — never as a preview.
      const read = () => {
        const entry = store.get(name);
        return fits(entry, decl) ? entry.value : decl.init;
      };
      return {
        get value() {
          return read();
        },
        set(next: unknown, lab?: RememberLabel) {
          // Validated, copied and frozen NOW: a staged set replays this value,
          // not the caller's object as it is by then (Codex review, round 3).
          const out = freezeJson(next, `${api}.set`);
          if (out.type !== decl.type) throw new TypeError(`${api}.set: the value must stay a${decl.type === "array" || decl.type === "object" ? "n" : ""} ${decl.type}, like its init`);
          write(decl, token, () => out, lab);
        },
        update(fn: (draft: any) => unknown, lab?: RememberLabel) {
          if (typeof fn !== "function") throw new TypeError(`${api}.update(fn) needs a function, got ${typeof fn}`);
          write(decl, token, (_current, json) => {
            const draft = JSON.parse(json);
            let result: unknown;
            inUpdate++;
            try {
              result = fn(draft);
            } finally {
              inUpdate--;
            }
            if (isThenable(result)) throw new TypeError(`${api}.update: fn must be synchronous (no async/await)`);
            const out = freezeJson(result === undefined ? draft : result, `${api}.update`);
            if (out.type !== decl.type) throw new TypeError(`${api}.update: the value must stay a${decl.type === "array" || decl.type === "object" ? "n" : ""} ${decl.type}, like its init`);
            return out;
          }, lab);
        },
      };
    },
    entries: () =>
      [...store.values()].map((e) => ({ name: e.name, json: e.json, text: e.text, rev: e.rev, at: e.at, declared: committedNames.has(e.name) })),
    stop() {
      disposed = true;
      store.clear();
      provisional = null;
      running = null;
      deferred = [];
      committed = [];
      committedNames = new Set();
    },
  };
}
