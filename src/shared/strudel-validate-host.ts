/**
 * Supervisor for the Strudel validation child.
 *
 * The problem this exists to solve: validating a pattern means RUNNING code an
 * LLM wrote, and before v0.5 that only ever happened inside the widget's
 * CSP-pinned browser iframe. Moving it server-side put it in the MCP server's
 * own process, where two things go wrong and neither is recoverable there:
 *
 *   F1  Scope. `@strudel/core`'s evaluate() is `Function(body)()` in the real
 *       global scope, so a prompt-injected pattern could read `process.env` or
 *       `await import("node:fs")`. (Reproduced; see the isolation test.)
 *   F2  Liveness. `while(true){}` inside an async body is a synchronous busy
 *       loop. `Promise.race` never gets a turn, the event loop never runs, and
 *       a stdio MCP server is simply dead until someone restarts it.
 *
 * So: one warm child process, forked lazily, holding all of it at arm's length.
 *
 *   env: {}                    nothing to steal — no API keys, no tokens, no PATH
 *   cwd: os.tmpdir()           relative paths lead somewhere boring
 *   --max-old-space-size=512   a runaway allocation OOMs the child, not the server
 *   stdio ignore/ignore/pipe   child stdout can never reach the server's stdout,
 *                              which on a stdio transport IS the JSON-RPC channel
 *   ipc + JSON serialisation   only data crosses back
 *   SIGKILL on timeout         the real deadline, and the answer to F2
 *
 * plus, inside the child, a node:vm context with no `process`/`fetch`/`require`
 * and no dynamic `import()` — see evalStrudelSandboxed in strudel-eval.ts.
 *
 * HONEST LIMITS. This is a containment boundary, not a sandbox:
 *   - The child can still READ the filesystem (`node:fs` is refused inside the
 *     vm, but a vm context is a scope boundary, not a security one, and nothing
 *     here chroots or seccomps the process). It can also still open sockets.
 *     Assume a determined escape reads files as the server's user.
 *   - The kill is per-request. A pattern that spawns detached work before
 *     hanging is not tracked.
 *   - Requests are serialised, so one slow pattern delays the next by up to its
 *     timeout. Validation is single-digit milliseconds in practice.
 * What it does buy is the two things that actually matter for an MCP server:
 * the process survives, and there is nothing in the child's environment worth
 * exfiltrating.
 */
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import type { StrudelValidation, ValidateOptions } from "./strudel-validation-types.js";

/** Extra wall-clock the child gets past the caller's timeout before SIGKILL. */
const KILL_GRACE_MS = 250;

/** Budget for fork + module load + evalScope warm-up. Measured at ~150-400 ms. */
const SPAWN_TIMEOUT_MS = 20_000;

/** Tail of child stderr kept for crash diagnostics. */
const STDERR_KEEP = 4000;

interface ChildEntry {
  /** File to fork. */
  path?: string;
  /** Interpreter to fork it with; undefined means `process.execPath`. */
  execPath?: string;
  /** Why there is no path, phrased for a tool result. */
  problem?: string;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * Find a Bun binary, for the source-tree case below. Reads the PARENT's
 * environment, which is fine — it is the child's environment that must be
 * empty, and nothing found here is passed on.
 */
function findBun(): string | undefined {
  if (isBun) return process.execPath;
  const candidates = [
    process.env.BUN_INSTALL ? `${process.env.BUN_INSTALL}/bin/bun` : undefined,
    process.env.HOME ? `${process.env.HOME}/.bun/bin/bun` : undefined,
    ...(process.env.PATH ?? "").split(":").map((dir) => (dir ? `${dir}/bun` : undefined)),
  ];
  return candidates.find((c) => c && existsSync(c));
}

/**
 * Where the child entry lives, which depends on how WE are being run.
 *
 * 1. Next to this module — the npm package, where `bun build` emits
 *    dist/strudel-validate-child.js beside the bundle this code ends up in.
 *    This is the only case an installed server ever takes.
 * 2. dist/ of the source tree, when the repo has been built (CI runs
 *    `bun run build` before `vitest`).
 * 3. The .ts sibling, forked with Bun. Node's own type stripping is not enough:
 *    it does not remap the project's `./x.js` specifiers onto `x.ts`, so the
 *    child dies with ERR_MODULE_NOT_FOUND. Bun does, so `execPath` points at it
 *    — which is also what the `bun main.ts` dev server is already running.
 *
 * Resolved once; an unresolvable child is reported per-request rather than
 * thrown at import time, so a packaging mistake degrades validation to
 * "unavailable" instead of breaking the server.
 */
function resolveChildEntry(): ChildEntry {
  const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
  const built = [here("./strudel-validate-child.js"), here("../../dist/strudel-validate-child.js")];
  for (const candidate of built) {
    if (existsSync(candidate)) return { path: candidate };
  }
  const source = here("./strudel-validate-child.ts");
  if (!existsSync(source)) {
    return { problem: `the validation child was not found next to ${here("./")}` };
  }
  const bun = findBun();
  if (bun) return { path: source, execPath: isBun ? undefined : bun };
  return {
    problem:
      "the validation child exists only as TypeScript and no Bun was found to run it — " +
      "run `bun run build` first (it emits dist/strudel-validate-child.js)",
  };
}

let entry: ChildEntry | undefined;

interface Pending {
  resolve: (value: StrudelValidation) => void;
  timer: ReturnType<typeof setTimeout>;
}

let child: ChildProcess | undefined;
/** Resolves when the current child has warmed up; rejects if it died first. */
let ready: Promise<ChildProcess> | undefined;
let stderr = "";
let nextId = 1;
const pending = new Map<number, Pending>();
let exitHookInstalled = false;

function failAllPending(message: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, error: { message } });
  }
  pending.clear();
}

/** Kill the current child (if any) and forget it; the next request respawns. */
function discardChild(reason?: string): void {
  const dying = child;
  child = undefined;
  ready = undefined;
  if (reason) failAllPending(reason);
  if (dying && dying.exitCode === null && dying.signalCode === null) {
    dying.removeAllListeners("exit");
    dying.kill("SIGKILL");
  }
}

export function shutdownStrudelValidator(): void {
  discardChild();
}

function spawnChild({ path: childPath, execPath }: ChildEntry): Promise<ChildProcess> {
  const cp = fork(childPath as string, [], {
    ...(execPath ? { execPath } : {}),
    // Never inherit the parent environment. An MCP server's env is exactly the
    // interesting thing on the box — API keys, session tokens, PATH.
    env: {},
    // The heap cap has to be an interpreter flag, not something the child can
    // set for itself: an OOM must kill the child before it exhausts the host.
    execArgv: ["--max-old-space-size=512"],
    // stdin ignored, STDOUT IGNORED (see the file header), stderr piped for
    // diagnostics, ipc for the protocol.
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    cwd: tmpdir(),
    // Plain JSON both ways: no structured-clone graph from untrusted code.
    serialization: "json",
  });
  stderr = "";
  cp.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_KEEP);
  });
  cp.on("message", (msg: unknown) => {
    const m = msg as { id?: number; result?: StrudelValidation } | undefined;
    if (typeof m?.id !== "number") return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    p.resolve(m.result ?? { ok: false, error: { message: "validation returned nothing" } });
  });
  cp.on("exit", () => {
    if (child === cp) {
      child = undefined;
      ready = undefined;
    }
    failAllPending(crashMessage());
  });
  cp.on("error", () => {
    if (child === cp) discardChild(crashMessage());
  });

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", shutdownStrudelValidator);
  }

  return new Promise<ChildProcess>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("the validation process did not start in time"));
    }, SPAWN_TIMEOUT_MS);
    const onReady = (msg: unknown) => {
      if ((msg as { type?: string } | undefined)?.type !== "ready") return;
      clearTimeout(timer);
      cp.off("message", onReady);
      resolve(cp);
    };
    cp.on("message", onReady);
    cp.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(crashMessage()));
    });
    cp.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function crashMessage(): string {
  const detail = stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ");
  return detail
    ? `validation crashed (out of memory?): ${detail.slice(0, 300)}`
    : "validation crashed (out of memory?)";
}

/** Serialises requests: one pattern in flight, so one kill is unambiguous. */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Validate `code` in the child. Always resolves — a dead, missing or wedged
 * child is a failed validation, never a failed tool call.
 */
export function validateStrudelIsolated(
  code: string,
  { cycles = 4, timeoutMs = 3000 }: ValidateOptions = {},
): Promise<StrudelValidation> {
  return enqueue(async () => {
    entry ??= resolveChildEntry();
    if (!entry.path) {
      return { ok: false, error: { message: `validation unavailable — ${entry.problem}` } };
    }

    let cp: ChildProcess;
    try {
      ready ??= spawnChild(entry);
      cp = await ready;
      child = cp;
    } catch (err) {
      discardChild();
      return { ok: false, error: { message: (err as Error)?.message ?? String(err) } };
    }

    const id = nextId++;
    return new Promise<StrudelValidation>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // The child is running a synchronous loop; nothing short of a signal
        // will get it back. Kill it and let the next request fork a fresh one.
        discardChild();
        resolve({
          ok: false,
          error: {
            message:
              `validation timed out after ${Math.round(timeoutMs / 100) / 10}s — ` +
              "the pattern may loop forever",
          },
        });
      }, timeoutMs + KILL_GRACE_MS);
      pending.set(id, { resolve, timer });
      try {
        cp.send({ id, code, cycles, timeoutMs });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        discardChild();
        resolve({ ok: false, error: { message: `validation could not be started: ${String(err)}` } });
      }
    });
  });
}
